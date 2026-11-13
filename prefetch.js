const axios = require('axios');
const { skipFillerAhead } = require('./filler');

const NEXT_EP_DELAY_MS = 3 * 60 * 1000;
const MAX_PREFETCHED_SET = 1000;

const nextEpTimers = new Map();
const prefetchedNextSet = new Set();

const LABEL_TO_STREAM_PATH = {
    'ARA-SRT': '/stream-ara.srt',
    'ARA-ASS': '/stream-ara.ass',
    'SRT': '/stream-ai.srt',
    'ASS': '/stream-ai.ass'
};

function getNextEpisodeTargetId(targetId) {
    if (!targetId) return null;
    const parts = String(targetId).split(':');
    if (parts.length >= 3 && (parts[0].startsWith('tt') || parts[0] === 'kitsu')) {
        const ep = parseInt(parts[2], 10);
        if (!isNaN(ep) && ep >= 1) {
            return parts[0] + ':' + parts[1] + ':' + (ep + 1);
        }
    }
    return null;
}

const SEASON_COUNTS_TTL_MS = 6 * 3600 * 1000;
const MAX_SEASON_COUNTS = 200;
const seasonCountsCache = new Map();

async function getSeasonCounts(imdbId) {
    const e = await getSeasonInfo(imdbId);
    return e ? e.counts : null;
}

// تاريخ عرض حلقة (ms) من Cinemeta، أو null إذا غير معروف
async function getReleaseMs(imdbId, season, ep) {
    const e = await getSeasonInfo(imdbId);
    if (!e || !e.rel) return null;
    const v = e.rel.get(season + ':' + ep);
    return Number.isFinite(v) ? v : null;
}

async function getSeasonInfo(imdbId) {
    const hit = seasonCountsCache.get(imdbId);
    if (hit && Date.now() - hit.at < SEASON_COUNTS_TTL_MS) return hit;
    try {
        const res = await axios.get('https://v3-cinemeta.strem.io/meta/series/' + imdbId + '.json', { timeout: 5000 });
        const videos = (res.data && res.data.meta && Array.isArray(res.data.meta.videos)) ? res.data.meta.videos : [];
        const counts = new Map();
        const rel = new Map();
        for (const v of videos) {
            const vs = parseInt(v.season, 10);
            const ve = parseInt(v.episode != null ? v.episode : v.number, 10);
            if (!isNaN(vs) && vs > 0 && !isNaN(ve) && ve > 0 && ve > (counts.get(vs) || 0)) counts.set(vs, ve);
            if (!isNaN(vs) && vs > 0 && !isNaN(ve) && ve > 0 && v.released) {
                const t = Date.parse(v.released);
                if (!isNaN(t)) rel.set(vs + ':' + ve, t);
            }
        }
        if (!counts.size) return null;
        if (seasonCountsCache.size >= MAX_SEASON_COUNTS) {
            const oldest = seasonCountsCache.keys().next().value;
            if (oldest) seasonCountsCache.delete(oldest);
        }
        const entry = { counts, rel, at: Date.now() };
        seasonCountsCache.set(imdbId, entry);
        return entry;
    } catch (e) {
        return null;
    }
}

async function resolveNextEpisodeTargetId(targetId) {
    const simple = getNextEpisodeTargetId(targetId);
    if (!simple) return null;
    const parts = String(targetId).split(':');
    if (!parts[0].startsWith('tt')) return simple;
    const season = parseInt(parts[1], 10);
    const ep = parseInt(parts[2], 10);
    if (isNaN(season) || isNaN(ep) || season < 1) return simple;
    const counts = await getSeasonCounts(parts[0]);
    if (!counts) return simple;
    if (ep === counts.get(season) && counts.has(season + 1)) {
        console.log('[تجهيز تلقائي] ' + targetId + ' هي آخر حلقة بالموسم ' + season + ' ⟵ أجهز بداية الموسم ' + (season + 1));
        return parts[0] + ':' + (season + 1) + ':1';
    }
    return simple;
}

function cancelNextEpisodePrefetch(targetId, reason = '') {
    if (!targetId) return;
    const existing = nextEpTimers.get(targetId);
    if (existing) {
        if (existing.timer) clearTimeout(existing.timer);
        nextEpTimers.delete(targetId);
    }
}

async function runNextEpisodePrefetch(info) {
    const { targetId, label, trackNum, rawConfig, kitsuId, kitsuEp, proto, host, port } = info;
    nextEpTimers.delete(targetId);
    let nextTargetId = await resolveNextEpisodeTargetId(targetId);
    if (!nextTargetId) return;

    // تجاوز حلقات الحشو (في الخلفية فقط): إن كانت الحلقة التالية حشواً نجهّز أقرب حلقة غير حشو بعدها
    try {
        const skip = await skipFillerAhead(targetId, kitsuId, kitsuEp);
        if (skip) {
            console.log('[تجهيز تلقائي] الحلقة ' + skip.from + ' وما بعدها حشو ⟵ تجاوز ' + skip.skipped
                + ' حلقة، وأجهز الحلقة ' + skip.to + ' (' + skip.kind + ') ⟵ ' + skip.targetId
                + ' [فحص الحشو: ' + skip.ms + ' ms]');
            nextTargetId = skip.targetId;
        }
    } catch (e) {
        console.error('[تجهيز تلقائي] فحص الحشو فشل (' + e.message + ') ⟵ أكمل بالحلقة التالية العادية.');
    }

    // لا نجهّز حلقة لم تُعرض بعد (وإلا تُحفظ ترجمات غلط مرفوعة على حلقة غير منشورة)
    try {
        const np = String(nextTargetId).split(':');
        if (np[0].startsWith('tt') && np.length >= 3) {
            const relMs = await getReleaseMs(np[0], parseInt(np[1], 10), parseInt(np[2], 10));
            if (relMs != null && relMs > Date.now()) {
                console.log('[تجهيز تلقائي] ' + nextTargetId + ' لم تُعرض بعد (' + new Date(relMs).toISOString().slice(0, 10) + ') ⟵ لا أجهّزها.');
                return;
            }
        }
    } catch (e) {}

    const prefetchKey = [nextTargetId, label, 'track' + trackNum].join('_');
    if (prefetchedNextSet.has(prefetchKey)) {
        console.log('[تجهيز] ' + nextTargetId + ' مجهّزة مسبقاً (' + label + ' مسار ' + trackNum + ')');
        return;
    }

    const expectedStreamPath = LABEL_TO_STREAM_PATH[label];
    if (!expectedStreamPath) return;

    const serverPort = port || process.env.PORT || 7000;
    const mediaType = nextTargetId.startsWith('kitsu') ? 'anime' : 'series';
    const subsPath = (rawConfig ? '/' + encodeURIComponent(rawConfig) : '')
        + '/subtitles/' + mediaType + '/' + encodeURIComponent(nextTargetId).replace(/%3A/gi, ':') + '.json?prefetch=1';

    console.log('[تجهيز] 3 دقائق على ' + targetId + ' ⟵ أجهز ' + nextTargetId + ' (' + label + ' مسار ' + trackNum + ')');

    try {
        const r = await axios.get('http://127.0.0.1:' + serverPort + subsPath, {
            headers: {
                'x-forwarded-host': host || ('127.0.0.1:' + serverPort),
                'x-forwarded-proto': proto || 'https'
            },
            timeout: 90000,
            validateStatus: () => true
        });

        const subs = (r.data && Array.isArray(r.data.subtitles)) ? r.data.subtitles : [];
        const matched = subs.find(s => {
            if (!s || !s.url) return false;
            try {
                const u = new URL(s.url);
                return u.pathname.toLowerCase().endsWith(expectedStreamPath) && u.searchParams.get('track') === String(trackNum);
            } catch {
                return false;
            }
        });

        if (!matched) {
            console.log('[تجهيز تلقائي] لم يتم العثور على ' + label + ' مسار ' + trackNum + ' للحلقة القادمة ' + nextTargetId);
            return;
        }

        const u = new URL(matched.url);
        u.searchParams.set('prefetch', '1');
        if (kitsuId && !u.searchParams.get('kitsu')) {
            u.searchParams.set('kitsu', kitsuId);
        }

        prefetchedNextSet.add(prefetchKey);
        if (prefetchedNextSet.size > MAX_PREFETCHED_SET) {
            const firstKey = prefetchedNextSet.values().next().value;
            if (firstKey) prefetchedNextSet.delete(firstKey);
        }

        await axios.get('http://127.0.0.1:' + serverPort + u.pathname + u.search, {
            headers: {
                'x-forwarded-host': host || ('127.0.0.1:' + serverPort),
                'x-forwarded-proto': proto || 'https'
            },
            timeout: 20000,
            validateStatus: () => true
        });
    } catch (e) {
        console.error('[تجهيز تلقائي] خطأ أثناء تجهيز الحلقة القادمة ' + nextTargetId + ':', e.message);
    }
}

function scheduleNextEpisodePrefetch(info) {
    const { targetId, label, trackNum, isReady } = info;
    const nextTargetId = getNextEpisodeTargetId(targetId);
    if (!nextTargetId) return;

    const prefetchKey = [nextTargetId, label, 'track' + trackNum].join('_');
    if (prefetchedNextSet.has(prefetchKey)) return;

    const existing = nextEpTimers.get(targetId);
    if (existing) {
        if (existing.timer) clearTimeout(existing.timer);
        if (existing.label !== label || String(existing.trackNum) !== String(trackNum)) {
            console.log('[تجهيز] تغيّر المسار على ' + targetId + ': ' + existing.label + ' ' + existing.trackNum + ' ⟵ ' + label + ' ' + trackNum + ' (أُعيد المؤقت)');
        }
    }

    const entry = { ...info, timer: null };
    if (isReady) {
        entry.timer = setTimeout(() => {
            runNextEpisodePrefetch(entry).catch(() => {});
        }, NEXT_EP_DELAY_MS);
        console.log('[تجهيز] بدأ مؤقت 3 دقائق على ' + targetId + ' ⟵ لتجهيز ' + nextTargetId + ' (' + label + ' مسار ' + trackNum + ')');
    }
    nextEpTimers.set(targetId, entry);
}

function activatePendingNextEpTimer(targetId, label, trackNum) {
    if (!targetId) return;
    const existing = nextEpTimers.get(targetId);
    if (!existing || existing.timer) return;

    if (existing.label === label && String(existing.trackNum) === String(trackNum)) {
        const nextTargetId = getNextEpisodeTargetId(targetId);
        if (!nextTargetId) return;
        existing.timer = setTimeout(() => {
            runNextEpisodePrefetch(existing).catch(() => {});
        }, NEXT_EP_DELAY_MS);
        console.log('[تجهيز] بدأ مؤقت 3 دقائق على ' + targetId + ' ⟵ لتجهيز ' + nextTargetId + ' (' + label + ' مسار ' + trackNum + ')');
    }
}

module.exports = {
    getReleaseMs,
    getNextEpisodeTargetId,
    resolveNextEpisodeTargetId,
    cancelNextEpisodePrefetch,
    scheduleNextEpisodePrefetch,
    activatePendingNextEpTimer
};
