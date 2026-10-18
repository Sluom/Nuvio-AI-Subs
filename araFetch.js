const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');
const { getOsCom, isOsComUrl, downloadOsComText } = require('./oscom');
module.exports = { getArabicSubsForCorrection, getRawArabicSubContent, resolveEpInfoForUrl };
const cleanPath = p => String(p || '').split('?')[0];
// ---------- وضع اختبار OS.com (متغير Render: OSCOM_TEST=1) ----------
// يلغي السقف الزمني لـ OS.com، ويفحص كل ملفاته، وينتظر نهاية الفحص كاملاً، ويتجاوز كاش النتائج.
// OSCOM_TEST_MAX=N (اختياري) يحدد أقصى عدد ملفات OS.com تُفحص. بدونه: بلا حد.
const OSCOM_TEST = process.env.OSCOM_TEST === '1';
const OSCOM_TEST_MAX = Math.max(0, parseInt(process.env.OSCOM_TEST_MAX || '0', 10) || 0);
const OSCOM_TEST_TIMEOUT = 120000;
// OS Legacy: نفس ترتيب الأجنبي (TemporaryUserAgent ثم VLSub دائماً)
const LEGACY_AGENTS = ['TemporaryUserAgent', 'VLSub 0.10.3'];
const LEGACY_AGENT_GAP_MS = 1000;
const LEGACY_BUDGET_MS = 3200;
const SOURCE_TIMEOUTS = { os_legacy: 3500, os_mirror: 3200, subdl: 3800, subsource: 3800, oscom: OSCOM_TEST ? OSCOM_TEST_TIMEOUT : 3500 };
const FAST_VERIFY_WINDOW_MS = OSCOM_TEST ? OSCOM_TEST_TIMEOUT : 2800;
const VERIFY_TIMEOUT_MS = 2600;
const TOTAL_WARN_MS = 4500;
const CONCURRENCY_LIMIT = 8;
const MAX_SRT_PER_SITE = 20;
const OSCOM_VERIFY_EACH = 2;
const CORRECTOR_MAX = 4;
const RESULT_TTL = 30 * 60 * 1000;
const MAX_RESULT_CACHE = 100;
const VERIFY_LEGACY = process.env.OS_LEGACY_VERIFY !== '0';
const LEGACY_DIRECT_LINK = process.env.OS_LEGACY_DIRECT === '1';
const resultCache = new Map();
const MAX_RAW_CACHE = 150;
const rawTextCache = new Map();
const seriesMetaCache = new Map();
const urlEpOverrideMap = new Map();
const assFormatRe = /^(ass|ssa)$/i;
const assFileRe = /\.(ass|ssa)(\b|$)/i;
const rarFileRe = /\.(rar|7z)(\?|$)/i;
const osFileIdRe = /\/file\/(\d+)/i;
// ---------- أدوات اللوغ ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sec = ms => (ms / 1000).toFixed(1) + 'ث';
const pad = (n, w) => String(n).padStart(w, '0');
function clk(ts) {
    const d = ts ? new Date(ts) : new Date();
    return pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + '.' + pad(d.getUTCMilliseconds(), 3);
}
function setRawCache(key, text) {
    if (!key || !text) return;
    if (rawTextCache.size >= MAX_RAW_CACHE && !rawTextCache.has(key)) {
        const oldestKey = rawTextCache.keys().next().value;
        if (oldestKey) rawTextCache.delete(oldestKey);
    }
    rawTextCache.set(key, { time: Date.now(), text });
}
function getRawCache(key) {
    const hit = rawTextCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.time > RESULT_TTL) {
        rawTextCache.delete(key);
        return null;
    }
    return hit.text;
}
function makeRawKey(url, epInfo) {
    const epTag = epInfo && epInfo.season != null && epInfo.episode != null
        ? [epInfo.season, epInfo.episode].join(':')
        : 'movie';
    return [url, epTag].join('|');
}
function setResultCache(key, value) {
    if (resultCache.size >= MAX_RESULT_CACHE && !resultCache.has(key)) {
        const oldestKey = resultCache.keys().next().value;
        if (oldestKey) resultCache.delete(oldestKey);
    }
    resultCache.set(key, { time: Date.now(), value });
}
function rememberUrlEpOverride(url, epOverride) {
    if (!url || !epOverride) return;
    if (urlEpOverrideMap.size >= 500) {
        const first = urlEpOverrideMap.keys().next().value;
        if (first) urlEpOverrideMap.delete(first);
    }
    urlEpOverrideMap.set(cleanPath(url), epOverride);
}
function resolveEpInfoForUrl(url, defaultEpInfo) {
    if (!url) return defaultEpInfo;
    return urlEpOverrideMap.get(cleanPath(url)) || defaultEpInfo;
}
async function loadSubText(url, subsourceKey, epInfo) {
    const osComId = isOsComUrl(url);
    if (osComId) return downloadOsComText(osComId);
    const { fetchAndExtractSub } = require('./ai').shared;
    return fetchAndExtractSub(url, subsourceKey, epInfo);
}
async function getAbsoluteEpisodeNumber(imdbId, season, episode) {
    const sNum = parseInt(season, 10);
    const eNum = parseInt(episode, 10);
    if (!imdbId || !imdbId.startsWith('tt') || isNaN(sNum) || isNaN(eNum) || sNum <= 1) {
        return null;
    }
    let seasonCounts = seriesMetaCache.get(imdbId);
    if (!seasonCounts) {
        try {
            const res = await axios.get('https://v3-cinemeta.strem.io/meta/series/' + imdbId + '.json', {
                timeout: 2200
            });
            const videos = (res.data && res.data.meta && Array.isArray(res.data.meta.videos)) ? res.data.meta.videos : [];
            if (videos.length > 0) {
                seasonCounts = new Map();
                for (const v of videos) {
                    const vs = parseInt(v.season, 10);
                    const ve = parseInt(v.episode != null ? v.episode : v.number, 10);
                    if (!isNaN(vs) && vs > 0 && !isNaN(ve) && ve > 0) {
                        const prevMax = seasonCounts.get(vs) || 0;
                        if (ve > prevMax) seasonCounts.set(vs, ve);
                    }
                }
                if (seasonCounts.size > 0) {
                    if (seriesMetaCache.size >= 200) {
                        const oldest = seriesMetaCache.keys().next().value;
                        if (oldest) seriesMetaCache.delete(oldest);
                    }
                    seriesMetaCache.set(imdbId, seasonCounts);
                }
            }
        } catch (e) {
            console.log('[ترقيم مطلق] تعذر جلب تقسيمة المواسم من Cinemeta: ' + e.message);
            return null;
        }
    }
    if (!seasonCounts || !seasonCounts.size) return null;
    let offset = 0;
    for (let s = 1; s < sNum; s++) {
        const count = seasonCounts.get(s);
        if (!count) return null;
        offset += count;
    }
    const absEp = offset + eNum;
    return absEp > eNum ? absEp : null;
}
function withTimeout(promise, ms, name) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            console.log('[جلب عربي - ' + name + '] تجاوز ' + (ms / 1000).toFixed(1) + ' ثانية، تجاهلته وكملت بالباقي.');
            resolve([]);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function extractOsFileId(url) {
    const m = String(url || '').match(osFileIdRe);
    return m ? m[1] : null;
}
function normalizeNameSig(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\.(srt|ass|ssa|zip|gz)$/i, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}
// ---------- OS Legacy ----------
function legacyErrDetail(response) {
    const d = response && response.data;
    let head = typeof d === 'string' ? d : (d ? JSON.stringify(d) : '');
    head = head.replace(/\s+/g, ' ').slice(0, 120);
    const h = (response && response.headers) || {};
    const parts = [];
    if (head) parts.push('رد الموقع: ' + head);
    if (h['retry-after']) parts.push('retry-after=' + h['retry-after']);
    if (h.server) parts.push('server=' + h.server);
    return parts.length ? ' | ' + parts.join(' | ') : '';
}
// يسأل الوكيلين بالترتيب (دائماً الاثنين) ويضيف النتائج أولاً بأول إلى sink
async function fetchLegacyData(url, sink, ctl, label) {
    for (let i = 0; i < LEGACY_AGENTS.length; i++) {
        if (ctl.stop) return;
        if (i > 0) await sleep(LEGACY_AGENT_GAP_MS);
        if (ctl.stop) return;
        const ua = LEGACY_AGENTS[i];
        const t0 = Date.now();
        try {
            const response = await axios.get(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' },
                timeout: 3000,
                validateStatus: () => true
            });
            const took = sec(Date.now() - t0);
            if (response.status < 200 || response.status >= 300) {
                console.log('[جلب عربي - OS Legacy] ' + label + ' | ' + ua + ' | HTTP ' + response.status + ' (' + took + ')' + legacyErrDetail(response));
                continue;
            }
            let json = response.data;
            if (typeof json === 'string') {
                try { json = JSON.parse(json); } catch { json = []; }
            }
            const arr = Array.isArray(json) ? json : [];
            console.log('[جلب عربي - OS Legacy] ' + label + ' | ' + ua + ' | رجع ' + arr.length + ' (' + took + ')');
            sink.push(...arr);
        } catch (e) {
            const why = e.code || (e.cause && (e.cause.code || e.cause.message)) || '';
            console.log('[جلب عربي - OS Legacy] ' + label + ' | ' + ua + ' | خطأ: ' + e.message + (why ? ' | السبب: ' + why : '') + ' (' + sec(Date.now() - t0) + ')');
        }
    }
}
async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;
    const primaryUrl = hasSE
        ? 'https://rest.opensubtitles.org/search/episode-' + episode + '/imdbid-' + numericId + '/season-' + season + '/sublanguageid-ara'
        : 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';
    const fallbackUrl = 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';
    const legacyFormat = r => {
        const f = String(r.SubFormat || '').toLowerCase();
        const n = String(r.SubFileName || '').toLowerCase();
        if (assFormatRe.test(f) || assFileRe.test(n)) return 'ass';
        if (f === 'srt' || /\.srt$/.test(n)) return 'srt';
        return null;
    };
    const tStart = Date.now();
    const ctl = { stop: false };
    const primarySink = [];
    const fallbackSink = [];
    const work = (async () => {
        await fetchLegacyData(primaryUrl, primarySink, ctl, 'أساسي');
        if (hasSE && !primarySink.some(r => legacyFormat(r) === 'ass')) {
            await fetchLegacyData(fallbackUrl, fallbackSink, ctl, 'احتياطي');
        }
    })().catch(e => console.log('[جلب عربي - OS Legacy] خطأ: ' + e.message));
    // ميزانية داخلية أقل من سقف المصدر (3.5ث): إذا خلصت نكتفي بما وصل بدل ضياع كل النتائج
    let budgetTimer;
    let timedOut = false;
    await Promise.race([
        work,
        new Promise(resolve => { budgetTimer = setTimeout(() => { timedOut = true; ctl.stop = true; resolve(); }, LEGACY_BUDGET_MS); })
    ]);
    clearTimeout(budgetTimer);
    if (timedOut) console.log('[جلب عربي - OS Legacy] وصلت حد ' + sec(LEGACY_BUDGET_MS) + '، أكتفي بما وصل حتى الآن.');
    let data = primarySink.slice();
    if (hasSE && fallbackSink.length) {
        const epNum = parseInt(episode, 10);
        const epRe = new RegExp('(?:e|ep|episode)[._ -]*0*' + epNum + '(?:[^0-9]|$)', 'i');
        data = [...data, ...fallbackSink.filter(r => legacyFormat(r) === 'ass' && epRe.test(r.SubFileName || ''))];
    }
    const out = [];
    const seenIds = new Set();
    for (const e of data) {
        if (!e || !e.SubDownloadLink) continue;
        const format = legacyFormat(e);
        if (!format) continue;
        const dedupeKey = String(e.IDSubtitleFile || e.SubDownloadLink);
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);
        const link = String(e.SubDownloadLink);
        out.push({
            url: LEGACY_DIRECT_LINK ? link.replace(/\.gz$/i, '') + '.' + format : link,
            format,
            fileName: e.SubFileName || e.MovieReleaseName || (format === 'ass' ? 'OS_Legacy_Ara_ASS' : 'OS_Legacy_Ara_SRT'),
            _source: 'os_legacy',
            _site: 'os_legacy',
            _osFileId: String(e.IDSubtitleFile || extractOsFileId(link) || ''),
            _sig: e.SubHash || normalizeNameSig(e.SubFileName || link)
        });
    }
    const nSrt = out.filter(x => x.format === 'srt').length;
    console.log('[جلب عربي - OS Legacy] رجع ' + data.length + ' | بعد الفلترة: SRT=' + nSrt + ' ASS=' + (out.length - nSrt) + (LEGACY_DIRECT_LINK ? ' | رابط مباشر' : '') + ' | الزمن ' + sec(Date.now() - tStart));
    return out;
}
async function fetchOsMirrorArabic(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? [imdbId, season, episode || 1].join(':') : imdbId;
    try {
        const response = await axios.get('https://opensubtitles-v3.strem.io/subtitles/' + mediaType + '/' + targetId + '.json', {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' },
            timeout: 3200
        });
        const data = response.data || {};
        return (data.subtitles || [])
            .filter(s => (s.lang || '').toLowerCase().startsWith('ar') && s.url)
            .map((s, idx) => {
                const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();
                const rawUrl = (s.url || '').toLowerCase();
                const fileId = extractOsFileId(s.url) || String(s.id || (idx + 1));
                const rawName = s.SubFileName || s.title || s.name || ('OS_Mirror_Ara_' + fileId);
                const isAss = subFormat === 'ssa' || subFormat === 'ass' || assFileRe.test(rawUrl) || assFileRe.test(rawName);
                return {
                    url: s.url,
                    format: isAss ? 'ass' : 'srt',
                    fileName: rawName,
                    _source: 'opensubtitles',
                    _site: 'opensubtitles',
                    _osFileId: fileId,
                    _sig: fileId || cleanPath(s.url)
                };
            });
    } catch (e) {
        console.log('[جلب عربي - OS Mirror] فشل: ' + e.message);
        return [];
    }
}
function isCleanArabicSrtText(text, cues) {
    if (!text || !Array.isArray(cues) || cues.length < 10) {
        return { ok: false, reason: 'cues=' + (cues ? cues.length : 0) };
    }
    const cuesText = cues.map(c => c.text || '').join(' ').replace(/\{[^}]*\}|<[^>]*>/g, '');
    const arabicCount = (cuesText.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicCount < 150) {
        return { ok: false, reason: 'arabic=' + arabicCount };
    }
    const replacementCount = (cuesText.match(/\uFFFD/g) || []).length;
    const mojibakeCount = (cuesText.match(/[\u00C0-\u00FF]/g) || []).length;
    if (replacementCount > 5 || mojibakeCount > 15 || mojibakeCount > arabicCount * 0.05) {
        return { ok: false, reason: 'ترميز ويندوز معطوب' };
    }
    return { ok: true, cuesText };
}
function detectAssContent(text, item) {
    if (item && item.format === 'ass') return true;
    const fName = (item && (item.fileName || item.title || item.url)) || '';
    if (assFileRe.test(fName)) return true;
    if (!text) return false;
    return /^\s*Dialogue:/im.test(text) || /\[Events\]/i.test(text) || /\[Script Info\]/i.test(text);
}
// rec: دالة اختيارية تستقبل نتيجة الفحص (للإحصاءات واللوغ فقط)
async function verifyArabicSub(s, subsourceKey, epInfo = null, rec = null) {
    let timer;
    const t0 = Date.now();
    const done = (outcome, detail) => {
        if (rec) rec({ s, outcome, detail: detail || '', ms: Date.now() - t0, startAt: t0, endAt: Date.now() });
    };
    const isTestOs = OSCOM_TEST && s._site === 'oscom';
    const verifyTimeout = isTestOs ? OSCOM_TEST_TIMEOUT : VERIFY_TIMEOUT_MS;
    try {
        const { extractCuesUniversal } = require('./ai').shared;
        const effectiveEpInfo = s._epOverride || resolveEpInfoForUrl(s.url, epInfo);
        const primaryRawKey = makeRawKey(s.url, epInfo);
        const effectiveRawKey = makeRawKey(s.url, effectiveEpInfo);
        let text = isTestOs ? null : (getRawCache(primaryRawKey) || getRawCache(effectiveRawKey));
        if (!text) {
            text = await Promise.race([
                loadSubText(s.url, subsourceKey, effectiveEpInfo),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), verifyTimeout); })
            ]);
        }
        if (!text || !String(text).trim()) { done('empty'); return null; }
        const cacheBoth = txt => {
            setRawCache(primaryRawKey, txt);
            if (effectiveRawKey !== primaryRawKey) setRawCache(effectiveRawKey, txt);
        };
        if (detectAssContent(text, s)) {
            cacheBoth(text);
            done('ok_ass');
            return { ...s, format: 'ass', _verified: true };
        }
        const cues = extractCuesUniversal(text);
        const check = isCleanArabicSrtText(text, cues);
        if (!check.ok) {
            s._bad = true;
            done('bad', check.reason);
            return null;
        }
        const sig = crypto.createHash('md5')
            .update(check.cuesText.replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        cacheBoth(text);
        done('ok_srt');
        return { ...s, format: 'srt', _sig: sig, _verified: true };
    } catch (e) {
        const msg = (e && e.message) || 'خطأ';
        done(msg === 'timeout' ? 'timeout' : 'error', msg);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
async function getRawArabicSubContent(targetUrl, subsourceKey, epInfo = null) {
    const effectiveEpInfo = resolveEpInfoForUrl(targetUrl, epInfo);
    const primaryKey = makeRawKey(targetUrl, epInfo);
    const effectiveKey = makeRawKey(targetUrl, effectiveEpInfo);
    // في وضع الاختبار روابط OS.com تتجاوز الكاش حتى يظهر زمن التحميل الحقيقي في اللوغ
    const skipCache = OSCOM_TEST && !!isOsComUrl(targetUrl);
    const cached = skipCache ? null : (getRawCache(primaryKey) || getRawCache(effectiveKey));
    if (cached) return cached;
    const text = await loadSubText(targetUrl, subsourceKey, effectiveEpInfo);
    if (!text || !String(text).trim()) {
        throw new Error('ملف الترجمة فارغ');
    }
    setRawCache(primaryKey, text);
    if (effectiveKey !== primaryKey) setRawCache(effectiveKey, text);
    return text;
}
// ---------- إحصاءات الفحص (لوغ فقط) ----------
function summarizeVerify(candidates, events, cutoffAt) {
    const sites = {};
    const get = k => sites[k] || (sites[k] = { cand: 0, fin: 0, okSrt: 0, okAss: 0, bad: {}, timeout: 0, error: 0, empty: 0, errs: {} });
    for (const c of candidates) get(c._site || c._source || '?').cand++;
    for (const ev of events) {
        if (cutoffAt && ev.endAt > cutoffAt) continue;
        const o = get(ev.s._site || ev.s._source || '?');
        o.fin++;
        if (ev.outcome === 'ok_srt') o.okSrt++;
        else if (ev.outcome === 'ok_ass') o.okAss++;
        else if (ev.outcome === 'bad') {
            const r = String(ev.detail || '?').split('=')[0];
            o.bad[r] = (o.bad[r] || 0) + 1;
        } else if (ev.outcome === 'timeout') o.timeout++;
        else if (ev.outcome === 'error') {
            o.error++;
            const m = String(ev.detail || '?').slice(0, 45);
            o.errs[m] = (o.errs[m] || 0) + 1;
        } else if (ev.outcome === 'empty') o.empty++;
    }
    return Object.keys(sites).map(k => {
        const o = sites[k];
        const badTotal = Object.keys(o.bad).reduce((n, r) => n + o.bad[r], 0);
        const badTxt = badTotal ? ' (' + Object.keys(o.bad).map(r => r + ':' + o.bad[r]).join(',') + ')' : '';
        const errTxt = o.error ? ' (' + Object.keys(o.errs).map(m => m + ' x' + o.errs[m]).join(' ، ') + ')' : '';
        return k + ': مرشح ' + o.cand + ' | انتهى ' + o.fin + ' | تأخر/معلق ' + (o.cand - o.fin)
            + ' | SRT سليم=' + o.okSrt + ' ASS=' + o.okAss
            + ' | تالف=' + badTotal + badTxt
            + ' | مهلة=' + o.timeout + ' | خطأ=' + o.error + errTxt + ' | فارغ=' + o.empty;
    });
}
function logVerifySummary(title, candidates, events, cutoffAt) {
    if (!candidates.length) return;
    console.log('[جلب عربي - فحص] ' + title);
    for (const line of summarizeVerify(candidates, events, cutoffAt)) console.log('[جلب عربي - فحص]   ' + line);
}
function runFastParallelCheck(candidates, subsourceKey, epInfo, windowMs) {
    const verified = [];
    const events = [];
    let windowEndAt = null;
    let done = false, timer, resolveWindow;
    const windowPromise = new Promise(r => { resolveWindow = r; });
    const finish = () => {
        if (done) return;
        done = true;
        windowEndAt = Date.now();
        clearTimeout(timer);
        resolveWindow();
    };
    const rec = ev => {
        events.push(ev);
        if (OSCOM_TEST && ev.s._site === 'oscom') {
            console.log('[فحص OS.com] ملف ' + (ev.s._osFileId || '?')
                + ' | بدأ ' + clk(ev.startAt) + ' UTC | انتهى ' + clk(ev.endAt) + ' UTC | المدة ' + sec(ev.ms)
                + ' | ' + ev.outcome + (ev.detail ? ' (' + ev.detail + ')' : '')
                + ' | ' + String(ev.s.fileName || '').slice(0, 60));
        }
    };
    const base = { verified, events, getWindowEnd: () => windowEndAt };
    if (!candidates.length) {
        finish();
        return { ...base, windowPromise, allPromise: Promise.resolve() };
    }
    timer = setTimeout(finish, windowMs);
    let idx = 0;
    const workerCount = Math.min(CONCURRENCY_LIMIT, candidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (idx < candidates.length) {
            const item = candidates[idx++];
            if (!item) continue;
            try {
                const res = await verifyArabicSub(item, subsourceKey, epInfo, rec);
                if (res) verified.push(res);
            } catch {
            }
        }
    });
    const allPromise = Promise.all(workers).then(finish);
    return { ...base, windowPromise, allPromise };
}
function lightweightPreFilter(list, siteKey) {
    const assList = [];
    const srtList = [];
    const drops = { noUrl: 0, rar: 0, dupUrl: 0, dupId: 0, dupName: 0 };
    const seenUrls = new Set();
    const seenFileIds = new Set();
    const seenNames = new Set();
    const ordered = siteKey === 'subdl'
        ? [
            ...list.filter(x => x && x.url && !String(x.url).includes('strem.top')),
            ...list.filter(x => x && x.url && String(x.url).includes('strem.top'))
        ]
        : list;
    for (const raw of ordered) {
        if (!raw || !raw.url) { drops.noUrl++; continue; }
        const urlStr = String(raw.url);
        if (rarFileRe.test(urlStr)) { drops.rar++; continue; }
        const item = {
            ...raw,
            _source: raw._source || siteKey,
            _site: siteKey
        };
        const isAss = item.format === 'ass' || assFormatRe.test(item.subFormat || '') || assFileRe.test(item.fileName || item.title || urlStr);
        if (isAss) {
            assList.push({ ...item, format: 'ass' });
            continue;
        }
        const cleanU = cleanPath(urlStr);
        if (seenUrls.has(cleanU)) { drops.dupUrl++; continue; }
        if (item._osFileId) {
            if (seenFileIds.has(item._osFileId)) { drops.dupId++; continue; }
            seenFileIds.add(item._osFileId);
        }
        seenUrls.add(cleanU);
        const nameKey = normalizeNameSig(item.fileName || item.title || '');
        if (nameKey && nameKey.length > 6 && seenNames.has(nameKey) && srtList.length >= MAX_SRT_PER_SITE) {
            drops.dupName++;
            continue;
        }
        if (nameKey) seenNames.add(nameKey);
        const uniqueSig = item._sig || item._osFileId || cleanU;
        srtList.push({ ...item, format: 'srt', _sig: uniqueSig });
    }
    return { assList, srtList, drops };
}
function logPreFilter(name, rawList, pre) {
    const dropped = rawList.length - pre.assList.length - pre.srtList.length;
    const d = pre.drops;
    const parts = [];
    if (d.noUrl) parts.push('بلا رابط=' + d.noUrl);
    if (d.rar) parts.push('rar/7z=' + d.rar);
    if (d.dupUrl) parts.push('رابط مكرر=' + d.dupUrl);
    if (d.dupId) parts.push('ملف مكرر=' + d.dupId);
    if (d.dupName) parts.push('اسم مكرر=' + d.dupName);
    console.log('[جلب عربي - فلترة] ' + name + ': دخل ' + rawList.length + ' → SRT=' + pre.srtList.length + ' ASS=' + pre.assList.length
        + ' | محذوف ' + dropped + (parts.length ? ' (' + parts.join(' ، ') + ')' : ''));
}
function buildFinalArabicLists({ legacyPre, osPre, subdlPre, subsourcePre, oscomPre, verifiedZipItems }) {
    const verifiedUrls = new Set();
    for (const v of verifiedZipItems) {
        if (v && v.url) verifiedUrls.add(cleanPath(v.url));
    }
    function collectSiteAss(siteKey, preAssList) {
        const out = [];
        const seen = new Set();
        for (const v of verifiedZipItems) {
            if (!v || v._site !== siteKey || v.format !== 'ass') continue;
            const u = cleanPath(v.url);
            if (seen.has(u)) continue;
            seen.add(u);
            out.push(v);
        }
        for (const a of preAssList) {
            const u = cleanPath(a.url);
            if (seen.has(u) || verifiedUrls.has(u)) continue;
            seen.add(u);
            out.push(a);
        }
        return out;
    }
    function collectSiteSrt(siteKey, preSrtList) {
        const out = [];
        const seenSigs = new Set();
        const seenCleanUrls = new Set();
        const seenOsIds = new Set();
        const siteVerifiedSrt = verifiedZipItems.filter(v => v && v._site === siteKey && v.format === 'srt');
        for (const v of siteVerifiedSrt) {
            if (out.length >= MAX_SRT_PER_SITE) break;
            const uKey = cleanPath(v.url);
            const sKey = v._sig || uKey;
            const osId = v._osFileId || '';
            if (seenCleanUrls.has(uKey) || seenSigs.has(sKey) || (osId && seenOsIds.has(osId))) continue;
            seenCleanUrls.add(uKey);
            seenSigs.add(sKey);
            if (osId) seenOsIds.add(osId);
            out.push(v);
        }
        for (const p of preSrtList) {
            if (out.length >= MAX_SRT_PER_SITE) break;
            const uKey = cleanPath(p.url);
            if (verifiedUrls.has(uKey)) continue;
            const sKey = p._sig || uKey;
            const osId = p._osFileId || '';
            if (seenCleanUrls.has(uKey) || seenSigs.has(sKey) || (osId && seenOsIds.has(osId))) continue;
            seenCleanUrls.add(uKey);
            seenSigs.add(sKey);
            if (osId) seenOsIds.add(osId);
            out.push(p);
        }
        return out;
    }
    // الأولوية: SubDL ثم Subsource ثم البقية (OS Mirror ثم OS Legacy ثم OS.com)
    // داخل كل موقع: المفحوص أولاً ثم الباقي
    const allAss = [
        ...collectSiteAss('subdl', subdlPre.assList),
        ...collectSiteAss('subsource', subsourcePre.assList),
        ...collectSiteAss('opensubtitles', osPre.assList),
        ...collectSiteAss('os_legacy', legacyPre.assList),
        ...collectSiteAss('oscom', oscomPre.assList)
    ];
    const subdlSrt = collectSiteSrt('subdl', subdlPre.srtList);
    const subsourceSrt = collectSiteSrt('subsource', subsourcePre.srtList);
    const osSrt = collectSiteSrt('opensubtitles', osPre.srtList);
    const legacySrt = collectSiteSrt('os_legacy', legacyPre.srtList);
    const oscomSrt = collectSiteSrt('oscom', oscomPre.srtList);
    const readySrt = [...subdlSrt, ...subsourceSrt, ...osSrt, ...legacySrt, ...oscomSrt];
    // المصحح ياخذ أول النتائج بالأولوية (نفسها تظهر أيضاً في الجاهز)، ويتجاوز الملفات التالفة المؤكدة
    const seenCorr = new Set();
    const correctorSrt = [];
    for (const c of readySrt) {
        const u = cleanPath(c.url);
        if (c._bad || seenCorr.has(u)) continue;
        seenCorr.add(u);
        correctorSrt.push(c);
        if (correctorSrt.length >= CORRECTOR_MAX) break;
    }
    return {
        ass: allAss,
        srt: readySrt,
        correctorSrt,
        counts: {
            ass: allAss.length,
            subdlSrt: subdlSrt.length,
            subsourceSrt: subsourceSrt.length,
            osSrt: osSrt.length,
            legacySrt: legacySrt.length,
            oscomSrt: oscomSrt.length
        }
    };
}
async function fetchAllSourcesOnce({ imdbId, season, episode, type, subdlKey, subsourceKey }, label = 'أساسي') {
    const sourceDefs = [
        { key: 'os_legacy', name: 'OS Legacy', run: () => fetchOsLegacyArabic(imdbId, season, episode) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type) },
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) },
        { key: 'oscom', name: 'OS.com', run: () => getOsCom({ imdbId, season, episode }) }
    ];
    const tAll = Date.now();
    const timings = {};
    const settled = await Promise.allSettled(
        sourceDefs.map(d => {
            const t0 = Date.now();
            const p = withTimeout(Promise.resolve().then(d.run), SOURCE_TIMEOUTS[d.key], d.name);
            const mark = () => { timings[d.key] = Date.now() - t0; };
            p.then(mark, mark);
            return p;
        })
    );
    const getList = idx => (settled[idx].status === 'fulfilled' && Array.isArray(settled[idx].value) ? settled[idx].value : []);
    const line = sourceDefs.map((d, i) => {
        const ms = timings[d.key] || 0;
        const capped = ms >= SOURCE_TIMEOUTS[d.key] - 50;
        return d.key + ' ' + sec(ms) + '=' + getList(i).length + (capped ? ' ⏱سقف' : '');
    }).join(' | ');
    console.log('[جلب عربي - توقيت المصادر ' + label + '] ' + line + ' | الكلي ' + sec(Date.now() - tAll));
    return {
        osLegacyList: getList(0),
        osMirrorList: getList(1),
        subdlRawList: getList(2),
        subsourceRawList: getList(3),
        oscomRawList: getList(4)
    };
}
async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const tReq = Date.now();
    const rawKeysStr = [subdlKey || '', subsourceKey || ''].join('|');
    const keyHash = crypto.createHash('md5').update(rawKeysStr).digest('hex').slice(0, 8);
    const cacheKey = [imdbId, season, episode, keyHash].join(':');
    const hit = resultCache.get(cacheKey);
    // في وضع الاختبار نتجاوز كاش النتائج حتى يرجع الجلب والفحص الحقيقي كل مرة
    if (!OSCOM_TEST && hit && Date.now() - hit.time < RESULT_TTL) {
        console.log('[جلب عربي] النتيجة من كاش الطلبات (' + sec(Date.now() - tReq) + ')');
        return hit.value;
    }
    let { osLegacyList, osMirrorList, subdlRawList, subsourceRawList, oscomRawList } = await fetchAllSourcesOnce({
        imdbId, season, episode, type, subdlKey, subsourceKey
    });
    const totalInitial = osLegacyList.length + osMirrorList.length + subdlRawList.length + subsourceRawList.length;
    if (season != null && parseInt(season, 10) > 1 && totalInitial < 2) {
        const absEp = await getAbsoluteEpisodeNumber(imdbId, season, episode);
        if (absEp) {
            console.log('[ترقيم مطلق 🔄] الموسم ' + season + ' الحلقة ' + episode + ' لم يرجع ترجمات كافية (' + totalInitial + '). جاري البحث بالرقم المطلق: الموسم 1 الحلقة ' + absEp + '...');
            const absOverride = { season: '1', episode: String(absEp) };
            const absRes = await fetchAllSourcesOnce({
                imdbId, season: 1, episode: absEp, type, subdlKey, subsourceKey
            }, 'ترقيم مطلق');
            const tagAbs = list => list.map(item => {
                if (item && item.url) rememberUrlEpOverride(item.url, absOverride);
                return { ...item, _epOverride: absOverride };
            });
            osLegacyList = [...osLegacyList, ...tagAbs(absRes.osLegacyList)];
            osMirrorList = [...osMirrorList, ...tagAbs(absRes.osMirrorList)];
            subdlRawList = [...subdlRawList, ...tagAbs(absRes.subdlRawList)];
            subsourceRawList = [...subsourceRawList, ...tagAbs(absRes.subsourceRawList)];
            oscomRawList = [...oscomRawList, ...tagAbs(absRes.oscomRawList)];
        }
    }
    const tSources = Date.now() - tReq;
    const legacyPre = lightweightPreFilter(osLegacyList, 'os_legacy');
    const osPre = lightweightPreFilter(osMirrorList, 'opensubtitles');
    const subdlPre = lightweightPreFilter(subdlRawList, 'subdl');
    const subsourcePre = lightweightPreFilter(subsourceRawList, 'subsource');
    const oscomPre = lightweightPreFilter(oscomRawList, 'oscom');
    logPreFilter('os_legacy', osLegacyList, legacyPre);
    logPreFilter('opensubtitles', osMirrorList, osPre);
    logPreFilter('subdl', subdlRawList, subdlPre);
    logPreFilter('subsource', subsourceRawList, subsourcePre);
    logPreFilter('oscom', oscomRawList, oscomPre);
    const usableCount = [legacyPre, osPre, subdlPre, subsourcePre]
        .reduce((n, p) => n + p.assList.length + p.srtList.length, 0);
    const oscomIsBackup = usableCount === 0;
    if (!OSCOM_TEST && oscomIsBackup && oscomPre.assList.length + oscomPre.srtList.length > 0) {
        console.log('[جلب عربي - OS.com] المواقع الأخرى ما رجعت أي نتيجة، فـ OS.com يشتغل كاحتياط (أفحص ' + (OSCOM_VERIFY_EACH * 2) + ' ملفات كحد أقصى).');
    }
    const zipCandidates = [];
    const subdlZips = [...subdlPre.assList, ...subdlPre.srtList.filter(x => !String(x.url).includes('strem.top'))].slice(0, 20);
    const subsourceZips = [...subsourcePre.assList, ...subsourcePre.srtList].slice(0, 20);
    const osZips = [...osPre.assList, ...osPre.srtList].slice(0, 20);
    const legacyZips = VERIFY_LEGACY ? [...legacyPre.assList, ...legacyPre.srtList].slice(0, 20) : [];
    let oscomZips;
    if (OSCOM_TEST) {
        const allOscom = [...oscomPre.assList, ...oscomPre.srtList];
        oscomZips = OSCOM_TEST_MAX > 0 ? allOscom.slice(0, OSCOM_TEST_MAX) : allOscom;
        console.log('[جلب عربي - OS.com] وضع الاختبار: سأفحص ' + oscomZips.length + ' ملف من ' + allOscom.length + ' (ASS=' + oscomPre.assList.length + ' SRT=' + oscomPre.srtList.length + ') بدون سقف زمني، وأنتظر نهاية الفحص كاملاً.');
    } else {
        oscomZips = oscomIsBackup ? [...oscomPre.assList.slice(0, OSCOM_VERIFY_EACH), ...oscomPre.srtList.slice(0, OSCOM_VERIFY_EACH)] : [];
    }
    const maxZips = Math.max(subdlZips.length, subsourceZips.length, osZips.length, legacyZips.length, oscomZips.length);
    for (let i = 0; i < maxZips; i++) {
        if (subdlZips[i]) zipCandidates.push(subdlZips[i]);
        if (subsourceZips[i]) zipCandidates.push(subsourceZips[i]);
        if (osZips[i]) zipCandidates.push(osZips[i]);
        if (legacyZips[i]) zipCandidates.push(legacyZips[i]);
        if (oscomZips[i]) zipCandidates.push(oscomZips[i]);
    }
    const epInfo = (season != null && episode != null) ? { season, episode } : null;
    const tVerify0 = Date.now();
    const job = runFastParallelCheck(zipCandidates, subsourceKey, epInfo, FAST_VERIFY_WINDOW_MS);
    await job.windowPromise;
    const tVerify = Date.now() - tVerify0;
    const windowEnd = job.getWindowEnd() || Date.now();
    logVerifySummary('داخل النافذة (' + sec(tVerify) + ')', zipCandidates, job.events, windowEnd);
    const snapshot = job.verified.slice();
    const value = buildFinalArabicLists({ legacyPre, osPre, subdlPre, subsourcePre, oscomPre, verifiedZipItems: snapshot });
    if (value.ass.length > 0 || value.srt.length > 0) {
        setResultCache(cacheKey, value);
    }
    const total = Date.now() - tReq;
    console.log('[جلب عربي] الزمن الكلي ' + sec(total) + ' (مصادر ' + sec(tSources) + ' + فحص ' + sec(tVerify) + ')'
        + (total > TOTAL_WARN_MS ? ' ⚠️ تجاوز ' + sec(TOTAL_WARN_MS) : ' ✅'));
    job.allPromise.then(() => {
        if (job.events.some(ev => ev.endAt > windowEnd)) {
            logVerifySummary('النهائي بعد انتهاء كل الفحوصات المتأخرة (' + sec(Date.now() - tVerify0) + ')', zipCandidates, job.events, null);
        }
        if (job.verified.length > snapshot.length) {
            const updated = buildFinalArabicLists({ legacyPre, osPre, subdlPre, subsourcePre, oscomPre, verifiedZipItems: job.verified });
            setResultCache(cacheKey, updated);
        }
    }).catch(() => {});
    return value;
}
