const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// رفعنا الإصدار حتى Nuvio يفرمت الكاش ويقراها كإضافة جديدة
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.0.3',
    name: 'Nuvio AI Subs',
    description: 'Auto-translate any subtitle into Arabic using APInex AI Model.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime', 'other'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
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
        <title>Nuvio AI Subs (v1.0.3)</title>
        <style>
            body { background: #0b1120; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            h1 { color: #38bdf8; }
            .btn { background: #0284c7; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; transition: 0.3s; }
            .btn:hover { background: #0369a1; box-shadow: 0 4px 15px rgba(2, 132, 199, 0.5); }
        </style>
    </head>
    <body>
        <h1>Nuvio AI Subs (v1.0.3)</h1>
        <p>هذه الإضافة جاهزة وتسحب الترجمات مجاناً بدون API Keys للتحويل عبر الذكاء الاصطناعي.</p>
        <a class="btn" href="stremio://${req.headers.host}/manifest.json">تثبيت الإضافة 🚀</a>
    </body>
    </html>
    `);
});

// مسار المانيفست متوافق مع Vercel
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(MANIFEST);
});

// مسار جلب الترجمات (نفس نظام Vercel بالضبط للروابط الذكية)
app.get([
  '/subtitles/:type/:reqId(*)', 
  '/:config/subtitles/:type/:reqId(*)'
], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    // استخراج الـ ID النظيف (مثال: tt0903747:1:1)
    let targetId = req.params.reqId.split('/')[0];
    if (targetId.endsWith('.json')) {
        targetId = targetId.slice(0, -5);
    }

    const type = req.params.type;
    const baseUrl = getBaseUrl(req);

    console.log(`[Request] Nuvio is asking for: ${type} - ${targetId}`);

    try {
        // الحركة الذكية: البحث في إضافة OpenSubtitles الرسمية المجانية بدون مفاتيح
        const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/${targetId}.json`;
        const r = await axios.get(osUrl, { timeout: 10000 });
        
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            // نبحث عن أي ترجمة إنجليزية كمرجع للذكاء الاصطناعي
            let sourceSub = r.data.subtitles.find(s => (s.lang || '').toLowerCase().startsWith('en'));
            
            // إذا ماكو إنجليزي، ناخذ أول ترجمة متوفرة
            if (!sourceSub) {
                sourceSub = r.data.subtitles[0];
            }

            const sourceUrl = sourceSub.url;
            const encodedUrl = encodeURIComponent(sourceUrl);
            
            // تجهيز الـ 5 خيارات مالتك للذكاء الاصطناعي
            const transSubs = [
                { id: 'nuvio-ai-srt-1', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', title: 'APInex SRT 1' },
                { id: 'nuvio-ai-srt-2', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', title: 'APInex SRT 2' },
                { id: 'nuvio-ai-srt-3', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', title: 'APInex SRT 3' },
                { id: 'nuvio-ai-ass-1', url: `${baseUrl}/stream-ai.ass?url=${encodedUrl}`, lang: 'ara', title: 'APInex ASS 1' },
                { id: 'nuvio-ai-ass-2', url: `${baseUrl}/stream-ai.ass?url=${encodedUrl}`, lang: 'ara', title: 'APInex ASS 2' }
            ];

            console.log(`[Success] Retrieved free source & sent 5 AI links to Nuvio!`);
            return res.json({ subtitles: transSubs });
        }
        
        // إذا ماكو أي ترجمة أصلية
        console.log(`[Result] No source found at all.`);
        return res.json({ subtitles: [] });
        
    } catch (err) {
        console.error("[Search Error]:", err.message);
        return res.json({ subtitles: [] });
    }
});

// مسار الترجمة بالذكاء الاصطناعي
app.all(['/stream-ai.srt', '/stream-ai.ass', '/stream-ai.ssa'], async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    const isAss = req.path.endsWith('.ass') || req.path.endsWith('.ssa');
    
    console.log(`[Translating...] isAss: ${isAss}`);

    try {
        let finalContent = '';
        if (isAss) {
            finalContent = await handleTranslationAss(targetUrl);
            res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
            res.setHeader('Content-Disposition', 'inline; filename="Trans-ASS.ssa"');
        } else {
            finalContent = await handleTranslationSrt(targetUrl);
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', 'inline; filename="Trans-SRT.srt"');
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.send(finalContent);
        console.log(`[Translate Success] Delivery Done!`);
    } catch (e) {
        console.error('[Translation Error]:', e.message);
        res.status(500).send('Error generating AI translation');
    }
});

// تشغيل سيرفر ريندر بشكل مستمر
app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE on port ${PORT}`);
});

module.exports = app;
