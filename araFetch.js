// araFetch.js
const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');

module.exports = { getArabicSubsForCorrection, getRawArabicSubContent };

const cleanPath = p => String(p || '').split('?')[0];

const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];

// ============================================================
// إعدادات الأزمنة والحدود (متوافقة مع Render ومنع التايم آوت)
// ============================================================
const SOURCE_TIMEOUTS = { os_legacy: 4500, os_mirror: 4000, subdl: 5000, subsource: 5000 };

// 5 ثوانٍ صافية كحد أقصى لفحص واستخراج ملفات ZIP و ASS قبل إرسال القائمة للمشغل
const VERIFY_WINDOW_MS = 5000;

// أقصى زمن لتحميل وفك ضغط ملف واحد
const VERIFY_TIMEOUT_MS = 8000;

// عدد الفحوصات المتوازية في نفس اللحظة
const CONCURRENCY_LIMIT = 10;

// الحد الأقصى لإجمالي الروابط المفحوصة للعمل الواحد
const MAX_CANDIDATES = 120;

const RESULT_TTL = 30 * 60 * 1000;
const MAX_RESULT_CACHE = 100;
const resultCache = new Map();

// كاش للنصوص العربية المستخرجة لتعمل الترجمات الجاهزة فوراً (0 ثانية انتظار)
const MAX_RAW_CACHE = 150;
const rawTextCache = new Map();

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

const assFormatRe = /^(ass|ssa)$/i;
const assFileRe = /\.(ass|ssa)\b/i;

async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;

    const primaryUrl = hasSE
        ? 'https://rest.opensubtitles.org/search/episode-' + episode + '/imdbid-' + numericId + '/season-' + season + '/sublanguageid-ara'
        : 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';

    async function fetchLegacyData(url) {
        let response;
        for (let i = 0; i < LEGACY_AGENTS.length; i++) {
            const ua = LEGACY_AGENTS[i];
            response = await fetch(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' }
            });
            const retryNote = i > 0 ? ' (محاولة ثانية: ' + ua + ')' : '';
            console.log('[جلب عربي - OS Legacy] ' + response.status + retryNote + ' <- ' + url);
            if (response.status !== 403) break;
        }
        if (!response || !response.ok) return [];
        const json = await response.json();
        return Array.isArray(json) ? json : [];
    }

    const isAssEntry = r => assFormatRe.test(r.SubFormat || '') || assFileRe.test(r.SubFileName || '');

    try {
        let data = await fetchLegacyData(primaryUrl);

        if (hasSE && !data.some(isAssEntry)) {
            const fallbackUrl = 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';
            const fallbackData = await fetchLegacyData(fallbackUrl);
            const epNum = parseInt(episode, 10);
            const epRe = new RegExp('(?:e|ep|episode)[._ -]*0*' + epNum + '(?:[^0-9]|$)', 'i');
            data = [...data, ...fallbackData.filter(r => isAssEntry(r) && epRe.test(r.SubFileName || ''))];
        }

        const total = data.length;
        const assOnly = data.filter(e => e.SubDownloadLink && isAssEntry(e)).map(e => ({
            url: e.SubDownloadLink,
            format: 'ass',
            fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
            _source: 'os_legacy'
        }));
        console.log('[جلب عربي - OS Legacy] رجع ' + total + ' نتيجة، المعتمد ASS فقط: ' + assOnly.length + ' (الـ SRT مستبعد).');
        return assOnly;
    } catch (e) {
        console.log('[جلب عربي - OS Legacy] خطأ: ' + e.message);
        return [];
    }
}

async function fetchOsMirrorArabic(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? [imdbId, season, episode || 1].join(':') : imdbId;

    try {
        const response = await axios.get('https://opensubtitles-v3.strem.io/subtitles/' + mediaType + '/' + targetId + '.json', {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' },
            timeout: 4000
        });

        const data = response.data || {};
        const out = (data.subtitles || [])
            .filter(s => (s.lang || '').toLowerCase().startsWith('ar') && s.url)
            .map(s => {
                const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();
                const rawUrl = (s.url || '').toLowerCase();
                const isAss = subFormat === 'ssa' || subFormat === 'ass' || /\.(ass|ssa)/.test(rawUrl);
                return {
                    url: s.url,
                    format: isAss ? 'ass' : 'srt',
                    fileName: s.SubFileName || s.title || s.name || 'OS_Mirror_Ara',
                    _source: 'os_mirror'
                };
            });
        console.log('[جلب عربي - OS Mirror] ' + out.length + ' ترجمة عربية.');
        return out;
    } catch (e) {
        console.log('[جلب عربي - OS Mirror] فشل: ' + e.message);
        return [];
    }
}

function isCleanArabicText(text, cues) {
    if (!text || !Array.isArray(cues) || cues.length < 10) {
        return { ok: false, reason: 'cues=' + (cues ? cues.length : 0) };
    }

    const cuesText = cues.map(c => c.text || '').join(' ').replace(/\{[^}]*\}|<[^>]*>/g, '');
    const arabicCount = (cuesText.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicCount < 200) {
        return { ok: false, reason: 'arabic=' + arabicCount };
    }

    // فحص حروف ويندوز المعطوبة (Mojibake / رموز الاستبدال غير المفهومة)
    const replacementCount = (cuesText.match(/\uFFFD/g) || []).length;
    const mojibakeCount = (cuesText.match(/[\u00C0-\u00FF]/g) || []).length;

    if (replacementCount > 5 || mojibakeCount > 15 || mojibakeCount > arabicCount * 0.05) {
        return { ok: false, reason: 'ترميز ويندوز معطوب (mojibake=' + mojibakeCount + ', replacement=' + replacementCount + ')' };
    }

    return { ok: true, cuesText };
}

async function verifyArabicSub(s, subsourceKey, epInfo = null) {
    let timer;
    try {
        const { fetchAndExtractSub, extractCuesUniversal } = require('./ai').shared;
        const rawKey = makeRawKey(s.url, epInfo);
        let text = getRawCache(rawKey);

        if (!text) {
            text = await Promise.race([
                fetchAndExtractSub(s.url, subsourceKey, epInfo),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), VERIFY_TIMEOUT_MS); })
            ]);
        }

        const cues = extractCuesUniversal(text);
        const check = isCleanArabicText(text, cues);
        if (!check.ok) {
            console.log('[فحص عربي] ✗ ' + s._source + ': مستبعد (' + check.reason + ') <- ' + s.url);
            return null;
        }

        const sig = crypto.createHash('md5')
            .update(check.cuesText.replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        const realFormat = /^\s*Dialogue:/im.test(text) ? 'ass' : 'srt';

        setRawCache(rawKey, text);
        return { ...s, format: realFormat, _sig: sig };
    } catch (e) {
        console.log('[فحص عربي] ✗ ' + s._source + ': ' + e.message + ' <- ' + s.url);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function getRawArabicSubContent(targetUrl, subsourceKey, epInfo = null) {
    const rawKey = makeRawKey(targetUrl, epInfo);
    const cached = getRawCache(rawKey);
    if (cached) return cached;

    const { fetchAndExtractSub, extractCuesUniversal } = require('./ai').shared;
    const text = await fetchAndExtractSub(targetUrl, subsourceKey, epInfo);
    const cues = extractCuesUniversal(text);
    const check = isCleanArabicText(text, cues);
    if (!check.ok) throw new Error('ملف الترجمة غير صالح (' + check.reason + ')');

    setRawCache(rawKey, text);
    return text;
}

function startVerification(list, subsourceKey, epInfo, windowMs) {
    const results = [];
    let done = false, hardTimer, resolveEarly;
    const early = new Promise(r => { resolveEarly = r; });

    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        resolveEarly();
    };

    if (!list.length) {
        finish();
        return { results, early, all: Promise.resolve() };
    }

    hardTimer = setTimeout(finish, windowMs);

    let idx = 0;
    const workerCount = Math.min(CONCURRENCY_LIMIT, list.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (idx < list.length) {
            const current = list[idx++];
            if (!current) continue;
            try {
                const r = await verifyArabicSub(current, subsourceKey, epInfo);
                if (r) results.push(r);
            } catch {
                // ignore individual failure
            }
        }
    });

    const all = Promise.all(workers).then(finish);
    return { results, early, all };
}

const SOURCE_ORDER = { subdl: 0, subsource: 1, os_legacy: 2, os_mirror: 3 };
const sourceRank = s => (SOURCE_ORDER[s._source] ?? 9);

function buildValue(verified) {
    const sorted = verified.slice().sort((a, b) => {
        if (a.format !== b.format) return a.format === 'ass' ? -1 : 1;
        return sourceRank(a) - sourceRank(b);
    });

    const seenSig = new Set();
    const good = sorted.filter(s => {
        const key = [s.format, s._sig].join(':');
        if (seenSig.has(key)) return false;
        seenSig.add(key);
        return true;
    });

    return {
        good,
        value: {
            srt: good.filter(s => s.format === 'srt'),
            ass: good.filter(s => s.format === 'ass')
        }
    };
}

function setResultCache(key, value) {
    if (resultCache.size >= MAX_RESULT_CACHE && !resultCache.has(key)) {
        const oldestKey = resultCache.keys().next().value;
        if (oldestKey) resultCache.delete(oldestKey);
    }
    resultCache.set(key, { time: Date.now(), value });
}

async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const t0 = Date.now();
    console.log('[جلب عربي] جاري البحث عن ترجمات عربية (جاهزة + مصحح) للعمل: ' + imdbId + '...');

    const rawKeysStr = [subdlKey || '', subsourceKey || ''].join('|');
    const keyHash = crypto.createHash('md5').update(rawKeysStr).digest('hex').slice(0, 8);
    const cacheKey = [imdbId, season, episode, keyHash].join(':');
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.time < RESULT_TTL) {
        console.log('[جلب عربي] النتيجة من الكاش.');
        return hit.value;
    }

    const sourceDefs = [
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) },
        { key: 'os_legacy', name: 'OS Legacy (ASS)', run: () => fetchOsLegacyArabic(imdbId, season, episode) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type) }
    ];
    const names = sourceDefs.map(d => d.name);

    const settled = await Promise.allSettled(
        sourceDefs.map(d => withTimeout(Promise.resolve().then(d.run), SOURCE_TIMEOUTS[d.key], d.name))
    );

    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.log('[جلب عربي - ' + names[i] + '] خطأ غير متوقع: ' + (r.reason && r.reason.message));
        }
    });

    const summaryStr = settled.map((r, i) => names[i] + '=' + (r.status === 'fulfilled' ? r.value.length : 'خطأ')).join(' | ');
    console.log('[جلب عربي] ملخص المصادر: ' + summaryStr + ' (بعد ' + ((Date.now() - t0) / 1000).toFixed(1) + ' ثانية)');

    const lists = settled.map((r, i) => {
        if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return [];
        const srcKey = sourceDefs[i].key;
        return r.value.map(item => (item && !item._source ? { ...item, _source: srcKey } : item));
    });

    const interleaved = [];
    const maxLen = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
        for (const l of lists) {
            if (l[i]) interleaved.push(l[i]);
        }
    }

    const seenUrls = new Set();
    const uniqueSubs = interleaved.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    const toVerify = uniqueSubs.slice(0, MAX_CANDIDATES);
    const epInfo = (season != null && episode != null) ? { season, episode } : null;

    const job = startVerification(toVerify, subsourceKey, epInfo, VERIFY_WINDOW_MS);
    await job.early;

    const snapshot = job.results.slice();
    const { good, value } = buildValue(snapshot);
    console.log('[جلب عربي] الشغالة حسب المصدر: ' + good.map(s => s._source + '/' + s.format).join(' | '));
    console.log('[جلب عربي] بعد الفحص: ' + snapshot.length + '/' + toVerify.length + ' شغالة، ' + good.length + ' بعد حذف المكرر -> ' + value.ass.length + ' ASS و ' + value.srt.length + ' SRT - الزمن الكلي ' + ((Date.now() - t0) / 1000).toFixed(1) + ' ثانية.');

    if (good.length > 0) setResultCache(cacheKey, value);

    job.all.then(() => {
        if (job.results.length > snapshot.length) {
            const full = buildValue(job.results);
            if (full.good.length > 0) {
                setResultCache(cacheKey, full.value);
                console.log('[جلب عربي] تحديث الكاش بالخلفية: ' + full.value.ass.length + ' ASS و ' + full.value.srt.length + ' SRT (كانت ' + (value.ass.length + value.srt.length) + ').');
            }
        }
    }).catch(() => {});

    return value;
}
