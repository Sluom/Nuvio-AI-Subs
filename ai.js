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

const MAX_SAFE_LINE_CHARS = 48;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SPLIT_CHUNK_SIZE = 5;
const CHUNK_SIZE = 80;

// ---- Tuning knobs ----
const MAX_CONCURRENCY = 30;         // هجوم شامل: 30 دفعة متوازية تستوعب كل مفاتيحك الـ 25 دفعة وحدة
const MAX_HTTP_ATTEMPTS = 5;        // محاولات لكل دفعة
const REQUEST_TIMEOUT_MS = 45000;

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

function isTranslationCacheable(cues, finalTranslations) {
    let needed = 0;
    let failed = 0;
    let arabic = 0;

    cues.forEach((c, idx) => {
        const t = finalTranslations[idx];
        if (!t || String(t).trim() === '') { failed++; return; }
        if (/[A-Za-z]/.test(c.text)) {
            needed++;
            if (/[\u0600-\u06FF]/.test(t)) arabic++;
        }
    });

    if (failed > 0) return false;
    if (needed === 0) return true;
    return (arabic / needed) >= 0.9;
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

function splitLongLineAtMidpoint(line, maxChars = MAX_SAFE_LINE_CHARS) {
    if (line.length <= maxChars) return line;
    const middle = Math.floor(line.length / 2);
    let splitIndex = -1;
    for (let i = middle; i < line.length; i++) {
        if (line[i] === ' ') { splitIndex = i; break; }
    }
    if (splitIndex === -1) {
        for (let i = middle; i >= 0; i--) {
            if (line[i] === ' ') { splitIndex = i; break; }
        }
    }
    if (splitIndex !== -1) {
        return line.slice(0, splitIndex) + '\n' + line.slice(splitIndex + 1);
    }
    return line;
}

function applyLineLengthFallback(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const processedLines = lines.map(line => {
        if (line.length > MAX_SAFE_LINE_CHARS) {
            return splitLongLineAtMidpoint(line);
        }
        return line;
    });
    return processedLines.join('\n');
}

function postProcessTranslatedText(txt, originalText) {
    let text = normalizeLineBreakArtifacts(txt);
    text = applyLineLengthFallback(text);
    return text.trim();
}

function fixMusicNote(s) {
    return String(s || '').replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
}

function stripJsonFences(raw) {
    let clean = raw.trim();
    if (clean.startsWith('```json')) clean = clean.substring(7);
    else if (clean.startsWith('```')) clean = clean.substring(3);
    if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);
    return clean.trim();
}

function parseRobustJsonArray(raw, expectedLength) {
    if (!raw) return null;
    const clean = stripJsonFences(raw);

    try {
        const parsed = JSON.parse(clean);
        let arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));

        if (Array.isArray(arr) && arr.length === expectedLength) {
            return arr.map(x => fixMusicNote(x));
        }
    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        const validMatches = stringMatches.filter(s => s !== 'translations' && s !== 'data');

        if (validMatches.length === expectedLength) {
            return validMatches.map(s => fixMusicNote(s));
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

// ===================== API Key Pool (with cooldown) =====================

let currentKeyIndex = 0;
const keyCooldownUntil = new Map();

function coolDownKey(key, ms) {
    keyCooldownUntil.set(key, Date.now() + ms);
}

function acquireKey(keysArray) {
    if (!keysArray || keysArray.length === 0) return null;
    const n = keysArray.length;
    const now = Date.now();

    for (let i = 0; i < n; i++) {
        const key = keysArray[currentKeyIndex % n];
        currentKeyIndex = (currentKeyIndex + 1) % n;
        if ((keyCooldownUntil.get(key) || 0) <= now) return { key, waitMs: 0 };
    }

    let bestKey = keysArray[0];
    let bestTime = Infinity;
    for (const k of keysArray) {
        const t = keyCooldownUntil.get(k) || 0;
        if (t < bestTime) { bestTime = t; bestKey = k; }
    }
    return { key: bestKey, waitMs: Math.max(0, bestTime - now) };
}

function computeCooldownMs(errData) {
    let s = '';
    try { s = typeof errData === 'string' ? errData : JSON.stringify(errData || {}); } catch (e) { }
    if (/PerDay|per day|daily/i.test(s)) return 60 * 60 * 1000;
    
    // إجبار الكود على انتظار 61 ثانية لأي 429 لحماية المفاتيح
    const m = s.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (m) {
        const ms = (parseFloat(m[1]) + 1) * 1000;
        return Math.max(ms, 61000); 
    }
    return 61000; 
}

// ===================== Translation Engine =====================

async function translateChunkStrict(texts, keysArray, modelName) {
    let maxRetries = Math.min(keysArray.length, MAX_HTTP_ATTEMPTS);
    
    const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');
    const GEMINI_URL = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){cleanModelName}:generateContent`;

    const prompt = `Translate the following English subtitles to Arabic:

=== CRITICAL FORMATTING RULES ===
1. STRICT 1:1 ARRAY MAPPING (FATAL): You MUST return a JSON array with EXACTLY ${texts.length} strings. Never merge two lines into one. Never skip or drop a line. If an input line is empty, just a musical note (♪), or just punctuation (e.g., "..."), return it EXACTLY as is.
2. PRESERVE ORIGINAL SYMBOLS: Keep all HTML tags (like <i>, <b>, <font>).
3. LINE LENGTH CONTROL: If an English subtitle translates to a long Arabic line exceeding ${MAX_SAFE_LINE_CHARS} characters, insert exactly ONE line break (\\n) at a logical midpoint (e.g., after a comma).

=== CINEMATIC CONSTITUTION (PROFESSIONAL ENTITY FORMATTING) ===
4. ENTITY FORMATTING (CRITICAL): You MUST apply this formatting to the Arabic translation, even if the English text lacks it:
   - CITIES, COUNTRIES & COMPANIES: Enclose all names of cities, countries, and companies/brands in parentheses. (e.g., (نيويورك), (آبل), (لندن)).
   - NAMES & VOICEOVER: Enclose all people's names AND Voiceover (V.O.) / Narration text in standard double quotes "". (e.g., "جون", "في البداية كان...").
5. PROPER NOUNS: NEVER translate proper names of people, cities, or brands literally (e.g., 'Smith' stays "سميث", not "حداد").
6. SMART GENDER & PRONOUNS: Use clever phrasing to be GENDER-NEUTRAL whenever the gender is ambiguous. Avoid explicit pronouns (أنتَ/أنتِ) if a neutral verb or noun form works.
7. IDIOMS & SLANG: Translate the MEANING of English idioms, metaphors, and slang, NEVER word-for-word.
8. RELIGIOUS EXCLAMATIONS: Translate 'Jesus', 'Christ', 'Holy shit', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a prophet's name.
9. FOREIGN LANGUAGES: Translate tags like [speaks Spanish] to [يتحدث الإسبانية] AND translate any accompanying third-language text.
10. ON-SCREEN TEXT & EPILOGUES: Never summarize long blocks of text. Translate completely and accurately.

Output ONLY A VALID JSON ARRAY OF STRINGS.

Input array:
${JSON.stringify(texts)}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const acquired = acquireKey(keysArray);
        if (!acquired) return null;

        if (acquired.waitMs > 0) {
            console.log(`[Quota] Keys resting — waiting ${Math.ceil(acquired.waitMs / 1000)}s.`);
            await delay(acquired.waitMs);
        }

        const cleanKey = String(acquired.key).trim();

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
                    timeout: REQUEST_TIMEOUT_MS
                }
            );

            if (r.status === 200) {
                const responseText = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                const parsedArr = parseRobustJsonArray(responseText, texts.length);
                if (parsedArr && parsedArr.length === texts.length) {
                    console.log(`[Success] Translated chunk (${texts.length} lines) via Key: ...${cleanKey.slice(-4)}`);
                    return parsedArr;
                }
            }
            return null;

        } catch (e) {
            const status = e.response?.status;
            const errData = e.response?.data;

            if (status === 429) {
                const ms = computeCooldownMs(errData);
                coolDownKey(cleanKey, ms);
                console.log(`[429] Key ...${cleanKey.slice(-4)} resting ${Math.ceil(ms / 1000)}s.`);
                continue;
            }

            if (status === 401 || status === 403) {
                coolDownKey(cleanKey, 60 * 60 * 1000);
                continue;
            }

            if (attempt === maxRetries) {
                console.error(`[Error] Key ...${cleanKey.slice(-4)}: ${e.message}`);
                return null;
            }
            await delay(3000);
        }
    }
    return null;
}

async function translateChunkWithRecovery(texts, keysArray, modelName, depth = 0) {
    const direct = await translateChunkStrict(texts, keysArray, modelName);
    if (direct && direct.length === texts.length) {
        return direct;
    }

    if (texts.length <= MIN_SPLIT_CHUNK_SIZE) {
        console.warn(`[Recovery] Giving up on a minimal chunk of ${texts.length} line(s).`);
        return texts.map(() => null);
    }

    console.warn(`[Recovery - Depth ${depth}] Chunk of ${texts.length} failed — splitting in half.`);
    const mid = Math.ceil(texts.length / 2);
    const firstHalf = texts.slice(0, mid);
    const secondHalf = texts.slice(mid);

    const [firstResult, secondResult] = await Promise.all([
        translateChunkWithRecovery(firstHalf, keysArray, modelName, depth + 1),
        translateChunkWithRecovery(secondHalf, keysArray, modelName, depth + 1)
    ]);

    return [...firstResult, ...secondResult];
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
    return MAX_CONCURRENCY; // إجبار التزامن على الرقم 30 بغض النظر عن عدد المفاتيح
}

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

        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK_SIZE) chunks.push(cues.slice(i, i + CHUNK_SIZE));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => c.text);
            const translated = await translateChunkWithRecovery(texts, keysArray, modelName);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : null);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) =>
            t ? postProcessTranslatedText(t, cues[idx]?.text) : null
        );

        const cacheable = isTranslationCacheable(cues, finalTranslations);

        let srtOutput = '';
        let counter = 1;

        cues.forEach((c, idx) => {
            let text = finalTranslations[idx];

            if (!text || text.trim() === '') {
                text = c.text;
            } else {
                let plainText = text.replace(/<[^>]+>|\{[^}]+\}/g, '');
                if (!/[a-zA-Z0-9\u0600-\u06FF♪]/.test(plainText)) {
                    text = c.text;
                }
            }

            let sTime = c.start.replace('.', ',');
            let eTime = c.end.replace('.', ',');
            if (sTime.length === 10) sTime = '0' + sTime;
            if (eTime.length === 10) eTime = '0' + eTime;
            if (sTime.split(',')[1].length === 2) sTime += '0';
            if (eTime.split(',')[1].length === 2) eTime += '0';

            srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
            counter++;
        });

        if (srtOutput && cacheable) {
            await setCachedTranslation(cacheKey, srtOutput);
        } else if (srtOutput) {
            console.warn(`[Cache] SKIPPED for ${cacheKey} — translation incomplete.`);
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

        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK_SIZE) chunks.push(cues.slice(i, i + CHUNK_SIZE));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => c.text);
            const translated = await translateChunkWithRecovery(texts, keysArray, modelName);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : null);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) =>
            t ? postProcessTranslatedText(t, cues[idx]?.text) : null
        );

        const cacheable = isTranslationCacheable(cues, finalTranslations);

        const assLines = [];
        cues.forEach((c, idx) => {
            let text = finalTranslations[idx];

            if (!text || text.trim() === '') {
                text = c.text;
            } else {
                let plainText = text.replace(/<[^>]+>|\{[^}]+\}/g, '');
                if (!/[a-zA-Z0-9\u0600-\u06FF♪]/.test(plainText)) {
                    text = c.text;
                }
            }

            const safeText = text.trim().replace(/\n/g, '\\N');
            assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${safeText}`);
        });

        const assOutput = ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';

        if (assLines.length && cacheable) {
            await setCachedTranslation(cacheKey, assOutput);
        } else if (assLines.length) {
            console.warn(`[Cache] SKIPPED for ${cacheKey} — translation incomplete.`);
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
    postProcessTranslatedText,
    translateChunkWithRecovery
};
