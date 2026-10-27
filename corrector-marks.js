'use strict';
const { isStop, isAmbigCommon } = require('./name-book');
const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const LETTER = /[\p{L}\p{N}]/u;
const NAME_MIN_WRAPS = 2;
const NAME_MIN_RATIO = 0.6;
const NAME_MIN_LEN = 3;
const FREQ_WRAPPED_SKIP = 6;
const KEEP_MIN_MARKED = 6;
const KEEP_MIN_RATIO = 0.6;
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
const exampleLine = masked => masked.replace(PH_RE, '').replace(/["()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
// يجمع الكلمات الملفوفة بتنصيص/أقواس (وكلها مشتبه فيها) مع أمثلة من الحلقة ليحكم عليها المصنّف
function collectNameCandidates(texts, eligible, max = 300, book = null) {
  const info = new Map();
  const items = [];
  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    const { masked } = maskTags(t);
    const toks = [];
    for (const m of masked.matchAll(AR_TOKEN)) {
      let w = null, wrapped = false;
      if (m[3]) w = m[3];
      else if (m[1] != null && ONE_WORD.test(m[1])) { w = m[1]; wrapped = true; }
      else if (m[2] != null && ONE_WORD.test(m[2])) { w = m[2]; wrapped = true; }
      if (!w) continue;
      const k = nameKey(w);
      let o = info.get(k);
      if (!o) info.set(k, o = { w, wrapped: 0, bare: 0 });
      if (wrapped) o.wrapped++; else o.bare++;
      toks.push([k, wrapped]);
    }
    items.push({ line: exampleLine(masked), toks });
  });
  const cands = new Map();
  for (const [k, o] of info) {
    if (!o.wrapped) continue;
    if (k.length < NAME_MIN_LEN || KNOWN_ENTITIES.has(k) || isStop(k)) continue;
    const risky = k.length <= NAME_MIN_LEN || isAmbigCommon(o.w) || !!(book && book.isRisky(o.w));
    if (!risky && o.wrapped >= FREQ_WRAPPED_SKIP) continue;
    cands.set(k, { w: o.w, wrapped: o.wrapped, bare: o.bare, risky, ex: [], exB: [] });
  }
  if (!cands.size) return [];
  for (const it of items) {
    const seen = new Set();
    for (const [k, wrapped] of it.toks) {
      const c = cands.get(k);
      if (!c || seen.has(k)) continue;
      seen.add(k);
      if (wrapped) { if (c.ex.length < 2 && !c.ex.includes(it.line)) c.ex.push(it.line); }
      else if (c.exB.length < 2 && !c.exB.includes(it.line)) c.exB.push(it.line);
    }
  }
  return [...cands.values()]
    .sort((a, b) => (b.risky - a.risky) || (a.wrapped - b.wrapped))
    .slice(0, max)
    .map(c => {
      const ex = [...c.exB, ...c.ex].slice(0, 4);
      return { w: c.w, wrapped: c.wrapped, bare: c.bare, ex };
    });
}
// يطبق حكم المصنّف: يمسح التنصيص عن الكلمات العادية، ويعمّم الأسماء الحقيقية فقط
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
  // كلمة لفّها موديل الأسطر بثبات (6 مرات فأكثر وبنسبة 60%+) لا يُلغى لفّها بحكم "none" وحده
  const keepByEvidence = k => {
    const o = st.get(k);
    if (!o) return false;
    const m = o.q + o.p;
    return m >= KEEP_MIN_MARKED && m / (m + o.b) >= KEEP_MIN_RATIO;
  };
  if (book && kinds) for (const [k, v] of kinds) if (v === 'none' && !keepByEvidence(k)) book.veto(k);
  const names = new Map(), wrapBare = new Set(), drop = new Set();
  if (!book) {
    for (const k of KNOWN_ENTITIES) { if (st.has(k)) { names.set(k, 'p'); wrapBare.add(k); } }
  }
  for (const [k, o] of st) {
    const marked = o.q + o.p;
    if (!marked) continue;
    if (isStop(k)) { drop.add(k); continue; }
    if (names.has(k) || k.length < NAME_MIN_LEN) continue;
    const kind = kinds.get(k);
    if (kind === 'none' && !keepByEvidence(k)) {
      if (!(book && book.lookup(k))) drop.add(k);
      continue;
    }
    if (book && book.lookup(k)) continue;
    const passes = marked >= NAME_MIN_WRAPS && marked / (marked + o.b) >= NAME_MIN_RATIO && !FALLBACK_NO_BARE.has(k) && !isAmbigCommon(k);
    if (kind === 'person') { names.set(k, 'q'); if (passes) wrapBare.add(k); }
    else if (kind === 'entity') { names.set(k, 'p'); if (passes) wrapBare.add(k); }
    else if (passes) { names.set(k, o.q >= o.p ? 'q' : 'p'); wrapBare.add(k); }
  }
  if (!names.size && !drop.size) return texts;
  const wrap = (w, kind) => (kind === 'q' ? '"' + w + '"' : '(' + w + ')');
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    const { masked, tags } = maskTags(t);
    const updated = masked.replace(AR_TOKEN, (all, q, p, bare) => {
      const marked = (q != null && ONE_WORD.test(q)) ? q : (p != null && ONE_WORD.test(p)) ? p : null;
      const word = bare || marked;
      if (!word) return all;
      const k = nameKey(word);
      if (marked && drop.has(k)) return marked;
      const kind = names.get(k);
      if (!kind) return all;
      if (bare && !wrapBare.has(k)) return all;
      return wrap(word, kind);
    });
    return unmaskTags(updated, tags);
  });
}
const CLASSIFY_BATCH = 60;
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
  const runPart = async part => {
    const prompt = `You will receive a JSON array of Arabic words taken from the subtitles of ONE film or TV episode:
[{"w": "<word>", "wrapped": <times a program marked it as a name>, "bare": <times it appears unmarked>, "ex": ["<line where it appears>", ...]}]
A program marked each of these words as a possible proper name, and MANY OF THOSE MARKS ARE MISTAKES. Ordinary Arabic words are often marked by mistake, for example: إليّ / الي (to me), أليس كذلك (isn't it so), بات (became), ليس، حتى، متى، نور، أمل، جميل، سعيد.
Decide what each word is in THESE lines:
- "person": the name of a person, a character, an animal character or a nickname. Choose it only if at least one line clearly uses the word as a name (addressed with يا, introduced with اسمه / اسمها / يدعى, followed by a surname, or clearly a character who acts or is spoken to or about).
- "entity": a city, country, region, place, building, company, brand, institution, organization, school, team, dish, food product or product name.
- "none": an ordinary Arabic word, or any case where the ordinary meaning fits the lines, or you are not sure.
Test: replace the word by its ordinary Arabic meaning. If every line still makes sense, answer "none". If the word is a real name in some lines and ordinary in others, answer "person" or "entity".
Return ONLY a JSON array: [{"w": "<same word>", "k": "person" | "entity" | "none"}] with one object per input word. No explanations.

Words:
${JSON.stringify(part)}`;
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
        break;
      } catch (e) {
        const status = e.response?.status || 0;
        if (isGeminiAuthFailure(e)) { deadKeys.add(activeKey); continue; }
        if (status) keyCooldowns.set(activeKey, Date.now() + cooldownForStatus(status));
        if (attempt < 2) await delay(1500 + Math.random() * 1500);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONC, parts.length) }, async () => {
    while (!noKeys && nextPart < parts.length) await runPart(parts[nextPart++]);
  }));
  return out;
}
module.exports = { fixMarks, propagateNames, collectNameCandidates, classifyNames, nameKey, tidyQuotes, tidyParens };
