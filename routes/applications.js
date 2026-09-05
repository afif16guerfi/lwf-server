const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireRole, requireActiveAccount } = require("../middleware/auth");
const { FIELD_GROUPS, allFieldKeys, SEASON, isValidForScript, isValidForFormat, isValidForOptions, sanitizeForFormat, isValidPhone, checkPhoneUniqueness, syncUserFromApplicationData, getAccountStatus } = require("../schema");
const { MAX_UPLOAD_MB } = require("../config");
const { sortedRequirements } = require("../documentRequirementsCore");
const { addAuditEntries } = require("../auditCore");

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

// key -> field definition, built once, so PUT can look up a field's
// `format` (if any) without re-scanning FIELD_GROUPS per key on every save.
const FIELD_META_BY_KEY = {};
FIELD_GROUPS.forEach((g) => g.fields.forEach((f) => { FIELD_META_BY_KEY[f.key] = f; }));

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
    const sanitized = {};
    Object.entries(fields).forEach(([k, v]) => {
      if (!valid.has(k)) return;
      let val = typeof v === "string" ? v : String(v ?? "");
      // Never trust the client alone for these formats (phone/CCP/shoe/
      // clothing size): re-normalize server-side too, same rules as the
      // client's live input filtering — see schema.js. This only
      // auto-corrects the value (strips stray characters, enforces the
      // CCP prefix/length, uppercases the clothing size, etc.); it never
      // rejects the autosave — full validation happens at submit time.
      const format = FIELD_META_BY_KEY[k] && FIELD_META_BY_KEY[k].format;
      if (format) val = sanitizeForFormat(format, val);
      sanitized[k] = val;
    });

    // Phone uniqueness (phone1/phone2 only — رقم هاتف شخص الطوارئ is
    // deliberately excluded) is enforced here at the API/Backend level,
    // not just as a frontend message — checked whenever either field is
    // being touched, using the value that will actually be saved.
    if (sanitized.phone1 !== undefined || sanitized.phone2 !== undefined) {
      const candidatePhone1 = sanitized.phone1 !== undefined ? sanitized.phone1 : app.data.phone1;
      const candidatePhone2 = sanitized.phone2 !== undefined ? sanitized.phone2 : app.data.phone2;
      const check = checkPhoneUniqueness(data, { phone1: candidatePhone1, phone2: candidatePhone2 }, req.user.id);
      if (!check.ok) return res.status(409).json({ error: check.message, field: check.field });
    }

    // Every actually-changed field, for the Audit Log — computed BEFORE
    // overwriting app.data, and not limited to identity fields (item 10 of
    // the spec: every important operation is logged, not just name/email/
    // phone).
    const fieldDiffs = [];
    Object.entries(sanitized).forEach(([k, val]) => {
      const oldVal = app.data[k];
      if (String(oldVal ?? "") !== String(val ?? "")) fieldDiffs.push({ field: k, oldValue: oldVal, newValue: val });
      app.data[k] = val;
    });

    // Single source of truth: whichever identity fields were just touched
    // (fullNameAr/fullNameLatin/email/phone1) are mirrored onto the account
    // record right here, in the same request, so every other place that
    // reads the referee's name/email/phone (chat, notifications, the admin
    // account list, the enrollment certificate, printed lists, requests…)
    // reflects the change immediately — never a stale copy.
    const me = data.users.find((u) => u.id === req.user.id);
    if (me) {
      const touchedKeys = Object.keys(sanitized);
      syncUserFromApplicationData(me, app.data, touchedKeys);
    }

    if (fieldDiffs.length) {
      addAuditEntries(data, req.user.id, fieldDiffs, {
        changedBy: "referee",
        changedByUserId: req.user.id,
        changedByName: me ? me.fullNameAr : null,
        source: "self_edit",
        reason: null,
        accountStatusBefore: me ? getAccountStatus(me) : null,
        accountStatusAfter: me ? getAccountStatus(me) : null,
      });
    }
  }
  if (typeof declaration === "boolean") app.declaration = declaration;
  app.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Live phone-uniqueness check while filling the enrollment wizard
//      (phone1/phone2 only — never emergencyPhone) — lets the frontend
//      flag a conflict as the referee types/moves between fields, in
//      addition to the hard enforcement above on save. ----
router.get("/phone-availability", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const { field, value } = req.query;
  if (!["phone1", "phone2"].includes(field)) return res.status(400).json({ error: "حقل غير صالح." });
  const v = sanitizeForFormat("phone", String(value || ""));
  if (!v) return res.json({ available: true });
  const data = await db.getAll();
  const check = checkPhoneUniqueness(data, { [field]: v }, req.user.id);
  res.json({ available: check.ok, reason: check.ok ? null : check.message });
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
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

  // validate required fields (and, for name-script fields, that the value
  // is actually written in the script the field asks for — client-side
  // input filtering already stops most of this, but that can't be trusted
  // alone since it's bypassable)
  const missingFields = [];
  const invalidFields = [];
  FIELD_GROUPS.forEach((g) =>
    g.fields.forEach((f) => {
      const val = app.data[f.key];
      if (f.required && !String(val || "").trim()) { missingFields.push(f.label); return; }
      if (f.script && val && !isValidForScript(f.script, val)) invalidFields.push(f.label);
      if (f.format && val && !isValidForFormat(f.format, val)) invalidFields.push(f.label);
      if ((f.type === "select" || f.type === "radio") && val && !isValidForOptions(f, val)) invalidFields.push(f.label);
      if (f.type === "date" && val) {
        const d = new Date(val);
        if (Number.isNaN(d.getTime())) invalidFields.push(f.label);
        else if (f.notFuture && d.getTime() > Date.now()) invalidFields.push(f.label);
      }
    })
  );
  const missingDocs = currentDocRequirements(data)
    .filter((d) => d.isRequired && !app.documents[d.id])
    .map((d) => d.title);
  if (!app.declaration) missingFields.push("الموافقة على الإقرار");
  // The e-signature is tied to this pledge — it must already be drawn and
  // saved (via POST /auth/signature) before the pledge/application can be
  // submitted at all.
  if (!user.signature || !user.signature.url) missingFields.push("التوقيع الإلكتروني");

  if (missingFields.length || invalidFields.length || missingDocs.length) {
    return res.status(400).json({
      error: invalidFields.length
        ? `الرجاء تصحيح الحقول التالية: ${invalidFields.join("، ")} — تأكد من صحة الصيغة المطلوبة لكل حقل.`
        : "الملف غير مكتمل.",
      missingFields,
      invalidFields,
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
  // Confirming the pledge finalizes the signature tied to it: once the
  // application is submitted, the signature becomes immutable (see the
  // hard lock enforced in routes/auth.js POST /signature) until an admin
  // explicitly unlocks it for an exceptional correction.
  if (user.signature && !user.signature.locked) {
    user.signature.locked = true;
    user.signature.lockedAt = new Date().toISOString();
  }
  await db.saveAll(data);
  res.json({ application: app });
});

module.exports = router;
