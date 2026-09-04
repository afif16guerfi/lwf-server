const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const realtime = require("../realtime");
const cloudinaryLib = require("../cloudinary");
const { JWT_SECRET } = require("../config");
const { requireAuth, requireRole } = require("../middleware/auth");
const { blankData, SEASON, ACCOUNT_STATUS, ACCOUNT_STATUS_LABELS, getAccountStatus, isValidForScript, isValidUsername, isValidPhone, isValidEmail, checkPhoneUniqueness } = require("../schema");
const { ensurePublicConversation, memberIdsOf } = require("../chatCore");
const { getSettings, isRegistrationOpen, isSiteEnabled, SITE_DISABLED_MESSAGE } = require("../settingsCore");
const { NOTIFICATION_TYPES, notifyAdmins, pushRealtime } = require("../notificationsCore");
const { addAuditEntries } = require("../auditCore");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function publicUser(u) {
  return {
    id: u.id, role: u.role, username: u.username, email: u.email, phone: u.phone,
    fullNameAr: u.fullNameAr, fullNameLatin: u.fullNameLatin,
    accountStatus: getAccountStatus(u),
    // Small, current-state-only slice of the registration review — enough
    // for the frontend to react (e.g. redirect to the registration-review
    // screen) without a second request. Full history lives behind
    // GET /auth/registration-status.
    reviewFields: Array.isArray(u.reviewFields) ? u.reviewFields : [],
    reviewNote: u.reviewNote || null,
    rejectionReason: u.rejectionReason || null,
    signature: u.signature && u.signature.url ? { url: u.signature.url, updatedAt: u.signature.updatedAt, locked: !!u.signature.locked } : null,
  };
}

// Case-insensitive everywhere a username/email is compared — "Ahmed" and
// "ahmed" are the same account, both for the one-of-a-kind check at signup
// and for matching a login attempt against whatever casing was stored.
// Storage keeps the casing the person typed (nicer to look at in admin
// lists); only comparisons are normalized.
function normUsername(v) { return String(v || "").trim().toLowerCase(); }
function normEmail(v) { return String(v || "").trim().toLowerCase(); }
function usernameTaken(data, username) {
  return data.users.some((u) => normUsername(u.username) === normUsername(username));
}
function emailTaken(data, email) {
  return data.users.some((u) => normEmail(u.email) === normEmail(email));
}
// Checked as a would-be phone1 against every OTHER account's phone1/phone2
// (and legacy user.phone) — رقم هاتف شخص الطوارئ is a completely separate
// field captured later in the enrollment form and never touches this check.
function phoneTaken(data, phone) {
  return !checkPhoneUniqueness(data, { phone1: phone }, null).ok;
}

// Used while the signup form is still being filled in — lets the UI show a
// green/red "available" indicator as the person types, before they submit.
// Doesn't require auth (there's no account yet at this point) and never
// mutates anything, so it's safe to leave open.
router.get("/availability", async (req, res) => {
  try {
    const { field, value } = req.query;
    const v = String(value || "").trim();
    if (!["username", "email", "phone"].includes(field) || !v) {
      return res.status(400).json({ error: "طلب غير صالح." });
    }
    const data = await db.getAll();
    if (field === "username") {
      if (!isValidUsername(v)) return res.json({ available: false, reason: "format" });
      return res.json({ available: !usernameTaken(data, v) });
    }
    if (field === "phone") {
      if (!isValidPhone(v)) return res.json({ available: false, reason: "format" });
      return res.json({ available: !phoneTaken(data, v) });
    }
    if (!isValidEmail(v)) return res.json({ available: false, reason: "format" });
    return res.json({ available: !emailTaken(data, v) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.post("/signup", async (req, res) => {
  try {
    const { fullNameAr, fullNameLatin, username, email, phone, password } = req.body;
    if (!fullNameAr || !fullNameLatin || !username || !email || !phone || !password) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة." });
    }
    if (!isValidForScript("ar", fullNameAr)) {
      return res.status(400).json({ error: "الاسم واللقب بالعربية يجب أن يُكتب بأحرف عربية فقط." });
    }
    if (!isValidForScript("latin", fullNameLatin)) {
      return res.status(400).json({ error: "الاسم واللقب باللاتينية يجب أن يُكتب بأحرف لاتينية (فرنسية/إنجليزية) فقط." });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: "اسم المستخدم يجب أن يتكون من أحرف لاتينية وأرقام فقط (بلا مسافات أو رموز)." });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "صيغة البريد الإلكتروني غير صحيحة. يجب أن يتكوّن من أحرف لاتينية (وأرقام عند الحاجة) فقط، بلا أحرف عربية (مثال: exemple@gmail.com)." });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "رقم الهاتف يجب أن يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام." });
    }
    if (String(password).length < 4) {
      return res.status(400).json({ error: "كلمة المرور قصيرة جدًا." });
    }
    const data = await db.getAll();

    // Whole-platform kill switch: checked before the registration-open
    // check below, and before any of the uniqueness checks — if the admin
    // disabled the site, nobody new can register regardless of anything
    // else. Re-checked fresh from the DB, so it can't be bypassed by
    // calling this endpoint directly.
    if (!isSiteEnabled(getSettings(data))) {
      return res.status(503).json({ error: SITE_DISABLED_MESSAGE, siteDisabled: true });
    }

    // Registration can be closed manually by the admin, or by an expired
    // countdown timer — checked here, server-side, so it can't be bypassed
    // by hitting the API directly even if the home page UI is stale.
    if (!isRegistrationOpen(getSettings(data))) {
      return res.status(403).json({ error: "التسجيل مغلق حالياً" });
    }

    if (usernameTaken(data, username)) {
      return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل." });
    }
    if (emailTaken(data, email)) {
      return res.status(409).json({ error: "البريد الإلكتروني مستخدم بالفعل." });
    }
    if (phoneTaken(data, phone)) {
      return res.status(409).json({ error: "رقم الهاتف مستخدم بالفعل." });
    }
    const hashed = await bcrypt.hash(password, 10);
    const nowIso = new Date().toISOString();
    const newUser = {
      id: uuidv4(),
      role: "referee",
      username,
      email,
      phone,
      fullNameAr,
      fullNameLatin,
      password: hashed,
      accountStatus: ACCOUNT_STATUS.PENDING_REVIEW,
      // Account activation review bookkeeping (see schema.js ACCOUNT_STATUS
      // and routes/admin.js /users/:id/accept|request-edit|reject) — kept on
      // the account itself, never a separate/duplicate record, so a
      // needs_edit -> resubmit cycle always updates this same account.
      reviewFields: [],
      reviewNote: null,
      rejectionReason: null,
      registrationHistory: [{ at: nowIso, event: "تم إنشاء الحساب وإرسال التسجيل", by: null, byRole: null }],
      createdAt: nowIso,
      // Named timestamp fields for the account's review lifecycle (kept
      // alongside the free-text registrationHistory log above so each
      // milestone is also directly queryable/sortable — see GET
      // /admin/users ?sort=). submittedAt tracks the *account's* own
      // registration submission distinct from the application's
      // (app.submittedAt), which only fires once the referee's file is
      // actually sent for review, not at signup.
      submittedAt: nowIso,
      clarificationRequestedAt: null,
      clarificationSubmittedAt: null,
      reviewedAt: null,
      approvedAt: null,
      rejectedAt: null,
      disabledAt: null,
      lastSeenAt: null,
    };
    data.users.push(newUser);

    const app = {
      id: uuidv4(),
      userId: newUser.id,
      status: "draft",
      season: SEASON,
      data: { ...blankData(), fullNameAr, fullNameLatin, email, phone1: phone },
      documents: {},
      declaration: false,
      flags: {},
      docFlags: {},
      rejectionSummary: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paidAt: null,
      submittedAt: null,
      reviewedAt: null,
      approvedAt: null,
      history: [{ at: new Date().toISOString(), event: "تم إنشاء الحساب وملف الانخراط" }],
    };
    data.applications.push(app);

    const { conversation: publicConv } = ensurePublicConversation(data);
    const nowMember = memberIdsOf(data, publicConv.id).includes(newUser.id);
    const preExistingMemberIds = memberIdsOf(data, publicConv.id).filter((id) => id !== newUser.id);

    await db.saveAll(data);
    if (nowMember) {
      realtime.sendToUsers(preExistingMemberIds, "conversation:member_joined", { conversationId: publicConv.id, userId: newUser.id, fullNameAr: newUser.fullNameAr });
    }

    const token = signToken(newUser);
    res.json({ token, user: publicUser(newUser) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "أدخل اسم المستخدم وكلمة المرور." });
    const data = await db.getAll();
    const user = data.users.find((u) => normUsername(u.username) === normUsername(username) || normEmail(u.email) === normUsername(username));
    if (!user) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });

    // Whole-platform kill switch: the admin account is always exempt (this
    // is how the admin gets back in to re-enable the site); every other
    // account is blocked from logging in while the platform is disabled,
    // even with perfectly correct credentials. Re-checked fresh from the
    // DB on every attempt.
    if (user.role !== "admin" && !isSiteEnabled(getSettings(data))) {
      return res.status(503).json({ error: SITE_DISABLED_MESSAGE, siteDisabled: true });
    }

    // Per-account admin disable (see routes/admin.js POST /users/:id/disable)
    // — independent of the registration-review status above; an already
    // approved/active referee can still be administratively suspended.
    if (user.disabled) {
      return res.status(403).json({ error: "تم تعطيل هذا الحساب من طرف الإدارة. للاستفسار يرجى التواصل مع الرابطة.", accountDisabled: true });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  res.json({ user: publicUser(user) });
});

// ---- Account activation review: full status for the referee's OWN
//      registration (not the enrollment form — that only opens once the
//      account is active) — قيد المراجعة / يحتاج إلى تعديل / مفعّل / مرفوض,
//      with the admin's note/reason and the full review history, so the
//      frontend can render the right screen (waiting / edit-and-resubmit /
//      rejected). Reachable in every account state (a rejected referee must
//      still be able to see WHY, and an active one can check their history if
//      needed) — only the edit/resubmit actions below are status-gated. ----
router.get("/registration-status", requireAuth, requireRole("referee"), async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  res.json({
    accountStatus: getAccountStatus(user),
    accountStatusLabel: ACCOUNT_STATUS_LABELS[getAccountStatus(user)],
    reviewFields: user.reviewFields || [],
    reviewNote: user.reviewNote || null,
    rejectionReason: user.rejectionReason || null,
    registrationHistory: user.registrationHistory || [],
    fields: { fullNameAr: user.fullNameAr, fullNameLatin: user.fullNameLatin, username: user.username, email: user.email, phone: user.phone },
  });
});

// ---- Account activation review: referee corrects the field(s) the admin
//      flagged — only reachable while the account is exactly "يحتاج إلى
//      تعديل" (needs_edit); re-checked fresh from the DB, so this can never
//      be bypassed by calling the API directly while pending_review/
//      rejected/active. Updates the SAME account and (if it exists yet) the
//      SAME draft application — never creates a new account or a new
//      registration record. Every actual change is written to the Audit
//      Log. Does NOT resubmit by itself — see POST /registration/resubmit
//      below, a separate explicit step, exactly as specified. ----
router.put("/registration", requireAuth, requireRole("referee"), async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  if (getAccountStatus(user) !== ACCOUNT_STATUS.NEEDS_EDIT) {
    return res.status(400).json({ error: "لا يمكن تعديل معلومات التسجيل في وضع الحساب الحالي." });
  }
  const { fields } = req.body;
  if (!fields || typeof fields !== "object") {
    return res.status(400).json({ error: "لا توجد بيانات لتعديلها." });
  }

  const fieldDiffs = [];
  const errors = {};
  const next = {}; // validated new values, applied only if everything passes

  if (fields.fullNameAr !== undefined) {
    const v = String(fields.fullNameAr || "").trim();
    if (!isValidForScript("ar", v)) errors.fullNameAr = "الاسم واللقب بالعربية يجب أن يُكتب بأحرف عربية فقط.";
    else next.fullNameAr = v;
  }
  if (fields.fullNameLatin !== undefined) {
    const v = String(fields.fullNameLatin || "").trim();
    if (!isValidForScript("latin", v)) errors.fullNameLatin = "الاسم واللقب باللاتينية يجب أن يُكتب بأحرف لاتينية فقط.";
    else next.fullNameLatin = v;
  }
  if (fields.username !== undefined) {
    const v = String(fields.username || "").trim();
    if (!isValidUsername(v)) errors.username = "اسم المستخدم يجب أن يتكون من أحرف لاتينية وأرقام فقط.";
    else if (usernameTaken(data, v) && normUsername(v) !== normUsername(user.username)) errors.username = "اسم المستخدم مستخدم بالفعل.";
    else next.username = v;
  }
  if (fields.email !== undefined) {
    const v = String(fields.email || "").trim();
    if (!isValidEmail(v)) errors.email = "صيغة البريد الإلكتروني غير صحيحة.";
    else if (emailTaken(data, v) && normEmail(v) !== normEmail(user.email)) errors.email = "البريد الإلكتروني مستخدم بالفعل.";
    else next.email = v;
  }
  if (fields.phone !== undefined) {
    const v = String(fields.phone || "").trim();
    if (!isValidPhone(v)) errors.phone = "رقم الهاتف يجب أن يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام.";
    else {
      const check = checkPhoneUniqueness(data, { phone1: v }, user.id);
      if (!check.ok) errors.phone = check.message;
      else next.phone = v;
    }
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: "تحقق من الحقول المدخلة.", fields: errors });
  if (Object.keys(next).length === 0) return res.status(400).json({ error: "لم يتم تحديد أي حقل صالح للتعديل." });

  Object.entries(next).forEach(([k, v]) => {
    const old = user[k];
    if (String(old ?? "") !== String(v ?? "")) fieldDiffs.push({ field: k, oldValue: old, newValue: v });
    user[k] = v;
  });

  // Mirror onto the draft application too (single source of truth — same
  // reasoning as syncUserFromApplicationData, just the other direction:
  // here the referee edited the account fields directly, before an
  // application even necessarily has meaningful data in it yet).
  const app = data.applications.find((a) => a.userId === user.id);
  if (app) {
    if (next.fullNameAr !== undefined) app.data.fullNameAr = next.fullNameAr;
    if (next.fullNameLatin !== undefined) app.data.fullNameLatin = next.fullNameLatin;
    if (next.email !== undefined) app.data.email = next.email;
    if (next.phone !== undefined) app.data.phone1 = next.phone;
  }

  if (fieldDiffs.length) {
    addAuditEntries(data, user.id, fieldDiffs, {
      changedBy: "referee",
      changedByUserId: user.id,
      changedByName: user.fullNameAr,
      source: "self_edit",
      reason: "تصحيح معلومات التسجيل بناءً على طلب الإدارة",
      accountStatusBefore: ACCOUNT_STATUS.NEEDS_EDIT,
      accountStatusAfter: ACCOUNT_STATUS.NEEDS_EDIT,
    });
  }

  await db.saveAll(data);
  res.json({ user: publicUser(user) });
});

// ---- Account activation review: referee explicitly resubmits after
//      correcting the flagged field(s) — a separate, deliberate step (never
//      automatic on save) so the admin only sees it back in their queue once
//      the referee is actually done. Only reachable from "needs_edit";
//      always returns the SAME account to "قيد المراجعة" (pending_review) —
//      never creates a new account/registration. ----
router.post("/registration/resubmit", requireAuth, requireRole("referee"), async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  if (getAccountStatus(user) !== ACCOUNT_STATUS.NEEDS_EDIT) {
    return res.status(400).json({ error: "لا يمكن إعادة إرسال التسجيل في وضع الحساب الحالي." });
  }
  const previousFields = user.reviewFields || [];
  const previousNote = user.reviewNote || null;
  const nowIso = new Date().toISOString();

  user.accountStatus = ACCOUNT_STATUS.PENDING_REVIEW;
  user.reviewFields = [];
  user.reviewNote = null;
  user.clarificationSubmittedAt = nowIso;
  if (!Array.isArray(user.registrationHistory)) user.registrationHistory = [];
  user.registrationHistory.push({
    at: nowIso,
    event: "أعاد الحكم إرسال التسجيل بعد تصحيح المعلومات المطلوبة",
    by: user.id,
    byRole: "referee",
    fields: previousFields,
    note: previousNote,
  });

  const created = notifyAdmins(data, {
    type: NOTIFICATION_TYPES.REGISTRATION_RESUBMITTED,
    title: "إعادة إرسال تسجيل بعد التعديل",
    body: `صحّح ${user.fullNameAr} معلوماته وأعاد إرسال التسجيل — بانتظار المراجعة من جديد.`,
    link: "#/admin-users",
    meta: { userId: user.id },
  });

  await db.saveAll(data);
  if (created.length) pushRealtime(data, created);
  res.json({ user: publicUser(user) });
});

// ---- Self-service password change (works for both referee and admin accounts) ----
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "أدخل كلمة السر الحالية والجديدة." });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: "كلمة السر الجديدة قصيرة جدًا." });
    }
    const data = await db.getAll();
    const user = data.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: "كلمة السر الحالية غير صحيحة." });
    user.password = await bcrypt.hash(newPassword, 10);
    await db.saveAll(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

// ---- Referee e-signature: drawn on a touch/mouse canvas client-side and
// sent here as a base64 PNG data URL, then stored permanently on the
// referee's account (not the application) via Cloudinary — same storage
// backend the rest of the platform already uses for uploaded documents, so
// this doesn't introduce a second storage system. Retrieved automatically
// on every /auth/me and /login response (see publicUser above), and used
// later when generating the enrollment certificate.
//
// The signature is tied to the referee's التعهد (pledge): once the
// application is submitted with the pledge confirmed (see
// applications.js /mine/submit), `user.signature.locked` is set to true
// and this endpoint refuses to accept a new drawing from then on — this is
// the sole enforcement point (checked fresh from the DB on every request),
// so it can't be bypassed by a stale/hidden frontend button. Only an admin
// (routes/admin.js POST /users/:id/unlock-signature) can lift the lock. ----
const SIGNATURE_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
router.post("/signature", requireAuth, requireRole("referee"), async (req, res) => {
  try {
    const { dataUrl } = req.body;
    const m = SIGNATURE_DATA_URL_RE.exec(String(dataUrl || ""));
    if (!m) {
      return res.status(400).json({ error: "صيغة الإمضاء غير صالحة." });
    }
    const buffer = Buffer.from(m[1], "base64");
    // A blank canvas still produces a small (but non-trivial) PNG — this
    // rejects anything implausibly tiny to be an actual drawn signature,
    // so an accidental empty save never overwrites a real one.
    if (buffer.length < 300) {
      return res.status(400).json({ error: "لا يمكن حفظ إمضاء فارغ. يرجى رسم الإمضاء أولاً." });
    }
    if (!cloudinaryLib.isConfigured()) {
      return res.status(500).json({
        error: "لم يتم إعداد تخزين الملفات (Cloudinary). أضف متغيرات البيئة CLOUDINARY_CLOUD_NAME وCLOUDINARY_API_KEY وCLOUDINARY_API_SECRET.",
      });
    }
    const data = await db.getAll();
    const user = data.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    // Hard server-side lock: rejects the request outright regardless of
    // what the frontend sent or hid. This is checked against the DB value,
    // never trusted from the client.
    if (user.signature && user.signature.locked) {
      return res.status(409).json({
        error: "التوقيع نهائي ومرتبط بالتعهد الموقّع، ولا يمكن تعديله. لأي تصحيح استثنائي يرجى التواصل مع إدارة الرابطة.",
        signatureLocked: true,
      });
    }

    let uploadResult;
    try {
      uploadResult = await cloudinaryLib.uploadBuffer(buffer, {
        folder: "lwf-referees/signatures",
        public_id: `signature_${user.id}_${uuidv4().slice(0, 8)}`,
        resource_type: "image",
      });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "تعذّر رفع الإمضاء إلى خدمة التخزين. حاول مرة أخرى." });
    }

    const old = user.signature;
    user.signature = {
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      updatedAt: new Date().toISOString(),
      locked: false,
    };
    await db.saveAll(data);
    if (old && old.publicId) await cloudinaryLib.destroyAsset(old.publicId, "image");

    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

module.exports = router;
