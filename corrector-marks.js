// corrector-marks.js
// الفكرة: الموديل يقترح، والكود يقرر ويصلح. هنا كل ما يخص التنصيص والأقواس وعلامات الأسماء.
//
// السياسة (الأولوية من الأعلى للأسفل):
//  1) أسماء الأشخاص = تنصيص " "   |   المدن والدول والشركات والمؤسسات والأكلات = أقواس ( )
//  2) قائمة KNOWN_ENTITIES (مدن ودول معروفة): دائمًا أقواس، بدون أي نقاش مع الموديل. أضف إليها ما تشاء.
//  3) باقي الكلمات التي علّمها الموديل: تُرسل لنداء تصنيف واحد صغير (شخص / جهة أو مكان / ليس اسمًا)
//     ويُطبَّق الجواب على كل الملف. وإن فشل النداء نرجع للأغلبية.
//  4) داخل الأسطر المنقولة (q) لا نلمس الأسماء، لأن القاعدة 7 تمنع التنصيص الداخلي.
//  5) الكود يفرض: لا مسافات داخل العلامات، ولا قبل علامات الترقيم، وتوازن العلامات، وتنصيص مستقيم " فقط.

const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const LETTER = /[\p{L}\p{N}]/u;

const NAME_MIN_WRAPS = 2;      // أقل عدد مرات لُفّ فيها الاسم (تنصيص أو أقواس) حتى نعممه
const NAME_MIN_RATIO = 0.6;    // نسبة المرات الملفوفة من كل ظهور
const NAME_MIN_LEN = 3;

// مدن ودول معروفة: تظهر دائمًا بين أقواس (عدّل القائمة كما تريد)
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

// ينظف سطرًا واحدًا: يوحّد شكل التنصيص، يشيل المسافات الداخلية، ويكشف التنصيص غير المغلق
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

// يفرض تلميح q (محسوب من الأصل): لا تنصيص داخلي إطلاقًا، فقط علامة الحافة المطلوبة
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
  // العلامة تأتي بعد وسوم أول السطر وقبل وسوم آخره
  if (q === 'whole' || q === 'open') first.body = first.body.replace(/^((?:\uE000\d+\uE001|\s)*)/, '$1"');
  if (q === 'whole' || q === 'close') last.body = last.body.replace(/((?:\uE000\d+\uE001|\s)*)$/, '"$1');
  return split.map(s => s.dash + s.body);
}

// نقطة الدخول: تُستدعى على نص السطر النهائي (فواصل \n) بعد cleanCorrectorOutput
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

// ============================================================
// اتساق الأسماء على مستوى الملف كله
// ============================================================
const AR_TOKEN = /"([^"\n]*)"|\(([^()\n]*)\)|([\u0621-\u065F\u0670-\u06D3]+)/g;
const ONE_WORD = /^[\u0621-\u065F\u0670-\u06D3]+$/;
const nameKey = w => w.replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا');
const KNOWN_ENTITIES = new Set(KNOWN_ENTITIES_RAW.split(/\s+/).filter(Boolean).map(nameKey));

// الكلمات المفردة التي علّمها الموديل (تنصيص أو أقواس) وتحتاج تصنيفًا، مع جملة مثال بدون علامات
function collectNameCandidates(texts, eligible, max = 300) {
  const seen = new Map();
  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    for (const m of String(t).matchAll(AR_TOKEN)) {
      const w = (m[1] != null && ONE_WORD.test(m[1])) ? m[1] : (m[2] != null && ONE_WORD.test(m[2])) ? m[2] : null;
      if (!w) continue;
      const k = nameKey(w);
      if (k.length < NAME_MIN_LEN || KNOWN_ENTITIES.has(k) || seen.has(k)) continue;
      const ex = String(t).replace(/<[^>]*>|\{[^}]*\}/g, '').replace(/["()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
      seen.set(k, { w, ex });
    }
  });
  return [...seen.values()].slice(0, max);
}

// texts: النصوص النهائية
// eligible[i]: هل نلمس السطر؟ (عربي ومصحح وليس سطر كلام منقول q ولا رسم)
// kinds: Map(مفتاح الكلمة -> 'person' | 'entity' | 'none') من نداء التصنيف (اختياري)
function propagateNames(texts, eligible, kinds = new Map()) {
  const st = new Map();   // key -> { q, p, b }
  const get = k => { let o = st.get(k); if (!o) st.set(k, o = { q: 0, p: 0, b: 0 }); return o; };

  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    for (const m of String(t).matchAll(AR_TOKEN)) {
      if (m[3]) get(nameKey(m[3])).b++;
      else if (m[1] && ONE_WORD.test(m[1])) get(nameKey(m[1])).q++;
      else if (m[2] && ONE_WORD.test(m[2])) get(nameKey(m[2])).p++;
    }
  });

  // names: key -> 'q' (تنصيص) أو 'p' (أقواس)   |   wrapBare: الكلمات التي نعلّمها أيضًا حيث نسيها الموديل
  const names = new Map(), wrapBare = new Set();
  for (const k of KNOWN_ENTITIES) { if (st.has(k)) { names.set(k, 'p'); wrapBare.add(k); } }

  for (const [k, o] of st) {
    if (names.has(k) || k.length < NAME_MIN_LEN) continue;
    const marked = o.q + o.p;
    if (!marked) continue;
    const passes = marked >= NAME_MIN_WRAPS && marked / (marked + o.b) >= NAME_MIN_RATIO;
    const kind = kinds.get(k);
    if (kind === 'person') { names.set(k, 'q'); if (passes) wrapBare.add(k); }
    else if (kind === 'entity') { names.set(k, 'p'); if (passes) wrapBare.add(k); }
    else if (kind === 'none') { /* ليس اسمًا: لا نلمسه */ }
    else if (passes) { names.set(k, o.q >= o.p ? 'q' : 'p'); wrapBare.add(k); }   // لا تصنيف: الأغلبية
  }
  if (!names.size) return texts;

  const wrap = (w, kind) => (kind === 'q' ? '"' + w + '"' : '(' + w + ')');
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    return String(t).replace(AR_TOKEN, (all, q, p, bare) => {
      const marked = (q != null && ONE_WORD.test(q)) ? q : (p != null && ONE_WORD.test(p)) ? p : null;
      const word = bare || marked;
      if (!word) return all;
      const k = nameKey(word);
      const kind = names.get(k);
      if (!kind) return all;
      if (bare && !wrapBare.has(k)) return all;
      return wrap(word, kind);
    });
  });
}


// ============================================================
// نداء تصنيف صغير: شخص / جهة أو مكان / ليس اسمًا. يُستدعى مرة واحدة لكل ملف (دفعات من 80 كلمة).
// deps: الأدوات الجاهزة من corrector.js (axios, acquireKey, ...) حتى لا نكرر الاستيراد.
// ============================================================
async function classifyNames(cands, keysArray, modelName, deps) {
  const out = new Map();
  if (!cands || !cands.length) return out;
  const { axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
    normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
    MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent } = deps;
  const model = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');

  for (let i = 0; i < cands.length; i += 80) {
    const part = cands.slice(i, i + 80);
    const prompt = `You will receive a JSON array of Arabic words taken from the subtitles of a film or TV episode: [{"w": "<word>", "ex": "<a line where it appears>"}].
Each word was marked as a possible proper name. Classify each word by how it is used in its line:
- "person": the name of a person, a character, an animal character or a nickname.
- "entity": a city, country, region, place, building, company, brand, institution, organization, school, team, dish, food product or product name.
- "none": not a proper name at all (a common word, a sound cue, an adjective, etc.).
Return ONLY a JSON array: [{"w": "<same word>", "k": "person" | "entity" | "none"}] with one object per input word. No explanations.

Words:
${JSON.stringify(part)}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const activeKey = await acquireKey(keysArray);
      if (!activeKey) return out;
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
  }
  return out;
}

module.exports = { fixMarks, propagateNames, collectNameCandidates, classifyNames, nameKey, tidyQuotes, tidyParens };
