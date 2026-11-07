const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB = 'nuvio_ai_subs';
const CACHE_VERSION = 'v1';
// مدة الاحتفاظ العامة (الترجمات المصححة، الأسماء، كاش الأسطر، الجنس...): 120 يوم
const TTL_DAYS = 120;
// مدة احتفاظ التراكات الخام (rawsrt) فقط: 10 أيام
const RAW_NS = 'rawsrt';
const RAW_TTL_DAYS = 10;
const DAY_SECONDS = 24 * 60 * 60;
const RETRY_AFTER_MS = 30000;

let database = null;
let connecting = null;
let retryAt = 0;

const docId = (ns, key) => crypto.createHash('sha1').update(`${CACHE_VERSION}|${ns}|${key}`).digest('hex');

// ينشئ فهرس انتهاء على updatedAt. إن كان موجودا بمدة مختلفة (مثلا 45 يوم القديمة)
// يعدّل مدته في مكانه بـ collMod. وإن فشل يكتب سببا واضحا في السجل ويكمل العمل.
async function ensureTtlIndex(d, collName, indexName, seconds, partialFilter) {
  const options = { name: indexName, expireAfterSeconds: seconds };
  if (partialFilter) options.partialFilterExpression = partialFilter;
  try {
    await d.collection(collName).createIndex({ updatedAt: 1 }, options);
    return true;
  } catch (e) {
    const conflict = e && (e.code === 85 || e.code === 86 || e.codeName === 'IndexOptionsConflict' || e.codeName === 'IndexKeySpecsConflict');
    if (!conflict) {
      console.log(`[MongoDB] تعذر إنشاء فهرس الانتهاء ${indexName} لمجموعة ${collName}: ${e.message}`);
      return false;
    }
    try {
      await d.command({ collMod: collName, index: { name: indexName, expireAfterSeconds: seconds } });
      console.log(`[MongoDB] تم تحديث مدة فهرس ${indexName} في ${collName} إلى ${Math.round(seconds / DAY_SECONDS)} يوم.`);
      return true;
    } catch (e2) {
      console.log(`[MongoDB] تعذر ضبط فهرس الانتهاء ${indexName} لمجموعة ${collName}: ${e2.message}. إن كان الفهرس القديم ما زال بمدته السابقة فاحذفه من تبويب Indexes في Atlas ثم أعد تشغيل البوت.`);
      return false;
    }
  }
}

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
        const ttlSeconds = TTL_DAYS * DAY_SECONDS;
        const rawTtlSeconds = RAW_TTL_DAYS * DAY_SECONDS;
        await ensureTtlIndex(d, 'docs', 'updatedAt_1', ttlSeconds);
        await ensureTtlIndex(d, 'maps', 'updatedAt_1', ttlSeconds);
        await ensureTtlIndex(d, 'docs', 'updatedAt_rawsrt_ttl', rawTtlSeconds, { ns: RAW_NS });
        database = d;
        console.log(`[MongoDB] متصل بقاعدة (${MONGODB_DB}) | مدة الاحتفاظ ${TTL_DAYS} يوم (التراكات الخام ${RAW_TTL_DAYS} أيام) | نسخة الكاش ${CACHE_VERSION}`);
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
