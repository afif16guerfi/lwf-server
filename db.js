// db.js — MongoDB Atlas-backed persistence layer.
//
// The entire platform state (users, applications, requests) is kept as ONE
// document in a single MongoDB collection. This keeps every route in the
// project completely unchanged (they all call db.getAll() / db.saveAll()),
// while giving the platform real, permanent, cross-device persistence.
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

function defaultData() {
  return {
    users: [], applications: [], requests: [], conversations: [], conversationMembers: [], messages: [], announcements: [],
    settings: { ...DEFAULT_SETTINGS },
    documentRequirements: seedDocumentRequirements(),
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
  // so upgrades never crash on startup.
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.applications)) data.applications = [];
  if (!Array.isArray(data.requests)) data.requests = [];
  if (!Array.isArray(data.conversations)) data.conversations = [];
  if (!Array.isArray(data.conversationMembers)) data.conversationMembers = [];
  if (!Array.isArray(data.messages)) data.messages = [];
  if (!Array.isArray(data.announcements)) data.announcements = [];
  if (!data.settings || typeof data.settings !== "object") data.settings = { ...DEFAULT_SETTINGS };
  if (!Array.isArray(data.documentRequirements)) data.documentRequirements = seedDocumentRequirements();
  return data;
}

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
