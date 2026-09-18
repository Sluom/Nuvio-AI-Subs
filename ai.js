const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');

// إعدادات APInex
const APINEX_BASE_URL = 'https://api.apinex.bond/v1/chat/completions';
const APINEX_API_KEY = process.env.API_KEY_APInex;
const APINEX_MODEL = 'free/claude-sonnet-4.6';

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

function parseRobustJsonArray(raw, expectedLength) {
    if (!raw) return null;
    let clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        const parsed = JSON.parse(clean);
        let arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
        if (Array.isArray(arr) && arr.length > 0) {
            return arr.map(x => String(x || '').trim());
        }
    } catch (e) {
        const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
        if (stringMatches.length >= expectedLength * 0.5) {
            return stringMatches.filter(s => s !== 'translations' && s !== 'data');
        }
    }
    return null;
}

async function runConcurrentPool(tasks, limit = 2) {
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

async function translateChunkStrict(texts) {
    const prompt = `You are a strict JSON subtitle translator. Translate the array to Arabic.
ONLY OUTPUT VALID JSON ARRAY OF STRINGS. NO OTHER TEXT. NO MARKDOWN.
Input length: ${texts.length}.
Input: ${JSON.stringify(texts)}`;

    try {
        const r = await axios.post(
            APINEX_BASE_URL,
            { 
                model: APINEX_MODEL, 
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2 // تقليل الهلوسة
            },
            {
                headers: { 
                    'Authorization': `Bearer ${APINEX_API_KEY}`, 
                    'Content-Type': 'application/json' 
                },
                timeout: 30000
            }
        );
        if (r.status === 200) {
            const parsedArr = parseRobustJsonArray(r.data?.choices?.[0]?.message?.content, texts.length);
            if (parsedArr && parsedArr.length > 0) return parsedArr;
        }
    } catch (e) {
        console.error("APInex Error:", e.message);
    }
    return null;
}

// تعديل جوهري لتجاوز الحظر وتحميل الملفات بشكل صحيح
async function fetchAndExtractSub(subUrl) {
    let response;
    const decodedUrl = decodeURIComponent(subUrl);

    try {
        console.log(`[Fetch] Downloading source: ${decodedUrl}`);
        response = await axios.get(decodedUrl, { 
            responseType: 'arraybuffer', 
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        });
    } catch (err) {
        console.error(`[Fetch Error] Failed to download source subtitle: ${err.message}`);
        throw err;
    }

    let buffer = Buffer.from(response.data);
    
    // فك الضغط إذا كان GZIP
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        buffer = zlib.gunzipSync(buffer);
    }
    
    // فك الضغط إذا كان ZIP
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        const assEntry = entries.find(e => !e.isDirectory && (e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')));
        const subEntry = entries.find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.srt'));
        if (assEntry) buffer = assEntry.getData();
        else if (subEntry) buffer = subEntry.getData();
    }
    
    return fixArabicEncoding(buffer).toString('utf-8');
}

async function handleTranslationSrt(subUrl) {
    let originalText = "";
    try {
        originalText = await fetchAndExtractSub(subUrl);
    } catch (e) {
        console.log("[Error] Returning fallback SRT");
        return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n";
    }

    const cues = extractCuesUniversal(originalText);
    if (!cues.length) return "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص من الملف.\n\n";

    console.log(`[Translate] Starting translation of ${cues.length} cues...`);
    const CHUNK = 40;
    const chunks = [];
    for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

    const tasks = chunks.map(chunk => async () => {
        const texts = chunk.map(c => c.text);
        const translated = await translateChunkStrict(texts);
        return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text); // إذا فشل يرجع النص الإنجليزي الأصلي
    });

    const chunkResults = await runConcurrentPool(tasks, 3);
    const finalTranslations = chunkResults.flat();

    let srtOutput = '';
    cues.forEach((c, idx) => {
        let sTime = c.start.replace('.', ',');
        let eTime = c.end.replace('.', ',');
        if (sTime.length === 10) sTime = '0' + sTime;
        if (eTime.length === 10) eTime = '0' + eTime;
        if (sTime.split(',')[1].length === 2) sTime += '0';
        if (eTime.split(',')[1].length === 2) eTime += '0';
        srtOutput += `${idx + 1}\n${sTime} --> ${eTime}\n${finalTranslations[idx]}\n\n`;
    });
    
    console.log(`[Translate] Done. Returning SRT.`);
    return srtOutput;
}

async function handleTranslationAss(subUrl) {
    let originalText = "";
    try {
        originalText = await fetchAndExtractSub(subUrl);
    } catch (e) {
        return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.`;
    }

    const cues = extractCuesUniversal(originalText);
    if (!cues.length) return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل استخراج النصوص من الملف.`;

    const CHUNK = 40;
    const chunks = [];
    for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

    const tasks = chunks.map(chunk => async () => {
        const texts = chunk.map(c => c.text);
        const translated = await translateChunkStrict(texts);
        return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : chunk[idx].text);
    });

    const chunkResults = await runConcurrentPool(tasks, 3);
    const finalTranslations = chunkResults.flat();
    const assLines = cues.map((c, idx) => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${finalTranslations[idx]}`);
    return ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';
}

module.exports = { handleTranslationSrt, handleTranslationAss };
