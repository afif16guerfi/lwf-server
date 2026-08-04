const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireRole, requireActiveAccount } = require("../middleware/auth");
const { allFieldKeys } = require("../schema");
const { MAX_UPLOAD_MB } = require("../config");

const router = express.Router();

const REQUEST_TYPES = ["absence", "special", "edit"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("نوع الملف غير مدعوم."));
    cb(null, true);
  },
});

function findMyApplication(data, userId) {
  return data.applications.find((a) => a.userId === userId);
}
function findRequest(data, id) {
  return (data.requests || []).find((r) => r.id === id);
}

async function uploadAttachment(file) {
  if (!file) return null;
  if (!cloudinaryLib.isConfigured()) {
    throw Object.assign(new Error("لم يتم إعداد تخزين الملفات (Cloudinary)."), { status: 500 });
  }
  const result = await cloudinaryLib.uploadBuffer(file.buffer, {
    public_id: `request_${uuidv4()}`,
    resource_type: "auto",
  });
  return {
    originalName: file.originalname,
    mimetype: file.mimetype,
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type,
  };
}

function validateRequestFields(type, body) {
  const { title, details, dateFrom, dateTo, fieldKey, newValue } = body;
  if (!REQUEST_TYPES.includes(type)) return "نوع الطلب غير معروف.";
  if (type !== "edit" && (!details || !String(details).trim())) return "يرجى كتابة تفاصيل الطلب.";
  if (type === "absence" && (!dateFrom || !dateTo)) return "يرجى تحديد تاريخ بداية ونهاية الغياب.";
  if (type === "special" && (!title || !String(title).trim())) return "يرجى كتابة عنوان مختصر للطلب.";
  if (type === "edit") {
    if (!fieldKey || !allFieldKeys().includes(fieldKey)) return "يرجى اختيار حقل صحيح لتعديله.";
    if (newValue === undefined || newValue === null || !String(newValue).trim()) return "يرجى كتابة القيمة الجديدة المطلوبة.";
    if (!details || !String(details).trim()) return "يرجى كتابة سبب طلب التعديل.";
  }
  return null;
}

// ---- Create a new request (absence / special / edit) ----
router.post("/mine", requireAuth, requireRole("referee"), requireActiveAccount, upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const app = findMyApplication(data, req.user.id);
  if (!app || app.status !== "approved") {
    return res.status(403).json({ error: "هذه الميزة متاحة فقط بعد قبول ملف انخراطك وصدور وثيقتك الرسمية." });
  }

  const { type, title, details, dateFrom, dateTo, fieldKey, newValue } = req.body;
  const validationError = validateRequestFields(type, req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  let attachment = null;
  try {
    attachment = await uploadAttachment(req.file);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }

  const request = {
    id: uuidv4(),
    userId: req.user.id,
    type,
    title: type === "absence" ? "طلب غياب" : type === "edit" ? "طلب تعديل معلومة" : String(title).trim(),
    details: details ? String(details).trim() : "",
    dateFrom: type === "absence" ? dateFrom : null,
    dateTo: type === "absence" ? dateTo : null,
    fieldKey: type === "edit" ? fieldKey : null,
    oldValue: type === "edit" ? (app.data[fieldKey] || "") : null,
    newValue: type === "edit" ? String(newValue).trim() : null,
    attachment,
    status: "pending",
    adminNote: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decidedAt: null,
  };
  data.requests.push(request);
  await db.saveAll(data);
  res.json({ request });
});

// ---- List my own requests ----
router.get("/mine", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const mine = data.requests
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests: mine });
});

// ---- Edit my own request (only while pending, or to correct a rejected one) ----
router.put("/mine/:id", requireAuth, requireRole("referee"), requireActiveAccount, upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const request = findRequest(data, req.params.id);
  if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "الطلب غير موجود." });
  if (!["pending", "rejected"].includes(request.status)) {
    return res.status(400).json({ error: "لا يمكن تعديل هذا الطلب بعد البت فيه بالقبول." });
  }

  const type = request.type;
  const validationError = validateRequestFields(type, req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { title, details, dateFrom, dateTo, fieldKey, newValue } = req.body;

  if (req.file) {
    if (request.attachment && request.attachment.publicId) {
      await cloudinaryLib.destroyAsset(request.attachment.publicId, request.attachment.resourceType);
    }
    try {
      request.attachment = await uploadAttachment(req.file);
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }
  }

  if (type === "absence") {
    request.details = String(details).trim();
    request.dateFrom = dateFrom;
    request.dateTo = dateTo;
  } else if (type === "special") {
    request.title = String(title).trim();
    request.details = String(details).trim();
  } else if (type === "edit") {
    const app = findMyApplication(data, req.user.id);
    request.fieldKey = fieldKey;
    request.oldValue = app ? app.data[fieldKey] || "" : request.oldValue;
    request.newValue = String(newValue).trim();
    request.details = String(details).trim();
  }

  const wasRejected = request.status === "rejected";
  if (wasRejected) {
    request.status = "pending";
    request.adminNote = "";
    request.decidedAt = null;
  }
  request.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ request });
});

// ---- Delete my own request (only while pending) ----
router.delete("/mine/:id", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const request = findRequest(data, req.params.id);
  if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "الطلب غير موجود." });
  if (request.status !== "pending") {
    return res.status(400).json({ error: "لا يمكن حذف طلب تم البت فيه (مقبول أو مرفوض)." });
  }
  if (request.attachment && request.attachment.publicId) {
    await cloudinaryLib.destroyAsset(request.attachment.publicId, request.attachment.resourceType);
  }
  data.requests = data.requests.filter((r) => r.id !== req.params.id);
  await db.saveAll(data);
  res.json({ ok: true });
});

module.exports = router;
