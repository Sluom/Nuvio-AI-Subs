const db = require('./db');

const PREF_NS = 'pref';
const NAME_SIM_MIN = 0.8;
const NAME_MIN_TOKENS = 2;
const MAX_MEM = 300;

const memCache = new Map();

function seriesKeyOf(targetId) {
  const parts = String(targetId || '').split(':');
  if (parts.length < 3) return null;
  if (/^tt\d+$/.test(parts[0])) return parts[0];
  if (parts[0] === 'kitsu' && parts[1]) return 'kitsu:' + parts[1];
  return null;
}

function urlKey(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try { return new URL(s).pathname.toLowerCase(); } catch (e) { return s.split('?')[0].toLowerCase(); }
}

function nameOf(item) {
  const raw = item && (item.name || item.fileName || item.title || item.origName);
  return String(raw || '').trim().slice(0, 200);
}

function nameTokens(name) {
  const base = String(name || '').toLowerCase()
    .replace(/\.(srt|ass|ssa|sub|zip|gz|rar|7z)$/g, '')
    .replace(/\[[0-9a-f]{8}\]/g, ' ')
    .replace(/\bs0*\d+[._\s-]*e0*\d+(?:[._\s-]*e?0*\d+)?\b/g, ' ')
    .replace(/\b\d+x0*\d+\b/g, ' ')
    .replace(/\b(?:season|s)[._\s-]*0*\d+\b/g, ' ')
    .replace(/\b(?:episode|ep|e)[._\s-]*0*\d+(?:v\d+)?\b/g, ' ')
    .replace(/(?<![\p{L}\p{N}])0*\d{1,4}(?:v\d+)?(?![\p{L}\p{N}])/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return base ? new Set(base.split(' ').filter(Boolean)) : new Set();
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function siteOf(item) {
  return String((item && (item._site || item._source)) || '').toLowerCase();
}

// يدور في القائمة على العنصر المفضل: الرابط نفسه أولا (نفس حزمة الموسم)، ثم نفس الموقع ونمط الاسم المشابه (موسم جديد).
function findPreferred(pool, pref) {
  if (!pref || !Array.isArray(pool) || !pool.length) return null;
  const wantUrl = urlKey(pref.url);
  if (wantUrl) {
    for (const it of pool) {
      if (it && it.url && urlKey(it.url) === wantUrl) return { item: it, how: 'url' };
    }
  }
  const wantTokens = nameTokens(pref.name);
  if (wantTokens.size < NAME_MIN_TOKENS) return null;
  const wantSite = String(pref.site || '').toLowerCase();
  let best = null;
  let bestSim = 0;
  for (const it of pool) {
    if (!it || !it.url) continue;
    if (wantSite && siteOf(it) !== wantSite) continue;
    const tokens = nameTokens(nameOf(it));
    if (tokens.size < NAME_MIN_TOKENS) continue;
    const sim = similarity(wantTokens, tokens);
    if (sim >= NAME_SIM_MIN && sim > bestSim) {
      best = it;
      bestSim = sim;
    }
  }
  return best ? { item: best, how: 'name' } : null;
}

// يضع العنصر في مكان التراك المفضل داخل قائمة التثبيت (أقصى 4)، ويزيل نسخته إن كانت موجودة قبلا.
function placeAtSlot(list, entry, slot, maxLen = 4) {
  const out = Array.isArray(list) ? list.filter(x => x && urlKey(x.url) !== urlKey(entry.url)) : [];
  const idx = Math.max(0, Math.min((parseInt(slot, 10) || 1) - 1, out.length));
  out.splice(idx, 0, entry);
  if (out.length > maxLen) out.length = maxLen;
  return out;
}

function makePinEntry(item) {
  return {
    url: item.url,
    _source: item._source || item._site || 'subdl',
    _site: item._site || item._source || 'subdl',
    name: nameOf(item)
  };
}

async function loadPref(targetId) {
  const key = seriesKeyOf(targetId);
  if (!key) return null;
  if (memCache.has(key)) return memCache.get(key);
  let value = null;
  try { value = await db.loadDoc(PREF_NS, key); } catch (e) { value = null; }
  if (memCache.size >= MAX_MEM) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, value || null);
  return value || null;
}

async function savePref(targetId, kind, slot, entry) {
  const key = seriesKeyOf(targetId);
  if (!key || (kind !== 'srt' && kind !== 'ass') || !entry || !entry.url) return null;
  const s = parseInt(slot, 10);
  if (!(s >= 1 && s <= 4)) return null;
  const cur = (await loadPref(targetId)) || {};
  const next = { ...cur };
  const same = !!(cur[kind] && cur[kind].slot === s && urlKey(cur[kind].url) === urlKey(entry.url));
  const keptName = (cur[kind] && urlKey(cur[kind].url) === urlKey(entry.url)) ? (cur[kind].name || '') : '';
  next[kind] = { slot: s, url: entry.url, site: String(entry._site || entry._source || ''), name: nameOf(entry) || keptName };
  memCache.set(key, next);
  await db.saveDoc(PREF_NS, key, next);
  return { key, changed: !same, pref: next[kind] };
}

module.exports = {
  seriesKeyOf,
  urlKey,
  nameOf,
  nameTokens,
  similarity,
  findPreferred,
  placeAtSlot,
  makePinEntry,
  loadPref,
  savePref
};
