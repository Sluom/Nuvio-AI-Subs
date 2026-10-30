
'use strict';
const AR = '\\u0621-\\u065F\\u0670-\\u06D3';
const TOKEN_RE = new RegExp('[' + AR + ']+', 'g');
const INNER_OK = new RegExp('^[' + AR + ' ]+$');
const AR_ONLY = new RegExp('^[' + AR + ' ]+$');
const SPAN_RE = /"([^"\n]*)"|\(([^()\n]*)\)/g;
const GAP_OK = /^[ \t\uE002\uE003]*[ \t][ \t\uE002\uE003]*$/;
const MARK_RE = /[\uE002\uE003]/g;
const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const SMART_MODE = process.env.NAMES_SWAP_ONLY !== '0';
const PERSON_MIN_WRAPS = 2;
const PERSON_MIN_RATIO = 0.6;
const SLICE = 400;
const CONC = 3;
const STRONG_MIN_MARKED = 3;
const STRONG_MIN_RATIO = 0.5;
const DIAC = /[\u064B-\u065F\u0670\u0640]/g;
const bookKey = s => String(s)
  .replace(DIAC, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/\s+/g, ' ').trim();
const rawNorm = s => String(s).replace(DIAC, '');
const TANWEEN_OR_END_SHADDA_YA = /[\u064B-\u064D]|[\u064A\u0649]\u0651$/;
const NOT_NAME_RE = /"([\u0621-\u065F\u0670-\u06D3]+)"|\(([\u0621-\u065F\u0670-\u06D3]+)\)/g;
function stripNotNames(text) {
  return text.replace(NOT_NAME_RE, (all, q, p, off, str) => {
    const w = q != null ? q : p;
    if (TANWEEN_OR_END_SHADDA_YA.test(w)) return w;
    if ((rawNorm(w) === 'أليس' || rawNorm(w) === 'اليس') && /^[ \t]+كذلك/.test(str.slice(off + all.length))) return w;
    return all;
  });
}
const NEVER = new Set(['الله', 'الرب'].map(bookKey));
const FUNC_RAW = new Set(['على', 'إلى', 'الى', 'حتى', 'متى', 'لدى', 'سوى', 'عدا']);
const ALWAYS_AMBIG = new Set(
  'علي نور امل سعيد جميل كريم رحمة حياة سلام امين صالح حسن جمال بدر زهرة ورد عزيز حبيب سيف غالي رائد قمر نجم وسام فرح خير'
    .split(/\s+/).map(bookKey));
const NEVER_STRONG = new Set(
  'سعيد نور امل حياة سلام جميل غالي عزيز حبيب كريم صالح رحمة خير فرح ورد'
    .split(/\s+/).map(bookKey));
const PRONOUNS = new Set('انا انت انتي انتم انتن نحن هو هي هم هن'.split(/\s+/).map(bookKey));
const NO_BARE = new Set([...ALWAYS_AMBIG, ...NEVER_STRONG, ...PRONOUNS]);
const DENY_COMBINED = new Set(
  'وسام بسام بديل بريد فريد وريد بعيد وعيد بخير بفضل بحمد'
    .split(/\s+/).map(bookKey));
const VOC = new Set(
  'يا سيد السيد سيدة السيدة انسة الانسة آنسة الآنسة دكتور الدكتور دكتورة الدكتورة استاذ الاستاذ أستاذ الأستاذ كابتن الكابتن محقق المحقق ضابط الضابط عم العم عمة العمة خال الخال خالة الخالة'
    .split(/\s+/).map(bookKey));
const ENTITY_HEADS = new Set(
  'شركة مدينة دولة نهر جامعة مطعم فندق فريق نادي بنك مطار ميناء مجمع مستشفى جزيرة جبل بحر مملكة امبراطورية وكالة منظمة مؤسسة عائلة ال'
    .split(/\s+/).map(bookKey));
const CTX_BEFORE_AMBIG = new Set(
  'بلا بدون اي بصيص شعاع قمة منتهى حظ عيد عام سنة خبر وقت مكان شيء رجل شخص'
    .split(/\s+/).map(bookKey));
const CTX_AFTER_AMBIG = new Set(
  'جدا حقا للغاية تماما اكثر اقل'
    .split(/\s+/).map(bookKey));
const KNOWN_ENTITIES = `لندن باريس نيويورك شيكاغو بوسطن ميامي هوليوود طوكيو بكين موسكو روما برلين مدريد فيينا
القاهرة بغداد دمشق بيروت الرياض دبي أبوظبي الدوحة القدس إسطنبول سيدني تورنتو أمستردام برشلونة ميلانو البندقية
أمريكا بريطانيا إنجلترا اسكتلندا أيرلندا فرنسا ألمانيا إيطاليا إسبانيا روسيا الصين اليابان كندا مصر العراق سوريا
لبنان الأردن السعودية الإمارات الكويت قطر المغرب الجزائر تونس ليبيا السودان اليمن فلسطين تركيا إيران الهند
المكسيك البرازيل أستراليا سويسرا السويد النرويج هولندا بلجيكا اليونان كوريا`.split(/\s+/).filter(Boolean).map(bookKey);
function maskTags(text) {
  const tags = [];
  const masked = String(text).replace(TAG_RE, t => { tags.push(t); return '\uE000' + (tags.length - 1) + '\uE001'; });
  return { masked, tags };
}
async function callJson(prompt, keysArray, model, d) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const activeKey = await d.acquireKey(keysArray);
    if (!activeKey) return null;
    const key = String(activeKey).trim();
    try {
      const r = await d.axios.post(`${d.DEFAULT_GEMINI_API_URL}/models/${model}:generateContent`, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        safetySettings: d.SAFETY_SETTINGS_OFF
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'x-goog-api-client': d.GEMINI_CLIENT_HEADER },
        timeout: 90000, httpAgent: d.httpAgent, httpsAgent: d.httpsAgent, maxContentLength: d.MAX_AI_RESPONSE_BYTES
      });
      const txt = (r.data?.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('');
      return JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch (e) {
      const status = e.response?.status || 0;
      if (d.isGeminiAuthFailure(e)) { d.deadKeys.add(activeKey); continue; }
      if (status) d.keyCooldowns.set(activeKey, Date.now() + d.cooldownForStatus(status));
      if (attempt < 2) await d.delay(1500 + Math.random() * 1500);
    }
  }
  return null;
}
function namesPrompt(lines, hints) {
  const hintBlock = hints && hints.length
    ? `\nCHARACTER NAMES from the cast database (Latin spelling, reference only; the Arabic spelling in the lines is what counts): ${JSON.stringify(hints.slice(0, 60))}\n`
    : '';
  return `You will receive Arabic subtitle lines from ONE film or TV episode. Extract every proper name that appears in them.
Return ONLY a JSON object: {"persons": [...], "entities": [...], "ambiguous": [...]}
- "persons": names of people, characters, nicknames, animal characters. Only the name itself (no titles like سيد، دكتور، كابتن).
- "entities": cities, countries, regions, landmarks, companies, brands, institutions, organizations, schools, teams, dishes, products.
- "ambiguous": the subset of the two lists above whose spelling is ALSO an ordinary Arabic word (e.g. نور، أمل، سعيد، جميل، ورد), so a program must not wrap every occurrence blindly.
Rules:
1. Write each name EXACTLY as spelled in the lines, without attached prefixes (و ف ب ل ك). Do not translate, do not correct spelling.
2. A full name of 2-3 words is ONE entry. If the first name also appears alone somewhere, list it as its own entry too.
3. Do NOT include: God (الله), titles alone, adjectives, nationalities, common nouns, sound cues, religious terms.
4. Include a name even if it appears only once.
5. No explanations.
${hintBlock}
Lines:
${lines.join('\n')}`;
}
async function runLimited(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; await t(); }
  }));
}
async function buildNameBook(lines, keysArray, modelName, deps, hints = [], conc = CONC) {
  if (!lines || !lines.length) return null;
  const model = deps.normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const votes = new Map();
  const vote = (arr, field) => {
    for (const w of Array.isArray(arr) ? arr : []) {
      if (typeof w !== 'string' || !AR_ONLY.test(w)) continue;
      const k = bookKey(w);
      const words = k.split(' ');
      if (words.length > 3 || k.replace(/ /g, '').length < 3 || NEVER.has(k) || VOC.has(words[0])) continue;
      let o = votes.get(k); if (!o) votes.set(k, o = { p: 0, e: 0, a: 0 });
      o[field]++;
    }
  };
  const tasks = [];
  let okSlices = 0, totalSlices = 0;
  for (let i = 0; i < lines.length; i += SLICE) {
    const part = lines.slice(i, i + SLICE);
    totalSlices++;
    tasks.push(async () => {
      const r = await callJson(namesPrompt(part, hints), keysArray, model, deps);
      if (!r || typeof r !== 'object') return;
      okSlices++;
      vote(r.persons, 'p'); vote(r.entities, 'e'); vote(r.ambiguous, 'a');
    });
  }
  await runLimited(tasks, conc);
  if (!okSlices) return null;
  const map = new Map();
  for (const [k, v] of votes) {
    if (!v.p && !v.e) continue;
    map.set(k, { kind: v.p >= v.e ? 'person' : 'entity', ambig: v.a > 0 || ALWAYS_AMBIG.has(k) });
  }
  for (const k of KNOWN_ENTITIES) map.set(k, { kind: 'entity', ambig: false });
  const book = makeBook(map);
  book.complete = okSlices === totalSlices;
  return book;
}
const PRE_OK = /^(?:[وف][بلك]?|[بلك])$/;
const SHORT_PRE_ALWAYS = new Set(['و', 'ف', 'ل', 'ول', 'فل']);
const SHORT_PRE_UNAMBIG = new Set(['ب', 'وب', 'فب']);
function splits(k) {
  const out = [{ n: 0, pre: '', base: k }];
  for (let n = 1; n <= 2 && n < k.length; n++) {
    const pre = k.slice(0, n);
    if (!PRE_OK.test(pre)) continue;
    const base = k.slice(n);
    out.push({ n, pre, base });
    if (pre.endsWith('ل') && base[0] === 'ل') out.push({ n, pre, base: 'ا' + base });
  }
  return out;
}
function makeBook(map) {
  let strong = new Set();
  function lookupKeys(keys, marked) {
    const rest = keys.slice(1);
    for (const sp of splits(keys[0])) {
      const key = [sp.base, ...rest].join(' ');
      const e = map.get(key);
      if (!e) continue;
      if (sp.n && !marked) {
        if (DENY_COMBINED.has(keys[0])) continue;
        const len = key.replace(/ /g, '').length;
        if (len < 3) continue;
        if (len === 3) {
          const okShort = SHORT_PRE_ALWAYS.has(sp.pre) || (!e.ambig && SHORT_PRE_UNAMBIG.has(sp.pre));
          if (!okShort) continue;
        }
      }
      return { key, e, pre: sp.pre };
    }
    return null;
  }
  function findMatches(s) {
    const prot = [];
    for (const m of s.matchAll(SPAN_RE)) prot.push([m.index, m.index + m[0].length]);
    const unw = [];
    for (const m of s.matchAll(/\uE002[^\uE003]*\uE003/g)) unw.push([m.index, m.index + m[0].length]);
    const inRange = (rs, p) => rs.some(([a, b]) => p >= a && p < b);
    const toks = [...s.matchAll(TOKEN_RE)].map(m => ({ t: m[0], a: m.index, b: m.index + m[0].length, k: bookKey(m[0]) }));
    const out = [];
    for (let i = 0; i < toks.length;) {
      let hit = null;
      if (!inRange(prot, toks[i].a)) {
        for (let n = Math.min(3, toks.length - i); n >= 1 && !hit; n--) {
          let ok = true;
          for (let j = i + 1; j < i + n; j++) {
            if (!GAP_OK.test(s.slice(toks[j - 1].b, toks[j].a)) || inRange(prot, toks[j].a)) { ok = false; break; }
          }
          if (!ok) continue;
          if (n === 1 && FUNC_RAW.has(rawNorm(toks[i].t))) continue;
          const marked = inRange(unw, toks[i].a);
          const r = lookupKeys(toks.slice(i, i + n).map(x => x.k), marked);
          if (!r) continue;
          const prev = toks[i - 1];
          const next = toks[i + n];
          const prevAdj = !!prev && GAP_OK.test(s.slice(prev.b, toks[i].a));
          const nextAdj = !!next && GAP_OK.test(s.slice(toks[i + n - 1].b, next.a));
          const voc = prevAdj && VOC.has(prev.k);
          const badCtx = r.e.ambig && !voc && (
            (prevAdj && CTX_BEFORE_AMBIG.has(prev.k)) ||
            (nextAdj && CTX_AFTER_AMBIG.has(next.k))
          );
          hit = { a: toks[i].a, b: toks[i + n - 1].b, n, key: r.key, e: r.e, marked, voc, badCtx };
        }
      }
      if (hit) { out.push(hit); i += hit.n; } else i++;
    }
    return out;
  }
  function prepare(text) {
    const { masked, tags } = maskTags(text);
    const s = masked.replace(SPAN_RE, (all, q, p) => {
      const inner = q != null ? q : p;
      if (!inner.trim() || !INNER_OK.test(inner)) return all;
      const toks = [...inner.matchAll(TOKEN_RE)].map(m => ({ k: bookKey(m[0]), a: m.index + 1 }));
      if (!toks.length || toks.length > 3) return all;
      const probe = '\uE002' + inner + '\uE003';
      const matches = findMatches(probe);
      if (!matches.length) return all;
      const inMatch = pos => matches.some(m => pos >= m.a && pos < m.b);
      const allValid = toks.every((t, idx) =>
        inMatch(t.a) ||
        (idx === 0 && toks.length >= 2 && ENTITY_HEADS.has(t.k)) ||
        (idx > 0 && idx < toks.length - 1 && t.k === 'و' && matches.length >= 2)
      );
      return allValid ? probe : all;
    });
    return { s, tags };
  }
  const wrap = (x, kind) => (kind === 'person' ? '"' + x + '"' : '(' + x + ')');
  let stats = new Map();
  const allowed = m => {
    if (m.badCtx) return false;
    if (!SMART_MODE) return !m.e.ambig || m.marked || m.voc || strong.has(m.key);
    if (m.marked) return true;
    if (m.e.ambig || NO_BARE.has(m.key)) return false;
    if (m.e.kind === 'entity') return true;
    const o = stats.get(m.key);
    return !!o && o.m >= PERSON_MIN_WRAPS && o.m / (o.m + o.b) >= PERSON_MIN_RATIO;
  };
  function apply(text) {
    const { s, tags } = prepare(String(text));
    let out = '', pos = 0;
    for (const m of findMatches(s)) {
      if (!allowed(m)) continue;
      out += s.slice(pos, m.a) + wrap(s.slice(m.a, m.b).replace(MARK_RE, ''), m.e.kind);
      pos = m.b;
    }
    out += s.slice(pos);
    return stripNotNames(out.replace(MARK_RE, '')).replace(PH_RE, (_, i) => tags[+i]);
  }
  function prime(texts, eligible) {
    const c = new Map();
    texts.forEach((t, i) => {
      if (!eligible[i]) return;
      const { s } = prepare(String(t));
      for (const m of findMatches(s)) {
        if (!m.e.ambig || NEVER_STRONG.has(m.key) || m.badCtx) continue;
        const o = c.get(m.key) || { m: 0, b: 0 };
        if (m.marked || m.voc) o.m++; else o.b++;
        c.set(m.key, o);
      }
    });
    strong = new Set();
    for (const [k, o] of c) if (o.m >= STRONG_MIN_MARKED && o.m / (o.m + o.b) >= STRONG_MIN_RATIO) strong.add(k);
    stats = new Map();
    if (!SMART_MODE) return;
    texts.forEach((t, i) => {
      if (!eligible[i]) return;
      const { s } = prepare(String(t));
      for (const m of findMatches(s)) {
        if (m.e.kind !== 'person') continue;
        const o = stats.get(m.key) || { m: 0, b: 0 };
        if (m.marked) o.m++; else o.b++;
        stats.set(m.key, o);
      }
    });
  }
  const lookup = phrase => {
    const toks = String(phrase).match(TOKEN_RE);
    if (!toks || toks.length > 3) return null;
    const r = lookupKeys(toks.map(bookKey), true);
    return r && r.e;
  };
  return { map, lookup, apply, prime, size: map.size, complete: true, get strong() { return strong; } };
}
function applyNameBook(texts, eligible, book) {
  if (!book || !book.size) return texts;
  book.prime(texts, eligible);
  return texts.map((t, i) => (eligible[i] ? book.apply(t) : t));
}
module.exports = { buildNameBook, applyNameBook, makeBook, bookKey };
