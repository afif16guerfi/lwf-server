// db.js — MongoDB Atlas-backed persistence layer (referee-platform side).
//
// The entire platform state (users, applications, requests, ...) is kept as
// ONE document in a single MongoDB collection. This keeps every route in the
// project completely unchanged (they all call db.getAll() / db.saveAll()),
// while giving the platform real, permanent, cross-device persistence.
//
// IMPORTANT — this collection is SHARED with the separately-deployed
// "lwf-finance-system" project (same DB_NAME/COLLECTION_NAME/DOC_ID below).
// The finance system used to be mounted inside this same server; it has
// been split out into its own project/deployment, but both still read and
// write the same underlying document so that existing admin/finance user
// accounts, login, and financial data keep working without any migration.
// This file therefore only declares/backfills the fields the referee
// platform itself uses (users, applications, requests, chat, announcements,
// notifications, referee lists, settings, document requirements, audit
// log). It never reads, deletes, or overwrites the finance* fields
// (financeTransactions, financeCategories, financeYears, financeAuditLog,
// financeSettings) — whatever is already in the document for those simply
// passes through untouched on every getAll()/saveAll() round-trip, so this
// split never risks losing finance data. All finance-specific schema and
// migrations now live exclusively in the finance-system project's own
// db.js.
//
// Note: MongoDB documents have a 16MB size limit. For a single wilaya
// referee registry (hundreds of files per season, text-only — uploaded
// files themselves live on Cloudinary, not here) this is enormous headroom.
// If the platform ever grows to serve many wilayas / tens of thousands of
// referees, migrate to one document per user/application instead.

const { MongoClient } = require("mongodb");
const { MONGODB_URI } = require("./config");

const DB_NAME = "lwf_referees";
const COLLECTION_NAME = "platform_state";
const DOC_ID = "singleton";

let client = null;
let collectionPromise = null;

const { DEFAULT_SETTINGS } = require("./settingsCore");
const { seedDocumentRequirements } = require("./documentRequirementsCore");
const { syncUserFromApplicationData } = require("./schema");
const { addAuditEntries } = require("./auditCore");

function defaultData() {
  return {
    users: [], applications: [], requests: [], conversations: [], conversationMembers: [], messages: [], announcements: [],
    notifications: [],
    refereeLists: [],
    settings: { ...DEFAULT_SETTINGS },
    documentRequirements: seedDocumentRequirements(),
    auditLog: [],
    // Finance fields are intentionally NOT declared here — see the note at
    // the top of this file. If this app ever creates the document first (a
    // brand-new, empty database), the finance-system project will backfill
    // its own fields the first time it connects.
  };
}

async function connect() {
  if (collectionPromise) return collectionPromise;

  if (!MONGODB_URI) {
    throw new Error(
      "متغير البيئة MONGODB_URI غير معرَّف. أضف رابط الاتصال بقاعدة بيانات MongoDB Atlas في ملف .env (محليًا) أو في إعدادات متغيرات البيئة على منصة الاستضافة."
    );
  }

  collectionPromise = (async () => {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const database = client.db(DB_NAME);
    const collection = database.collection(COLLECTION_NAME);

    const existing = await collection.findOne({ _id: DOC_ID });
    if (!existing) {
      await collection.insertOne({ _id: DOC_ID, ...defaultData() });
    }
    return collection;
  })();

  return collectionPromise;
}

async function getAll() {
  const collection = await connect();
  const doc = await collection.findOne({ _id: DOC_ID });
  const data = doc || defaultData();

  // Backfill keys that may be missing from an older version of the platform,
  // so upgrades never crash on startup. (Finance fields are deliberately
  // left alone here — see the note at the top of this file.)
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.applications)) data.applications = [];
  if (!Array.isArray(data.requests)) data.requests = [];
  if (!Array.isArray(data.conversations)) data.conversations = [];
  if (!Array.isArray(data.conversationMembers)) data.conversationMembers = [];
  if (!Array.isArray(data.messages)) data.messages = [];
  if (!Array.isArray(data.announcements)) data.announcements = [];
  if (!Array.isArray(data.notifications)) data.notifications = [];
  if (!Array.isArray(data.refereeLists)) data.refereeLists = [];
  if (!data.settings || typeof data.settings !== "object") data.settings = { ...DEFAULT_SETTINGS };
  if (!Array.isArray(data.documentRequirements)) data.documentRequirements = seedDocumentRequirements();
  if (!Array.isArray(data.auditLog)) data.auditLog = [];

  // Migration: the identity name used to be one field (`fullName`); it's
  // now two, `fullNameAr` + `fullNameLatin` (see schema.js). Accounts and
  // applications created before this change only have the old field —
  // best-effort carry its value into fullNameAr (it was typed in Arabic in
  // practice, since the whole platform is Arabic-first) and leave
  // fullNameLatin blank rather than guessing at a transliteration; an admin
  // can ask the referee to fill it in via a future profile-edit feature, or
  // set it directly. This never overwrites a value that's already there.
  data.users.forEach((u) => {
    if (!u.fullNameAr && u.fullName) u.fullNameAr = u.fullName;
    if (u.fullNameLatin === undefined) u.fullNameLatin = u.fullNameLatin || "";
    // Migration: account activation review — every referee account now
    // carries these fields (see schema.js ACCOUNT_STATUS). Older accounts
    // predate this system, so backfill blank/neutral defaults without
    // touching accountStatus itself (getAccountStatus() already treats a
    // missing/unrecognized value as "active" — this only adds the bookkeeping
    // fields alongside it, it never changes anyone's actual status).
    if (!Array.isArray(u.reviewFields)) u.reviewFields = [];
    if (u.reviewNote === undefined) u.reviewNote = null;
    if (u.rejectionReason === undefined) u.rejectionReason = null;
    if (!Array.isArray(u.registrationHistory)) {
      u.registrationHistory = [{ at: u.createdAt || new Date().toISOString(), event: "تم إنشاء الحساب وإرسال التسجيل", by: null, byRole: null }];
    }
  });
  data.applications.forEach((a) => {
    if (a.data) {
      if (!a.data.fullNameAr && a.data.fullName) a.data.fullNameAr = a.data.fullName;
      if (a.data.fullNameLatin === undefined) a.data.fullNameLatin = a.data.fullNameLatin || "";
    }
  });

  // Migration: announcement `readBy` used to be a plain array of userIds
  // (whether the referee opened the announcement, no timestamp). It's now
  // an array of { userId, readAt } so the admin's read-tracking table can
  // show *when* each referee read it (see ninth requirement in the
  // request/notification/announcement upgrade). Old string entries are
  // carried over with readAt left null rather than guessed at.
  data.announcements.forEach((a) => {
    if (Array.isArray(a.readBy) && a.readBy.length && typeof a.readBy[0] === "string") {
      a.readBy = a.readBy.map((userId) => ({ userId, readAt: null }));
    } else if (!Array.isArray(a.readBy)) {
      a.readBy = [];
    }
  });

  // Migration: referee requests predate the قيد المراجعة/يحتاج إلى
  // توضيح/مقبول/مرفوض status + timeline system — backfill `history` and
  // `previousVersions` so older requests don't crash the new UI/routes.
  (data.requests || []).forEach((r) => {
    if (!Array.isArray(r.history)) r.history = [];
    if (!Array.isArray(r.previousVersions)) r.previousVersions = [];
  });

  // Self-healing repair: single source of truth for referee identity data.
  // application.data (the enrollment form) is the field the referee/admin
  // actually edit; the account record (`user`) only ever keeps a MIRROR of
  // fullNameAr/fullNameLatin/email/phone1→phone for the places that need it
  // without loading the application (chat, notifications, the admin account
  // list — see schema.js IDENTITY_MIRROR). Older code only ever synced
  // phone1, so any account whose name/email was edited before this fix will
  // have a stale mirror. This repairs that drift automatically, the first
  // time each affected record is loaded — it changes nothing in the
  // browser/API surface, and every actual correction is written to the
  // Audit Log (source: "system_sync") so an admin can see exactly which
  // records were affected and when. This block runs on every getAll() call
  // but is a no-op (just comparisons, no writes) once every record is in
  // sync, which is true after the very first save that follows.
  let repaired = false;
  data.applications.forEach((app) => {
    if (!app.data || !app.userId) return;
    const owner = data.users.find((u) => u.id === app.userId);
    if (!owner) return;
    const diffs = syncUserFromApplicationData(owner, app.data);
    if (diffs.length) {
      repaired = true;
      addAuditEntries(data, app.userId, diffs, {
        changedBy: "admin",
        changedByUserId: null,
        changedByName: "تصحيح تلقائي عند الترقية",
        source: "system_sync",
        reason: "إصلاح تلقائي لبيانات كانت غير متزامنة بين ملف الحكم وحسابه (قبل توحيد مصدر البيانات).",
        accountStatusBefore: null,
        accountStatusAfter: null,
      });
    }
  });
  if (repaired) {
    // Persist the repair immediately rather than waiting for some unrelated
    // route to save next — an admin opening a read-only list page (e.g.
    // "كل الحسابات المسجَّلة") should see corrected data right away, and the
    // audit entries above must not be silently lost if the process restarts
    // before anything else triggers a save.
    try {
      const collection = await connect();
      await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
    } catch (e) {
      console.error("تعذر حفظ الإصلاح التلقائي لتزامن بيانات الحكام:", e);
    }
  }

  return data;
}

// Writes the FULL document back, including any fields this file doesn't
// know about (in particular the finance-system project's financeTransactions
// / financeCategories / financeYears / financeAuditLog / financeSettings
// fields, which were already present on `data` as fetched by getAll() above
// and were never touched) — so saving referee-platform data can never wipe
// out finance data, even though this project no longer contains any
// finance code.
async function saveAll(data) {
  const collection = await connect();
  await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
  return data;
}

// ---- Chat: atomic operations on the messages array ----
//
// Messages are written far more often than any other data in this platform
// (every chat message, edit, delete). Going through getAll()/saveAll() would
// read-modify-write the ENTIRE document on every message, which both wastes
// bandwidth and risks silently dropping a concurrent message (two users
// sending at the same instant would race on the same full-document replace).
// These helpers instead issue targeted MongoDB array operators so concurrent
// chat activity is safe.

async function pushMessage(message) {
  const collection = await connect();
  await collection.updateOne({ _id: DOC_ID }, { $push: { messages: message } });
  return message;
}

async function updateMessageById(id, patch) {
  const collection = await connect();
  const setObj = {};
  Object.entries(patch).forEach(([k, v]) => { setObj[`messages.$.${k}`] = v; });
  const result = await collection.updateOne({ _id: DOC_ID, "messages.id": id }, { $set: setObj });
  return result.matchedCount > 0;
}

async function deleteMessagesByConversation(conversationId) {
  const collection = await connect();
  await collection.updateOne({ _id: DOC_ID }, { $pull: { messages: { conversationId } } });
}

async function touchConversation(conversationId, iso) {
  const collection = await connect();
  await collection.updateOne(
    { _id: DOC_ID, "conversations.id": conversationId },
    { $set: { "conversations.$.updatedAt": iso, "conversations.$.lastMessageAt": iso } }
  );
}

// ---- Presence: last-seen persistence ----
// Same targeted-update reasoning as updateMessageById above — this fires on
// every disconnect (closing a tab, losing signal, logging out), so it must
// not read-modify-write the whole platform document each time.
async function updateUserById(id, patch) {
  const collection = await connect();
  const setObj = {};
  Object.entries(patch).forEach(([k, v]) => { setObj[`users.$.${k}`] = v; });
  const result = await collection.updateOne({ _id: DOC_ID, "users.id": id }, { $set: setObj });
  return result.matchedCount > 0;
}

module.exports = {
  connect, getAll, saveAll,
  pushMessage, updateMessageById, deleteMessagesByConversation, touchConversation, updateUserById,
};
