const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// ==========================================
// 1. ذاكرة السيرفر (Cache) لتخزين الترجمات
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
    version: '2.0.0',
    name: 'Nuvio AI Subs (Ultra Max)',
    description: 'Auto-translate from Official OpenSubtitles Legacy API. Strict SDH removal, 3 SRT & 3 true ASS tracks.',
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
        <h1>إعدادات المترجم الذكي (نسخة Legacy)</h1>
        <div class="container">
            <p style="text-align: center; font-size: 14px; color: #cbd5e1; margin-bottom: 25px;">أضف مفاتيح Gemini API الخاصة بك هنا. النظام يعتمد على الجلب الرسمي المباشر.</p>
            
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
// 3. دوال الجلب العبقرية (من موقع OpenSubtitles الرسمي)
// ==========================================

function matchEpisode(fileName, targetEpisode) {
    if (!targetEpisode) return true;
    const name = (fileName || '').toLowerCase();
    if (name.includes('.zip') || name.includes('.rar') || name.includes('.gz')) return true;
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

async function fetchLegacyData(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'VLSub 0.10.3', 'X-User-Agent': 'VLSub 0.10.3', 'Accept': 'application/json' },
            timeout: 8000
        });
        if (!Array.isArray(response.data)) return [];
        
        const results = [];
        response.data.forEach(entry => {
            const downloadLink = entry.SubDownloadLink;
            if (!downloadLink) return;
            const format = (entry.SubFormat || '').toLowerCase();
            const rawName = entry.SubFileName || entry.MovieReleaseName || 'OpenSubtitles Legacy';
            const isAss = format === 'ass' || format === 'ssa' || rawName.toLowerCase().includes('.ass') || rawName.toLowerCase().includes('.ssa');
            results.push({ url: downloadLink, fileName: rawName, isAss: isAss });
        });
        return results;
    } catch (e) {
        return [];
    }
}

async function fetchLegacyApiEnglish(imdbId, season, episode) {
    const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
    let primaryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
    
    if (season != null && episode != null) {
        primaryUrl = `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-eng`;
    }

    let results = await fetchLegacyData(primaryUrl);

    if (season != null && episode != null) {
        const hasAss = results.some(r => r.isAss);
        // إذا ماكو ASS بالحلقة، نبحث بالحزمة الكاملة للموسم ونفلتر
        if (!hasAss) {
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
            const fallbackResults = await fetchLegacyData(fallbackUrl);
            const filteredFallback = fallbackResults.filter(r => r.isAss && matchEpisode(r.fileName, episode));
            results = [...results, ...filteredFallback];
        }
    }
    return results;
}

async function fetchMirrorEnglish(imdbId, season, episode, type) {
    const mediaType = (type === 'series' || type === 'anime' || !!season) ? 'series' : 'movie';
    const targetId = (mediaType === 'series' && season) ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    try {
        const url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`;
        const res = await axios.get(url, { timeout: 7000 });
        const list = res.data?.subtitles || [];
        return list.filter(s => (s.lang || '').toLowerCase().startsWith('en') && s.url).map(s => {
            const rawUrl = (s.url || '').toLowerCase();
            const rawName = (s.SubFileName || s.subtitleFileName || s.title || s.name || '').toLowerCase();
            const subFormat = (s.SubFormat || s.format || '').toLowerCase();
            const isAss = subFormat === 'ssa' || subFormat === 'ass' || rawUrl.includes('.ass') || rawUrl.includes('.ssa') || rawName.includes('.ass') || rawName.includes('.ssa');
            return { url: s.url, fileName: s.SubFileName || s.title || 'Mirror', isAss: isAss };
        });
    } catch(e) {
        return [];
    }
}

async function getEnglishSubtitles(imdbId, season, episode, type) {
    const [legacy, mirror] = await Promise.all([
        fetchLegacyApiEnglish(imdbId, season, episode),
        fetchMirrorEnglish(imdbId, season, episode, type)
    ]);
    const allSubs = [...legacy, ...mirror];
    const unique = [];
    const seenUrls = new Set();
    
    for (const sub of allSubs) {
        const cleanUrl = sub.url.split('?')[0];
        if (seenUrls.has(cleanUrl)) continue;
        seenUrls.add(cleanUrl);
        unique.push(sub);
    }
    return unique;
}

// ==========================================
// مسار جلب الترجمات النهائي (التوزيع الذكي للروابط)
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
    
    let imdbId = targetId;
    let season = null;
    let episode = null;

    if (targetId.includes(':')) {
        const parts = targetId.split(':');
        imdbId = parts[0];
        season = parts[1];
        episode = parts[2];
    }

    try {
        const engSubs = await getEnglishSubtitles(imdbId, season, episode, type);
        
        if (engSubs.length > 0) {
            // استبعاد SDH مطلقاً ونهائياً
            const cleanSubs = engSubs.filter(sub => {
                const fname = (sub.fileName || '').toLowerCase();
                return !(fname.includes('sdh') || fname.includes('hi ') || fname.includes('hearing impaired'));
            });

            if (cleanSubs.length === 0) return res.json({ subtitles: [] });

            const assSubs = cleanSubs.filter(s => s.isAss);
            const srtSubs = cleanSubs.filter(s => !s.isAss);

            const transSubs = [];
            const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
            const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;
            
            // إضافة 3 روابط SRT
            if (srtSubs.length > 0) {
                for (let i = 0; i < 3; i++) {
                    const sub = srtSubs[i] || srtSubs[srtSubs.length - 1]; 
                    transSubs.push({
                        id: `nuvio-ai-srt-${i+1}`,
                        url: `${baseUrl}${streamPathSrt}?url=${encodeURIComponent(sub.url)}&track=${i+1}`,
                        lang: 'ara',
                        title: `Nuvio AI SRT ${i+1} (Sync ${String.fromCharCode(65+i)})`
                    });
                }
            }

            // إضافة 3 روابط ASS (تظهر فقط إذا كان هناك ASS حقيقي من الـ ZIP)
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

            return res.json({ subtitles: transSubs });
        }
        return res.json({ subtitles: [] });
    } catch (err) {
        return res.json({ subtitles: [] });
    }
});

// ==========================================
// مسار الترجمة بالخلفية
// ==========================================
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
