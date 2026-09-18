const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// المانيفست المعدل ليكون متوافق 100% مع Nuvio و Stremio
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.0.0',
    name: 'Nuvio AI Subs',
    description: 'Auto-translate any subtitle into Arabic using APInex AI Model.',
    resources: [
        {
            name: "subtitles",
            types: ["movie", "series", "anime"],
            idPrefixes: ["tt", "kitsu"]
        }
    ],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: false, // تم تعطيلها لأن Nuvio مرات ما يدعمها زين
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
        <p>هذه الإضافة تسحب أي ترجمة (بأي لغة متوفرة) وتحولها للعربية فورياً عبر الذكاء الاصطناعي.</p>
        <a class="btn" href="stremio://${req.headers.host}/manifest.json">تثبيت الإضافة 🚀</a>
    </body>
    </html>
    `);
});

app.get('/manifest.json', (req, res) => {
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
        
        console.log(`[Search] Searching SubDL for: ${imdbId} | URL: ${url}`);
        
        const r = await axios.get(url, { 
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } 
        });
        
        if (r.data && r.data.subtitles && r.data.subtitles.length > 0) {
            let selectedSub = r.data.subtitles.find(sub => sub.language && sub.language.toLowerCase() === 'english');
            
            if (!selectedSub) {
                selectedSub = r.data.subtitles[0];
            }
            
            const dlLink = `https://dl.subdl.com${selectedSub.url}`;
            console.log(`[Search] Found Subtitle: ${dlLink}`);
            return dlLink;
        } else {
            console.log(`[Search] No subtitles found for ${imdbId} on SubDL.`);
        }
    } catch (e) {
        console.error("[Search Error] SubDL failed:", e.message);
    }
    return null;
}

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

    console.log(`[Request] Nuvio asked for: Type=${type}, ID=${imdbId}, Season=${season}, Episode=${episode}`);

    try {
        const subUrl = await findSourceSubtitle(imdbId, season, episode, type);
        
        if (!subUrl) {
             console.log(`[Result] Returning empty array to Nuvio for ${imdbId}`);
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

        console.log(`[Result] Sending 5 AI options to Nuvio for ${imdbId}`);
        res.json({ subtitles: transSubs });
    } catch (err) {
        console.error("Subtitle Route Error:", err.message);
        res.json({ subtitles: [] });
    }
});

app.get(['/stream-ai.srt', '/stream-ai.ass', '/stream-ai.ssa'], async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    const isAss = req.path.endsWith('.ass') || req.path.endsWith('.ssa');
    
    console.log(`[Translate] Starting translation for: ${targetUrl} (isAss: ${isAss})`);

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
        console.log(`[Translate] Translation sent successfully!`);
    } catch (e) {
        console.error('[Translate Error]:', e.message);
        res.status(500).send('Error generating AI translation');
    }
});

app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE and listening on port ${PORT}`);
});

module.exports = app;
