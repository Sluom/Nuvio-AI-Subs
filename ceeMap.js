'use strict';
// يحوّل معرفات سينمانا (cee:123) إلى رقم IMDb.
// الخريطة يجهّزها الموبايل (idmap.js) وتنرفع مع الكتالوج على GitHub Pages،
// فالإضافة على Render ما تتصل بسينمانا أبداً.

const axios = require('axios');

const MAP_URL = process.env.CEE_MAP_URL || 'https://sluom.github.io/cinemana-catalog/cee-map.json';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

let mapData = null;
let loadedAt = 0;
let lastFailAt = 0;
let loading = null;

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
    if (!map) return { ok: false, reason: 'map-unavailable' };

    if (parts.length >= 4) return fromSeries(map, nb, parts[2], parts[3]);

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
    return { ok: false, reason: 'not-found' };
}

module.exports = { resolveCeeId, loadMap };
