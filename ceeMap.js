'use strict';
// يحوّل معرفات سينمانا (cee:123) إلى رقم IMDb.
// 1) الأول يدوّر بالخريطة (cee-map.json) اللي يجهّزها الموبايل وتنرفع مع الكتالوج على GitHub Pages.
// 2) إذا العمل مو بالخريطة (مثلاً جاي من البحث)، يسأل سينمانا مباشرة (يشتغل فقط إذا Render مو محجوب).
//    وإذا انحجب، السجل يطبع السبب بوضوح: [CEE Live] ... فشل.

const axios = require('axios');

const MAP_URL = process.env.CEE_MAP_URL || 'https://sluom.github.io/cinemana-catalog/cee-map.json';
const CEE_BASE = (process.env.CEE_BASE || 'https://cee.buzz').replace(/\/+$/, '');
const LIVE_ENABLED = process.env.CEE_LIVE !== '0';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const LIVE_OK_MS = 6 * 60 * 60 * 1000;
const LIVE_FAIL_MS = 2 * 60 * 1000;
const LIVE_TIMEOUT_MS = 7000;
const LIVE_CACHE_MAX = 5000;

let mapData = null;
let loadedAt = 0;
let lastFailAt = 0;
let loading = null;

const str = v => (v === undefined || v === null ? '' : String(v).trim());
const imdbOf = d => {
    const m = str(d && d.imdbUrlRef).match(/tt\d+/);
    return m ? m[0] : '';
};

async function fetchMap() {
    const r = await axios.get(MAP_URL, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
        params: { t: Math.floor(Date.now() / REFRESH_MS) }
    });
    const d = r.data;
    if (!d || typeof d !== 'object' || !d.movies || !d.series || !d.eps) throw new Error('شكل الملف غير صحيح');
    return d;
}

async function loadMap() {
    const now = Date.now();
    if (mapData && now - loadedAt < REFRESH_MS) return mapData;
    if (lastFailAt && now - lastFailAt < RETRY_MS) return mapData;
    if (loading) return loading;
    loading = (async () => {
        try {
            const d = await fetchMap();
            mapData = d;
            loadedAt = Date.now();
            lastFailAt = 0;
            console.log('[CEE Map] تم تحميل الخريطة: أفلام=' + Object.keys(d.movies).length +
                ' مسلسلات=' + Object.keys(d.series).length + ' حلقات=' + Object.keys(d.eps).length);
        } catch (e) {
            lastFailAt = Date.now();
            console.error('[CEE Map] فشل تحميل الخريطة: ' + e.message);
        } finally {
            loading = null;
        }
        return mapData;
    })();
    return loading;
}

// ---------- السؤال المباشر لسينمانا ----------
const liveCache = new Map();

async function liveInfo(nb) {
    const r = await axios.get(CEE_BASE + '/api/android/allVideoInfo/id/' + encodeURIComponent(nb), {
        timeout: LIVE_TIMEOUT_MS,
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
            'Referer': CEE_BASE
        }
    });
    const d = r.data;
    if (!d || typeof d !== 'object' || !d.nb) throw new Error('رد غير صالح من سينمانا');
    return d;
}

async function resolveLive(nb) {
    const d = await liveInfo(nb);
    const isSeries = parseInt(d.kind, 10) === 2;
    let imdbId = imdbOf(d);
    let title = str(d.en_title) || str(d.ar_title);
    let year = str(d.year);
    if (!isSeries) {
        return { ok: true, type: 'movie', imdbId, title, year, reason: imdbId ? '' : 'no-imdb', live: true };
    }
    const root = parseInt(d.rootSeries, 10) || 0;
    if (!imdbId && root > 0) {
        try {
            const rd = await liveInfo(String(root));
            imdbId = imdbOf(rd);
            title = str(rd.en_title) || str(rd.ar_title) || title;
            year = str(rd.year) || year;
        } catch (e) { /* نكمل بدون رقم */ }
    }
    return {
        ok: true,
        type: 'series',
        imdbId,
        season: parseInt(d.season, 10) || 1,
        episode: parseInt(d.episodeNummer, 10) || 1,
        title,
        year,
        reason: imdbId ? '' : 'no-imdb',
        live: true
    };
}

function liveLookup(nb) {
    const now = Date.now();
    const hit = liveCache.get(nb);
    if (hit && now < hit.until) return hit.promise;
    if (liveCache.size >= LIVE_CACHE_MAX) liveCache.delete(liveCache.keys().next().value);
    const entry = { promise: null, until: now + LIVE_OK_MS };
    entry.promise = resolveLive(nb).then(
        res => {
            if (res.imdbId) {
                console.log('[CEE Live] cee:' + nb + ' -> ' + res.imdbId + (res.title ? ' (' + res.title + ')' : ''));
            } else {
                entry.until = Date.now() + LIVE_FAIL_MS;
                console.log('[CEE Live] cee:' + nb + ': سينمانا ما عندها رقم IMDb لهذا العمل' + (res.title ? ' | ' + res.title + ' ' + (res.year || '') : ''));
            }
            return res;
        },
        err => {
            entry.until = Date.now() + LIVE_FAIL_MS;
            const code = err && err.response ? 'HTTP ' + err.response.status : (err && (err.code || err.message)) || 'unknown';
            console.error('[CEE Live] cee:' + nb + ' فشل السؤال المباشر لسينمانا: ' + code);
            return { ok: false, reason: 'live-failed:' + code };
        }
    );
    liveCache.set(nb, entry);
    return entry.promise;
}

async function liveFallback(nb, parts) {
    if (!LIVE_ENABLED) return { ok: false, reason: 'not-found' };
    const res = await liveLookup(nb);
    // الشكل الاحتياطي cee:<مسلسل>:<موسم>:<حلقة>: نأخذ رقم IMDb من المسلسل ونبقي الموسم والحلقة من الطلب
    if (res && res.ok && parts.length >= 4) {
        return { ...res, type: 'series', season: parseInt(parts[2], 10) || 1, episode: parseInt(parts[3], 10) || 1 };
    }
    return res;
}

// ---------- الخريطة ----------
function fromSeries(map, seriesNb, season, episode) {
    const info = map.series[seriesNb];
    const imdbId = info && info.i ? info.i : '';
    return {
        ok: true,
        type: 'series',
        imdbId,
        season: parseInt(season, 10) || 1,
        episode: parseInt(episode, 10) || 1,
        title: info ? info.n : '',
        year: info ? info.y : '',
        reason: imdbId ? '' : (info ? 'no-imdb' : 'series-not-found')
    };
}

// الأشكال المدعومة:
//   cee:<رقم الفيلم>
//   cee:<رقم الحلقة>                       (رقم الحلقة نفسه من كتالوجنا)
//   cee:<رقم المسلسل>:<موسم>:<حلقة>         (احتياطاً، إذا التطبيق ركّبه بهذا الشكل)
async function resolveCeeId(targetId) {
    const parts = String(targetId || '').split(':');
    if (parts[0] !== 'cee' || !parts[1]) return { ok: false, reason: 'not-cee' };
    const nb = parts[1];
    const map = await loadMap();
    if (!map) return liveFallback(nb, parts);

    if (parts.length >= 4) {
        if (map.series[nb]) return fromSeries(map, nb, parts[2], parts[3]);
        return liveFallback(nb, parts);
    }

    const ep = map.eps[nb];
    if (ep) return fromSeries(map, ep[0], ep[1], ep[2]);

    const mv = map.movies[nb];
    if (mv) {
        return {
            ok: true,
            type: 'movie',
            imdbId: mv.i || '',
            title: mv.n || '',
            year: mv.y || '',
            reason: mv.i ? '' : 'no-imdb'
        };
    }
    return liveFallback(nb, parts);
}

module.exports = { resolveCeeId, loadMap };
