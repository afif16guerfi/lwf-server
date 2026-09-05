const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireRole, requireActiveAccount } = require("../middleware/auth");
const { allFieldKeys, REQUEST_STATUS } = require("../schema");
const { MAX_UPLOAD_MB } = require("../config");
const { NOTIFICATION_TYPES, notifyAdmins, pushRealtime } = require("../notificationsCore");

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

// ---- Timeline (سجل الطلب) — every status transition and edit is recorded
// here: who did it, when, what changed. Kept on the request itself so the
// full history travels with it (GET /mine and GET /admin/requests already
// return the whole request object, so the timeline needs no extra route). ----
function logHistory(request, { event, from, to, by, note }) {
  request.history.push({
    at: new Date().toISOString(),
    event,
    from: from || null,
    to: to || null,
    by: by || null, // "referee" | "admin"
    note: note || null,
  });
}

function requestTypeLabel(r) {
  if (r.type === "absence") return "طلب غياب";
  if (r.type === "edit") return "طلب تعديل معلومة";
  return "طلب خاص";
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

// A snapshot of the editable fields, taken right before a referee edits
// and resends a request — "يُفضّل الاحتفاظ بنسخ سابقة من الطلب عند
// تعديله حتى لا تضيع المعلومات القديمة" (fourth requirement).
function snapshotOf(request) {
  return {
    at: new Date().toISOString(),
    title: request.title,
    details: request.details,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    fieldKey: request.fieldKey,
    oldValue: request.oldValue,
    newValue: request.newValue,
    attachment: request.attachment,
  };
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

  const nowIso = new Date().toISOString();
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
    status: REQUEST_STATUS.PENDING,
    adminNote: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    decidedAt: null,
    history: [{ at: nowIso, event: "تم إنشاء الطلب", from: null, to: REQUEST_STATUS.PENDING, by: "referee", note: null }],
    previousVersions: [],
  };
  data.requests.push(request);

  const created = notifyAdmins(data, {
    type: NOTIFICATION_TYPES.REQUEST_NEW,
    title: "طلب جديد من حكم",
    body: `أرسل ${app.data.fullNameAr || "حكم"} ${requestTypeLabel(request)} جديدًا بانتظار المراجعة.`,
    link: "#/admin-requests",
    meta: { requestId: request.id },
  });

  await db.saveAll(data);
  pushRealtime(data, created);
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

// ---- Edit + resend my own request — allowed while the request is still
//      "قيد المراجعة" for the first time (the admin hasn't acted on it yet)
//      OR while the admin has explicitly asked for توضيح/تعديل. Once a
//      request is approved or rejected it is final and closed for the
//      referee (no edit, no resend, no status change, no delete). ----
router.put("/mine/:id", requireAuth, requireRole("referee"), requireActiveAccount, upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const request = findRequest(data, req.params.id);
  if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "الطلب غير موجود." });
  const editable = request.status === REQUEST_STATUS.PENDING || request.status === REQUEST_STATUS.NEEDS_CLARIFICATION;
  if (!editable) {
    return res.status(400).json({ error: "لا يمكن تعديل هذا الطلب بعد أن بتّت فيه الإدارة (مقبول أو مرفوض)." });
  }

  const type = request.type;
  const validationError = validateRequestFields(type, req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { title, details, dateFrom, dateTo, fieldKey, newValue } = req.body;

  // Keep the pre-edit version so the old information is never lost.
  request.previousVersions.push(snapshotOf(request));

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

  const fromStatus = request.status;
  const wasNeedsClarification = fromStatus === REQUEST_STATUS.NEEDS_CLARIFICATION;
  request.status = REQUEST_STATUS.PENDING;
  request.adminNote = "";
  request.decidedAt = null;
  request.updatedAt = new Date().toISOString();
  logHistory(request, {
    event: wasNeedsClarification ? "عدّل الحكم الطلب وأعاد إرساله" : "عدّل الحكم الطلب",
    from: fromStatus,
    to: REQUEST_STATUS.PENDING,
    by: "referee",
  });

  const app = findMyApplication(data, req.user.id);
  const created = notifyAdmins(data, {
    type: NOTIFICATION_TYPES.REQUEST_RESUBMITTED,
    title: wasNeedsClarification ? "الحكم أعاد إرسال طلبه" : "الحكم عدّل طلبه",
    body: wasNeedsClarification
      ? `عدّل ${app ? app.data.fullNameAr : "حكم"} ${requestTypeLabel(request)} وأعاد إرساله بعد التوضيح المطلوب.`
      : `عدّل ${app ? app.data.fullNameAr : "حكم"} ${requestTypeLabel(request)} قبل مراجعته.`,
    link: "#/admin-requests",
    meta: { requestId: request.id },
  });

  await db.saveAll(data);
  pushRealtime(data, created);
  res.json({ request });
});

// ---- Referees can delete their OWN request ONLY while it is still "قيد
//      المراجعة" for the first time — i.e. the admin hasn't acted on it yet
//      (status still REQUEST_STATUS.PENDING and it was never sent back for
//      توضيح). Once the admin has touched it in any way (طلب توضيح, قبول,
//      رفض) the referee can never delete it, at any point afterwards —
//      re-editing a توضيح request back to "pending" does NOT reopen delete,
//      since history.length > 1 marks it as already handled at least once. ----
router.delete("/mine/:id", requireAuth, requireRole("referee"), requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const request = findRequest(data, req.params.id);
  if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "الطلب غير موجود." });

  const everHandledByAdmin = (request.history || []).some((h) => h.by === "admin");
  if (request.status !== REQUEST_STATUS.PENDING || everHandledByAdmin) {
    return res.status(403).json({ error: "لا يمكن حذف هذا الطلب إلا وهو قيد المراجعة لأول مرة، قبل أن تتعامل معه الإدارة." });
  }

  if (request.attachment && request.attachment.publicId) {
    try {
      await cloudinaryLib.destroyAsset(request.attachment.publicId, request.attachment.resourceType);
    } catch (e) {
      // Non-fatal — proceed with deleting the request record even if the
      // remote asset cleanup fails (e.g. already gone).
    }
  }

  data.requests = data.requests.filter((r) => r.id !== request.id);
  await db.saveAll(data);
  res.json({ ok: true });
});

module.exports = router;
