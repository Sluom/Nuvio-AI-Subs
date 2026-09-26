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
const ARABIC_SAFE_LINE_CHARS = 42; // تم التعديل إلى 50 حسب طلبك
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // أسبوع

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
 * يقسم سطر عربي طويل لعدة أسطر حقيقية (\n) عند حدود الكلمات، بحيث ما تحتاج
 * أي تطبيق عرض auto-wrap لهالسطر — يشتغل بشكل مستقل عن أي منطق RTL بجانب
 * التطبيق، لأن \n (عكس رموز RLE/PDF) لا يُحذف أو يُتجاهل من أي مشغل.
 */
function splitArabicLineAtWordBoundaries(text, maxChars = ARABIC_SAFE_LINE_CHARS) {
    if (!text || text.length <= maxChars) return text;

    const segments = [];
    let segmentStart = 0;
    let lastSpaceIndex = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') lastSpaceIndex = i;
        if (i - segmentStart >= maxChars) {
            if (lastSpaceIndex > segmentStart) {
                segments.push(text.slice(segmentStart, lastSpaceIndex));
                segmentStart = lastSpaceIndex + 1;
                lastSpaceIndex = -1;
            }
            // لو ما فيه مسافة جوا الحد (كلمة طويلة جدًا)، نكمل بدون قطع نصها.
        }
    }
    if (segmentStart < text.length) {
        segments.push(text.slice(segmentStart));
    }
    return segments.join('\n');
}

/**
 * يطبّق التقسيم الآمن على كل سطر منطقي بالنص المترجم (لا يلمس الأسطر
 * المفصولة أصلاً بحوار شخصين أو نص شاشي — كل وحدة تتعالج لحالها)، فقط
 * لو النص يحتوي حروف عربية.
 */
function applyRtlSafeLineSplit(text) {
    if (!text) return text;
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    if (!hasArabic) return text;
    return text
        .split('\n')
        .map(line => splitArabicLineAtWordBoundaries(line))
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
    text = applyRtlSafeLineSplit(text);
    return text.trim();
}

/**
 * يحاول يحلّل استجابة Gemini كـ JSON array من النصوص.
 * أولوية أولى: JSON.parse سليم. لو فشل، fallback عن طريق regex يمسك النصوص
 * بين علامات تنصيص — لكن يرفض أي "ترجمة" هي بس علامات ترقيم (فاصلة، نقطة...)
 * بدون أي حرف فعلي، ويشترط تطابق شبه كامل بالعدد (90%+) قبل ما يقبل النتيجة.
 * لو ما وصلنا لهذا الحد، يرجّع null — وهذا يخلي الكود الأعلى يستخدم النص
 * الإنجليزي الأصلي بدل ما يعرض فواصل فاضية.
 */
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
                return txt.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
            });
        }

    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        const validMatches = stringMatches
            .filter(s => s !== 'translations' && s !== 'data')
            .filter(s => /[a-zA-Z0-9\u0600-\u06FF]/.test(s));

        if (validMatches.length >= expectedLength * 0.9) {
            return validMatches.map(s => s.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪'));
        }

        console.error(
            `[ParseFailure] Fallback regex got ${stringMatches.length}/${expectedLength} raw matches, ` +
            `only ${validMatches.length} valid (non-punctuation). Rejecting chunk — will fall back to original text.`
        );
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

// ===================== Character Gender Map Extraction (NEW) =====================

/**
 * يسوي استدعاء واحد فقط لكامل الملف (قبل التقسيم لأجزاء) يطلع منه قائمة
 * أسماء الشخصيات وجنس كل وحدة منها، بالاعتماد على كل الأدلة المتوفرة بكامل
 * النص (مو بس جزء صغير معزول). هذا يحل مشكلة "الشخصية تتكرر بجزء بعيد بدون
 * أي دليل جنس جديد" لأن الجنس يصير معروف مسبقًا وثابت لكل الأجزاء.
 *
 * يرجّع Object زي: { "SARAH": "female", "JOHN": "male" } أو null لو فشل
 * الاستخراج (وبهذي الحالة يرجع الكود الأعلى يشتغل بدون خارطة، زي الوضع
 * القديم بالضبط — ما فيه أي كسر بالوظيفة الأساسية).
 */
async function extractCharacterGenderMap(cues, keysArray, modelName) {
    if (!cues || !cues.length) return null;

    const fullText = cues.map(c => c.text).join('\n');
    // بدون أي قص: نافذة السياق الكبيرة عند Gemini تسمح بقراءة نص الفلم كامل
    // (حتى أطول فلم لا يتجاوز عادة 50-70 ألف حرف)، فالخارطة تصير شاملة
    // (Global) لكل شخصيات الفلم من أول ثانية لآخر ثانية.
    const sample = fullText;

    const prompt = `You are analyzing an English subtitle script to identify character names and their genders, to help a downstream Arabic translation system apply correct gender-specific grammar consistently across the whole file.

Read the following subtitle text and identify every character/person name that appears (real proper names of people only — never places, food, brands, or objects). For each name, determine the character's gender (male or female) using any contextual clues found ANYWHERE in the text (pronouns near the name, titles like Mr./Mrs./Sir/Ma'am, relationship words like wife/husband/sister/brother/girlfriend/boyfriend, dialogue addressed to them, etc).

Rules:
- Only include actual person names.
- Merge obvious variants of the same character into one entry (e.g. "John" and "JOHN" and "Johnny" if clearly the same person) using the most common form as the name.
- If a name appears with zero gender clues anywhere in the text, still include it with your best guess based on common name/gender association, or "unknown" if truly ambiguous.
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
                    console.log(`[GenderMap] Extracted ${Object.keys(map).length} character(s): ${Object.keys(map).join(', ')}`);
                    return map;
                }
            }
        } catch (e) {
            console.error(`[GenderMap] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.response?.data?.error?.message || e.message}`);
        }
    }

    console.warn('[GenderMap] Extraction failed — proceeding without a gender map (fallback to per-chunk inference).');
    return null;
}

/** يحوّل خارطة الأسماء/الجنس إلى نص جاهز للحقن داخل نقطة 8 بالبرومنت. */
function formatGenderMapForPrompt(genderMap) {
    if (!genderMap || Object.keys(genderMap).length === 0) return '';
    const lines = Object.entries(genderMap).map(([name, gender]) => `   - ${name} = ${gender}`);
    return `

   KNOWN CHARACTER GENDER MAP (ground truth extracted from the full script — use this instead of guessing whenever a name below appears, even if this specific chunk has no gender clue on its own):
${lines.join('\n')}
`;
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
8. CRITICAL GENDER ENFORCEMENT: English pronouns ('you', 'they', 'I') are gender-neutral, but Arabic is strictly gendered. You MUST act as a gender-context analyzer:
   a) SCAN FOR CLUES: Actively look for names, titles (sir/ma'am), relationships (wife/sister/brother), or emotional context (e.g., romantic couples) before translating.
   b) APPLY FEMININE RIGOROUSLY: If addressing a female or if a female is speaking, you MUST use feminine conjugations perfectly (e.g., أنتِ، لكِ، ماذا تفعلين).
   c) LOCK CONSISTENCY: Once a gender is established in a conversation block, DO NOT flip-flop genders randomly between lines. Keep it locked.
   d) ZERO CLUE FALLBACK: Default to masculine ONLY if absolutely zero clues exist in the text, but NEVER ignore a female clue if it appears.
   e) PRIORITY OVERRIDE: If a name below appears in the KNOWN CHARACTER GENDER MAP, its gender is already confirmed from analysis of the entire script — apply it directly to every line spoken to or by that character, even if this specific chunk alone has no visible clue. Only deviate from the map if the immediate line contains an unmistakable contradicting clue (e.g. the map is wrong for that one specific line).${genderMapBlock}

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

        // خطوة واحدة قبل التقسيم: استخراج خارطة أسماء الشخصيات وجنسها من كامل الملف
        const genderMap = await extractCharacterGenderMap(cues, keysArray, modelName);

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
            const translated = await translateChunkStrict(texts, keysArray, modelName, genderMap);
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

        // خطوة واحدة قبل التقسيم: استخراج خارطة أسماء الشخصيات وجنسها من كامل الملف
        const genderMap = await extractCharacterGenderMap(cues, keysArray, modelName);

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
            const translated = await translateChunkStrict(texts, keysArray, modelName, genderMap);
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
    applyRtlSafeLineSplit,
    stripEmptyDialogueLines,
    postProcessTranslatedText,
    extractCharacterGenderMap,
    formatGenderMapForPrompt
};
