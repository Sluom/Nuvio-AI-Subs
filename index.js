const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// المانيفست متوافق مع هيكل إضافتك الثانية
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.0.2',
    name: 'Nuvio AI Subs',
    description: 'Auto-translate any subtitle into Arabic using APInex AI Model.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],
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
        <title>Nuvio AI Subs (v1.0.2)</title>
        <style>
            body { background: #0b1120; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            h1 { color: #38bdf8; }
            .btn { background: #0284c7; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; transition: 0.3s; }
            .btn:hover { background: #0369a1; box-shadow: 0 4px 15px rgba(2, 132, 199, 0.5); }
        </style>
    </head>
    <body>
        <h1>Nuvio AI Subs (v1.0.2)</h1>
        <p>هذه الإضافة تسحب أي ترجمة وتحولها للعربية فورياً عبر الذكاء الاصطناعي.</p>
        <a class="btn" href="stremio://${req.headers.host}/manifest.json">تثبيت الإضافة 🚀</a>
    </body>
    </html>
    `);
});

// دعم المانيفست مع وبدون Config (نفس كود Vercel مالتك)
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(MANIFEST);
});

async function findSourceSubtitle(imdbId, season, episode, type) {
    try {
        let url = `https://api.subdl.com/api/v1/subtitles?imdb_id=${imdbId}`;
        if (type === 'series') {
            url += `&season_number=${season}&episode_number=${episode}`;
        }
        
        console.log(`[Search] SubDL => ID: ${imdbId}`);
        
        const r = await axios.get(url, { 
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } 
        });
        
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            let selectedSub = r.data.subtitles.find(sub => sub.language && sub.language.toLowerCase() === 'english');
            if (!selectedSub) selectedSub = r.data.subtitles[0];
            
            const dlLink = `https://dl.subdl.com${selectedSub.url}`;
            return dlLink;
        }
    } catch (e) {
        console.error("[Search Error]:", e.message);
    }
    return null;
}

// التعديل الأهم: مسارات متوافقة 100% مع Nuvio (نسخاً من كود Vercel)
app.get([
  '/subtitles/:type/:id', 
  '/subtitles/:type/:id/:extra',
  '/:config/subtitles/:type/:id',
  '/:config/subtitles/:type/:id/:extra'
], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    // معالجة الـ ID بنفس طريقتك الذكية
    let targetId = req.params.id || '';
    if (targetId.endsWith('.json')) {
        targetId = targetId.slice(0, -5);
    }

    const type = req.params.type;
    const parts = targetId.split(':');
    const imdbId = parts[0];
    const season = parts[1] || 1;
    const episode = parts[2] || 1;
    const baseUrl = getBaseUrl(req);

    console.log(`[Nuvio Request] Type=${type} | ID=${imdbId}`);

    try {
        const subUrl = await findSourceSubtitle(imdbId, season, episode, type);
        
        if (!subUrl) {
             return res.json({ subtitles: [] });
        }

        const encodedUrl = encodeURIComponent(subUrl);
        
        const transSubs = [
            { id: 'nuvio-ai-srt-1', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', format: 'srt' },
            { id: 'nuvio-ai-srt-2', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', format: 'srt' },
            { id: 'nuvio-ai-srt-3', url: `${baseUrl}/stream-ai.srt?url=${encodedUrl}`, lang: 'ara', format: 'srt' },
            { id: 'nuvio-ai-ass-1', url: `${baseUrl}/stream-ai.ass?url=${encodedUrl}`, lang: 'ara', format: 'ass' },
            { id: 'nuvio-ai-ass-2', url: `${baseUrl}/stream-ai.ass?url=${encodedUrl}`, lang: 'ara', format: 'ass' }
        ];

        console.log(`[Success] 5 AI Subtitles sent!`);
        res.json({ subtitles: transSubs });
    } catch (err) {
        console.error("[Route Error]:", err.message);
        res.json({ subtitles: [] });
    }
});

app.all(['/stream-ai.srt', '/stream-ai.ass', '/stream-ai.ssa'], async (req, res) => {
    // دعم OPTIONS مثل Vercel
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
            res.setHeader('Content-Disposition', 'inline; filename="subtitle.ssa"');
        } else {
            finalContent = await handleTranslationSrt(targetUrl);
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', 'inline; filename="subtitle.srt"');
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.send(finalContent);
    } catch (e) {
        console.error('[Translation Error]:', e.message);
        res.status(500).send('Error generating translation');
    }
});

// ريندر يحتاج السيرفر يشتغل دائماً بدون شرط (عكس Vercel)
app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE on port ${PORT}`);
});

module.exports = app;
