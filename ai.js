const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const { applyVocativeRules } = require('./genderRules');
const { getTmdbCast } = require('./tmdb'); 
const { getAnilistCast } = require('./anilist'); 

// ================== استدعاء مكاتب التحليل المحلي (النقطة 1 و 2) ==================
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

// ================== إعدادات تحليل الجنس (Patch 1 & 2) ==================
const ENABLE_GENDER_ANALYSIS = true;

// تم الرجوع للموديل السريع لضمان عدم حصول اختناق 503
const ANNOTATION_MODEL = String(process.env.ANNOTATION_MODEL || 'gemini-3.1-flash-lite').trim();
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

const CONTEXT_LINES = 4;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  if (!utf8Text.includes('\uFFFD')) return buffer;
  if (/[\u0600-\u06FF]/.test(utf8Text)) return buffer;
  try {
    const decodedWin = iconv.decode(buffer, 'windows-1256');
    if (/[\u0600-\u06FF]/.test(decodedWin)) return Buffer.from(decodedWin, 'utf-8');
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
    ? `\n15. CONTEXT (READ-ONLY): The lines below are NOT part of the content to translate. Use them ONLY to understand sentences that continue across entries, who is speaking, and references to people/places/objects.\ncontext_before: ${JSON.stringify(ctx.before)}\ncontext_after: ${JSON.stringify(ctx.after)}\n`
    : '';

  const prompt = `You will receive a JSON array of subtitle entries. Each entry is an object: {"id": <number>, "text": "<subtitle text>"} and may also include "g": a hint code.
"g" = two letters: the first letter is the SPEAKER's gender, the second letter is the gender of the person being ADDRESSED. If the entry holds several speaker turns (lines starting with "-"), "g" has one two-letter code per turn, separated by "/", in the same order as the turns (for example "FM/MF"): apply each code only to its own turn. M = male, F = female, G = group or mixed, U = unknown, N = none. Never output "g".
Translate the "text" of every entry to Arabic while:
1. Returning a JSON array of objects in the exact same shape: [{"id": <same number>, "text": "<Arabic translation>"}].
   - Return exactly ONE object for EVERY input id, using the SAME id.
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

async function fetchAndExtractSub(subUrl) {
  const decodedUrl = decodeURIComponent(subUrl);

  const isOsOrg = /^https?:\/\/dl\.opensubtitles\.org\//i.test(decodedUrl);
  const headers = isOsOrg
    ? { 'User-Agent': 'VLSub 0.10.3', 'X-User-Agent': 'VLSub 0.10.3', 'Accept': '*/*' }
    : { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };

  let response;
  try {
    response = await axios.get(decodedUrl, {
      responseType: 'arraybuffer', timeout: 15000,
      headers
    });
  } catch (e) {
    if (isOsOrg) console.log(`[Download] ${e.response?.status || e.code || 'ERR'} (VLSub) <- ${decodedUrl}`);
    throw e;
  }
  if (isOsOrg) console.log(`[Download] ${response.status} (VLSub) <- ${decodedUrl}`);

  let buffer = Buffer.from(response.data);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find(e => !e.isDirectory && /\.(srt|ass|ssa)$/i.test(e.entryName));
    if (entry) buffer = entry.getData();
  }
  return fixArabicEncoding(buffer).toString('utf-8');
}

function prepCueText(t) {
  if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) return `[${t}]`;
  return t;
}

const lineCaches = new Map();
const MAX_LINE_CACHES = 40;

function getLineCache(key) {
  if (!lineCaches.has(key)) {
    lineCaches.set(key, new Map());
    if (lineCaches.size > MAX_LINE_CACHES) lineCaches.delete(lineCaches.keys().next().value);
  }
  return lineCaches.get(key);
}

function needsTranslation(text) {
  const t = String(text || '').replace(/<[^>]*>|\{[^}]*\}|\\N|\\n/g, '');
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

const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
];

async function callGeminiText({ prompt, keysArray, modelName, generationConfig, timeout = 120000, attempts = 4, deadline = Infinity }) {
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
      return { status: 'ok', text: parts.map(p => p?.text || '').join('') };
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

// ==================================================================================
// ================== Patch 2: القاموس الشامل، النداء المتقدم، والأولويات ==================
// ==================================================================================

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// تعديل (كلاود): دعم حدود Unicode (\p{L}) لمعالجة اللغات المتعددة واستثناء الترقيم
function isVocativeName(text, name) {
  if (!name || name.length < 2) return false;
  const n = escapeRe(name).replace(/\s+/g, '\\s+');
  try {
    const start = new RegExp(`^[^\\p{L}]*(?:(?:hey|oh|ok|okay|look|listen|please|yes|no|well|come on|hola|oye|mira|bonjour|salut)\\s*,?\\s+)?${n}\\s*[,!?:.]`, 'iu');
    const end = new RegExp(`[,!?:.]\\s*${n}\\s*[^\\p{L}]*$`, 'iu');
    return start.test(String(text || '')) || end.test(String(text || ''));
  } catch (e) {
    // خط رجعة لو بيئة Node قديمة
    const start = new RegExp(`^\\W*(?:(?:hey|oh|ok|okay|look|listen|please|yes|no|well|come on|hola|oye|mira)\\s*,?\\s+)?${n}\\s*[,!?:.]`, 'i');
    const end = new RegExp(`[,!?:.]\\s*${n}\\s*\\W*$`, 'i');
    return start.test(String(text || '')) || end.test(String(text || ''));
  }
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
  const scope = mode === 'rescue'
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
- grammatical gender inside the line itself, in languages where adjectives and participles agree with the speaker or the listener
- "he said" / "she said", the alternation of replies in a conversation, and pauses
Use the whole conversation, not only the single line. If you are not reasonably sure about one side, answer U for that side. Do not guess randomly.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}
${scope}
Output ONLY a valid JSON array of strings, exactly one string per item you must answer, in the same order, each formatted "<id>:<codes>", for example ["12:UU","13:FM","14:MF/FM"]. No explanations.
Lines:
${JSON.stringify(windowItems)}`;
}

async function annotateWindow({ windowItems, mode, keysArray, modelName, deadline, label, castPromptBlock }) {
  const baseModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const prompt = buildAnnotationPrompt(windowItems, mode, castPromptBlock);
  const t0 = Date.now();

  let model = (!annotationModelBroken && ANNOTATION_MODEL) ? normalizeGeminiModelId(ANNOTATION_MODEL) : baseModel;
  const call = m => callGeminiText({
    prompt, keysArray, modelName: m, generationConfig: annotationConfig(m, baseModel),
    timeout: ANNOTATION_REQUEST_TIMEOUT_MS, attempts: ANNOTATION_ATTEMPTS, deadline
  });

  let res = await call(model);
  if (res.status === 'config_error' && model !== baseModel) {
    annotationModelBroken = true;
    console.log(`[تحليل الضمائر] موديل التحليل (${model}) غير صالح. أرجع لموديل الترجمة (${baseModel}) لباقي الطلبات.`);
    model = baseModel;
    res = await call(model);
  }

  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${label}: فشل (${res.status}) بعد ${Date.now() - t0}ms.`);
    return new Map();
  }
  const map = parseAnnotationCodes(res.text);
  console.log(`[تحليل الضمائر] ${label}: رجع ${map.size} كود من ${windowItems.length} سطر في ${Date.now() - t0}ms (${model}).`);
  return map;
}

async function getAnnotations(cues, keysArray, modelName, cacheKey, deadline, castPromptBlock = '', localHints = new Map()) {
  const cache = getAnnotationCache(cacheKey);
  const tStart = Date.now();

  const { items, turnsById } = buildAnnotationItems(cues);
  const posById = new Map(items.map((it, i) => [it.id, i]));
  const pending = items.filter(it => !cache.has(it.id));
  const coded = new Map();
  const defaultCode = id => Array(turnsById.get(id) || 1).fill('UU').join('/');
  const conc = Math.max(1, Math.min(aliveKeyCount(keysArray), ANNOTATION_MAX_CONCURRENCY));

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
        const map = await annotateWindow({
          windowItems, mode: 'main', keysArray, modelName, deadline,
          label: `جولة 1 شريحة ${ri + 1}/${ranges.length}`, castPromptBlock
        });
        for (const it of core) {
          if (cache.has(it.id)) continue;
          const c = normalizeCode(map.get(it.id), turnsById.get(it.id));
          if (c) coded.set(it.id, c);
        }
      });
    });
    console.log(`[تحليل الضمائر] ${items.length} سطر بالتسلسل (من ${cues.length}) | ${tasks.length} طلب (تزامن ${Math.min(conc, tasks.length)}، مفاتيح حية ${aliveKeyCount(keysArray)}).`);
    await runConcurrentPool(tasks, conc);
  }

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
      const first = posById.get(group[0].id);
      const last = posById.get(group[group.length - 1].id);
      const from = Math.max(0, first - RESCUE_CONTEXT);
      const to = Math.min(items.length, last + 1 + RESCUE_CONTEXT);
      const askSet = new Set(group.map(it => it.id));
      const windowItems = items.slice(from, to).map(it => {
        const o = { ...it };
        const p = coded.get(it.id) || cache.get(it.id);
        if (p) o.p = p;
        if (askSet.has(it.id)) o.ask = 1; else o.ctx = 1;
        return o;
      });
      const map = await annotateWindow({
        windowItems, mode: 'rescue', keysArray, modelName, deadline,
        label: `جولة 2 (إعادة U) نافذة ${gi + 1}/${groups.length} [${group.length} سطر]`, castPromptBlock
      });
      for (const it of group) {
        const nc = normalizeCode(map.get(it.id), turnsById.get(it.id));
        if (nc) coded.set(it.id, mergeCodes(coded.get(it.id) || defaultCode(it.id), nc));
      }
    });
    console.log(`[تحليل الضمائر] جولة 2: ${askList.length} سطر → ${groups.length} طلب بسياق ±${RESCUE_CONTEXT}.`);
    await runConcurrentPool(tasks, conc);
  }

  let localFilled = 0;
  for (const it of pending) {
    let code = coded.get(it.id);
    const local = localHints.get(it.id);
    if (local && (turnsById.get(it.id) || 1) === 1) {
      const merged = mergeCodes(code || 'UU', local);
      if (merged !== (code || 'UU')) localFilled++;
      code = merged;
    }
    if (code) cache.set(it.id, code);
  }

  const dist = new Map();
  let useful = 0;
  for (const it of pending) {
    const c = cache.get(it.id);
    if (!c) continue;
    dist.set(c, (dist.get(c) || 0) + 1);
    if (/[MFG]/.test(c)) useful++;
  }
  const distStr = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`[تحليل الضمائر] النتيجة: ${useful}/${pending.length} سطر فيه معلومة جنس | ملأ المحلي ${localFilled} حرف | ${Date.now() - tStart}ms | التوزيع: ${distStr || 'لا شيء'}`);

  return cache;
}

async function translateAllCues(cues, keysArray, modelName, concurrency, cacheKey, castPromptBlock = '') {
  const tStart = Date.now();
  const CHUNK = getDynamicChunkSize(modelName);
  const cache = getLineCache(cacheKey);

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
  const localHints = new Map();

  // ================== السجل الشامل (Global Dictionary) والأدلة المتعددة ==================
  if (ENABLE_GENDER_ANALYSIS && toDo.length > 0 && nlp && genderDetect) {
    
    // 1. استخراج الأسماء الموثوقة من (TMDB/AniList) وتوليد أسماء مستعارة (الاسم الأول)
    const known = new Map();
    const lines = enhancedCastPrompt.split('\n');
    for (const l of lines) {
      const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
      if (m) {
        const fullName = m[1].trim().toLowerCase();
        const gen = m[2].toUpperCase();
        known.set(fullName, gen);
        if (fullName.includes(' ')) known.set(fullName.split(' ')[0], gen);
      }
    }

    const dynamicNames = new Map();
    const nameFreq = new Map();

    // 2. مسح شامل لكامل الملف (Global Pass) لحصر أسماء الشخصيات الجانبية
    for (const it of toDo) {
      const doc = nlp(it.text);
      const people = doc.people().out('array');
      for (let p of people) {
        const cleanP = p.replace(/[^\w\s]/g, '').trim().toLowerCase();
        // استثناء الأفعال والكلمات الشائعة التي تلتبس بالأسماء
        if (cleanP && cleanP.length > 2 && !known.has(cleanP) && !/^(will|may|mark|hope|faith|joy|grace|chase|hunter|miles)$/i.test(cleanP)) {
           nameFreq.set(cleanP, (nameFreq.get(cleanP) || 0) + 1);
        }
      }
    }

    // بناء قاموس الأسماء الجانبية
    for (const [name, count] of nameFreq.entries()) {
      if (count >= 1) { 
         const first = name.split(' ')[0];
         const g = genderDetect.detect(first);
         if (g === 'male') dynamicNames.set(name, 'M');
         else if (g === 'female') dynamicNames.set(name, 'F');
      }
    }

    // 3. تحليل الأدلة المحلية (النداء والتعريف الذاتي متعدد اللغات)
    const MULTILINGUAL_SELF_ID = /^(?:i am|i'm|my name is|soy|me llamo|je suis|ich bin|sono|mi chiamo)\s+([A-Z][a-z]+)/i;

    for (const it of toDo) {
      const doc = nlp(it.text);
      const people = doc.people().out('array');
      let addresseeG = 'U', speakerG = 'U';

      // فحص التعريف الذاتي
      const selfIdMatch = it.text.match(MULTILINGUAL_SELF_ID);
      if (selfIdMatch) {
          const n = selfIdMatch[1].toLowerCase();
          speakerG = known.get(n) || dynamicNames.get(n) || 'U';
      }

      if (people.length > 0) {
          for (let p of people) {
              const pName = p.replace(/[^\w\s]/g, '').trim().toLowerCase();
              const pGen = known.get(pName) || dynamicNames.get(pName);
              if (pGen) {
                  // نداء صريح كدليل للمخاطب
                  if (isVocativeName(it.text, pName)) addresseeG = pGen;
                  // تعريف ذاتي (إنجليزي) عبر NLP
                  if (doc.match('(i am|im|my name is) #Person').found && speakerG === 'U') speakerG = pGen;
              }
          }
      }

      if (speakerG !== 'U' || addresseeG !== 'U') {
          localHints.set(it.id, speakerG + addresseeG);
      }
    }

    // 4. دمج قاموس التخمينات ضمن سياق الـ AI (بدرجة ثقة أقل)
    if (dynamicNames.size > 0) {
      enhancedCastPrompt += '\n\nGUESSED SIDE CHARACTERS (weak guesses from first names; story context overrides them):\n' + [...dynamicNames.entries()].map(([k,v]) => `${k} = ${v}`).join('\n');
      console.log(`[قاموس الشخصيات] تم بناء سجل موحد لـ ${dynamicNames.size} اسم جانبي لكامل الملف.`);
    }
    if (localHints.size > 0) {
      console.log(`[التحليل اللغوي] ${localHints.size} سطر فيه دليل محلي موثوق (تعريف ذاتي أو نداء صريح).`);
    }
  }
  // =====================================================================================

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
        const annotations = await getAnnotations(cues, keysArray, modelName, cacheKey, deadline, enhancedCastPrompt, localHints);

        let attached = 0;
        for (const it of toDo) {
          const g = annotations.get(it.id);
          if (g && /[MFG]/.test(g)) { it.g = g; attached++; }
        }
        annotationSummary = `أُرفق بـ ${attached} من ${toDo.length} سطر (${Date.now() - tA}ms)`;
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
      for (const [id, text] of map) {
        results[id] = text;
        cache.set(id, text);
      }
    });

    await runConcurrentPool(tasks, pass === 0 ? concurrency : Math.min(2, concurrency));

    pendingChunks = pendingChunks
      .map(ch => ch.filter(it => results[it.id] == null))
      .filter(ch => ch.length > 0);
  }

  const missing = results.filter(r => r == null).length;
  if (missing > 0) {
    console.log(`[تنبيه] ${missing} سطر بقوا بنصهم الأصلي بعد كل المحاولات (محفوظ الباقي بالكاش).`);
  }

  console.log(`[ملخص] أسطر=${cues.length} | للترجمة=${toDo.length} | ناقص=${missing} | تحليل الضمائر: ${annotationSummary} | زمن الترجمة=${Date.now() - tTrans}ms | الكلي=${Date.now() - tStart}ms`);

  return {
    texts: cues.map((c, i) => normalizeLineBreakArtifacts(results[i] || c.text)),
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

async function handleTranslationSrtDetailed(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId) {
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
  try { originalText = await fetchAndExtractSub(subUrl); }
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

async function handleTranslationAssDetailed(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId) {
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
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي (ASS): ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف.`, missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي (ASS).');
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };
  }

  console.log(`[Nuvio-ASS] ${cues.length} cues | Model=${normalizeGeminiModelId(modelName)} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)})`);

  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 8, subUrl, castPromptBlock);

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
  translateItemsWithRecovery
};
