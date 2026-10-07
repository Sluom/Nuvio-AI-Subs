const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const { applyVocativeRules } = require('./genderRules');
const { getTmdbCast } = require('./tmdb'); 
const { getAnilistCast } = require('./anilist'); 
const db = require('./db');

let nlp, genderDetect;
try {
  nlp = require('compromise');
  genderDetect = require('gender-detection');
} catch (e) {
  console.log("[تنبيه] مكتبات (compromise) أو (gender-detection) غير منصبة. تعمل الترجمة بدون التحليل المحلي.");
}

let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const ASS_DEFAULT_HEADER = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'Collisions: Normal',
  'PlayDepth: 0',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,26,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ''
].join('\n');

const DEFAULT_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CLIENT_HEADER = 'stremio-submaker/1.4.94';
const MAX_AI_RESPONSE_BYTES = 20 * 1024 * 1024;

const MAX_MISSING_RETRIES = 3;
const MAX_RETRY_PASSES = 4;

const ENABLE_GENDER_ANALYSIS = true;

// تقسيم سطر الترجمة الطويل إلى سطرين متوازنين (0 = تعطيل)
const TRANSLATION_WRAP_AT = 42;
const WRAP_MIN_PART = 8;

// true = احذف أسطر الرسم (m ... l ...) من ملف ASS النهائي لأن المشغّل يعرضها كأرقام
// false = أبقِها حرفيًا كما في الملف الأصلي
const DROP_DRAWINGS = true;
const DRAWING_RE = /\{[^}]*\\p0*[1-9][^}]*\}/;   // سطر رسم vector في ASS: {\p1} ... {\p0}

const ANNOTATION_MODEL = String(process.env.ANNOTATION_MODEL || '').trim();
const ANNOTATION_BUDGET_MS = 75000;
const ANNOTATION_SLICE_SIZE = 200;
const ANNOTATION_OVERLAP = 8;
const ANNOTATION_MAX_CONCURRENCY = 8;
const ANNOTATION_REQUEST_TIMEOUT_MS = 60000;
const ANNOTATION_ATTEMPTS = 3;
const ANNOTATION_TEMPERATURE = 0.1;
const SCENE_BREAK_SECONDS = 4;
const RESCUE_CONTEXT = 10;
const RESCUE_MAX_ASK = 80;
const RESCUE_MAX_SPAN = 250;

const ROSTER_ENABLED = process.env.ROSTER_PASS !== '0';
const VERIFY_RUN_MIN = 6;
const VERIFY_MAX_REQUESTS = 6;
const VERIFY_CONTEXT = 10;

const REGISTRY_BUDGET_MS = 30000;
const REGISTRY_MAX_CHARS = 250000;
const REGISTRY_MAX_CHARACTERS = 60;

const CONTEXT_LINES = 4;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// عرض الزمن بالثواني بدل الملي ثانية في اللوغ
const secs = ms => `${(ms / 1000).toFixed(1)} ثانية`;

const keyCooldowns = new Map();
const deadKeys = new Set();
let currentKeyIndex = 0;
let annotationModelBroken = false;

function normalizeGeminiModelId(m) {
  return String(m || '').trim().replace(/^models\//, '');
}

function isGemini3Model(m) {
  const id = normalizeGeminiModelId(m).toLowerCase();
  if (id.startsWith('gemini-3')) return true;
  if (id === 'gemini-flash-latest' || id === 'gemini-flash-lite-latest' || id === 'gemini-pro-latest') return true;
  return false;
}

function getFallbackOutputTokenLimit(model) {
  const n = normalizeGeminiModelId(model).toLowerCase();
  if (n.includes('2.0') || n.includes('-flash-001') || n.includes('-flash-lite-001')) return 8192;
  if (n.includes('2.5') || isGemini3Model(n)) return 65536;
  return 8192;
}

function isGeminiAuthFailure(e) {
  const s = e?.response?.status;
  if (s === 401 || s === 403) return true;
  if (s !== 400) return false;
  const msg = String(e?.response?.data?.error?.message || '').toLowerCase();
  return msg.includes('api key') && (msg.includes('invalid') || msg.includes('not valid') || msg.includes('permission'));
}

function isGeminiConfigError(e) {
  const s = e?.response?.status;
  if (s === 404) return true;
  if (s !== 400) return false;
  const msg = String(e?.response?.data?.error?.message || '').toLowerCase();
  return /thinking|thought|model|unsupported|not supported|not found/.test(msg);
}

function getDynamicChunkSize(modelName) {
  const limit = getFallbackOutputTokenLimit(modelName);
  const safetyMargin = Math.floor(limit * 0.05);
  const available = limit - safetyMargin;
  if (available >= 60000) return 280;
  if (available >= 30000) return 100;
  return 80;
}

function aliveKeyCount(keysArray) {
  return (keysArray || []).filter(k => !deadKeys.has(k)).length;
}

async function acquireKey(keysArray, maxWaitMs = Infinity) {
  if (!keysArray || keysArray.length === 0) return null;
  while (true) {
    const now = Date.now();
    for (let i = 0; i < keysArray.length; i++) {
      const key = keysArray[currentKeyIndex % keysArray.length];
      currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
      if (deadKeys.has(key)) continue;
      if ((keyCooldowns.get(key) || 0) <= now) return key;
    }
    let bestTime = Infinity;
    for (const k of keysArray) {
      if (!deadKeys.has(k)) bestTime = Math.min(bestTime, keyCooldowns.get(k) || 0);
    }
    if (bestTime === Infinity) return null;
    const wait = bestTime - now;
    if (wait > maxWaitMs) return null;
    if (wait > 0) {
      console.log(`[تبريد جماعي] كل المفاتيح الحية بالتبريد. انتظار ${Math.ceil(wait / 1000)}s...`);
      await delay(wait + (Math.random() * 3000));
    }
  }
}

function cooldownForStatus(status) {
  if (status === 503 || status === 500 || status === 502) return 3000 + Math.random() * 2000;
  if (status === 429) return 60000;
  if (status === 400) return 10000;
  if (status === 0) return 2000;
  return 60000;
}

function shortErr(e) {
  const m = e?.response?.data?.error?.message || e?.message || '';
  return String(m).replace(/\s+/g, ' ').slice(0, 140);
}

function fixArabicEncoding(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    try { return Buffer.from(iconv.decode(buffer, 'utf16-le'), 'utf-8'); } catch (e) {}
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try { return Buffer.from(iconv.decode(buffer, 'utf16-be'), 'utf-8'); } catch (e) {}
  }
  const utf8Text = buffer.toString('utf-8');
  const badCount = (utf8Text.match(/\uFFFD/g) || []).length;
  if (badCount === 0) return buffer;
  const arCount = (utf8Text.match(/[\u0600-\u06FF]/g) || []).length;
  if (arCount > badCount * 3) return buffer;
  try {
    const decodedWin = iconv.decode(buffer, 'windows-1256');
    const winAr = (decodedWin.match(/[\u0600-\u06FF]/g) || []).length;
    if (winAr > arCount) return Buffer.from(decodedWin, 'utf-8');
  } catch (e) {}
  try {
    const decodedIso = iconv.decode(buffer, 'iso-8859-6');
    if (/[\u0600-\u06FF]/.test(decodedIso)) return Buffer.from(decodedIso, 'utf-8');
  } catch (e) {}
  return buffer;
}

function srtTimeToAss(t) {
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return '0:00:00.00';
  const h = parseInt(m[1], 10);
  const cs = Math.floor(parseInt(m[4], 10) / 10).toString().padStart(2, '0');
  return `${h}:${m[2]}:${m[3]}.${cs}`;
}

function extractCuesUniversal(text) {
  const assLines = text.split(/\r?\n/).filter(l => /^Dialogue:/i.test(l.trim()));
  if (assLines.length > 0) {
    const cues = [];
    for (const line of assLines) {
      const m = line.match(/^Dialogue:\s*[^,]*,([^,]*),([^,]*),(?:[^,]*,){6}(.*)$/i);
      if (m) cues.push({ start: m[1].trim(), end: m[2].trim(), text: m[3] });
    }
    if (cues.length) return cues;
  }
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length);
    if (lines.length < 2) continue;
    let idx = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const tm = (lines[idx] || '').match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const text2 = lines.slice(idx + 1).join('\\N');
    if (text2.trim()) cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

function normalizeLineBreakArtifacts(txt) {
  if (!txt) return txt;
  return String(txt)
    .replace(/\\"/g, '"')
    .replace(/\\\\n/gi, '\n')
    .replace(/\\\\N/g, '\n')
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\r/g, '');
}

// يقسم سطرًا عربيًا واحدًا طويلًا إلى سطرين متوازنين.
// لا يقسم: الأسطر المتعددة، أسطر الحوار بالشارطة، الأسطر الموضعية (\pos \an ...)،
// ولا يقطع داخل اسم بين تنصيص أو أقواس قصيرة، ولا داخل الوسوم.
function wrapLongSubtitleLine(text) {
  const t = String(text == null ? '' : text);
  if (!(TRANSLATION_WRAP_AT > 0) || t.includes('\n')) return t;
  if (/^\s*(?:\{[^}]*\}|<[^>]*>)*\s*[-–—]/.test(t)) return t;
  if (/\{[^}]*\\(?:pos|move|an\d|org|i?clip|p\d)/i.test(t)) return t;

  // مواضع محمية: اسم قصير بين تنصيص أو أقواس (حتى 3 فراغات) لا يُقطع
  const prot = new Uint8Array(t.length);
  t.replace(/"[^"“”]{1,40}"|“[^“”]{1,40}”|\([^()]{1,40}\)/g, (m, off) => {
    if ((m.match(/ /g) || []).length <= 3) for (let k = off; k < off + m.length; k++) prot[k] = 1;
    return m;
  });

  let inTag = '', vis = 0;
  const cands = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inTag) { if (ch === inTag) inTag = ''; continue; }
    if (ch === '{') { inTag = '}'; continue; }
    if (ch === '<') { inTag = '>'; continue; }
    if (ch === ' ' && !prot[i]) cands.push({ idx: i, left: vis });
    vis++;
  }
  if (vis <= TRANSLATION_WRAP_AT) return t;

  let best = null, bestDiff = Infinity;
  for (const c of cands) {
    const right = vis - c.left - 1;
    if (c.left < WRAP_MIN_PART || right < WRAP_MIN_PART) continue;
    const diff = Math.abs(c.left - right);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  if (!best) return t;

  let a = t.slice(0, best.idx).trimEnd();
  let b = t.slice(best.idx + 1).trimStart();
  // وسم HTML مفتوح قبل الكسر (مثل <i>) نغلقه في السطر الأول ونعيد فتحه في الثاني
  for (const tg of ['i', 'b', 'u']) {
    const op = (a.match(new RegExp('<' + tg + '>', 'gi')) || []).length;
    const cl = (a.match(new RegExp('</' + tg + '>', 'gi')) || []).length;
    if (op > cl) { a += '</' + tg + '>'; b = '<' + tg + '>' + b; }
  }
  return a + '\n' + b;
}

function parseRobustJsonArray(raw, expectedLength) {
  if (!raw) return null;
  let clean = raw.trim();
  if (clean.startsWith('```json')) clean = clean.substring(7);
  else if (clean.startsWith('```')) clean = clean.substring(3);
  if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);
  clean = clean.trim();

  try {
    const parsed = JSON.parse(clean);
    let arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
    if (Array.isArray(arr) && arr.length === expectedLength) {
      return arr.map(x => {
        let txt = String(x || '').replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
        return normalizeLineBreakArtifacts(txt).trim();
      });
    }
  } catch (e) {
    const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
    if (stringMatches.length === expectedLength) {
      return stringMatches.filter(s => s !== 'translations' && s !== 'data').map(s => normalizeLineBreakArtifacts(s).replace(/âTM./gi, '♪').trim());
    }
  }
  return null;
}

function parseIdTranslations(raw) {
  if (!raw) return null;
  let clean = String(raw).trim();
  if (clean.startsWith('```json')) clean = clean.substring(7);
  else if (clean.startsWith('```')) clean = clean.substring(3);
  if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);
  clean = clean.trim();

  const map = new Map();
  const fix = s => normalizeLineBreakArtifacts(
    String(s == null ? '' : s).replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪')
  ).trim();

  try {
    const parsed = JSON.parse(clean);
    const arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o === 'object' && o.id !== undefined) {
          const id = Number(o.id);
          const t = fix(o.text);
          if (Number.isInteger(id) && t) map.set(id, t);
        }
      }
    }
    if (map.size) return map;
  } catch (e) {}

  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    let t;
    try { t = JSON.parse('"' + m[2] + '"'); } catch (e) { t = m[2]; }
    t = fix(t);
    if (t) map.set(Number(m[1]), t);
  }
  return map.size ? map : null;
}

async function runConcurrentPool(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try { results[current] = await tasks[current](); }
      catch (err) {
        console.log(`[Pool] مهمة ${current + 1}/${tasks.length} فشلت: ${err && err.message}`);
        results[current] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildChunkContext(cues, chunk) {
  if (!chunk || !chunk.length) return { before: [], after: [] };
  const first = chunk[0].id;
  const last = chunk[chunk.length - 1].id;
  const grab = (from, to) => {
    const out = [];
    for (let i = Math.max(0, from); i < Math.min(cues.length, to); i++) {
      const t = cleanForAnalysis(cues[i].text);
      if (t) out.push(t);
    }
    return out;
  };
  return {
    before: grab(first - CONTEXT_LINES, first),
    after: grab(last + 1, last + 1 + CONTEXT_LINES)
  };
}

async function translateChunkStrict(items, keysArray, modelName, castPromptBlock = '', ctx = null) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const isGemini3 = isGemini3Model(cleanModel);
  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };
  if (isGemini3) { generationConfig.thinkingConfig = { thinkingLevel: 'minimal' }; }

  const ctxBlock = ctx && (ctx.before.length || ctx.after.length)
    ? `
15. CONTEXT (READ-ONLY): The lines below are NOT part of the content to translate. Use them ONLY to understand sentences that continue across entries, who is speaking, and references to people/places/objects.
   - NEVER translate, modify, or output any context line.
   - Do NOT apply any formatting rule (parentheses, quotation marks, brackets, narration quotes) to context lines.
context_before: ${JSON.stringify(ctx.before)}
context_after: ${JSON.stringify(ctx.after)}
`
    : '';

  const prompt = `You will receive a JSON array of subtitle entries. Each entry is an object: {"id": <number>, "text": "<subtitle text>"} and may also include "g": a hint code.
"g" = two letters: the first letter is the SPEAKER's gender, the second letter is the gender of the person being ADDRESSED. If the entry holds several speaker turns (lines starting with "-"), "g" has one two-letter code per turn, separated by "/", in the same order as the turns (for example "FM/MF"): apply each code only to its own turn. M = male, F = female, G = group or mixed, U = unknown, N = none. Never output "g".
Translate the "text" of every entry to Arabic while:
1. Returning a JSON array of objects in the exact same shape: [{"id": <same number>, "text": "<Arabic translation>"}].
   - Return exactly ONE object for EVERY input id, using the SAME id. Never merge entries, never split an entry, never skip an entry, never invent ids.
   - Keep each translation inside its own id, even if a sentence continues in the next entry.
2. If an entry contains multiple lines separated by a real line break, the translation must contain the exact same number of lines, in the same order, separated by a real line break only, within the JSON string value.
3. Preserving any formatting tags or special characters.
4. Any text wrapped entirely in square brackets [ ] represents on-screen text or action tags. Translate it accurately and strictly keep the square brackets in the Arabic output.
5. Wrap place names, city names, country names, food/dish names, brand names, and other foreign proper nouns (non-person) in Arabic parentheses: (الاسم).
6. Wrap person names (character names) in Arabic quotation marks: "الاسم" — quotation marks are reserved for person names only, never for places/food/brands.
7. When an entire entry is off-screen narration, a voice-over, a letter being read aloud, or a voice heard through a phone/radio/TV with no visible speaker on screen, wrap the WHOLE entry in ONE single pair of quotation marks (one at the start, one at the end). Do not add internal quotes for names if the whole entry is already quoted.
8. GENDER ENFORCEMENT & NEUTRALITY: Arabic requires gendered grammar (verbs, adjectives, pronouns, vocatives) for I/me/my/you/your and for anyone referred to. When an entry has "g", use it to pick the correct Arabic gender for the speaker (first letter) and the person addressed (second letter). Treat "g" as a strong hint, but if the text itself clearly contradicts it (explicit names, titles, "he said"/"she said"), trust the text. When "g" is missing or a letter is U or N, infer gender from the dialogue context in this chunk; if it is still impossible to determine, formulate the Arabic to be naturally GENDER-NEUTRAL (passive voice or verbal nouns) instead of guessing.
9. Pay close attention to split sentences (sentences that start in one entry and continue into the next, often indicated by "..."). Ensure the Arabic grammar and phrasing flow logically and seamlessly across these sequential entries, while still keeping each entry's translation under its own id.
10. Act as an expert cinematic subtitler. Translate idioms/slang naturally into Arabic rather than literally.
=== CINEMATIC CONSTITUTION (CRITICAL RULES) ===
11. RELIGIOUS EXCLAMATIONS: Translate words like 'Jesus', 'Christ', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a person's name.
12. EPILOGUES & LONG TEXTS: Never ignore, skip, or summarize long blocks of on-screen text. Translate them completely and accurately.
13. FOREIGN LANGUAGES: If dialogue is in a third language or has a tag (e.g., [speaks Spanish]), translate BOTH the tag and the actual meaning entirely into Arabic (e.g., [يتحدث الإسبانية] يا صديقي). Leave NO English or foreign text behind.
14. PROFANITY: Translate swear words into standard cinematic Arabic equivalents without literal awkwardness.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}${ctxBlock}
Do NOT overthink. Do NOT overplan.
Do NOT include acknowledgements, explanations, notes or alternative translations.
Output ONLY A VALID JSON ARRAY OF OBJECTS {"id","text"}, nothing else.
Content to translate:
${JSON.stringify(items)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const activeKey = await acquireKey(keysArray);
    if (!activeKey) return { status: 'no_keys', map: new Map() };

    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;

    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
        ]
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: 60000,
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const responseText = parts.map(p => p?.text || '').join('');
      const map = parseIdTranslations(responseText);

      if (map) {
        const allowedIds = new Set(items.map(i => i.id));
        let extraIds = 0;
        for (const id of map.keys()) if (!allowedIds.has(id)) extraIds++;
        if (extraIds > Math.max(3, Math.floor(items.length * 0.02))) {
          console.log(`[حارس الأرقام] الرد فيه ${extraIds} رقم ما طلبته (من ${items.length}). أرفضه.`);
          return { status: 'bad_ids', map: new Map() };
        }
        if (items.length >= 80) console.log(`[Success] chunk ${items.length} via ...${cleanKey.slice(-4)} (${map.size} رجعت)`);
        return { status: 'ok', map };
      }

      return { status: 'bad_format', map: new Map() };

    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status}) ${shortErr(e)}`);
        continue;
      }

      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s (status:${status}) ${shortErr(e)}`);

      if (attempt < 3) {
        const backoffDelay = 2000 + (Math.random() * 2000);
        await delay(backoffDelay);
      }
    }
  }
  return { status: 'api_exhausted', map: new Map() };
}

async function translateItemsWithRecovery(items, keysArray, modelName, castPromptBlock = '', ctx = null) {
  const done = new Map();
  if (!items || items.length === 0) return done;

  let pending = items;

  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    const result = await translateChunkStrict(pending, keysArray, modelName, castPromptBlock, ctx);

    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ] السيرفرات مختنقة. تم تجاوز (${pending.length}) سطر للحفاظ على تزامن الفلم.`);
      break;
    }

    if ((result.status === 'bad_ids' || result.status === 'bad_format') && pending.length > 60) {
      const mid = Math.ceil(pending.length / 2);
      console.log(`[حارس الأرقام] أقسم الدفعة (${pending.length}) لنصفين وأعيد.`);
      const left = await translateItemsWithRecovery(pending.slice(0, mid), keysArray, modelName, castPromptBlock, ctx);
      const right = await translateItemsWithRecovery(pending.slice(mid), keysArray, modelName, castPromptBlock, ctx);
      for (const [id, text] of left) done.set(id, text);
      for (const [id, text] of right) done.set(id, text);
      pending = pending.filter(it => !done.has(it.id));
      break;
    }

    if (result.status === 'ok') {
      const wanted = new Set(pending.map(it => it.id));
      for (const [id, text] of result.map) {
        if (wanted.has(id) && text) done.set(id, text);
      }
    }

    const before = pending.length;
    pending = pending.filter(it => !done.has(it.id));

    if (pending.length > 0 && round < MAX_MISSING_RETRIES) {
      console.log(`[إعادة الناقص 🔁] ناقص ${pending.length} من ${before}. أعيد طلبهم فقط...`);
    }
  }

  if (pending.length > 0) {
    console.log(`[تجاوز سطر] ${pending.length} سطر بقوا بنصهم الأصلي للحفاظ على التزامن.`);
  }
  return done;
}

const subTextCache = new Map();
const SUB_CACHE_TTL = 30 * 60 * 1000;
const SUB_CACHE_MAX = 60;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function safeDecode(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }

function zipEpisodeOf(name) {
  const base = String(name).split(/[\\/]/).pop();
  const m = base.match(/s(\d{1,2})[ ._-]*e(\d{1,4})/i);
  return m ? Number(m[2]) : null;
}

function zipNameHasEpisode(name, episode) {
  const base = String(name).split(/[\\/]/).pop();
  const sxe = zipEpisodeOf(base);
  if (sxe != null) return sxe === Number(episode);
  const clean = base.replace(/(?:480|576|720|1080|2160)[pi]|[xh]\.?26[45]|\b(?:19|20)\d{2}\b/gi, ' ');
  return new RegExp(`(?<![0-9])0*${Number(episode)}(?![0-9])`).test(clean);
}

async function fetchAndExtractSub(subUrl, subsourceKey = '', epInfo = null) {
  const decodedUrl = safeDecode(subUrl);
  const memKey = decodedUrl + '#' + (epInfo ? epInfo.episode : '');
  const hit = subTextCache.get(memKey);
  if (hit && Date.now() - hit.time < SUB_CACHE_TTL) return hit.text;

  const ssKey = String(subsourceKey || '').trim();
  const isOsOrg = /^https?:\/\/dl\.opensubtitles\.org\//i.test(decodedUrl);
  const isSubsource = /^https?:\/\/api\.subsource\.net\//i.test(decodedUrl);
  const isSubdl = /^https?:\/\/dl\.subdl\.com\//i.test(decodedUrl);
  const agents = isOsOrg ? ['VLSub 0.10.3', 'TemporaryUserAgent'] : [BROWSER_UA, 'Mozilla/5.0'];

  let response = null;
  let lastErr = null;
  for (let i = 0; i < agents.length; i++) {
    const ua = agents[i];
    const headers = isOsOrg
      ? { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': '*/*' }
      : { 'User-Agent': ua, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' };
    if (isSubdl) headers['Referer'] = 'https://subdl.com/';
    if (isSubsource && ssKey) headers['X-API-Key'] = ssKey;
    try {
      response = await axios.get(decodedUrl, { responseType: 'arraybuffer', timeout: 15000, headers });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const st = e.response?.status || e.code || 'ERR';
      console.log(`[Download] ${st} (${ua.slice(0, 18)}) <- ${decodedUrl}`);
      if (!(e.response?.status === 403 && i < agents.length - 1)) break;
    }
  }
  if (!response) throw lastErr;

  let buffer = Buffer.from(response.data);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    const cands = zip.getEntries().filter(e => !e.isDirectory && /\.(srt|ass|ssa)$/i.test(e.entryName));
    let entry = cands[0];
    if (epInfo && epInfo.episode != null) {
      if (cands.length > 1) {
        entry = cands.find(e => zipNameHasEpisode(e.entryName, epInfo.episode));
        if (!entry) throw new Error(`الـ ZIP فيه ${cands.length} ملف ولا يوجد ملف للحلقة ${epInfo.episode}`);
      } else if (entry && zipEpisodeOf(entry.entryName) != null && !zipNameHasEpisode(entry.entryName, epInfo.episode)) {
        throw new Error(`ملف الـ ZIP (${entry.entryName}) ليس للحلقة ${epInfo.episode}`);
      }
    }
    console.log(`[ZIP] ${cands.length} ملف | المختار: ${entry ? entry.entryName : 'لا شيء'}`);
    if (entry) buffer = entry.getData();
  }
  const text = fixArabicEncoding(buffer).toString('utf-8');
  subTextCache.set(memKey, { time: Date.now(), text });
  if (subTextCache.size > SUB_CACHE_MAX) subTextCache.delete(subTextCache.keys().next().value);
  return text;
}

function prepCueText(t) {
  if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) return `[${t}]`;
  return t;
}

const lineCaches = new Map();
const MAX_LINE_CACHES = 40;
const hydratedMaps = new WeakSet();

function getLineCache(key) {
  if (!lineCaches.has(key)) {
    lineCaches.set(key, new Map());
    if (lineCaches.size > MAX_LINE_CACHES) lineCaches.delete(lineCaches.keys().next().value);
  }
  return lineCaches.get(key);
}

async function loadLineCache(key) {
  const cache = getLineCache(key);
  if (!hydratedMaps.has(cache)) {
    hydratedMaps.add(cache);
    const stored = await db.loadMap('line', key);
    let restored = 0;
    for (const [id, text] of stored) {
      if (!cache.has(id)) { cache.set(id, text); restored++; }
    }
    if (restored > 0) console.log(`[MongoDB] استرجعت ${restored} سطر من كاش الأسطر الدائم.`);
  }
  return cache;
}

function needsTranslation(text) {
  const raw = String(text || '');
  // سطر رسم vector في ASS ({\p1} ... {\p0}): ليس نصًا ولا يُترجم
  if (DRAWING_RE.test(raw)) return false;
  const t = raw.replace(/<[^>]*>|\{[^}]*\}|\\N|\\n/g, '');
  return /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(t);
}

const annotationCaches = new Map();
const MAX_ANNOTATION_CACHES = 40;

function getAnnotationCache(key) {
  if (!annotationCaches.has(key)) {
    annotationCaches.set(key, new Map());
    if (annotationCaches.size > MAX_ANNOTATION_CACHES) annotationCaches.delete(annotationCaches.keys().next().value);
  }
  return annotationCaches.get(key);
}

async function loadAnnotationCache(key) {
  const cache = getAnnotationCache(key);
  if (!hydratedMaps.has(cache)) {
    hydratedMaps.add(cache);
    const stored = await db.loadMap('annot', key);
    let restored = 0;
    for (const [id, code] of stored) {
      if (!cache.has(id)) { cache.set(id, code); restored++; }
    }
    if (restored > 0) console.log(`[MongoDB] استرجعت ${restored} كود تحليل ضمائر من التخزين الدائم.`);
  }
  return cache;
}

const ENGLISH_PRONOUNS = /\b(i|i'm|i've|i'll|i'd|me|my|myself|you|you're|you've|you'll|your|yours|yourself|we|us|our|he|she|him|her|his)\b/i;

const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
];

async function callGeminiText({ prompt, keysArray, modelName, generationConfig, timeout = 120000, attempts = 4, deadline = Infinity, stopOn429 = false }) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 2000) return { status: 'deadline', text: '' };
    const activeKey = await acquireKey(keysArray, remaining);
    if (!activeKey) return { status: 'no_keys', text: '' };
    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;
    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: SAFETY_SETTINGS_OFF
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: Math.min(timeout, Math.max(deadline - Date.now(), 2000)),
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      return {
        status: 'ok',
        text: parts.map(p => p?.text || '').join(''),
        finishReason: r.data?.candidates?.[0]?.finishReason || '',
        blockReason: r.data?.promptFeedback?.blockReason || ''
      };
    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status}) ${shortErr(e)}`);
        continue;
      }
      if (isGeminiConfigError(e)) {
        console.log(`[إعداد موديل] ${cleanModel} (status:${status}) ${shortErr(e)}`);
        return { status: 'config_error', text: '' };
      }
      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s (status:${status}) ${shortErr(e)}`);
      if (status === 429 && stopOn429) return { status: 'rate_limited', text: '' };
      if (attempt < attempts - 1) await delay(1000 + Math.random() * 1000);
    }
  }
  return { status: 'api_exhausted', text: '' };
}

function cleanForAnalysis(t) {
  return String(t || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isVocativeName(text, name) {
  const n = escapeRe(name).replace(/\s+/g, '\\s+');
  const start = new RegExp(`^\\W*(?:(?:hey|oh|ok|okay|look|listen|please|yes|no|well|come on)\\s*,?\\s+)?${n}\\s*[,!?:]`, 'i');
  const end = new RegExp(`,\\s*${n}\\s*[.!?…"]*\\s*$`, 'i');
  return start.test(String(text || '')) || end.test(String(text || ''));
}

function assTimeToSec(t) {
  const m = String(t || '').match(/(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseFloat('0.' + m[4]);
}

function fmtClock(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function splitTurns(rawText) {
  const lines = String(rawText || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .split(/\\N|\\n|\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [lines.join(' ')];
  const isDash = l => /^[-–—]/.test(l);
  const dashCount = lines.filter(isDash).length;
  if (dashCount === 0) return [lines.join(' ')];
  if (dashCount === 1 && isDash(lines[0])) return [lines.join(' ')];
  const turns = [];
  for (const l of lines) {
    if (isDash(l) || turns.length === 0) turns.push(l);
    else turns[turns.length - 1] += ' ' + l;
  }
  return turns;
}

function buildAnnotationItems(cues) {
  const items = [];
  const turnsById = new Map();
  let prevEnd = null;
  cues.forEach((c, i) => {
    const s = assTimeToSec(c.start);
    const e = assTimeToSec(c.end);
    if (needsTranslation(c.text)) {
      const turns = splitTurns(c.text);
      const text = turns.join(' ⏎ ');
      if (text.trim()) {
        const it = { id: i, t: fmtClock(s), text };
        if (prevEnd != null && s != null && s - prevEnd > SCENE_BREAK_SECONDS) it.b = 1;
        if (turns.length > 1) it.turns = turns.length;
        items.push(it);
        turnsById.set(i, turns.length);
      }
    }
    if (e != null) prevEnd = e;
  });
  return { items, turnsById };
}

function parseAnnotationCodes(raw) {
  const map = new Map();
  if (!raw) return map;
  const re = /(\d+)\s*[:=]\s*([MFGUN]{2}(?:\s*\/\s*[MFGUN]{2})*)(?![A-Za-z0-9])/gi;
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    map.set(Number(m[1]), m[2].toUpperCase().replace(/\s+/g, ''));
  }
  if (map.size > 0) return map;
  try {
    const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(clean);
    const arr = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([k, v]) => ({ id: k, code: v }));
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      const code = String(o.code ?? o.codes ?? o.g ?? '').toUpperCase().replace(/\s+/g, '');
      const id = Number(o.id);
      if (Number.isInteger(id) && /^[MFGUN]{2}(?:\/[MFGUN]{2})*$/.test(code)) map.set(id, code);
    }
  } catch (e) {}
  return map;
}

function normalizeCode(raw, turns) {
  if (!raw) return null;
  const segs = String(raw).toUpperCase().split('/').map(s => s.trim());
  if (segs.length !== (turns || 1)) return null;
  if (!segs.every(s => /^[MFGUN]{2}$/.test(s))) return null;
  return segs.join('/');
}

function mergeCodes(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const b = String(base).split('/');
  const e = String(extra).split('/');
  if (b.length !== e.length) return base;
  return b.map((seg, i) => {
    let out = '';
    for (let k = 0; k < 2; k++) {
      out += (seg[k] === 'U' && e[i][k] && e[i][k] !== 'U') ? e[i][k] : seg[k];
    }
    return out;
  }).join('/');
}

function makeCoreRanges(n, size) {
  const ranges = [];
  let start = 0;
  while (start < n) {
    let end = Math.min(n, start + size);
    if (n - end < Math.floor(size / 3)) end = n;
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

function annotationConfig(model, baseModel) {
  const cfg = { temperature: ANNOTATION_TEMPERATURE, responseMimeType: 'application/json' };
  if (isGemini3Model(model)) cfg.thinkingConfig = { thinkingLevel: model === baseModel ? 'minimal' : 'low' };
  return cfg;
}

function buildAnnotationPrompt(windowItems, mode, castPromptBlock) {
  const scope = mode === 'verify'
    ? `Answer ONLY for items with "ask":1. Every other item is read-only context. "p" is the code an earlier pass gave. That pass said that ALL the "ask" lines are spoken between two women (FF). This is unusual, so check it carefully: work out who the two sides of this conversation are (names, forms of address, the other lines of the scene), and remember that the two sides can be a woman and a man. Do not assume the earlier pass is right or wrong. Use U for a side you cannot justify.`
    : mode === 'rescue'
    ? `Answer ONLY for items with "ask":1. Every other item is read-only context. "p" is the code an earlier, less careful pass gave (U = that side was not decided). "p" codes on context items are usually right: use them as evidence about who is in the conversation. For "ask" items, re-read the surrounding lines carefully before answering U.`
    : `Items with "ctx":1 are read-only context from the neighbouring parts of the story: never answer for them. Answer for every other item.`;

  return `You will receive consecutive subtitle lines from ONE film or episode, in story order, as a JSON array of objects {"id": <number>, "t": "<m:ss start time>", "text": "<subtitle text>"}.
Optional fields: "b":1 = a pause of several seconds before this line (often a new scene or a change of speakers); "turns": N = the text holds N speaker turns separated by "⏎"; "ctx":1 = read-only context; "p" = code from an earlier pass; "ask":1 = answer this item.
The subtitles can be in ANY language. Read the story first.
For each item you must answer, work out WHO IS SPEAKING and WHO IS BEING ADDRESSED, and output only their genders.
Codes: M = male, F = female, G = group or mixed, U = unknown, N = none (narration, on-screen text, sound effects, or the person talks to themselves or to the audience).
Answer with TWO letters per line: first the speaker's gender, then the addressee's gender. "FM" = a woman speaking to a man, "MG" = a man speaking to a group, "UU" = cannot tell.
If an item has "turns": N, give N codes separated by "/", one per turn in order (each turn usually starts with "-"), for example "FM/MF".
Evidence to use:
- names, titles and forms of address (sir, ma'am, mother, king, senhora, señor...), and who was just spoken to
- grammatical gender inside the line itself, in languages where adjectives and participles agree with the speaker or the listener (for example Portuguese "obrigada" = a woman is speaking, "obrigado" = a man; "cansada"/"cansado"; Spanish "estoy cansada"; French "je suis fatiguée"; Russian "я устала" / "я устал")
- "he said" / "she said", the alternation of replies in a conversation, and pauses
Use the whole conversation, not only the single line. If you are not reasonably sure about one side, answer U for that side. Do not guess randomly.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}
${scope}
Output ONLY a valid JSON array of strings, exactly one string per item you must answer, in the same order, each formatted "<id>:<codes>", for example ["12:UU","13:FM","14:MF/FM"]. No explanations.
Lines:
${JSON.stringify(windowItems)}`;
}

async function callAnnotationLLM({ prompt, keysArray, modelName, deadline, timeout = ANNOTATION_REQUEST_TIMEOUT_MS, attempts = ANNOTATION_ATTEMPTS, stopOn429 = false }) {
  const baseModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  let model = (!annotationModelBroken && ANNOTATION_MODEL) ? normalizeGeminiModelId(ANNOTATION_MODEL) : baseModel;
  const call = m => callGeminiText({
    prompt, keysArray, modelName: m, generationConfig: annotationConfig(m, baseModel),
    timeout, attempts, deadline, stopOn429
  });
  let res = await call(model);
  if (res.status === 'config_error' && model !== baseModel) {
    annotationModelBroken = true;
    console.log(`[تحليل الضمائر] موديل التحليل (${model}) غير صالح. أرجع لموديل الترجمة (${baseModel}) لباقي الطلبات.`);
    model = baseModel;
    res = await call(model);
  }
  return { res, model };
}

async function annotateWindow({ windowItems, mode, keysArray, modelName, deadline, label, castPromptBlock, depth = 0, state = null }) {
  if (state && state.aborted) return new Map();
  const prompt = buildAnnotationPrompt(windowItems, mode, castPromptBlock);
  const t0 = Date.now();
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline, stopOn429: !!state });

  if (res.status === 'rate_limited') {
    if (state) state.aborted = true;
    console.log(`[تحليل الضمائر] ${label}: 429 (حصة الموديل). أوقف باقي الطلبات الاختيارية.`);
    return new Map();
  }
  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${label}: فشل (${res.status}) بعد ${secs(Date.now() - t0)}.`);
    return new Map();
  }
  const map = parseAnnotationCodes(res.text);
  console.log(`[تحليل الضمائر] ${label}: رجع ${map.size} كود من ${windowItems.length} سطر في ${secs(Date.now() - t0)} (${model}).`);

  if (map.size === 0) {
    const head = String(res.text || '').replace(/\s+/g, ' ').slice(0, 100);
    console.log(`[تحليل الضمائر] ${label}: ما رجع أي كود (finish=${res.finishReason || '-'} block=${res.blockReason || '-'}) الرد: "${head}"`);
    const isAnswer = it => ((mode === 'rescue' || mode === 'verify') ? !!it.ask : !it.ctx);
    const answerable = windowItems.filter(isAnswer);
    if (depth < 1 && answerable.length >= 20 && deadline - Date.now() > 4000) {
      const half = Math.floor(answerable.length / 2);
      const keepA = new Set(answerable.slice(0, half).map(it => it.id));
      const keepB = new Set(answerable.slice(half).map(it => it.id));
      const demote = keep => windowItems.map(it => {
        if (!isAnswer(it) || keep.has(it.id)) return it;
        const o = { ...it };
        delete o.ask;
        o.ctx = 1;
        return o;
      });
      console.log(`[تحليل الضمائر] ${label}: أقسم الطلب لنصفين وأعيده.`);
      const common = { mode, keysArray, modelName, deadline, castPromptBlock, depth: depth + 1, state };
      const [mA, mB] = await Promise.all([
        annotateWindow({ ...common, windowItems: demote(keepA), label: `${label} (نصف 1)` }),
        annotateWindow({ ...common, windowItems: demote(keepB), label: `${label} (نصف 2)` })
      ]);
      return new Map([...mA, ...mB]);
    }
  }
  return map;
}

function buildRosterPrompt(windowItems, castPromptBlock) {
  return `You will receive consecutive subtitle lines from ONE film or episode, in story order, as a JSON array of objects {"id": <number>, "t": "<m:ss start time>", "text": "<subtitle text>"}.
Optional fields: "b":1 = a pause of several seconds before this line (often a new scene or a change of speakers); "turns": N = the text holds N speaker turns separated by "⏎"; "ctx":1 = read-only context from the neighbouring parts of the story.
The subtitles can be in ANY language. Read the story first.
STEP 1 - PEOPLE: list every person who speaks or is spoken to in the lines that are not "ctx". For each person give "id" ("P1", "P2", ...), "name" (the name used in the subtitles or in the known characters list below; if the person is never named, a short description such as "woman in black" or "waiter"), and "gender" ("M", "F", or "U" only if the story really does not show it). A person has ONE gender, valid for every line. If a person is a known character from the list below, use that name and that gender.
STEP 2 - LINES: for every line that is not "ctx", say who speaks and who is addressed, using the person ids: "<id>:<speaker>><addressee>".
- Use "G" for a group or mixed audience, "N" for none (narration, on-screen text, sound effects, songs, or talking to oneself), and "?" when you cannot tell.
- If an item has "turns": N, give N pairs separated by "/", one per turn in order (each turn usually starts with "-"), for example "14:P1>P2/P2>P1".
Evidence to use: names, titles and forms of address, who was just spoken to, the alternation of replies (in a conversation between two people the speakers alternate and each one is the addressee of the other, and the two can be a woman and a man), pauses ("b":1), "he said" / "she said", and grammatical gender inside the line (for example Portuguese "obrigada" = a woman is speaking, "obrigado" = a man; Spanish "estoy cansada"; French "je suis fatiguée"; Russian "я устала"). Do not guess randomly: use "?" or "U" when unsure.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}
Output ONLY valid JSON: {"people":[{"id":"P1","name":"Harry","gender":"M"}],"lines":["12:P1>P2","13:P2>P1","14:N>N"]}
Lines:
${JSON.stringify(windowItems)}`;
}

function parseRosterResponse(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(clean); }
  catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { parsed = JSON.parse(clean.slice(a, b + 1)); } catch (e2) {} }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const people = new Map();
  for (const p of (Array.isArray(parsed.people) ? parsed.people : [])) {
    if (!p || p.id == null) continue;
    const id = String(p.id).trim().toUpperCase();
    let g = String(p.gender || 'U').trim().toUpperCase();
    if (g !== 'M' && g !== 'F') g = 'U';
    people.set(id, { id, name: String(p.name || '').trim().slice(0, 60), gender: g });
  }
  people.nameIndex = new Map([...people.values()].filter(p => p.name).map(p => [normName(p.name), p]));
  const lines = new Map();
  for (const s of (Array.isArray(parsed.lines) ? parsed.lines : [])) {
    const m = String(s).match(/^\s*(\d+)\s*[:=]\s*(.+?)\s*$/);
    if (m) lines.set(Number(m[1]), m[2]);
  }
  return { people, lines };
}

function lookupRegistry(name, index) {
  if (!index || !index.size) return null;
  const k = normName(name);
  if (!k) return null;
  let ent = index.map.get(k);
  if (ent) return ent;
  const noTitle = k.split(' ').filter(w => !HONORIFICS.has(w.replace(/\.$/, ''))).join(' ');
  ent = noTitle ? index.map.get(noTitle) : null;
  if (ent) return ent;
  const words = String(name).trim().split(/\s+/);
  if (!words.every(w => /^\p{Lu}/u.test(w))) return null;
  for (const w of noTitle.split(' ')) {
    if (w.length >= 3 && !ALIAS_STOP.has(w) && !HONORIFICS.has(w)) {
      const e = index.map.get(w);
      if (e) return e;
    }
  }
  return null;
}

function fixRosterGenders(people, index, stats) {
  if (!index || !index.size) return;
  for (const p of people.values()) {
    const ent = lookupRegistry(p.name, index);
    if (!ent) continue;
    if (ent.tier === 'cast') {
      if (p.gender !== ent.gender) {
        if (p.gender === 'U') stats.filled++; else stats.changed++;
        p.gender = ent.gender;
      }
    } else if (p.gender === 'U') {
      p.gender = ent.gender;
      stats.filled++;
    }
  }
}

function rosterLetter(token, people) {
  const t = String(token || '').trim().toUpperCase();
  if (t === 'G') return 'G';
  if (t === 'N') return 'N';
  const p = people.get(t) || (people.nameIndex && people.nameIndex.get(normName(token)));
  return p ? p.gender : 'U';
}

function deriveRosterCode(spec, turns, people) {
  const segs = String(spec).split('/');
  if (segs.length !== (turns || 1)) return null;
  const out = [];
  for (const seg of segs) {
    const parts = seg.split('>');
    if (parts.length !== 2) return null;
    const s = parts[0].trim().toUpperCase();
    const a = parts[1].trim().toUpperCase();
    const sl = rosterLetter(s, people);
    let al = rosterLetter(a, people);
    if (s === a && people.has(s)) al = 'N';
    out.push(sl + al);
  }
  return out.join('/');
}

async function annotateRosterWindow({ windowItems, keysArray, modelName, deadline, label, castPromptBlock, regIndex, turnsById, rosterStats }) {
  const prompt = buildRosterPrompt(windowItems, castPromptBlock);
  const t0 = Date.now();
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline });
  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${label}: فشل (${res.status}) بعد ${secs(Date.now() - t0)}.`);
    return null;
  }
  const parsed = parseRosterResponse(res.text);
  if (!parsed || parsed.lines.size === 0) {
    const head = String(res.text || '').replace(/\s+/g, ' ').slice(0, 100);
    console.log(`[تحليل الضمائر] ${label}: ما رجع جدول صالح (finish=${res.finishReason || '-'} block=${res.blockReason || '-'}) الرد: "${head}"`);
    return null;
  }
  fixRosterGenders(parsed.people, regIndex, rosterStats);
  const map = new Map();
  for (const [id, spec] of parsed.lines) {
    const turns = turnsById.get(id);
    if (!turns) continue;
    const code = deriveRosterCode(spec, turns, parsed.people);
    if (code) map.set(id, code);
  }
  rosterStats.slices++;
  rosterStats.people += parsed.people.size;
  console.log(`[تحليل الضمائر] ${label}: ${parsed.people.size} شخص | ${map.size} كود من ${windowItems.length} سطر في ${secs(Date.now() - t0)} (${model}).`);
  if (process.env.GENDER_DEBUG === '1') {
    console.log(`[مشهد] ${label}: ` + [...parsed.people.values()].slice(0, 40).map(p => `${p.id}=${p.name || '?'}(${p.gender})`).join(', '));
  }
  return map;
}

const isFFcode = c => !!c && c.split('/').every(seg => seg === 'FF');
function findFFRuns(items, codeOf, minLen) {
  const runs = [];
  let cur = [];
  let ff = 0;
  const flush = () => {
    while (cur.length && !isFFcode(codeOf(cur[cur.length - 1].id))) cur.pop();
    if (ff >= minLen && cur.length) runs.push({ items: cur.slice(), ff });
    cur = [];
    ff = 0;
  };
  for (const it of items) {
    const c = codeOf(it.id);
    if (it.b === 1 && cur.length) flush();
    if (isFFcode(c)) { cur.push(it); ff++; }
    else if (c && /[MG]/.test(c)) flush();
    else if (cur.length) cur.push(it);
  }
  flush();
  return runs;
}

const registryCaches = new Map();
const MAX_REGISTRY_CACHES = 40;

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mister', 'dr', 'doctor', 'sir', 'lord', 'lady', 'madam', 'dame',
  'father', 'mother', 'brother', 'sister', 'king', 'queen', 'prince', 'princess', 'captain', 'officer', 'detective',
  'sr', 'sra', 'srta', 'senhor', 'senhora', 'señor', 'señora', 'monsieur', 'madame', 'mademoiselle', 'herr', 'frau',
  'signor', 'signora', 'don', 'dona', 'dom']);
const ALIAS_STOP = new Set(['may', 'will', 'can', 'you', 'the', 'and', 'but', 'mom', 'dad', 'man', 'boy', 'girl', 'guy', 'boss', 'baby']);

const INTERJECTIONS = 'hey|hi|hello|oh|ok|okay|look|listen|please|yes|no|well|come on|thanks|thank you|sorry|olá|oi|ei|ouça|escuta|olha|vamos|obrigado|obrigada|sim|não|hola|oye|mira|oiga|gracias|sí|salut|écoute|regarde|merci|oui|non|ciao|ehi|senti|guarda|grazie|sì|hallo|hör|sieh|danke|ja|nein';
const INTRO_PHRASES = "i'm|i am|my name is|eu sou|meu nome é|me chamo|soy|me llamo|mi nombre es|je suis|je m'appelle|sono|mi chiamo|ich bin|ich heiße|mein name ist";

function normName(s) {
  return String(s || '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function startsCapital(s) {
  const c = String(s || '')[0] || '';
  return c !== c.toLowerCase() || (c === c.toUpperCase() && c === c.toLowerCase());
}

function parseCastEntries(castPromptBlock) {
  const out = [];
  for (const l of String(castPromptBlock || '').split('\n')) {
    const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
    if (m) out.push({ name: m[1].trim(), gender: m[2].toUpperCase(), tier: 'cast', aliases: [] });
  }
  return out;
}

function parseRegistry(raw) {
  if (!raw) return [];
  const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(clean); }
  catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { parsed = JSON.parse(clean.slice(a, b + 1)); } catch (e2) {} }
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.characters) ? parsed.characters : []);
  const out = [];
  for (const c of arr) {
    if (!c || typeof c.name !== 'string') continue;
    const g = String(c.gender || '').toUpperCase();
    if (g !== 'M' && g !== 'F') continue;
    const name = c.name.trim();
    if (name.length < 2 || name.length > 40) continue;
    const aliases = (Array.isArray(c.aliases) ? c.aliases : [])
      .filter(a => typeof a === 'string').map(a => a.trim()).filter(a => a.length >= 2 && a.length <= 40).slice(0, 8);
    out.push({ name, gender: g, aliases });
    if (out.length >= REGISTRY_MAX_CHARACTERS) break;
  }
  return out;
}

async function getCharacterRegistry(cues, keysArray, modelName, cacheKey, castPromptBlock) {
  if (registryCaches.has(cacheKey)) return registryCaches.get(cacheKey);

  const stored = await db.loadDoc('registry', cacheKey);
  if (Array.isArray(stored) && stored.length > 0) {
    registryCaches.set(cacheKey, stored);
    if (registryCaches.size > MAX_REGISTRY_CACHES) registryCaches.delete(registryCaches.keys().next().value);
    console.log(`[سجل الشخصيات] ${stored.length} شخصية من التخزين الدائم.`);
    return stored;
  }

  const lines = [];
  for (const c of cues) {
    if (!needsTranslation(c.text)) continue;
    const t = splitTurns(c.text).join(' ⏎ ').trim();
    if (t) lines.push(t);
  }
  if (lines.length < 20) return [];
  let body = lines.join('\n');
  if (body.length > REGISTRY_MAX_CHARS) body = body.slice(0, REGISTRY_MAX_CHARS);

  const prompt = `You will receive ALL the subtitle lines of one film or episode, in order (any language). A line may hold several speaker turns separated by "⏎".
Build a list of the CHARACTERS whose gender is clear from the story.
For each character give: "name" (the main name exactly as written in the subtitles), "aliases" (other names, nicknames, surnames or titles used to call or mention the same person, exactly as written in the subtitles), and "gender" ("M" or "F").
Rules:
- Include a character only if the story makes the gender clear (pronouns, titles, descriptions, forms of address, grammatical gender). Do not guess from the name alone.
- Only people or personified characters: no places, groups, brands or generic words.
- At most ${REGISTRY_MAX_CHARACTERS} characters, the most important first.
${castPromptBlock ? '\nA database list of known characters follows. Use it to match nicknames to known characters, and reuse the same name for them:\n' + castPromptBlock + '\n' : ''}
Output ONLY valid JSON: {"characters":[{"name":"...","aliases":["..."],"gender":"M"}]}
Subtitles:
${body}`;

  const t0 = Date.now();
  const deadline = Date.now() + REGISTRY_BUDGET_MS;
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline, timeout: REGISTRY_BUDGET_MS, attempts: 2 });
  if (res.status !== 'ok') {
    console.log(`[سجل الشخصيات] فشل (${res.status}) بعد ${secs(Date.now() - t0)}.`);
    return [];
  }
  const registry = parseRegistry(res.text);
  console.log(`[سجل الشخصيات] ${registry.length} شخصية من الملف كامل في ${secs(Date.now() - t0)} (${model}).`);
  if (registry.length > 0) {
    registryCaches.set(cacheKey, registry);
    if (registryCaches.size > MAX_REGISTRY_CACHES) registryCaches.delete(registryCaches.keys().next().value);
    db.saveDoc('registry', cacheKey, registry);
  }
  return registry;
}

function buildRegistryIndex(castPromptBlock, registry) {
  const entries = parseCastEntries(castPromptBlock);
  const castByKey = new Map(entries.map(e => [normName(e.name), e]));
  let fileCount = 0;
  for (const r of registry || []) {
    const hit = castByKey.get(normName(r.name)) || (r.aliases || []).map(a => castByKey.get(normName(a))).find(Boolean);
    if (hit) {
      if (hit.gender === r.gender) hit.aliases.push(r.name, ...(r.aliases || []));
      continue;
    }
    entries.push({ name: r.name, gender: r.gender, tier: 'file', aliases: r.aliases || [] });
    fileCount++;
  }

  const votes = new Map();
  const add = (key, gender, tier) => {
    if (!key || key.length < 3) return;
    const cur = votes.get(key);
    if (!cur) { votes.set(key, { gender, tier }); return; }
    if (cur.gender !== gender) cur.ambiguous = true;
    else if (tier === 'cast') cur.tier = 'cast';
  };
  for (const e of entries) {
    for (const n of [e.name, ...e.aliases]) {
      const k = normName(n);
      add(k, e.gender, e.tier);
      const noTitle = k.split(' ').filter(w => !HONORIFICS.has(w.replace(/\.$/, ''))).join(' ');
      if (noTitle && noTitle !== k) add(noTitle, e.gender, e.tier);
      for (const w of noTitle.split(' ')) {
        if (w.length >= 3 && !ALIAS_STOP.has(w) && !HONORIFICS.has(w)) add(w, e.gender, e.tier);
      }
    }
  }
  const map = new Map();
  for (const [k, v] of votes) if (!v.ambiguous) map.set(k, v);

  const index = { map, size: map.size, entries, castCount: entries.length - fileCount, fileCount, startRe: null, endRe: null, introRe: null, labelRe: null };
  if (!map.size) return index;

  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const alt = keys.map(k => escapeRe(k).replace(/ /g, '\\s+')).join('|');
  const L = '[^\\p{L}\\p{N}]';
  index.startRe = new RegExp(`^${L}*(?:(?:${INTERJECTIONS})\\s*,?\\s+)?(${alt})\\s*[,!]`, 'iu');
  index.endRe = new RegExp(`,\\s*(${alt})\\s*[.!?…"]*\\s*$`, 'iu');
  index.introRe = new RegExp(`(?<![\\p{L}\\p{N}'])(?:${INTRO_PHRASES})\\s+(${alt})(?=\\s*(?:[.,!?…]|$))`, 'iu');
  index.labelRe = new RegExp(`^${L}*(${alt})[\\]\\)]?\\s*:\\s`, 'iu');
  return index;
}

function registryPromptBlock(index) {
  if (!index) return '';
  const lines = index.entries
    .filter(e => e.tier === 'file')
    .slice(0, REGISTRY_MAX_CHARACTERS)
    .map(e => `${e.name}${e.aliases.length ? ' (also called: ' + e.aliases.slice(0, 4).join(', ') + ')' : ''} = ${e.gender}`);
  if (!lines.length) return '';
  return 'CHARACTERS INFERRED FROM THE WHOLE SUBTITLE FILE (M = male, F = female; inferred by reading the whole story, may contain mistakes; the context of the line overrides them):\n' + lines.join('\n');
}

function registryEvidenceForCue(rawText, index) {
  if (!index || !index.size) return null;
  const turns = splitTurns(rawText).map(t => String(t).replace(/[’‘`]/g, "'"));
  let any = false;
  const ev = turns.map(t => {
    const e = {};
    let hit = null;
    let m = index.startRe.exec(t);
    if (m) hit = m[1];
    else {
      m = index.endRe.exec(t);
      if (m && !/\b(?:it'?s|it is|this is|that'?s|i'?m|i am)\s+me\s*$/i.test(t.slice(0, m.index))) hit = m[1];
    }
    if (hit && startsCapital(hit)) {
      const ent = index.map.get(normName(hit));
      if (ent) { e.a = ent.gender; e.aT = ent.tier; any = true; }
    }
    const mi = index.introRe.exec(t) || index.labelRe.exec(t);
    if (mi && startsCapital(mi[1])) {
      const ent = index.map.get(normName(mi[1]));
      if (ent) { e.s = ent.gender; e.sT = ent.tier; any = true; }
    }
    return e;
  });
  return any ? ev : null;
}

function applyEvidence(code, ev, stats) {
  const segs = String(code).split('/');
  if (!ev || segs.length !== ev.length) return code;
  const pin = (cur, val, tier) => {
    if (!val) return cur;
    if (tier === 'cast') {
      if (cur === val) return cur;
      if (cur === 'U' || cur === 'N') stats.filled++; else stats.overridden++;
      return val;
    }
    if (cur === 'U') { stats.filled++; return val; }
    return cur;
  };
  return segs.map((seg, i) => {
    const e = ev[i] || {};
    return pin(seg[0], e.s, e.sT) + pin(seg[1], e.a, e.aT);
  }).join('/');
}

async function getAnnotations(cues, keysArray, modelName, cacheKey, deadline, castPromptBlock = '', evidence = new Map(), regIndex = null) {
  const cache = await loadAnnotationCache(cacheKey);
  const tStart = Date.now();

  const { items, turnsById } = buildAnnotationItems(cues);
  const posById = new Map(items.map((it, i) => [it.id, i]));
  const pending = items.filter(it => !cache.has(it.id));
  const coded = new Map();
  const defaultCode = id => Array(turnsById.get(id) || 1).fill('UU').join('/');
  const conc = Math.max(1, Math.min(aliveKeyCount(keysArray), ANNOTATION_MAX_CONCURRENCY));
  const evStats = { overridden: 0, filled: 0 };
  const rosterStats = { changed: 0, filled: 0, people: 0, slices: 0, fallbacks: 0 };
  const optState = { aborted: false };
  const applyAllEvidence = () => {
    for (const it of pending) {
      const ev = evidence.get(it.id);
      if (!ev) continue;
      const base = coded.get(it.id) || defaultCode(it.id);
      const next = applyEvidence(base, ev, evStats);
      if (next !== base) coded.set(it.id, next);
    }
  }
  const windowFor = (fromPos, toPos, askSet) => items.slice(fromPos, toPos).map(it => {
    const o = { ...it };
    const p = coded.get(it.id) || cache.get(it.id);
    if (p) o.p = p;
    if (askSet.has(it.id)) o.ask = 1; else o.ctx = 1;
    return o;
  });

  if (pending.length > 0) {
    const ranges = makeCoreRanges(items.length, ANNOTATION_SLICE_SIZE);
    const tasks = [];
    ranges.forEach(([a, b], ri) => {
      const core = items.slice(a, b);
      if (core.every(it => cache.has(it.id))) return;
      const from = Math.max(0, a - ANNOTATION_OVERLAP);
      const to = Math.min(items.length, b + ANNOTATION_OVERLAP);
      const windowItems = items.slice(from, to).map((it, k) => ((from + k < a || from + k >= b) ? { ...it, ctx: 1 } : it));
      tasks.push(async () => {
        const need = core.filter(it => !cache.has(it.id));
        let map = null;
        if (ROSTER_ENABLED) {
          map = await annotateRosterWindow({
            windowItems, keysArray, modelName, deadline, castPromptBlock, regIndex, turnsById, rosterStats,
            label: `جولة 1 (مشهد) شريحة ${ri + 1}/${ranges.length}`
          });
        }
        const covered = map ? need.filter(it => map.has(it.id)).length : 0;
        if (!map || covered < need.length * 0.5) {
          rosterStats.fallbacks++;
          const lm = await annotateWindow({
            windowItems, mode: 'main', keysArray, modelName, deadline, castPromptBlock,
            label: `جولة 1 (حروف) شريحة ${ri + 1}/${ranges.length}`
          });
          map = new Map([...lm, ...(map || [])]);
        }
        for (const it of core) {
          if (cache.has(it.id)) continue;
          const c = normalizeCode(map.get(it.id), turnsById.get(it.id));
          if (c) coded.set(it.id, c);
        }
      });
    });
    console.log(`[تحليل الضمائر] ${items.length} سطر بالتسلسل (من ${cues.length}) | ${tasks.length} طلب (تزامن ${Math.min(conc, tasks.length)}، مفاتيح حية ${aliveKeyCount(keysArray)}).`);
    await runConcurrentPool(tasks, conc);
    if (ROSTER_ENABLED) {
      console.log(`[مشهد] ${rosterStats.slices} شريحة بنظام الأشخاص | ${rosterStats.people} شخص | الكاست غيّر جنس ${rosterStats.changed} شخص وملأ ${rosterStats.filled} | رجعت للحروف ${rosterStats.fallbacks} شريحة.`);
    }
  }

  applyAllEvidence();

  const askList = pending.filter(it => {
    const c = coded.get(it.id);
    return !c || c.includes('U');
  });
  console.log(`[تحليل الضمائر] الجولة 1 انتهت: ${coded.size}/${pending.length} سطر رجع كود، و${askList.length} فيه U أو ناقص.`);

  if (askList.length > 0 && deadline - Date.now() > 4000) {
    const groups = [];
    let cur = [];
    for (const it of askList) {
      const pos = posById.get(it.id);
      if (cur.length && (cur.length >= RESCUE_MAX_ASK || pos - posById.get(cur[0].id) > RESCUE_MAX_SPAN)) {
        groups.push(cur);
        cur = [];
      }
      cur.push(it);
    }
    if (cur.length) groups.push(cur);

    const tasks = groups.map((group, gi) => async () => {
      if (optState.aborted) return;
      const first = posById.get(group[0].id);
      const last = posById.get(group[group.length - 1].id);
      const windowItems = windowFor(Math.max(0, first - RESCUE_CONTEXT), Math.min(items.length, last + 1 + RESCUE_CONTEXT), new Set(group.map(it => it.id)));
      const map = await annotateWindow({
        windowItems, mode: 'rescue', keysArray, modelName, deadline, castPromptBlock, state: optState,
        label: `جولة 2 (إعادة U) نافذة ${gi + 1}/${groups.length} [${group.length} سطر]`
      });
      for (const it of group) {
        const nc = normalizeCode(map.get(it.id), turnsById.get(it.id));
        if (nc) coded.set(it.id, mergeCodes(coded.get(it.id) || defaultCode(it.id), nc));
      }
    });
    console.log(`[تحليل الضمائر] جولة 2: ${askList.length} سطر → ${groups.length} طلب بسياق ±${RESCUE_CONTEXT}.`);
    await runConcurrentPool(tasks, conc);
  }

  applyAllEvidence();

  if (!optState.aborted && deadline - Date.now() > 6000) {
    const codeOf = id => coded.get(id) || cache.get(id);
    const jobs = [];
    for (const run of findFFRuns(items, codeOf, VERIFY_RUN_MIN)) {
      if (!run.items.some(it => !cache.has(it.id))) continue;
      for (let i = 0; i < run.items.length; i += 80) jobs.push({ items: run.items.slice(i, i + 80), ff: run.ff });
    }
    jobs.sort((x, y) => y.ff - x.ff);
    const picked = jobs.slice(0, VERIFY_MAX_REQUESTS);
    if (picked.length > 0) {
      console.log(`[تحليل الضمائر] رأي ثاني: ${picked.length} طلب لمشاهد فيها FF متتالية (امرأة مع امرأة).`);
      let changedLines = 0;
      const vtasks = picked.map((job, vi) => async () => {
        if (optState.aborted) return;
        const first = posById.get(job.items[0].id);
        const last = posById.get(job.items[job.items.length - 1].id);
        const windowItems = windowFor(Math.max(0, first - VERIFY_CONTEXT), Math.min(items.length, last + 1 + VERIFY_CONTEXT), new Set(job.items.map(it => it.id)));
        const map = await annotateWindow({
          windowItems, mode: 'verify', keysArray, modelName, deadline, castPromptBlock, state: optState,
          label: `رأي ثاني مشهد ${vi + 1}/${picked.length} [${job.items.length} سطر]`
        });
        for (const it of job.items) {
          if (cache.has(it.id)) continue;
          const nc = normalizeCode(map.get(it.id), turnsById.get(it.id));
          if (!nc) continue;
          const old = coded.get(it.id) || defaultCode(it.id);
          const merged = mergeCodes(nc, old);
          if (merged !== old) { coded.set(it.id, merged); changedLines++; }
        }
      });
      await runConcurrentPool(vtasks, Math.min(conc, 4));
      console.log(`[تحليل الضمائر] الرأي الثاني غيّر ${changedLines} سطر.`);
      applyAllEvidence();
    }
  }
  if (optState.aborted) {
    console.log('[تحليل الضمائر] وصلت حصة الموديل (429) فأوقفت باقي الطلبات الاختيارية لأحمي مفاتيح الترجمة.');
  }

  console.log(`[أدلة] غيّرت ${evStats.overridden} حرف من قرار الـ AI (دليل مؤكد من الكاست)، وملأت ${evStats.filled} حرف ناقص.`);

  const fresh = [];
  for (const it of pending) {
    const code = coded.get(it.id);
    if (code) {
      cache.set(it.id, code);
      fresh.push([it.id, code]);
    }
  }
  if (fresh.length > 0) db.saveMap('annot', cacheKey, fresh);

  const dist = new Map();
  let useful = 0;
  for (const it of pending) {
    const c = cache.get(it.id);
    if (!c) continue;
    dist.set(c, (dist.get(c) || 0) + 1);
    if (/[MFG]/.test(c)) useful++;
  }
  const distStr = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`[تحليل الضمائر] النتيجة: ${useful}/${pending.length} سطر فيه معلومة جنس | ${secs(Date.now() - tStart)} | التوزيع: ${distStr || 'لا شيء'}`);

  return cache;
}

async function translateAllCues(cues, keysArray, modelName, concurrency, cacheKey, castPromptBlock = '') {
  const tStart = Date.now();
  const CHUNK = getDynamicChunkSize(modelName);
  const cache = await loadLineCache(cacheKey);

  const results = new Array(cues.length).fill(null);
  const toDo = [];
  let fromCache = 0;
  cues.forEach((c, i) => {
    if (!needsTranslation(c.text)) { results[i] = c.text; return; }
    if (cache.has(i)) { results[i] = cache.get(i); fromCache++; return; }
    toDo.push({ id: i, text: prepCueText(c.text) });
  });
  if (fromCache > 0) console.log(`[كاش الأسطر] ${fromCache} سطر جاهز من قبل، أترجم الباقي (${toDo.length}) فقط.`);

  let enhancedCastPrompt = castPromptBlock || '';
  const storyM = String(castPromptBlock || '').match(/STORY OVERVIEW:\n([\s\S]*?)\n\nKNOWN CHARACTERS/);
  console.log(storyM ? `[القصة] مرفقة (${storyM[1].length} حرف): ${storyM[1].replace(/\s+/g, ' ')}` : '[القصة] غير مرفقة (ما في كاست)');
  
  const localHints = new Map();

  let regIndex = null;
  if (ENABLE_GENDER_ANALYSIS && toDo.length > 0) {
    try {
      const registry = await getCharacterRegistry(cues, keysArray, modelName, cacheKey, castPromptBlock);
      regIndex = buildRegistryIndex(castPromptBlock, registry);
      const block = registryPromptBlock(regIndex);
      if (block) enhancedCastPrompt += (enhancedCastPrompt ? '\n\n' : '') + block;
      console.log(`[سجل الشخصيات] الفهرس: ${regIndex.size} اسم/لقب (كاست ${regIndex.castCount} شخصية + ملف ${regIndex.fileCount}).`);
    } catch (e) {
      console.log(`[سجل الشخصيات] فشل (${e.message})، أكمل بدونه.`);
    }
  }

  if (ENABLE_GENDER_ANALYSIS && toDo.length > 0 && nlp && genderDetect) {
    const known = new Map();
    const lines = enhancedCastPrompt.split('\n');
    for (const l of lines) {
      const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
      if (m) known.set(m[1].trim().toLowerCase(), m[2].toUpperCase());
    }

    const dynamicNames = new Map();
    for (const it of toDo) {
      if (!ENGLISH_PRONOUNS.test(it.text)) continue;

      const doc = nlp(it.text);
      const people = doc.people().out('array');

      for (let p of people) {
        const cleanP = p.replace(/[^\w\s]/g, '').trim().toLowerCase();
        if (cleanP && cleanP.length > 2 && !known.has(cleanP) && !dynamicNames.has(cleanP)) {
           const first = cleanP.split(' ')[0];
           const g = genderDetect.detect(first);
           if (g === 'male') dynamicNames.set(cleanP, 'M');
           else if (g === 'female') dynamicNames.set(cleanP, 'F');
        }
      }

      let addresseeG = 'U', speakerG = 'U';

      if (people.length === 1) {
         const pName = people[0].replace(/[^\w\s]/g, '').trim().toLowerCase();
         const pGen = known.get(pName) || dynamicNames.get(pName);
         if (pGen) {
            if (isVocativeName(it.text, pName)) addresseeG = pGen;
            if (doc.match('(i am|im|my name is) #Person').found) speakerG = pGen;
         }
      }

      if (speakerG !== 'U' || addresseeG !== 'U') {
         localHints.set(it.id, speakerG + addresseeG);
      }
    }

    if (dynamicNames.size > 0) {
      enhancedCastPrompt += '\n\nGUESSED SIDE CHARACTERS (weak guesses from first names, may be wrong; the story context overrides them):\n' + [...dynamicNames.entries()].map(([k,v]) => `${k} = ${v}`).join('\n');
      console.log(`[تخمين الأسماء] تم تخمين جنس ${dynamicNames.size} أسماء جانبية وإضافتها كترجيح ضعيف لسياق الـ AI.`);
    }
    if (localHints.size > 0) {
      console.log(`[التحليل النحوي] ${localHints.size} سطر فيه دليل محلي (يُستخدم فقط لملء الحروف اللي ما حسمها الـ AI).`);
    }
  }

  const evidence = new Map();
  if (ENABLE_GENDER_ANALYSIS && toDo.length > 0) {
    cues.forEach((c, i) => {
      if (!needsTranslation(c.text)) return;
      const ev = registryEvidenceForCue(c.text, regIndex);
      if (ev) evidence.set(i, ev);
    });
    const fromRegistry = evidence.size;
    for (const [id, code] of localHints) {
      if (splitTurns(cues[id].text).length !== 1) continue;
      const ev = evidence.get(id) || [{}];
      const e = ev[0];
      if (!e.s && code[0] !== 'U') { e.s = code[0]; e.sT = 'file'; }
      if (!e.a && code[1] !== 'U') { e.a = code[1]; e.aT = 'file'; }
      evidence.set(id, ev);
    }
    if (evidence.size > 0) console.log(`[أدلة] ${fromRegistry} سطر فيه نداء/تعريف باسم معروف من السجل، و${evidence.size - fromRegistry} سطر إضافي من NLP.`);
  }

  let annotationSummary = 'لم يُستخدم';
  if (toDo.length > 0) {
    if (!ENABLE_GENDER_ANALYSIS) {
      console.log('[الجندر] تحليل الضمائر موقوف (ENABLE_GENDER_ANALYSIS=false).');
      annotationSummary = 'موقوف';
    } else {
      console.log('[الجندر] أشغّل تحليل الضمائر...');
      try {
        const tA = Date.now();
        const deadline = Date.now() + ANNOTATION_BUDGET_MS;
        const annotations = await getAnnotations(cues, keysArray, modelName, cacheKey, deadline, enhancedCastPrompt, evidence, regIndex);

        let attached = 0;
        for (const it of toDo) {
          const g = annotations.get(it.id);
          if (g && /[MFG]/.test(g)) { it.g = g; attached++; }
        }
        annotationSummary = `أُرفق بـ ${attached} من ${toDo.length} سطر (${secs(Date.now() - tA)})`;
        console.log(`[تحليل الضمائر] أرفقت معلومة الجنس بـ ${attached} من ${toDo.length} سطر.`);
      } catch (e) {
        annotationSummary = `فشل (${e.message})`;
        console.log(`[تحليل الضمائر] فشل (${e.message})، أكمل الترجمة بدونه.`);
      }
    }
  }

  if (toDo.length > 0) {
    let ruleFixes = 0;
    for (const it of toDo) {
      if (it.g && it.g.includes('/')) continue;
      const adj = applyVocativeRules(cues[it.id].text, it.g);
      if (adj && adj !== it.g) { it.g = adj; ruleFixes++; }
    }
    if (ruleFixes > 0) console.log(`[قواعد الألقاب] عدّلت أو أضفت معلومة الجنس لـ ${ruleFixes} سطر.`);
  }

  const tTrans = Date.now();
  let pendingChunks = [];
  for (let i = 0; i < toDo.length; i += CHUNK) pendingChunks.push(toDo.slice(i, i + CHUNK));

  for (let pass = 0; pass <= MAX_RETRY_PASSES && pendingChunks.length > 0; pass++) {
    if (pass > 0) {
      const left = pendingChunks.reduce((n, ch) => n + ch.length, 0);
      if (keysArray.every(k => deadKeys.has(k))) {
        console.log('[توقف] كل المفاتيح ميتة، ما فايدة من إعادة المحاولة.');
        break;
      }
      console.log(`[جولة إعادة ${pass}/${MAX_RETRY_PASSES} 🔁] باقي ${left} سطر انتجاوزوا بسبب الخنق. راحة ثم أعيدهم...`);
      await delay(5000 + Math.random() * 3000);
    }

    const tasks = pendingChunks.map(chunk => async () => {
      const ctx = buildChunkContext(cues, chunk);
      const map = await translateItemsWithRecovery(chunk, keysArray, modelName, enhancedCastPrompt, ctx);
      const fresh = [];
      for (const [id, text] of map) {
        results[id] = text;
        cache.set(id, text);
        fresh.push([id, text]);
      }
      if (fresh.length > 0) db.saveMap('line', cacheKey, fresh);
    });

    await runConcurrentPool(tasks, pass === 0 ? concurrency : Math.min(2, concurrency));

    pendingChunks = pendingChunks
      .map(ch => ch.filter(it => results[it.id] == null))
      .filter(ch => ch.length > 0);
  }

  const FIND = String(process.env.GENDER_FIND || '').trim();
  const DEBUG = process.env.GENDER_DEBUG === '1';
  if ((FIND || DEBUG) && toDo.length > 0) {
    const flat2 = x => String(x == null ? '' : x).replace(/\{[^}]*\}|<[^>]*>/g, '').replace(/\\N|\\n|\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (DEBUG && regIndex) {
      console.log(`[سجل] ${regIndex.entries.length} شخصية (كاست ${regIndex.castCount} + ملف ${regIndex.fileCount}):`);
      regIndex.entries.slice(0, 80).forEach(e => console.log(`[سجل] ${e.name} = ${e.gender} (${e.tier})${e.aliases.length ? ' | ' + e.aliases.slice(0, 5).join(', ') : ''}`));
    }
    if (FIND) {
      let re = null;
      try { re = new RegExp(FIND, 'iu'); } catch (e) { console.log(`[بحث] تعبير غير صالح: ${e.message}`); }
      if (re) {
        const byId = new Map(toDo.map(it => [it.id, it]));
        const hits = [];
        cues.forEach((c, i) => { if (byId.has(i) && (re.test(flat2(c.text)) || re.test(flat2(results[i])))) hits.push(i); });
        const MAX_HITS = 25;
        console.log(`[بحث] "${FIND}": ${hits.length} سطر مطابق${hits.length > MAX_HITS ? ` (أطبع أول ${MAX_HITS})` : ''}`);
        for (const i of hits.slice(0, MAX_HITS)) {
          console.log(`[بحث] ----- #${i}`);
          for (let j = Math.max(0, i - 2); j <= Math.min(cues.length - 1, i + 2); j++) {
            const it = byId.get(j);
            if (!it) continue;
            console.log(`[بحث] ${j === i ? '>>' : '  '}#${j} [${it.g || '--'}] ${flat2(cues[j].text)} => ${flat2(results[j])}`);
          }
        }
      }
    }
  }

  const missing = results.filter(r => r == null).length;
  if (missing > 0) {
    console.log(`[تنبيه] ${missing} سطر بقوا بنصهم الأصلي بعد كل المحاولات (محفوظ الباقي بالكاش).`);
  }

  console.log(`[ملخص] أسطر=${cues.length} | للترجمة=${toDo.length} | ناقص=${missing} | تحليل الضمائر: ${annotationSummary} | زمن الترجمة=${secs(Date.now() - tTrans)} | الكلي=${secs(Date.now() - tStart)}`);

  return {
    // الأسطر المترجمة فقط تُقسَّم إن كانت طويلة؛ غير المترجمة تبقى كما هي
    texts: cues.map((c, i) => {
      const t = normalizeLineBreakArtifacts(results[i] || c.text);
      return (results[i] != null && needsTranslation(c.text)) ? wrapLongSubtitleLine(t) : t;
    }),
    missing
  };
}

function parseExternalIds(targetId) {
  const s = String(targetId || '').trim();
  const out = { imdbId: null, tvdbId: null };
  const tt = s.match(/tt\d+/i);
  if (tt) out.imdbId = tt[0].toLowerCase();
  const tv = s.match(/^(?:tvdb|thetvdb)[:_-]?(\d+)/i);
  if (tv) out.tvdbId = tv[1];
  return out;
}

const ASS_DLG_RE = /^(Dialogue:\s*[^,]*,[^,]*,[^,]*,(?:[^,]*,){6})(.*)$/i;

// يقرأ ملف ASS مع حفظ مكان كل سطر Dialogue، حتى نستبدل النص فقط ونبقي الملف الأصلي كما هو
function parseAssKeepingStructure(text) {
  const lines = String(text).split(/\r?\n/);
  const cues = [], slots = [];
  lines.forEach((line, i) => {
    const m = line.match(ASS_DLG_RE);
    if (!m) return;
    const f = m[1].split(',');
    cues.push({ start: f[1].trim(), end: f[2].trim(), text: m[2] });
    slots.push(i);
  });
  return { lines, cues, slots };
}

function rebuildAss(parsed, texts) {
  const out = parsed.lines.slice();
  const drop = new Set();
  parsed.slots.forEach((lineIdx, k) => {
    if (DROP_DRAWINGS && DRAWING_RE.test(texts[k])) { drop.add(lineIdx); return; }
    const m = out[lineIdx].match(ASS_DLG_RE);
    out[lineIdx] = m[1] + String(texts[k]).replace(/\r?\n/g, '\\N');
  });
  return out.filter((_, i) => !drop.has(i)).join('\n');
}

async function handleTranslationSrtDetailed(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let castPromptBlock = '';
  const { imdbId, tvdbId } = parseExternalIds(targetId);

  if (kitsuId) {
    console.log(`[AniList] جاري جلب بيانات الشخصيات للأنمي (Kitsu ID: ${kitsuId})...`);
    const aniRes = await getAnilistCast({ kitsuId });
    if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
        console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${aniRes.title || kitsuId}).`);
        castPromptBlock = aniRes.promptBlock;
    } else {
        console.log(`[AniList] فشل/لا يوجد شخصيات للعمل ${kitsuId} | السبب: ${aniRes.reason || 'غير معروف'}`);
    }
  } else if (targetId) {
    if (imdbId || tvdbId) {
      console.log(`[AniList] جاري التحقق إن كان العمل أنمي (IMDb: ${imdbId || '-'} | TVDB: ${tvdbId || '-'})...`);
      const aniRes = await getAnilistCast({ imdbId, tvdbId });
      if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
          console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${aniRes.title || imdbId || tvdbId}).`);
          castPromptBlock = aniRes.promptBlock;
      } else {
          console.log(`[AniList] لا يوجد شخصيات للعمل ${imdbId || tvdbId} | السبب: ${aniRes.reason || 'غير معروف'}`);
      }
    }

    if (!castPromptBlock) {
      console.log(`[TMDB] جاري جلب بيانات الشخصيات للعمل: ${targetId}...`);
      const tmdbRes = await getTmdbCast(targetId, userTmdbKey);
      if (tmdbRes.ok && tmdbRes.cast && tmdbRes.cast.length > 0) {
          console.log(`[TMDB] نجح: تم العثور على ${tmdbRes.cast.length} شخصية لعمل (${tmdbRes.title || targetId}).`);
          castPromptBlock = tmdbRes.promptBlock;
      } else {
          console.log(`[TMDB] فشل/لا يوجد شخصيات للعمل ${targetId} | السبب: ${tmdbRes.reason || 'غير معروف'}`);
      }
    }
  } else {
    console.log(`[شخصيات] لم يتم تمرير targetId أو kitsuId، سيتم تجاوز جلب الشخصيات.`);
  }

  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey, extraKeys); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n", missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي.');
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n", missing: 0, total: 0, failed: true };
  }

  console.log(`[Nuvio] ${cues.length} cues -> CHUNK=${getDynamicChunkSize(modelName)} | Model=${normalizeGeminiModelId(modelName)} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)})`);

  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 5, subUrl, castPromptBlock);

  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    if (DRAWING_RE.test(c.text)) return; // لا معنى لأسطر الرسم في SRT
    let text = finalTranslations[idx];
    if (!text) return;
    if (text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    let sTime = c.start.replace('.', ','), eTime = c.end.replace('.', ',');
    if (sTime.length === 10) sTime = '0' + sTime;
    if (eTime.length === 10) eTime = '0' + eTime;
    if (sTime.split(',')[1].length === 2) sTime += '0';
    if (eTime.split(',')[1].length === 2) eTime += '0';
    srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
    counter++;
  });
  return { content: srtOutput, missing, total: cues.length, failed: false };
}

async function handleTranslationAssDetailed(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let castPromptBlock = '';
  const { imdbId, tvdbId } = parseExternalIds(targetId);

  if (kitsuId) {
    console.log(`[AniList] جاري جلب بيانات الشخصيات للأنمي (Kitsu ID: ${kitsuId})...`);
    const aniRes = await getAnilistCast({ kitsuId });
    if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
        console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${aniRes.title || kitsuId}).`);
        castPromptBlock = aniRes.promptBlock;
    } else {
        console.log(`[AniList] فشل/لا يوجد شخصيات للعمل ${kitsuId} | السبب: ${aniRes.reason || 'غير معروف'}`);
    }
  } else if (targetId) {
    if (imdbId || tvdbId) {
      console.log(`[AniList] جاري التحقق إن كان العمل أنمي (IMDb: ${imdbId || '-'} | TVDB: ${tvdbId || '-'})...`);
      const aniRes = await getAnilistCast({ imdbId, tvdbId });
      if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
          console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${aniRes.title || imdbId || tvdbId}).`);
          castPromptBlock = aniRes.promptBlock;
      } else {
          console.log(`[AniList] لا يوجد شخصيات للعمل ${imdbId || tvdbId} | السبب: ${aniRes.reason || 'غير معروف'}`);
      }
    }

    if (!castPromptBlock) {
      console.log(`[TMDB] جاري جلب بيانات الشخصيات للعمل: ${targetId}...`);
      const tmdbRes = await getTmdbCast(targetId, userTmdbKey);
      if (tmdbRes.ok && tmdbRes.cast && tmdbRes.cast.length > 0) {
          console.log(`[TMDB] نجح: تم العثور على ${tmdbRes.cast.length} شخصية لعمل (${tmdbRes.title || targetId}).`);
          castPromptBlock = tmdbRes.promptBlock;
      } else {
          console.log(`[TMDB] فشل/لا يوجد شخصيات للعمل ${targetId} | السبب: ${tmdbRes.reason || 'غير معروف'}`);
      }
    }
  } else {
    console.log(`[شخصيات] لم يتم تمرير targetId أو kitsuId، سيتم تجاوز جلب الشخصيات.`);
  }

  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey, extraKeys); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي (ASS): ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف.`, missing: 0, total: 0, failed: true };
  }

  // نقرأ الملف مع حفظ بنيته (الستايلات والطبقات والهوامش) لنستبدل النص فقط
  const parsed = parseAssKeepingStructure(originalText);
  const isRealAss = parsed.cues.length > 0;
  const cues = isRealAss ? parsed.cues : extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي (ASS).');
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };
  }

  console.log(`[Nuvio-ASS] ${cues.length} cues | Model=${normalizeGeminiModelId(modelName)} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)}) | ملف ASS أصلي=${isRealAss}`);

  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 8, subUrl, castPromptBlock);

  if (isRealAss) {
    // الأسطر غير المترجمة (رسم / بدون حروف) أو التي بقيت بنصها الأصلي نعيدها حرفيًا كما في الأصل
    const texts = cues.map((c, i) => {
      const t = finalTranslations[i];
      return (!needsTranslation(c.text) || t === normalizeLineBreakArtifacts(c.text)) ? c.text : t;
    });
    return { content: rebuildAss(parsed, texts) + '\n', missing, total: cues.length, failed: false };
  }

  // الأصل كان SRT: نبني ASS من الصفر كما كان
  const assLines = [];
  cues.forEach((c, idx) => {
    let text = finalTranslations[idx];
    if (!text) return;
    if (text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${text.trim().replace(/\n/g, '\\N')}`);
  });
  return { content: ASS_DEFAULT_HEADER + assLines.join('\n') + '\n', missing, total: cues.length, failed: false };
}

async function handleTranslationSrt(subUrl, keysArray, modelName) {
  return (await handleTranslationSrtDetailed(subUrl, keysArray, modelName)).content;
}
async function handleTranslationAss(subUrl, keysArray, modelName) {
  return (await handleTranslationAssDetailed(subUrl, keysArray, modelName)).content;
}

module.exports = {
  handleTranslationSrt,
  handleTranslationAss,
  handleTranslationSrtDetailed,
  handleTranslationAssDetailed,
  normalizeLineBreakArtifacts,
  parseRobustJsonArray,
  parseIdTranslations,
  translateItemsWithRecovery,
  shared: {
    axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
    normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
    MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent, parseIdTranslations, buildChunkContext,
    needsTranslation, getLineCache, loadLineCache, aliveKeyCount, MAX_MISSING_RETRIES, fetchAndExtractSub,
    extractCuesUniversal, normalizeLineBreakArtifacts, ASS_DEFAULT_HEADER
  }
};
