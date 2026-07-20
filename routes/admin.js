const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireRole } = require("../middleware/auth");
const { allFieldKeys, DOC_TYPES } = require("../schema");

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

// ---- Get single application ----
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

module.exports = router;
