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
    version: '1.6.0',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Auto-translate subtitles to Arabic using unlimited Gemini API keys with Smart SDH Sorting and Background Cache.',
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

// مسار صفحة الإعدادات
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

// مسار المانيفست
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    
    let modifiedManifest = { ...MANIFEST };
    if (req.params.config) {
        modifiedManifest.description = '✅ مفعل! جاهز للترجمة التلقائية مع الفرز الذكي لملفات SDH.';
        modifiedManifest.name = 'Nuvio AI Subs (Active)';
    }
    
    res.json(modifiedManifest);
});

// ==========================================
// مسار جلب الترجمات وفرز الـ SDH والملفات المختلفة
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

    try {
        const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/${targetId}.json`;
        const r = await axios.get(osUrl, { timeout: 10000 });
        
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            
            // جلب كل الترجمات الإنجليزية المتوفرة
            const engSubs = r.data.subtitles.filter(s => (s.lang || '').toLowerCase().startsWith('en'));
            if (engSubs.length === 0) engSubs.push(r.data.subtitles[0]);

            // فرز الترجمات إلى (عادية) و (ضعاف سمع SDH)
            const normalSubs = [];
            const sdhSubs = [];
            
            engSubs.forEach(sub => {
                const isSdh = sub.id?.toLowerCase().includes('sdh') || 
                              sub.id?.toLowerCase().includes('hi') || 
                              sub.title?.toLowerCase().includes('sdh') || 
                              sub.title?.toLowerCase().includes('hearing impaired');
                if (isSdh) sdhSubs.push(sub);
                else normalSubs.push(sub);
            });

            // اختيار 3 ملفات إنجليزية مختلفة لضمان تنوع التوقيتات
            let sub1 = normalSubs.length > 0 ? normalSubs[0] : (sdhSubs[0] || engSubs[0]);
            let sub2 = normalSubs.length > 1 ? normalSubs[1] : sub1;
            let sub3 = sdhSubs.length > 0 ? sdhSubs[0] : (normalSubs.length > 2 ? normalSubs[2] : sub1);

            const url1 = encodeURIComponent(sub1.url);
            const url2 = encodeURIComponent(sub2.url);
            const url3 = encodeURIComponent(sub3.url);
            
            const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
            const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;
            
            // إضافة 5 روابط تشير إلى ملفات مختلفة ومفصولة
            const transSubs = [
                { id: 'nuvio-ai-srt-1', url: `${baseUrl}${streamPathSrt}?url=${url1}&track=1`, lang: 'ara', title: 'Nuvio AI SRT 1 (Normal)' },
                { id: 'nuvio-ai-srt-2', url: `${baseUrl}${streamPathSrt}?url=${url2}&track=2`, lang: 'ara', title: 'Nuvio AI SRT 2 (Alt Sync)' },
                { id: 'nuvio-ai-srt-3', url: `${baseUrl}${streamPathSrt}?url=${url3}&track=3`, lang: 'ara', title: 'Nuvio AI SRT 3 (SDH)' },
                { id: 'nuvio-ai-ass-1', url: `${baseUrl}${streamPathAss}?url=${url1}&track=4`, lang: 'ara', title: 'Nuvio AI ASS 1 (Normal)' },
                { id: 'nuvio-ai-ass-2', url: `${baseUrl}${streamPathAss}?url=${url2}&track=5`, lang: 'ara', title: 'Nuvio AI ASS 2 (Alt Sync)' }
            ];

            return res.json({ subtitles: transSubs });
        }
        return res.json({ subtitles: [] });
    } catch (err) {
        return res.json({ subtitles: [] });
    }
});

// ==========================================
// مسار الترجمة (القلب النابض بالخلفية)
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
    
    // 1. إذا الترجمة جاهزة بالذاكرة (Cache)، دزها فوراً
    if (translationCache[cacheKey] && translationCache[cacheKey].status === 'done') {
        console.log(`[Cache Hit] Delivering completed translation for track ${trackNum}`);
        res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-${isAss ? 'ASS.ssa' : 'SRT.srt'}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(translationCache[cacheKey].content);
    }

    // 2. استخراج المفاتيح
    let userKeys = [];
    let userModel = 'gemini-3.1-flash-lite'; 
    if (req.params.config) {
        try {
            const decodedConfig = JSON.parse(decodeURIComponent(req.params.config));
            if (decodedConfig.keys && Array.isArray(decodedConfig.keys)) userKeys = decodedConfig.keys;
            if (decodedConfig.model) userModel = decodedConfig.model;
        } catch (e) { }
    }

    // 3. إذا أول مرة ينطلب، نبدأ الترجمة بالخلفية ونخزن الحالة كـ pending
    if (!translationCache[cacheKey]) {
        console.log(`[Background Init] Starting background translation for track ${trackNum}...`);
        translationCache[cacheKey] = { status: 'pending' };

        globalTranslationQueue.add(async () => {
            try {
                let finalContent = '';
                if (isAss) {
                    finalContent = await handleTranslationAss(targetUrl, userKeys, userModel);
                } else {
                    finalContent = await handleTranslationSrt(targetUrl, userKeys, userModel);
                }
                // خزن النتيجة بالذاكرة من تكمل
                translationCache[cacheKey] = { status: 'done', content: finalContent };
                console.log(`[Background Success] Translation completed and cached for track ${trackNum}!`);
            } catch (e) {
                console.error(`[Background Error] Track ${trackNum}:`, e.message);
                const errorSub = isAss 
                    ? `[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,فشل الترجمة النهائي. حاول مجدداً.`
                    : `1\n00:00:01,000 --> 01:00:00,000\nفشل الترجمة النهائي. حاول مجدداً.\n\n`;
                translationCache[cacheKey] = { status: 'done', content: errorSub };
            }
        });
    }

    // 4. إرسال الترجمة الوهمية فوراً لمنع الـ Timeout (خداع المشغل)
    console.log(`[Fake Sub Sent] Informing player that translation is in progress...`);
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
