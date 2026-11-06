const axios = require('axios');

// ملف بيانات الحشو (نفس الملف الذي تستخدمه aiometadata). يمكن تغيير عنوانه من متغير Render.
const FILLER_URL = (process.env.FILLER_DATA_URL || 'https://github.com/cedya77/anime-offline-database/releases/download/fillers/fillers.json').trim();
// FILLER_SKIP=0 في Render يطفئ الميزة بالكامل
const ENABLED = process.env.FILLER_SKIP !== '0';

const REFRESH_MS = (() => {
    const h = Number(process.env.FILLER_DATA_REFRESH_HOURS);
    return (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000;
})();
const RETRY_MS = 10 * 60 * 1000;
const ARM_TTL_MS = 24 * 3600 * 1000;
const MAX_ARM_CACHE = 500;
const MAX_SCAN = 1000;
const KINDS = ['canon', 'filler', 'mixed', 'anime_canon'];

let snapshot = null;
let nextTryAt = 0;
let loading = null;
const armCache = new Map();

const pos = v => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

async function download() {
    const t0 = Date.now();
    const r = await axios.get(FILLER_URL, {
        timeout: 30000,
        responseType: 'json',
        headers: { 'User-Agent': 'Nuvio-AI-Subs', 'Accept': 'application/json' }
    });
    const body = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const kinds = new Map();
    const maxEp = new Map();
    for (const [id, show] of Object.entries((body && body.shows) || {})) {
        const mal = pos(id);
        if (!mal) continue;
        const eps = new Map();
        let max = 0;
        for (const kind of KINDS) {
            for (const e of (show && show[kind]) || []) {
                const n = pos(e);
                if (!n) continue;
                eps.set(n, kind);
                if (n > max) max = n;
            }
        }
        kinds.set(mal, eps);
        maxEp.set(mal, max);
    }
    if (!kinds.size) throw new Error('الملف فارغ أو بصيغة غير متوقعة');
    snapshot = { kinds, maxEp, generated: (body && typeof body.generated === 'string') ? body.generated : null };
    nextTryAt = Date.now() + REFRESH_MS;
    console.log('[فلر] تم تحميل بيانات الحشو لـ ' + kinds.size + ' أنمي خلال ' + (Date.now() - t0) + ' ms'
        + (snapshot.generated ? ' (الملف مبني: ' + snapshot.generated + ')' : ''));
}

async function ensureLoaded() {
    if (!ENABLED) return false;
    if (Date.now() >= nextTryAt && !loading) {
        nextTryAt = Date.now() + RETRY_MS;
        loading = download()
            .catch(e => console.error('[فلر] فشل تحميل ملف الحشو: ' + e.message))
            .finally(() => { loading = null; });
    }
    if (!snapshot && loading) await loading;
    return !!snapshot;
}

function covers(mal) {
    return !!(snapshot && snapshot.kinds.has(mal));
}

function kindOf(mal, ep) {
    return (snapshot && snapshot.kinds.get(mal) && snapshot.kinds.get(mal).get(ep)) || null;
}

async function armEntry(kitsuId) {
    const key = String(kitsuId);
    const hit = armCache.get(key);
    if (hit && Date.now() - hit.at < ARM_TTL_MS) return hit.data;
    const r = await axios.get('https://arm.haglund.dev/api/v2/ids?source=kitsu&id=' + encodeURIComponent(key), {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
    });
    const data = r.data || null;
    if (data) {
        if (armCache.size >= MAX_ARM_CACHE) {
            const oldest = armCache.keys().next().value;
            if (oldest) armCache.delete(oldest);
        }
        armCache.set(key, { at: Date.now(), data });
    }
    return data;
}

/**
 * يُستدعى من الخلفية فقط (تجهيز الحلقة التالية).
 * يرجع null  ← لا تغيير، يكمل prefetch.js بمنطقه القديم.
 * يرجع كائن  ← { targetId, from, to, skipped, kind, mal, ms } أقرب حلقة غير حشو بعد الحلقة الحالية.
 */
async function skipFillerAhead(targetId, kitsuId) {
    if (!ENABLED || !kitsuId || !targetId) return null;
    const parts = String(targetId).split(':');
    if (parts.length < 3) return null;
    const ep = parseInt(parts[2], 10);
    if (!Number.isInteger(ep) || ep < 1) return null;
    const isKitsuForm = parts[0] === 'kitsu';
    const isTtForm = /^tt\d+$/.test(parts[0]);
    if (!isKitsuForm && !isTtForm) return null;

    const t0 = Date.now();
    if (!(await ensureLoaded())) return null;

    const data = await armEntry(kitsuId);
    if (!data) return null;
    const mal = pos(Array.isArray(data.myanimelist) ? data.myanimelist[0] : data.myanimelist);
    if (!mal || !covers(mal)) return null;

    if (isKitsuForm) {
        if (String(parts[1]) !== String(kitsuId)) return null;
    } else {
        const imdb = Array.isArray(data.imdb) ? data.imdb[0] : data.imdb;
        const season = data['thetvdb-season'] ?? data['themoviedb-season'] ?? 1;
        if (imdb !== parts[0] || String(season) !== String(parts[1])) {
            console.log('[فلر] ' + targetId + ': ترقيم الحلقة لا يطابق ترقيم Kitsu، تجاوز الحشو غير مفعّل لهذه الحلقة.');
            return null;
        }
    }

    const next = ep + 1;
    if (kindOf(mal, next) !== 'filler') return null;

    let to = next;
    while (kindOf(mal, to) === 'filler' && to - next < MAX_SCAN) to++;

    return {
        targetId: parts[0] + ':' + parts[1] + ':' + to,
        from: next,
        to,
        skipped: to - next,
        kind: kindOf(mal, to) || 'unlisted',
        mal,
        ms: Date.now() - t0
    };
}

module.exports = {
    skipFillerAhead,
    _test: {
        kindOf,
        covers,
        ensureLoaded,
        reset() { snapshot = null; nextTryAt = 0; loading = null; armCache.clear(); }
    }
};
