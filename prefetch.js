const axios = require('axios');

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

function cancelNextEpisodePrefetch(targetId, reason = '') {
    if (!targetId) return;
    const existing = nextEpTimers.get(targetId);
    if (existing) {
        if (existing.timer) clearTimeout(existing.timer);
        nextEpTimers.delete(targetId);
        if (reason) {
            console.log('[تجهيز تلقائي] تم إلغاء مؤقت ' + targetId + ' (' + reason + ')');
        }
    }
}

async function runNextEpisodePrefetch(info) {
    const { targetId, label, trackNum, rawConfig, kitsuId, proto, host, port } = info;
    nextEpTimers.delete(targetId);
    const nextTargetId = getNextEpisodeTargetId(targetId);
    if (!nextTargetId) return;

    const prefetchKey = [nextTargetId, label, 'track' + trackNum].join('_');
    if (prefetchedNextSet.has(prefetchKey)) {
        console.log('[تجهيز تلقائي] المسار ' + trackNum + ' (' + label + ') للحلقة القادمة ' + nextTargetId + ' مجهّز مسبقاً.');
        return;
    }

    const expectedStreamPath = LABEL_TO_STREAM_PATH[label];
    if (!expectedStreamPath) return;

    const serverPort = port || process.env.PORT || 7000;
    const mediaType = nextTargetId.startsWith('kitsu') ? 'anime' : 'series';
    const subsPath = (rawConfig ? '/' + encodeURIComponent(rawConfig) : '')
        + '/subtitles/' + mediaType + '/' + encodeURIComponent(nextTargetId).replace(/%3A/gi, ':') + '.json?prefetch=1';

    console.log('[تجهيز تلقائي] استقرار 3 دقائق على ' + targetId + ' (' + label + ' مسار ' + trackNum + ') ⟵ بدء تجهيز الحلقة القادمة بالوضع العميق: ' + nextTargetId);

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

        console.log('[تجهيز تلقائي] ✅ تم إرسال ' + label + ' مسار ' + trackNum + ' للحلقة ' + nextTargetId + ' إلى طابور التجهيز بالخلفية.');
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
            console.log('[تجهيز تلقائي] تغيير المسار في ' + targetId + ' من (' + existing.label + ' مسار ' + existing.trackNum + ') إلى (' + label + ' مسار ' + trackNum + ') ⟵ إعادة ضبط المؤقت.');
        }
    }

    const entry = { ...info, timer: null };
    if (isReady) {
        entry.timer = setTimeout(() => {
            runNextEpisodePrefetch(entry).catch(() => {});
        }, NEXT_EP_DELAY_MS);
        console.log('[تجهيز تلقائي] بدء مؤقت 3 دقائق لـ ' + targetId + ' (' + label + ' مسار ' + trackNum + ') لتجهيز ' + nextTargetId);
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
        console.log('[تجهيز تلقائي] اكتمل تجهيز ' + targetId + ' (' + label + ' مسار ' + trackNum + ') ⟵ بدء مؤقت 3 دقائق لتجهيز ' + nextTargetId);
    }
}

module.exports = {
    getNextEpisodeTargetId,
    cancelNextEpisodePrefetch,
    scheduleNextEpisodePrefetch,
    activatePendingNextEpTimer
};
