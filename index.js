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
// 3. محوّل معرفات الأنمي (Kitsu -> IMDb)
//    الطريقة 1: خدمة ARM   |   الطريقة 2 (احتياطية): إضافة Kitsu القديمة
// ==========================================
const armCache = new Map();
const ARM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 ساعة

// الطريقة 1: خدمة ARM (arm.haglund.dev)
async function mapKitsuViaArm(kitsuId, kitsuEp) {
    const cached = armCache.get(kitsuId);
    let data;

    if (cached && (Date.now() - cached.time) < ARM_CACHE_TTL) {
        data = cached.data;
    } else {
        const armUrl = `https://arm.haglund.dev/api/v2/ids?source=kitsu&id=${encodeURIComponent(kitsuId)}`;
        const r = await axios.get(armUrl, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
        });
        data = r.data;
        // نخزن فقط النتائج المفيدة (التي فيها رقم IMDb)
        if (data && data.imdb) armCache.set(kitsuId, { time: Date.now(), data });
    }

    if (!data || !data.imdb) return null;

    const imdbId = Array.isArray(data.imdb) ? data.imdb[0] : data.imdb;
    if (!imdbId) return null;

    // الموسم: إن لم تُرجع الخدمة موسماً (مثل ون بيس) نستخدم 1
    let season = data['thetvdb-season'];
    if (season === null || season === undefined) season = data['themoviedb-season'];
    if (season === null || season === undefined) season = 1;

    return `${imdbId}:${season}:${kitsuEp}`;
}

// الطريقة 2 (احتياطية): إضافة Kitsu القديمة
async function mapKitsuViaKitsuAddon(targetId, kitsuId, kitsuEp) {
    const kitsuMetaUrl = `https://anime-kitsu.strem.fun/meta/anime/kitsu:${kitsuId}.json`;
    const metaRes = await axios.get(kitsuMetaUrl, {
        timeout: 8000,
        headers: { 'User-Agent': 'Stremio/4.4.16 (Windows)' }
    });

    const videos = metaRes.data && metaRes.data.meta && metaRes.data.meta.videos;
    if (!videos) return null;

    const epData = videos.find(v => v.id === targetId) || videos.find(v => v.episode === kitsuEp);
    if (epData && epData.imdb_id) {
        const s = epData.imdbSeason || epData.season || 1;
        const e = epData.imdbEpisode || epData.episode || kitsuEp;
        return `${epData.imdb_id}:${s}:${e}`;
    }
    return null;
}

// الدالة الرئيسية: تجرّب الطريقة 1 ثم 2، وترجع null إذا فشلتا
async function mapKitsuToImdb(targetId) {
    const parts = targetId.split(':');
    if (parts.length !== 3) return null;

    const kitsuId = parts[1];
    const kitsuEp = parseInt(parts[2], 10);
    if (!kitsuId || isNaN(kitsuEp)) return null;

    console.log(`[Anime Mapper] Searching mapping for Kitsu ID: ${kitsuId}, Ep: ${kitsuEp}`);

    try {
        const viaArm = await mapKitsuViaArm(kitsuId, kitsuEp);
        if (viaArm) {
            console.log(`[Anime Mapper] ARM mapped ${targetId} -> ${viaArm}`);
            return viaArm;
        }
        console.log(`[Anime Mapper] ARM returned no IMDb match for ${targetId}`);
    } catch (err) {
        console.error(`[Anime Mapper] ARM failed for ${targetId} - ${err.message}`);
    }

    try {
        const viaKitsu = await mapKitsuViaKitsuAddon(targetId, kitsuId, kitsuEp);
        if (viaKitsu) {
            console.log(`[Anime Mapper] Kitsu addon mapped ${targetId} -> ${viaKitsu}`);
            return viaKitsu;
        }
        console.log(`[Anime Mapper] Kitsu addon returned no IMDb match for ${targetId}`);
    } catch (err) {
        console.error(`[Anime Mapper] Kitsu addon failed for ${targetId} - ${err.message}`);
    }

    return null;
}

// ==========================================
// 4. جلب ترجمات ASS/SSA الأصلية من OpenSubtitles.org (القديم عبر rest.opensubtitles.org)
//    هذا مصدر منفصل تماماً عن opensubtitles-v3.strem.io المستخدم في SRT،
//    لأن الأخير بيحول كل شيء لـ SRT تلقائياً قبل ما يوصلنا (proxySrtOrVtt)
//    وبالتالي مفيش ASS خام هيوصل منه أبداً. rest.opensubtitles.org بيرجع
//    SubDownloadLink مباشر للملف الأصلي كما هو (srt أو ass أو ssa).
// ==========================================
function isLegacyAssEntry(entry) {
    const format = (entry.SubFormat || '').toLowerCase();
    const fname = (entry.SubFileName || entry.MovieReleaseName || '').toLowerCase();
    return format === 'ass' || format === 'ssa' || fname.endsWith('.ass') || fname.endsWith('.ssa');
}

// نفس منطق المطابقة الذكية لرقم الحلقة (لحالة حزم المواسم الكاملة)
function matchesEpisodeNumber(fileName, targetEpisode) {
    if (!targetEpisode) return true;
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

async function fetchLegacyAssList(url) {
    try {
        const res = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'VLSub 0.10.3',
                'X-User-Agent': 'VLSub 0.10.3',
                'Accept': 'application/json'
            }
        });
        const data = res.data;
        if (!Array.isArray(data)) return [];
        return data
            .filter(isLegacyAssEntry)
            .map(entry => ({
                url: entry.SubDownloadLink,
                fileName: entry.SubFileName || entry.MovieReleaseName || 'OpenSubtitles-ASS'
            }))
            .filter(s => !!s.url);
    } catch (e) {
        console.error(`[Legacy ASS Fetch Error] ${e.message}`);
        return [];
    }
}

// يرجع مصفوفة ملفات ASS/SSA خام (بدون أي تحويل) بلغات المصدر المطلوبة
async function fetchOriginalAssSubs(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
    // نفس اللغات المصدر المستخدمة في مسار SRT: انجليزي، ياباني، تركي، فارسي، روسي، كوري، فرنسي، اسباني
    const srcLangs = 'eng,jpn,tur,per,rus,kor,fre,spa';

    let primaryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-${srcLangs}`;
    if (season != null && episode != null && !isNaN(season) && !isNaN(episode)) {
        primaryUrl = `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-${srcLangs}`;
    }

    let results = await fetchLegacyAssList(primaryUrl);

    // لو مفيش ASS للحلقة بالضبط، جرب حزمة الموسم الكاملة وفلتر برقم الحلقة (نفس فكرة matchEpisode)
    if (results.length === 0 && season != null && episode != null && !isNaN(season) && !isNaN(episode)) {
        const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-${srcLangs}`;
        const fallbackResults = await fetchLegacyAssList(fallbackUrl);
        results = fallbackResults.filter(r => matchesEpisodeNumber(r.fileName, episode));
    }

    return results;
}

// ==========================================
// المانيفست الأساسي
// ==========================================
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.9.1',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Auto-translate subtitles to Arabic using Gemini. Strict SDH removal, 6 SRT tracks + 3 ASS tracks.',
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
// مسار جلب الترجمات (SRT + ASS مع دعم لغات متعددة)
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

    let type = req.params.type;
    const baseUrl = getBaseUrl(req);

    try {
        let subtitlesData = [];
        let finalTargetId = targetId;
        let finalType = type;

        // === دعم الأنمي: تحويل معرّف Kitsu إلى معرّف IMDb (ARM أولاً ثم الطريقة القديمة) ===
        if (targetId.startsWith('kitsu')) {
            const mapped = await mapKitsuToImdb(targetId);
            if (mapped) {
                finalTargetId = mapped;
                finalType = 'series';
                console.log(`[Anime Mapper] Successfully mapped! ${targetId} -> ${finalTargetId}`);
            } else {
                console.log(`[Anime Mapper] No mapping found for ${targetId}, using it as-is.`);
            }
        }

        // === توحيد النوع: OpenSubtitles يعرف movie و series فقط ===
        // إذا وصل معرّف tt بنوع anime أو other نحوّله للنوع الصحيح
        if (/^tt\d+/.test(finalTargetId) && finalType !== 'movie' && finalType !== 'series') {
            finalType = finalTargetId.includes(':') ? 'series' : 'movie';
        }
        // ==========================================================

        // جلب الترجمة من المحرك الأساسي والموثوق
        const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${finalType}/${finalTargetId}.json`;
        console.log(`[Fetch] Requesting subtitles from: ${osUrl}`);
        
        const r = await axios.get(osUrl, { timeout: 10000 });
        if (r.data && r.data.subtitles) subtitlesData = r.data.subtitles;
        console.log(`[Fetch] OpenSubtitles returned ${subtitlesData.length} subtitle(s) for ${finalTargetId}`);

        if (subtitlesData.length > 0) {
            
            // إضافة اللغات المطلوبة: انجليزي، ياباني، تركي، فارسي، روسي، كوري، فرنسي، اسباني
            const targetLangs = ['en', 'eng', 'ja', 'jpn', 'jap', 'tr', 'tur', 'fa', 'per', 'fas', 'ru', 'rus', 'ko', 'kor', 'fr', 'fre', 'fra', 'es', 'spa'];
            
            const validSubs = subtitlesData.filter(s => {
                const lang = (s.lang || '').toLowerCase();
                return targetLangs.some(l => lang === l || lang.startsWith(l));
            });
            
            // استبعاد SDH مطلقاً ونهائياً
            const cleanSubs = validSubs.filter(sub => {
                const title = (sub.title || '').toLowerCase();
                const idStr = (sub.id || '').toLowerCase();
                return !(title.includes('sdh') || title.includes('hi ') || title.includes('hearing impaired') || idStr.includes('sdh') || idStr.includes('hi'));
            });

            if (cleanSubs.length === 0) {
                console.log(`[Fetch] No usable subtitles left after language/SDH filters for ${finalTargetId}`);
                return res.json({ subtitles: [] });
            }

            // الفرز لإبقاء SRT واستبعاد أي ملف ASS (هذا الفرع يبقى كما هو تماماً - لا تعديل)
            const srtSubs = cleanSubs.filter(s => {
                const fname = (s.subtitleFileName || '').toLowerCase();
                const url = (s.url || '').toLowerCase();
                return !fname.endsWith('.ass') && !fname.endsWith('.ssa') && !url.includes('.ass') && !url.includes('.ssa');
            });

            const transSubs = [];
            const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
            const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;
            
            // إضافة 6 روابط SRT (بدون أي تغيير)
            if (srtSubs.length > 0) {
                for (let i = 0; i < 6; i++) {
                    const sub = srtSubs[i] || srtSubs[srtSubs.length - 1]; // تكرار الأخير إذا العدد أقل من 6
                    transSubs.push({
                        id: `nuvio-ai-srt-${i+1}`,
                        url: `${baseUrl}${streamPathSrt}?url=${encodeURIComponent(sub.url)}&track=${i+1}`,
                        lang: 'ara',
                        title: `Nuvio AI SRT ${i+1} (Sync ${String.fromCharCode(65+i)})`
                    });
                }
            }

            // === جديد: جلب ASS/SSA الأصلي حصراً من rest.opensubtitles.org (مصدر خام حقيقي)
            //     وليس من opensubtitles-v3.strem.io لأنه بيحول كل شيء لـ SRT دايماً ===
            let assImdbId = null, assSeason = null, assEpisode = null;
            const idParts = finalTargetId.split(':');
            if (idParts[0] && idParts[0].startsWith('tt')) {
                assImdbId = idParts[0];
                if (idParts.length >= 3) {
                    assSeason = parseInt(idParts[1], 10);
                    assEpisode = parseInt(idParts[2], 10);
                }
            }

            const assResults = await fetchOriginalAssSubs(assImdbId, assSeason, assEpisode);

            if (assResults.length > 0) {
                for (let i = 0; i < 3; i++) {
                    const sub = assResults[i] || assResults[assResults.length - 1]; // تكرار الأخير إذا العدد أقل من 3
                    transSubs.push({
                        id: `nuvio-ai-ass-${i+1}`,
                        url: `${baseUrl}${streamPathAss}?url=${encodeURIComponent(sub.url)}&track=${i+1}`,
                        lang: 'ara',
                        title: `Nuvio AI ASS ${i+1} (Sync ${String.fromCharCode(65+i)})`
                    });
                }
                console.log(`[Fetch] Added 3 ASS track(s) from ${assResults.length} original ASS source(s) via rest.opensubtitles.org for ${finalTargetId}`);
            } else {
                console.log(`[Fetch] No original ASS/SSA found via rest.opensubtitles.org for ${finalTargetId} - skipping ASS tracks`);
            }

            return res.json({ subtitles: transSubs });
        }
        return res.json({ subtitles: [] });
    } catch (err) {
        console.error(`[Subtitles Error] ${targetId} - ${err.message}`);
        return res.json({ subtitles: [] });
    }
});

app.all([
    '/stream-ai.srt', '/:config/stream-ai.srt'
], async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    
    const targetUrl = req.query.url;
    const trackNum = req.query.track || '1';
    if (!targetUrl) return res.status(400).send('Missing URL');

    const cacheKey = `SRT_${targetUrl}`;
    
    if (translationCache[cacheKey] && translationCache[cacheKey].status === 'done') {
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-SRT.srt"`);
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
                const finalContent = await handleTranslationSrt(targetUrl, userKeys, userModel);
                translationCache[cacheKey] = { status: 'done', content: finalContent };
            } catch (e) {
                console.error(`[Background Error] Track ${trackNum}:`, e.message);
                const errorSub = `1\n00:00:01,000 --> 01:00:00,000\nفشل الترجمة النهائي. حاول مجدداً.\n\n`;
                translationCache[cacheKey] = { status: 'done', content: errorSub };
            }
        });
    }

    const fakeSub = `1\n00:00:01,000 --> 01:00:00,000\nالترجمة قيد التنفيذ ⏳\nانقر لإعادة التحميل بمجرد جاهزيتها.\n\n`;

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Trans-Wait-SRT.srt"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fakeSub);
});

// === جديد: مسار بث ترجمات ASS مترجمة - نفس منطق SRT تماماً لكن بدون أي تحويل نوع ===
app.all([
    '/stream-ai.ass', '/:config/stream-ai.ass'
], async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);

    const targetUrl = req.query.url;
    const trackNum = req.query.track || '1';
    if (!targetUrl) return res.status(400).send('Missing URL');

    // مفتاح كاش منفصل تماماً عن SRT حتى لو كان نفس الرابط الأصلي بالمصادفة
    const cacheKey = `ASS_${targetUrl}`;

    if (translationCache[cacheKey] && translationCache[cacheKey].status === 'done') {
        res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-ASS.ass"`);
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
                const finalContent = await handleTranslationAss(targetUrl, userKeys, userModel);
                translationCache[cacheKey] = { status: 'done', content: finalContent };
            } catch (e) {
                console.error(`[Background Error - ASS] Track ${trackNum}:`, e.message);
                const errorSub = `[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,فشل الترجمة النهائي. حاول مجدداً.`;
                translationCache[cacheKey] = { status: 'done', content: errorSub };
            }
        });
    }

    const fakeSub = `[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,الترجمة قيد التنفيذ ⏳ انقر لإعادة التحميل بمجرد جاهزيتها.`;

    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Trans-Wait-ASS.ass"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fakeSub);
});

app.listen(PORT, () => {
    console.log(`✅ Nuvio AI Subs Server is LIVE on port ${PORT}`);
});

module.exports = app;
