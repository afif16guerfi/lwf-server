const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireRole, requireActiveAccount } = require("../middleware/auth");
const { FIELD_GROUPS, allFieldKeys, SEASON } = require("../schema");
const { MAX_UPLOAD_MB } = require("../config");
const { sortedRequirements } = require("../documentRequirementsCore");

const router = express.Router();

// Files are held in memory only long enough to stream them to Cloudinary —
// nothing is written to the local disk, so this works on hosts with an
// ephemeral filesystem (Render free tier, etc.).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("نوع الملف غير مدعوم."));
    cb(null, true);
  },
});

function findApp(data, userId) {
  return data.applications.find((a) => a.userId === userId);
}

function logEvent(app, text) {
  app.history.push({ at: new Date().toISOString(), event: text });
}

function currentDocRequirements(data) {
  return sortedRequirements(data.documentRequirements);
}

// ---- Get my application ----
router.get("/mine", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const app = findApp(data, req.user.id);
  if (!app) return res.status(404).json({ error: "لا يوجد ملف انخراط." });
  res.json({ application: app });
});

// ---- Update draft field data (partial, called on each wizard step) ----
router.put("/mine", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const app = findApp(data, req.user.id);
  if (!app) return res.status(404).json({ error: "لا يوجد ملف انخراط." });
  if (!["draft", "pending_review", "rejected"].includes(app.status)) {
    return res.status(400).json({ error: "لا يمكن تعديل الملف في وضعه الحالي." });
  }
  const { fields, declaration } = req.body;
  if (fields && typeof fields === "object") {
    const valid = new Set(allFieldKeys());
    Object.entries(fields).forEach(([k, v]) => {
      if (valid.has(k)) app.data[k] = typeof v === "string" ? v : String(v ?? "");
    });
  }
  if (typeof declaration === "boolean") app.declaration = declaration;
  app.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Upload a document ----
router.post("/mine/documents/:docKey", requireAuth, requireRole("referee"), requireActiveAccount, upload.single("file"), async (req, res) => {
  const { docKey } = req.params;
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف." });
  if (!cloudinaryLib.isConfigured()) {
    return res.status(500).json({
      error: "لم يتم إعداد تخزين الملفات (Cloudinary). أضف متغيرات البيئة CLOUDINARY_CLOUD_NAME وCLOUDINARY_API_KEY وCLOUDINARY_API_SECRET.",
    });
  }

  const data = await db.getAll();
  if (!currentDocRequirements(data).some((d) => d.id === docKey)) {
    return res.status(400).json({ error: "نوع وثيقة غير معروف." });
  }
  const app = findApp(data, req.user.id);
  if (!app) return res.status(404).json({ error: "لا يوجد ملف انخراط." });
  if (!["draft", "pending_review", "rejected"].includes(app.status)) {
    return res.status(400).json({ error: "لا يمكن تعديل الوثائق في وضع الملف الحالي." });
  }

  let uploadResult;
  try {
    uploadResult = await cloudinaryLib.uploadBuffer(req.file.buffer, {
      public_id: `${req.user.id}_${docKey}_${uuidv4().slice(0, 8)}`,
      resource_type: "auto",
    });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "تعذّر رفع الملف إلى خدمة التخزين. حاول مرة أخرى." });
  }

  // remove old file for this doc key, if any
  const old = app.documents[docKey];
  if (old && old.publicId) {
    await cloudinaryLib.destroyAsset(old.publicId, old.resourceType);
  }

  app.documents[docKey] = {
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    url: uploadResult.secure_url,
    publicId: uploadResult.public_id,
    resourceType: uploadResult.resource_type,
    uploadedAt: new Date().toISOString(),
  };
  if (app.docFlags && app.docFlags[docKey] !== undefined) delete app.docFlags[docKey];
  app.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Submit application (draft -> pending_review directly, registration is free) ----
router.post("/mine/submit", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const app = findApp(data, req.user.id);
  if (!app) return res.status(404).json({ error: "لا يوجد ملف انخراط." });
  if (!["draft", "rejected"].includes(app.status)) {
    return res.status(400).json({ error: "الملف ليس في وضع يسمح بالإرسال." });
  }

  // validate required fields
  const missingFields = [];
  FIELD_GROUPS.forEach((g) =>
    g.fields.forEach((f) => {
      if (f.required && !String(app.data[f.key] || "").trim()) missingFields.push(f.label);
    })
  );
  const missingDocs = currentDocRequirements(data)
    .filter((d) => d.isRequired && !app.documents[d.id])
    .map((d) => d.title);
  if (!app.declaration) missingFields.push("الموافقة على الإقرار");

  if (missingFields.length || missingDocs.length) {
    return res.status(400).json({
      error: "الملف غير مكتمل.",
      missingFields,
      missingDocs,
    });
  }

  const wasRejected = app.status === "rejected";
  app.flags = {};
  app.docFlags = {};
  app.rejectionSummary = "";
  app.submittedAt = new Date().toISOString();
  app.status = "pending_review";
  logEvent(app, wasRejected ? "أعاد الحكم إرسال الملف بعد التصحيح" : "أرسل الحكم ملفه للمراجعة");
  await db.saveAll(data);
  res.json({ application: app });
});

module.exports = router;
