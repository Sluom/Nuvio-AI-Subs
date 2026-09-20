const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// ==========================================
// 1. ذاكرة السيرفر (Cache) لتخزين الترجمات الجاهزة
// ==========================================
const translationCache = {};

// ==========================================
// 2. الطابور الذكي (Global Queue) للعمل بالخلفية
// ==========================================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    async add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await task();
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
            if (!this.isProcessing) {
                this.processNext();
            }
        });
    }

    async processNext() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }
        this.isProcessing = true;
        const task = this.queue.shift();
        try {
            await task();
        } catch (e) {
            console.error("[Queue Error]", e.message);
        }
        this.processNext();
    }
}
const globalTranslationQueue = new RequestQueue();

// ==========================================
// المانيفست الأساسي
// ==========================================
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.8.0',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Auto-translate subtitles to Arabic using Gemini. Strict SDH removal, 3 SRT & 3 true ASS tracks.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime', 'other'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: true, 
        configurationRequired: true
    }
};

function getBaseUrl(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${host}`;
}

// ==========================================
// دوال جلب الترجمات من OpenSubtitles.org (Legacy REST)
// نفس أسلوب تخطي الحماية: User-Agent الخاص بـ VLSub
// ==========================================
const LEGACY_UA = 'VLSub 0.10.3';

function matchEpisode(fileName, targetEpisode) {
    if (!targetEpisode) return true; // فيلم مو مسلسل
    const name = (fileName || '').toLowerCase();

    if (name.includes('.zip') || name.includes('.rar')) return true;

    const epStr = parseInt(targetEpisode, 10).toString();
    const patterns = [
        new RegExp(`(?:s0*\\d+[._ -]*)?(?:e|ep|episode)[._ -]*0*${epStr}(?:[^0-9]|$)`, 'i'),
        new RegExp(`[._ -]0*${epStr}[._ -]`, 'i'),
        new RegExp(`\\[0*${epStr}\\]`, 'i'),
        new RegExp(`\\(0*${epStr}\\)`, 'i'),
        new RegExp(`\\b0*${epStr}\\b`, 'i')
    ];
    return patterns.some(p => p.test(name));
}

// جلب صفحة واحدة من rest.opensubtitles.org مع تسجيل مفصّل لكل خطوة
async function fetchLegacyData(url) {
    console.log(`[OS Debug] Requesting: ${url}`);
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': LEGACY_UA,
                'X-User-Agent': LEGACY_UA,
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        console.log(`[OS Debug] Status: ${res.status} | Content-Type: ${res.headers['content-type']}`);

        const data = res.data;
        if (!Array.isArray(data)) {
            console.log(`[OS Debug] Response is NOT an array. Type: ${typeof data} | Sample: ${JSON.stringify(data).slice(0, 300)}`);
            return [];
        }

        console.log(`[OS Debug] Got ${data.length} raw entries from OpenSubtitles`);

        return data
            .filter(e => e.SubDownloadLink)
            .map(e => {
                const format = (e.SubFormat || '').toLowerCase();
                const isHI = e.SubHearingImpaired === '1' || e.SubHearingImpaired === 1;
                return {
                    url: e.SubDownloadLink,
                    subtitleFileName: e.SubFileName || e.MovieReleaseName || 'OpenSubtitles',
                    format: format || 'srt',
                    isHI
                };
            });
    } catch (e) {
        console.error(`[OS Debug] FAILED: ${url}`);
        console.error(`[OS Debug] Error: ${e.message} | Status: ${e.response?.status} | Code: ${e.code}`);
        if (e.response?.data) {
            console.error(`[OS Debug] Response body sample: ${JSON.stringify(e.response.data).slice(0, 300)}`);
        }
        return [];
    }
}

// جلب ترجمات إنجليزية (SRT + ASS الحقيقية) من OpenSubtitles.org حصراً
async function fetchOpenSubtitlesEnglish(imdbId, season, episode) {
    console.log(`[OS Debug] === Fetching for imdbId=${imdbId} season=${season} episode=${episode} ===`);
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log(`[OS Debug] Rejected: imdbId "${imdbId}" doesn't start with 'tt'`);
        return [];
    }
    const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');

    let primaryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
    if (season != null && episode != null) {
        primaryUrl = `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-eng`;
    }

    let results = await fetchLegacyData(primaryUrl);
    console.log(`[OS Debug] Primary query returned ${results.length} usable subs`);

    // لو محددين حلقة معينة وما لقينا ass بها، نبحث بكامل المسلسل ونفلتر برقم الحلقة
    if (season != null && episode != null) {
        const hasAss = results.some(r => r.format === 'ass' || r.format === 'ssa');
        if (!hasAss) {
            console.log(`[OS Debug] No ASS in primary result, trying fallback (full series)`);
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
            const fallbackResults = await fetchLegacyData(fallbackUrl);
            console.log(`[OS Debug] Fallback query returned ${fallbackResults.length} total subs`);
            const filteredAss = fallbackResults.filter(r =>
                (r.format === 'ass' || r.format === 'ssa') && matchEpisode(r.subtitleFileName, episode)
            );
            console.log(`[OS Debug] Fallback ASS matching episode ${episode}: ${filteredAss.length}`);
            results = [...results, ...filteredAss];
        }
    }

    // إزالة التكرار حسب رابط التحميل
    const seen = new Set();
    const final = results.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
    });
    console.log(`[OS Debug] Final unique results: ${final.length}`);
    return final;
}

app.get(['/', '/configure'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>إعدادات Nuvio AI Subs</title>
        <style>
            body { background: #0b1120; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px; }
            h1 { color: #38bdf8; text-align: center; }
            .container { background: #1e293b; padding: 30px; border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
            .input-group { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; color: #94a3b8; font-size: 14px; }
            input[type="text"] { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; }
            .btn { background: #0284c7; color: #fff; padding: 12px; border: none; border-radius: 8px; font-weight: bold; width: 100%; cursor: pointer; margin-top: 10px; transition: 0.3s; }
            .btn:hover { background: #0369a1; }
            .btn-secondary { background: #475569; margin-bottom: 20px; }
            .btn-secondary:hover { background: #334155; }
            .key-row { display: flex; gap: 10px; margin-bottom: 10px; }
            .key-row input { flex: 1; }
            .remove-btn { background: #ef4444; color: white; border: none; border-radius: 6px; padding: 0 15px; cursor: pointer; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1>إعدادات المترجم الذكي</h1>
        <div class="container">
            <p style="text-align: center; font-size: 14px; color: #cbd5e1; margin-bottom: 25px;">أضف مفاتيح Gemini API الخاصة بك هنا. النظام سيبدل بينها تلقائياً.</p>
            
            <div id="keys-container">
                <div class="key-row">
                    <input type="text" class="api-key" placeholder="المفتاح الأساسي (AIzaSy...)">
                </div>
            </div>

            <button type="button" class="btn btn-secondary" onclick="addKeyField()">+ إضافة مفتاح آخر</button>
            
            <div class="input-group" style="margin-top: 20px;">
                <label>نموذج الترجمة (Translation Model)</label>
                <select id="model-select" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff;">
                    <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                    <option value="gemini-3.7-flash">Gemini 3.7 Flash (beta)</option>
                    <option value="gemini-3.6-flash">Gemini 3.6 Flash (beta)</option>
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash (beta)</option>
                </select>
            </div>

            <button class="btn" onclick="generateInstallLink()">تثبيت الإضافة في Nuvio 🚀</button>
        </div>

        <script>
            function addKeyField() {
                const container = document.getElementById('keys-container');
                const row = document.createElement('div');
                row.className = 'key-row';
                row.innerHTML = \`
                    <input type="text" class="api-key" placeholder="مفتاح إضافي (AIzaSy...)">
                    <button class="remove-btn" onclick="this.parentElement.remove()">X</button>
                \`;
                container.appendChild(row);
            }

            function generateInstallLink() {
                const inputs = document.querySelectorAll('.api-key');
                let keys = [];
                inputs.forEach(input => {
                    let val = input.value.trim();
                    if(val) keys.push(val);
                });

                if(keys.length === 0) {
                    alert('الرجاء إدخال مفتاح API واحد على الأقل!');
                    return;
                }

                const model = document.getElementById('model-select').value;
                const config = { keys: keys, model: model };
                const configStr = encodeURIComponent(JSON.stringify(config));
                const host = window.location.host;
                const installUrl = 'stremio://' + host + '/' + configStr + '/manifest.json';
                
                window.location.href = installUrl;
            }
        </script>
    </body>
    </html>
    `);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    
    let modifiedManifest = { ...MANIFEST };
    if (req.params.config) {
        modifiedManifest.description = '✅ مفعل! جاهز للترجمة التلقائية.';
        modifiedManifest.name = 'Nuvio AI Subs (Active)';
    }
    
    res.json(modifiedManifest);
});

// ==========================================
// مسار جلب الترجمات (OpenSubtitles.org حصراً + الفرز الصارم للـ ASS والـ SRT)
// ==========================================
app.get([
  '/subtitles/:type/:reqId(*)', 
  '/:config/subtitles/:type/:reqId(*)'
], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    const configParam = req.params.config || '';
    
    let targetId = req.params.reqId.split('/')[0];
    if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);

    const type = req.params.type;
    const baseUrl = getBaseUrl(req);

    // فك تفكيك معرف Stremio: tt1234567 أو tt1234567:season:episode
    const idParts = targetId.split(':');
    const imdbId = idParts[0];
    const season = idParts.length > 1 ? idParts[1] : null;
    const episode = idParts.length > 2 ? idParts[2] : null;

    try {
        const rawSubs = await fetchOpenSubtitlesEnglish(imdbId, season, episode);
        console.log(`[Route Debug] rawSubs: ${rawSubs.length} for targetId=${targetId} type=${type}`);

        if (rawSubs.length > 0) {

            // استبعاد SDH مطلقاً ونهائياً (بالحقل الرسمي + الاسم احتياطاً)
            const cleanSubs = rawSubs.filter(sub => {
                if (sub.isHI) return false;
                const name = (sub.subtitleFileName || '').toLowerCase();
                return !(name.includes('sdh') || name.includes('hi ') || name.includes('hearing impaired'));
            });

            console.log(`[Route Debug] cleanSubs after SDH filter: ${cleanSubs.length}`);

            if (cleanSubs.length === 0) return res.json({ subtitles: [] });

            // الفرز إلى SRT و ASS بناءً على حقل SubFormat الحقيقي القادم من OpenSubtitles
            const assSubs = cleanSubs.filter(s => s.format === 'ass' || s.format === 'ssa');
            const srtSubs = cleanSubs.filter(s => s.format !== 'ass' && s.format !== 'ssa');

            console.log(`[Route Debug] assSubs: ${assSubs.length} | srtSubs: ${srtSubs.length}`);

            const transSubs = [];
            const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
            const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;
            
            // إضافة 3 روابط SRT (بملفات مستقلة)
            if (srtSubs.length > 0) {
                for (let i = 0; i < 3; i++) {
                    const sub = srtSubs[i] || srtSubs[srtSubs.length - 1]; // تكرار الأخير إذا العدد أقل من 3
                    transSubs.push({
                        id: `nuvio-ai-srt-${i+1}`,
                        url: `${baseUrl}${streamPathSrt}?url=${encodeURIComponent(sub.url)}&track=${i+1}`,
                        lang: 'ara',
                        title: `Nuvio AI SRT ${i+1} (Sync ${String.fromCharCode(65+i)})`
                    });
                }
            }

            // إضافة 3 روابط ASS (تظهر فقط إذا كان هناك ملفات ASS حقيقية متوفرة فعلاً)
            if (assSubs.length > 0) {
                for (let i = 0; i < 3; i++) {
                    const sub = assSubs[i] || assSubs[assSubs.length - 1];
                    transSubs.push({
                        id: `nuvio-ai-ass-${i+1}`,
                        url: `${baseUrl}${streamPathAss}?url=${encodeURIComponent(sub.url)}&track=${i+4}`,
                        lang: 'ara',
                        title: `Nuvio AI ASS ${i+1} (Sync ${String.fromCharCode(65+i)})`
                    });
                }
            }

            console.log(`[Route Debug] Final transSubs count: ${transSubs.length}`);
            return res.json({ subtitles: transSubs });
        }
        console.log(`[Route Debug] rawSubs was empty, returning []`);
        return res.json({ subtitles: [] });
    } catch (err) {
        console.error(`[Route Debug] EXCEPTION: ${err.message}`);
        return res.json({ subtitles: [] });
    }
});

app.all([
    '/stream-ai.srt', '/stream-ai.ass', '/stream-ai.ssa',
    '/:config/stream-ai.srt', '/:config/stream-ai.ass', '/:config/stream-ai.ssa'
], async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    
    const targetUrl = req.query.url;
    const trackNum = req.query.track || '1';
    if (!targetUrl) return res.status(400).send('Missing URL');

    const isAss = req.path.endsWith('.ass') || req.path.endsWith('.ssa');
    const cacheKey = `${isAss ? 'ASS' : 'SRT'}_${targetUrl}`;
    
    if (translationCache[cacheKey] && translationCache[cacheKey].status === 'done') {
        res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-${isAss ? 'ASS.ssa' : 'SRT.srt'}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(translationCache[cacheKey].content);
    }

    let userKeys = [];
    let userModel = 'gemini-3.1-flash-lite'; 
    if (req.params.config) {
        try {
            const decodedConfig = JSON.parse(decodeURIComponent(req.params.config));
            if (decodedConfig.keys && Array.isArray(decodedConfig.keys)) userKeys = decodedConfig.keys;
            if (decodedConfig.model) userModel = decodedConfig.model;
        } catch (e) { }
    }

    if (!translationCache[cacheKey]) {
        translationCache[cacheKey] = { status: 'pending' };

        globalTranslationQueue.add(async () => {
            try {
                let finalContent = '';
                if (isAss) {
                    finalContent = await handleTranslationAss(targetUrl, userKeys, userModel);
                } else {
                    finalContent = await handleTranslationSrt(targetUrl, userKeys, userModel);
                }
                translationCache[cacheKey] = { status: 'done', content: finalContent };
            } catch (e) {
                console.error(`[Background Error] Track ${trackNum}:`, e.message);
                const errorSub = isAss 
                    ? `[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,فشل الترجمة النهائي. حاول مجدداً.`
                    : `1\n00:00:01,000 --> 01:00:00,000\nفشل الترجمة النهائي. حاول مجدداً.\n\n`;
                translationCache[cacheKey] = { status: 'done', content: errorSub };
            }
        });
    }

    const fakeSub = isAss 
        ? `[Script Info]
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
Dialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,الترجمة قيد التنفيذ ⏳\\Nانقر لإعادة التحميل بمجرد جاهزيتها.`
        : `1\n00:00:01,000 --> 01:00:00,000\nالترجمة قيد التنفيذ ⏳\nانقر لإعادة التحميل بمجرد جاهزيتها.\n\n`;

    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Trans-Wait-${isAss ? 'ASS.ssa' : 'SRT.srt'}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fakeSub);
});

app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE on port ${PORT}`);
});

module.exports = app;
