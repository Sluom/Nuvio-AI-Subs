const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const ASS_DEFAULT_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,26,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const MAX_SAFE_LINE_CHARS = 42;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // أسبوع

// ===================== MongoDB Cache Layer =====================

let mongoClient = null;
let cacheCollection = null;
let cacheReady = false;

async function initCache() {
    if (cacheReady) return cacheCollection;
    if (!process.env.MONGODB_URI) {
        console.warn('[Cache] MONGODB_URI not set — caching disabled.');
        cacheReady = true;
        return null;
    }
    try {
        mongoClient = new MongoClient(process.env.MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db('nuvio_subtitles');
        cacheCollection = db.collection('translation_cache');
        await cacheCollection.createIndex(
            { createdAt: 1 },
            { expireAfterSeconds: CACHE_TTL_SECONDS }
        );
        cacheReady = true;
        console.log('[Cache] MongoDB connected, TTL index ready.');
        return cacheCollection;
    } catch (e) {
        console.error('[Cache] MongoDB connection failed:', e.message);
        cacheReady = true;
        return null;
    }
}

function buildCacheKey(subUrl, modelName, format) {
    const hash = crypto.createHash('sha256').update(subUrl).digest('hex').slice(0, 32);
    return `${format}:${hash}:${modelName || 'default'}`;
}

async function getCachedTranslation(key) {
    const col = await initCache();
    if (!col) return null;
    try {
        const doc = await col.findOne({ _id: key });
        if (doc?.output) {
            console.log(`[Cache] HIT for ${key}`);
            return doc.output;
        }
    } catch (e) {
        console.error('[Cache] Read failed:', e.message);
    }
    return null;
}

async function setCachedTranslation(key, output) {
    const col = await initCache();
    if (!col) return;
    try {
        await col.updateOne(
            { _id: key },
            { $set: { output, createdAt: new Date() } },
            { upsert: true }
        );
        console.log(`[Cache] SET for ${key}`);
    } catch (e) {
        console.error('[Cache] Write failed:', e.message);
    }
}

// ===================== Encoding / Parsing Helpers =====================

function fixArabicEncoding(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        try { return Buffer.from(iconv.decode(buffer, 'utf16-le'), 'utf-8'); } catch (e) { }
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        try { return Buffer.from(iconv.decode(buffer, 'utf16-be'), 'utf-8'); } catch (e) { }
    }
    const utf8Text = buffer.toString('utf-8');
    if (!utf8Text.includes('\uFFFD')) return buffer;
    if (/[\u0600-\u06FF]/.test(utf8Text)) return buffer;
    try {
        const decodedWin = iconv.decode(buffer, 'windows-1256');
        if (/[\u0600-\u06FF]/.test(decodedWin)) return Buffer.from(decodedWin, 'utf-8');
    } catch (e) { }
    try {
        const decodedIso = iconv.decode(buffer, 'iso-8859-6');
        if (/[\u0600-\u06FF]/.test(decodedIso)) return Buffer.from(decodedIso, 'utf-8');
    } catch (e) { }
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

// ===================== Text Normalization Helpers =====================

function normalizeLineBreakArtifacts(txt) {
    if (!txt) return txt;
    let text = String(txt)
        .replace(/\\"/g, '"')
        .replace(/\\\\n/gi, '\n')
        .replace(/\\\\N/g, '\n')
        .replace(/\\n/gi, '\n')
        .replace(/\\N/g, '\n')
        .replace(/\\r/g, '')
        .replace(/[\u200E\u200F\u202A-\u202E]/g, '');

    return text;
}

function splitLongLineAtMidpoint(line, maxChars) {
    if (!line || line.length <= maxChars) return line;

    const mid = Math.floor(line.length / 2);
    let bestSpaceIdx = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < line.length; i++) {
        if (line[i] === ' ') {
            const distance = Math.abs(i - mid);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestSpaceIdx = i;
            }
        }
    }

    if (bestSpaceIdx === -1) return line;

    return line.slice(0, bestSpaceIdx) + '\n' + line.slice(bestSpaceIdx + 1);
}

function applyLineLengthFallback(text) {
    if (!text) return text;
    return text
        .split('\n')
        .map(line => splitLongLineAtMidpoint(line, MAX_SAFE_LINE_CHARS))
        .join('\n');
}

/**
 * يحذف أي سطر فرعي (داخل نفس الـ cue) ما فيه محتوى فعلي — يبقي فقط شرطة
 * أو علامات ترقيم بدون نص — بينما يحافظ على باقي الأسطر اللي فيها كلام.
 * يطبع تحذير تشخيصي لحظة ما يحذف سطر، عشان نلقط سبب المشكلة تلقائيًا من اللوق.
 */
function stripEmptyDialogueLines(text, originalTextForDebug) {
    if (!text) return text;
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
        const plain = line.replace(/<[^>]+>|\{[^}]+\}/g, '');
        const hasContent = /[a-zA-Z0-9\u0600-\u06FF♪]/.test(plain);
        if (!hasContent && line.trim() !== '') {
            console.warn(
                `[EmptyLineDropped] Removed line: "${line}" | Full translated text: "${text}" | Original: "${originalTextForDebug || 'N/A'}"`
            );
        }
        return hasContent;
    });
    return filtered.join('\n');
}

/** يطبّق كل خطوات التنظيف بالترتيب الصحيح على نص مترجم واحد. */
function postProcessTranslatedText(txt, originalText) {
    let text = normalizeLineBreakArtifacts(txt);
    text = stripEmptyDialogueLines(text, originalText);
    text = applyLineLengthFallback(text);
    return text.trim();
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
                let txt = String(x || '');
                txt = txt.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
                return txt;
            });
        }

    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        if (stringMatches.length >= expectedLength * 0.5) {
            return stringMatches
                .filter(s => s !== 'translations' && s !== 'data')
                .map(s => s.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪'));
        }
    }
    return null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runConcurrentPool(tasks, limit = 1) {
    const results = new Array(tasks.length);
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const current = index++;
            try {
                results[current] = await tasks[current]();
            } catch (err) {
                results[current] = null;
            }
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

let currentKeyIndex = 0;
function getNextApiKey(keysArray) {
    if (!keysArray || keysArray.length === 0) return null;
    const key = keysArray[currentKeyIndex % keysArray.length];
    currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
    return key;
}

async function translateChunkStrict(texts, keysArray, modelName) {
    const MAX_RETRIES = 4;
    let baseDelay = 3000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const activeKey = getNextApiKey(keysArray);

        if (!activeKey) {
            console.error("[Fatal] No Gemini API Keys configured!");
            return null;
        }

        const cleanKey = String(activeKey).trim();
        const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');

        const p1 = "https://";
        const p2 = "generativelanguage.googleapis.com";
        const p3 = "/v1beta/models/";
        const p4 = ":generateContent";
        const GEMINI_URL = p1 + p2 + p3 + cleanModelName + p4;

        const prompt = `Translate the following subtitles while:
1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. If an entry contains multiple lines separated by a real line break, the translation must contain the exact same number of lines, in the same order, separated by a real line break only, within the JSON string value.
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue
6. Translate any text inside brackets [] or parentheses () into Arabic professionally while strictly keeping the original brackets/parentheses in the output.
7. Apply professional Arabic subtitling conventions for punctuation as follows:
   a. Wrap place names, city names, country names, food/dish names, brand names, and other foreign proper nouns (non-person) in Arabic parentheses: (الاسم).
   b. Wrap person names (character names) in Arabic quotation marks: "الاسم" — quotation marks are reserved for person names only, never for places/food/brands.
   c. When an entire entry is off-screen narration, a voice-over, a letter being read aloud, or a voice heard through a phone/radio/TV with no visible speaker on screen — even if it spans multiple lines — wrap the WHOLE entry in ONE single pair of quotation marks: one opening mark at the very start of the first line, and one closing mark at the very end of the last line. Do NOT put a separate pair of quotation marks around each individual line.
   d. Do not double-wrap: if a full entry is already voice-over (rule c), do not additionally quote a name inside it — the outer quotes are enough.
   e. Never use quotation marks for places/objects and never use parentheses for person names.
8. Carefully infer the gender of the speakers and listeners from context, relationships, or character names, and strictly apply the correct masculine or feminine Arabic pronouns and verb conjugations.
9. Act as an expert cinematic subtitler. Maintain a consistent tone throughout the dialogue, and translate idioms/slang naturally into Arabic rather than literally.
10. Pay close attention to split sentences (sentences that start in one cue and continue into the next, often indicated by "..."). Ensure the Arabic grammar and phrasing flow logically and seamlessly across these sequential lines without treating them as isolated sentences.
11. Any text wrapped entirely in square brackets [ ] represents on-screen text (like signs, locations, or dates). Translate it accurately and strictly keep the square brackets in the Arabic output.
12. Line length control: if a translated line (not counting an existing dialogue dash "-" prefix) would exceed roughly 40 Arabic characters, break it into exactly two lines using a real line break (\\n) at a natural grammatical point (after a comma, between clauses, or near the sentence's midpoint) — never in the middle of a word. Prefer a shorter, more concise phrasing over a long literal one when it keeps the meaning intact.
13. Do not exceed 2 lines per entry after any splitting from rule 12. Do not merge separate dialogue lines (lines that already start with "-" for different speakers) or separate on-screen-text lines into a single line, and do not add extra splits beyond what is needed — preserve the original line grouping given by the source as much as possible.

Translate to Arabic.
Do NOT overthink. Do NOT overplan.
Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY A VALID JSON ARRAY OF STRINGS, nothing else.

Content to translate:
${JSON.stringify(texts)}`;

        try {
            const r = await axios.post(
                GEMINI_URL,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        responseMimeType: "application/json"
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                    ]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': cleanKey,
                        'x-goog-api-client': 'stremio-submaker/1.4.94'
                    },
                    timeout: 30000
                }
            );

            if (r.status === 200) {
                const responseText = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                const parsedArr = parseRobustJsonArray(responseText, texts.length);
                if (parsedArr && parsedArr.length > 0) {
                    console.log(`[Success] Translated chunk with ${cleanModelName} via Key: ...${cleanKey.slice(-4)}`);
                    return parsedArr;
                }
            }
            return null;

        } catch (e) {
            const status = e.response?.status;
            const isRateLimit = status === 429;
            const isServerError = status >= 500;
            const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';

            if (attempt === MAX_RETRIES || (!isRateLimit && !isServerError && !isTimeout)) {
                console.error(`[Gemini Error - Final] Key ...${cleanKey.slice(-4)}: ${e.response?.data?.error?.message || e.message}`);
                return null;
            }

            const delayMs = baseDelay * Math.pow(2, attempt);
            console.log(`[Retry ${attempt + 1}/${MAX_RETRIES}] Key ...${cleanKey.slice(-4)} failed (Status: ${status}). Waiting ${delayMs}ms before trying NEXT key...`);

            await delay(delayMs);
        }
    }

    return null;
}

async function fetchAndExtractSub(subUrl) {
    let response;
    const decodedUrl = decodeURIComponent(subUrl);
    try {
        response = await axios.get(decodedUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            }
        });
    } catch (err) {
        throw err;
    }

    let buffer = Buffer.from(response.data);
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        const subEntry = entries.find(e => !e.isDirectory && (e.entryName.toLowerCase().endsWith('.srt') || e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')));
        if (subEntry) buffer = subEntry.getData();
    }

    return fixArabicEncoding(buffer).toString('utf-8');
}

function resolvePoolLimit(keysArray) {
    const n = Array.isArray(keysArray) ? keysArray.length : 0;
    return n > 0 ? n : 1;
}

// ===================== Translation Queue (Mutex Lock) =====================

let translationQueue = Promise.resolve();

async function enqueueTranslation(task) {
    const currentWait = translationQueue;
    let releaseNext;
    translationQueue = new Promise(resolve => { releaseNext = resolve; });
    try {
        await currentWait;
        return await task();
    } finally {
        releaseNext();
    }
}

// ===================== Main Handlers =====================

async function handleTranslationSrt(subUrl, keysArray, modelName) {
    const cacheKey = buildCacheKey(subUrl, modelName, 'srt');
    let cached = await getCachedTranslation(cacheKey);
    if (cached) return cached;

    return await enqueueTranslation(async () => {
        cached = await getCachedTranslation(cacheKey);
        if (cached) return cached;

        let originalText = "";
        try { originalText = await fetchAndExtractSub(subUrl); }
        catch (e) { return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n"; }

        const cues = extractCuesUniversal(originalText);
        if (!cues.length) return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n";

        const CHUNK = 80;
        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => {
                let t = c.text;
                if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) {
                    return `[${t}]`;
                }
                return t;
            });
            const translated = await translateChunkStrict(texts, keysArray, modelName);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) => postProcessTranslatedText(t, cues[idx]?.text));

        let srtOutput = '';
        let counter = 1;

        cues.forEach((c, idx) => {
            let text = finalTranslations[idx];
            if (!text) return;

            let plainText = text.replace(/<[^>]+>|\{[^}]+\}/g, '');
            if (!/[a-zA-Z0-9\u0600-\u06FF♪]/.test(plainText)) return;

            let sTime = c.start.replace('.', ',');
            let eTime = c.end.replace('.', ',');
            if (sTime.length === 10) sTime = '0' + sTime;
            if (eTime.length === 10) eTime = '0' + eTime;
            if (sTime.split(',')[1].length === 2) sTime += '0';
            if (eTime.split(',')[1].length === 2) eTime += '0';

            srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
            counter++;
        });

        if (srtOutput) {
            await setCachedTranslation(cacheKey, srtOutput);
        }

        return srtOutput;
    });
}

async function handleTranslationAss(subUrl, keysArray, modelName) {
    const cacheKey = buildCacheKey(subUrl, modelName, 'ass');
    let cached = await getCachedTranslation(cacheKey);
    if (cached) return cached;

    return await enqueueTranslation(async () => {
        cached = await getCachedTranslation(cacheKey);
        if (cached) return cached;

        let originalText = "";
        try { originalText = await fetchAndExtractSub(subUrl); }
        catch (e) { return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.`; }

        const cues = extractCuesUniversal(originalText);
        if (!cues.length) return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل استخراج النصوص.`;

        const CHUNK = 80;
        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => {
                let t = c.text;
                if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) {
                    return `[${t}]`;
                }
                return t;
            });
            const translated = await translateChunkStrict(texts, keysArray, modelName);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) => postProcessTranslatedText(t, cues[idx]?.text));

        const assLines = [];
        cues.forEach((c, idx) => {
            let text = finalTranslations[idx];
            if (!text) return;

            let plainText = text.replace(/<[^>]+>|\{[^}]+\}/g, '');
            if (!/[a-zA-Z0-9\u0600-\u06FF♪]/.test(plainText)) return;

            const safeText = text.trim().replace(/\n/g, '\\N');
            assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${safeText}`);
        });

        const assOutput = ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';

        if (assLines.length) {
            await setCachedTranslation(cacheKey, assOutput);
        }

        return assOutput;
    });
}

module.exports = {
    handleTranslationSrt,
    handleTranslationAss,
    normalizeLineBreakArtifacts,
    parseRobustJsonArray,
    applyLineLengthFallback,
    stripEmptyDialogueLines,
    postProcessTranslatedText
};
