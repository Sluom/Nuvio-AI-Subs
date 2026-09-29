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

// ============ الإعدادات (تقدر تغيّرها من هنا فقط) ============
const CHUNK_SIZE = 300;          // عدد الأسطر بكل طلب (قليل الطلبات = ما نصطدم بحد جوجل)
const CONCURRENCY = 1;           // كم طلب نرسل بنفس الوقت (خليه 1، وإذا كل شي تمام جرب 2)
const REQUEST_TIMEOUT = 180000;  // مهلة الطلب: 3 دقائق (الدفعة الكبيرة تحتاج وقت)
const MAX_OUTPUT_TOKENS = 32000; // سقف طول الرد
const COOLDOWN_429 = 60000;      // تبريد المفتاح عند 429
const COOLDOWN_SERVER = 3000;    // تبريد المفتاح عند 500/502/503
const GLOBAL_PAUSE = 65000;      // الإيقاف الجماعي لما الحد يكون عام
const MIN_SPLIT_SIZE = 10;       // ما نقسم الدفعة لو صارت أصغر من هذا
// ============================================================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// نظام تبريد المفاتيح بالخلفية
const keyCooldowns = new Map();
let currentKeyIndex = 0;

// إيقاف جماعي: لما جوجل يرفض عدة مفاتيح ورا بعض، معناها الحد عام
let globalPauseUntil = 0;
let consecutive429 = 0;

async function acquireKey(keysArray) {
    if (!keysArray || keysArray.length === 0) return null;

    while (true) {
        const now = Date.now();

        // البحث عن أول مفتاح متاح وما داخل تبريد
        for (let i = 0; i < keysArray.length; i++) {
            const key = keysArray[currentKeyIndex % keysArray.length];
            currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
            const cooldownUntil = keyCooldowns.get(key) || 0;

            if (now >= cooldownUntil) {
                return key;
            }
        }

        // إذا كل المفاتيح بالتبريد، انتظر لحين فك أول واحد
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
    let text = String(txt)
        .replace(/\\"/g, '"')
        .replace(/\\\\n/gi, '\n')
        .replace(/\\\\N/g, '\n')
        .replace(/\\n/gi, '\n')
        .replace(/\\N/g, '\n')
        .replace(/\\r/g, '');

    return text;
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
The output array MUST contain exactly ${texts.length} strings, one per input entry, in the same order.

Output ONLY A VALID JSON ARRAY OF STRINGS, nothing else.

Content to translate:
${JSON.stringify(texts)}`;
}

// يترجم دفعة واحدة. يرجع مصفوفة بنفس عدد الأسطر، أو null إذا فشل.
async function translateChunkStrict(texts, keysArray, modelName) {
    const MAX_FAILS = 4;    // فشل حقيقي (مو 429)
    const MAX_PAUSES = 6;   // عدد مرات الإيقاف الجماعي
    let fails = 0;
    let pauses = 0;

    const cleanModelName = String(modelName || 'gemini-3.1-flash-lite').trim().replace(/^models\//, '');
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent`;
    const prompt = buildPrompt(texts);

    while (fails <= MAX_FAILS && pauses <= MAX_PAUSES) {
        // إذا في إيقاف جماعي شغال، انتظر
        const pauseLeft = globalPauseUntil - Date.now();
        if (pauseLeft > 0) {
            console.log(`[إيقاف جماعي] انتظار ${Math.ceil(pauseLeft / 1000)} ثانية...`);
            await delay(pauseLeft);
        }

        const activeKey = await acquireKey(keysArray);
        if (!activeKey) {
            console.error('[Fatal] No Gemini API Keys configured!');
            return null;
        }
        const cleanKey = String(activeKey).trim();

        try {
            const r = await axios.post(
                GEMINI_URL,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: MAX_OUTPUT_TOKENS,
                        responseMimeType: 'application/json'
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
                    timeout: REQUEST_TIMEOUT
                }
            );

            const parts = r.data?.candidates?.[0]?.content?.parts || [];
            const responseText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
            const parsedArr = parseRobustJsonArray(responseText, texts.length);

            // نقبل الرد فقط إذا العدد مطابق، حتى ما تنزاح الترجمة عن مكانها
            if (parsedArr && parsedArr.length === texts.length) {
                consecutive429 = 0;
                console.log(`[Success] ${texts.length} سطر via Key: ...${cleanKey.slice(-4)}`);
                return parsedArr;
            }

            fails++;
            console.log(`[عدد غلط] المطلوب ${texts.length} والراجع ${parsedArr ? parsedArr.length : 0}. إعادة المحاولة...`);

        } catch (e) {
            const status = e.response?.status || 0;

            if (status === 429) {
                consecutive429++;
                keyCooldowns.set(activeKey, Date.now() + COOLDOWN_429);

                if (consecutive429 >= 3) {
                    // الحد عام: أوقف الكل مرة وحدة بدل ما نحرق المفاتيح
                    globalPauseUntil = Date.now() + GLOBAL_PAUSE;
                    keyCooldowns.clear();
                    consecutive429 = 0;
                    pauses++;
                    console.log(`[429 متكرر] الحد عام، إيقاف كل المفاتيح ${GLOBAL_PAUSE / 1000} ثانية (مرة ${pauses})`);
                }
                // الـ429 ما تنحسب من المحاولات
            } else {
                fails++;
                const cooldown = (status === 500 || status === 502 || status === 503) ? COOLDOWN_SERVER : COOLDOWN_SERVER;
                keyCooldowns.set(activeKey, Date.now() + cooldown);
                console.log(`[فشل] المفتاح ...${cleanKey.slice(-4)} السبب: ${status || e.code || e.message}`);
            }
        }
    }

    return null;
}

// إذا فشلت الدفعة الكبيرة، نقسمها نصفين ونحاول كل نصف لحاله
async function translateWithSplit(texts, keysArray, modelName) {
    const result = await translateChunkStrict(texts, keysArray, modelName);
    if (result) return result;

    if (texts.length <= MIN_SPLIT_SIZE) return texts.map(() => null);

    console.log(`[تقسيم] الدفعة (${texts.length} سطر) فشلت، نقسمها نصفين...`);
    const mid = Math.ceil(texts.length / 2);
    const firstHalf = await translateWithSplit(texts.slice(0, mid), keysArray, modelName);
    const secondHalf = await translateWithSplit(texts.slice(mid), keysArray, modelName);
    return [...firstHalf, ...secondHalf];
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

// يترجم كل الأسطر (مشترك بين SRT و ASS)
async function translateAllCues(cues, keysArray, modelName) {
    const chunks = [];
    for (let i = 0; i < cues.length; i += CHUNK_SIZE) chunks.push(cues.slice(i, i + CHUNK_SIZE));

    console.log(`[بدء] ${cues.length} سطر مقسمة على ${chunks.length} طلب (${CHUNK_SIZE} سطر بالطلب)`);

    const tasks = chunks.map(chunk => async () => {
        const texts = chunk.map(c => {
            let t = c.text;
            if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) {
                return `[${t}]`;
            }
            return t;
        });
        const translated = await translateWithSplit(texts, keysArray, modelName);
        return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
    });

    const chunkResults = await runConcurrentPool(tasks, CONCURRENCY);
    // لو دفعة كاملة فشلت بشكل غير متوقع نرجع النص الأصلي بدل ما نضيع الأسطر
    return chunkResults.map((res, i) => res || chunks[i].map(c => c.text))
        .flat()
        .map(t => normalizeLineBreakArtifacts(t));
}

async function handleTranslationSrt(subUrl, keysArray, modelName) {
    let originalText = '';
    try { originalText = await fetchAndExtractSub(subUrl); }
    catch (e) { return '1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n'; }

    const cues = extractCuesUniversal(originalText);
    if (!cues.length) return '1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n';

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
    let originalText = '';
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

        const safeText = text.trim().replace(/\n/g, '\\N');
        assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${safeText}`);
    });

    return ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';
}

module.exports = { handleTranslationSrt, handleTranslationAss, normalizeLineBreakArtifacts, parseRobustJsonArray };
