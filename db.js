// db.js (نسخة الذاكرة اللحظية RAM - بدون MongoDB)
const docStore = new Map();
const mapStore = new Map();
const MAX_CACHE_ITEMS = 50;

async function init() {
  console.log('[DB - RAM Mode] تم تفعيل الذاكرة المؤقتة السريعة وإيقاف MongoDB.');
  return true;
}

async function loadDoc(ns, key) {
  // نرجع null للكاش النهائي حتى يجبر الكود يطبق الدرع العائلي بكل تجربة
  return null;
}

async function saveDoc(ns, key, value) {
  const fullKey = `${ns}:${key}`;
  if (docStore.size >= MAX_CACHE_ITEMS) {
    const firstKey = docStore.keys().next().value;
    docStore.delete(firstKey);
  }
  docStore.set(fullKey, value);
  return true;
}

async function loadMap(ns, key) {
  const fullKey = `${ns}:${key}`;
  const existing = mapStore.get(fullKey);
  return existing ? new Map(existing) : new Map();
}

async function saveMap(ns, key, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  const fullKey = `${ns}:${key}`;
  let current = mapStore.get(fullKey);
  if (!current) {
    if (mapStore.size >= MAX_CACHE_ITEMS) {
      const firstKey = mapStore.keys().next().value;
      mapStore.delete(firstKey);
    }
    current = new Map();
    mapStore.set(fullKey, current);
  }
  for (const [k, v] of entries) {
    current.set(k, v);
  }
  return true;
}

module.exports = { init, loadDoc, saveDoc, loadMap, saveMap };
