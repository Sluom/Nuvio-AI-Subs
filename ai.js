const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');

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

// ===================== الإعدادات =====================
const CHUNK_SIZE = 400;            // عدد الأسطر بالطلب (كان 80)
const MIN_SPLIT_SIZE = 50;         // أقل حجم يُقسم عند الفشل
const MAX_BAD_OUTPUTS = 2;         // مخرجات خربانة قبل التقسيم
const REQUEST_TIMEOUT_MS = 180000; // الطلب الكبير يحتاج وقت أطول
const MAX_OUTPUT_TOKENS = 65536;
const COOLDOWN_429_MS = 60000;
const COOLDOWN_5XX_MS = 3000;
const GLOBAL_PAUSE_MS = 65000;     // 3 مفاتيح ورا بعض 429 = حد عام
// =====================================================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const keyCooldowns = new Map();
let currentKeyIndex = 0;
let consecutive429 = 0;

async function acquireKey(keysArray) {
    if (!keysArray || keysArray.length === 0) return null;

    while (true) {
        const now = Date.now();

        for (let i = 0; i < keysArray.length; i++) {
            const key = keysArray[currentKeyIndex % keysArray.length];
            currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
            const cooldownUntil = keyCooldowns.get(key) || 0;
            if (now >= cooldownUntil) return key;
        }

        let bestKey = keysArray[0];
        let bestTime = Infinity;
        for (const k of keysArray) {
            const t = keyCooldowns.get(k) || 0;
            if (t < bestTime) { bestTime = t; bestKey = k; }
        }

        const waitTime = bestTime - now;
        if (waitTime > 0) {
            console.log(`[نفاد تام] جميع المفاتيح بالتبريد. السكربت سينتظر ${Math.ceil(waitTime / 1000)} ثانية...`);
            await delay(waitTime);
        } else {
            return bestKey;
        }
    }
}

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
                let txt = String(x || '');
                txt = txt.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
                txt = normalizeLineBreakArtifacts(txt);
                return txt.trim();
            });
        }
    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        if (stringMatches.length >= expectedLength * 0.5) {
            return stringMatches
                .filter(s => s !== 'translations' && s !== 'data')
                .map(s => {
                    let text = normalizeLineBreakArtifacts(s);
                    text = text.replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
                    return text.trim();
                });
        }
    }
    return null;
}

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

// إعدادات التوليد حسب عائلة المودل
function buildGenerationConfig(modelName) {
    const cfg = {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json'
    };
    if (/^gemini-3/i.test(modelName) || /^gemini-(flash|flash-lite|pro)-latest$/i.test(modelName)) {
        // Gemini 3.x: تفكير أدنى وبدون temperature
        cfg.thinkingConfig = { thinkingLevel: 'minimal' };
    } else {
        cfg.temperature = 0.1;
        if (/2\.5/.test(modelName) && !/pro/i.test(modelName)) {
            cfg.thinkingConfig = { thinkingBudget: 0 };
        }
    }
    return cfg;
}

function buildPrompt(texts) {
    return `Translate the following subtitles while:
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

The input array has EXACTLY ${texts.length} entries. Your output array MUST have EXACTLY ${texts.length} strings, in the same order, one translation per entry. Never merge, split, skip, or add entries.

Output ONLY A VALID JSON ARRAY OF STRINGS, nothing else.

Content to translate:
${JSON.stringify(texts)}`;
}

async function translateChunkStrict(texts, keysArray, modelName) {
    const MAX_ATTEMPTS = keysArray.length + 3;
    const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent`;
    const prompt = buildPrompt(texts);
    const generationConfig = buildGenerationConfig(cleanModelName);

    let badOutputs = 0;
    let globalPauses = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const activeKey = await acquireKey(keysArray);

        if (!activeKey) {
            console.error("[Fatal] No Gemini API Keys configured!");
            return null;
        }

        const cleanKey = String(activeKey).trim();

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

            consecutive429 = 0;

            if (r.status === 200) {
                const cand = r.data?.candidates?.[0];
                const responseText = cand?.content?.parts?.map(p => p?.text || '').join('') || '';
                const parsedArr = parseRobustJsonArray(responseText, texts.length);

                if (parsedArr && parsedArr.length === texts.length) {
                    console.log(`[Success] Translated chunk (${texts.length} lines) via Key: ...${cleanKey.slice(-4)}`);
                    return parsedArr;
                }

                badOutputs++;
                console.log(`[طول/JSON غلط] المتوقع ${texts.length} والمستلم ${parsedArr ? parsedArr.length : 'null'} (finish: ${cand?.finishReason || 'n/a'}) - محاولة ${badOutputs}/${MAX_BAD_OUTPUTS}`);
                if (badOutputs >= MAX_BAD_OUTPUTS) return null; // يروح للتقسيم
            }
        } catch (e) {
            const status = e.response?.status || 'Unknown';
            const errMsg = e.response?.data?.error?.message || e.message || '';
            let cooldownTime = COOLDOWN_5XX_MS;

            if (status === 429) {
                cooldownTime = COOLDOWN_429_MS;
                consecutive429++;
                console.log('[429 body]', String(errMsg).slice(0, 300));

                if (consecutive429 >= 3 && globalPauses < 3) {
                    globalPauses++;
                    consecutive429 = 0;
                    keyCooldowns.set(activeKey, Date.now() + cooldownTime);
                    console.log(`[حد عام] 3 مفاتيح ورا بعض 429. إيقاف مؤقت ${GLOBAL_PAUSE_MS / 1000} ثانية...`);
                    await delay(GLOBAL_PAUSE_MS);
                    attempt--; // ما تحسبها محاولة
                    continue;
                }
            }

            keyCooldowns.set(activeKey, Date.now() + cooldownTime);
            console.log(`[فشل لحظي] المفتاح ...${cleanKey.slice(-4)} دخل التبريد لـ ${cooldownTime / 1000} ثانية (السبب: ${status}). جاري السحب الفوري للمفتاح التالي...`);
        }
    }

    return null;
}

// إذا فشل الـ chunk الكبير نقسمه نصفين ونعيد، بدل ما يرجع إنجليزي
async function translateWithFallback(texts, keysArray, modelName, depth = 0) {
    const result = await translateChunkStrict(texts, keysArray, modelName);
    if (result) return result;

    if (texts.length <= MIN_SPLIT_SIZE || depth >= 3) return null;

    console.log(`[تقسيم] فشل chunk بحجم ${texts.length}، يتم تقسيمه نصفين...`);
    const mid = Math.ceil(texts.length / 2);
    const firstHalf = texts.slice(0, mid);
    const secondHalf = texts.slice(mid);
    const a = await translateWithFallback(firstHalf, keysArray, modelName, depth + 1);
    const b = await translateWithFallback(secondHalf, keysArray, modelName, depth + 1);
    return [...(a || firstHalf), ...(b || secondHalf)];
}

async function fetchAndExtractSub(subUrl) {
    const decodedUrl = decodeURIComponent(subUrl);
    const response = await axios.get(decodedUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': '*/*'
        }
    });

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

// منطق الترجمة المشترك بين SRT و ASS
async function translateAllCues(cues, keysArray, modelName) {
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
        const translated = await translateWithFallback(texts, keysArray, modelName);
        return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
    });

    const chunkResults = await runConcurrentPool(tasks, 1);
    return chunkResults.flat().map(t => normalizeLineBreakArtifacts(t));
}

async function handleTranslationSrt(subUrl, keysArray, modelName) {
    let originalText = "";
    try { originalText = await fetchAndExtractSub(subUrl); }
    catch (e) { return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n"; }

    const cues = extractCuesUniversal(originalText);
    if (!cues.length) return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n";

    const finalTranslations = await translateAllCues(cues, keysArray, modelName);

    let srtOutput = '';
    let counter = 1;

    cues.forEach((c, idx) => {
        let text = finalTranslations[idx];
        if (!text) return;

        let checkText = text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '');
        if (checkText.length === 0) return;

        let sTime = c.start.replace('.', ',');
        let eTime = c.end.replace('.', ',');
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
    catch (e) { return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.`; }

    const cues = extractCuesUniversal(originalText);
    if (!cues.length) return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل استخراج النصوص.`;

    const finalTranslations = await translateAllCues(cues, keysArray, modelName);

    const assLines = [];
    cues.forEach((c, idx) => {
        let text = finalTranslations[idx];
        if (!text) return;

        let checkText = text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '');
        if (checkText.length === 0) return;

        const safeText = text.trim().replace(/\n/g, '\\N
