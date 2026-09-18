const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();

// إعدادات الحماية والوصول
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// إعدادات الإضافة الأساسية
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.0.0',
    name: 'Nuvio AI Subs',
    description: 'Auto-translate any subtitle into Arabic using APInex AI Model.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    }
};

// دالة لجلب رابط السيرفر الأساسي
function getBaseUrl(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${host}`;
}

// الصفحة الرئيسية وواجهة التثبيت
app.get(['/', '/configure'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <title>Nuvio AI Subs</title>
        <style>
            body { background: #0b1120; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            h1 { color: #38bdf8; }
            .btn { background: #0284c7; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; transition: 0.3s; }
            .btn:hover { background: #0369a1; box-shadow: 0 4px 15px rgba(2, 132, 199, 0.5); }
        </style>
    </head>
    <body>
        <h1>Nuvio AI Subs</h1>
        <p>هذه الإضافة متخصصة في جلب الترجمات الأجنبية وترجمتها للعربية فورياً بواسطة الذكاء الاصطناعي (APInex).</p>
        <a class="btn" href="stremio://${req.headers.host}/manifest.json">تثبيت الإضافة 🚀</a>
    </body>
    </html>
    `);
});

// مسار المانيفست اللي يتعرف عليه Nuvio
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(MANIFEST);
});

// دالة البحث عن الترجمة الإنجليزية الأصلية كمرجع
async function findEnglishSubtitle(imdbId, season, episode, type) {
    try {
        const url = `https://api.subdl.com/api/v1/subtitles?imdb_id=${imdbId}${type === 'series' ? `&season_number=${season}&episode_number=${episode}` : ''}&languages=EN`;
        const r = await axios.get(url, { timeout: 10000 });
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            const firstSub = r.data.subtitles[0];
            return `https://dl.subdl.com${firstSub.url}`;
        }
    } catch (e) {
        console.error("SubDL Fetch Error:", e.message);
    }
    return null;
}

// مسار معالجة الترجمات وإرسالها للتطبيق
app.get('/subtitles/:type/:id', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    let targetId = req.params.id || '';
    if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);

    const type = req.params.type;
    const parts = targetId.split(':');
    const imdbId = parts[0];
    const season = parts[1] || 1;
    const episode = parts[2] || 1;
    const baseUrl = getBaseUrl(req);

    try {
        const subUrl = await findEnglishSubtitle(imdbId, season, episode, type);
        
        if (!subUrl) {
             return res.json({ subtitles: [] });
        }

        const encodedUrl = encodeURIComponent(subUrl);
        const transSubs = [
            {
                id: \`nuvio-ai-srt-1\`,
                url: \`${baseUrl}/stream-ai.srt?url=${encodedUrl}\`,
                lang: 'ara',
                format: 'srt'
            },
            {
                id: \`nuvio-ai-ass-1\`,
                url: \`${baseUrl}/stream-ai.ass?url=${encodedUrl}\`,
                lang: 'ara',
                format: 'ass'
            }
        ];

        res.json({ subtitles: transSubs });
    } catch (err) {
        console.error("Subtitle Route Error:", err.message);
        res.json({ subtitles: [] });
    }
});

// مسار البث والترجمة الحية عبر الذكاء الاصطناعي
app.get(['/stream-ai.srt', '/stream-ai.ass', '/stream-ai.ssa'], async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    const isAss = req.path.endsWith('.ass') || req.path.endsWith('.ssa');
    
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
    } catch (e) {
        console.error('AI Translation Error:', e.message);
        res.status(500).send('Error generating AI translation');
    }
});

// تشغيل السيرفر الدائم على Render بدون شروط
app.listen(PORT, () => {
    console.log(\`✅ Nuvio AI Subs Server is LIVE and listening on port \${PORT}\`);
});

module.exports = app;
