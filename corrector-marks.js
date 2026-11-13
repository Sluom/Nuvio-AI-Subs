
'use strict';
const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const LETTER = /[\p{L}\p{N}]/u;
const { EXCLUDE_RAW } = require('./name-book');
const TRANSLATOR_MODE = true;
const NAME_MIN_WRAPS = 2;
const NAME_MIN_RATIO = 0.6;
const NAME_MIN_LEN = 3;
const KNOWN_ENTITIES_RAW = `لندن باريس نيويورك شيكاغو بوسطن ميامي هوليوود طوكيو بكين موسكو روما برلين مدريد فيينا
القاهرة بغداد دمشق بيروت الرياض دبي أبوظبي الدوحة القدس إسطنبول سيدني تورنتو أمستردام برشلونة ميلانو البندقية
أمريكا بريطانيا إنجلترا اسكتلندا أيرلندا فرنسا ألمانيا إيطاليا إسبانيا روسيا الصين اليابان كندا مصر العراق سوريا
لبنان الأردن السعودية الإمارات الكويت قطر المغرب الجزائر تونس ليبيا السودان اليمن فلسطين تركيا إيران الهند
المكسيك البرازيل أستراليا سويسرا السويد النرويج هولندا بلجيكا اليونان كوريا`;
function maskTags(text) {
  const tags = [];
  const masked = String(text).replace(TAG_RE, t => { tags.push(t); return '\uE000' + (tags.length - 1) + '\uE001'; });
  return { masked, tags };
}
const unmaskTags = (text, tags) => text.replace(PH_RE, (_, i) => tags[+i]);
function tidyQuotes(line) {
  line = line.replace(/[“”„«»]/g, '"');
  let out = '', open = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== '"') { out += ch; continue; }
    if (!open) {
      open = true;
      if (LETTER.test(out.slice(-1))) out += ' ';
      out += '"';
      while (line[i + 1] === ' ') i++;
    } else {
      open = false;
      out = out.replace(/ +$/, '') + '"';
      if (LETTER.test(line[i + 1] || '')) out += ' ';
    }
  }
  return { text: out, unclosed: open };
}
function tidyParens(line) {
  return line
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\)([\p{L}\p{N}])/gu, ') $1');
}
const DASH_LEAD = /^[-–—]\s*/;
const stripQ = s => s.replace(/"/g, '').replace(/ {2,}/g, ' ').trim();
function enforceHint(lines, q) {
  const split = lines.map(l => {
    const dm = l.match(DASH_LEAD);
    return { dash: dm ? '- ' : '', body: stripQ(dm ? l.slice(dm[0].length) : l) };
  });
  if (Array.isArray(q)) {
    if (q.length !== split.length) return null;
    return split.map((s, i) => {
      const h = q[i];
      const b = h === 'whole' ? '"' + s.body + '"' : h === 'open' ? '"' + s.body : h === 'close' ? s.body + '"' : s.body;
      return s.dash + b;
    });
  }
  const first = split[0], last = split[split.length - 1];
  if (q === 'whole' || q === 'open') first.body = first.body.replace(/^((?:\uE000\d+\uE001|\s)*)/, '$1"');
  if (q === 'whole' || q === 'close') last.body = last.body.replace(/((?:\uE000\d+\uE001|\s)*)$/, '"$1');
  return split.map(s => s.dash + s.body);
}
function fixMarks(text, q = null) {
  const { masked, tags } = maskTags(text);
  let lines = masked.split('\n');
  if (q) {
    const forced = enforceHint(lines, q);
    if (forced) lines = forced;
  } else {
    lines = lines.map(l => {
      let t = tidyQuotes(l);
      if (t.unclosed || (t.text.match(/"/g) || []).length % 2) t = tidyQuotes(l.replace(/["“”„«»]/g, ''));
      return t.text;
    });
  }
  return unmaskTags(lines.map(tidyParens).map(l => l.replace(/([")])[ \t]+([.…!؟?،؛:,])/g, '$1$2')).join('\n'), tags);
}
const AR_TOKEN = /"([^"\n]*)"|\(([^()\n]*)\)|([\u0621-\u065F\u0670-\u06D3]+)/g;
const ONE_WORD = /^[\u0621-\u065F\u0670-\u06D3]+$/;
const nameKey = w => String(w).replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا');
const KNOWN_ENTITIES = new Set(KNOWN_ENTITIES_RAW.split(/\s+/).filter(Boolean).map(nameKey));
const FALLBACK_NO_BARE = new Set(
  'الله الرب على إلى الى حتى متى لدى سوى عدا سعيد نور امل حياة سلام جميل غالي عزيز حبيب كريم صالح رحمة خير فرح ورد'
    .split(/\s+/).map(nameKey));
const HARD = new Set(EXCLUDE_RAW.split(/\s+/).filter(Boolean).map(nameKey));
function collectNameCandidates(texts, eligible, max = 300, book = null) {
  const seen = new Map();
  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    const { masked } = maskTags(t);
    for (const m of masked.matchAll(AR_TOKEN)) {
      const w = (m[1] != null && ONE_WORD.test(m[1])) ? m[1] : (m[2] != null && ONE_WORD.test(m[2])) ? m[2] : null;
      if (!w) continue;
      const k = nameKey(w);
      if (k.length < NAME_MIN_LEN || KNOWN_ENTITIES.has(k) || seen.has(k)) continue;
      if (book && book.lookup(w)) continue;
      const ex = masked.replace(PH_RE, '').replace(/["()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
      seen.set(k, { w, ex });
    }
  });
  return [...seen.values()].slice(0, max);
}
function propagateNames(texts, eligible, kinds = new Map(), book = null) {
  const st = new Map();
  const get = k => { let o = st.get(k); if (!o) st.set(k, o = { q: 0, p: 0, b: 0 }); return o; };
  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    const { masked } = maskTags(t);
    for (const m of masked.matchAll(AR_TOKEN)) {
      if (m[3]) get(nameKey(m[3])).b++;
      else if (m[1] && ONE_WORD.test(m[1])) get(nameKey(m[1])).q++;
      else if (m[2] && ONE_WORD.test(m[2])) get(nameKey(m[2])).p++;
    }
  });
  const names = new Map(), wrapBare = new Set();
  if (!book) {
    for (const k of KNOWN_ENTITIES) { if (st.has(k)) { names.set(k, 'p'); wrapBare.add(k); } }
  }
  for (const [k, o] of st) {
    if (names.has(k) || k.length < NAME_MIN_LEN) continue;
    if (book && book.lookup(k)) continue;
    const marked = o.q + o.p;
    if (!marked) continue;
    const passes = marked >= NAME_MIN_WRAPS && marked / (marked + o.b) >= NAME_MIN_RATIO && !FALLBACK_NO_BARE.has(k);
    const kind = kinds.get(k);
    if (kind === 'person') { names.set(k, 'q'); if (passes) wrapBare.add(k); }
    else if (kind === 'entity') { names.set(k, 'p'); if (passes) wrapBare.add(k); }
    else if (kind === 'none') { }
    else if (passes) { names.set(k, o.q >= o.p ? 'q' : 'p'); wrapBare.add(k); }
  }
  if (!names.size) return texts;
  const wrap = (w, kind) => (kind === 'q' ? '"' + w + '"' : '(' + w + ')');
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    const { masked, tags } = maskTags(t);
    const updated = masked.replace(AR_TOKEN, (all, q, p, bare) => {
      const marked = (q != null && ONE_WORD.test(q)) ? q : (p != null && ONE_WORD.test(p)) ? p : null;
      const word = bare || marked;
      if (!word) return all;
      const k = nameKey(word);
      const kind = names.get(k);
      if (!kind) return all;
      if (bare && !wrapBare.has(k)) return all;
      return wrap(word, kind);
    });
    return unmaskTags(updated, tags);
  });
}
const ARW = '[\\u0621-\\u065F\\u0670-\\u06D3]+';
const ARW_G = new RegExp(ARW, 'g');
const ARP = ARW + '(?: ' + ARW + '){0,2}';
const QCH = '["\\u201C\\u201D\\u00AB\\u00BB]';
const T_SPAN = new RegExp('(?<![\\p{L}\\p{N}])' + QCH + '(' + ARP + ')[.,\\u060C\\u061B\\u2026!\\u061F?:]{0,3}' + QCH + '(?![\\p{L}\\p{N}])|\\((' + ARP + ')\\)|\\)(' + ARP + ')\\(', 'gu');
function scanTranslator(text) {
  const { masked } = maskTags(text);
  const toks = [...masked.matchAll(ARW_G)].map(m => ({ k: nameKey(m[0]), a: m.index, b: m.index + m[0].length }));
  const flags = new Array(toks.length).fill(0);
  for (const m of masked.matchAll(T_SPAN)) {
    const a = m.index, b = a + m[0].length;
    const inside = [];
    toks.forEach((t, j) => { if (t.a >= a && t.b <= b) inside.push(j); });
    if (!inside.length) continue;
    const code = inside.length > 1 ? 3 : (m[1] != null ? 1 : 2);
    inside.forEach(j => { flags[j] = code; });
  }
  const covered = new Set();
  for (const m of masked.matchAll(T_SPAN)) for (let p = m.index; p < m.index + m[0].length; p++) covered.add(p);
  const stack = [], lone = [];
  for (let p = 0; p < masked.length; p++) {
    if (covered.has(p)) continue;
    const ch = masked[p];
    if (ch === '(') stack.push(p);
    else if (ch === ')') { if (stack.length) stack.pop(); else lone.push(p); }
  }
  lone.push(...stack);
  for (const p of lone) {
    const j = masked[p] === '(' ? toks.findIndex(t => t.a === p + 1) : toks.findIndex(t => t.b === p);
    if (j < 0 || flags[j] !== 0) continue;
    const k = toks[j].k;
    if (k.length < NAME_MIN_LEN || HARD.has(k)) continue;
    flags[j] = 4;
  }
  return { toks, flags };
}
function translatorFlags(orig, fin) {
  const o = scanTranslator(orig);
  const ft = [...maskTags(fin).masked.matchAll(ARW_G)].map(m => nameKey(m[0]));
  if (o.toks.length === ft.length) return o.flags.map((f, j) => (o.toks[j].k === ft[j] ? f : -1));
  if (o.toks.map(t => t.k).join('') !== ft.join('')) return null;
  let pos = 0;
  const spans = o.toks.map(t => { const a = pos; pos += t.k.length; return [a, pos]; });
  pos = 0;
  return ft.map(k => {
    const a = pos, b = pos + k.length; pos = b;
    let f = 0;
    spans.forEach(([x, y], j) => { if (x < b && y > a) f = Math.max(f, o.flags[j]); });
    return f;
  });
}
const PRE_ONLY = /^(?:[وف][بلك]?|[بلك])$/;
const DIAC = /[\u064B-\u065F\u0670\u0640]/;
function splitGluedPrefixes(orig, fin) {
  const o = scanTranslator(orig);
  const { masked, tags } = maskTags(fin);
  const ftoks = [...masked.matchAll(ARW_G)];
  if (o.toks.length === ftoks.length) return fin;
  if (o.toks.map(t => t.k).join('') !== ftoks.map(m => nameKey(m[0])).join('')) return fin;
  const om = maskTags(orig).masked;
  const need = new Set();
  let pos = 0;
  o.toks.forEach((t, j) => {
    if (j > 0 && o.flags[j] >= 1 && o.flags[j] <= 3 && PRE_ONLY.test(o.toks[j - 1].k) && /^["(\u201C\u00AB]$/.test(om.slice(o.toks[j - 1].b, t.a))) need.add(pos);
    pos += t.k.length;
  });
  if (!need.size) return fin;
  let out = '', last = 0, cum = 0;
  for (const m of ftoks) {
    out += masked.slice(last, m.index);
    last = m.index + m[0].length;
    let cnt = 0;
    for (const ch of m[0]) {
      if (!DIAC.test(ch)) {
        if (cnt > 0 && need.has(cum + cnt)) out += ' ';
        cnt++;
      }
      out += ch;
    }
    cum += nameKey(m[0]).length;
  }
  return unmaskTags(out + masked.slice(last), tags);
}
const MADDA_NAMES = new Set('آنا آني آمي آبي آلي آدم آليس آلان آشر آيا آري آدي آرن آلف آلا'.split(' '));
const MADDA_PRE = /^(?:[وف][بلك]?|[بلك])$/;
function maddaSplit(rawTok) {
  const t = rawTok.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  if (MADDA_NAMES.has(t)) return 0;
  for (let n = 1; n <= 2 && n < t.length; n++) {
    if (MADDA_PRE.test(t.slice(0, n)) && MADDA_NAMES.has(t.slice(n))) return n;
  }
  return -1;
}
function wrapMaddaNames(orig, out) {
  if (!/\u0622/.test(orig)) return out;
  const o = scanTranslator(orig);
  const om = maskTags(orig).masked;
  const hits = [];
  let pos = 0;
  [...om.matchAll(ARW_G)].forEach((m, j) => {
    const start = pos;
    pos += o.toks[j].k.length;
    if (!m[0].includes('\u0622')) return;
    if (o.flags[j] !== 0 && o.flags[j] !== 4) return;
    const n = maddaSplit(m[0]);
    if (n < 0) return;
    const nameRaw = m[0].replace(/[\u064B-\u065F\u0670\u0640]/g, '').slice(n);
    hits.push({ ls: start + n, le: start + o.toks[j].k.length, nameRaw });
  });
  if (!hits.length) return out;
  const { masked, tags } = maskTags(out);
  const ftoks = [...masked.matchAll(ARW_G)];
  if (ftoks.map(m => nameKey(m[0])).join('') !== o.toks.map(t => t.k).join('')) return out;
  const posOf = [];
  for (const m of ftoks) {
    for (let c = 0; c < m[0].length; c++) if (!DIAC.test(m[0][c])) posOf.push(m.index + c);
  }
  let res = masked;
  for (const h of hits.sort((a, b) => b.ls - a.ls)) {
    if (h.le <= h.ls || h.le > posOf.length) continue;
    const a = posOf[h.ls];
    let b = posOf[h.le - 1] + 1;
    while (b < res.length && DIAC.test(res[b])) b++;
    const before = res[a - 1] || '', after = res[b] || '';
    if (before === '"' || before === '(' || after === '"' || after === ')') continue;
    res = res.slice(0, a) + (/[\p{L}\p{N}]/u.test(before) ? ' ' : '') + '"' + h.nameRaw + '"' + res.slice(b);
  }
  return unmaskTags(res, tags);
}
function collectNameCandidatesT(texts, eligible, flagsArr, max = 300, book = null) {
  const seen = new Map();
  for (const want of [[1, 2]]) {
    texts.forEach((t, i) => {
      const fl = flagsArr[i];
      if (!eligible[i] || !fl) return;
      const { masked } = maskTags(t);
      [...masked.matchAll(ARW_G)].forEach((m, j) => {
        if (!want.includes(fl[j])) return;
        const w = m[0], k = nameKey(w);
        if (k.length < NAME_MIN_LEN || KNOWN_ENTITIES.has(k) || HARD.has(k) || seen.has(k)) return;
        if (book && book.lookup(w)) return;
        const ex = masked.replace(PH_RE, '').replace(/["()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        seen.set(k, { w, ex });
      });
    });
  }
  return [...seen.values()].slice(0, max);
}
function propagateNamesT(texts, eligible, kinds, book, flagsArr) {
  if (!book) return texts;
  const allowUnwrap = book.complete !== false;
  const tw = new Set();
  texts.forEach((t, i) => {
    const fl = flagsArr[i];
    if (!eligible[i] || !fl) return;
    [...maskTags(t).masked.matchAll(ARW_G)].forEach((m, j) => { if (fl[j] === 1 || fl[j] === 2) tw.add(nameKey(m[0])); });
  });
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    const fl = flagsArr[i];
    const { masked, tags } = maskTags(t);
    let idx = 0;
    const updated = masked.replace(AR_TOKEN, (all, q, p, bare) => {
      const inner = bare != null ? bare : (q != null ? q : p);
      const start = idx;
      idx += (inner.match(ARW_G) || []).length;
      const word = bare || ((q != null && ONE_WORD.test(q)) ? q : (p != null && ONE_WORD.test(p)) ? p : null);
      if (!word || book.lookup(word)) return all;
      const k = nameKey(word);
      const excl = HARD.has(k);
      const kind = kinds.get(k);
      const f = fl ? fl[start] : -1;
      const wordLevel = !excl && k.length >= NAME_MIN_LEN && tw.has(k);
      let t2;
      if (wordLevel && kind === 'person') t2 = 'q';
      else if (wordLevel && kind === 'entity') t2 = 'p';
      else if (f === 1) t2 = 'q';
      else if (f === 2) t2 = (excl || kind === 'person') ? 'q' : 'p';
      else if (f === 0 && allowUnwrap) t2 = null;
      else return all;
      return t2 === null ? word : (t2 === 'q' ? '"' + word + '"' : '(' + word + ')');
    });
    return unmaskTags(updated, tags);
  });
}
const CLASSIFY_BATCH = 80;
const CLASSIFY_CONC = 3;
async function classifyNames(cands, keysArray, modelName, deps) {
  const out = new Map();
  if (!cands || !cands.length) return out;
  const { axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
    normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
    MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent } = deps;
  const model = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const parts = [];
  for (let i = 0; i < cands.length; i += CLASSIFY_BATCH) parts.push(cands.slice(i, i + CLASSIFY_BATCH));
  let nextPart = 0, noKeys = false;
  const tCls = Date.now();
  let okParts = 0;
  const runPart = async part => {
    const prompt = `You will receive a JSON array of Arabic words taken from the subtitles of a film or TV episode: [{"w": "<word>", "ex": "<a line where it appears>"}].
Each word was marked as a possible proper name. Classify each word by how it is used in its line:
- "person": the name of a person, a character, an animal character or a nickname.
- "entity": a city, country, region, place, building, company, brand, institution, organization, school, team, dish, food product or product name.
- "none": not a proper name at all (a common word, a sound cue, an adjective, etc.).
Return ONLY a JSON array: [{"w": "<same word>", "k": "person" | "entity" | "none"}] with one object per input word. No explanations.

Words:
${JSON.stringify(part)}`;
    let partOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const activeKey = await acquireKey(keysArray);
      if (!activeKey) { noKeys = true; return; }
      const cleanKey = String(activeKey).trim();
      try {
        const r = await axios.post(`${DEFAULT_GEMINI_API_URL}/models/${model}:generateContent`, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          safetySettings: SAFETY_SETTINGS_OFF
        }, {
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
          timeout: 60000, httpAgent, httpsAgent, maxContentLength: MAX_AI_RESPONSE_BYTES
        });
        const txt = (r.data?.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('');
        const arr = JSON.parse(txt.replace(/```json|```/g, '').trim());
        for (const it of Array.isArray(arr) ? arr : []) {
          if (it && typeof it.w === 'string' && ['person', 'entity', 'none'].includes(it.k)) out.set(nameKey(it.w), it.k);
        }
        partOk = true;
        break;
      } catch (e) {
        const status = e.response?.status || 0;
        if (isGeminiAuthFailure(e)) { deadKeys.add(activeKey); continue; }
        if (status) keyCooldowns.set(activeKey, Date.now() + cooldownForStatus(status));
        if (attempt < 2) await delay(1500 + Math.random() * 1500);
      }
    }
    if (partOk) okParts++;
    else console.log(`\u200F[تصنيف الأسماء ⚠] دفعة فشلت (${part.length} كلمة)`);
  };
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONC, parts.length) }, async () => {
    while (!noKeys && nextPart < parts.length) await runPart(parts[nextPart++]);
  }));
  console.log(`\u200F[تصنيف الأسماء 🏷] كلمات=${cands.length} | دفعات=${parts.length} | نجحت=${okParts} | فشلت=${parts.length - okParts} | الزمن=${((Date.now() - tCls) / 1000).toFixed(1)} ثانية`);
  return out;
}
module.exports = { fixMarks, propagateNames, collectNameCandidates, classifyNames, nameKey, tidyQuotes, tidyParens, TRANSLATOR_MODE, translatorFlags, splitGluedPrefixes, wrapMaddaNames, collectNameCandidatesT, propagateNamesT };
