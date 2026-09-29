const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ================== نظام 25 مفتاح - تبريد ذكي ==================
const keyCooldowns = new Map();
const deadKeys = new Set();
let currentKeyIndex = 0;

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

function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(Math.ceil(String(text).length / 3) * 1.1);
}

function getDynamicChunkSize(modelName) {
  const limit = getFallbackOutputTokenLimit(modelName);
  const safetyMargin = Math.floor(limit * 0.05);
  const available = limit - safetyMargin;
  if (available >= 60000) return 280;
  if (available >= 30000) return 180;
  return 80;
}

async function acquireKey(keysArray) {
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
    if (wait > 0) {
      console.log(`[تبريد جماعي] كل المفاتيح الحية بالتبريد. انتظار ${Math.ceil(wait / 1000)}s...`);
      await delay(wait);
    } else {
      return keysArray.find(k => !deadKeys.has(k)) || null;
    }
  }
}

// ================== دوال المعالجة ==================
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
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map(x => {
        let txt = String(x || '').replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
        return normalizeLineBreakArtifacts(txt).trim();
      });
    }
  } catch (e) {
    const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
    if (stringMatches.length >= expectedLength * 0.5) {
      return stringMatches.filter(s => s !== 'translations' && s !== 'data').map(s => normalizeLineBreakArtifacts(s).replace(/âTM./gi, '♪').trim());
    }
  }
  return null;
}

async function runConcurrentPool(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try { results[current] = await tasks[current](); } catch (err) { results[current] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ================== الترجمة الأساسية ==================
async function translateChunkStrict(texts, keysArray, modelName) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const isGemini3 = isGemini3Model(cleanModel);

  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };
  if (isGemini3) {
    generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  }

  const prompt = `Translate the following subtitles while:
1. Preserving the timing and structure exactly as given.
2. If an entry contains multiple lines separated by a real line break, the translation must contain the exact same number of lines, in the same order, separated by a real line break only, within the JSON string value.
3. Preserving any formatting tags or special characters.
4. Any text wrapped entirely in square brackets [ ] represents on-screen text or action tags. Translate it accurately and strictly keep the square brackets in the Arabic output.
5. Wrap place names, city names, country names, food/dish names, brand names, and other foreign proper nouns (non-person) in Arabic parentheses: (الاسم).
6. Wrap person names (character names) in Arabic quotation marks: "الاسم" — quotation marks are reserved for person names only, never for places/food/brands.
7. When an entire entry is off-screen narration, a voice-over, a letter being read aloud, or a voice heard through a phone/radio/TV with no visible speaker on screen, wrap the WHOLE entry in ONE single pair of quotation marks (one at the start, one at the end). Do not add internal quotes for names if the whole entry is already quoted.
8. GENDER ENFORCEMENT & NEUTRALITY: Arabic requires gendered grammar. Infer the speaker's/listener's gender from the context available within this chunk only (names, titles, dialogue cues). If there is a clear back-and-forth between a male and a female, alternate the Arabic pronouns accordingly. If gender is impossible to determine from the context, formulate the Arabic translation to be naturally GENDER-NEUTRAL whenever possible (e.g., use passive voice or verbal nouns to avoid explicit أنتَ/أنتِ).
9. Pay close attention to split sentences (sentences that start in one cue and continue into the next, often indicated by "..."). Ensure the Arabic grammar and phrasing flow logically and seamlessly across these sequential lines without treating them as isolated sentences.
10. Act as an expert cinematic subtitler. Translate idioms/slang naturally into Arabic rather than literally.
=== CINEMATIC CONSTITUTION (CRITICAL RULES) ===
11. RELIGIOUS EXCLAMATIONS: Translate words like 'Jesus', 'Christ', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a person's name.
12. EPILOGUES & LONG TEXTS: Never ignore, skip, or summarize long blocks of on-screen text. Translate them completely and accurately.
13. FOREIGN LANGUAGES: If dialogue is in a third language or has a tag (e.g., [speaks Spanish]), translate BOTH the tag and the actual meaning entirely into Arabic (e.g., [يتحدث الإسبانية] يا صديقي). Leave NO English or foreign text behind.
14. PROFANITY: Translate swear words into standard cinematic Arabic equivalents without literal awkwardness.
Translate to Arabic.
Do NOT overthink. Do NOT overplan.
Do NOT include acknowledgements, explanations, notes or alternative translations.
Output ONLY A VALID JSON ARRAY OF STRINGS, nothing else.
Content to translate:
${JSON.stringify(texts)}`;

  for (let attempt = 0; attempt < keysArray.length; attempt++) {
    const activeKey = await acquireKey(keysArray);
    if (!activeKey) return null;
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

      const responseText = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsedArr = parseRobustJsonArray(responseText, texts.length);
      if (parsedArr && parsedArr.length > 0) {
        console.log(`[Success] chunk ${texts.length} via ...${cleanKey.slice(-4)} | ${cleanModel}`);
        return parsedArr;
      }
      throw new Error('Empty parse');

    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت نهائي] ...${cleanKey.slice(-4)} (401/403) لن نستخدمه مجدداً`);
        continue;
      }
      let cd = 60000;
      if (status === 503 || status === 500 || status === 502) cd = 3000 + Math.random() * 2000;
      else if (status === 429) cd = 60000;
      else if (status === 400) cd = 10000;
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد] ...${cleanKey.slice(-4)} -> ${cd / 1000}s (status:${status})`);
    }
  }
  return null;
}

async function fetchAndExtractSub(subUrl) {
  const decodedUrl = decodeURIComponent(subUrl);
  const response = await axios.get(decodedUrl, {
    responseType: 'arraybuffer', timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
  });
  let buffer = Buffer.from(response.data);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find(e => !e.isDirectory && /\.(srt|ass|ssa)$/i.test(e.entryName));
    if (entry) buffer = entry.getData();
  }
  return fixArabicEncoding(buffer).toString('utf-8');
}

async function handleTranslationSrt(subUrl, keysArray, modelName) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) { return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n"; }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n";

  const CHUNK = getDynamicChunkSize(modelName);
  console.log(`[Nuvio] ${cues.length} cues -> CHUNK=${CHUNK} | Model=${normalizeGeminiModelId(modelName)}`);

  const chunks = [];
  for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

  const tasks = chunks.map(chunk => async () => {
    const texts = chunk.map(c => {
      let t = c.text;
      if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) return `[${t}]`;
      return t;
    });
    const translated = await translateChunkStrict(texts, keysArray, modelName);
    return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
  });

  const chunkResults = await runConcurrentPool(tasks, 5);
  const finalTranslations = chunkResults.flat().map(t => normalizeLineBreakArtifacts(t));

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
  return srtOutput;
}

async function handleTranslationAss(subUrl, keysArray, modelName) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) { return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف.`; }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`;

  const CHUNK = getDynamicChunkSize(modelName);
  const chunks = [];
  for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

  const tasks = chunks.map(chunk => async () => {
    const texts = chunk.map(c => {
      let t = c.text;
      if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) return `[${t}]`;
      return t;
    });
    const translated = await translateChunkStrict(texts, keysArray, modelName);
    return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
  });

  const chunkResults = await runConcurrentPool(tasks, 5);
  const finalTranslations = chunkResults.flat().map(t => normalizeLineBreakArtifacts(t));
  const assLines = [];
  cues.forEach((c, idx) => {
    let text = finalTranslations[idx];
    if (!text) return;
    if (text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${text.trim().replace(/\n/g, '\\N')}`);
  });
  return ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';
}

module.exports = { handleTranslationSrt, handleTranslationAss, normalizeLineBreakArtifacts, parseRobustJsonArray };
