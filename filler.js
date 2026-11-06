const axios = require('axios');

// ============================================================================
//  تجاوز حلقات الحشو (Filler) في التجهيز التلقائي للحلقة القادمة.
//  المصدر الوحيد: إضافة aiometadata الخاصة بك (علامات isFiller / isMixedFiller).
//
//  الإعداد من Render (لا يوضع أي رابط داخل الكود لأن المستودع عام):
//    AIOMETADATA_URL = رابط تثبيت إضافتك (نفس رابط manifest.json) — يقبل مع أو بدون /manifest.json
//    FILLER_SKIP=0   ← يطفئ الميزة بالكامل
//
//  القاعدة:
//    - يُتجاوز فقط من علامته isFiller=true (ولم تُعلَّم Mixed).
//    - Mixed وأي حلقة غير حشو تُجهَّز دائماً كما هي.
//    - أي خطأ/تعذّر اتصال ⟵ يرجع null فيكمل التجهيز بالحلقة التالية العادية (الميزة لا تعطّل شيئاً أبداً).
// ============================================================================

const ENABLED = process.env.FILLER_SKIP !== '0';

// يقبل: https://host/…/manifest.json أو stremio://host/…/manifest.json أو الرابط بدون manifest.json
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

const showCache = new Map();   // imdbId → { at, ok, seq, index }
const inflight = new Map();    // imdbId → Promise
let warnedNoUrl = false;

const posInt = v => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// يبني من videos تسلسلاً مرتباً للحلقات العادية فقط (الموسم 0 / الخاصة مستبعدة)
function buildShow(videos) {
    const seq = [];
    for (const v of videos || []) {
        if (!v) continue;
        const s = posInt(v.season);
        const e = posInt(v.episode != null ? v.episode : v.number);
        if (!s || !e) continue;
        const mixed = v.isMixedFiller === true;
        const filler = v.isFiller === true && !mixed;   // Mixed لا يُتجاوز أبداً
        seq.push({ s, e, filler, mixed });
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

async function fetchShow(imdbId) {
    const t0 = Date.now();
    const r = await axios.get(BASE + '/meta/series/' + encodeURIComponent(imdbId) + '.json', {
        timeout: FETCH_TIMEOUT_MS,
        responseType: 'json',
        headers: { 'User-Agent': 'Nuvio-AI-Subs', 'Accept': 'application/json' }
    });
    const body = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const videos = body && body.meta && Array.isArray(body.meta.videos) ? body.meta.videos : null;
    if (!videos) throw new Error('رد aiometadata بلا قائمة حلقات');
    const show = buildShow(videos);
    if (!show.seq.length) throw new Error('aiometadata لم يرجع حلقات عادية');
    const withFlags = show.seq.some(x => x.filler || x.mixed);
    console.log('[فلر] ' + imdbId + ': قرأت ' + show.seq.length + ' حلقة من aiometadata ('
        + show.seq.filter(x => x.filler).length + ' حشو، ' + show.seq.filter(x => x.mixed).length + ' مختلطة'
        + (withFlags ? '' : ' — لا توجد أي علامة حشو لهذا العمل') + ') خلال ' + (Date.now() - t0) + ' ms');
    return show;
}

async function getShow(imdbId) {
    const hit = showCache.get(imdbId);
    if (hit && Date.now() - hit.at < (hit.ok ? CACHE_TTL_MS : FAIL_RETRY_MS)) return hit.ok ? hit : null;
    if (inflight.has(imdbId)) return inflight.get(imdbId);
    const p = fetchShow(imdbId)
        .then(show => {
            if (showCache.size >= MAX_SHOWS) {
                const oldest = showCache.keys().next().value;
                if (oldest) showCache.delete(oldest);
            }
            const entry = { at: Date.now(), ok: true, seq: show.seq, index: show.index, maxS1: show.maxS1 };
            showCache.set(imdbId, entry);
            return entry;
        })
        .catch(e => {
            // لا نطبع الرابط أبداً (فيه إعدادك الخاص) — الرسالة فقط
            console.error('[فلر] تعذّر قراءة aiometadata لـ ' + imdbId + (BASE_HOST ? ' (' + BASE_HOST + ')' : '') + ': ' + e.message);
            showCache.set(imdbId, { at: Date.now(), ok: false });
            return null;
        })
        .finally(() => { inflight.delete(imdbId); });
    inflight.set(imdbId, p);
    return p;
}

/**
 * يُستدعى من الخلفية فقط (تجهيز الحلقة القادمة).
 * يرجع null  ← لا تغيير، يكمل prefetch.js بمنطقه المعتاد.
 * يرجع كائن  ← { targetId, from, to, skipped, kind, ms } أقرب حلقة غير حشو بعد الحلقة الحالية.
 * (kitsuId يبقى بالتوقيع للتوافق، ولا نعتمد عليه: الاعتماد على aiometadata فقط.)
 */
async function skipFillerAhead(targetId, kitsuId) {
    if (!ENABLED || !targetId) return null;
    if (!BASE) {
        if (!warnedNoUrl) {
            warnedNoUrl = true;
            console.log('[فلر] AIOMETADATA_URL غير مضبوط في Render ⟵ تجاوز الحشو متوقف (التجهيز يعمل بالحلقة التالية العادية).');
        }
        return null;
    }
    const m = /^(tt\d+):(\d+):(\d+)$/.exec(String(targetId));
    if (!m) return null;
    const imdbId = m[1];
    const season = parseInt(m[2], 10);
    const ep = parseInt(m[3], 10);
    if (!(season >= 1) || !(ep >= 1)) return null;

    const t0 = Date.now();
    const show = await getShow(imdbId);
    if (!show) return null;

    // موضع الحلقة الحالية بالتسلسل:
    //  1) ترقيم aiometadata نفسه (موسم:حلقة)  ← الحالة المعتادة
    //  2) ترقيم مطلق tt:1:N الذي تنتجه إعادة الترقيم داخل الإضافة (N أكبر من آخر حلقة بالموسم 1 عند aiometadata)
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
    if (!nextItem || !nextItem.filler) return null;     // التالية ليست حشواً ⟵ لا شيء يتغير

    let to = nextIdx;
    while (show.seq[to] && show.seq[to].filler && to - nextIdx < MAX_SCAN) to++;
    const target = show.seq[to];
    if (!target || target.filler) return null;          // ما بعدها كله حشو/انتهى المسلسل ⟵ المنطق المعتاد

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
