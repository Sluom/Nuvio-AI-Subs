const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB = String(process.env.MONGODB_DB || 'nuvio_ai_subs').trim();
const CACHE_VERSION = String(process.env.CACHE_VERSION || 'v1').trim();
const TTL_DAYS = Math.max(1, parseInt(process.env.MONGODB_TTL_DAYS || '45', 10) || 45);
const RETRY_AFTER_MS = 30000;

let database = null;
let connecting = null;
let retryAt = 0;

const docId = (ns, key) => crypto.createHash('sha1').update(`${CACHE_VERSION}|${ns}|${key}`).digest('hex');

async function getDb() {
  if (!MONGODB_URI) return null;
  if (database) return database;
  if (Date.now() < retryAt) return null;

  if (!connecting) {
    connecting = (async () => {
      try {
        const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
        await client.connect();
        const d = client.db(MONGODB_DB);
        const ttlSeconds = TTL_DAYS * 24 * 60 * 60;
        for (const name of ['docs', 'maps']) {
          try {
            await d.collection(name).createIndex({ updatedAt: 1 }, { expireAfterSeconds: ttlSeconds });
          } catch (e) {
            console.log(`[MongoDB] تعذر إنشاء فهرس الانتهاء لمجموعة ${name}: ${e.message}`);
          }
        }
        database = d;
        console.log(`[MongoDB] متصل بقاعدة (${MONGODB_DB}) | مدة الاحتفاظ ${TTL_DAYS} يوم | نسخة الكاش ${CACHE_VERSION}`);
        return d;
      } catch (e) {
        retryAt = Date.now() + RETRY_AFTER_MS;
        console.log(`[MongoDB] فشل الاتصال: ${e.message}. إعادة المحاولة بعد ${Math.round(RETRY_AFTER_MS / 1000)}s.`);
        return null;
      } finally {
        connecting = null;
      }
    })();
  }
  return connecting;
}

async function init() {
  if (!MONGODB_URI) {
    console.log('[MongoDB] المتغير MONGODB_URI غير موجود. الكاش الدائم معطل، والعمل بالذاكرة فقط.');
    return false;
  }
  const d = await getDb();
  return !!d;
}

async function loadDoc(ns, key) {
  const d = await getDb();
  if (!d) return null;
  try {
    const doc = await d.collection('docs').findOne({ _id: docId(ns, key) });
    return doc ? doc.value : null;
  } catch (e) {
    console.log(`[MongoDB] فشلت القراءة (${ns}): ${e.message}`);
    return null;
  }
}

async function saveDoc(ns, key, value) {
  const d = await getDb();
  if (!d) return false;
  try {
    await d.collection('docs').updateOne(
      { _id: docId(ns, key) },
      { $set: { ns, value, updatedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (e) {
    console.log(`[MongoDB] فشل الحفظ (${ns}): ${e.message}`);
    return false;
  }
}

async function loadMap(ns, key) {
  const out = new Map();
  const d = await getDb();
  if (!d) return out;
  try {
    const doc = await d.collection('maps').findOne({ _id: docId(ns, key) });
    if (doc && doc.data) {
      for (const [k, v] of Object.entries(doc.data)) {
        const id = Number(k);
        if (Number.isInteger(id) && v != null) out.set(id, v);
      }
    }
  } catch (e) {
    console.log(`[MongoDB] فشلت قراءة الخريطة (${ns}): ${e.message}`);
  }
  return out;
}

async function saveMap(ns, key, entries) {
  if (!entries || entries.length === 0) return false;
  const d = await getDb();
  if (!d) return false;
  const set = { ns, updatedAt: new Date() };
  for (const [id, value] of entries) set[`data.${id}`] = value;
  try {
    await d.collection('maps').updateOne({ _id: docId(ns, key) }, { $set: set }, { upsert: true });
    return true;
  } catch (e) {
    console.log(`[MongoDB] فشل حفظ الخريطة (${ns}): ${e.message}`);
    return false;
  }
}

module.exports = { init, loadDoc, saveDoc, loadMap, saveMap };
