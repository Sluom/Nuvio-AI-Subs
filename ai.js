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
const CHUNK_SIZE = 80;

// ---- Tuning knobs ----
// لا يوجد أي معالجة متوازية (لا Concurrency، لا Pool، لا Pause جماعي).
// كل جزء (chunk) يُترجم بعد ما يخلص اللي قبله، بالتتابع، بدون أي تزامن بين الأسطر.
const MAX_RECOVERY_ROUNDS = 3;       // إعادة الطلب فقط للأسطر الناقصة (بدون تقسيم الجزء نفسه)
const RATE_LIMIT_COOLDOWN_MS = 60000; // إذا جوجل ما حددت مدة انتظار (retryDelay)، نعتبرها دقيقة كاملة (حد الحصة المجانية يتصفر كل دقيقة عادةً)
const REQUEST_TIMEOUT_MS = 45000;
const USE_RESPONSE_SCHEMA = true;    // اجعلها false لو الـ API رفض الـ schema بخطأ 400

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

function buildChunkCacheKey(texts, modelName) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 32);
    return `chunk:${hash}:${modelName || 'default'}`;
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

// نفس فكرة الدالة فوق، لكن لجزء واحد (تُستخدم لكاش الجزء الفردي)
function chunkLooksTranslated(texts, translated) {
    let needed = 0;
    let arabic = 0;
    for (let i = 0; i < texts.length; i++) {
        const t = translated[i];
        if (!t || String(t).trim() === '') return false;
        if (/[A-Za-z]/.test(texts[i])) {
            needed++;
            if (/[\u0600-\u06FF]/.test(t)) arabic++;
        }
    }
    return needed === 0 || (arabic / needed) >= 0.9;
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

// موجودة للتوافق مع الاستدعاءات القديمة (مُصدَّرة). المحرك الحالي يستخدم parseIndexedTranslations.
function parseRobustJsonArray(raw, expectedLength) {
    if (!raw) return null;
    const clean = stripJsonFences(raw);

    try {
        const parsed = JSON.parse(clean);
        let arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));

        if (Array.isArray(arr) && arr.length === expectedLength) {
            return arr.map(x => fixMusicNote(x));
        }
        throw new Error("Length mismatch");
    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        const validMatches = stringMatches.filter(s => s !== 'translations' && s !== 'data');

        if (validMatches.length === expectedLength) {
            return validMatches.map(s => fixMusicNote(s));
        }
        console.error(`[ParseFailure] Strict 1:1 mapping failed. Expected ${expectedLength}, got ${stringMatches.length} raw / ${validMatches.length} valid.`);
    }
    return null;
}

// يحلل [{"i":0,"t":"..."}, ...] إلى مصفوفة بطول expectedLength.
// الأسطر اللي تجاهلها النموذج تبقى null، عشان بس هذي الأسطر تُطلب مرة ثانية.
function parseIndexedTranslations(raw, expectedLength) {
    if (!raw) return null;
    const clean = stripJsonFences(raw);
    const out = new Array(expectedLength).fill(null);
    let found = 0;

    let parsed;
    try {
        parsed = JSON.parse(clean);
    } catch (e) {
        // JSON مقطوع أو مكسور جزئياً: ننقذ أي زوج {"i":N,"t":"..."} كامل موجود
        for (const m of clean.matchAll(/"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
            const idx = parseInt(m[1], 10);
            if (idx >= 0 && idx < expectedLength && out[idx] === null) {
                try {
                    const val = JSON.parse(`"${m[2]}"`);
                    if (String(val).trim() !== '') { out[idx] = fixMusicNote(val); found++; }
                } catch (e2) { }
            }
        }
        return found > 0 ? out : null;
    }

    const arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || null);
    if (!Array.isArray(arr) || arr.length === 0) return null;

    // النموذج تجاهل صيغة الـ id ورجّع نصوصاً عادية: نقبلها بس لو العدد يطابق تماماً
    if (typeof arr[0] !== 'object' || arr[0] === null) {
        if (arr.length === expectedLength) return arr.map(x => fixMusicNote(x));
        return null;
    }

    for (const item of arr) {
        if (!item) continue;
        const idx = Number(item.i);
        if (Number.isInteger(idx) && idx >= 0 && idx < expectedLength
            && typeof item.t === 'string' && item.t.trim() !== '' && out[idx] === null) {
            out[idx] = fixMusicNote(item.t);
            found++;
        }
    }
    return found > 0 ? out : null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let currentKeyIndex = 0;
function getNextApiKey(keysArray) {
    if (!keysArray || keysArray.length === 0) return null;
    const key = keysArray[currentKeyIndex % keysArray.length];
    currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
    return key;
}

// ===================== API Key Pool (with cooldown) =====================

const keyCooldownUntil = new Map(); // key -> timestamp (ms) إلى متى المفتاح "مستريح"

function coolDownKey(key, ms) {
    keyCooldownUntil.set(key, Date.now() + ms);
}

// يرجع أقرب مفتاح سليم (round-robin). لو كل المفاتيح مستريحة، يرجع أقربها استعداداً
// مع مدة الانتظار اللازمة (بدون أي حد أقصى — ننتظر مهما طالت المدة).
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
    // حصة يومية خلصت: ما فايدة نجرب هذا المفتاح قريب
    if (/PerDay|per day|daily/i.test(s)) return 60 * 60 * 1000;
    // جوجل حددت مدة انتظار صريحة بالرد (retryDelay) — نحترمها بالضبط
    const m = s.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (m) {
        const ms = (parseFloat(m[1]) + 1) * 1000;
        return Math.min(Math.max(ms, 5000), 10 * 60 * 1000);
    }
    // ما فيه retryDelay بالرد: نفترض حد الحصة بالدقيقة (المعيار الشائع بالخطة المجانية)
    // ونعطي المفتاح دقيقة كاملة راحة بدل تجربته كل ثواني قليلة بلا فايدة
    return RATE_LIMIT_COOLDOWN_MS;
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

        const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent`;

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

// ===================== Translation Engine =====================

const RESPONSE_SCHEMA = {
    type: "ARRAY",
    items: {
        type: "OBJECT",
        properties: {
            i: { type: "INTEGER" },
            t: { type: "STRING" }
        },
        required: ["i", "t"]
    }
};

function buildTranslationPrompt(texts, genderMap) {
    const genderMapBlock = formatGenderMapForPrompt(genderMap);
    const items = texts.map((t, i) => ({ i, t }));

    return `Translate the following subtitles while:
1. STRICT 1:1 MAPPING BY ID (CRITICAL): The input is a JSON array of ${texts.length} objects {"i": <id>, "t": "<english text>"}. Return a JSON array with EXACTLY one object {"i": <same id>, "t": "<arabic translation>"} for every input object. Never merge, skip, split or reorder lines. Every id must appear exactly once.
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language.
3. Preserving any formatting tags or special characters.
4. PROFESSIONAL ARABIC FORMATTING (Netflix-style subtitling convention — CRITICAL, apply to every line):
   a) Wrap every city, company, and country name in Arabic parentheses ( ) — e.g. (باريس), (شركة سامسونج), (اليابان).
   b) Wrap every personal name AND any voice-over / off-screen narration line in Arabic quotation marks "" — e.g. "سارة", "صوت الراوي".
   c) If the original English text already has brackets [], parentheses (), or quotation marks "" for a different reason (a sound/action cue, an on-screen text quote), keep those exactly as they are, in the same position, in addition to applying (a) and (b).
   d) Never use square brackets [] for names, cities, companies, or countries — [] is reserved only for sound/action cues already present in the source (e.g. [door creaks]).
5. Apply professional Arabic subtitling conventions for punctuation.
6. LINE LENGTH CONTROL (CRITICAL): If an English subtitle is a single long line, translate it as a single Arabic line UNLESS it exceeds ${MAX_SAFE_LINE_CHARS} characters. If it is too long, insert exactly ONE line break (\\n) at a logical midpoint (e.g. after a comma or conjunction). If the original text already contains a line break (\\n), PRESERVE IT in the exact same logical place in the Arabic translation.
7. CRITICAL GENDER ENFORCEMENT & DYNAMIC CONTEXT: Treat this chunk as a continuous cinematic scene. Use the provided GENDER MAP to deduce who is participating in the conversation.
   - If the dialogue is a clear back-and-forth between a male and a female, dynamically alternate the Arabic pronouns to match the conversation flow.
   - NEUTRAL EVASION: If the gender of the speaker/listener is completely ambiguous and cannot be logically deduced from the scene's flow or the Gender Map, formulate the Arabic translation to be naturally GENDER-NEUTRAL whenever possible (e.g., rephrase using passive voice or verbal nouns to avoid explicit أنتَ/أنتِ). ${genderMapBlock}
8. Pay close attention to split sentences. Ensure the Arabic grammar flows logically.

=== CINEMATIC CONSTITUTION (CRITICAL RULES) ===
9. RELIGIOUS EXCLAMATIONS: Translate words like 'Jesus', 'Christ', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a person's name.
10. EPILOGUES & LONG TEXTS: Never ignore, skip, or summarize long blocks of on-screen text (like true-story epilogues). Translate them completely and accurately.
11. FOREIGN LANGUAGES: If dialogue is in a third language (e.g., 'Amigo') or has a tag (e.g., [speaks Spanish]), translate BOTH the tag and the actual meaning entirely into Arabic (e.g., [يتحدث الإسبانية] يا صديقي). Leave NO English or foreign text behind.
12. PROFANITY: Translate swear words into standard cinematic Arabic equivalents without literal awkwardness.

Output ONLY A VALID JSON ARRAY of {"i": <id>, "t": "<translation>"} objects, nothing else.

Content to translate:
${JSON.stringify(items)}`;
}

/**
 * طلب واحد (يدور على المفاتيح لو فشل). ما فيه أي تزامن أو تعدد طلبات هنا —
 * هذه الدالة نفسها تُستدعى مرة وحدة بمرة، بالتتابع.
 * يرجع { status, data } حيث:
 *   status: 'ok'    -> data مصفوفة (طولها = texts.length)؛ الأسطر الناقصة null
 *           'parse' -> رد وصل لكن ما نقدر نقرأه (المتصل ممكن يعيد الطلب)
 *           'quota' -> كل المفاتيح جربناها بهالدورة ولا وحدة نجحت
 *           'error' -> خطأ غير قابل لإعادة المحاولة
 */
async function translateChunkStrict(texts, keysArray, modelName, genderMap = null) {
    if (!Array.isArray(keysArray) || keysArray.length === 0) {
        console.error("[Fatal] No Gemini API Keys configured!");
        return { status: 'error', data: null };
    }

    const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent`;
    const prompt = buildTranslationPrompt(texts, genderMap);

    const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };
    if (USE_RESPONSE_SCHEMA) generationConfig.responseSchema = RESPONSE_SCHEMA;

    let serverErrors = 0;
    // أول طلب يحق له يجرب كل مفتاح من مفاتيحك (بدون أي حد أصغر) قبل ما نستسلم
    const maxAttempts = keysArray.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const acquired = acquireKey(keysArray);
        if (!acquired) return { status: 'error', data: null };

        // ما فيه أي حد أقصى للانتظار — لو كل المفاتيح مستريحة، ننتظر أقربها مهما طالت المدة
        if (acquired.waitMs > 0) {
            console.log(`[Cooldown] All keys resting — waiting ${Math.ceil(acquired.waitMs / 1000)}s for Key ...${String(acquired.key).slice(-4)} to free up.`);
            await delay(acquired.waitMs);
        }

        const cleanKey = String(acquired.key).trim();

        try {
            const r = await axios.post(
                GEMINI_URL,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig,
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

            const responseText = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            const parsedArr = parseIndexedTranslations(responseText, texts.length);
            if (parsedArr) {
                const got = parsedArr.filter(Boolean).length;
                console.log(`[Success] ${got}/${texts.length} lines with ${cleanModelName} via Key: ...${cleanKey.slice(-4)}`);
                return { status: 'ok', data: parsedArr };
            }
            console.warn(`[Parse] Unreadable reply from Key ...${cleanKey.slice(-4)}.`);
            return { status: 'parse', data: null };

        } catch (e) {
            const status = e.response?.status;
            const errData = e.response?.data;
            const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';

            if (status === 429) {
                console.log('[429 body]', cleanKey.slice(-4), JSON.stringify(errData || e.message).slice(0, 700));
                const ms = computeCooldownMs(errData);
                coolDownKey(cleanKey, ms);
                console.log(`[429] Key ...${cleanKey.slice(-4)} resting ${Math.ceil(ms / 1000)}s. Switching key (attempt ${attempt + 1}/${maxAttempts}).`);
                continue;
            }

            if (status === 401 || status === 403) {
                coolDownKey(cleanKey, 60 * 60 * 1000);
                console.error(`[Auth] Key ...${cleanKey.slice(-4)} rejected (${status}). Resting it for 1h.`);
                continue;
            }

            if ((status >= 500) || isTimeout) {
                console.log('[5xx body]', status || e.code, JSON.stringify(errData || e.message).slice(0, 300));
                serverErrors++;
                const delayMs = Math.min(2000 * Math.pow(2, serverErrors - 1), 12000);
                console.log(`[Retry ${attempt + 1}/${maxAttempts}] ${status || e.code} on Key ...${cleanKey.slice(-4)}. Waiting ${delayMs}ms.`);
                await delay(delayMs);
                continue;
            }

            console.error(`[Gemini Error - Final] Key ...${cleanKey.slice(-4)}: ${errData?.error?.message || e.message}`);
            return { status: 'error', data: null };
        }
    }

    return { status: 'quota', data: null };
}

/**
 * يترجم جزء واحد. الأسطر اللي ترجع ناقصة تُعاد فقط هي (بدون تقسيم الجزء لنصفين)،
 * فعدد الطلبات ما يتضاعف أبداً. يرجع مصفوفة بطول texts.length، وnull للسطر اللي فشل نهائياً.
 */
async function translateChunkWithRecovery(texts, keysArray, modelName, genderMap) {
    const results = new Array(texts.length).fill(null);
    let pending = texts.map((_, i) => i);

    for (let round = 0; round < MAX_RECOVERY_ROUNDS && pending.length > 0; round++) {
        const subTexts = pending.map(i => texts[i]);
        const res = await translateChunkStrict(subTexts, keysArray, modelName, genderMap);

        if (res.data) {
            pending.forEach((origIdx, k) => {
                if (res.data[k]) results[origIdx] = res.data[k];
            });
        }

        pending = pending.filter(i => results[i] === null);

        if (res.status === 'quota' || res.status === 'error') break;

        if (pending.length > 0) {
            console.warn(`[Recovery] Round ${round + 1}: ${pending.length} line(s) still missing — re-asking only those.`);
        }
    }

    if (pending.length > 0) {
        console.warn(`[Recovery] ${pending.length} line(s) could not be translated — will fall back to original text for just these.`);
    }
    return results;
}

// يغلّف الاسترجاع بكاش لكل جزء، عشان الملف اللي فشل جزئياً يعيد بس اللي ناقص.
async function translateChunkCached(texts, keysArray, modelName, genderMap) {
    const key = buildChunkCacheKey(texts, modelName);
    const cached = await getCachedTranslation(key);
    if (Array.isArray(cached) && cached.length === texts.length) return cached;

    const result = await translateChunkWithRecovery(texts, keysArray, modelName, genderMap);
    if (chunkLooksTranslated(texts, result)) {
        await setCachedTranslation(key, result);
    }
    return result;
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

        // معالجة تتابعية بحتة: جزء واحد بمرة وحدة. ما نبدأ بالجزء التالي إلا بعد
        // ما يخلص اللي قبله تماماً — صفر تزامن بين الأسطر أو الأجزاء.
        const rawTranslations = [];
        for (const chunk of chunks) {
            const texts = chunk.map(c => c.text);
            const translated = await translateChunkCached(texts, keysArray, modelName, genderMap);
            chunk.forEach((_, idx) => {
                rawTranslations.push(translated && translated[idx] ? translated[idx] : null);
            });
        }

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
            console.warn(`[Cache] SKIPPED for ${cacheKey} — translation incomplete (some lines failed or stayed non-Arabic). Not saving to MongoDB.`);
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

        // نفس المبدأ: جزء واحد بمرة وحدة، بالتتابع، بدون أي تزامن.
        const rawTranslations = [];
        for (const chunk of chunks) {
            const texts = chunk.map(c => c.text);
            const translated = await translateChunkCached(texts, keysArray, modelName, genderMap);
            chunk.forEach((_, idx) => {
                rawTranslations.push(translated && translated[idx] ? translated[idx] : null);
            });
        }

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
            console.warn(`[Cache] SKIPPED for ${cacheKey} — translation incomplete (some lines failed or stayed non-Arabic). Not saving to MongoDB.`);
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
