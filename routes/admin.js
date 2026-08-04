const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const realtime = require("../realtime");
const { ensurePublicConversation, memberIdsOf } = require("../chatCore");
const { requireAuth, requireRole } = require("../middleware/auth");
const { allFieldKeys, ACCOUNT_STATUS, getAccountStatus } = require("../schema");
const { sanitizeRichText } = require("../announcementsCore");
const { MAX_UPLOAD_MB } = require("../config");
const { REGISTRATION_MODES, getSettings, isRegistrationOpen } = require("../settingsCore");
const { toPublic, sortedRequirements, newRequirementId } = require("../documentRequirementsCore");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function logEvent(app, text) {
  app.history.push({ at: new Date().toISOString(), event: text });
}

// Character set avoids visually ambiguous characters (0/O, 1/l/I) so the
// admin can read the password aloud over the phone without confusion.
const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generateRandomPassword(length = 8) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARS[crypto.randomInt(0, PASSWORD_CHARS.length)];
  }
  return out;
}


// ---- List applications (excludes drafts referees haven't submitted yet) ----
router.get("/applications", async (req, res) => {
  const data = await db.getAll();
  const status = req.query.status;
  let apps = data.applications.filter((a) => a.status !== "draft");
  if (status) apps = apps.filter((a) => a.status === status);
  apps.sort((a, b) => new Date(b.submittedAt || b.updatedAt) - new Date(a.submittedAt || a.updatedAt));
  res.json({ applications: apps });
});

// ---- List all registered referee accounts (with or without a submitted file) ----
router.get("/users", async (req, res) => {
  const data = await db.getAll();
  const referees = data.users
    .filter((u) => u.role === "referee")
    .map((u) => {
      const app = data.applications.find((a) => a.userId === u.id);
      return {
        id: u.id,
        fullName: u.fullName,
        username: u.username,
        email: u.email,
        createdAt: u.createdAt,
        accountStatus: getAccountStatus(u),
        applicationId: app ? app.id : null,
        applicationStatus: app ? app.status : "draft",
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ users: referees, total: referees.length });
});

// ---- Delete a referee account entirely (user + application + requests) ----
router.delete("/users/:id", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  const app = data.applications.find((a) => a.userId === user.id);

  // Best-effort cleanup of any files this referee uploaded to Cloudinary.
  if (app && app.documents) {
    for (const doc of Object.values(app.documents)) {
      if (doc && doc.publicId) await cloudinaryLib.destroyAsset(doc.publicId, doc.resourceType);
    }
  }
  const myRequests = (data.requests || []).filter((r) => r.userId === user.id);
  for (const r of myRequests) {
    if (r.attachment && r.attachment.publicId) {
      await cloudinaryLib.destroyAsset(r.attachment.publicId, r.attachment.resourceType);
    }
  }

  data.users = data.users.filter((u) => u.id !== user.id);
  data.applications = data.applications.filter((a) => a.userId !== user.id);
  data.requests = (data.requests || []).filter((r) => r.userId !== user.id);

  await db.saveAll(data);
  res.json({ ok: true });
});

// ---- Reset a referee's password to a new random one ----
router.post("/users/:id/reset-password", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  const newPassword = generateRandomPassword(8);
  user.password = await bcrypt.hash(newPassword, 10);
  await db.saveAll(data);

  res.json({
    username: user.username,
    fullName: user.fullName,
    newPassword, // returned once in plain text so the admin can hand it to the referee
  });
});

// ---- Activate a pending referee account: unlocks the dashboard/form/
//      requests/announcements/group chats. Reuses ensurePublicConversation so
//      the referee is enrolled into the public chat in the same request. ----
router.post("/users/:id/activate", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  user.accountStatus = ACCOUNT_STATUS.ACTIVE;
  const { conversation: publicConv } = ensurePublicConversation(data);
  await db.saveAll(data);

  realtime.sendToUser(user.id, "account:activated", {});
  realtime.sendToUsers(
    memberIdsOf(data, publicConv.id).filter((id) => id !== user.id),
    "conversation:member_joined",
    { conversationId: publicConv.id, userId: user.id, fullName: user.fullName }
  );
  res.json({ ok: true, accountStatus: user.accountStatus });
});

// ---- Revert an account to pending (e.g. activated by mistake). Does not
//      remove them from conversations they already joined — only blocks
//      further access until reactivated. ----
router.post("/users/:id/deactivate", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  user.accountStatus = ACCOUNT_STATUS.PENDING;
  await db.saveAll(data);
  res.json({ ok: true, accountStatus: user.accountStatus });
});


router.get("/applications/:id", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  res.json({ application: app });
});

// ---- Admin: directly edit any referee's application data (any status) ----
router.put("/applications/:id", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  const { fields } = req.body;
  if (!fields || typeof fields !== "object") {
    return res.status(400).json({ error: "لا توجد بيانات لتعديلها." });
  }
  const valid = new Set(allFieldKeys());
  let changedCount = 0;
  Object.entries(fields).forEach(([k, v]) => {
    if (valid.has(k)) {
      app.data[k] = typeof v === "string" ? v : String(v ?? "");
      changedCount++;
    }
  });
  if (changedCount === 0) return res.status(400).json({ error: "لم يتم تحديد أي حقل صالح للتعديل." });
  app.updatedAt = new Date().toISOString();
  logEvent(app, "عدّلت الإدارة معلومات الملف مباشرة");
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Approve ----
router.post("/applications/:id/approve", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  if (app.status !== "pending_review") {
    return res.status(400).json({ error: "لا يمكن قبول الملف في وضعه الحالي." });
  }
  if (Object.keys(app.flags || {}).length || Object.keys(app.docFlags || {}).length) {
    return res.status(400).json({ error: "توجد ملاحظات معلقة، لا يمكن القبول قبل إزالتها أو رفض الملف بها." });
  }
  app.status = "approved";
  app.approvedAt = new Date().toISOString();
  app.reviewedAt = new Date().toISOString();
  logEvent(app, "وافقت الإدارة على الملف وأصدرت وثيقة الانخراط");
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Reject with field/doc-level flags ----
router.post("/applications/:id/reject", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  if (app.status !== "pending_review") {
    return res.status(400).json({ error: "لا يمكن رفض الملف في وضعه الحالي." });
  }
  const { flags, docFlags, rejectionSummary } = req.body;
  const hasFlags = (flags && Object.keys(flags).length) || (docFlags && Object.keys(docFlags).length);
  if (!hasFlags) {
    return res.status(400).json({ error: "يجب تحديد ملاحظة واحدة على الأقل قبل الرفض." });
  }
  app.status = "rejected";
  app.reviewedAt = new Date().toISOString();
  app.flags = flags || {};
  app.docFlags = docFlags || {};
  app.rejectionSummary = rejectionSummary || "";
  logEvent(app, "رفضت الإدارة الملف مع ملاحظات للتصحيح");
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Revoke a previous approval (send the file back to pending review) ----
router.post("/applications/:id/revoke", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  if (app.status !== "approved") {
    return res.status(400).json({ error: "لا يمكن التراجع إلا عن ملف مقبول (وثيقة انخراط صادرة)." });
  }
  app.status = "pending_review";
  app.approvedAt = null;
  logEvent(app, "تراجعت الإدارة عن الموافقة على الملف وأعادته لقائمة المراجعة");
  await db.saveAll(data);
  res.json({ application: app });
});

// ---- Requests (absence / special) submitted by referees ----
router.get("/requests", async (req, res) => {
  const data = await db.getAll();
  const status = req.query.status;
  let list = data.requests || [];
  if (status) list = list.filter((r) => r.status === status);
  const withUser = list
    .map((r) => {
      const u = data.users.find((u) => u.id === r.userId);
      return { ...r, refereeName: u ? u.fullName : "—", refereeUsername: u ? u.username : "—" };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests: withUser });
});

router.post("/requests/:id/approve", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  request.status = "approved";
  request.adminNote = req.body.adminNote || "";
  request.decidedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();

  // For an "edit" (profile change) request, applying it means writing the
  // new value into the referee's application data.
  if (request.type === "edit" && request.fieldKey) {
    const app = data.applications.find((a) => a.userId === request.userId);
    if (app) {
      app.data[request.fieldKey] = request.newValue;
      app.updatedAt = new Date().toISOString();
      logEvent(app, `وافقت الإدارة على طلب تعديل معلومة (${request.fieldKey}) من الحكم`);
    }
  }

  await db.saveAll(data);
  res.json({ request });
});

router.post("/requests/:id/reject", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  request.status = "rejected";
  request.adminNote = req.body.adminNote || "";
  request.decidedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ request });
});

// ---- Admin: edit a request's content directly ----
router.put("/requests/:id", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  const { title, details, dateFrom, dateTo, newValue } = req.body;
  if (request.type === "absence") {
    if (details !== undefined) request.details = String(details).trim();
    if (dateFrom !== undefined) request.dateFrom = dateFrom;
    if (dateTo !== undefined) request.dateTo = dateTo;
  } else if (request.type === "special") {
    if (title !== undefined) request.title = String(title).trim();
    if (details !== undefined) request.details = String(details).trim();
  } else if (request.type === "edit") {
    if (newValue !== undefined) request.newValue = String(newValue).trim();
    if (details !== undefined) request.details = String(details).trim();
  }
  request.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ request });
});

// ---- Revoke a decision and send the request back to "pending" ----
router.post("/requests/:id/revoke", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (request.status === "pending") return res.status(400).json({ error: "الطلب قيد الانتظار بالفعل." });
  request.status = "pending";
  request.decidedAt = null;
  request.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ request });
});

// ============================================================
// الإعلانات (Announcements) — full admin management.
// Referee-facing read-only access lives in routes/announcements.js.
// ============================================================

const announcementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("نوع الملف غير مدعوم."));
    cb(null, true);
  },
});
const announcementUploadFields = announcementUpload.fields([
  { name: "image", maxCount: 1 },
  { name: "attachments", maxCount: 10 },
]);

function findAnnouncement(data, id) {
  return (data.announcements || []).find((a) => a.id === id);
}

async function uploadAnnouncementImage(file) {
  if (!file) return null;
  if (!cloudinaryLib.isConfigured()) {
    throw Object.assign(new Error("لم يتم إعداد تخزين الملفات (Cloudinary)."), { status: 500 });
  }
  const result = await cloudinaryLib.uploadBuffer(file.buffer, {
    public_id: `announcement_image_${uuidv4()}`,
    resource_type: "image",
  });
  return { url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type };
}

async function uploadAnnouncementAttachments(files) {
  if (!files || !files.length) return [];
  if (!cloudinaryLib.isConfigured()) {
    throw Object.assign(new Error("لم يتم إعداد تخزين الملفات (Cloudinary)."), { status: 500 });
  }
  const out = [];
  for (const file of files) {
    const result = await cloudinaryLib.uploadBuffer(file.buffer, {
      public_id: `announcement_attachment_${uuidv4()}`,
      resource_type: "auto",
    });
    out.push({
      id: uuidv4(),
      originalName: file.originalname,
      mimetype: file.mimetype,
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    });
  }
  return out;
}

// ---- List all announcements (any status) ----
router.get("/announcements", async (req, res) => {
  const data = await db.getAll();
  const list = [...(data.announcements || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ announcements: list });
});

// ---- Get a single announcement (for the edit form / preview) ----
router.get("/announcements/:id", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  res.json({ announcement: a });
});

// ---- Create a new announcement (starts as a draft) ----
router.post("/announcements", announcementUploadFields, async (req, res) => {
  const { title, summary, content } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: "عنوان الإعلان مطلوب." });
  if (!summary || !String(summary).trim()) return res.status(400).json({ error: "الوصف المختصر مطلوب." });
  if (!content || !String(content).trim()) return res.status(400).json({ error: "محتوى الإعلان مطلوب." });

  const files = req.files || {};
  let image = null;
  let attachments = [];
  try {
    image = await uploadAnnouncementImage(files.image && files.image[0]);
    attachments = await uploadAnnouncementAttachments(files.attachments);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }

  const data = await db.getAll();
  const iso = new Date().toISOString();
  const announcement = {
    id: uuidv4(),
    title: String(title).trim(),
    summary: String(summary).trim(),
    content: sanitizeRichText(content),
    image,
    attachments,
    status: "draft",
    isPinned: false,
    publishedAt: null,
    createdAt: iso,
    updatedAt: iso,
    createdBy: req.user.id,
    readBy: [],
  };
  data.announcements.push(announcement);
  await db.saveAll(data);
  res.json({ announcement });
});

// ---- Edit an announcement (title/summary/content, replace image, add attachments) ----
router.put("/announcements/:id", announcementUploadFields, async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });

  const { title, summary, content, removeImage } = req.body;
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: "عنوان الإعلان مطلوب." });
    a.title = String(title).trim();
  }
  if (summary !== undefined) {
    if (!String(summary).trim()) return res.status(400).json({ error: "الوصف المختصر مطلوب." });
    a.summary = String(summary).trim();
  }
  if (content !== undefined) {
    if (!String(content).trim()) return res.status(400).json({ error: "محتوى الإعلان مطلوب." });
    a.content = sanitizeRichText(content);
  }

  const files = req.files || {};
  try {
    if (files.image && files.image[0]) {
      if (a.image && a.image.publicId) await cloudinaryLib.destroyAsset(a.image.publicId, a.image.resourceType);
      a.image = await uploadAnnouncementImage(files.image[0]);
    } else if (removeImage === "true" || removeImage === true) {
      if (a.image && a.image.publicId) await cloudinaryLib.destroyAsset(a.image.publicId, a.image.resourceType);
      a.image = null;
    }
    if (files.attachments && files.attachments.length) {
      const newOnes = await uploadAnnouncementAttachments(files.attachments);
      a.attachments = [...(a.attachments || []), ...newOnes];
    }
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }

  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

// ---- Remove a single attachment from an announcement ----
router.delete("/announcements/:id/attachments/:attachmentId", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  const att = (a.attachments || []).find((x) => x.id === req.params.attachmentId);
  if (!att) return res.status(404).json({ error: "المرفق غير موجود." });
  if (att.publicId) await cloudinaryLib.destroyAsset(att.publicId, att.resourceType);
  a.attachments = a.attachments.filter((x) => x.id !== req.params.attachmentId);
  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

// ---- Delete an announcement entirely (+ cleanup its Cloudinary assets) ----
router.delete("/announcements/:id", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  if (a.image && a.image.publicId) await cloudinaryLib.destroyAsset(a.image.publicId, a.image.resourceType);
  for (const att of a.attachments || []) {
    if (att.publicId) await cloudinaryLib.destroyAsset(att.publicId, att.resourceType);
  }
  data.announcements = data.announcements.filter((x) => x.id !== req.params.id);
  await db.saveAll(data);
  res.json({ ok: true });
});

// ---- Publish (draft/archived -> published); keeps the original publish date if republished ----
router.post("/announcements/:id/publish", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  a.status = "published";
  if (!a.publishedAt) a.publishedAt = new Date().toISOString();
  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

// ---- Hide (published -> draft; no longer visible to referees) ----
router.post("/announcements/:id/hide", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  if (a.status !== "published") return res.status(400).json({ error: "الإعلان غير منشور أصلًا." });
  a.status = "draft";
  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

// ---- Archive (from any status) ----
router.post("/announcements/:id/archive", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  a.status = "archived";
  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

// ---- Toggle pin (stays pinned to the top of the referees' list) ----
router.post("/announcements/:id/pin", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  a.isPinned = !a.isPinned;
  a.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ announcement: a });
});

/* ================= registration control & countdown ================= */

// ---- Get current registration settings (for the admin control panel) ----
router.get("/settings/registration", async (req, res) => {
  const data = await db.getAll();
  const settings = getSettings(data);
  res.json({ ...settings, isOpenNow: isRegistrationOpen(settings) });
});

// ---- Update registration settings: manual open/close switch, mode, deadline ----
router.put("/settings/registration", async (req, res) => {
  const { is_registration_open, registration_mode, registration_deadline } = req.body;
  const data = await db.getAll();
  const next = { ...getSettings(data) };

  if (typeof is_registration_open === "boolean") {
    next.is_registration_open = is_registration_open;
  }

  if (registration_mode !== undefined) {
    if (![REGISTRATION_MODES.ALWAYS_OPEN, REGISTRATION_MODES.TIMER].includes(registration_mode)) {
      return res.status(400).json({ error: "نمط تسجيل غير صالح." });
    }
    next.registration_mode = registration_mode;
  }

  if (registration_deadline !== undefined) {
    if (registration_deadline === null || registration_deadline === "") {
      next.registration_deadline = null;
    } else {
      const d = new Date(registration_deadline);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "تاريخ/وقت انتهاء التسجيل غير صالح." });
      next.registration_deadline = d.toISOString();
    }
  }

  if (next.registration_mode === REGISTRATION_MODES.TIMER && !next.registration_deadline) {
    return res.status(400).json({ error: "يرجى تحديد تاريخ ووقت انتهاء التسجيل عند اختيار النمط المؤقت." });
  }

  data.settings = next;
  await db.saveAll(data);
  res.json({ ...next, isOpenNow: isRegistrationOpen(next) });
});

// ============================================================
// إدارة وثائق الانخراط الديناميكي (Dynamic Document Requirements)
// Full admin control over which documents referees must upload, with an
// optional downloadable PDF template per document. Referee-facing read
// access to the same list lives in routes/documentRequirements.js.
// ============================================================

const docRequirementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") return cb(new Error("النموذج القابل للتحميل يجب أن يكون ملف PDF."));
    cb(null, true);
  },
});

function findDocRequirement(data, id) {
  return (data.documentRequirements || []).find((d) => d.id === id);
}

// Icons are plain emoji strings (consistent with the rest of the app's
// design system, e.g. 🪪📄🆔🎓💳) rather than an icon-font/component library.
// Generously capped rather than restricted to a fixed list, so the admin can
// also paste in any other single emoji beyond the frontend's preset picker.
function sanitizeIcon(raw) {
  if (!raw) return "📎";
  const trimmed = String(raw).trim();
  if (!trimmed) return "📎";
  return trimmed.slice(0, 8);
}

async function uploadTemplateFile(file) {
  if (!cloudinaryLib.isConfigured()) {
    const err = new Error("لم يتم إعداد تخزين الملفات (Cloudinary). أضف متغيرات البيئة CLOUDINARY_CLOUD_NAME وCLOUDINARY_API_KEY وCLOUDINARY_API_SECRET.");
    err.status = 500;
    throw err;
  }
  try {
    return await cloudinaryLib.uploadBuffer(file.buffer, {
      folder: "lwf-referees/doc-templates",
      public_id: `template_${uuidv4()}`,
      resource_type: "raw", // PDFs are stored as raw assets so the exact filename/extension is preserved on download
    });
  } catch (e) {
    console.error(e);
    const err = new Error("تعذّر رفع ملف النموذج إلى خدمة التخزين. حاول مرة أخرى.");
    err.status = 502;
    throw err;
  }
}

// ---- List all document requirements (admin view — includes internal fields) ----
router.get("/document-requirements", async (req, res) => {
  const data = await db.getAll();
  res.json({ documentRequirements: sortedRequirements(data.documentRequirements).map(toPublic) });
});

// ---- Add a new document requirement, optionally with a PDF template ----
router.post("/document-requirements", docRequirementUpload.single("template"), async (req, res) => {
  const { title, description, isRequired, hasTemplate, icon } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: "عنوان الوثيقة إجباري." });

  const wantsTemplate = hasTemplate === "true" || hasTemplate === true;
  if (wantsTemplate && !req.file) {
    return res.status(400).json({ error: "يرجى إرفاق ملف PDF للنموذج، أو إلغاء تفعيل خيار النموذج." });
  }

  let templateUrl = "", templatePublicId = "", templateOriginalName = "";
  if (wantsTemplate && req.file) {
    try {
      const uploadResult = await uploadTemplateFile(req.file);
      templateUrl = uploadResult.secure_url;
      templatePublicId = uploadResult.public_id;
      templateOriginalName = req.file.originalname;
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }
  }

  const data = await db.getAll();
  const maxOrder = (data.documentRequirements || []).reduce((m, d) => Math.max(m, d.order ?? 0), -1);
  const now = new Date().toISOString();
  const requirement = {
    id: newRequirementId(),
    title: String(title).trim(),
    description: description ? String(description).trim() : "",
    icon: sanitizeIcon(icon),
    isRequired: isRequired === "true" || isRequired === true,
    hasTemplate: wantsTemplate,
    templateUrl, templatePublicId, templateOriginalName,
    order: maxOrder + 1,
    createdAt: now, updatedAt: now,
  };
  data.documentRequirements.push(requirement);
  await db.saveAll(data);
  res.status(201).json({ documentRequirement: toPublic(requirement) });
});

// ---- Edit a document requirement (title/description/isRequired/template) ----
router.put("/document-requirements/:id", docRequirementUpload.single("template"), async (req, res) => {
  const data = await db.getAll();
  const requirement = findDocRequirement(data, req.params.id);
  if (!requirement) return res.status(404).json({ error: "الوثيقة غير موجودة." });

  const { title, description, isRequired, hasTemplate, removeTemplate, icon } = req.body;
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: "عنوان الوثيقة إجباري." });
    requirement.title = String(title).trim();
  }
  if (description !== undefined) requirement.description = String(description).trim();
  if (isRequired !== undefined) requirement.isRequired = isRequired === "true" || isRequired === true;
  if (icon !== undefined) requirement.icon = sanitizeIcon(icon);

  const wantsTemplate = hasTemplate === "true" || hasTemplate === true;
  const wantsRemoveTemplate = removeTemplate === "true" || removeTemplate === true;

  if (!wantsTemplate || wantsRemoveTemplate) {
    // Template disabled or explicitly removed — drop any previously stored file.
    if (requirement.templatePublicId) await cloudinaryLib.destroyAsset(requirement.templatePublicId, "raw");
    requirement.hasTemplate = false;
    requirement.templateUrl = "";
    requirement.templatePublicId = "";
    requirement.templateOriginalName = "";
  }
  if (wantsTemplate && req.file) {
    // Replacing an existing template file.
    if (requirement.templatePublicId) await cloudinaryLib.destroyAsset(requirement.templatePublicId, "raw");
    let uploadResult;
    try {
      uploadResult = await uploadTemplateFile(req.file);
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }
    requirement.hasTemplate = true;
    requirement.templateUrl = uploadResult.secure_url;
    requirement.templatePublicId = uploadResult.public_id;
    requirement.templateOriginalName = req.file.originalname;
  } else if (wantsTemplate && !wantsRemoveTemplate && !requirement.templateUrl) {
    return res.status(400).json({ error: "يرجى إرفاق ملف PDF للنموذج، أو إلغاء تفعيل خيار النموذج." });
  } else if (wantsTemplate) {
    requirement.hasTemplate = true;
  }

  requirement.updatedAt = new Date().toISOString();
  await db.saveAll(data);
  res.json({ documentRequirement: toPublic(requirement) });
});

// ---- Delete a document requirement ----
router.delete("/document-requirements/:id", async (req, res) => {
  const data = await db.getAll();
  const requirement = findDocRequirement(data, req.params.id);
  if (!requirement) return res.status(404).json({ error: "الوثيقة غير موجودة." });

  if (requirement.templatePublicId) await cloudinaryLib.destroyAsset(requirement.templatePublicId, "raw");
  data.documentRequirements = data.documentRequirements.filter((d) => d.id !== req.params.id);
  await db.saveAll(data);
  // Note: any files referees already uploaded for this requirement are left
  // in place on their applications (app.documents[id]) — removing the
  // requirement only stops asking for it going forward, it does not erase
  // already-submitted files or retroactively invalidate approved files.
  res.json({ ok: true });
});

module.exports = router;
