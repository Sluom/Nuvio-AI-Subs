'use strict';

const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const LETTER = /[\p{L}\p{N}]/u;
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
const SHADDA_OR_TANWEEN = /[\u064B-\u064D\u0651]/;

const nameKey = w => String(w).replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا');
const KNOWN_ENTITIES = new Set(KNOWN_ENTITIES_RAW.split(/\s+/).filter(Boolean).map(nameKey));

const FALLBACK_NO_BARE = new Set(
  ('الله الرب على إلى الى إلي الي حتى متى لدى سوى عدا أليس اليس ليس بات عاد صار ظل كان ' +
   'سعيد نور امل حياة سلام جميل غالي عزيز حبيب كريم صالح رحمة خير فرح ورد علي مارك بيل توم ' +
   'مي جاك دان فان مات غاب كال قال كام قام خان دار عاش مال بان دام راي الان لان الا ابي امي اخي منه عنه لنا بنا هنا')
    .split(/\s+/).map(nameKey)
);

function collectNameCandidates(texts, eligible, max = 300, book = null) {
  const seen = new Map();
  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    const { masked } = maskTags(t);
    for (const m of masked.matchAll(AR_TOKEN)) {
      const w = (m[1] != null && ONE_WORD.test(m[1])) ? m[1] : (m[2] != null && ONE_WORD.test(m[2])) ? m[2] : null;
      if (!w) continue;
      if (SHADDA_OR_TANWEEN.test(w)) continue;
      const k = nameKey(w);
      if (k.length < NAME_MIN_LEN || KNOWN_ENTITIES.has(k) || seen.has(k)) continue;
      if (FALLBACK_NO_BARE.has(k)) continue;
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
      if (m[3]) {
        if (!SHADDA_OR_TANWEEN.test(m[3])) get(nameKey(m[3])).b++;
      } else if (m[1] && ONE_WORD.test(m[1])) {
        if (!SHADDA_OR_TANWEEN.test(m[1])) get(nameKey(m[1])).q++;
      } else if (m[2] && ONE_WORD.test(m[2])) {
        if (!SHADDA_OR_TANWEEN.test(m[2])) get(nameKey(m[2])).p++;
      }
    }
  });

  const names = new Map(), wrapBare = new Set();
  if (!book) {
    for (const k of KNOWN_ENTITIES) { if (st.has(k)) { names.set(k, 'p'); wrapBare.add(k); } }
  }

  for (const [k, o] of st) {
    if (names.has(k) || k.length < NAME_MIN_LEN) continue;
    if (FALLBACK_NO_BARE.has(k)) continue;
    if (book && book.lookup(k)) continue;
    const marked = o.q + o.p;
    if (!marked) continue;
    const passes = marked >= NAME_MIN_WRAPS && marked / (marked + o.b) >= NAME_MIN_RATIO;
    const kind = kinds.get(k);
    if (kind === 'person') { names.set(k, 'q'); if (passes) wrapBare.add(k); }
    else if (kind === 'entity') { names.set(k, 'p'); if (passes) wrapBare.add(k); }
    else if (kind === 'none') { }
    else if (passes) { names.set(k, o.q >= o.p ? 'q' : 'p'); wrapBare.add(k); }
  }

  if (!names.size) return texts;
  const wrap = (w, kind) => (kind === 'person' ? '"' + w + '"' : '(' + w + ')');
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    const { masked, tags } = maskTags(t);
    const updated = masked.replace(AR_TOKEN, (all, q, p, bare) => {
      const marked = (q != null && ONE_WORD.test(q)) ? q : (p != null && ONE_WORD.test(p)) ? p : null;
      const word = bare || marked;
      if (!word) return all;
      if (SHADDA_OR_TANWEEN.test(word)) return all;
      const k = nameKey(word);
      const kind = names.get(k);
      if (!kind) return all;
      if (bare && !wrapBare.has(k)) return all;
      return wrap(word, kind);
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

  const runPart = async part => {
    const prompt = `You will receive a JSON array of Arabic words taken from the subtitles of a film or TV episode: [{"w": "<word>", "ex": "<a line where it appears>"}].
Each word was marked as a possible proper name. Classify each word by how it is used in its line:
- "person": the name of a person, a character, an animal character or a nickname.
- "entity": a city, country, region, place, building, company, brand, institution, organization, school, team, dish, food product or product name.
- "none": not a proper name at all (a common word, a sound cue, an adjective, a verb like بات or مات, a question word like أليس, a preposition like إليّ).
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
          if (it && typeof it.w === 'string' && ['person', 'entity', 'none'].includes(it.k)) {
            const k = nameKey(it.w);
            if (!FALLBACK_NO_BARE.has(k)) out.set(k, it.k);
          }
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
