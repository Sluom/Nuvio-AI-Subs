'use strict';
const axios = require('axios');
const crypto = require('crypto');
const settings = require('../core/settings');
const imageSearch = require('./imageSearch');
let shared = null;
try { shared = require('../ai/ai').shared; } catch (e) { shared = null; }

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let H = {};
function init(h) { H = h || {}; }
const tg = (...a) => H.tg(...a);
const withTimeout = (...a) => H.withTimeout(...a);
const logErr = (...a) => H.logErr(...a);
const answerCb = (...a) => H.answerCb(...a);
const scrub = s => H.scrub(s);
const loadCtx = () => H.loadCtx();
const getCtx = () => H.getCtx();
const getMeta = (...a) => H.getMeta(...a);
const onRequest = (...a) => H.onRequest(...a);
const takeCount = () => H.takeCount();
const getPendingEp = () => pendingEp;
const setPendingEp = v => { pendingEp = v; };

const FIND_MAX_RESULTS = 8;
const SMART_MAX = 7;
const MAX_FINDS = 50;
const MAX_RAW = 400;
const SMART_DEADLINE_MS = 45000;
const GEMINI_STEP_TIMEOUT_MS = 20000;
const CINEMETA_SEARCH_TIMEOUT_MS = 8000;
const CINEMETA_META_TIMEOUT_MS = 6000;
const ESCALATE_SIM = 0.72;
const RESOLVE_MIN_SIM = 0.6;
const POSTERS_MAX = 4;
const POSTERS_TIMEOUT_MS = 10000;
const POSTER_ALBUM_TIMEOUT_MS = 9000;
const POSTER_SINGLE_TIMEOUT_MS = 6000;
const DEFAULT_SEARCH_MODEL = 'gemini-3.1-flash-lite';
const finds = new Map();
let pendingEp = null;

const envList = v => String(v || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
const searchEnv = () => ({
  keys: envList(process.env.SEARCH_GEMINI_KEYS),
  model: String(settings.get('search_model') || '').trim(),
  grounding: true
});

const latinDigits = s => String(s == null ? '' : s).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
const hasArabic = s => /[\u0600-\u06FF]/.test(String(s || ''));
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const KIND_AR = { 'فلم': 'movie', 'فيلم': 'movie', 'افلام': 'movie', 'أفلام': 'movie', 'مسلسل': 'series', 'مسلسلات': 'series', 'انمي': 'anime', 'أنمي': 'anime' };
const KIND_EN = { movie: 'movie', film: 'movie', series: 'series', anime: 'anime' };
const DESC_CUE = /(اتذكر|أتذكر|ما اعرف|ما أعرف|نسيت|احداث|أحداث|قصة|قصته|قصتها|يحكي|يتحدث|تدور|بطولة|بطله|مشهد|ممثل|about a |about the |starring|plot|remember|forgot|scene)/i;
const IDLE_TEXT = /^(شكرا|شكراً|شكرًا|تمام|ok|okay|thanks|thx|هلا|هلو|مرحبا|اهلا|أهلا|سلام|السلام عليكم)$/i;

function parseFind(text) {
  const t = String(text || '').trim();
  const m = /^\/find(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t) || /^(?:بحث|ابحث)(?:\s+([\s\S]*))?$/.exec(t);
  return m ? { q: String(m[1] || '').trim() } : null;
}

function isPlainSearchText(text) {
  const t = String(text || '').trim();
  return !!t && t.length <= 600 && !t.startsWith('/') && /\p{L}/u.test(t) && !IDLE_TEXT.test(t);
}

function parseQuery(raw, max) {
  const s = latinDigits(raw).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 100);
  let kind = '';
  const rest = [];
  for (const w of s.split(' ').filter(Boolean)) {
    const k = KIND_AR[w];
    if (k && !kind) kind = k; else rest.push(w);
  }
  if (!kind && rest.length > 1 && KIND_EN[rest[0].toLowerCase()]) kind = KIND_EN[rest.shift().toLowerCase()];
  let year = 0;
  if (rest.length > 1) {
    const maxYear = new Date().getFullYear() + 2;
    for (let i = rest.length - 1; i >= 0; i--) {
      const ym = /^[(\[]?((?:19|20)\d{2})[)\]]?$/.exec(rest[i]);
      if (ym && +ym[1] <= maxYear) { year = +ym[1]; rest.splice(i, 1); break; }
    }
  }
  return { name: rest.join(' ').trim(), year, kind };
}

function parseEpisode(text) {
  const m = /^(?:s\s*)?(\d{1,3})\s*(?:[:,\-xXeE]|\s)\s*(?:e\s*)?(\d{1,4})$/i.exec(latinDigits(text).trim());
  if (!m) return null;
  const season = +m[1];
  const episode = +m[2];
  return season >= 1 && episode >= 1 ? { season, episode } : null;
}

function foldText(s) {
  return String(s || '').normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').replace(/^the /, '');
}

function osaDistance(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = [];
  for (let i = 0; i <= n; i++) { d[i] = new Array(m + 1); d[i][0] = i; }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}
const levSim = (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - osaDistance(a, b) / m : 1; };

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; m++; break; }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) if (ma[i]) { while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && l < la && l < lb && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

function trigramSim(a, b) {
  const grams = s => {
    const p = '  ' + s + ' ';
    const m = new Map();
    for (let i = 0; i + 3 <= p.length; i++) { const g = p.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = grams(a), B = grams(b);
  let inter = 0, sa = 0, sb = 0;
  for (const [g, c] of A) { sa += c; inter += Math.min(c, B.get(g) || 0); }
  for (const c of B.values()) sb += c;
  return sa + sb ? 2 * inter / (sa + sb) : 0;
}

const tokSim = (x, y) => (x === y ? 1 : Math.max(levSim(x, y), jaroWinkler(x, y)));

function nameSim(q, t) {
  const a = foldText(q), b = foldText(t);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const full = 0.4 * levSim(a, b) + 0.3 * jaroWinkler(a, b) + 0.3 * trigramSim(a, b);
  const bt = b.split(' ');
  let cover = 0;
  const at = a.split(' ');
  for (const x of at) { let best = 0; for (const y of bt) best = Math.max(best, tokSim(x, y)); cover += best; }
  cover /= at.length;
  return Math.min(1, 0.6 * full + 0.4 * cover);
}
const titleSim = (a, b) => Math.max(nameSim(a, b), 0.9 * nameSim(b, a));

function searchGeminiModel(model) {
  const m = String(model || '').trim();
  return /^groq$/i.test(m) || /^qwen\//i.test(m) ? DEFAULT_SEARCH_MODEL : (m || DEFAULT_SEARCH_MODEL);
}

function geminiCfg() {
  try {
    const raw = getCtx().rawConfig;
    let d;
    try { d = JSON.parse(raw); } catch { d = JSON.parse(decodeURIComponent(raw)); }
    return { keys: Array.isArray(d.keys) ? d.keys.filter(k => k && String(k).trim()) : [], model: searchGeminiModel(d.model === 'groq' || /^qwen\//i.test(String(d.model || '')) ? d.translationModel : d.model) };
  } catch (e) {
    return { keys: [], model: '' };
  }
}

async function searchKeys() {
  const env = searchEnv();
  if (env.keys.length) {
    const cfgModel = (getCtx() && getCtx().rawConfig) ? geminiCfg().model : '';
    return { keys: env.keys, model: searchGeminiModel(env.model || cfgModel), src: 'env' };
  }
  if (!getCtx()) await loadCtx();
  if (!getCtx() || !getCtx().rawConfig) return { keys: [], err: 'nocfg' };
  const c = geminiCfg();
  return { keys: c.keys, model: searchGeminiModel(env.model || c.model), src: 'cfg', err: c.keys.length ? '' : 'nokeys' };
}

function cleanTitle(t) {
  let s = String(t || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  s = s.replace(/[`*"“”]/g, '').replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').replace(/\.$/, '').trim();
  return s && s.length <= 80 && !hasArabic(s) ? s : '';
}

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const i = s.search(/[\[{]/);
  if (i < 0) return null;
  const close = s[i] === '{' ? '}' : ']';
  const j = s.lastIndexOf(close);
  if (j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

const isGemini3Id = m => /^gemini-3/i.test(m) || /^gemini-(flash|flash-lite|pro)-latest$/i.test(m);

function genVariants(model, wantJson, grounded, temperature) {
  const base = { temperature };
  if (wantJson && !grounded) base.responseMimeType = 'application/json';
  if (!isGemini3Id(model)) return [base];
  return [
    Object.assign({}, base, { thinkingConfig: { thinkingLevel: 'low' } }),
    Object.assign({}, base, { thinkingConfig: { thinkingLevel: 'minimal' } }),
    base
  ];
}

const GROUNDING_QUOTA_COOLDOWN_MS = 20 * 60 * 1000;
let groundingBlockedUntil = 0;
const groundingBlockedMin = () => Math.max(0, Math.ceil((groundingBlockedUntil - Date.now()) / 60000));

async function searchGemini({ prompt, deadline, wantJson, grounding, temperature, thinking, image }) {
  const S = shared;
  if (!S || !S.acquireKey || !S.axios) return { err: 'nocfg' };
  const ks = await searchKeys();
  if (!ks.keys.length) return { err: ks.err || 'nokeys' };
  const model = S.normalizeGeminiModelId(ks.model);
  const url = S.DEFAULT_GEMINI_API_URL + '/models/' + model + ':generateContent';
  let vi = thinking === 'minimal' ? 1 : 0;
  let grounded = !!grounding && groundingBlockedMin() === 0;
  let why = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) return { err: 'busy', why };
    const key = await S.acquireKey(ks.keys, Math.min(8000, remaining));
    if (!key) return { err: 'busy', why };
    const variants = genVariants(model, wantJson, grounded, temperature == null ? 0.2 : temperature);
    const parts = [{ text: prompt }];
    if (image && image.data) parts.push({ inlineData: { mimeType: image.mime || 'image/jpeg', data: image.data } });
    const body = { contents: [{ parts }], generationConfig: variants[Math.min(vi, variants.length - 1)], safetySettings: S.SAFETY_SETTINGS_OFF };
    if (grounded) body.tools = [{ google_search: {} }];
    try {
      const r = await S.axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(key).trim(), 'x-goog-api-client': S.GEMINI_CLIENT_HEADER },
        timeout: Math.min(GEMINI_STEP_TIMEOUT_MS, Math.max(remaining, 3000)), httpAgent: S.httpAgent, httpsAgent: S.httpsAgent
      });
      const parts = (r && r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
      const text = parts.map(p => (p && p.text) || '').join('');
      return text.trim() ? { text, grounded } : { err: 'empty' };
    } catch (e) {
      const st = (e && e.response && e.response.status) || 0;
      const em = String((e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || '').replace(/\s+/g, ' ').slice(0, 160);
      why = (st ? 'HTTP ' + st : 'timeout/شبكة') + ' | ' + model + (em ? ' | ' + em.slice(0, 70) : '');
      if (S.isGeminiAuthFailure(e)) { console.log('[بحث ذكي] مفتاح مرفوض ' + why); S.deadKeys.add(key); continue; }
      if (grounded) {
        grounded = false;
        if (st === 429) {
          const first = groundingBlockedMin() === 0;
          groundingBlockedUntil = Date.now() + GROUNDING_QUOTA_COOLDOWN_MS;
          if (first) console.log('[بحث ذكي] حصة البحث بجوجل خلصت (429) ⟵ أكمل بدونه، وأعيد المحاولة بعد ' + Math.round(GROUNDING_QUOTA_COOLDOWN_MS / 60000) + ' دقيقة.');
        } else {
          console.log('[بحث ذكي] تعذر البحث بجوجل (' + (st ? 'HTTP ' + st : 'timeout') + ') ⟵ أكمل بدونه.');
        }
        continue;
      }
      console.log('[بحث ذكي] ' + why);
      if (st === 404) return { err: 'config' };
      if (st === 400) {
        if (vi < variants.length - 1) { vi++; continue; }
        return { err: 'config' };
      }
      S.keyCooldowns.set(key, Date.now() + S.cooldownForStatus(st));
      await sleep(600);
    }
  }
  return { err: 'busy', why };
}

async function cinemetaSearch(type, q) {
  try {
    const r = await axios.get('https://v3-cinemeta.strem.io/catalog/' + type + '/top/search=' + encodeURIComponent(q) + '.json', { timeout: CINEMETA_SEARCH_TIMEOUT_MS });
    const metas = r && r.data && Array.isArray(r.data.metas) ? r.data.metas : [];
    return metas.filter(x => x && /^tt\d+$/.test(String(x.id || ''))).map(x => ({
      id: String(x.id), type, name: String(x.name || x.id), year: parseInt(String(x.releaseInfo || x.year || '').slice(0, 4), 10) || 0,
      poster: /^https:\/\//.test(String(x.poster || '')) ? String(x.poster) : ''
    }));
  } catch (e) {
    return null;
  }
}

async function fetchMetaBrief(type, id) {
  try {
    const r = await axios.get('https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json', { timeout: CINEMETA_META_TIMEOUT_MS });
    const m = r && r.data && r.data.meta;
    if (!m) return null;
    const arr = v => (Array.isArray(v) ? v : v ? [v] : []).map(String);
    return { genres: arr(m.genres).slice(0, 4), cast: arr(m.cast).slice(0, 8), director: arr(m.director).slice(0, 2), country: String(m.country || ''), description: String(m.description || '').slice(0, 350) };
  } catch (e) {
    return null;
  }
}

function mergeResults(lists, year) {
  const seen = new Set();
  const all = [];
  const max = Math.max(0, ...lists.map(l => (l || []).length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const x = l && l[i];
      if (x && !seen.has(x.id)) { seen.add(x.id); all.push(x); }
    }
  }
  if (!year) return { items: all.slice(0, FIND_MAX_RESULTS), yearMiss: false };
  const exact = all.filter(x => x.year === year);
  if (!exact.length) return { items: all.slice(0, FIND_MAX_RESULTS), yearMiss: true };
  return { items: exact.concat(all.filter(x => x.year !== year)).slice(0, FIND_MAX_RESULTS), yearMiss: false };
}

async function freeSearch(p) {
  const types = p.kind === 'movie' ? ['movie'] : p.kind === 'series' ? ['series'] : ['movie', 'series'];
  const lists = await Promise.all(types.map(t => cinemetaSearch(t, p.name)));
  return lists.every(l => l === null) ? null : mergeResults(lists, p.year);
}

async function understand(raw, p, deadline) {
  const env = searchEnv();
  const hints =[p.kind ? 'type=' + p.kind : '', p.year ? 'year=' + p.year : ''].filter(Boolean).join(', ');
  const prompt = [
    'You are the search engine of a movie / TV series / anime lookup bot. The user wrote the message below in Arabic or English. It may contain typos, a partial title, a transliterated title, or a description from memory (plot, scenes, characters, actors, country, era).',
    'Task: identify up to ' + SMART_MAX + ' movies, TV series or anime this message most likely refers to, best match first.',
    'Rules:',
    '- Return REAL works only. Never invent a title. If you are not sure a work exists, leave it out or give it a low confidence.',
    '- "title" is the official English title as listed on IMDb (never a translation or transliteration of your own). For non-English works use the English release title on IMDb and put the original-language title in "original_title".',
    '- "year" is the first release year as an integer, or null if unsure. "type" is "movie" or "series" (anime TV = "series", anime film = "movie").',
    '- "confidence" is an integer 0-100: how likely this is the work the user means.',
    '- If the message names a work (even misspelled or incomplete), put that work first; add other works of the same franchise only if the name is ambiguous.',
    '- If it describes plot / actors / scenes, rank by how well each work fits ALL the clues together, not just one clue.',
    '- Respect the user hints (type, year) when given.',
    '- If the message holds too little information to identify anything (for example just "an action movie"), return vague=true and an empty list.',
    '- "mode" is "title" when the user is trying to type a name, or "description" when they describe the work.',
    'Output ONLY JSON, no commentary: {"mode":"title","vague":false,"candidates":[{"title":"","original_title":"","year":2020,"type":"movie","confidence":90}]}',
    'Today\'s date: ' + new Date().toISOString().slice(0, 10),
    hints ? 'User hints: ' + hints : '',
    'User message: <<<' + raw + '>>>'
  ].filter(Boolean).join('\n');
  const descLike = DESC_CUE.test(raw) || String(raw).split(/\s+/).filter(Boolean).length >= 7;
  const r = await searchGemini({ prompt, deadline, wantJson: true, grounding: env.grounding, temperature: 0.2, thinking: descLike ? '' : 'minimal' });
  if (!r.text) return { err: r.err || 'empty', why: r.why || '' };
  const j = extractJson(r.text);
  if (!j || typeof j !== 'object') return { err: 'empty' };
  const cands = candsFromJson(j);
  return { mode: j.mode === 'description' ? 'description' : 'title', vague: !!j.vague || !cands.length, cands: cands.slice(0, SMART_MAX), grounded: !!r.grounded };
}

function candsFromJson(j) {
  const curYear = new Date().getFullYear();
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.candidates) ? j.candidates : []);
  const seen = new Set();
  const cands = [];
  for (const c of arr) {
    const title = cleanTitle(c && c.title);
    if (!title) continue;
    const y = Math.round(Number(c.year));
    const year = y >= 1880 && y <= curYear + 2 ? y : 0;
    const key = foldText(title) + '|' + year;
    if (seen.has(key)) continue;
    seen.add(key);
    const conf = Number(c.confidence);
    cands.push({ title, original: cleanTitle(c.original_title), year, type: c.type === 'movie' || c.type === 'series' ? c.type : '', confidence: Number.isFinite(conf) ? clamp(conf, 0, 100) : 50, why: trunc(String(c.why || '').replace(/\s+/g, ' ').trim(), 70) });
  }
  cands.sort((a, b) => b.confidence - a.confidence);
  return cands;
}

async function resolveCandidate(c) {
  const types = c.type ? [c.type] : ['movie', 'series'];
  const qs = [c.title];
  const main = c.title.split(/\s*[:\-–—]\s*/)[0].trim();
  if (main.length >= 3 && main !== c.title) qs.push(main);
  if (c.original && c.original !== c.title) qs.push(c.original);
  for (const q of qs) {
    const lists = await Promise.all(types.map(t => cinemetaSearch(t, q)));
    let best = null;
    for (const l of lists) {
      for (const x of (l || [])) {
        const sim = titleSim(c.title, x.name);
        if (sim < RESOLVE_MIN_SIM) continue;
        const yd = c.year && x.year ? Math.abs(c.year - x.year) : null;
        if (yd !== null && yd > 2 && sim < 0.9) continue;
        const score = sim * 0.75 + (yd === null ? 0.5 : yd === 0 ? 1 : yd === 1 ? 0.5 : 0) * 0.25;
        if (!best || score > best.score) best = { x, score };
      }
    }
    if (best) return Object.assign({}, best.x, { c1: c.confidence });
  }
  return null;
}

async function compareByDescription(raw, items, deadline) {
  const metas = await Promise.all(items.map(x => fetchMetaBrief(x.type, x.id)));
  const pack = items.map((x, i) => Object.assign({ id: x.id, type: x.type, title: x.name, year: x.year || null }, metas[i] || {}));
  const prompt = [
    'A user is trying to remember a movie / TV series / anime. Their description (Arabic or English):',
    '<<<' + raw + '>>>',
    'Below are candidate works with data from a database (JSON). For EACH candidate, score 0-100 how well it matches ALL the clues in the description (plot, characters, actors, year, country, genre). Use the data given plus your own knowledge. A clue that contradicts the work (wrong actor, wrong era, wrong country) is a strong negative; a clue that fits is a positive. Do not reward a candidate just for being famous.',
    'Output ONLY JSON, no commentary: [{"id":"tt...","score":85,"why":"<= 12 words in Arabic"}]',
    'Candidates: ' + JSON.stringify(pack)
  ].join('\n');
  const r = await searchGemini({ prompt, deadline, wantJson: true, grounding: false, temperature: 0 });
  if (!r.text) return null;
  const j = extractJson(r.text);
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.results) ? j.results : null);
  if (!arr) return null;
  const ids = new Set(items.map(x => x.id));
  const out = new Map();
  for (const e of arr) {
    const id = String(e && e.id || '');
    const sc = Number(e && e.score);
    if (ids.has(id) && Number.isFinite(sc)) out.set(id, { score: clamp(sc, 0, 100), why: trunc(String(e.why || '').replace(/\s+/g, ' ').trim(), 70) });
  }
  return out.size ? out : null;
}

function rankItems(resolved, cmp, p, mode) {
  const latinQ = mode === 'title' && !hasArabic(p.name) ? p.name : '';
  const scored = resolved.map(x => {
    const c3 = cmp && cmp.has(x.id) ? cmp.get(x.id).score : null;
    const sim = latinQ ? nameSim(latinQ, x.name) : null;
    const parts = [[c3 != null ? 0.35 : 0.65, x.c1]];
    if (c3 != null) parts.push([0.5, c3]);
    if (sim != null) parts.push([c3 != null ? 0.15 : 0.35, sim * 100]);
    let s = parts.reduce((a, q) => a + q[0] * q[1], 0) / parts.reduce((a, q) => a + q[0], 0);
    if (p.year && x.year) { const d = Math.abs(p.year - x.year); s += d === 0 ? 8 : d === 1 ? 3 : -12; }
    if ((p.kind === 'movie' || p.kind === 'series') && x.type !== p.kind) s -= 40;
    return Object.assign({}, x, { score: clamp(Math.round(s), 0, 100), why: c3 != null ? cmp.get(x.id).why : '' });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SMART_MAX);
}

const SMART_FAIL = {
  nokeys: 'ما لقيت مفاتيح جمناي للبحث (لا بمتغير SEARCH_GEMINI_KEYS ولا بإعداداتك). اكتب الاسم بالإنجليزي.',
  nocfg: 'ما عندي إعداداتك بالذاكرة (السيرفر تو اشتغل). افتح أي حلقة من Nuvio مرة وحدة، أو اكتب الاسم بالإنجليزي.',
  busy: 'مفاتيح جمناي مشغولة حالياً، جرّب بعد شوي أو اكتب الاسم بالإنجليزي.',
  config: 'الموديل المحفوظ ما قبل الطلب، غيّره أو اكتب الاسم بالإنجليزي.',
  empty: 'ما كدرت أفهم الطلب، جرّب صياغة ثانية أو اكتب الاسم بالإنجليزي.'
};

async function sendPosters(chatId, items) {
  const pics = items.map((x, i) => ({ x, i })).filter(o => o.x.poster).slice(0, POSTERS_MAX);
  if (!pics.length) return;
  const cap = o => (o.i + 1) + '. ' + trunc(o.x.name, 80) + (o.x.year ? ' (' + o.x.year + ')' : '');
  try {
    if (pics.length === 1) await tg('sendPhoto', { chat_id: chatId, photo: pics[0].x.poster, caption: cap(pics[0]) }, POSTER_ALBUM_TIMEOUT_MS, false);
    else await tg('sendMediaGroup', { chat_id: chatId, media: pics.map(o => ({ type: 'photo', media: o.x.poster, caption: cap(o) })) }, POSTER_ALBUM_TIMEOUT_MS, false);
  } catch (e) {
    if (/timeout|ECONNABORTED/i.test(String(e && e.message))) return;
    for (const o of pics) await tg('sendPhoto', { chat_id: chatId, photo: o.x.poster, caption: cap(o) }, POSTER_SINGLE_TIMEOUT_MS, false).catch(() => {});
  }
}

async function showResults(chatId, o) {
  const { items, p, raw, smart, canSmart, mode } = o;
  const desc = smart && mode === 'description';
  const tags = [{ movie: 'فلم', series: 'مسلسل', anime: 'أنمي' }[p.kind] || '', p.year ? String(p.year) : ''].filter(Boolean);
  const out = [];
  if (o.header) out.push(rtl(o.header));
  else if (desc) out.push(rtl('🧠 رشحت لك حسب وصفك (الأقرب أول):'));
  else out.push(rtl('🔎 نتائج ' + latin('«' + (smart && hasArabic(p.name) ? items[0].name : p.name) + '»') + (tags.length ? ' (' + tags.join(' · ') + ')' : '')));
  if (smart && !desc && hasArabic(p.name) && p.name.length <= 40) out.push(rtl('🌐 ' + p.name + ' ← ' + latin(items[0].name)));
  if (o.yearMiss) out.push(rtl('ما لقيت بسنة ' + p.year + '، هذي أقرب النتائج:'));
  if (o.note) out.push(rtl(o.note));
  if (o.sources) out.push(rtl(o.sources));
  if (desc) {
    items.forEach((x, i) => out.push(rtl((i + 1) + '. ' + (x.score >= 75 ? '✅' : x.score >= 50 ? '🔸' : '▫️') + ' ' + latin(x.name + (x.year ? ' (' + x.year + ')' : '')) + (x.why ? ' — ' + (hasArabic(x.why) ? x.why : latin(x.why)) : ''))));
    out.push(rtl('✅ قوي · 🔸 محتمل · ▫️ ضعيف'));
  }
  out.push(rtl('🎬 فلم · 📺 مسلسل. اختر العمل الصحيح:'));
  const h = crypto.createHash('sha1').update(raw + ':' + Date.now()).digest('hex').slice(0, 8);
  finds.set(h, { items, at: Date.now(), raw });
  while (finds.size > MAX_FINDS) finds.delete(finds.keys().next().value);
  const rows = items.map((x, i) => [{ text: (i + 1) + '· ' + (x.type === 'movie' ? '🎬 ' : '📺 ') + trunc(x.name, 34) + (x.year ? ' · ' + x.year : ''), callback_data: 'fd:' + h + ':' + i }]);
  if (canSmart && !smart) rows.push([{ text: '🧠 بحث أذكى (وصف/تصحيح أخطاء)', callback_data: 'fs:' + h }]);
  await withTimeout(sendPosters(chatId, items), POSTERS_TIMEOUT_MS);
  await tg('sendMessage', { chat_id: chatId, text: out.join('\n'), reply_markup: { inline_keyboard: rows }, disable_web_page_preview: true });
}

async function runSearch(chatId, rawIn, opts) {
  opts = opts || {};
  const send = (text, markup) => tg('sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });
  let waitId = 0;
  const clearWait = async () => {
    if (!waitId) return;
    const id = waitId;
    waitId = 0;
    await tg('deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
  };
  try {
    pendingEp = null;
    const raw = String(rawIn || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_RAW);
    const p = parseQuery(raw, MAX_RAW);
    if (!p.name) {
      await send([rtl('🔎 البحث بالاسم أو بالوصف'), rtl('اكتب اسم الفلم أو المسلسل، أو وصفاً لما تتذكره، مثل:'), latin('spider man 2026'), rtl('فلم سبايدر مان 2026'), rtl('اتذكر فلم عن شاب يعضه عنكبوت ويتسلق الجدران')].join('\n'));
      return;
    }
    const deadline = Date.now() + SMART_DEADLINE_MS;
    const ks = (await withTimeout(searchKeys(), 4000)) || { keys: [], err: 'nocfg' };
    const canSmart = ks.keys.length > 0;
    const words = p.name.split(' ').length;
    const wantSmart = !!opts.forceSmart || hasArabic(raw) || words >= 7 || DESC_CUE.test(raw);
    let free = null;
    if (!wantSmart) {
      free = await freeSearch(p);
      if (free && free.items.length) {
        const best = Math.max(...free.items.map(x => nameSim(p.name, x.name)));
        if (best >= ESCALATE_SIM || !canSmart) {
          console.log('[بحث] مباشر من Cinemeta (' + free.items.length + ' نتيجة، أفضل تشابه ' + best.toFixed(2) + ')');
          await showResults(chatId, { items: free.items, p, raw, smart: false, canSmart, yearMiss: free.yearMiss });
          return;
        }
        console.log('[بحث] التشابه ضعيف (' + best.toFixed(2) + ') ⟵ أنتقل للبحث الذكي');
      } else if (!canSmart) {
        await send(free === null ? rtl('⚠️ تعذر الاتصال بمصدر البحث (Cinemeta)، جرّب بعد شوي.') : rtl('ما لقيت نتائج لـ ' + latin('«' + p.name + '»')) + '\n' + rtl('جرّب اسم ثاني، أو أضف مفاتيح جمناي للبحث حتى يفهم الوصف والأخطاء.'));
        return;
      }
    }
    if (!canSmart) { await send(rtl('⚠️ ' + SMART_FAIL[ks.err === 'nocfg' ? 'nocfg' : 'nokeys'])); return; }

    const wait = await send(rtl('🧠 جاري البحث الذكي...'));
    waitId = (wait && wait.message_id) || 0;
    const fallbackFree = async note => {
      await clearWait();
      await showResults(chatId, { items: free.items, p, raw, smart: false, canSmart: false, yearMiss: free.yearMiss, note });
    };
    const u = await understand(raw, p, deadline);
    if (u.err) {
      console.log('[بحث ذكي] فشل الفهم: ' + u.err + (u.why ? ' | ' + u.why : ''));
      if (free && free.items.length) { await fallbackFree('تعذر البحث الذكي، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send(rtl('⚠️ ' + (SMART_FAIL[u.err] || SMART_FAIL.empty)) + (u.why ? '\n' + rtl('🔎 السبب:') + ' ' + latin(u.why) : ''));
      return;
    }
    if (u.vague) {
      console.log('[بحث ذكي] الطلب عام/غير محدد');
      if (free && free.items.length) { await fallbackFree('ما كدرت أفهم الطلب أكثر، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send([rtl('🧠 ما كدرت أحدد العمل، المعلومات قليلة.'), rtl('أضف أي من هذي: اسم ممثل، سنة تقريبية، حدث أو مشهد مميز، بلد أو لغة، أو نوعه (فلم / مسلسل / أنمي).')].join('\n'));
      return;
    }
    const resolvedAll = (await Promise.all(u.cands.map(c => resolveCandidate(c)))).filter(Boolean);
    const byId = new Map();
    for (const x of resolvedAll) if (!byId.has(x.id) || byId.get(x.id).c1 < x.c1) byId.set(x.id, x);
    const resolved = [...byId.values()];
    console.log('[بحث ذكي] الوضع=' + u.mode + ' | مرشحين=' + u.cands.length + ' | تحقق منهم=' + resolved.length + (u.grounded ? ' | grounding' : ''));
    if (!resolved.length) {
      if (free && free.items.length) { await fallbackFree('جمناي ما لقى شي أدق، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send([rtl('جمناي رجّح هذي الأعمال، بس ما لقيتها بـ Cinemeta:'), ...u.cands.map(c => rtl('• ' + latin(c.title + (c.year ? ' (' + c.year + ')' : '')))), rtl('جرّب تكتب الاسم بالإنجليزي أو أضف تفاصيل.')].join('\n'));
      return;
    }
    let cmp = null;
    if (u.mode === 'description' && resolved.length >= 2 && deadline - Date.now() > 8000) cmp = await compareByDescription(raw, resolved, deadline).catch(() => null);
    if (u.mode === 'description') console.log('[بحث ذكي] مقارنة الأوصاف: ' + (cmp ? cmp.size + ' نتيجة' : 'تعذرت (أكمل بترتيب جمناي الأول)'));
    const items = rankItems(resolved, cmp, p, u.mode);
    await clearWait();
    await showResults(chatId, { items, p, raw, smart: true, canSmart, mode: u.mode });
  } catch (e) {
    logErr('خطأ بالبحث', e);
    await clearWait();
    try { await send(rtl('⚠️ صار خطأ أثناء البحث، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

const onFind = runSearch;

async function askEpisode(chatId, it) {
  pendingEp = { imdb: it.id, name: it.name, at: Date.now() };
  const lines = [rtl('📺 ' + latin(it.name) + (it.year ? ' ' + latin('(' + it.year + ')') : '') + ' ' + latin('(' + it.id + ')')),
    rtl('هذا مسلسل، ابعث الموسم والحلقة مثل:'), latin('1 5')];
  const meta = await getMeta(it.id);
  if (meta && meta.all.size) {
    const ss = [...meta.all.keys()].sort((a, b) => a - b);
    lines.push(rtl('المواسم المتوفرة (موسم:حلقات):'));
    lines.push(latin(ss.slice(0, 15).map(s => s + ':' + meta.all.get(s)).join('  ') + (ss.length > 15 ? '  …' : '')));
  }
  const epText = lines.join('\n');
  const idAt = epText.indexOf(String(it.id));
  await tg('sendMessage', { chat_id: chatId, text: epText, ...(idAt >= 0 ? { entities: [{ type: 'code', offset: idAt, length: String(it.id).length }] } : {}), disable_web_page_preview: true });
}

async function onFindCallback(cq) {
  const m = /^fd:([0-9a-f]{8}):(\d+)$/.exec(String(cq.data || ''));
  const f = m && finds.get(m[1]);
  const it = f && f.items[+m[2]];
  if (!it) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث البحث من جديد'); return; }
  if (!getCtx()) await loadCtx();
  if (!getCtx()) { await answerCb(cq, 'افتح حلقة من Nuvio مرة وحدة أول'); return; }
  const chatId = cq.message.chat.id;
  if (it.type === 'movie') {
    await answerCb(cq, 'جاري جلب التراكات...');
    await onRequest(chatId, { imdb: it.id, targetId: it.id }, takeCount());
    return;
  }
  await answerCb(cq);
  await askEpisode(chatId, it);
}

async function onSmartCallback(cq) {
  const m = /^fs:([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const f = m && finds.get(m[1]);
  if (!f) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث البحث من جديد'); return; }
  await answerCb(cq, 'جاري البحث الذكي...');
  await runSearch(cq.message.chat.id, f.raw, { forceSmart: true });
}

const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20000;
const IMAGE_GEMINI_BUDGET_MS = 40000;
const IMAGE_CAPTION_MAX = 300;
const IMAGE_MIMES = /^image\/(jpeg|png|webp|heic|heif)$/i;
const MERGE_SIM = 0.85;

function imageOf(m) {
  if (!m) return null;
  if (m.video || m.animation || m.video_note) return { unsupported: true };
  if (Array.isArray(m.photo) && m.photo.length) {
    const area = p => (p.width || 0) * (p.height || 0);
    const sizes = m.photo.slice().sort((a, b) => area(a) - area(b));
    const main = sizes[sizes.length - 1];
    const fits = p => (p.file_size ? p.file_size <= imageSearch.LENS_MAX_BYTES : (p.width || 0) <= 800);
    const small = main && fits(main) ? null : sizes.slice().reverse().find(fits);
    return { main: main.file_id, lens: small ? small.file_id : null, mime: 'image/jpeg' };
  }
  const d = m.document;
  if (d && IMAGE_MIMES.test(String(d.mime_type || ''))) {
    const th = d.thumbnail || d.thumb;
    const small = d.file_size && d.file_size > imageSearch.LENS_MAX_BYTES && th ? th.file_id : null;
    return { main: d.file_id, lens: small, mime: String(d.mime_type).toLowerCase(), size: d.file_size || 0 };
  }
  return null;
}

async function tgDownload(fileId, maxBytes) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f || !f.file_path) throw new Error('getFile');
  if (f.file_size && f.file_size > maxBytes) throw new Error('big');
  try {
    const r = await axios.get('https://api.telegram.org/file/bot' + TG_TOKEN + '/' + f.file_path, { responseType: 'arraybuffer', timeout: IMAGE_DOWNLOAD_TIMEOUT_MS, maxContentLength: maxBytes });
    return Buffer.from(r.data);
  } catch (e) {
    throw new Error(scrub(e && e.message));
  }
}

function mergeImageCands(gemini, trace) {
  const out = gemini.map(c => Object.assign({}, c));
  for (const t of trace) {
    const hit = out.find(c => titleSim(c.title, t.title) >= MERGE_SIM);
    if (hit) {
      hit.confidence = clamp(Math.max(hit.confidence, t.confidence) + 5, 0, 100);
      hit.why = (hit.why ? hit.why + ' · ' : '') + t.why;
      if (!hit.year && t.year) hit.year = t.year;
    } else {
      out.push(Object.assign({}, t));
    }
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, SMART_MAX);
}

async function onImage(chatId, m) {
  const send = (text, markup) => tg('sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });
  let waitId = 0;
  const clearWait = async () => {
    if (!waitId) return;
    const id = waitId;
    waitId = 0;
    await tg('deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
  };
  try {
    pendingEp = null;
    const im = imageOf(m);
    if (!im || im.unsupported) return;
    const caption = String(m.caption || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/^\/find(?:@\w+)?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, IMAGE_CAPTION_MAX);
    const wait = await send(rtl('🖼 جاري تحليل الصورة (Lens + trace.moe + جمناي)...'));
    waitId = (wait && wait.message_id) || 0;

    let main;
    try {
      main = await tgDownload(im.main, IMAGE_MAX_BYTES);
    } catch (e) {
      await clearWait();
      await send(rtl(e && e.message === 'big' ? '⚠️ الصورة كبيرة (أكثر من 15MB)، صغّرها وابعثها.' : '⚠️ ما كدرت أنزّل الصورة من تلغرام، ابعثها مرة ثانية.'));
      return;
    }
    let lensBuf = main.length <= imageSearch.LENS_MAX_BYTES ? main : null;
    if (!lensBuf && im.lens) lensBuf = await tgDownload(im.lens, imageSearch.LENS_MAX_BYTES).catch(() => null);
    const serpKey = String(settings.get('serpapi_key') || '').trim();
    const ev = await imageSearch.gather({ buf: main, mime: im.mime, lensBuf, lensMime: lensBuf === main ? im.mime : 'image/jpeg', serpKey });
    if (ev.lens && ev.lens.err) console.log('[بحث صورة] Lens فشل: ' + ev.lens.err);
    if (ev.trace && ev.trace.err) console.log('[بحث صورة] trace.moe فشل: ' + ev.trace.err);

    const ks = (await withTimeout(searchKeys(), 4000)) || { keys: [], err: 'nocfg' };
    const canSmart = ks.keys.length > 0;
    let gCands = [];
    let gerr = '';
    if (canSmart) {
      const prompt = imageSearch.buildPrompt({ caption, lens: ev.lens, trace: ev.trace, maxCands: SMART_MAX, today: new Date().toISOString().slice(0, 10) });
      const r = await searchGemini({ prompt, deadline: Date.now() + IMAGE_GEMINI_BUDGET_MS, wantJson: true, grounding: true, temperature: 0.2, thinking: '', image: { mime: im.mime, data: main.toString('base64') } });
      const j = r.text ? extractJson(r.text) : null;
      if (j && typeof j === 'object') gCands = candsFromJson(j);
      else gerr = r.err || 'empty';
      if (gerr) console.log('[بحث صورة] جمناي فشل: ' + gerr + (r.why ? ' | ' + r.why : ''));
    }
    const cands = mergeImageCands(gCands, imageSearch.traceCands(ev.trace, cleanTitle));
    const sm = imageSearch.summary(ev);
    const srcLine = '🧩 جمناي ' + (!canSmart ? '⛔' : gerr ? '⚠️' : '✅') + ' · Lens ' + sm.L + ' · trace.moe ' + sm.T;
    console.log('[بحث صورة] Lens=' + sm.L + ' | trace=' + sm.T + ' | جمناي=' + (canSmart ? (gerr ? 'فشل' : gCands.length + ' مرشح') : 'بدون مفاتيح') + ' | بعد الدمج=' + cands.length);

    if (!cands.length) {
      await clearWait();
      if (!canSmart) { await send(rtl('⚠️ ' + SMART_FAIL[ks.err === 'nocfg' ? 'nocfg' : 'nokeys'])); return; }
      await send([rtl('🖼 ما كدرت أحدد العمل من هذي الصورة.'), rtl(srcLine), rtl('جرّب لقطة أوضح، أو ابعثها ومعها وصف (نص من الحوار، البلد، النوع، السنة) بالكابشن.')].join('\n'));
      return;
    }
    const resolvedAll = (await Promise.all(cands.map(async c => {
      const x = await resolveCandidate(c);
      return x ? Object.assign(x, { why: c.why }) : null;
    }))).filter(Boolean);
    const byId = new Map();
    for (const x of resolvedAll) if (!byId.has(x.id) || byId.get(x.id).c1 < x.c1) byId.set(x.id, x);
    const items = [...byId.values()].sort((a, b) => b.c1 - a.c1).slice(0, SMART_MAX).map(x => Object.assign(x, { score: clamp(Math.round(x.c1), 0, 100) }));
    if (!items.length) {
      await clearWait();
      await send([rtl('رشحت هذي الأعمال، بس ما لقيتها بـ Cinemeta:'), ...cands.map(c => rtl('• ' + latin(c.title + (c.year ? ' (' + c.year + ')' : '')))), rtl(srcLine)].join('\n'));
      return;
    }
    await clearWait();
    await showResults(chatId, { items, p: { name: caption || 'image', kind: '', year: 0 }, raw: caption || 'image', smart: true, canSmart: false, mode: 'description', header: '🖼 رشحت لك من الصورة (الأقرب أول):', sources: srcLine });
  } catch (e) {
    logErr('خطأ بالبحث بالصورة', e);
    await clearWait();
    try { await send(rtl('⚠️ صار خطأ أثناء تحليل الصورة، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

const serpKeyCmd = t => { const m = /^\/serpkey(?:@\w+)?(?:\s+(\S+))?$/i.exec(t); return m ? String(m[1] || '').trim() : null; };
const maskKey = k => (k ? '…' + String(k).slice(-4) : '');

async function onSerpKeyCmd(chatId, arg, msgId) {
  const send = text => tg('sendMessage', { chat_id: chatId, text }).catch(() => {});
  const cur = String(settings.get('serpapi_key') || '').trim();
  if (!arg) {
    await send(cur
      ? rtl('🖼 مفتاح SerpApi (Lens) شغّال ✅ ') + latin(maskKey(cur)) + '\n' + rtl('للتغيير: ') + latin('/serpkey KEY') + rtl(' وللمسح: ') + latin('/serpkey off')
      : rtl('🖼 Lens غير مفعّل ⛔ (البحث بالصورة يشتغل بجمناي و trace.moe فقط).') + '\n' + rtl('لتفعيله ابعث: ') + latin('/serpkey KEY'));
    return;
  }
  if (/^(off|clear|مسح|حذف|ايقاف)$/i.test(arg)) {
    await settings.clear('serpapi_key');
    await send(rtl('تم مسح مفتاح SerpApi ⛔ البحث بالصورة يكمل بجمناي و trace.moe بدون Lens.'));
    return;
  }
  if (msgId) tg('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
  const r = await settings.set('serpapi_key', arg);
  if (!r.ok || !r.value) { await send(rtl('⚠️ المفتاح غير صالح (أحرف وأرقام فقط)، ما انحفظ.')); return; }
  await send(rtl('✅ انحفظ مفتاح SerpApi ') + latin(maskKey(r.value)) + rtl(' وانمسحت رسالتك من المحادثة.') + (r.saved === false ? '\n' + rtl('⚠️ اشتغل لكن ما انحفظ بالقاعدة (يرجع للقديم بعد إعادة التشغيل).') : ''));
}

const COUNTRY_WORDS = [
  [/^(كوري|كورية|korean)$/i, 'KR', 'ko'], [/^(تركي|تركية|turkish)$/i, 'TR', 'tr'], [/^(ياباني|يابانية|japanese)$/i, 'JP', 'ja'],
  [/^(هندي|هندية|indian)$/i, 'IN', 'hi'], [/^(اسباني|إسباني|اسبانية|إسبانية|spanish)$/i, 'ES', 'es'], [/^(فرنسي|فرنسية|french)$/i, 'FR', 'fr'],
  [/^(ايطالي|إيطالي|ايطالية|إيطالية|italian)$/i, 'IT', 'it'], [/^(الماني|ألماني|المانية|ألمانية|german)$/i, 'DE', 'de'], [/^(صيني|صينية|chinese)$/i, 'CN', 'zh'],
  [/^(امريكي|أمريكي|امريكية|أمريكية|american)$/i, 'US', 'en'], [/^(بريطاني|بريطانية|british)$/i, 'GB', 'en'], [/^(مصري|مصرية|egyptian)$/i, 'EG', 'ar'], [/^(عربي|عربية|arabic)$/i, '', 'ar']
];
const ACTOR_SKIP_GENRES = new Set([10767, 10763, 10764]);
const actorCmd = t => { const m = /^\/actor(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t); return m ? String(m[1] || '').trim() : null; };
const ACTOR_RESOLVE_MAX = 12;

function tmdbKeyFromCtx() {
  try {
    const d = JSON.parse(decodeURIComponent(getCtx().rawConfig));
    return String(d.tmdbKey || '').replace(/["'\s]/g, '').replace(/^Bearer/i, '');
  } catch (e) {
    return '';
  }
}

async function tmdbGet(path, params) {
  const key = tmdbKeyFromCtx();
  if (!key) { const e = new Error('nokey'); e.code = 'nokey'; throw e; }
  const auth = key.length > 40 ? { headers: { Authorization: 'Bearer ' + key }, params: {} } : { headers: {}, params: { api_key: key } };
  try {
    const r = await axios.get('https://api.themoviedb.org/3' + path, { headers: auth.headers, params: Object.assign({}, auth.params, params), timeout: 8000 });
    return r.data;
  } catch (e) {
    throw new Error('tmdb HTTP ' + ((e && e.response && e.response.status) || 'net'));
  }
}

async function onActor(chatId, argRaw) {
  const send = text => tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  try {
    const p0 = parseQuery(argRaw, MAX_RAW);
    let country = null;
    const words = [];
    for (const w of String(p0.name || '').split(' ').filter(Boolean)) {
      const c = !country && COUNTRY_WORDS.find(x => x[0].test(w));
      if (c) country = c; else words.push(w);
    }
    const name = words.join(' ').trim();
    if (!name) {
      await send([rtl('🎭 البحث عن أعمال ممثل (بالاسم النصي):'), latin('/actor Tom Hanks'), latin('/actor Tom Hanks 2000'), rtl('وتكدر تضيف: فلم / مسلسل، أو سنة، أو جنسية العمل (كوري، تركي، ياباني...)')].join('\n'));
      return;
    }
    if (!getCtx()) await loadCtx();
    if (!getCtx()) { await send(rtl('افتح حلقة من Nuvio مرة وحدة أول حتى أعرف إعداداتك (مفتاح TMDB).')); return; }
    if (!tmdbKeyFromCtx()) { await send(rtl('ما لقيت مفتاح TMDB بإعدادات الإضافة، أضفه وجرّب مرة ثانية.')); return; }
    const wait = await send(rtl('🎭 جاري البحث عن أعمال ' + latin(name) + '...'));
    const waitId = (wait && wait.message_id) || 0;
    const clearWait = () => (waitId ? tg('deleteMessage', { chat_id: chatId, message_id: waitId }).catch(() => {}) : Promise.resolve());
    try {
      const found = await tmdbGet('/search/person', { query: name, language: 'en-US', include_adult: 'false' });
      const people = (found && found.results) || [];
      const person = people.find(x => x.known_for_department === 'Acting') || people[0];
      if (!person) { await clearWait(); await send(rtl('ما لقيت ممثل باسم ') + latin('«' + name + '»') + rtl('، جرّب الاسم بالإنجليزي.')); return; }
      const cr = await tmdbGet('/person/' + person.id + '/combined_credits', { language: 'en-US' });
      const seen = new Set();
      const list = [];
      for (const c of ((cr && cr.cast) || [])) {
        const isMovie = c.media_type === 'movie';
        if (!isMovie && c.media_type !== 'tv') continue;
        if (p0.kind === 'movie' && !isMovie) continue;
        if ((p0.kind === 'series' || p0.kind === 'anime') && isMovie) continue;
        if (/\b(self|himself|herself|themselves)\b/i.test(String(c.character || ''))) continue;
        if ((c.genre_ids || []).some(g => ACTOR_SKIP_GENRES.has(g))) continue;
        if ((c.vote_count || 0) < 30) continue;
        const title = String((isMovie ? c.title : c.name) || '').trim();
        const date = String((isMovie ? c.release_date : c.first_air_date) || '');
        const year = parseInt(date.slice(0, 4), 10) || 0;
        if (!title || (p0.year && year !== p0.year)) continue;
        if (country) {
          const okC = (c.origin_country || []).includes(country[1]) || c.original_language === country[2];
          if (!okC) continue;
        }
        const key = (isMovie ? 'm' : 't') + c.id;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ title, original: String((isMovie ? c.original_title : c.original_name) || '').trim(), year, type: isMovie ? 'movie' : 'series', pop: c.popularity || 0 });
      }
      list.sort((a, b) => b.pop - a.pop);
      const resolved = (await Promise.all(list.slice(0, ACTOR_RESOLVE_MAX).map(async c => {
        const x = await resolveCandidate({ title: cleanTitle(c.title) || c.title, original: cleanTitle(c.original), year: c.year, type: c.type, confidence: 50 });
        return x;
      }))).filter(Boolean);
      const byId = new Map();
      for (const x of resolved) if (!byId.has(x.id)) byId.set(x.id, x);
      const items = [...byId.values()].slice(0, FIND_MAX_RESULTS);
      await clearWait();
      if (!items.length) { await send(rtl('لقيت ') + latin(person.name) + rtl(' بس ما لقيت أعمال تطابق الفلتر. جرّب بدون سنة أو جنسية.')); return; }
      const tags = [{ movie: 'فلم', series: 'مسلسل', anime: 'أنمي' }[p0.kind] || '', p0.year ? String(p0.year) : '', country ? country[1] || 'AR' : ''].filter(Boolean);
      await showResults(chatId, { items, p: { name, kind: p0.kind, year: p0.year }, raw: argRaw, smart: false, canSmart: false, header: '🎭 أعمال ' + latin(person.name) + (tags.length ? ' (' + tags.join(' · ') + ')' : '') + ' — الأشهر أول:' });
    } catch (e) {
      await clearWait();
      logErr('خطأ بـ /actor', e);
      await send(rtl('⚠️ تعذر جلب أعمال الممثل من TMDB، جرّب بعد شوي.'));
    }
  } catch (e) {
    logErr('خطأ بـ /actor', e);
  }
}

module.exports = {
  init, getPendingEp, setPendingEp, finds, latinDigits, clamp, maskKey, groundingBlockedMin,
  onFindCallback, onSmartCallback, IMAGE_MIMES, onImage, serpKeyCmd, onSerpKeyCmd, actorCmd, onActor,
  parseFind, parseEpisode, onFind, isPlainSearchText, parseQuery, cinemetaSearch, mergeResults,
  nameSim, foldText, osaDistance, jaroWinkler, trigramSim, extractJson, rankItems
};
