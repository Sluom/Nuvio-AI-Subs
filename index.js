const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { handleTranslationSrtDetailed, handleTranslationAssDetailed } = require('./ai/ai');
const { getSubDL } = require('./sources/subdl');
const { getSubSource } = require('./sources/subsource');
const { getArabicSubsForCorrection, getRawArabicSubContent } = require('./sources/araFetch');
const { handleCorrectionSrt, handleCorrectionAss } = require('./Corrector/corrector');
const db = require('./db');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 7000;
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DAY_MS = 24 * 60 * 60 * 1000;
const translationCache = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class RequestQueue {
    constructor(concurrency = 2) {
        this.queue = [];
        this.activeCount = 0;
        this.concurrency = concurrency;
    }
    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try { resolve(await task()); } catch (e) { reject(e); }
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
                .catch(e => console.error('[Queue Error]', e.message))
                .finally(() => {
                    this.activeCount--;
                    this.processNext();
                });
        }
    }
}
const globalTranslationQueue = new RequestQueue(1);
const MAX_BACKGROUND_ROUNDS = 3;
const ROUND_PAUSE_MS = 30000;
function startTranslationJob({ cacheKey, handler, targetUrl, userKeys, userModel, userTmdbKey, extraKeys, trackNum, label, targetId, kitsuId }) {
    translationCache[cacheKey] = { status: 'pending' };
    const dropIfNotDone = () => {
        const cur = translationCache[cacheKey];
        if (!cur || cur.status !== 'done') delete translationCache[cacheKey];
    };
    globalTranslationQueue.add(async () => {
        try {
            for (let round = 1; round <= MAX_BACKGROUND_ROUNDS; round++) {
                const r = await handler(targetUrl, userKeys, userModel, userTmdbKey, targetId, kitsuId, extraKeys);
                if (r.failed) {
                    console.error('[' + label + '] Track ' + trackNum + ': فشل تحميل/استخراج الملف الأصلي. ستُعاد المحاولة عند الضغطة القادمة.');
                    dropIfNotDone();
                    return;
                }
                translationCache[cacheKey] = { status: 'done', content: r.content, complete: r.missing === 0 };
                if (r.missing === 0) {
                    const saved = await db.saveDoc('job', cacheKey, { content: r.content });
                    if (saved) console.log('[MongoDB] ' + label + ' Track ' + trackNum + ': حُفظت النتيجة الكاملة في التخزين الدائم.');
                    if (round > 1) console.log('[' + label + '] Track ' + trackNum + ': اكتملت الترجمة/التصحيح بعد ' + round + ' جولات ✅');
                    return;
                }
                console.log('[' + label + '] Track ' + trackNum + ': ناقص ' + r.missing + ' من ' + r.total + ' سطر (جولة ' + round + '/' + MAX_BACKGROUND_ROUNDS + '). النتيجة الحالية جاهزة للمستخدم.');
                if (round < MAX_BACKGROUND_ROUNDS) await sleep(ROUND_PAUSE_MS);
            }
        } catch (e) {
            console.error('[Background Error - ' + label + '] Track ' + trackNum + ':', e.message);
            dropIfNotDone();
        }
    });
}
const armCache = new Map();
async function mapKitsuViaArm(kitsuId, kitsuEp) {
    const cached = armCache.get(kitsuId);
    let data;
    if (cached && (Date.now() - cached.time) < DAY_MS) {
        data = cached.data;
    } else {
        const r = await axios.get('https://arm.haglund.dev/api/v2/ids?source=kitsu&id=' + encodeURIComponent(kitsuId), {
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
        });
        data = r.data;
        if (data && data.imdb) armCache.set(kitsuId, { time: Date.now(), data });
    }
    if (!data || !data.imdb) return null;
    const imdbId = Array.isArray(data.imdb) ? data.imdb[0] : data.imdb;
    if (!imdbId) return null;
    const season = data['thetvdb-season'] ?? data['themoviedb-season'] ?? 1;
    return [imdbId, season, kitsuEp].join(':');
}
async function mapKitsuViaKitsuAddon(targetId, kitsuId, kitsuEp) {
    const metaRes = await axios.get('https://anime-kitsu.strem.fun/meta/anime/kitsu:' + kitsuId + '.json', {
        timeout: 6000,
        headers: { 'User-Agent': 'Stremio/4.4.16 (Windows)' }
    });
    const videos = metaRes.data && metaRes.data.meta && metaRes.data.meta.videos;
    if (!videos) return null;
    const epData = videos.find(v => v.id === targetId) || videos.find(v => v.episode === kitsuEp);
    if (epData && epData.imdb_id) {
        const s = epData.imdbSeason || epData.season || 1;
        const e = epData.imdbEpisode || epData.episode || kitsuEp;
        return [epData.imdb_id, s, e].join(':');
    }
    return null;
}
async function mapKitsuToImdb(targetId) {
    const parts = targetId.split(':');
    if (parts.length !== 3) return null;
    const kitsuId = parts[1];
    const kitsuEp = parseInt(parts[2], 10);
    if (!kitsuId || isNaN(kitsuEp)) return null;
    console.log('[Anime Mapper] Searching mapping for Kitsu ID: ' + kitsuId + ', Ep: ' + kitsuEp);
    const mappers = [
        ['ARM', () => mapKitsuViaArm(kitsuId, kitsuEp)],
        ['Kitsu addon', () => mapKitsuViaKitsuAddon(targetId, kitsuId, kitsuEp)]
    ];
    for (const [name, fn] of mappers) {
        try {
            const mapped = await fn();
            if (mapped) {
                console.log('[Anime Mapper] ' + name + ' mapped ' + targetId + ' -> ' + mapped);
                return mapped;
            }
            console.log('[Anime Mapper] ' + name + ' returned no IMDb match for ' + targetId);
        } catch (err) {
            console.error('[Anime Mapper] ' + name + ' failed for ' + targetId + ' - ' + err.message);
        }
    }
    return null;
}
const absCache = new Map();
async function osCount(id) {
    try {
        const r = await axios.get('https://opensubtitles-v3.strem.io/subtitles/series/' + id + '.json', { timeout: 5000 });
        return (r.data && Array.isArray(r.data.subtitles)) ? r.data.subtitles.length : 0;
    } catch {
        return 0;
    }
}
async function resolveAbsoluteTtId(ttId) {
    const cached = absCache.get(ttId);
    if (cached && (Date.now() - cached.time) < DAY_MS) return cached.value;
    const [imdbId, s, e] = ttId.split(':');
    const season = parseInt(s, 10);
    const episode = parseInt(e, 10);
    if (!imdbId || isNaN(season) || isNaN(episode) || season <= 1) return null;
    let result = null;
    try {
        if ((await osCount(ttId)) > 0) {
            absCache.set(ttId, { time: Date.now(), value: null });
            return null;
        }
        const meta = await axios.get('https://v3-cinemeta.strem.io/meta/series/' + imdbId + '.json', {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const videos = (meta.data && meta.data.meta && meta.data.meta.videos) || [];
        const before = videos.filter(v => v.season > 0 && v.season < season).length;
        if (before > 0) {
            const candidate = [imdbId, 1, before + episode].join(':');
            const n = await osCount(candidate);
            console.log('[TT Remap] ' + ttId + ': حلقات قبل الموسم=' + before + ' -> ' + candidate + ' (OpenSubtitles: ' + n + ' ترجمة)');
            if (n > 0) result = candidate;
        } else {
            console.log('[TT Remap] ' + ttId + ': Cinemeta ما رجّع مواسم سابقة، ما أقدر أحسب الرقم المطلق');
        }
    } catch (err) {
        console.error('[TT Remap] فشل لـ ' + ttId + ': ' + err.message);
        return null;
    }
    absCache.set(ttId, { time: Date.now(), value: result });
    return result;
}
const HI_REGEX = /\b(sdh|hi|cc|deaf)\b|hearing[\s_-]*impaired|closed[\s_-]*caption/;
function isHearingImpairedSub(sub) {
    if (!sub) return false;
    if (sub.hearingImpaired === true) return true;
    return [sub.title, sub.id, sub.url, sub.subtitleFileName, sub.fileName]
        .filter(Boolean)
        .some(f => HI_REGEX.test(String(f).toLowerCase()));
}
const isEng = s => /^en/i.test((s && s.lang) || '');
const byEng = (a, b) => isEng(b) - isEng(a);
const isHiFlag = v => ['1', 1, true].includes(v);
function matchEpisode(fileName, targetEpisode) {
    if (!targetEpisode) return true;
    const name = (fileName || '').toLowerCase();
    if (name.includes('.zip') || name.includes('.rar')) return true;
    const ep = parseInt(targetEpisode, 10).toString();
    return [
        new RegExp('(?:s0*\\d+[._ -]*)?(?:e|ep|episode)[._ -]*0*' + ep + '(?:[^0-9]|$)', 'i'),
        new RegExp('[._ -]0*' + ep + '[._ -]', 'i'),
        new RegExp('\\[0*' + ep + '\\]', 'i'),
        new RegExp('\\(0*' + ep + '\\)', 'i'),
        new RegExp('\\b0*' + ep + '\\b', 'i')
    ].some(p => p.test(name));
}
function mkOsSub(url, name, isAss, isHi, site = 'opensubtitles') {
    const f = isAss ? 'ass' : 'srt';
    return {
        url,
        lang: 'eng',
        format: f,
        ext: f,
        subFormat: isAss ? 'ssa' : 'srt',
        fileName: name,
        origName: name,
        hearingImpaired: isHi,
        _source: site,
        _priority: isAss ? 0 : 2
    };
}
const LEGACY_AGENTS = ['TemporaryUserAgent', 'VLSub 0.10.3'];
const LEGACY_AGENT_GAP_MS = 1000;
const assLegacyFormatRe = /^(ass|ssa)$/i;
const assLegacyFileRe = /\.(ass|ssa)/i;
async function fetchLegacyData(url) {
    const combinedData = [];
    for (let i = 0; i < LEGACY_AGENTS.length; i++) {
        if (i > 0) await sleep(LEGACY_AGENT_GAP_MS);
        const ua = LEGACY_AGENTS[i];
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' }
            });
            if (response && response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) combinedData.push(...data);
            }
        } catch (e) {
            console.log('[Legacy] خطأ (' + ua + '):', e.message);
        }
    }
    if (combinedData.length === 0) return [];
    const results = [];
    const seenLinks = new Set();
    combinedData.forEach(entry => {
        if (!entry || !entry.SubDownloadLink) return;
        const format = (entry.SubFormat || '').toLowerCase();
        const rawName = entry.SubFileName || entry.MovieReleaseName || 'OpenSubtitles Legacy';
        const lower = rawName.toLowerCase();
        const isAss = assLegacyFormatRe.test(format) || assLegacyFileRe.test(lower);
        if (!isAss) return;
        const linkKey = String(entry.IDSubtitleFile || entry.SubDownloadLink);
        if (seenLinks.has(linkKey)) return;
        seenLinks.add(linkKey);
        results.push(mkOsSub(entry.SubDownloadLink, rawName, true, isHiFlag(entry.SubHearingImpaired), 'os_legacy'));
    });
    return results;
}
async function fetchLegacyApiEnglish(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
    const hasSE = season != null && episode != null;
    const primaryUrl = hasSE
        ? 'https://rest.opensubtitles.org/search/episode-' + episode + '/imdbid-' + numericId + '/season-' + season + '/sublanguageid-eng'
        : 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-eng';
    let results = await fetchLegacyData(primaryUrl);
    if (hasSE && results.length === 0) {
        const fallbackResults = await fetchLegacyData('https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-eng');
        const filteredFallback = fallbackResults.filter(r => matchEpisode(r.fileName, episode));
        results = [...results, ...filteredFallback];
    }
    return results;
}
async function fetchMirrorEnglish(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    try {
        const isSeries = type === 'series' || type === 'anime' || !!season;
        const mediaType = isSeries ? 'series' : 'movie';
        const mTargetId = isSeries && season ? [imdbId, season, episode || 1].join(':') : imdbId;
        const response = await fetch('https://opensubtitles-v3.strem.io/subtitles/' + mediaType + '/' + mTargetId + '.json', {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return (data.subtitles || [])
            .filter(s => (s.lang || '').toLowerCase().startsWith('en') && s.url)
            .map(s => {
                const rawUrl = (s.url || '').toLowerCase();
                const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
                const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();
                const isAss = subFormat === 'ssa' || subFormat === 'ass' || /\.(ass|ssa)/.test(rawUrl) || /\.(ass|ssa)/.test(rawName);
                const isHi = isHiFlag(s.SubHearingImpaired)
                    || /\b(sdh|hi)\b|hearing[\s_-]*impaired/.test(rawName)
                    || /\b(sdh|hi)\b/.test(rawUrl);
                return mkOsSub(s.url, s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror', isAss, isHi);
            });
    } catch {
        return [];
    }
}
async function getOpenSubtitlesEnglish({ imdbId, season, episode, type }) {
    const settled = await Promise.allSettled([
        fetchLegacyApiEnglish(imdbId, season, episode),
        fetchMirrorEnglish(imdbId, season, episode, type)
    ]);
    return settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .filter(s => s && s.url);
}
const MANIFEST = {
    id: 'org.nuvio.ai.subtitles',
    version: '1.9.5',
    name: 'Nuvio AI Subs (Pro Max)',
    description: 'Ready Arabic subtitles, Arabic Corrector, and Auto-translate to Arabic using Gemini.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime', 'other'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true }
};
function getBaseUrl(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return proto + '://' + host;
}
function parseConfig(raw, onError) {
    const cfg = { keys: [], model: DEFAULT_MODEL, tmdbKey: '', subdlKey: '', subsourceKey: '' };
    if (!raw) return cfg;
    try {
        const d = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(d.keys)) cfg.keys = d.keys;
        if (d.model) cfg.model = d.model;
        if (d.tmdbKey) cfg.tmdbKey = d.tmdbKey;
        if (d.subdlKey) cfg.subdlKey = String(d.subdlKey).trim();
        if (d.subsourceKey) cfg.subsourceKey = String(d.subsourceKey).trim();
    } catch (e) {
        if (onError) onError(e);
    }
    return cfg;
}
const MODELS = [
    ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash (beta)'],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash (beta)'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash (beta)'],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash']
];
const attr = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const {
        keys: existingKeys, model: existingModel, tmdbKey: existingTmdbKey,
        subdlKey: existingSubdlKey, subsourceKey: existingSubsourceKey
    } = parseConfig(req.params.config, e => console.error('[Configure] Failed to parse existing config:', e.message));
    const keyRowsHtml = existingKeys.length > 0
        ? existingKeys.map((key, i) => {
            const k = attr(key);
            return i === 0
                ? '<div class="key-row"><input type="text" class="api-key" placeholder="المفتاح الأساسي (AIzaSy...)" value="' + k + '"></div>'
                : '<div class="key-row"><input type="text" class="api-key" placeholder="مفتاح إضافي (AIzaSy...)" value="' + k + '"><button class="remove-btn" onclick="this.parentElement.remove()">X</button></div>';
        }).join('\n')
        : '<div class="key-row"><input type="text" class="api-key" placeholder="المفتاح الأساسي (AIzaSy...)"></div>';
    const modelOptions = MODELS.map(([v, n]) => '<option value="' + v + '"' + (existingModel === v ? ' selected' : '') + '>' + n + '</option>').join('');
    const bannerHtml = existingKeys.length > 0
        ? '<div class="status-banner">✅ تم تحميل ' + existingKeys.length + ' مفتاح موجود مسبقًا — عدّل حسب حاجتك</div>'
        : '';
    const btnText = existingKeys.length > 0 ? 'تحديث الإضافة في Nuvio 🔄' : 'تثبيت الإضافة في Nuvio 🚀';
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>إعدادات Nuvio AI Subs</title>
<style>
body{background:#0b1120;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;padding:20px}
h1{color:#38bdf8;text-align:center}
.container{background:#1e293b;padding:30px;border-radius:12px;width:100%;max-width:500px;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.input-group{margin-bottom:15px}
label{display:block;margin-bottom:5px;color:#94a3b8;font-size:14px}
input[type="text"]{width:100%;padding:10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#fff;box-sizing:border-box}
.btn{background:#0284c7;color:#fff;padding:12px;border:none;border-radius:8px;font-weight:bold;width:100%;cursor:pointer;margin-top:10px;transition:.3s}
.btn:hover{background:#0369a1}
.btn-secondary{background:#475569;margin-bottom:20px}
.btn-secondary:hover{background:#334155}
.key-row{display:flex;gap:10px;margin-bottom:10px}
.key-row input{flex:1}
.remove-btn{background:#ef4444;color:#fff;border:none;border-radius:6px;padding:0 15px;cursor:pointer;font-weight:bold}
.status-banner{background:#14532d;color:#86efac;padding:10px;border-radius:8px;text-align:center;margin-bottom:20px;font-size:14px}
</style>
</head>
<body>
<h1>إعدادات المترجم الذكي</h1>
<div class="container">
` + bannerHtml + `
<p style="text-align:center;font-size:14px;color:#cbd5e1;margin-bottom:25px">أضف مفاتيح Gemini API الخاصة بك هنا. النظام سيبدل بينها تلقائياً.</p>
<div id="keys-container">` + keyRowsHtml + `</div>
<button type="button" class="btn btn-secondary" onclick="addKeyField()">+ إضافة مفتاح آخر</button>
<div class="input-group" style="margin-top:20px">
<label>مفتاح TMDB API (اختياري - لمعرفة أسماء وجنس الشخصيات)</label>
<input type="text" id="tmdb-key" placeholder="المفتاح القصير v3 أو التوكن v4" value="` + attr(existingTmdbKey) + `">
</div>
<div class="input-group" style="margin-top:20px">
<label>مفتاح SubDL API (اختياري - مصدر ترجمات إضافي)</label>
<input type="text" id="subdl-key" placeholder="مفتاح SubDL" value="` + attr(existingSubdlKey) + `">
</div>
<div class="input-group">
<label>مفتاح Subsource API (اختياري - مصدر ترجمات عربية إضافي)</label>
<input type="text" id="subsource-key" placeholder="مفتاح Subsource" value="` + attr(existingSubsourceKey) + `">
</div>
<div class="input-group" style="margin-top:20px">
<label>نموذج الترجمة (Translation Model)</label>
<select id="model-select" style="width:100%;padding:10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#fff">` + modelOptions + `</select>
</div>
<button class="btn" onclick="generateInstallLink()">` + btnText + `</button>
<div id="test-link-box" style="display:none;margin-top:20px;padding:12px;background:#0f172a;border-radius:8px;border:1px solid #334155">
<label style="margin-bottom:8px">رابط اختبار (JSON) - انسخه للفحص اليدوي بالمفاتيح:</label>
<input type="text" id="test-link-input" readonly style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#38bdf8;font-size:12px;box-sizing:border-box" onclick="this.select()">
<button type="button" class="btn btn-secondary" style="margin-top:8px;margin-bottom:0" onclick="copyTestLink()">نسخ الرابط</button>
</div>
</div>
<script>
function addKeyField(){
const row=document.createElement('div');
row.className='key-row';
row.innerHTML='<input type="text" class="api-key" placeholder="مفتاح إضافي (AIzaSy...)"><button class="remove-btn" onclick="this.parentElement.remove()">X</button>';
document.getElementById('keys-container').appendChild(row);
}
function buildConfigStr(){
const keys=[];
document.querySelectorAll('.api-key').forEach(i=>{const v=i.value.trim();if(v)keys.push(v);});
if(keys.length===0){alert('الرجاء إدخال مفتاح API واحد على الأقل!');return null;}
const tmdbKey=document.getElementById('tmdb-key').value.trim();
const subdlKey=document.getElementById('subdl-key').value.trim();
const subsourceKey=document.getElementById('subsource-key').value.trim();
const config={keys:keys,model:document.getElementById('model-select').value};
if(tmdbKey)config.tmdbKey=tmdbKey;
if(subdlKey)config.subdlKey=subdlKey;
if(subsourceKey)config.subsourceKey=subsourceKey;
return encodeURIComponent(JSON.stringify(config));
}
function generateInstallLink(){
const c=buildConfigStr();
if(!c)return;
document.getElementById('test-link-input').value=window.location.origin+'/'+c+'/manifest.json';
document.getElementById('test-link-box').style.display='block';
window.location.href='stremio://'+window.location.host+'/'+c+'/manifest.json';
}
function copyTestLink(){
const i=document.getElementById('test-link-input');
if(!i.value)return;
i.select();
i.setSelectionRange(0,99999);
try{navigator.clipboard.writeText(i.value);}catch(e){document.execCommand('copy');}
}
</script>
</body>
</html>`);
});
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    const m = { ...MANIFEST };
    if (req.params.config) {
        m.description = '✅ مفعل! ترجمات عربية جاهزة + مصحح عربي + ترجمة تلقائية بالذكاء الاصطناعي.';
        m.name = 'Nuvio AI Subs (Active)';
    }
    res.json(m);
});
const WANTED_TRACKS = 4;
const TARGET_LANGS = ['en', 'eng', 'ja', 'jpn', 'jap', 'tr', 'tur', 'fa', 'per', 'fas', 'ru', 'rus', 'ko', 'kor', 'fr', 'fre', 'fra', 'es', 'spa', 'hi', 'hin', 'pt', 'por', 'pob', 'pb', 'pt-br', 'zh', 'zho', 'chi', 'cht', 'chs', 'de', 'ger', 'it', 'ita', 'id', 'ind'];
const SOURCE_LABELS = {
    subdl: 'subdl',
    subsource: 'subsource',
    os_legacy: 'opensubtitles.org',
    os_mirror: 'opensubtitles',
    opensubtitles: 'opensubtitles'
};
const getSourceLabel = src => SOURCE_LABELS[src] || src || 'source';
const assExtRe = /\.(ass|ssa)$/i;
const SITE_ORDER = ['subdl', 'subsource', 'opensubtitles', 'opensubtitles.org'];
const isAssSub = s => !!s && (s.format === 'ass' || assLegacyFormatRe.test(s.subFormat || '') || assExtRe.test(String(s.fileName || s.title || s.url || '').split('?')[0]));
function logSiteSummary({ arabicSubs, corrSrtList, osClean, osHi, assOnly, subdlSubs, subsourceSubs, extFetched }) {
    const ready = {}, corr = {}, foreign = {};
    const add = (stats, site, isAss, n = 1) => {
        const k = getSourceLabel(site);
        const o = stats[k] || (stats[k] = { srt: 0, ass: 0 });
        o[isAss ? 'ass' : 'srt'] += n;
    };
    const siteOf = s => s._site || s._source;
    (arabicSubs.srt || []).forEach(s => add(ready, siteOf(s), false));
    (arabicSubs.ass || []).forEach(s => add(ready, siteOf(s), true));
    corrSrtList.slice(0, 4).forEach(s => add(corr, siteOf(s), false));
    (arabicSubs.ass || []).slice(0, 4).forEach(s => add(corr, siteOf(s), true));
    add(foreign, 'opensubtitles', false, osClean.length + osHi.length);
    assOnly.forEach(s => add(foreign, s._source === 'os_legacy' ? 'os_legacy' : 'opensubtitles', true));
    subdlSubs.forEach(s => add(foreign, 'subdl', isAssSub(s)));
    subsourceSubs.forEach(s => add(foreign, 'subsource', isAssSub(s)));
    const fmt = (st, k) => 'SRT=' + (st[k] ? st[k].srt : 0) + ' ASS=' + (st[k] ? st[k].ass : 0);
    SITE_ORDER.forEach(k => {
        const foreignTxt = (!extFetched && (k === 'subdl' || k === 'subsource')) ? '-' : fmt(foreign, k);
        console.log('[جلب] ' + k + ' | جاهز ' + fmt(ready, k) + ' | مصحح ' + fmt(corr, k) + ' | أجنبي ' + foreignTxt);
    });
}
app.get(['/subtitles/:type/:reqId(*)', '/:config/subtitles/:type/:reqId(*)'], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    const configParam = req.params.config ? encodeURIComponent(req.params.config) : '';
    const addonCfg = parseConfig(req.params.config);
    let targetId = req.params.reqId.split('/')[0];
    if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);
    targetId = targetId.replace(/[.\s]+$/, '');
    const baseUrl = getBaseUrl(req);
    try {
        let subtitlesData = [];
        let finalTargetId = targetId;
        let finalType = req.params.type;
        let originalKitsuId = null;
        if (targetId.startsWith('kitsu')) {
            originalKitsuId = targetId.split(':')[1];
            const mapped = await mapKitsuToImdb(targetId);
            if (mapped) {
                finalTargetId = mapped;
                finalType = 'series';
                console.log('[Anime Mapper] Successfully mapped! ' + targetId + ' -> ' + finalTargetId);
            } else {
                console.log('[Anime Mapper] No mapping found for ' + targetId + ', using it as-is.');
            }
        }
        if (!originalKitsuId && /^tt\d+:\d+:\d+$/.test(finalTargetId)) {
            const alt = await resolveAbsoluteTtId(finalTargetId);
            if (alt) {
                console.log('[TT Remap] Using absolute numbering: ' + finalTargetId + ' -> ' + alt);
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
        const osUrl = 'https://opensubtitles-v3.strem.io/subtitles/' + finalType + '/' + finalTargetId + '.json';
        console.log('[Fetch] بدء الجلب المتوازي الشامل (الجاهز + المصحح + AI) للعمل: ' + finalTargetId);
        const [arabicSubs, r, assResults] = await Promise.all([
            getArabicSubsForCorrection({
                imdbId: assImdbId,
                season: assSeason,
                episode: assEpisode,
                type: finalType,
                subdlKey: addonCfg.subdlKey,
                subsourceKey: addonCfg.subsourceKey
            }).catch(err => {
                console.error('[لوغ الفحص] خطأ أثناء جلب الترجمات العربية:', err.message);
                return { srt: [], ass: [], correctorSrt: [] };
            }),
            axios.get(osUrl, { timeout: 5000 }).catch(e => {
                console.log('[Fetch] OpenSubtitles فشل لـ ' + finalTargetId + ': ' + e.message);
                return null;
            }),
            getOpenSubtitlesEnglish({ imdbId: assImdbId, season: assSeason, episode: assEpisode, type: finalType }).catch(() => [])
        ]);
        if (r && r.data && r.data.subtitles) subtitlesData = r.data.subtitles;
        const extraAssFromOs = subtitlesData.filter(s => {
            if (!s || !s.url) return false;
            const lang = (s.lang || '').toLowerCase();
            if (!TARGET_LANGS.some(l => lang.startsWith(l))) return false;
            const fname = s.subtitleFileName || '';
            const url = s.url || '';
            return assExtRe.test(fname) || assExtRe.test(url);
        });
        const assOnly = [
            ...(assResults || []).filter(s => s && (s.format === 'ass' || s.format === 'ssa')),
            ...extraAssFromOs
        ];
        let osClean = [], osHi = [];
        if (subtitlesData.length > 0) {
            const validSubs = subtitlesData.filter(s => {
                const lang = (s.lang || '').toLowerCase();
                return TARGET_LANGS.some(l => lang.startsWith(l));
            });
            const srtOnly = validSubs.filter(s => {
                const fname = s.subtitleFileName || '';
                const url = s.url || '';
                return !assExtRe.test(fname) && !assExtRe.test(url);
            });
            osClean = srtOnly.filter(s => !isHearingImpairedSub(s)).sort(byEng);
            osHi = srtOnly.filter(s => isHearingImpairedSub(s)).sort(byEng);
        }
        let extClean = [], extHi = [], subdlSubs = [], subsourceSubs = [], extFetched = false;
        if (osClean.length < WANTED_TRACKS) {
            extFetched = true;
            [subdlSubs, subsourceSubs] = await Promise.all([
                getSubDL({ imdbId: assImdbId, season: assSeason, episode: assEpisode, apiKey: addonCfg.subdlKey }).catch(() => []),
                getSubSource({ imdbId: assImdbId, season: assSeason, episode: assEpisode, apiKey: addonCfg.subsourceKey, language: 'english' }).catch(() => [])
            ]);
            const extSubs = [];
            for (let i = 0; i < Math.max(subdlSubs.length, subsourceSubs.length); i++) {
                if (subdlSubs[i]) extSubs.push(subdlSubs[i]);
                if (subsourceSubs[i]) extSubs.push(subsourceSubs[i]);
            }
            extClean = extSubs.filter(s => !s.hearingImpaired).sort(byEng);
            extHi = extSubs.filter(s => s.hearingImpaired).sort(byEng);
        }
        const srtSubs = [...osClean, ...extClean, ...osHi, ...extHi];
        const transSubs = [];
        const streamRawSrt = configParam ? '/' + configParam + '/stream-raw.srt' : '/stream-raw.srt';
        const streamRawAss = configParam ? '/' + configParam + '/stream-raw.ass' : '/stream-raw.ass';
        const streamAraSrt = configParam ? '/' + configParam + '/stream-ara.srt' : '/stream-ara.srt';
        const streamAraAss = configParam ? '/' + configParam + '/stream-ara.ass' : '/stream-ara.ass';
        const streamPathSrt = configParam ? '/' + configParam + '/stream-ai.srt' : '/stream-ai.srt';
        const streamPathAss = configParam ? '/' + configParam + '/stream-ai.ass' : '/stream-ai.ass';
        let extraParams = '&id=' + finalTargetId;
        if (originalKitsuId) extraParams += '&kitsu=' + originalKitsuId;
        if (arabicSubs.ass && arabicSubs.ass.length > 0) {
            const assSiteCounters = {};
            for (let i = 0; i < arabicSubs.ass.length; i++) {
                const sub = arabicSubs.ass[i];
                const srcLabel = getSourceLabel(sub._source);
                assSiteCounters[srcLabel] = (assSiteCounters[srcLabel] || 0) + 1;
                const siteIdx = assSiteCounters[srcLabel];
                transSubs.push({
                    id: 'nuvio-ass-' + srcLabel + '-ara-' + siteIdx,
                    url: baseUrl + streamRawAss + '?url=' + encodeURIComponent(sub.url) + '&track=' + (i + 1) + extraParams,
                    lang: 'ara',
                    title: 'nuvio-ass-' + srcLabel + '-ara-' + siteIdx
                });
            }
        }
        if (arabicSubs.srt && arabicSubs.srt.length > 0) {
            const srtSiteCounters = {};
            for (let i = 0; i < arabicSubs.srt.length; i++) {
                const sub = arabicSubs.srt[i];
                const srcLabel = getSourceLabel(sub._source);
                srtSiteCounters[srcLabel] = (srtSiteCounters[srcLabel] || 0) + 1;
                const siteIdx = srtSiteCounters[srcLabel];
                transSubs.push({
                    id: 'nuvio-srt-' + srcLabel + '-ara-' + siteIdx,
                    url: baseUrl + streamRawSrt + '?url=' + encodeURIComponent(sub.url) + '&track=' + (i + 1) + extraParams,
                    lang: 'ara',
                    title: 'nuvio-srt-' + srcLabel + '-ara-' + siteIdx
                });
            }
        }
        const corrSrtList = (arabicSubs.correctorSrt && arabicSubs.correctorSrt.length > 0)
            ? arabicSubs.correctorSrt
            : (arabicSubs.srt || []);
        if (corrSrtList.length > 0) {
            const maxAraSrt = Math.min(4, corrSrtList.length);
            for (let i = 0; i < maxAraSrt; i++) {
                transSubs.push({
                    id: 'nuvio-ara-srt-' + (i + 1),
                    url: baseUrl + streamAraSrt + '?url=' + encodeURIComponent(corrSrtList[i].url) + '&track=' + (i + 1) + extraParams,
                    lang: 'ara',
                    title: 'Nuvio AI Arabic SRT ' + (i + 1)
                });
            }
        }
        if (arabicSubs.ass && arabicSubs.ass.length > 0) {
            const maxAraAss = Math.min(4, arabicSubs.ass.length);
            for (let i = 0; i < maxAraAss; i++) {
                transSubs.push({
                    id: 'nuvio-ara-ass-' + (i + 1),
                    url: baseUrl + streamAraAss + '?url=' + encodeURIComponent(arabicSubs.ass[i].url) + '&track=' + (i + 1) + extraParams,
                    lang: 'ara',
                    title: 'Nuvio AI Arabic ASS ' + (i + 1)
                });
            }
        }
        if (srtSubs.length > 0) {
            for (let i = 0; i < WANTED_TRACKS; i++) {
                const sub = srtSubs[i] || srtSubs[srtSubs.length - 1];
                transSubs.push({
                    id: 'nuvio-ai-srt-' + (i + 1),
                    url: baseUrl + streamPathSrt + '?url=' + encodeURIComponent(sub.url) + '&track=' + (i + 1) + extraParams,
                    lang: 'ara',
                    title: 'Nuvio AI SRT ' + (i + 1) + ' (Sync ' + String.fromCharCode(65 + i) + ')'
                });
            }
        }
        if (assOnly.length > 0) {
            const maxAss = Math.min(4, assOnly.length);
            for (let i = 0; i < maxAss; i++) {
                transSubs.push({
                    id: 'nuvio-ai-ass-' + (i + 1),
                    url: baseUrl + streamPathAss + '?url=' + encodeURIComponent(assOnly[i].url) + '&track=' + (i + 7) + extraParams,
                    lang: 'ara',
                    title: 'Nuvio AI ASS ' + (i + 1) + ' (Sync ' + String.fromCharCode(65 + i) + ')'
                });
            }
        }
        logSiteSummary({ arabicSubs, corrSrtList, osClean, osHi, assOnly, subdlSubs, subsourceSubs, extFetched });
        return res.json({ subtitles: transSubs });
    } catch (err) {
        console.error('[Subtitles Error] ' + targetId + ' - ' + err.message);
        return res.json({ subtitles: [] });
    }
});
const sendSub = (res, mime, name, body) => {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline; filename="' + name + '"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(body);
};
function parseEpInfoFromTargetId(targetId) {
    if (!targetId) return null;
    const parts = String(targetId).split(':');
    if (parts.length >= 3 && parts[0].startsWith('tt')) {
        return { season: parts[1], episode: parts[2] };
    }
    return null;
}
const rawStreamRoute = (ext, mime) => async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    const targetUrl = req.query.url;
    const targetId = req.query.id || '';
    const trackNum = String(req.query.track || '1').replace(/[^0-9a-zA-Z_-]/g, '');
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return res.status(400).send('Invalid or Missing URL');
    }
    try {
        const cfg = parseConfig(req.params.config);
        const epInfo = parseEpInfoFromTargetId(targetId);
        const content = await getRawArabicSubContent(targetUrl, cfg.subsourceKey, epInfo);
        return sendSub(res, mime, 'Ready-Track' + trackNum + '.' + ext, content);
    } catch (e) {
        console.error('[Raw Sub Error] Track ' + trackNum + ':', e.message);
        if (!/\.zip(\?|$)/i.test(targetUrl)) {
            return res.redirect(302, targetUrl);
        }
        return res.status(502).send('Failed to load ready subtitle');
    }
};
const streamRoute = (ext, label, mime, handler, waitBody) => async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    const targetUrl = req.query.url;
    const targetId = req.query.id || '';
    const kitsuId = req.query.kitsu || '';
    const trackNum = String(req.query.track || '1').replace(/[^0-9a-zA-Z_-]/g, '');
    if (!targetUrl) return res.status(400).send('Missing URL');
    const cacheKey = [label, targetId, targetUrl].join('_');
    let cached = translationCache[cacheKey];
    if (!cached) {
        const stored = await db.loadDoc('job', cacheKey);
        if (!translationCache[cacheKey]) {
            if (stored && stored.content) {
                translationCache[cacheKey] = { status: 'done', content: stored.content, complete: true };
                console.log('[MongoDB] ' + label + ' Track ' + trackNum + ': الترجمة جاهزة من التخزين الدائم.');
            } else {
                const cfg = parseConfig(req.params.config);
                startTranslationJob({
                    cacheKey, handler, targetUrl,
                    userKeys: cfg.keys, userModel: cfg.model, userTmdbKey: cfg.tmdbKey,
                    extraKeys: { subdlKey: cfg.subdlKey, subsourceKey: cfg.subsourceKey },
                    trackNum, label, targetId, kitsuId
                });
            }
        }
        cached = translationCache[cacheKey];
    }
    if (cached && cached.status === 'done') {
        return sendSub(res, mime, 'Trans-Track' + trackNum + '-' + label + '.' + ext, cached.content);
    }
    sendSub(res, mime, 'Trans-Wait-' + label + '.' + ext, waitBody);
};
const SRT_WAIT = '1\n00:00:01,000 --> 01:00:00,000\nالترجمة قيد التنفيذ ⏳\nانقر لإعادة التحميل بمجرد جاهزيتها.\n\n';
const ASS_WAIT = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,1:00:00.00,Default,,0,0,0,,الترجمة قيد التنفيذ ⏳ انقر لإعادة التحميل بمجرد جاهزيتها.';
app.all(['/stream-raw.srt', '/:config/stream-raw.srt'],
    rawStreamRoute('srt', 'application/x-subrip; charset=utf-8'));
app.all(['/stream-raw.ass', '/:config/stream-raw.ass'],
    rawStreamRoute('ass', 'text/x-ssa; charset=utf-8'));
app.all(['/stream-ai.srt', '/:config/stream-ai.srt'],
    streamRoute('srt', 'SRT', 'application/x-subrip; charset=utf-8', handleTranslationSrtDetailed, SRT_WAIT));
app.all(['/stream-ai.ass', '/:config/stream-ai.ass'],
    streamRoute('ass', 'ASS', 'text/x-ssa; charset=utf-8', handleTranslationAssDetailed, ASS_WAIT));
app.all(['/stream-ara.srt', '/:config/stream-ara.srt'],
    streamRoute('srt', 'ARA-SRT', 'application/x-subrip; charset=utf-8', handleCorrectionSrt, SRT_WAIT));
app.all(['/stream-ara.ass', '/:config/stream-ara.ass'],
    streamRoute('ass', 'ARA-ASS', 'text/x-ssa; charset=utf-8', handleCorrectionAss, ASS_WAIT));
app.listen(PORT, () => {
    console.log('✅ Nuvio AI Subs Server is LIVE on port ' + PORT);
    db.init();
});
module.exports = app;
