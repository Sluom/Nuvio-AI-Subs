const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrtDetailed, handleTranslationAssDetailed } = require('./ai');
const { getSubDLEnglish } = require('./subdl');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

// للاختبار فقط: ضع FORCE_SUBDL=1 بريندر ليستخدم SubDL حتى لو OpenSubtitles رجّع ترجمات
// (احذف المتغير بعد ما تتأكد أن SubDL يشتغل)
const FORCE_SUBDL = process.env.FORCE_SUBDL === '1';

// ==========================================
// 1. ذاكرة السيرفر (Cache) لتخزين الترجمات الجاهزة
// ==========================================
const translationCache = {};

// ==========================================
// 2. الطابور الذكي (Global Queue) للعمل بالخلفية - يدعم تنفيذ متوازي (concurrency)
// ==========================================
class RequestQueue {
    constructor(concurrency = 2) {
        this.queue = [];
        this.activeCount = 0;
        this.concurrency = concurrency;
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
            this.processNext();
        });
    }

    processNext() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            this.activeCount++;
            Promise.resolve()
                .then(() => task())
                .catch(e => console.error("[Queue Error]", e.message))
                .finally(() => {
                    this.activeCount--;
                    this.processNext();
                });
        }
    }
}

const globalTranslationQueue = new RequestQueue(1);

// ==========================================
// 2.5 مشغّل الترجمة بالخلفية
// ==========================================
const MAX_BACKGROUND_ROUNDS = 3;
const ROUND_PAUSE_MS = 30000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startTranslationJob({ cacheKey, handler, targetUrl, userKeys, userModel, userTmdbKey, trackNum, label, targetId, kitsuId }) {
    translationCache[cacheKey] = { status: 'pending' };

    globalTranslationQueue.add(async () => {
        try {
            for (let round = 1; round <= MAX_BACKGROUND_ROUNDS; round++) {
                // تمرير kitsuId للـ handler
                const r = await handler(targetUrl, userKeys, userModel, userTmdbKey, targetId, kitsuId);

                if (r.failed) {
                    console.error(`[${label}] Track ${trackNum}: فشل تحميل/استخراج الملف الأصلي. ستُعاد المحاولة عند الضغطة القادمة.`);
                    const cur = translationCache[cacheKey];
                    if (!cur || cur.status !== 'done') delete translationCache[cacheKey];
                    return;
                }

                translationCache[cacheKey] = { status: 'done', content: r.content, complete: r.missing === 0 };

                if (r.missing === 0) {
                    if (round > 1) console.log(`[${label}] Track ${trackNum}: اكتملت الترجمة بعد ${round} جولات ✅`);
                    return;
                }

                console.log(`[${label}] Track ${trackNum}: ناقص ${r.missing} من ${r.total} سطر (جولة ${round}/${MAX_BACKGROUND_ROUNDS}). الترجمة الحالية جاهزة للمستخدم.`);
                if (round < MAX_BACKGROUND_ROUNDS) await sleep(ROUND_PAUSE_MS);
            }
        } catch (e) {
            console.error(`[Background Error - ${label}] Track ${trackNum}:`, e.message);
            const cur = translationCache[cacheKey];
            if (!cur || cur.status !== 'done') delete translationCache[cacheKey];
        }
    });
}

// ==========================================
// 3. محوّل معرفات الأنمي (Kitsu -> IMDb)
// ==========================================
const armCache = new Map();
const ARM_CACHE_TTL = 24 * 60 * 60 * 1000;

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
        if (data && data.imdb) armCache.set(kitsuId, { time: Date.now(), data });
    }

    if (!data || !data.imdb) return null;

    const imdbId = Array.isArray(data.imdb) ? data.imdb[0] : data.imdb;
    if (!imdbId) return null;

    let season = data['thetvdb-season'];
    if (season === null || season === undefined) season = data['themoviedb-season'];
    if (season === null || season === undefined) season = 1;

    return `${imdbId}:${season}:${kitsuEp}`;
}

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
// 3.4 تحويل ترقيم tt:S:E (مواسم) إلى الترقيم المطلق tt:1:ABS
// مثال: One Piece tt0388629:9:17 -> tt0388629:1:160
// (مواقع الترجمة تخزّن بعض الأنمي بالرقم المطلق، فلو ما حولنا ترجع النتيجة فارغة)
// ==========================================
const absCache = new Map();
const ABS_CACHE_TTL = 24 * 60 * 60 * 1000;

async function osCount(id) {
    try {
        const r = await axios.get(`https://opensubtitles-v3.strem.io/subtitles/series/${id}.json`, { timeout: 8000 });
        return (r.data && Array.isArray(r.data.subtitles)) ? r.data.subtitles.length : 0;
    } catch (e) {
        return 0;
    }
}

// يرجع معرف بديل بالترقيم المطلق (tt:1:ABS) أو null إذا ما احتاج/ما لقى
async function resolveAbsoluteTtId(ttId) {
    const cached = absCache.get(ttId);
    if (cached && (Date.now() - cached.time) < ABS_CACHE_TTL) return cached.value;

    const [imdbId, s, e] = ttId.split(':');
    const season = parseInt(s, 10);
    const episode = parseInt(e, 10);
    if (!imdbId || isNaN(season) || isNaN(episode) || season <= 1) return null;

    let result = null;
    try {
        // إذا OpenSubtitles عنده ترجمات للترقيم الأصلي، لا نغيّر شي
        const direct = await osCount(ttId);
        if (direct > 0) {
            absCache.set(ttId, { time: Date.now(), value: null });
            return null;
        }

        // نحسب الرقم المطلق = عدد حلقات المواسم السابقة + رقم الحلقة
        const meta = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const videos = (meta.data && meta.data.meta && meta.data.meta.videos) || [];
        const before = videos.filter(v => v.season > 0 && v.season < season).length;

        if (before > 0) {
            const absolute = before + episode;
            const candidate = `${imdbId}:1:${absolute}`;
            const n = await osCount(candidate);
            console.log(`[TT Remap] ${ttId}: حلقات قبل الموسم=${before} -> ${candidate} (OpenSubtitles: ${n} ترجمة)`);
            if (n > 0) result = candidate;
        } else {
            console.log(`[TT Remap] ${ttId}: Cinemeta ما رجّع مواسم سابقة، ما أقدر أحسب الرقم المطلق`);
        }
    } catch (err) {
        console.error(`[TT Remap] فشل لـ ${ttId}: ${err.message}`);
        return null; // لا نخزّن الفشل
    }

    absCache.set(ttId, { time: Date.now(), value: result });
    return result;
}

// ==========================================
// 3.5 كاشف ترجمات الصم وضعاف السمع (SDH)
// ==========================================
function isHearingImpairedSub(sub) {
    if (!sub) return false;
    if (sub.hearingImpaired === true) return true;

    const fields = [sub.title, sub.id, sub.url, sub.subtitleFileName, sub.fileName]
        .filter(Boolean)
        .map(f => String(f).toLowerCase());

    const patterns = [
        /\bsdh\b/,
        /\bhi\b/,
        /\bcc\b/,
        /hearing[\s_-]*impaired/,
        /closed[\s_-]*caption/,
        /\bdeaf\b/
    ];

    return fields.some(text => patterns.some(p => p.test(text)));
}

// ==========================================
// 4. جلب ترجمات ASS/SSA الأصلية
// ==========================================
function matchEpisode(fileName, targetEpisode) {
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

async function fetchLegacyData(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'VLSub 0.10.3',
                'X-User-Agent': 'VLSub 0.10.3',
                'Accept': 'application/json'
            }
        });

        // [DEBUG-1] رمز رد السيرفر القديم
        console.log(`[Legacy] ${response.status} <- ${url}`);

        if (!response.ok) return [];
        const data = await response.json();
        if (!Array.isArray(data)) return [];

        // [DEBUG-2] عدد النتائج وعدد ملفات ASS منها
        console.log(`[Legacy] رجع ${data.length} نتيجة، منها ASS: ${data.filter(e => /^(ass|ssa)$/i.test(e.SubFormat || '') || /\.(ass|ssa)/i.test(e.SubFileName || '')).length}`);

        const results = [];
        data.forEach(entry => {
            const downloadLink = entry.SubDownloadLink;
            if (!downloadLink) return;

            const format = (entry.SubFormat || '').toLowerCase();
            const rawName = entry.SubFileName || entry.MovieReleaseName || 'OpenSubtitles Legacy';
            const isAss = format === 'ass' || format === 'ssa' || rawName.toLowerCase().includes('.ass') || rawName.toLowerCase().includes('.ssa');
            const finalExt = isAss ? 'ass' : 'srt';

            const isHi = entry.SubHearingImpaired === '1' || entry.SubHearingImpaired === 1 || entry.SubHearingImpaired === true;

            // الخدعة السحرية: تحويل الرابط المضغوط إلى نص مباشر حتى يفهمه الذكاء الاصطناعي
            const directUrl = downloadLink.replace(/\.gz$/i, '') + '.' + finalExt;

            results.push({
                url: directUrl,
                lang: 'eng',
                format: finalExt,
                ext: finalExt,
                subFormat: isAss ? 'ssa' : 'srt',
                fileName: rawName,
                origName: rawName,
                hearingImpaired: isHi,
                _source: 'opensubtitles',
                _priority: isAss ? 0 : 2
            });
        });
        return results;
    } catch (e) {
        // [DEBUG-3] سبب الفشل
        console.log('[Legacy] خطأ:', e.message);
        return [];
    }
}

async function fetchLegacyApiEnglish(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');

    let primaryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
    if (season != null && episode != null) {
        primaryUrl = `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-eng`;
    }

    let results = await fetchLegacyData(primaryUrl);

    if (season != null && episode != null) {
        const hasAss = results.some(r => r.format === 'ass' || r.format === 'ssa');

        if (!hasAss) {
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-eng`;
            const fallbackResults = await fetchLegacyData(fallbackUrl);

            const filteredFallback = fallbackResults.filter(r => {
                if (r.format !== 'ass' && r.format !== 'ssa') return false;
                return matchEpisode(r.fileName, episode);
            });

            results = [...results, ...filteredFallback];
        }
    }
    return results;
}

async function fetchMirrorEnglish(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];

    try {
        const isSeries = type === 'series' || type === 'anime' || !!season;
        const mediaType = isSeries ? 'series' : 'movie';
        const mTargetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

        const url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${mTargetId}.json`;
        const response = await fetch(url, { headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' } });
        if (!response.ok) return [];
        const data = await response.json();
        const list = data.subtitles || [];

        return list
            .filter(s => {
                const lang = (s.lang || '').toLowerCase();
                return (lang === 'eng' || lang === 'en' || lang.startsWith('en')) && s.url;
            })
            .map(s => {
                const rawUrl = (s.url || '').toLowerCase();
                const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
                const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();

                const isAss = subFormat === 'ssa' || subFormat === 'ass' || rawUrl.includes('.ass') || rawUrl.includes('.ssa') || rawName.includes('.ass') || rawName.includes('.ssa');
                const format = isAss ? 'ass' : 'srt';

                const isHi = s.SubHearingImpaired === '1' || s.SubHearingImpaired === 1 || s.SubHearingImpaired === true
                    || /\bsdh\b/.test(rawName) || /\bhi\b/.test(rawName) || /hearing[\s_-]*impaired/.test(rawName)
                    || /\bsdh\b/.test(rawUrl) || /\bhi\b/.test(rawUrl);

                return {
                    url: s.url,
                    lang: 'eng',
                    format: format,
                    ext: format,
                    subFormat: isAss ? 'ssa' : 'srt',
                    fileName: s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror',
                    origName: s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror',
                    hearingImpaired: isHi,
                    _source: 'opensubtitles',
                    _priority: isAss ? 0 : 2
                };
            });
    } catch (e) {
        return [];
    }
}

async function getOpenSubtitlesEnglish({ imdbId, season, episode, type }) {
    const tasks = [];
    tasks.push(fetchLegacyApiEnglish(imdbId, season, episode));
    tasks.push(fetchMirrorEnglish(imdbId, season, episode, type));

    const settled = await Promise.allSettled(tasks);
    const allSubs = settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .filter(s => s && s.url);

    const uniqueSubs = [];
    const seenUrls = new Set();

    for (const sub of allSubs) {
        const cleanUrl = sub.url.split('?')[0];
        if (seenUrls.has(cleanUrl)) continue;
        seenUrls.add(cleanUrl);
        uniqueSubs.push(sub);
    }

    uniqueSubs.sort((a, b) => {
        const aHi = isHearingImpairedSub(a) ? 1 : 0;
        const bHi = isHearingImpairedSub(b) ? 1 : 0;
        return aHi - bHi;
    });

    return uniqueSubs;
}

// ==========================================
// المانيفست الأساسي
// ==========================================
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.9.2',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Auto-translate subtitles to Arabic using Gemini. Strict SDH removal, up to 6 SRT & 4 true ASS tracks.',
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

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    let existingKeys = [];
    let existingModel = 'gemini-3.1-flash-lite';
    let existingTmdbKey = '';

    if (req.params.config) {
        try {
            const decoded = JSON.parse(decodeURIComponent(req.params.config));
            if (Array.isArray(decoded.keys)) existingKeys = decoded.keys;
            if (decoded.model) existingModel = decoded.model;
            if (decoded.tmdbKey) existingTmdbKey = decoded.tmdbKey;
        } catch (e) {
            console.error('[Configure] Failed to parse existing config:', e.message);
        }
    }

    let keyRowsHtml = '';
    if (existingKeys.length > 0) {
        keyRowsHtml = existingKeys.map((key, i) => {
            const escapedKey = String(key).replace(/"/g, '&quot;');
            if (i === 0) {
                return `<div class="key-row"><input type="text" class="api-key" placeholder="المفتاح الأساسي (AIzaSy...)" value="${escapedKey}"></div>`;
            }
            return `<div class="key-row"><input type="text" class="api-key" placeholder="مفتاح إضافي (AIzaSy...)" value="${escapedKey}"><button class="remove-btn" onclick="this.parentElement.remove()">X</button></div>`;
        }).join('\n');
    } else {
        keyRowsHtml = `<div class="key-row"><input type="text" class="api-key" placeholder="المفتاح الأساسي (AIzaSy...)"></div>`;
    }

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
            .status-banner { background: #14532d; color: #86efac; padding: 10px; border-radius: 8px; text-align: center; margin-bottom: 20px; font-size: 14px; }
        </style>
    </head>
    <body>
        <h1>إعدادات المترجم الذكي</h1>
        <div class="container">
            ${existingKeys.length > 0 ? `<div class="status-banner">✅ تم تحميل ${existingKeys.length} مفتاح موجود مسبقًا — عدّل حسب حاجتك</div>` : ''}
            <p style="text-align: center; font-size: 14px; color: #cbd5e1; margin-bottom: 25px;">أضف مفاتيح Gemini API الخاصة بك هنا. النظام سيبدل بينها تلقائياً.</p>
            
            <div id="keys-container">
                ${keyRowsHtml}
            </div>

            <button type="button" class="btn btn-secondary" onclick="addKeyField()">+ إضافة مفتاح آخر</button>
            
            <div class="input-group" style="margin-top: 20px;">
                <label>مفتاح TMDB API (اختياري - لمعرفة أسماء وجنس الشخصيات)</label>
                <input type="text" id="tmdb-key" placeholder="المفتاح القصير v3 أو التوكن v4" value="${existingTmdbKey.replace(/"/g, '&quot;')}">
            </div>

            <div class="input-group" style="margin-top: 20px;">
                <label>نموذج الترجمة (Translation Model)</label>
                <select id="model-select" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff;">
                    <option value="gemini-3.1-flash-lite" ${existingModel === 'gemini-3.1-flash-lite' ? 'selected' : ''}>Gemini 3.1 Flash Lite</option>
                    <option value="gemini-3.5-flash-lite" ${existingModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>Gemini 3.5 Flash Lite</option>
                    <option value="gemini-3.7-flash" ${existingModel === 'gemini-3.7-flash' ? 'selected' : ''}>Gemini 3.7 Flash (beta)</option>
                    <option value="gemini-3.6-flash" ${existingModel === 'gemini-3.6-flash' ? 'selected' : ''}>Gemini 3.6 Flash (beta)</option>
                    <option value="gemini-3.5-flash" ${existingModel === 'gemini-3.5-flash' ? 'selected' : ''}>Gemini 3.5 Flash (beta)</option>
                    <option value="gemini-2.5-flash" ${existingModel === 'gemini-2.5-flash' ? 'selected' : ''}>Gemini 2.5 Flash</option>
                </select>
            </div>

            <button class="btn" onclick="generateInstallLink()">${existingKeys.length > 0 ? 'تحديث الإضافة في Nuvio 🔄' : 'تثبيت الإضافة في Nuvio 🚀'}</button>

            <div id="test-link-box" style="display:none; margin-top: 20px; padding: 12px; background: #0f172a; border-radius: 8px; border: 1px solid #334155;">
                <label style="margin-bottom: 8px;">رابط اختبار (JSON) - انسخه للفحص اليدوي بالمفاتيح:</label>
                <input type="text" id="test-link-input" readonly style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #38bdf8; font-size: 12px; box-sizing: border-box;" onclick="this.select()">
                <button type="button" class="btn btn-secondary" style="margin-top: 8px; margin-bottom: 0;" onclick="copyTestLink()">نسخ الرابط</button>
            </div>
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

            function buildConfigStr() {
                const inputs = document.querySelectorAll('.api-key');
                let keys = [];
                inputs.forEach(input => {
                    let val = input.value.trim();
                    if(val) keys.push(val);
                });

                if(keys.length === 0) {
                    alert('الرجاء إدخال مفتاح API واحد على الأقل!');
                    return null;
                }

                const tmdbKey = document.getElementById('tmdb-key').value.trim();
                const model = document.getElementById('model-select').value;
                
                const config = { keys: keys, model: model };
                if (tmdbKey) config.tmdbKey = tmdbKey; 
                
                return encodeURIComponent(JSON.stringify(config));
            }

            function generateInstallLink() {
                const configStr = buildConfigStr();
                if (!configStr) return;
                const host = window.location.host;

                const installUrl = 'stremio://' + host + '/' + configStr + '/manifest.json';
                const testUrl = window.location.origin + '/' + configStr + '/manifest.json';
                
                document.getElementById('test-link-input').value = testUrl;
                document.getElementById('test-link-box').style.display = 'block';

                window.location.href = installUrl;
            }

            function copyTestLink() {
                const input = document.getElementById('test-link-input');
                if (!input.value) return;
                input.select();
                input.setSelectionRange(0, 99999);
                try {
                    navigator.clipboard.writeText(input.value);
                } catch (e) {
                    document.execCommand('copy');
                }
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
// مسار جلب الترجمات
// ==========================================
app.get([
  '/subtitles/:type/:reqId(*)', 
  '/:config/subtitles/:type/:reqId(*)'
], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    const configParamRaw = req.params.config || '';
    const configParam = configParamRaw ? encodeURIComponent(configParamRaw) : '';
    
    let targetId = req.params.reqId.split('/')[0];
    if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);

    let type = req.params.type;
    const baseUrl = getBaseUrl(req);

    try {
        let subtitlesData = [];
        let finalTargetId = targetId;
        let finalType = type;
        
        let originalKitsuId = null;

        if (targetId.startsWith('kitsu')) {
            originalKitsuId = targetId.split(':')[1]; // نستخرج رقم الأنمي قبل التحويل
            
            const mapped = await mapKitsuToImdb(targetId);
            if (mapped) {
                finalTargetId = mapped;
                finalType = 'series';
                console.log(`[Anime Mapper] Successfully mapped! ${targetId} -> ${finalTargetId}`);
            } else {
                console.log(`[Anime Mapper] No mapping found for ${targetId}, using it as-is.`);
            }
        }

        // تحويل tt:S:E (ترقيم المواسم) إلى الترقيم المطلق إذا مواقع الترجمة ما تعرف الرقم الأصلي
        if (!originalKitsuId && /^tt\d+:\d+:\d+$/.test(finalTargetId)) {
            const alt = await resolveAbsoluteTtId(finalTargetId);
            if (alt) {
                console.log(`[TT Remap] Using absolute numbering: ${finalTargetId} -> ${alt}`);
                finalTargetId = alt;
                finalType = 'series';
            }
        }

        if (/^tt\d+/.test(finalTargetId) && finalType !== 'movie' && finalType !== 'series') {
            finalType = finalTargetId.includes(':') ? 'series' : 'movie';
        }

        let assImdbId = null, assSeason = null, assEpisode = null;
        const idParts = finalTargetId.split(':');
        if (idParts[0] && idParts[0].startsWith('tt')) {
            assImdbId = idParts[0];
            if (idParts.length >= 3) {
                assSeason = idParts[1];
                assEpisode = idParts[2];
            }
        }

        getSubDLEnglish({ imdbId: assImdbId, season: assSeason, episode: assEpisode })
            .then(list => console.log(`[SubDL Probe] ${finalTargetId} => ${list.length} ترجمة${list.length === 0 ? ' (السبب بالسطر اللي قبل هذا)' : ' ✅ SubDL شغال'}`))
            .catch(e => console.log(`[SubDL Probe] ${finalTargetId} => استثناء غير متوقع: ${e.message}`));

        const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${finalType}/${finalTargetId}.json`;
        console.log(`[Fetch] Requesting subtitles from: ${osUrl}`);

        const [r, assResults] = await Promise.all([
            axios.get(osUrl, { timeout: 10000 }).catch(e => {
                console.log(`[Fetch] OpenSubtitles فشل لـ ${finalTargetId}: ${e.message}`);
                return null;
            }),
            getOpenSubtitlesEnglish({ imdbId: assImdbId, season: assSeason, episode: assEpisode, type: finalType })
                .catch(() => [])
        ]);

        if (r && r.data && r.data.subtitles) subtitlesData = r.data.subtitles;
        console.log(`[Fetch] OpenSubtitles returned ${subtitlesData.length} subtitle(s) for ${finalTargetId}`);

        const assOnly = (assResults || []).filter(s => s.format === 'ass' || s.format === 'ssa');
        const assHiCount = assOnly.filter(s => isHearingImpairedSub(s)).length;
        console.log(`[Fetch] Legacy OpenSubtitles.org returned ${assOnly.length} ASS/SSA subtitle(s) for ${finalTargetId} (${assHiCount} SDH, pushed to the back)`);

        let srtSubs = [];

        if (subtitlesData.length > 0) {
            const targetLangs = ['en', 'eng', 'ja', 'jpn', 'jap', 'tr', 'tur', 'fa', 'per', 'fas', 'ru', 'rus', 'ko', 'kor', 'fr', 'fre', 'fra', 'es', 'spa', 'hi', 'hin', 'pt', 'por', 'pob', 'pb', 'pt-br', 'zh', 'zho', 'chi', 'cht', 'chs', 'de', 'ger', 'it', 'ita', 'id', 'ind'];

            const validSubs = subtitlesData.filter(s => {
                const lang = (s.lang || '').toLowerCase();
                return targetLangs.some(l => lang === l || lang.startsWith(l));
            });

            const sortedSubs = [...validSubs].sort((a, b) => {
                const aHi = isHearingImpairedSub(a) ? 1 : 0;
                const bHi = isHearingImpairedSub(b) ? 1 : 0;
                return aHi - bHi;
            });

            const cleanCount = sortedSubs.filter(s => !isHearingImpairedSub(s)).length;
            console.log(`[SDH Filter] ${cleanCount}/${sortedSubs.length} valid subtitle(s) are non-SDH for ${finalTargetId}`);

            srtSubs = sortedSubs.filter(s => {
                const fname = (s.subtitleFileName || '').toLowerCase();
                const url = (s.url || '').toLowerCase();
                return !fname.endsWith('.ass') && !fname.endsWith('.ssa') && !url.includes('.ass') && !url.includes('.ssa');
            });
        }

        if (srtSubs.length === 0 || FORCE_SUBDL) {
            console.log(FORCE_SUBDL
                ? `[SubDL] وضع الاختبار FORCE_SUBDL مفعل، أجرب SubDL لـ ${finalTargetId}...`
                : `[SubDL] OpenSubtitles ما رجّع ترجمة صالحة لـ ${finalTargetId}، أجرب SubDL...`);

            const subdlSubs = await getSubDLEnglish({
                imdbId: assImdbId,
                season: assSeason,
                episode: assEpisode
            });

            if (subdlSubs.length > 0) {
                srtSubs = subdlSubs;
                console.log(`[SubDL] راح أستخدم ${subdlSubs.length} ترجمة من SubDL لـ ${finalTargetId}.`);
            } else {
                console.log(`[SubDL] ما لقيت شي بـ SubDL لـ ${finalTargetId}.`);
            }
        }

        const transSubs = [];
        const streamPathSrt = configParam ? `/${configParam}/stream-ai.srt` : `/stream-ai.srt`;
        const streamPathAss = configParam ? `/${configParam}/stream-ai.ass` : `/stream-ai.ass`;

        let extraParams = `&id=${finalTargetId}`;
        if (originalKitsuId) extraParams += `&kitsu=${originalKitsuId}`;

        if (srtSubs.length > 0) {
            for (let i = 0; i < 6; i++) {
                const sub = srtSubs[i] || srtSubs[srtSubs.length - 1]; 
                transSubs.push({
                    id: `nuvio-ai-srt-${i+1}`,
                    url: `${baseUrl}${streamPathSrt}?url=${encodeURIComponent(sub.url)}&track=${i+1}${extraParams}`,
                    lang: 'ara',
                    title: `Nuvio AI SRT ${i+1} (Sync ${String.fromCharCode(65+i)})`
                });
            }
        }

        if (assOnly.length > 0) {
            const maxAss = Math.min(4, assOnly.length);
            for (let i = 0; i < maxAss; i++) {
                transSubs.push({
                    id: `nuvio-ai-ass-${i+1}`,
                    url: `${baseUrl}${streamPathAss}?url=${encodeURIComponent(assOnly[i].url)}&track=${i+7}${extraParams}`,
                    lang: 'ara',
                    title: `Nuvio AI ASS ${i+1} (Sync ${String.fromCharCode(65+i)})`
                });
            }
            console.log(`[Fetch] Added ${maxAss} ASS track(s) from ${assOnly.length} original ASS source(s) for ${finalTargetId}`);
        } else {
            console.log(`[Fetch] No original ASS/SSA found for ${finalTargetId} - skipping ASS tracks`);
        }

        return res.json({ subtitles: transSubs });
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
    const targetId = req.query.id || ''; 
    const kitsuId = req.query.kitsu || '';
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
    let userTmdbKey = '';

    if (req.params.config) {
        try {
            const decodedConfig = JSON.parse(decodeURIComponent(req.params.config));
            if (decodedConfig.keys && Array.isArray(decodedConfig.keys)) userKeys = decodedConfig.keys;
            if (decodedConfig.model) userModel = decodedConfig.model;
            if (decodedConfig.tmdbKey) userTmdbKey = decodedConfig.tmdbKey; 
        } catch (e) { }
    }

    if (!translationCache[cacheKey]) {
        startTranslationJob({
            cacheKey,
            handler: handleTranslationSrtDetailed,
            targetUrl, userKeys, userModel, userTmdbKey, trackNum, 
            label: 'SRT',
            targetId,
            kitsuId
        });
    }

    const fakeSub = `1\n00:00:01,000 --> 01:00:00,000\nالترجمة قيد التنفيذ ⏳\nانقر لإعادة التحميل بمجرد جاهزيتها.\n\n`;

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Trans-Wait-SRT.srt"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fakeSub);
});

app.all([
    '/stream-ai.ass', '/:config/stream-ai.ass'
], async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);

    const targetUrl = req.query.url;
    const targetId = req.query.id || ''; 
    const kitsuId = req.query.kitsu || '';
    const trackNum = req.query.track || '1';
    if (!targetUrl) return res.status(400).send('Missing URL');

    const cacheKey = `ASS_${targetUrl}`;

    if (translationCache[cacheKey] && translationCache[cacheKey].status === 'done') {
        res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="Trans-Track${trackNum}-ASS.ass"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(translationCache[cacheKey].content);
    }

    let userKeys = [];
    let userModel = 'gemini-3.1-flash-lite';
    let userTmdbKey = '';

    if (req.params.config) {
        try {
            const decodedConfig = JSON.parse(decodeURIComponent(req.params.config));
            if (decodedConfig.keys && Array.isArray(decodedConfig.keys)) userKeys = decodedConfig.keys;
            if (decodedConfig.model) userModel = decodedConfig.model;
            if (decodedConfig.tmdbKey) userTmdbKey = decodedConfig.tmdbKey; 
        } catch (e) { }
    }

    if (!translationCache[cacheKey]) {
        startTranslationJob({
            cacheKey,
            handler: handleTranslationAssDetailed,
            targetUrl, userKeys, userModel, userTmdbKey, trackNum, 
            label: 'ASS',
            targetId,
            kitsuId
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
