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

function defaultData() {
  return { users: [], applications: [], requests: [] };
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
  return data;
}

async function saveAll(data) {
  const collection = await connect();
  await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
  return data;
}

module.exports = { connect, getAll, saveAll };
