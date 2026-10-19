'use strict';
const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const {
  applyVocativeRules,
  extractRuleEvidenceForCue,
  analyzeSubtitlesGender,
  logGenderDebug
} = require('./genderRules');
const { getTmdbCast } = require('./tmdb');
const { getAnilistCast } = require('./anilist');
const db = require('./db');
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
const GENDER_SOURCE_LANGS = new Set(['he', 'hi']);
const TRANSLATION_WRAP_AT = 42;
const WRAP_MIN_PART = 8;
const DROP_DRAWINGS = true;
const DRAWING_RE = /\{[^}]*\\p0*[1-9][^}]*\}/;
const CONTEXT_LINES = 4;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secs = ms => `${(ms / 1000).toFixed(1)} ثانية`;
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
function fixHebrewEncoding(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return fixArabicEncoding(buffer);
  if (!buffer.toString('utf-8').includes('\uFFFD')) return buffer;
  try {
    const dec = iconv.decode(buffer, 'windows-1255');
    if (/[\u05D0-\u05EA]/.test(dec)) return Buffer.from(dec, 'utf-8');
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
      const m = line.match(/^Dialogue:\s*[^,]*,([^,]*),([^,]*),[^,]*,([^,]*),(?:[^,]*,){4}(.*)$/i);
      if (m) cues.push({ start: m[1].trim(), end: m[2].trim(), actor: m[3].trim(), text: m[4] });
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
    if (text2.trim()) cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), actor: '', text: text2 });
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
function wrapLongSubtitleLine(text) {
  const t = String(text == null ? '' : text);
  if (!(TRANSLATION_WRAP_AT > 0) || t.includes('\n')) return t;
  if (/^\s*(?:\{[^}]*\}|<[^>]*>)*\s*[-–—]/.test(t)) return t;
  if (/\{[^}]*\\(?:pos|move|an\d|org|i?clip|p\d)/i.test(t)) return t;
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
        const msg = err && err.message ? err.message : 'Unknown error';
        console.log(`[Pool] مهمة ${current + 1}/${tasks.length} فشلت: ${msg}`);
        results[current] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
function cleanForAnalysis(t) {
  return String(t || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
async function translateChunkStrict(items, keysArray, modelName, castPromptBlock = '', ctx = null, srcLang = '') {
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
  const srcName = srcLang === 'he' ? 'Hebrew' : srcLang === 'hi' ? 'Hindi' : '';
  const rule8b = srcName
    ? `8b. SOURCE-GRAMMAR GENDER (this takes priority over the hint mechanism above, which is not used for this track): the source language is ${srcName}, and it marks gender in verbs, adjectives and participles (Hebrew: הולך/הולכת, בוא/בואי, עייף/עייפה; Hindi: जा रहे हो/जा रही हो, थका/थकी). Read the gender of the speaker and of the person addressed from these forms and use the matching Arabic gendered verbs, adjectives and pronouns. Write the Arabic with NO diacritics at all (no fatha/kasra on endings: write أنت, بيتك, لك, عندك).`
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
8. GENDER ENFORCEMENT & NEUTRALITY: Arabic requires gendered grammar (verbs, adjectives, pronouns, vocatives) for I/me/my/you/your and for anyone referred to. When an entry has "g", use it to pick the correct Arabic gender for the speaker (first letter) and the person addressed (second letter). Treat "g" as a strong hint, but if the text itself clearly contradicts it (explicit names, titles, "he said"/"she said"), trust the text. When "g" is missing or a letter is U or N, infer gender from the dialogue context in this chunk; if it is still impossible to determine, formulate the Arabic to be naturally GENDER-NEUTRAL (passive voice or verbal nouns) instead of guessing.${rule8b ? '\n' + rule8b : ''}
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
        safetySettings: SAFETY_SETTINGS_OFF
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
async function translateItemsWithRecovery(items, keysArray, modelName, castPromptBlock = '', ctx = null, srcLang = '') {
  const done = new Map();
  if (!items || items.length === 0) return done;
  let pending = items;
  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    const result = await translateChunkStrict(pending, keysArray, modelName, castPromptBlock, ctx, srcLang);
    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ] السيرفرات مختنقة. تم تجاوز (${pending.length}) سطر للحفاظ على تزامن الفلم.`);
      break;
    }
    if ((result.status === 'bad_ids' || result.status === 'bad_format') && pending.length > 60) {
      const mid = Math.ceil(pending.length / 2);
      console.log(`[حارس الأرقام] أقسم الدفعة (${pending.length}) لنصفين وأعيد.`);
      const left = await translateItemsWithRecovery(pending.slice(0, mid), keysArray, modelName, castPromptBlock, ctx, srcLang);
      const right = await translateItemsWithRecovery(pending.slice(mid), keysArray, modelName, castPromptBlock, ctx, srcLang);
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
  const base = String(name).split(/[\\/]/).pop().replace(/\.(srt|ass|ssa)$/i, '').trim();
  if (!base) return null;
  let m = base.match(/\bs\d{1,2}[ ._-]*e0*(\d{1,4})(?:v\d+)?\b|\b\d{1,2}x0*(\d{1,4})(?:v\d+)?\b/i);
  if (m) return Number(m[1] || m[2]);
  m = base.match(/(?:^|[ ._\-\[\(])(?:ep|episode|e)[ ._-]*0*(\d{1,4})(?:v\d+)?(?=[ ._\-\]\)]|$)/i);
  if (m) return Number(m[1]);
  m = base.match(/^0*(\d{1,4})(?:v\d+)?$/i);
  if (m) return Number(m[1]);
  const clean = base
    .replace(/\[[0-9a-f]{8}\]/gi, ' ')
    .replace(/\[\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*\]/g, ' ')
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, ' ')
    .replace(/(?:480|576|720|1080|2160)[pi]|[xh]\.?26[45]|10\s*bit|8\s*bit|yuv\d+p\d+|(?:\b|_)(?:19|20)\d{2}(?:\b|_)/gi, ' ');
  m = clean.match(/[ ._]+-[ ._]*0*(\d{1,4})(?:v\d+)?(?=[ ._\-\[\(]|$)/i);
  if (m) return Number(m[1]);
  m = clean.match(/\[0*(\d{1,4})(?:v\d+)?\]/);
  if (m) return Number(m[1]);
  return null;
}
function zipNameHasEpisode(name, episode) {
  const base = String(name).split(/[\\/]/).pop();
  const sxe = zipEpisodeOf(base);
  if (sxe != null) return sxe === Number(episode);
  const clean = base.replace(/(?:480|576|720|1080|2160)[pi]|[xh]\.?26[45]|\b(?:19|20)\d{2}\b/gi, ' ');
  return new RegExp(`(?<![0-9])0*${Number(episode)}(?![0-9])`).test(clean);
}
const epInfoOf = id => {
  const p = String(id || '').split(':');
  return (p.length >= 3 && /^\d+$/.test(p[2])) ? { season: p[1], episode: p[2] } : null;
};
const dlCache = new Map();
const DL_OK_TTL = 10 * 60 * 1000;
const DL_FAIL_TTL = 30 * 1000;
function downloadShared(url, run) {
  const hit = dlCache.get(url);
  if (hit && Date.now() - hit.time < (hit.failed ? DL_FAIL_TTL : DL_OK_TTL)) return hit.promise;
  const entry = { time: Date.now(), failed: false };
  entry.promise = run().then(r => { entry.time = Date.now(); return r; }, e => {
    if (e?.response?.status === 429) { entry.failed = true; entry.time = Date.now(); }
    else dlCache.delete(url);
    throw e;
  });
  dlCache.set(url, entry);
  if (dlCache.size > 30) dlCache.delete(dlCache.keys().next().value);
  return entry.promise;
}
async function fetchAndExtractSub(subUrl, subsourceKey = '', epInfo = null, srcLang = '') {
  const decodedUrl = safeDecode(subUrl);
  const memKey = decodedUrl + '#' + (epInfo ? epInfo.episode : '');
  const hit = subTextCache.get(memKey);
  if (hit && Date.now() - hit.time < SUB_CACHE_TTL) return hit.text;
  const ssKey = String(subsourceKey || '').trim();
  const isOsOrg = /^https?:\/\/dl\.opensubtitles\.org\//i.test(decodedUrl);
  const isSubsource = /^https?:\/\/api\.subsource\.net\//i.test(decodedUrl);
  const isSubdl = /^https?:\/\/dl\.subdl\.com\//i.test(decodedUrl);
  const agents = isOsOrg ? ['VLSub 0.10.3', 'TemporaryUserAgent'] : [BROWSER_UA, 'Mozilla/5.0'];
  const response = await downloadShared(decodedUrl, async () => {
    let res = null;
    let lastErr = null;
    for (let i = 0; i < agents.length; i++) {
      const ua = agents[i];
      const headers = isOsOrg
        ? { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': '*/*' }
        : { 'User-Agent': ua, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' };
      if (isSubdl) headers['Referer'] = 'https://subdl.com/';
      if (isSubsource && ssKey) headers['X-API-Key'] = ssKey;
      try {
        res = await axios.get(decodedUrl, { responseType: 'arraybuffer', timeout: 15000, headers });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const st = e.response?.status || e.code || 'ERR';
        console.log(`[Download] ${st} (${ua.slice(0, 18)}) <- ${decodedUrl}`);
        if (!(e.response?.status === 403 && i < agents.length - 1)) break;
      }
    }
    if (!res) throw lastErr;
    return res;
  });
  let buffer = Buffer.from(response.data);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    const cands = zip.getEntries().filter(e => !e.isDirectory && /\.(srt|ass|ssa)$/i.test(e.entryName));
    if (cands.length === 0) {
      throw new Error('ملف الـ ZIP لا يحتوي على أي ملف ترجمة صالح (srt/ass/ssa)');
    }
    let entry = cands[0];
    if (epInfo && epInfo.episode != null) {
      if (cands.length > 1) {
        entry = cands.find(e => zipNameHasEpisode(e.entryName, epInfo.episode));
        if (!entry) throw new Error(`الـ ZIP فيه ${cands.length} ملف ولا يوجد ملف للحلقة ${epInfo.episode}`);
      } else if (entry && zipEpisodeOf(entry.entryName) != null && !zipNameHasEpisode(entry.entryName, epInfo.episode)) {
        throw new Error(`ملف الـ ZIP (${entry.entryName}) ليس للحلقة ${epInfo.episode}`);
      }
    }
    if (entry) buffer = entry.getData();
  }
  const text = (srcLang === 'he' ? fixHebrewEncoding(buffer) : fixArabicEncoding(buffer)).toString('utf-8');
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
  if (DRAWING_RE.test(raw)) return false;
  const t = raw.replace(/<[^>]*>|\{[^}]*\}|\\N|\\n/g, '');
  return /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0900-\u097F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(t);
}
async function translateAllCues(cues, keysArray, modelName, concurrency, cacheKey, castPromptBlock = '', srcLang = '') {
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
  const { enhancedCastPrompt, annotationSummary, regIndex } = await analyzeSubtitlesGender({
    cues,
    toDo,
    keysArray,
    modelName,
    cacheKey,
    castPromptBlock,
    enableGender: ENABLE_GENDER_ANALYSIS && !GENDER_SOURCE_LANGS.has(srcLang),
    deps: {
      callGeminiText,
      runConcurrentPool,
      aliveKeyCount,
      normalizeGeminiModelId,
      isGemini3Model,
      needsTranslation,
      db,
      secs
    }
  });
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
      const map = await translateItemsWithRecovery(chunk, keysArray, modelName, enhancedCastPrompt, ctx, srcLang);
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
  logGenderDebug({ cues, toDo, results, regIndex });
  const missing = results.filter(r => r == null).length;
  if (missing > 0) {
    console.log(`[تنبيه] ${missing} سطر بقوا بنصهم الأصلي بعد كل المحاولات (محفوظ الباقي بالكاش).`);
  }
  console.log(`[ملخص] أسطر=${cues.length} | للترجمة=${toDo.length} | ناقص=${missing} | تحليل الضمائر: ${annotationSummary} | زمن الترجمة=${secs(Date.now() - tTrans)} | الكلي=${secs(Date.now() - tStart)}`);
  return {
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
function parseAssKeepingStructure(text) {
  const lines = String(text).split(/\r?\n/);
  const cues = [], slots = [];
  lines.forEach((line, i) => {
    const m = line.match(ASS_DLG_RE);
    if (!m) return;
    const f = m[1].split(',');
    cues.push({ start: f[1].trim(), end: f[2].trim(), actor: (f[4] || '').trim(), text: m[2] });
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
async function resolveCastPromptBlock(targetId, kitsuId, userTmdbKey) {
  let castPromptBlock = '';
  const { imdbId, tvdbId } = parseExternalIds(targetId);
  if (kitsuId) {
    console.log(`[AniList] جاري جلب بيانات الشخصيات للأنمي (Kitsu ID: ${kitsuId})...`);
    const aniRes = await getAnilistCast({ kitsuId });
    if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
      const title = aniRes.title || kitsuId;
      console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${title}).`);
      castPromptBlock = aniRes.promptBlock;
    } else {
      const reason = aniRes.reason || 'غير معروف';
      console.log(`[AniList] فشل/لا يوجد شخصيات للعمل ${kitsuId} | السبب: ${reason}`);
    }
  } else if (targetId) {
    if (imdbId || tvdbId) {
      const imLog = imdbId || '-';
      const tvLog = tvdbId || '-';
      const idLabel = imdbId || tvdbId;
      console.log(`[AniList] جاري التحقق إن كان العمل أنمي (IMDb: ${imLog} | TVDB: ${tvLog})...`);
      const aniRes = await getAnilistCast({ imdbId, tvdbId });
      if (aniRes.ok && aniRes.cast && aniRes.cast.length > 0) {
        const title = aniRes.title || idLabel;
        console.log(`[AniList] نجح: تم العثور على ${aniRes.cast.length} شخصية لعمل (${title}).`);
        castPromptBlock = aniRes.promptBlock;
      } else {
        const reason = aniRes.reason || 'غير معروف';
        console.log(`[AniList] لا يوجد شخصيات للعمل ${idLabel} | السبب: ${reason}`);
      }
    }
    if (!castPromptBlock) {
      console.log(`[TMDB] جاري جلب بيانات الشخصيات للعمل: ${targetId}...`);
      const tmdbRes = await getTmdbCast(targetId, userTmdbKey);
      if (tmdbRes.ok && tmdbRes.cast && tmdbRes.cast.length > 0) {
        const title = tmdbRes.title || targetId;
        console.log(`[TMDB] نجح: تم العثور على ${tmdbRes.cast.length} شخصية لعمل (${title}).`);
        castPromptBlock = tmdbRes.promptBlock;
      } else {
        const reason = tmdbRes.reason || 'غير معروف';
        console.log(`[TMDB] فشل/لا يوجد شخصيات للعمل ${targetId} | السبب: ${reason}`);
      }
    }
  } else {
    console.log('[شخصيات] لم يتم تمرير targetId أو kitsuId، سيتم تجاوز جلب الشخصيات.');
  }
  return castPromptBlock;
}
async function handleTranslationSrtDetailed(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  const castPromptBlock = await resolveCastPromptBlock(targetId, kitsuId, userTmdbKey);
  let originalText = '';
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey, epInfoOf(targetId), extraKeys.srcLang); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: '1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n', missing: 0, total: 0, failed: true };
  }
  const cues = extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي.');
    return { content: '1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n', missing: 0, total: 0, failed: true };
  }
  console.log(`[Nuvio] ${cues.length} cues -> CHUNK=${getDynamicChunkSize(modelName)} | Model=${normalizeGeminiModelId(modelName)} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)})`);
  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 5, `${targetId}|${subUrl}`, castPromptBlock, extraKeys.srcLang);
  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    if (DRAWING_RE.test(c.text)) return;
    const text = finalTranslations[idx];
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
  const castPromptBlock = await resolveCastPromptBlock(targetId, kitsuId, userTmdbKey);
  let originalText = '';
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey, epInfoOf(targetId), extraKeys.srcLang); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي (ASS): ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + 'Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف.', missing: 0, total: 0, failed: true };
  }
  const parsed = parseAssKeepingStructure(originalText);
  const isRealAss = parsed.cues.length > 0;
  const cues = isRealAss ? parsed.cues : extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي (ASS).');
    return { content: ASS_DEFAULT_HEADER + 'Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.', missing: 0, total: 0, failed: true };
  }
  console.log(`[Nuvio-ASS] ${cues.length} cues | Model=${normalizeGeminiModelId(modelName)} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)}) | ملف ASS أصلي=${isRealAss}`);
  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 8, `${targetId}|${subUrl}`, castPromptBlock, extraKeys.srcLang);
  if (isRealAss) {
    const texts = cues.map((c, i) => {
      const t = finalTranslations[i];
      return (!needsTranslation(c.text) || t === normalizeLineBreakArtifacts(c.text)) ? c.text : t;
    });
    return { content: rebuildAss(parsed, texts) + '\n', missing, total: cues.length, failed: false };
  }
  const assLines = [];
  cues.forEach((c, idx) => {
    const text = finalTranslations[idx];
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
