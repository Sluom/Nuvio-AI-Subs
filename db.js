const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// جلب روابط القاعدتين
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGO_URI_TRACKS = String(process.env.MONGO_URI_TRACKS || '').trim();

const MONGODB_DB = 'nuvio_ai_subs';
const TRACKS_DB = 'nuvio_tracks'; // اسم القاعدة الثانوية

const CACHE_VERSION = 'v1';
const TTL_DAYS = 120; // مدة احتفاظ القاعدة الأساسية
const TRACKS_TTL_DAYS = 90; // مدة احتفاظ قاعدة التراكات الجديدة
const RAW_NS = 'rawsrt';
const DAY_SECONDS = 24 * 60 * 60;
const RETRY_AFTER_MS = 30000;

// فصل حالات الاتصال للقاعدتين لضمان عدم التداخل
let primaryDb = null;
let tracksDb = null;
let connectingPrimary = null;
let connectingTracks = null;
let retryAtPrimary = 0;
let retryAtTracks = 0;

const docId = (ns, key) => crypto.createHash('sha1').update(`${CACHE_VERSION}|${ns}|${key}`).digest('hex');

// دالة إنشاء أو تحديث الفهرس (نفسها بدون تغيير)
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
      console.log(`[MongoDB] تعذر ضبط فهرس الانتهاء ${indexName} لمجموعة ${collName}: ${e2.message}.`);
      return false;
    }
  }
}

// الاتصال بالقاعدة الأساسية (القديمة)
async function getPrimaryDb() {
  if (!MONGODB_URI) return null;
  if (primaryDb) return primaryDb;
  if (Date.now() < retryAtPrimary) return null;

  if (!connectingPrimary) {
    connectingPrimary = (async () => {
      try {
        const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
        await client.connect();
        const d = client.db(MONGODB_DB);
        const ttlSeconds = TTL_DAYS * DAY_SECONDS;
        await ensureTtlIndex(d, 'docs', 'updatedAt_1', ttlSeconds);
        await ensureTtlIndex(d, 'maps', 'updatedAt_1', ttlSeconds);
        primaryDb = d;
        console.log(`[MongoDB] متصل بالقاعدة الأساسية (${MONGODB_DB}) | مدة الاحتفاظ ${TTL_DAYS} يوم | الكاش ${CACHE_VERSION}`);
        return d;
      } catch (e) {
        retryAtPrimary = Date.now() + RETRY_AFTER_MS;
        console.log(`[MongoDB] فشل الاتصال بالأساسية: ${e.message}. إعادة المحاولة لاحقاً.`);
        return null;
      } finally {
        connectingPrimary = null;
      }
    })();
  }
  return connectingPrimary;
}

// الاتصال بقاعدة التراكات (الجديدة)
async function getTracksDb() {
  if (!MONGO_URI_TRACKS) return null;
  if (tracksDb) return tracksDb;
  if (Date.now() < retryAtTracks) return null;

  if (!connectingTracks) {
    connectingTracks = (async () => {
      try {
        const client = new MongoClient(MONGO_URI_TRACKS, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
        await client.connect();
        const d = client.db(TRACKS_DB);
        const ttlSeconds = TRACKS_TTL_DAYS * DAY_SECONDS;
        // إنشاء فهرس 90 يوم للتراكات الجديدة
        await ensureTtlIndex(d, 'docs', 'updatedAt_1', ttlSeconds);
        tracksDb = d;
        console.log(`[MongoDB] متصل بقاعدة التراكات (${TRACKS_DB}) | مدة الاحتفاظ ${TRACKS_TTL_DAYS} يوم.`);
        return d;
      } catch (e) {
        retryAtTracks = Date.now() + RETRY_AFTER_MS;
        console.log(`[MongoDB] فشل الاتصال بقاعدة التراكات: ${e.message}. إعادة المحاولة لاحقاً.`);
        return null;
      } finally {
        connectingTracks = null;
      }
    })();
  }
  return connectingTracks;
}

// دالة توجيه الطلبات: تحدد وين يروح الحفظ/القراءة بناءً على نوع البيانات
function getTargetDb(ns) {
  return (ns === RAW_NS) ? getTracksDb() : getPrimaryDb();
}

async function init() {
  if (!MONGODB_URI) console.log('[MongoDB] MONGODB_URI غير موجود للأساسية.');
  if (!MONGO_URI_TRACKS) console.log('[MongoDB] MONGO_URI_TRACKS غير موجود للتراكات.');
  
  // تشغيل الاتصالين بالتوازي
  const [p, t] = await Promise.all([getPrimaryDb(), getTracksDb()]);
  return !!(p || t);
}

// ---------------- عمليات القراءة والحفظ ---------------- //

async function loadDoc(ns, key) {
  const d = await getTargetDb(ns);
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
  const d = await getTargetDb(ns);
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
  const d = await getPrimaryDb(); // الخرائط دائماً بالأساسية
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
  const d = await getPrimaryDb(); // الخرائط دائماً بالأساسية
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
