const axios = require('axios');

const WYZIE_API = 'https://sub.wyzie.io/search';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SOURCE = String(process.env.WYZIE_SOURCE || 'all').trim() || 'all';
const SOURCE_COST = SOURCE === 'all' ? 3 : Math.max(1, SOURCE.split(',').filter(Boolean).length);
const DAILY_UNITS = Math.max(30, parseInt(process.env.WYZIE_DAILY_UNITS || '1000', 10) || 1000);
const ALL_TITLES = true; // للاختبار: ويز لكل الأعمال (ارجعها false ليرجع للأنمي فقط)

const MAX_RESULTS = 3;
const SEARCH_TIMEOUT_MS = 3000;
const BG_SEARCH_TIMEOUT_MS = 9000;
const META_TIMEOUT_MS = 2500;

const RESULT_OK_TTL_MS = 20 * 60 * 1000;
const RESULT_EMPTY_TTL_MS = 3 * 3600 * 1000;
const RESULT_FAIL_TTL_MS = 2 * 60 * 1000;
const ANIME_TTL_MS = 14 * 24 * 3600 * 1000;
const ANIME_FAIL_TTL_MS = 10 * 60 * 1000;
const KEY_REJECT_PAUSE_MS = 60 * 60 * 1000;
const RATE_PAUSE_MS = 15 * 60 * 1000;
const MAX_CACHE = 400;

let apiKey = '';
let pausedUntil = 0;
let pauseReason = '';
let usage = { day: '', units: 0 };
let real = { plan: '', balance: null };
const FREE_DAILY = 1000;

const resultCache = new Map();
const resultPending = new Map();
const animeCache = new Map();
const animePending = new Map();
const loggedOnce = new Map();

function setWyzieKey(k) {
    const v = String(k || '').trim();
    if (v === apiKey) return;
    apiKey = v;
    pausedUntil = 0;
    pauseReason = '';
}

function hasWyzieKey() {
    return !!apiKey;
}

function logOnce(k, msg, ttlMs = 6 * 3600 * 1000) {
    const t = loggedOnce.get(k);
    if (t && Date.now() - t < ttlMs) return;
    if (loggedOnce.size >= 500) loggedOnce.clear();
    loggedOnce.set(k, Date.now());
    console.log(msg);
}

function putCache(map, key, value, ttl) {
    if (map.size >= MAX_CACHE && !map.has(key)) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { value, exp: Date.now() + ttl });
}

function getCache(map, key) {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) {
        map.delete(key);
        return undefined;
    }
    return hit.value;
}

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function msToNextUtcDay() {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(60 * 1000, next - now.getTime());
}

function pause(ms, reason) {
    pausedUntil = Date.now() + ms;
    pauseReason = reason;
}

function isPaused() {
    if (pausedUntil && Date.now() < pausedUntil) return true;
    if (pausedUntil) {
        pausedUntil = 0;
        pauseReason = '';
    }
    return false;
}

function takeBudget() {
    const day = todayUtc();
    if (usage.day !== day) usage = { day, units: 0 };
    if (usage.units + SOURCE_COST > DAILY_UNITS) {
        pause(msToNextUtcDay(), 'الحد اليومي');
        logOnce('wyzie-daily-cap', '[Wyzie] وصلت الحد اليومي المحلي (' + usage.units + '/' + DAILY_UNITS + ' وحدة) ⟵ أوقف ويز لباقي اليوم (UTC).', 3600 * 1000);
        return false;
    }
    usage.units += SOURCE_COST;
    return true;
}

function noteBilling(res) {
    const h = res && res.headers;
    if (!h) return;
    const balance = parseFloat(h['x-wyzie-balance']);
    if (!Number.isFinite(balance)) return;
    const plan = String(h['x-wyzie-plan'] || '').toLowerCase();
    real = { plan, balance };
    if (plan === 'free') {
        const day = todayUtc();
        if (usage.day !== day) usage = { day, units: 0 };
        usage.units = Math.max(0, FREE_DAILY - Math.round(balance));
    }
}

function unitsLabel() {
    if (real.balance !== null && real.plan === 'free') return 'U ' + usage.units + '/' + FREE_DAILY;
    if (real.balance !== null) return 'R ' + Math.round(real.balance);
    return 'U ~' + usage.units;
}

function judgeAnime(meta) {
    const genres = [].concat(meta.genres || [], meta.genre || []).map(String).join(' ');
    const origin = [meta.country, meta.language].filter(Boolean).map(String).join(' ');
    const animLike = /animation|anime/i.test(genres);
    const explicitAnime = /\banime\b/i.test(genres);
    const japanese = /japan/i.test(origin);
    return {
        anime: (animLike && japanese) || (explicitAnime && !origin),
        suspect: animLike && !japanese,
        genres: genres.slice(0, 60),
        origin: origin.slice(0, 40)
    };
}

async function fetchIsAnime(imdbId, isSeries) {
    const res = await axios.get(CINEMETA + '/meta/' + (isSeries ? 'series' : 'movie') + '/' + imdbId + '.json', {
        timeout: META_TIMEOUT_MS,
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        validateStatus: () => true
    });
    const meta = res && res.status === 200 && res.data && res.data.meta;
    if (!meta || typeof meta !== 'object') return { known: false };
    const j = judgeAnime(meta);
    return { known: true, ...j };
}

async function isAnimeTitle(imdbId, type, isSeries) {
    if (type === 'anime' || ALL_TITLES) return true;
    const cached = getCache(animeCache, imdbId);
    if (cached !== undefined) return cached;
    let pending = animePending.get(imdbId);
    if (!pending) {
        pending = (async () => {
            try {
                const r = await fetchIsAnime(imdbId, isSeries);
                if (!r.known) {
                    putCache(animeCache, imdbId, false, ANIME_FAIL_TTL_MS);
                    logOnce('wyzie-meta-' + imdbId, '[Wyzie] ' + imdbId + ': ما قدرت أتأكد إنه أنمي (Cinemeta ما رجع بيانات) ⟵ تخطيت ويز.', 30 * 60 * 1000);
                    return false;
                }
                putCache(animeCache, imdbId, r.anime, ANIME_TTL_MS);
                if (r.anime) {
                    logOnce('wyzie-anime-' + imdbId, '[Wyzie] ' + imdbId + ': أنمي ✅ (' + r.genres + (r.origin ? ' | ' + r.origin : '') + ') ⟵ أستخدم ويز لـ ASS العربي.');
                } else if (r.suspect) {
                    logOnce('wyzie-suspect-' + imdbId, '[Wyzie] ' + imdbId + ': رسوم متحركة لكن مو ياباني (' + r.genres + ' | ' + (r.origin || 'بدون بلد') + ') ⟵ تخطيت ويز.');
                }
                return r.anime;
            } catch (e) {
                putCache(animeCache, imdbId, false, ANIME_FAIL_TTL_MS);
                logOnce('wyzie-meta-' + imdbId, '[Wyzie] ' + imdbId + ': فحص الأنمي فشل (' + (e && (e.code || e.message) || 'خطأ') + ') ⟵ تخطيت ويز.', 30 * 60 * 1000);
                return false;
            } finally {
                animePending.delete(imdbId);
            }
        })();
        animePending.set(imdbId, pending);
    }
    return pending;
}

function isArabicRow(r) {
    return /^ar/i.test(String(r.language || '')) || /arabic/i.test(String(r.display || ''));
}

function toItems(rows) {
    const arabic = (Array.isArray(rows) ? rows : [])
        .filter(r => r && typeof r.url === 'string' && /^https:\/\//i.test(r.url) && isArabicRow(r) && r.ai !== true);
    const rank = (a, b) =>
        (+!!a.isHearingImpaired - +!!b.isHearingImpaired) ||
        ((Number(b.downloadCount) || 0) - (Number(a.downloadCount) || 0));
    const assRows = arabic.filter(r => /^(ass|ssa)$/i.test(String(r.format || ''))).sort(rank);
    const srtRows = arabic.filter(r => /^srt$/i.test(String(r.format || ''))).sort(rank);
    const mk = fmt => r => {
        const hi = !!r.isHearingImpaired;
        const id = String(r.id || r.url.split('?')[0]);
        return {
            url: r.url,
            format: fmt,
            fileName: String(r.fileName || r.release || ('Wyzie_Ara_' + id)),
            hearingImpaired: hi,
            _isSdh: hi,
            _source: 'wyzie',
            _site: 'wyzie',
            _sig: 'wyzie:' + id,
            _wyzieSource: r.source ? String(r.source) : ''
        };
    };
    const out = [...assRows.slice(0, MAX_RESULTS).map(mk('ass')), ...srtRows.slice(0, MAX_RESULTS).map(mk('srt'))];
    out._raw = assRows.length;
    out._rawSrt = srtRows.length;
    return out;
}

function buildQuery(params) {
    return new URLSearchParams(params).toString().replace(/%2C/gi, ',');
}

async function searchWyzie({ imdbId, season, episode, isSeries, isPrefetch, tag }) {
    if (!takeBudget()) return null;
    const params = { id: imdbId, language: 'ar', format: 'ass,ssa,srt', source: SOURCE, key: apiKey };
    if (isSeries) {
        params.season = String(season);
        params.episode = String(episode);
    }
    let res;
    try {
        res = await axios.get(WYZIE_API + '?' + buildQuery(params), {
            timeout: isPrefetch ? BG_SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_MS,
            headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
            validateStatus: () => true
        });
    } catch (e) {
        logOnce('wyzie-net', '[Wyzie] ' + tag + ': خطأ شبكة (' + (e && (e.code || e.message) || 'خطأ') + ')', 10 * 60 * 1000);
        return null;
    }
    noteBilling(res);
    const st = res.status;
    if (st === 200 && Array.isArray(res.data)) return toItems(res.data);
    if (st === 404) return Object.assign([], { _raw: 0 });
    const msg = res.data && typeof res.data === 'object' ? String(res.data.message || res.data.details || '').slice(0, 80) : '';
    if (st === 401 || st === 403) {
        pause(KEY_REJECT_PAUSE_MS, 'المفتاح مرفوض');
        logOnce('wyzie-key', '[Wyzie] HTTP ' + st + (msg ? ' - ' + msg : '') + ' ⟵ المفتاح مرفوض أو موقوف، أوقف ويز ساعة. تأكد من المفتاح بصفحة الإعداد.', 30 * 60 * 1000);
    } else if (st === 402) {
        pause(msToNextUtcDay(), 'الرصيد');
        logOnce('wyzie-402', '[Wyzie] HTTP 402 ⟵ الرصيد خلص، أوقف ويز لباقي اليوم.', 3600 * 1000);
    } else if (st === 429) {
        const ra = parseInt(res.headers && res.headers['retry-after'], 10);
        pause(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6 * 3600 * 1000) : RATE_PAUSE_MS, 'حد الطلبات');
        logOnce('wyzie-429', '[Wyzie] HTTP 429 ⟵ تجاوزت حد الطلبات، أوقف ويز مؤقتاً.', 30 * 60 * 1000);
    } else {
        logOnce('wyzie-http-' + st, '[Wyzie] ' + tag + ': HTTP ' + st + (msg ? ' - ' + msg : ''), 10 * 60 * 1000);
    }
    return null;
}

async function getWyzieAss({ imdbId, season, episode, type, isPrefetch = false } = {}) {
    if (!apiKey) {
        logOnce('wyzie-nokey', '[Wyzie] غير مفعّل: ما في مفتاح Wyzie بصفحة الإعداد.', 24 * 3600 * 1000);
        return [];
    }
    if (!imdbId || !/^tt\d+$/.test(imdbId)) return [];
    if (isPaused()) return [];
    const isSeries = season != null && episode != null;
    const cacheKey = imdbId + ':' + (isSeries ? season + ':' + episode : 'movie');
    const hit = getCache(resultCache, cacheKey);
    if (hit !== undefined) return hit;
    if (!(await isAnimeTitle(imdbId, type, isSeries))) return [];
    if (isPaused()) return [];
    let pending = resultPending.get(cacheKey);
    if (!pending) {
        const tag = imdbId + (isSeries ? ' S' + season + 'E' + episode : '');
        pending = (async () => {
            try {
                const out = await searchWyzie({ imdbId, season, episode, isSeries, isPrefetch, tag });
                if (out === null) {
                    putCache(resultCache, cacheKey, [], RESULT_FAIL_TTL_MS);
                    return [];
                }
                putCache(resultCache, cacheKey, out, out.length ? RESULT_OK_TTL_MS : RESULT_EMPTY_TTL_MS);
                if (out.length) {
                    const src = Array.from(new Set(out.map(x => x._wyzieSource).filter(Boolean))).join('/');
                    const nAss = out.filter(x => x.format === 'ass').length;
                    const nSrt = out.length - nAss;
                    console.log('[Wyzie] ' + tag + ': ' + nAss + ' ASS + ' + nSrt + ' SRT عربي' + (src ? ' (' + src + ')' : '') + ' | ' + unitsLabel());
                } else {
                    console.log('[Wyzie] ' + tag + ': ما في ASS/SRT عربي | ' + unitsLabel());
                }
                return out;
            } finally {
                resultPending.delete(cacheKey);
            }
        })();
        resultPending.set(cacheKey, pending);
    }
    return pending;
}

function getWyzieUnits() {
    return usage.day === todayUtc() ? usage.units : 0;
}

module.exports = { getWyzieUnits, getWyzieAss, setWyzieKey, hasWyzieKey, isAnimeTitle, isPaused };
