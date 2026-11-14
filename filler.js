const axios = require('axios');

const settings = require('./settings');
const isEnabled = () => !!settings.get('filler_skip');

function normalizeBase(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/^stremio:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(u)) return '';
    u = u.replace(/[?#].*$/, '').replace(/\/manifest\.json\/?$/i, '').replace(/\/+$/, '');
    return u;
}
const BASE = normalizeBase(process.env.AIOMETADATA_URL);
let BASE_HOST = '';
try { BASE_HOST = BASE ? new URL(BASE).host : ''; } catch { BASE_HOST = ''; }

const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const FAIL_RETRY_MS = 5 * 60 * 1000;
const MAX_SHOWS = 100;
const MAX_SCAN = 1000;

const showCache = new Map();
const inflight = new Map();
let warnedNoUrl = false;

const posInt = v => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

function buildShow(videos) {
    const seq = [];
    for (const v of videos || []) {
        if (!v) continue;
        const s = posInt(v.season);
        const e = posInt(v.episode != null ? v.episode : v.number);
        if (!s || !e) continue;
        const mixed = v.isMixedFiller === true;
        const filler = v.isFiller === true && !mixed;
        seq.push({ s, e, id: String(v.id || ''), filler, mixed });
    }
    seq.sort((a, b) => a.s - b.s || a.e - b.e);
    const index = new Map();
    const uniq = [];
    for (const x of seq) {
        const key = x.s + ':' + x.e;
        if (index.has(key)) continue;
        index.set(key, uniq.length);
        uniq.push(x);
    }
    let maxS1 = 0;
    for (const x of uniq) if (x.s === 1 && x.e > maxS1) maxS1 = x.e;
    return { seq: uniq, index, maxS1 };
}

async function fetchShow(key) {
    const t0 = Date.now();
    const r = await axios.get(BASE + '/meta/series/' + (key.startsWith('kitsu:') ? key : encodeURIComponent(key)) + '.json', {
        timeout: FETCH_TIMEOUT_MS,
        responseType: 'json',
        headers: { 'User-Agent': 'Nuvio-AI-Subs', 'Accept': 'application/json' }
    });
    const body = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const videos = body && body.meta && Array.isArray(body.meta.videos) ? body.meta.videos : null;
    if (!videos) throw new Error('رد aiometadata بلا قائمة حلقات');
    const show = buildShow(videos);
    if (!show.seq.length) throw new Error('aiometadata لم يرجع حلقات عادية');
    show.imdb = String(body.meta._imdbId || body.meta.imdb_id || '');
    return show;
}

async function getShow(key) {
    const hit = showCache.get(key);
    if (hit && Date.now() - hit.at < (hit.ok ? CACHE_TTL_MS : FAIL_RETRY_MS)) return hit.ok ? hit : null;
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchShow(key)
        .then(show => {
            if (showCache.size >= MAX_SHOWS) {
                const oldest = showCache.keys().next().value;
                if (oldest) showCache.delete(oldest);
            }
            const entry = { at: Date.now(), ok: true, seq: show.seq, index: show.index, maxS1: show.maxS1, imdb: show.imdb };
            showCache.set(key, entry);
            return entry;
        })
        .catch(e => {
            console.error('[فلر] تعذّر قراءة aiometadata لـ ' + key + (BASE_HOST ? ' (' + BASE_HOST + ')' : '') + ': ' + e.message);
            showCache.set(key, { at: Date.now(), ok: false });
            return null;
        })
        .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
}

async function skipKitsu(targetId, kid, kepRaw, detail) {
    if (!/^\d+$/.test(kid)) return null;
    const kep = posInt(kepRaw);
    if (!kep) return null;
    const t0 = Date.now();
    const show = await getShow('kitsu:' + kid);
    if (!show) return null;

    const tm = /^(tt\d+):/.exec(String(targetId));
    if (tm && /^tt\d+$/.test(show.imdb || '') && show.imdb !== tm[1]) {
        console.log('[فلر] kitsu:' + kid + ': رقم IMDb عند aiometadata (' + show.imdb + ') لا يطابق ' + tm[1] + ' ⟵ تجاوز الحشو متوقف لهذه الحلقة.');
        return null;
    }

    const cur = show.seq.findIndex(x => x.id === 'kitsu:' + kid + ':' + kep);
    if (cur < 0) return null;

    const nextIdx = cur + 1;
    const nextItem = show.seq[nextIdx];
    if (!nextItem || !nextItem.filler) return null;

    let to = nextIdx;
    while (show.seq[to] && show.seq[to].filler && to - nextIdx < MAX_SCAN) to++;
    const target = show.seq[to];
    if (!target || target.filler) return detail ? { allFiller: true } : null;
    const tmk = /^kitsu:(\d+):(\d+)$/.exec(target.id);
    if (!tmk || tmk[1] !== kid) return null;

    return {
        targetId: target.id,
        from: String(nextItem.e),
        to: String(target.e),
        skipped: to - nextIdx,
        kind: target.mixed ? 'mixed' : 'canon',
        ms: Date.now() - t0
    };
}

async function skipFillerAhead(targetId, kitsuId, kitsuEp, detail) {
    if (!isEnabled() || !targetId) return null;
    if (!BASE) {
        if (!warnedNoUrl) {
            warnedNoUrl = true;
            console.log('[فلر] AIOMETADATA_URL غير مضبوط في Render ⟵ تجاوز الحشو متوقف (التجهيز يعمل بالحلقة التالية العادية).');
        }
        return null;
    }
    if (kitsuId) return skipKitsu(targetId, String(kitsuId).trim(), kitsuEp, detail);
    const m = /^(tt\d+):(\d+):(\d+)$/.exec(String(targetId));
    if (!m) return null;
    const imdbId = m[1];
    const season = parseInt(m[2], 10);
    const ep = parseInt(m[3], 10);
    if (!(season >= 1) || !(ep >= 1)) return null;

    const t0 = Date.now();
    const show = await getShow(imdbId);
    if (!show) return null;

    let absolute = false;
    let cur = show.index.get(season + ':' + ep);
    if (cur === undefined) {
        if (season === 1 && ep > show.maxS1 && ep <= show.seq.length) {
            cur = ep - 1;
            absolute = true;
        } else {
            return null;
        }
    }

    const nextIdx = cur + 1;
    const nextItem = show.seq[nextIdx];
    if (!nextItem || !nextItem.filler) return null;

    let to = nextIdx;
    while (show.seq[to] && show.seq[to].filler && to - nextIdx < MAX_SCAN) to++;
    const target = show.seq[to];
    if (!target || target.filler) return detail ? { allFiller: true } : null;

    const idOf = i => absolute ? (imdbId + ':1:' + (i + 1)) : (imdbId + ':' + show.seq[i].s + ':' + show.seq[i].e);
    const labelOf = i => {
        const x = show.seq[i];
        return (absolute || x.s === season) ? String(absolute ? i + 1 : x.e) : x.s + 'x' + x.e;
    };

    return {
        targetId: idOf(to),
        from: labelOf(nextIdx),
        to: labelOf(to),
        skipped: to - nextIdx,
        kind: target.mixed ? 'mixed' : 'canon',
        ms: Date.now() - t0
    };
}

module.exports = {
    skipFillerAhead,
    _test: {
        normalizeBase,
        buildShow,
        reset() { showCache.clear(); inflight.clear(); warnedNoUrl = false; }
    }
};
