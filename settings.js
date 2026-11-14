'use strict';

const NS = 'cfg';
const KEY = 'settings';
// docs عليها انتهاء 120 يوم (TTL) ⟵ نجدد وقت الحفظ كل 7 أيام حتى ما تنمسح الإعدادات بصمت
const TOUCH_MS = 7 * 24 * 60 * 60 * 1000;

const ASS_SLOT_CHOICES = ['subdl', 'subsource', 'wyzie', 'org', 'any'];
const SRT_SLOT_CHOICES = ['subdl', 'subsource', 'os', 'com', 'org', 'wyzie', 'any'];
const ASS_SLOT_ALIASES = { subs: 'subsource', wyz: 'wyzie', wiz: 'wyzie', legacy: 'org', os_legacy: 'org', oscom: 'com', mirror: 'os', opensubtitles: 'os', '*': 'any' };
const ASS_SLOTS_MAX = 4;

const trimEnv = v => String(v == null ? '' : v).trim();

const DEFS = {
  ass_slots: { env: 'ASS_SLOTS', fromEnv: trimEnv, def: '' },
  srt_slots: { env: 'SRT_SLOTS', fromEnv: trimEnv, def: '' },
  search_model: { env: 'SEARCH_GEMINI_MODEL', fromEnv: trimEnv, def: '' },
  search_grounding: { env: 'SEARCH_GROUNDING', fromEnv: v => /^(1|true|yes|on)$/i.test(trimEnv(v)), def: false },
  filler_skip: { env: 'FILLER_SKIP', fromEnv: v => v !== '0', def: true },
  show_ai_always: { env: 'SHOW_AI_ALWAYS', fromEnv: v => v === '1', def: false }
};

let overrides = {};
let loaded = false;
let touchTimer = null;
const listeners = [];

function normalizeSlots(raw, choices = ASS_SLOT_CHOICES) {
  const toks = String(raw == null ? '' : raw).split(/[\s,;|]+/).filter(Boolean);
  if (!toks.length) return { ok: true, value: '' };
  const out = [];
  const bad = [];
  for (const t0 of toks.slice(0, ASS_SLOTS_MAX)) {
    const t = String(t0).toLowerCase();
    const name = ASS_SLOT_ALIASES[t] || t;
    if (choices.includes(name)) out.push(name); else bad.push(t0);
  }
  if (bad.length) return { ok: false, bad };
  return { ok: true, value: out.every(x => x === 'any') ? '' : out.join(',') };
}

function validate(key, value) {
  const d = DEFS[key];
  if (!d) return { ok: false };
  if (key === 'ass_slots') return normalizeSlots(value);
  if (key === 'srt_slots') return normalizeSlots(value, SRT_SLOT_CHOICES);
  if (key === 'search_model') {
    const v = trimEnv(value);
    return /^[A-Za-z0-9._\-\/]{0,80}$/.test(v) ? { ok: true, value: v } : { ok: false };
  }
  return { ok: true, value: !!value };
}

function envRaw(key) {
  const d = DEFS[key];
  return d ? process.env[d.env] : undefined;
}

function get(key) {
  const d = DEFS[key];
  if (!d) return undefined;
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const raw = envRaw(key);
  if (raw === undefined) return d.def;
  return d.fromEnv(raw);
}

// من أين جاءت القيمة الحالية: tg | env | def
function source(key) {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return 'tg';
  const raw = envRaw(key);
  return raw !== undefined && trimEnv(raw) !== '' ? 'env' : 'def';
}

function getDb() {
  try { return require('./db'); } catch (e) { return null; }
}

async function persist() {
  const db = getDb();
  if (!db) return false;
  try { return !!(await db.saveDoc(NS, KEY, overrides)); } catch (e) { return false; }
}

function emit(key, value) {
  for (const fn of listeners) { try { fn(key, value); } catch (e) {} }
}

async function set(key, value) {
  const v = validate(key, value);
  if (!v.ok) return { ok: false, bad: v.bad || [] };
  overrides[key] = v.value;
  const saved = await persist();
  emit(key, v.value);
  return { ok: true, value: v.value, saved };
}

async function clear(key) {
  if (!DEFS[key]) return { ok: false };
  delete overrides[key];
  const saved = await persist();
  emit(key, get(key));
  return { ok: true, value: get(key), saved };
}

async function load() {
  const ok = await loadOnce();
  // لو Mongo ما كان جاهز عند التشغيل: نعيد القراءة مرتين إذا ما في تعديلات بالذاكرة
  for (const ms of [45000, 300000]) {
    const t = setTimeout(() => { if (!Object.keys(overrides).length) loadOnce().catch(() => {}); }, ms);
    if (t.unref) t.unref();
  }
  return ok;
}

async function loadOnce() {
  const db = getDb();
  if (!db) return false;
  try {
    const doc = await db.loadDoc(NS, KEY);
    if (doc && typeof doc === 'object') {
      const next = {};
      for (const k of Object.keys(doc)) {
        if (!DEFS[k]) continue;
        const v = validate(k, doc[k]);
        if (v.ok) next[k] = v.value;
      }
      overrides = { ...next, ...overrides };
    }
    loaded = true;
    if (Object.keys(overrides).length) {
      persist().catch(() => {});
      console.log('[إعدادات 🎛] محمّلة من تلغرام: ' + Object.keys(overrides).join(', '));
    }
    if (!touchTimer) {
      touchTimer = setInterval(() => { if (Object.keys(overrides).length) persist().catch(() => {}); }, TOUCH_MS);
      if (touchTimer.unref) touchTimer.unref();
    }
    return true;
  } catch (e) {
    return false;
  }
}

function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

module.exports = {
  get, set, clear, load, source, onChange,
  ASS_SLOT_CHOICES, SRT_SLOT_CHOICES, ASS_SLOTS_MAX,
  _t: { normalizeSlots, validate, DEFS, reset: () => { overrides = {}; loaded = false; }, isLoaded: () => loaded, dump: () => ({ ...overrides }) }
};
