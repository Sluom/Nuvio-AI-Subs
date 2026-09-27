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

const MAX_SAFE_LINE_CHARS = 48; // الحد الأقصى لعدد الأحرف في السطر الواحد
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SPLIT_CHUNK_SIZE = 5;
const CHUNK_SIZE = 48; // حجم الدفعة المثالي لتقليل الحمل المعرفي

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

function splitLongLineAtMidpoint(line, maxChars = MAX_SAFE_LINE_CHARS) {
    if (line.length <= maxChars) return line;
    const middle = Math.floor(line.length / 2);
    let splitIndex = -1;
    // البحث عن أقرب مسافة للوسط
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
                let txt = String(x || '');
                return txt.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
            });
        }
        throw new Error("Length mismatch");
    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        const validMatches = stringMatches.filter(s => s !== 'translations' && s !== 'data');

        if (validMatches.length === expectedLength) {
            return validMatches.map(s => s.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪'));
        }
        console.error(`[ParseFailure] Strict 1:1 mapping failed. Expected ${expectedLength}, got ${stringMatches.length} raw / ${validMatches.length} valid.`);
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

// ===================== Character Gender Map Extraction =====================

async function extractCharacterGenderMap(cues, keysArray, modelName) {
    if (!cues || !cues.length) return null;

    const fullText = cues.map(c => c.text).join('\n');
    const sample = fullText;

    const prompt = `You are analyzing an English subtitle script to identify character names and their genders, to help a downstream Arabic translation system apply correct gender-specific grammar consistently across the whole file.

Read the following subtitle text and identify every character/person name that appears (real proper names of people only — never places, food, brands, or objects). For each name, determine the character's gender (male or female) using any contextual clues found ANYWHERE in the text.

Rules:
- Only include actual person names.
- Merge obvious variants of the same character into one entry.
- If a name appears with zero gender clues anywhere in the text, still include it with your best guess, or "unknown".
- Do NOT include narration-only labels or on-screen text placeholders.

Output ONLY a valid JSON array of objects, nothing else, no explanations, in this exact format:
[{"name": "JOHN", "gender": "male"}, {"name": "SARAH", "gender": "female"}]

Subtitle text:
${sample}`;

    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const activeKey = getNextApiKey(keysArray);
        if (!activeKey) return null;

        const cleanKey = String(activeKey).trim();
        const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');
        const GEMINI_URL = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){cleanModelName}:generateContent`;

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
                    timeout: 20000
                }
            );

            const responseText = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!responseText) continue;

            let clean = responseText.trim();
            if (clean.startsWith('```json')) clean = clean.slice(7);
            else if (clean.startsWith('```')) clean = clean.slice(3);
            if (clean.endsWith('```')) clean = clean.slice(0, -3);
            clean = clean.trim();

            const parsed = JSON.parse(clean);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const map = {};
                for (const entry of parsed) {
                    if (entry?.name && entry?.gender) {
                        map[String(entry.name).trim().toUpperCase()] = String(entry.gender).trim().toLowerCase();
                    }
                }
                if (Object.keys(map).length > 0) {
                    console.log(`[GenderMap] Extracted ${Object.keys(map).length} character(s)`);
                    return map;
                }
            }
        } catch (e) {
            console.error(`[GenderMap] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed.`);
        }
    }

    console.warn('[GenderMap] Extraction failed — proceeding without a gender map.');
    return null;
}

function formatGenderMapForPrompt(genderMap) {
    if (!genderMap || Object.keys(genderMap).length === 0) return '';
    const lines = Object.entries(genderMap).map(([name, gender]) => `   - ${name} = ${gender}`);
    return `\n\n   KNOWN CHARACTER GENDER MAP:\n${lines.join('\n')}\n`;
}

async function translateChunkStrict(texts, keysArray, modelName, genderMap = null) {
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

        const genderMapBlock = formatGenderMapForPrompt(genderMap);

        const prompt = `Translate the following subtitles while:
1. STRICT 1:1 ARRAY MAPPING (CRITICAL): The output JSON array MUST have exactly ${texts.length} elements — one output string per input string. Never merge or skip lines.
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language.
3. Preserving any formatting tags or special characters.
4. Translate any text inside brackets [] or parentheses () into Arabic professionally while strictly keeping the original brackets/parentheses in the output.
5. Apply professional Arabic subtitling conventions for punctuation.
6. LINE LENGTH CONTROL (CRITICAL): If an English subtitle is a single long line, translate it as a single Arabic line UNLESS it exceeds ${MAX_SAFE_LINE_CHARS} characters. If it is too long, insert exactly ONE line break (\\n) at a logical midpoint (e.g. after a comma or conjunction). If the original text already contains a line break (\\n), PRESERVE IT in the exact same logical place in the Arabic translation.
7. CRITICAL GENDER ENFORCEMENT & DYNAMIC CONTEXT: Treat this chunk as a continuous cinematic scene. Use the provided GENDER MAP to deduce who is participating in the conversation.
   - If the dialogue is a clear back-and-forth between a male and a female, dynamically alternate the Arabic pronouns to match the conversation flow.
   - NEUTRAL EVASION: If the gender of the speaker/listener is completely ambiguous and cannot be logically deduced from the scene's flow or the Gender Map, formulate the Arabic translation to be naturally GENDER-NEUTRAL whenever possible (e.g., rephrase using passive voice or verbal nouns to avoid explicit أنتَ/أنتِ). ${genderMapBlock}
8. Pay close attention to split sentences. Ensure the Arabic grammar flows logically.

=== CINEMATIC CONSTITUTION (CRITICAL RULES) ===
9. RELIGIOUS EXCLAMATIONS: Translate words like 'Jesus', 'Christ', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a person's name.
10. ACRONYMS, AGENCIES & ENTITIES (STRICT ARABIZATION):
    - TRANSLATE ALL government, military, medical, and scientific acronyms (e.g., FBI, CIA, SWAT, TAT, DNA, BAU, NSA) into their FULL and official Arabic meanings (e.g., المباحث الفدرالية، وكالة المخابرات المركزية، القوات الخاصة، اختبار الإدراك الموضوعي، الحمض النووي).
    - ABSOLUTELY NO ENGLISH LETTERS for agencies or scientific acronyms.
    - If a highly obscure acronym cannot be translated to a meaning, transliterate it phonetically using ARABIC letters ONLY (e.g., output 'تي إيه تي' instead of 'TAT').
    - Only purely commercial global brands (e.g., Apple, KFC) may remain in English if transliteration is awkward, but Arabic letters are always preferred.

11. EPILOGUES & LONG TEXTS: Never ignore, skip, or summarize long blocks of on-screen text (like true-story epilogues). Translate them completely and accurately.
12. FOREIGN LANGUAGES: If dialogue is in a third language (e.g., 'Amigo') or has a tag (e.g., [speaks Spanish]), translate BOTH the tag and the actual meaning entirely into Arabic (e.g., [يتحدث الإسبانية] يا صديقي). Leave NO English or foreign text behind.
13. SARCASM & GENDER FLIPPING: Follow the GENDER MAP strictly, EXCEPT when a character intentionally uses the wrong gender to insult or mock someone. In cases of deliberate sarcasm/insult, preserve the insulting gendered conjugation.
14. FORMALITY & HONORIFICS: Observe the status of the characters. When addressing figures of authority (judges, bosses, royalty), use formal Arabic equivalents (e.g., سيدي، حضرتك، جلالتك) instead of the casual 'أنت'.
15. IDIOMS & WORDPLAY: Do not translate English idioms or jokes literally. Use the closest culturally appropriate Arabic idiom.
16. FILLER WORDS: When encountering fillers like 'Umm', 'Uh', or 'Ah' as standalone dialogue, do not translate them literally. Replace them with natural Arabic conversational responses like 'حسناً', 'أجل', 'تمام', or 'واو' depending on context. Never return an empty line.
17. SONGS & POETRY: If a line contains the music symbol '♪', keep the symbol at the start/end and translate the lyrics poetically rather than literally.
18. PROFANITY: Translate swear words into standard cinematic Arabic equivalents without literal awkwardness.

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
                    console.log(`[Success] Translated chunk (${texts.length} lines) with ${cleanModelName} via Key: ...${cleanKey.slice(-4)}`);
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

async function translateChunkWithRecovery(texts, keysArray, modelName, genderMap) {
    const direct = await translateChunkStrict(texts, keysArray, modelName, genderMap);
    if (direct && direct.length === texts.length) {
        return direct;
    }

    if (texts.length <= MIN_SPLIT_CHUNK_SIZE) {
        console.warn(`[Recovery] Giving up on a minimal chunk of ${texts.length} line(s) — will fall back to original text for just these.`);
        return texts.map(() => null);
    }

    console.warn(`[Recovery] Chunk of ${texts.length} failed — splitting in half and retrying each half.`);
    const mid = Math.ceil(texts.length / 2);
    const firstHalf = texts.slice(0, mid);
    const secondHalf = texts.slice(mid);

    const [firstResult, secondResult] = await Promise.all([
        translateChunkWithRecovery(firstHalf, keysArray, modelName, genderMap),
        translateChunkWithRecovery(secondHalf, keysArray, modelName, genderMap)
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

        const genderMap = await extractCharacterGenderMap(cues, keysArray, modelName);

        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK_SIZE) chunks.push(cues.slice(i, i + CHUNK_SIZE));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => {
                let t = c.text;
                if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) {
                    return `[${t}]`;
                }
                return t;
            });
            const translated = await translateChunkWithRecovery(texts, keysArray, modelName, genderMap);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : null);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) =>
            t ? postProcessTranslatedText(t, cues[idx]?.text) : null
        );

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

        const genderMap = await extractCharacterGenderMap(cues, keysArray, modelName);

        const chunks = [];
        for (let i = 0; i < cues.length; i += CHUNK_SIZE) chunks.push(cues.slice(i, i + CHUNK_SIZE));

        const tasks = chunks.map(chunk => async () => {
            const texts = chunk.map(c => {
                let t = c.text;
                if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) {
                    return `[${t}]`;
                }
                return t;
            });
            const translated = await translateChunkWithRecovery(texts, keysArray, modelName, genderMap);
            return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : null);
        });

        const chunkResults = await runConcurrentPool(tasks, resolvePoolLimit(keysArray));
        const rawTranslations = chunkResults.flat();
        const finalTranslations = rawTranslations.map((t, idx) =>
            t ? postProcessTranslatedText(t, cues[idx]?.text) : null
        );

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
    postProcessTranslatedText,
    extractCharacterGenderMap,
    formatGenderMapForPrompt,
    translateChunkWithRecovery
};
