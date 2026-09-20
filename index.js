const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// ==========================================
// 🚀 الطابور الذكي (Global Queue) لمنع الـ Timeout والـ Quota
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

const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.4.0',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Auto-translate subtitles to Arabic using unlimited Gemini API keys with Key Rotation and Smart Queue limits.',
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
        <h1>إعدادات المترجم الذكي</h1>
        <div class="container">
            <p style="text-align: center; font-size: 14px; color: #cbd5e1; margin-bottom: 25px;">أضف مفاتيح Gemini API الخاصة بك هنا. النظام سيبدل بينها تلقائياً لتجاوز حدود الطلبات (Key Rotation).</p>
            
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
                    <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite (beta)</option>
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
        modifiedManifest.description = '✅ مفعل! جاهز للترجمة التلقائية باستخدام مفاتيحك المتعددة والطابور الذكي.';
        modifiedManifest.name = 'Nuvio AI Subs (Active)';
    }
    
    res.json(modifiedManifest);
});

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

    console.log(`[Request] Nuvio is asking for: ${type} - ${targetId}`);

    try {
        const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/${targetId}.json`;
        const r = await axios.get(osUrl, { timeout: 10000 });
        
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            let sourceSub = r.data.subtitles.find(s => (s.lang || '').toLowerCase().startsWith('en'));
            if (!sourceSub) sourceSub = r.data.subtitles[0];

            const sourceUrl = sourceSub.url;
            const encodedUrl = encodeURIComponent(sourceUrl);
            
            const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
            const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;
            
            // إضافة 5 روابط بناءً على طلبك (3 SRT و 2 ASS)
            const transSubs = [
                { id: 'nuvio-ai-srt-1', url: `${baseUrl}${streamPathSrt}?url=${encodedUrl}&track=1`, lang: 'ara', title: 'Nuvio AI SRT 1 (Gemini)' },
                { id: 'nuvio-ai-srt-2', url: `${baseUrl}${streamPathSrt}?url=${encodedUrl}&track=2`, lang: 'ara', title: 'Nuvio AI SRT 2 (Gemini)' },
                { id: 'nuvio-ai-srt-3', url: `${baseUrl}${streamPathSrt}?url=${encodedUrl}&track=3`, lang: 'ara', title: 'Nuvio AI SRT 3 (Gemini)' },
                { id: 'nuvio-ai-ass-1', url: `${baseUrl}${streamPathAss}?url=${encodedUrl}&track=4`, lang: 'ara', title: 'Nuvio AI ASS 1 (Gemini)' },
                { id: 'nuvio-ai-ass-2', url: `${baseUrl}${streamPathAss}?url=${encodedUrl}&track=5`, lang: 'ara', title: 'Nuvio AI ASS 2 (Gemini)' }
            ];

            console.log(`[Success] Sent 5 AI links to Nuvio!`);
            return res.json({ subtitles: transSubs });
        }
        
        return res.json({ subtitles: [] });
    } catch (err) {
        console.error("[Search Error]:", err.message);
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
    
    let userKeys = [];
    let userModel = 'gemini-3.1-flash-lite'; 
    
    if (req.params.config) {
        try {
            const decodedConfig = JSON.parse(decodeURIComponent(req.params.config));
            if (decodedConfig.keys && Array.isArray(decodedConfig.keys)) {
                userKeys = decodedConfig.keys;
            }
            if (decodedConfig.model) {
                userModel = decodedConfig.model;
            }
        } catch (e) {
            console.error("[Config Error] Failed to parse config");
        }
    }
    
    console.log(`[Queued] Track ${trackNum} (${isAss ? 'ASS' : 'SRT'}) added to waitlist...`);

    // إرسال الطلب إلى الطابور الذكي لمعالجته بالدور
    try {
        const finalContent = await globalTranslationQueue.add(async () => {
            console.log(`[Translating...] Now processing Track ${trackNum} - isAss: ${isAss}, Model: ${userModel}`);
            if (isAss) {
                return await handleTranslationAss(targetUrl, userKeys, userModel);
            } else {
                return await handleTranslationSrt(targetUrl, userKeys, userModel);
            }
        });

        res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-${isAss ? 'ASS.ssa' : 'SRT.srt'}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.send(finalContent);
        
        console.log(`[Delivery Done] Track ${trackNum} sent to player!`);
    } catch (e) {
        console.error('[Translation Error]:', e.message);
        if (!res.headersSent) res.status(500).send('Error generating AI translation');
    }
});

app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE on port ${PORT}`);
});

module.exports = app;
