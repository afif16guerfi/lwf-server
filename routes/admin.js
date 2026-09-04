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
const { allFieldKeys, ACCOUNT_STATUS, ACCOUNT_STATUS_LABELS, getAccountStatus, isValidRegistrationField, registrationFieldLabel, REQUEST_STATUS, checkPhoneUniqueness, syncUserFromApplicationData, isValidUsername, isValidEmail, isValidForScript, isValidPhone } = require("../schema");
const { addAuditEntries } = require("../auditCore");
const { sanitizeRichText, eligibleRefereeIds } = require("../announcementsCore");
const { MAX_UPLOAD_MB } = require("../config");
const { REGISTRATION_MODES, getSettings, isRegistrationOpen, isSiteEnabled } = require("../settingsCore");
const { toPublic, sortedRequirements, newRequirementId } = require("../documentRequirementsCore");
const { NOTIFICATION_TYPES, notifyUser, notifyUsers, pushRealtime, removeNotificationsByMeta } = require("../notificationsCore");
const { getAuditLog } = require("../auditCore");

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

// ---- Pagination (section 8: pagination on every account list in the
// referee platform, with a 5/10/20/50 page-size choice) ----------------
const ALLOWED_PAGE_SIZES = [5, 10, 20, 50];
function paginate(list, query) {
  const pageSize = ALLOWED_PAGE_SIZES.includes(parseInt(query.pageSize, 10)) ? parseInt(query.pageSize, 10) : 20;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), total: list.length, page, pageSize, totalPages };
}


// ---- List applications (excludes drafts referees haven't submitted yet) ----
// Section 8: same server-side pagination pattern as GET /users above.
router.get("/applications", async (req, res) => {
  const data = await db.getAll();
  let apps = data.applications.filter((a) => a.status !== "draft");
  if (req.query.status && req.query.status !== "all") apps = apps.filter((a) => a.status === req.query.status);
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    apps = apps.filter((a) => [a.data && a.data.fullNameAr, a.data && a.data.fullNameLatin, a.data && a.data.email, a.data && a.data.phone1]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }
  apps.sort((a, b) => new Date(b.submittedAt || b.updatedAt) - new Date(a.submittedAt || a.updatedAt));

  const counts = {
    all: data.applications.filter((a) => a.status !== "draft").length,
    pending_review: data.applications.filter((a) => a.status === "pending_review").length,
    approved: data.applications.filter((a) => a.status === "approved").length,
    rejected: data.applications.filter((a) => a.status === "rejected").length,
  };

  if (req.query.page || req.query.pageSize) {
    const { items, total, page, pageSize, totalPages } = paginate(apps, req.query);
    return res.json({ applications: items, total, page, pageSize, totalPages, counts });
  }
  // Backward-compatible: no pagination params -> full list, as before.
  res.json({ applications: apps, counts });
});

// ---- List all registered referee accounts (with or without a submitted file) ----
// Section 8: server-side pagination (page-size choice 5/10/20/50) working
// together with search (?q=) and status filtering (?status= one of the
// accountStatus values, or "disabled" for administratively-disabled
// accounts) — every list on the منصة الحكام that shows accounts routes
// through this one endpoint with a different ?status=.
router.get("/users", async (req, res) => {
  const data = await db.getAll();
  let referees = data.users
    .filter((u) => u.role === "referee")
    .map((u) => {
      const app = data.applications.find((a) => a.userId === u.id);
      const accountStatus = getAccountStatus(u);
      return {
        id: u.id,
        fullNameAr: u.fullNameAr,
        fullNameLatin: u.fullNameLatin,
        username: u.username,
        email: u.email,
        phone: u.phone,
        createdAt: u.createdAt,
        accountStatus,
        accountStatusLabel: ACCOUNT_STATUS_LABELS[accountStatus],
        // Account activation review (قيد المراجعة → مفعّل / يحتاج إلى تعديل / مرفوض)
        reviewFields: u.reviewFields || [],
        reviewNote: u.reviewNote || null,
        rejectionReason: u.rejectionReason || null,
        awaitingReview: accountStatus === ACCOUNT_STATUS.PENDING_REVIEW,
        applicationId: app ? app.id : null,
        applicationStatus: app ? app.status : "draft",
        signatureLocked: !!(u.signature && u.signature.locked),
        // Administrative disable (independent of the review workflow above —
        // see POST /users/:id/disable)
        disabled: !!u.disabled,
        disabledAt: u.disabledAt || null,
        submittedAt: u.submittedAt || u.createdAt,
        reviewedAt: u.reviewedAt || null,
        approvedAt: u.approvedAt || null,
        rejectedAt: u.rejectedAt || null,
        clarificationRequestedAt: u.clarificationRequestedAt || null,
        clarificationSubmittedAt: u.clarificationSubmittedAt || null,
        lastActivityAt: u.lastSeenAt || u.updatedAt || u.createdAt,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const counts = {
    all: referees.length,
    pending: referees.filter((u) => u.accountStatus === ACCOUNT_STATUS.PENDING_REVIEW).length,
    needs_edit: referees.filter((u) => u.accountStatus === ACCOUNT_STATUS.NEEDS_EDIT).length,
    active: referees.filter((u) => u.accountStatus === ACCOUNT_STATUS.ACTIVE && !u.disabled).length,
    rejected: referees.filter((u) => u.accountStatus === ACCOUNT_STATUS.REJECTED).length,
    disabled: referees.filter((u) => u.disabled).length,
  };

  if (req.query.status === "disabled") referees = referees.filter((u) => u.disabled);
  else if (req.query.status && req.query.status !== "all") referees = referees.filter((u) => u.accountStatus === req.query.status);

  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    referees = referees.filter((u) => [u.fullNameAr, u.fullNameLatin, u.username, u.email, u.phone]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }

  const sortKey = req.query.sort;
  const sorters = {
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    last_activity: (a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt),
    name: (a, b) => String(a.fullNameAr).localeCompare(String(b.fullNameAr), "ar"),
    approved_at: (a, b) => new Date(b.approvedAt || 0) - new Date(a.approvedAt || 0),
    rejected_at: (a, b) => new Date(b.rejectedAt || 0) - new Date(a.rejectedAt || 0),
    clarification_at: (a, b) => new Date(b.clarificationRequestedAt || 0) - new Date(a.clarificationRequestedAt || 0),
    resubmitted_at: (a, b) => new Date(b.clarificationSubmittedAt || 0) - new Date(a.clarificationSubmittedAt || 0),
  };
  if (sorters[sortKey]) referees.sort(sorters[sortKey]);

  const { items, total, page, pageSize, totalPages } = paginate(referees, req.query);
  res.json({ users: items, total, page, pageSize, totalPages, counts });
});

// ---- Account activation review: full history for one referee's account
//      (registration date, every review cycle, who reviewed it, what was
//      requested, what the referee changed, when they resubmitted, and the
//      outcome of each round) — used from the admin's review screen for
//      that account. ----
router.get("/users/:id/registration-history", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  const accountStatus = getAccountStatus(user);
  res.json({
    accountStatus,
    accountStatusLabel: ACCOUNT_STATUS_LABELS[accountStatus],
    reviewFields: user.reviewFields || [],
    reviewNote: user.reviewNote || null,
    rejectionReason: user.rejectionReason || null,
    registrationHistory: user.registrationHistory || [],
  });
});

// ---- Audit Log: every change made to a referee's core data (name, email,
//      phone, rank, season…), whoever made it — the referee themselves, the
//      admin editing directly, or an approved "طلب تعديل معلومة" — with the
//      old/new value, who made it, when, and why. Admin-only (this whole
//      router requires the admin role). Optional ?userId= to see one
//      referee's history only (used from their profile/review screen). ----
router.get("/audit-log", async (req, res) => {
  const data = await db.getAll();
  const entries = getAuditLog(data, { userId: req.query.userId || undefined });
  res.json({ entries, total: entries.length });
});

// ---- Delete a referee account entirely (user + application + requests +
//      chat trail). Section 15: after deletion the referee must vanish
//      completely — from the referee list, search, active accounts, and
//      the chat system (participant lists, the public conversation, any
//      private/group conversation) — with no reference left that could
//      make them reappear. ----
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

  const deletedRequestIds = new Set((data.requests || []).filter((r) => r.userId === user.id).map((r) => r.id));

  // ---- Chat cleanup (section 15) ----
  // 1. This referee's own messages, in every conversation, are removed
  //    outright — not just hidden — so no trace of them (name, content,
  //    timestamps) remains anywhere in the chat system.
  const affectedConversationIds = new Set(
    (data.conversationMembers || []).filter((m) => m.userId === user.id).map((m) => m.conversationId)
  );
  data.messages = (data.messages || []).filter((m) => m.senderId !== user.id);
  // 2. Remove their membership from every conversation (public, private,
  //    group) — this alone already drops them from every participant
  //    list and member-count anywhere in the UI.
  data.conversationMembers = (data.conversationMembers || []).filter((m) => m.userId !== user.id);
  // 3. A private (1-to-1) or group conversation that now has one member
  //    left (or none) is a dead end with nobody left to talk to — remove
  //    it entirely rather than leave an empty shell that could still
  //    surface the deleted referee's name in its title/history.
  affectedConversationIds.forEach((convId) => {
    const conv = data.conversations.find((c) => c.id === convId);
    if (!conv || conv.type === "public") return; // public conversation always persists
    const remaining = (data.conversationMembers || []).filter((m) => m.conversationId === convId).length;
    if (remaining <= 1) {
      data.conversations = data.conversations.filter((c) => c.id !== convId);
      data.conversationMembers = (data.conversationMembers || []).filter((m) => m.conversationId !== convId);
      data.messages = (data.messages || []).filter((m) => m.conversationId !== convId);
    }
  });
  // 4. Cut off any live session immediately, and tell whoever was looking
  //    at a conversation with them that they're gone (so a client that
  //    still has them rendered in a member list refreshes it).
  const contactedIds = new Set();
  affectedConversationIds.forEach((convId) => {
    (data.conversationMembers || []).filter((m) => m.conversationId === convId).forEach((m) => contactedIds.add(m.userId));
  });
  realtime.disconnectUser(user.id);

  data.users = data.users.filter((u) => u.id !== user.id);
  data.applications = data.applications.filter((a) => a.userId !== user.id);
  data.requests = (data.requests || []).filter((r) => r.userId !== user.id);
  // Clean up: this referee's own notifications, and any admin notification
  // that pointed at one of their now-deleted requests.
  removeNotificationsByMeta(data, (n) => n.userId === user.id || (n.meta && deletedRequestIds.has(n.meta.requestId)));

  await db.saveAll(data);
  realtime.sendToUsers([...contactedIds], "user:removed", { userId: user.id });
  res.json({ ok: true });
});

// ---- Edit a referee's account information directly (section 7: full name,
//      username — and optionally password/email/phone in the same call).
//      Actually writes to the database (not just accountStatus review
//      fields), with the same uniqueness/format rules registration uses,
//      and is recorded in the audit log like any other admin edit. ----
router.put("/users/:id", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  const changes = [];
  const body = req.body || {};

  if (body.fullNameAr !== undefined) {
    const v = String(body.fullNameAr).trim();
    if (!v || !isValidForScript("ar", v)) return res.status(400).json({ error: "الاسم الكامل بالعربية غير صحيح." });
    if (v !== user.fullNameAr) { changes.push(["fullNameAr", user.fullNameAr, v]); user.fullNameAr = v; }
  }
  if (body.fullNameLatin !== undefined) {
    const v = String(body.fullNameLatin).trim();
    if (v && !isValidForScript("latin", v)) return res.status(400).json({ error: "الاسم الكامل باللاتينية غير صحيح." });
    if (v !== (user.fullNameLatin || "")) { changes.push(["fullNameLatin", user.fullNameLatin, v]); user.fullNameLatin = v || null; }
  }
  if (body.username !== undefined) {
    const v = String(body.username).trim();
    if (!isValidUsername(v)) return res.status(400).json({ error: "اسم المستخدم غير صحيح (أحرف لاتينية وأرقام فقط)." });
    const taken = data.users.some((u) => u.id !== user.id && u.username.toLowerCase() === v.toLowerCase());
    if (taken) return res.status(400).json({ error: "اسم المستخدم مستخدم بالفعل." });
    if (v !== user.username) { changes.push(["username", user.username, v]); user.username = v; }
  }
  if (body.email !== undefined) {
    const v = String(body.email).trim();
    if (!isValidEmail(v)) return res.status(400).json({ error: "البريد الإلكتروني غير صحيح." });
    const taken = data.users.some((u) => u.id !== user.id && (u.email || "").toLowerCase() === v.toLowerCase());
    if (taken) return res.status(400).json({ error: "البريد الإلكتروني مستخدم بالفعل." });
    if (v !== user.email) { changes.push(["email", user.email, v]); user.email = v; }
  }
  if (body.phone !== undefined) {
    const v = String(body.phone).trim();
    if (!isValidPhone(v)) return res.status(400).json({ error: "رقم الهاتف غير صحيح." });
    const check = checkPhoneUniqueness(data, { phone1: v }, user.id);
    if (!check.ok) return res.status(400).json({ error: check.message || "رقم الهاتف مستخدم بالفعل." });
    if (v !== user.phone) { changes.push(["phone", user.phone, v]); user.phone = v; }
  }
  if (body.password !== undefined && String(body.password).trim()) {
    const pw = String(body.password).trim();
    if (pw.length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تتكون من 6 أحرف على الأقل." });
    user.password = await bcrypt.hash(pw, 10);
    changes.push(["password", "••••••", "••••••"]); // never store/expose the actual value in the audit trail
  }

  if (!changes.length) return res.status(400).json({ error: "لم يتم إدخال أي تعديل." });

  user.updatedAt = new Date().toISOString();
  addAuditEntries(
    data, user.id,
    changes.map(([field, oldValue, newValue]) => ({ field, oldValue, newValue })),
    { changedBy: "admin", changedByUserId: req.user.id, changedByName: req.user.username, reason: "تعديل مباشر من الإدارة على معلومات الحساب", source: "admin_edit" }
  );
  await db.saveAll(data);
  res.json({
    ok: true,
    user: { id: user.id, fullNameAr: user.fullNameAr, fullNameLatin: user.fullNameLatin, username: user.username, email: user.email, phone: user.phone },
  });
});

// ---- Administrative disable/enable (section 6 & 7) — independent of the
//      registration-review workflow (accountStatus) above: an already
//      fully-approved referee can still be suspended, e.g. for a
//      disciplinary reason, without touching their review history. Blocks
//      login (routes/auth.js + middleware/auth.js) immediately, including
//      for an already-open session. ----
router.post("/users/:id/disable", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  if (user.disabled) return res.status(400).json({ error: "الحساب معطّل بالفعل." });

  user.disabled = true;
  user.disabledAt = new Date().toISOString();
  user.disabledBy = req.user.id;
  user.disabledReason = req.body && req.body.reason ? String(req.body.reason).trim() : null;
  await db.saveAll(data);
  realtime.disconnectUser(user.id);
  res.json({ ok: true, disabled: true, disabledAt: user.disabledAt });
});

router.post("/users/:id/enable", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  if (!user.disabled) return res.status(400).json({ error: "الحساب مفعّل بالفعل." });

  user.disabled = false;
  user.enabledAt = new Date().toISOString();
  user.enabledBy = req.user.id;
  await db.saveAll(data);
  res.json({ ok: true, disabled: false, enabledAt: user.enabledAt });
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
    fullNameAr: user.fullNameAr,
    newPassword, // returned once in plain text so the admin can hand it to the referee
  });
});

// ---- Exceptional correction: unlock a referee's e-signature so they can
//      draw a new one. Normally the signature becomes immutable the moment
//      the referee submits their التعهد (see routes/applications.js
//      /mine/submit and the hard lock in routes/auth.js POST /signature) —
//      this is the only way to lift that lock, and it's restricted to
//      admins by the requireRole("admin") middleware applied to this whole
//      router above. It only clears the lock flag; it does not touch the
//      stored image or the application itself, so the referee still has to
//      actively draw and save a replacement afterwards. ----
router.post("/users/:id/unlock-signature", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  if (!user.signature) return res.status(400).json({ error: "لا يوجد إمضاء محفوظ لهذا الحكم." });

  user.signature.locked = false;
  user.signature.unlockedAt = new Date().toISOString();
  user.signature.unlockedBy = req.user.id;
  await db.saveAll(data);
  res.json({ ok: true });
});

// ---- Account activation review — the admin has exactly three outcomes
//      when reviewing a new (or resubmitted) registration:
//        🟢 accept        -> "active"       (see acceptRegistration below)
//        🔵 request-edit  -> "needs_edit"    (admin names field(s) + a note)
//        🔴 reject        -> "rejected"      (admin must give a reason)
//      All three act on the SAME account and never create a duplicate. A
//      shared helper does the actual work so the legacy /activate route
//      below (kept for backward compatibility with anything already calling
//      it) and the new /accept route behave identically. ----
async function acceptRegistration(data, user, by) {
  const before = getAccountStatus(user);
  const nowIso = new Date().toISOString();
  user.accountStatus = ACCOUNT_STATUS.ACTIVE;
  user.reviewFields = [];
  user.reviewNote = null;
  user.rejectionReason = null;
  user.reviewedAt = nowIso;
  user.approvedAt = nowIso;
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({ at: nowIso, event: "قبول الحساب وتفعيله", by: by.id, byRole: "admin", statusBefore: before, statusAfter: ACCOUNT_STATUS.ACTIVE });
  const { conversation: publicConv } = ensurePublicConversation(data);
  return publicConv;
}

// ---- Activate a pending referee account: unlocks the dashboard/form/
//      requests/announcements/group chats. Reuses ensurePublicConversation so
//      the referee is enrolled into the public chat in the same request.
//      Kept as-is (same path, same response shape) for backward
//      compatibility — equivalent to POST /users/:id/accept below. ----
router.post("/users/:id/activate", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  const publicConv = await acceptRegistration(data, user, { id: req.user.id });
  const created = notifyUser(data, user.id, {
    type: NOTIFICATION_TYPES.REGISTRATION_ACCEPTED,
    title: "تم قبول حسابك",
    body: "راجعت الإدارة تسجيلك وقبلته — يمكنك الآن متابعة الخطوات التالية في المنصة.",
    link: "#/dashboard",
  });
  await db.saveAll(data);

  realtime.sendToUser(user.id, "account:activated", {});
  realtime.sendToUsers(
    memberIdsOf(data, publicConv.id).filter((id) => id !== user.id),
    "conversation:member_joined",
    { conversationId: publicConv.id, userId: user.id, fullNameAr: user.fullNameAr }
  );
  if (created) pushRealtime(data, [created]);
  res.json({ ok: true, accountStatus: user.accountStatus });
});

// ---- 🟢 قبول الحساب — same action as /activate above, added under the
//      explicit review-workflow naming used by the new admin review screen.
//      Reachable from "قيد المراجعة" or "يحتاج إلى تعديل" (an admin may
//      decide the info is fine even before a formal resubmit). ----
router.post("/users/:id/accept", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  const status = getAccountStatus(user);
  if (status === ACCOUNT_STATUS.ACTIVE) return res.status(400).json({ error: "الحساب مفعّل بالفعل." });
  if (status === ACCOUNT_STATUS.REJECTED) return res.status(400).json({ error: "هذا الحساب مرفوض. أعد فتح المراجعة أولاً قبل القبول." });

  const publicConv = await acceptRegistration(data, user, { id: req.user.id });
  const created = notifyUser(data, user.id, {
    type: NOTIFICATION_TYPES.REGISTRATION_ACCEPTED,
    title: "تم قبول حسابك",
    body: "راجعت الإدارة تسجيلك وقبلته — يمكنك الآن متابعة الخطوات التالية في المنصة.",
    link: "#/dashboard",
  });
  await db.saveAll(data);

  realtime.sendToUser(user.id, "account:activated", {});
  realtime.sendToUsers(
    memberIdsOf(data, publicConv.id).filter((id) => id !== user.id),
    "conversation:member_joined",
    { conversationId: publicConv.id, userId: user.id, fullNameAr: user.fullNameAr }
  );
  if (created) pushRealtime(data, [created]);
  res.json({ ok: true, accountStatus: user.accountStatus });
});

// ---- 🔵 طلب توضيح / تعديل معلومة — the admin names which registration
//      field(s) need correcting and writes a note explaining what's needed.
//      Reachable from "قيد المراجعة" or "يحتاج إلى تعديل" (a second round of
//      corrections after a resubmit that still isn't right). Never touches
//      the account or application otherwise — the referee corrects it
//      themselves via PUT /auth/registration + POST /auth/registration/
//      resubmit, which is the only thing that moves it back to "قيد
//      المراجعة". ----
router.post("/users/:id/request-edit", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  const status = getAccountStatus(user);
  if (status === ACCOUNT_STATUS.ACTIVE) return res.status(400).json({ error: "الحساب مفعّل بالفعل — لا حاجة لطلب تعديل." });
  if (status === ACCOUNT_STATUS.REJECTED) return res.status(400).json({ error: "هذا الحساب مرفوض. أعد فتح المراجعة أولاً." });

  const { fields, note } = req.body;
  const fieldList = Array.isArray(fields) ? fields.filter((f) => isValidRegistrationField(f)) : [];
  if (fieldList.length === 0) return res.status(400).json({ error: "حدد معلومة واحدة على الأقل تحتاج إلى تعديل." });
  const trimmedNote = String(note || "").trim();
  if (!trimmedNote) return res.status(400).json({ error: "يجب كتابة ملاحظة توضح للحكم المطلوب تعديله." });

  const before = status;
  user.accountStatus = ACCOUNT_STATUS.NEEDS_EDIT;
  user.reviewFields = fieldList;
  user.reviewNote = trimmedNote;
  user.reviewedAt = new Date().toISOString();
  user.clarificationRequestedAt = user.reviewedAt;
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({
    at: new Date().toISOString(),
    event: "طلبت الإدارة تعديل معلومة/معلومات في التسجيل",
    by: req.user.id, byRole: "admin",
    statusBefore: before, statusAfter: ACCOUNT_STATUS.NEEDS_EDIT,
    fields: fieldList, note: trimmedNote,
  });

  const created = notifyUser(data, user.id, {
    type: NOTIFICATION_TYPES.REGISTRATION_NEEDS_EDIT,
    title: "مطلوب تصحيح معلومات التسجيل",
    body: `${fieldList.map((f) => registrationFieldLabel(f)).join("، ")} — ${trimmedNote}`,
    link: "#/registration-status",
    meta: { fields: fieldList },
  });
  await db.saveAll(data);
  if (created) pushRealtime(data, [created]);
  res.json({ ok: true, accountStatus: user.accountStatus, reviewFields: user.reviewFields, reviewNote: user.reviewNote });
});

// ---- 🔴 رفض الحساب — reason is mandatory. Stops the registration; the
//      account stays inactive and reachable only to see the rejection
//      reason and message the admin (see requireActiveAccount /
//      canAccessConversation, both now treat any non-"active" status the
//      same way). Use /reopen below if the admin needs to walk this back. ----
router.post("/users/:id/reject", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  const status = getAccountStatus(user);
  if (status === ACCOUNT_STATUS.ACTIVE) return res.status(400).json({ error: "لا يمكن رفض حساب مفعّل بالفعل." });
  if (status === ACCOUNT_STATUS.REJECTED) return res.status(400).json({ error: "الحساب مرفوض بالفعل." });

  const reason = String(req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "يجب كتابة سبب الرفض." });

  const before = status;
  user.accountStatus = ACCOUNT_STATUS.REJECTED;
  user.rejectionReason = reason;
  user.reviewFields = [];
  user.reviewNote = null;
  user.rejectedAt = new Date().toISOString();
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({ at: new Date().toISOString(), event: "رفض الحساب", by: req.user.id, byRole: "admin", statusBefore: before, statusAfter: ACCOUNT_STATUS.REJECTED, reason });

  const created = notifyUser(data, user.id, {
    type: NOTIFICATION_TYPES.REGISTRATION_REJECTED,
    title: "تم رفض تسجيلك",
    body: reason,
    link: "#/registration-status",
  });
  await db.saveAll(data);
  if (created) pushRealtime(data, [created]);
  res.json({ ok: true, accountStatus: user.accountStatus, rejectionReason: user.rejectionReason });
});

// ---- Admin error-recovery: reopen a rejected account back to "قيد
//      المراجعة" (e.g. rejected by mistake). Not part of the referee-facing
//      cycle — only an admin action, mirroring the existing "revoke" pattern
//      already used for application approvals below. ----
router.post("/users/:id/reopen", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });
  if (getAccountStatus(user) !== ACCOUNT_STATUS.REJECTED) return res.status(400).json({ error: "هذا الإجراء متاح فقط للحسابات المرفوضة." });

  user.accountStatus = ACCOUNT_STATUS.PENDING_REVIEW;
  const previousReason = user.rejectionReason;
  user.rejectionReason = null;
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({ at: new Date().toISOString(), event: "أعادت الإدارة فتح مراجعة الحساب بعد الرفض", by: req.user.id, byRole: "admin", statusBefore: ACCOUNT_STATUS.REJECTED, statusAfter: ACCOUNT_STATUS.PENDING_REVIEW, previousReason });
  await db.saveAll(data);
  res.json({ ok: true, accountStatus: user.accountStatus });
});

// ---- Revert an account to pending (e.g. activated by mistake). Does not
//      remove them from conversations they already joined — only blocks
//      further access until reactivated. Kept for backward compatibility;
//      only reachable from "active", unlike /reopen above which is for
//      "rejected". ----
router.post("/users/:id/deactivate", async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.params.id && u.role === "referee");
  if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

  const before = getAccountStatus(user);
  user.accountStatus = ACCOUNT_STATUS.PENDING_REVIEW;
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({ at: new Date().toISOString(), event: "أعادت الإدارة الحساب إلى قيد المراجعة", by: req.user.id, byRole: "admin", statusBefore: before, statusAfter: ACCOUNT_STATUS.PENDING_REVIEW });
  await db.saveAll(data);
  res.json({ ok: true, accountStatus: user.accountStatus });
});


router.get("/applications/:id", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  const owner = data.users.find((u) => u.id === app.userId);
  const refereeSignature = owner && owner.signature && owner.signature.url ? { url: owner.signature.url } : null;
  res.json({ application: app, refereeSignature });
});

// ---- Per-document audit mark, used by the side-by-side التدقيق screen
// (pageAdminAudit in app.js) to track "✅ matched / ⚠️ needs review /
// ❌ rejected" as the admin flips through documents one by one. This is a
// bookkeeping layer on top of the existing approve/reject mechanism below,
// not a replacement for it: the final accept/reject decision is still made
// exactly as before, from the same `flags`/`docFlags` the admin has always
// used — a "rejected" mark here simply writes into that same `docFlags`
// entry (so it blocks approval exactly like manually flagging a document
// always has), and "ok"/"needs_review" are purely informational, stored
// separately in `docReviewMarks` so they never affect the approve/reject
// gate.
router.put("/applications/:id/doc-review", async (req, res) => {
  const data = await db.getAll();
  const app = data.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "الملف غير موجود." });
  const { docId, status, note } = req.body;
  const VALID_STATUSES = new Set(["ok", "needs_review", "rejected", "clear"]);
  if (!docId || typeof docId !== "string" || !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "بيانات غير صالحة." });
  }
  if (!app.docReviewMarks) app.docReviewMarks = {};
  if (status === "clear") {
    delete app.docReviewMarks[docId];
  } else {
    app.docReviewMarks[docId] = {
      status,
      note: typeof note === "string" ? note : "",
      at: new Date().toISOString(),
      by: req.user.id,
    };
  }
  if (!app.docFlags) app.docFlags = {};
  if (status === "rejected") {
    app.docFlags[docId] = typeof note === "string" ? note : "";
  } else if (app.docFlags[docId] !== undefined) {
    delete app.docFlags[docId];
  }
  await db.saveAll(data);
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

  // Phone uniqueness (phone1/phone2 only — emergencyPhone is exempt) is
  // enforced here too, not just on the referee's own self-service edit —
  // an admin editing a referee's file directly must never be able to write
  // in a number another referee already has as their phone1 or phone2.
  if (fields.phone1 !== undefined || fields.phone2 !== undefined) {
    const candidatePhone1 = fields.phone1 !== undefined ? String(fields.phone1) : app.data.phone1;
    const candidatePhone2 = fields.phone2 !== undefined ? String(fields.phone2) : app.data.phone2;
    const check = checkPhoneUniqueness(data, { phone1: candidatePhone1, phone2: candidatePhone2 }, app.userId);
    if (!check.ok) return res.status(409).json({ error: check.message, field: check.field });
  }

  let changedCount = 0;
  const touchedKeys = [];
  const fieldDiffs = []; // every actually-changed field, for the Audit Log — not just identity fields
  Object.entries(fields).forEach(([k, v]) => {
    if (valid.has(k)) {
      const newVal = typeof v === "string" ? v : String(v ?? "");
      const oldVal = app.data[k];
      if (String(oldVal ?? "") !== String(newVal ?? "")) fieldDiffs.push({ field: k, oldValue: oldVal, newValue: newVal });
      app.data[k] = newVal;
      touchedKeys.push(k);
      changedCount++;
    }
  });
  if (changedCount === 0) return res.status(400).json({ error: "لم يتم تحديد أي حقل صالح للتعديل." });

  // Single source of truth: mirror whichever identity fields (name/email/
  // phone1) the admin just touched onto the account record, in the same
  // request — so the change shows up everywhere immediately (chat, admin
  // account list, notifications, printed documents…), never leaving a
  // stale copy anywhere.
  const owner = data.users.find((u) => u.id === app.userId);
  if (owner) syncUserFromApplicationData(owner, app.data, touchedKeys);

  // Every actually-changed field is written to the Audit Log — who changed
  // it, old/new value, and the admin's note (`reason`), if one was given.
  if (fieldDiffs.length) {
    addAuditEntries(data, app.userId, fieldDiffs, {
      changedBy: "admin",
      changedByUserId: req.user.id,
      changedByName: req.user.username,
      source: "admin_edit",
      reason: typeof req.body.reason === "string" ? req.body.reason.trim() || null : null,
      accountStatusBefore: owner ? getAccountStatus(owner) : null,
      accountStatusAfter: owner ? getAccountStatus(owner) : null,
    });
  }

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
  app.reviewedBy = req.user.id;
  app.reviewedByUsername = req.user.username;
  logEvent(app, `وافقت الإدارة (${req.user.username}) على الملف وأصدرت وثيقة الانخراط`);
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
  app.reviewedBy = req.user.id;
  app.reviewedByUsername = req.user.username;
  app.flags = flags || {};
  app.docFlags = docFlags || {};
  app.rejectionSummary = rejectionSummary || "";
  logEvent(app, `رفضت الإدارة (${req.user.username}) الملف مع ملاحظات للتصحيح`);
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

// ---- Requests (absence / special / edit-info) submitted by referees ----
function logRequestHistory(request, { event, from, to, by, note }) {
  if (!Array.isArray(request.history)) request.history = [];
  request.history.push({ at: new Date().toISOString(), event, from: from || null, to: to || null, by: by || null, note: note || null });
}
function requestTypeLabelAdmin(r) {
  if (r.type === "absence") return "طلب غياب";
  if (r.type === "edit") return "طلب تعديل معلومة";
  return "طلب خاص";
}

router.get("/requests", async (req, res) => {
  const data = await db.getAll();
  const status = req.query.status;
  let list = data.requests || [];
  if (status) list = list.filter((r) => r.status === status);
  const withUser = list
    .map((r) => {
      const u = data.users.find((u) => u.id === r.userId);
      return { ...r, refereeName: u ? u.fullNameAr : "—", refereeUsername: u ? u.username : "—" };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests: withUser });
});

// ---- Approve — final and closed for the referee from this point on ----
router.post("/requests/:id/approve", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (REQUEST_STATUS.APPROVED === request.status || REQUEST_STATUS.REJECTED === request.status) {
    return res.status(400).json({ error: "تم البت في هذا الطلب بالفعل ولا يمكن تغيير قراره من هنا — استخدم «إعادة لقيد الانتظار» أولاً." });
  }
  const fromStatus = request.status;
  request.status = REQUEST_STATUS.APPROVED;
  request.adminNote = req.body.adminNote || "";
  request.decidedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  logRequestHistory(request, { event: "تم قبول الطلب", from: fromStatus, to: REQUEST_STATUS.APPROVED, by: "admin", note: request.adminNote });

  // For an "edit" (profile change) request, applying it means writing the
  // new value into the referee's application data — the single source of
  // truth — then mirroring it onto the account record (if it's one of the
  // identity fields) in the same request, exactly like every other write
  // path, so the change is reflected everywhere immediately and captured
  // in the Audit Log (with the referee's own stated reason for the
  // change, from `request.details`).
  if (request.type === "edit" && request.fieldKey) {
    const app = data.applications.find((a) => a.userId === request.userId);
    if (app) {
      const oldValue = app.data[request.fieldKey];
      app.data[request.fieldKey] = request.newValue;
      app.updatedAt = new Date().toISOString();
      logEvent(app, `وافقت الإدارة على طلب تعديل معلومة (${request.fieldKey}) من الحكم`);

      const owner = data.users.find((u) => u.id === request.userId);
      if (owner) {
        const diffs = syncUserFromApplicationData(owner, app.data, [request.fieldKey]);
        addAuditEntries(data, request.userId, diffs.length ? diffs : [{ field: request.fieldKey, oldValue, newValue: request.newValue }], {
          changedBy: "referee",
          changedByUserId: request.userId,
          changedByName: owner.fullNameAr,
          source: "edit_request",
          reason: request.details || null,
          accountStatusBefore: getAccountStatus(owner),
          accountStatusAfter: getAccountStatus(owner),
        });
      }
    }
  }

  const created = notifyUser(data, request.userId, {
    type: NOTIFICATION_TYPES.REQUEST_APPROVED,
    title: "تم قبول طلبك",
    body: `تم قبول ${requestTypeLabelAdmin(request)} الذي أرسلته.`,
    link: "#/requests",
    meta: { requestId: request.id },
  });

  await db.saveAll(data);
  if (created) pushRealtime(data, [created]);
  res.json({ request });
});

// ---- Reject — final and closed for the referee ----
router.post("/requests/:id/reject", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (REQUEST_STATUS.APPROVED === request.status || REQUEST_STATUS.REJECTED === request.status) {
    return res.status(400).json({ error: "تم البت في هذا الطلب بالفعل ولا يمكن تغيير قراره من هنا — استخدم «إعادة لقيد الانتظار» أولاً." });
  }
  const fromStatus = request.status;
  request.status = REQUEST_STATUS.REJECTED;
  request.adminNote = req.body.adminNote || "";
  request.decidedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  logRequestHistory(request, { event: "تم رفض الطلب", from: fromStatus, to: REQUEST_STATUS.REJECTED, by: "admin", note: request.adminNote });

  const created = notifyUser(data, request.userId, {
    type: NOTIFICATION_TYPES.REQUEST_REJECTED,
    title: "تم رفض طلبك",
    body: `تم رفض ${requestTypeLabelAdmin(request)} الذي أرسلته. يرجى الاطلاع على سبب الرفض.`,
    link: "#/requests",
    meta: { requestId: request.id },
  });

  await db.saveAll(data);
  if (created) pushRealtime(data, [created]);
  res.json({ request });
});

// ---- Request clarification/edit from the referee (🔵 يحتاج إلى توضيح) —
//      NOT a final rejection; the referee can edit and resend while in this
//      status (see routes/requests.js PUT /mine/:id). ----
router.post("/requests/:id/request-clarification", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (REQUEST_STATUS.APPROVED === request.status || REQUEST_STATUS.REJECTED === request.status) {
    return res.status(400).json({ error: "لا يمكن طلب توضيح على طلب تم البت فيه بالفعل." });
  }
  const note = String(req.body.adminNote || req.body.note || "").trim();
  if (!note) return res.status(400).json({ error: "يرجى كتابة ملاحظة توضح للحكم ما المطلوب منه." });

  const fromStatus = request.status;
  request.status = REQUEST_STATUS.NEEDS_CLARIFICATION;
  request.adminNote = note;
  request.decidedAt = null;
  request.updatedAt = new Date().toISOString();
  logRequestHistory(request, { event: "طلبت الإدارة توضيحًا/تعديلًا", from: fromStatus, to: REQUEST_STATUS.NEEDS_CLARIFICATION, by: "admin", note });

  const created = notifyUser(data, request.userId, {
    type: NOTIFICATION_TYPES.REQUEST_NEEDS_CLARIFICATION,
    title: "الإدارة تطلب توضيح/تعديل طلبك",
    body: note,
    link: "#/requests",
    meta: { requestId: request.id },
  });

  await db.saveAll(data);
  if (created) pushRealtime(data, [created]);
  res.json({ request });
});

// ---- Admin: edit a request's content directly (allowed regardless of
//      status, per the admin's full permissions over requests) ----
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
  logRequestHistory(request, { event: "عدّلت الإدارة محتوى الطلب مباشرة", from: request.status, to: request.status, by: "admin" });
  await db.saveAll(data);
  res.json({ request });
});

// ---- Revoke a decision and send the request back to "pending" ----
router.post("/requests/:id/revoke", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (request.status === REQUEST_STATUS.PENDING) return res.status(400).json({ error: "الطلب قيد المراجعة بالفعل." });
  const fromStatus = request.status;
  request.status = REQUEST_STATUS.PENDING;
  request.decidedAt = null;
  request.updatedAt = new Date().toISOString();
  logRequestHistory(request, { event: "أعادت الإدارة الطلب إلى قيد المراجعة", from: fromStatus, to: REQUEST_STATUS.PENDING, by: "admin" });
  await db.saveAll(data);
  res.json({ request });
});

// ---- Admin: delete a request entirely (the referee never can) ----
router.delete("/requests/:id", async (req, res) => {
  const data = await db.getAll();
  const request = (data.requests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "الطلب غير موجود." });
  if (request.attachment && request.attachment.publicId) {
    await cloudinaryLib.destroyAsset(request.attachment.publicId, request.attachment.resourceType);
  }
  data.requests = (data.requests || []).filter((r) => r.id !== req.params.id);
  // No dangling notification should point at a request that no longer
  // exists.
  removeNotificationsByMeta(data, (n) => n.meta && n.meta.requestId === req.params.id);
  await db.saveAll(data);
  res.json({ ok: true });
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

// ---- Edit an announcement (title/summary/content, replace image, add
//      attachments). The same announcement document is always kept and
//      updated in place — no new copy is ever created. Editing never
//      resets readBy on its own; if the admin marks the change as
//      significant (notifyOnUpdate=true) and the announcement is already
//      published, a fresh notification goes out to every eligible referee
//      instead (their existing read/unread state is left untouched). ----
router.put("/announcements/:id", announcementUploadFields, async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });

  const { title, summary, content, removeImage, notifyOnUpdate } = req.body;
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

  let created = [];
  if (a.status === "published" && (notifyOnUpdate === "true" || notifyOnUpdate === true)) {
    created = notifyUsers(data, eligibleRefereeIds(data), {
      type: NOTIFICATION_TYPES.ANNOUNCEMENT_UPDATED,
      title: "تحديث على إعلان سابق",
      body: `تم تحديث الإعلان: «${a.title}»`,
      link: `#/announcement/${a.id}`,
      meta: { announcementId: a.id },
    });
  }

  await db.saveAll(data);
  if (created.length) pushRealtime(data, created);
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
  // A deleted announcement must never leave a broken link behind in
  // someone's notification list.
  removeNotificationsByMeta(data, (n) => n.meta && n.meta.announcementId === req.params.id);
  await db.saveAll(data);
  res.json({ ok: true });
});

// ---- Publish (draft/archived -> published); keeps the original publish
//      date if republished. A notification only goes out to every eligible
//      referee the FIRST time an announcement is actually published — not
//      on every hide/republish cycle of the same announcement. ----
router.post("/announcements/:id/publish", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });
  const isFirstPublish = !a.publishedAt;
  a.status = "published";
  if (!a.publishedAt) a.publishedAt = new Date().toISOString();
  a.updatedAt = new Date().toISOString();

  let created = [];
  if (isFirstPublish) {
    created = notifyUsers(data, eligibleRefereeIds(data), {
      type: NOTIFICATION_TYPES.ANNOUNCEMENT_NEW,
      title: "تم نشر إعلان جديد من الإدارة",
      body: a.summary || a.title,
      link: `#/announcement/${a.id}`,
      meta: { announcementId: a.id },
    });
  }

  await db.saveAll(data);
  if (created.length) pushRealtime(data, created);
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

// ---- Read-tracking stats: who has opened this announcement, who hasn't,
//      and when — separate from whether the notification was opened (see
//      announcementsCore.js). Search/filter (قرأ/لم يقرأ, by name) is done
//      client-side against this full list, same pattern already used by
//      the other admin tables in this platform. ----
router.get("/announcements/:id/read-stats", async (req, res) => {
  const data = await db.getAll();
  const a = findAnnouncement(data, req.params.id);
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });

  const targetIds = eligibleRefereeIds(data);
  const readByMap = new Map((a.readBy || []).map((r) => [r.userId, r.readAt]));
  const rows = targetIds
    .map((userId) => {
      const u = data.users.find((x) => x.id === userId);
      const readAt = readByMap.get(userId) || null;
      return {
        userId,
        fullNameAr: u ? u.fullNameAr : "—",
        username: u ? u.username : "—",
        read: readByMap.has(userId),
        readAt,
      };
    })
    .sort((x, y) => {
      if (x.read !== y.read) return x.read ? -1 : 1; // read first
      return (y.readAt || "").localeCompare(x.readAt || "");
    });

  const targetedCount = rows.length;
  const readCount = rows.filter((r) => r.read).length;
  const unreadCount = targetedCount - readCount;
  const readRate = targetedCount ? Math.round((readCount / targetedCount) * 1000) / 10 : 0;

  res.json({ announcement: { id: a.id, title: a.title }, targetedCount, readCount, unreadCount, readRate, rows });
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

/* ================= whole-platform kill switch ("حالة الموقع") ================= */
// Every route in this file is already behind requireAuth + requireRole("admin")
// (see router.use at the top), and requireAuth itself unconditionally exempts
// admins from the kill switch — so an admin can always reach these two routes
// to check or flip the platform's status, even while it's disabled for
// everyone else.

// ---- Get current site status ----
router.get("/settings/site-status", async (req, res) => {
  const data = await db.getAll();
  const settings = getSettings(data);
  res.json({ site_enabled: isSiteEnabled(settings) });
});

// ---- Toggle the whole platform on/off ----
router.put("/settings/site-status", async (req, res) => {
  const { site_enabled } = req.body;
  if (typeof site_enabled !== "boolean") {
    return res.status(400).json({ error: "قيمة غير صالحة لحالة الموقع." });
  }
  const data = await db.getAll();
  const next = { ...getSettings(data), site_enabled };
  data.settings = next;
  await db.saveAll(data);
  res.json({ site_enabled: isSiteEnabled(next) });
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
