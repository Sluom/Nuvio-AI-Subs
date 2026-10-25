const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');
const { getOsCom, isOsComUrl, downloadOsComText } = require('./oscom');
const { hasEgyptianSpelling } = require('./arabic-spelling');

module.exports = { getArabicSubsForCorrection, getRawArabicSubContent, resolveEpInfoForUrl };

const cleanPath = p => String(p || '').split('?')[0];
const LEGACY_AGENTS = ['TemporaryUserAgent', 'VLSub 0.10.3'];

// إعدادات الوضع السريع (المباشر للمستخدم - سقف ~5 ثوانٍ)
const SOURCE_TIMEOUTS = { os_legacy: 4500, os_mirror: 3200, subdl: 3800, subsource: 3800, oscom: 3500 };
const FAST_VERIFY_WINDOW_MS = 2800;
const VERIFY_TIMEOUT_MS = 2600;

// إعدادات الوضع العميق بالخلفية (Prefetch - يأخذ وقته الكامل بفك الضغط والتصفية)
const BG_SOURCE_TIMEOUTS = { os_legacy: 12000, os_mirror: 8000, subdl: 12000, subsource: 12000, oscom: 10000 };
const BG_VERIFY_WINDOW_MS = 35000;
const BG_VERIFY_TIMEOUT_MS = 10000;
const BG_MAX_ZIPS_PER_SITE = 35;

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

// كاشف SDH / HI من البيانات الوصفية أو اسم الملف
const HI_NAME_RE = /(?:^|[._\s\-\[\(])(sdh|hi|cc|deaf)(?=[._\s\-\]\)]|$)|hearing[\s._-]*impaired|closed[\s._-]*caption|ضعاف[\s._-]*السمع/i;
// كاشف المؤثرات الصوتية النصية داخل الأسطر مثل [موسيقى] أو (ضحك) أو ♪
const SDH_CUE_RE = /[♪♫]|^\s*[\[\(][^\]\)\n]{2,45}[\]\)]\s*$/;

function isHearingImpairedMeta(item) {
    if (!item) return false;
    if (item._isSdh === true || item.hearingImpaired === true || item.hi === true) return true;
    if (['1', 1, true].includes(item.SubHearingImpaired)) return true;
    return [item.fileName, item.title, item.origName, item.name, item.subtitleFileName, cleanPath(item.url)]
        .filter(Boolean)
        .some(f => HI_NAME_RE.test(String(f)));
}

function detectSdhInLines(lines) {
    if (!Array.isArray(lines) || lines.length < 15) return false;
    let sdhCount = 0;
    for (const l of lines) {
        const clean = String(l || '').replace(/\{[^}]*\}|<[^>]*>/g, '').trim();
        if (SDH_CUE_RE.test(clean)) sdhCount++;
    }
    return sdhCount >= 12 && (sdhCount / lines.length) >= 0.12;
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

function setResultCache(key, value, isComplete = false) {
    if (resultCache.size >= MAX_RESULT_CACHE && !resultCache.has(key)) {
        const oldestKey = resultCache.keys().next().value;
        if (oldestKey) resultCache.delete(oldestKey);
    }
    resultCache.set(key, { time: Date.now(), value, isComplete });
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

// توليد بصمة هيكلية ثابتة لاسم الإصدار (مع إعطاء الأولوية للترجمات غير الـ SDH أولاً)
function computeReleaseTemplateInfo(item) {
    const isSdh = isHearingImpairedMeta(item);
    const sdhRank = isSdh ? '1' : '0';

    const raw = String((item && (item.fileName || item.title || item.origName || item.name)) || '').trim();
    const fallbackUrl = cleanPath((item && item.url) || '').split('/').pop() || '';
    const base = (raw || fallbackUrl)
        .toLowerCase()
        .replace(/\.(srt|ass|ssa|sub|zip|gz|rar|7z)$/gi, '');

    const bracketMatch = base.match(/^\s*\[([^\]]+)\]/);
    const animeGroup = bracketMatch ? bracketMatch[1].replace(/\s+/g, '') : '';

    const stripped = base
        .replace(/\[[0-9a-f]{8}\]/gi, '')
        .replace(/\bs0*\d+[._\s-]*e0*\d+(?:[._\s-]*e?0*\d+)?\b/gi, '')
        .replace(/\b\d+x0*\d+\b/gi, '')
        .replace(/\b(?:season|s)[._\s-]*0*\d+\b/gi, '')
        .replace(/\b(?:episode|ep|e)[._\s-]*0*\d+(?:v\d+)?\b/gi, '')
        .replace(/(?:^|[._\s-\[\(])(sdh|hi|cc|deaf)(?=[._\s-\]\)]|$)/gi, ' ')
        .replace(/(?:^|[._\s-\[\(])0*\d{1,4}(?:v\d+)?(?=[._\s-\]\)]|$)/g, ' ');

    const sceneMatch = stripped.match(/-([a-z0-9]{2,15})$/i);
    const sceneGroup = sceneMatch ? sceneMatch[1].toLowerCase() : '';

    let sourceTier = 4;
    if (/\b(web[._\s-]*dl|webdl|amzn|nf|netflix|dsnp|atvp|hmax|cr|crunchyroll|b-global|hidive)\b/i.test(stripped)) {
        sourceTier = 1;
    } else if (/\b(web[._\s-]*rip|webrip|web)\b/i.test(stripped)) {
        sourceTier = 2;
    } else if (/\b(blu[._\s-]*ray|bdrip|brrip|remux)\b/i.test(stripped)) {
        sourceTier = 3;
    }

    const cleanTemplate = stripped.replace(/[^\p{L}\p{N}]+/gu, '');
    const groupKey = animeGroup || sceneGroup || '';
    const sortKey = [
        sdhRank,
        String(sourceTier),
        groupKey,
        cleanTemplate || fallbackUrl.toLowerCase()
    ].join('|');

    return { sortKey, sourceTier, groupKey, isSdh };
}

function sortByConsistentTemplate(list) {
    if (!Array.isArray(list) || list.length <= 1) return list;
    return list
        .map((item, idx) => ({ item, idx, tpl: computeReleaseTemplateInfo(item) }))
        .sort((a, b) => {
            if (a.tpl.sortKey < b.tpl.sortKey) return -1;
            if (a.tpl.sortKey > b.tpl.sortKey) return 1;
            return a.idx - b.idx;
        })
        .map(x => x.item);
}

async function fetchOsLegacyArabic(imdbId, season, episode, isPrefetch = false) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;
    const primaryUrl = hasSE
        ? 'https://rest.opensubtitles.org/search/episode-' + episode + '/imdbid-' + numericId + '/season-' + season + '/sublanguageid-ara'
        : 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const reqTimeout = isPrefetch ? 5500 : 2500;

    async function requestWithAgent(url, ua) {
        try {
            const response = await axios.get(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' },
                timeout: reqTimeout,
                validateStatus: () => true
            });
            if (!response || response.status < 200 || response.status >= 300) {
                console.log('[جلب عربي - OS Legacy (' + ua + ')] HTTP ' + (response ? response.status : 'بدون رد'));
                return [];
            }
            let json = response.data;
            if (typeof json === 'string') {
                try { json = JSON.parse(json); } catch { json = []; }
            }
            return Array.isArray(json) ? json : [];
        } catch (err) {
            console.log('[جلب عربي - OS Legacy (' + ua + ')] خطأ طلب: ' + err.message);
            return [];
        }
    }

    async function fetchLegacyData(url) {
        const firstPromise = requestWithAgent(url, LEGACY_AGENTS[0]);
        const secondPromise = sleep(1000).then(() => requestWithAgent(url, LEGACY_AGENTS[1]));
        const [firstResults, secondResults] = await Promise.all([firstPromise, secondPromise]);
        const combined = [];
        const seenIds = new Set();
        for (const item of [...firstResults, ...secondResults]) {
            if (!item || !item.SubDownloadLink) continue;
            const key = String(item.IDSubtitleFile || item.SubDownloadLink);
            if (seenIds.has(key)) continue;
            seenIds.add(key);
            combined.push(item);
        }
        return combined;
    }

    const legacyFormat = r => {
        const f = String(r.SubFormat || '').toLowerCase();
        const n = String(r.SubFileName || '').toLowerCase();
        if (assFormatRe.test(f) || assFileRe.test(n)) return 'ass';
        if (f === 'srt' || /\.srt$/.test(n)) return 'srt';
        return null;
    };

    try {
        let data = await fetchLegacyData(primaryUrl);
        if (hasSE && !data.some(r => legacyFormat(r) === 'ass')) {
            const fallbackUrl = 'https://rest.opensubtitles.org/search/imdbid-' + numericId + '/sublanguageid-ara';
            const fallbackData = await fetchLegacyData(fallbackUrl);
            const epNum = parseInt(episode, 10);
            const epRe = new RegExp('(?:e|ep|episode)[._ -]*0*' + epNum + '(?:[^0-9]|$)', 'i');
            data = [...data, ...fallbackData.filter(r => legacyFormat(r) === 'ass' && epRe.test(r.SubFileName || ''))];
        }
        const out = [];
        for (const e of data) {
            if (!e || !e.SubDownloadLink) continue;
            const format = legacyFormat(e);
            if (!format) continue;
            const link = String(e.SubDownloadLink);
            const fName = e.SubFileName || e.MovieReleaseName || (format === 'ass' ? 'OS_Legacy_Ara_ASS' : 'OS_Legacy_Ara_SRT');
            const isHi = ['1', 1, true].includes(e.SubHearingImpaired) || HI_NAME_RE.test(fName);
            out.push({
                url: LEGACY_DIRECT_LINK ? link.replace(/\.gz$/i, '') + '.' + format : link,
                format,
                fileName: fName,
                hearingImpaired: isHi,
                _isSdh: isHi,
                _source: 'os_legacy',
                _site: 'os_legacy',
                _osFileId: String(e.IDSubtitleFile || extractOsFileId(link) || ''),
                _sig: e.SubHash || normalizeNameSig(e.SubFileName || link)
            });
        }
        const nSrt = out.filter(x => x.format === 'srt').length;
        console.log('[جلب عربي - OS Legacy] رجع ' + data.length + ' | بعد الفلترة: SRT=' + nSrt + ' ASS=' + (out.length - nSrt) + (LEGACY_DIRECT_LINK ? ' | رابط مباشر' : ''));
        return out;
    } catch (e) {
        const why = e.code || (e.cause && (e.cause.code || e.cause.message)) || '';
        console.log('[جلب عربي - OS Legacy] خطأ: ' + e.message + (why ? ' | السبب: ' + why : ''));
        return [];
    }
}

async function fetchOsMirrorArabic(imdbId, season, episode, type, isPrefetch = false) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? [imdbId, season, episode || 1].join(':') : imdbId;
    try {
        const response = await axios.get('https://opensubtitles-v3.strem.io/subtitles/' + mediaType + '/' + targetId + '.json', {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' },
            timeout: isPrefetch ? 6500 : 3200
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
                const isHi = ['1', 1, true].includes(s.SubHearingImpaired) || s.hearingImpaired === true || HI_NAME_RE.test(rawName) || HI_NAME_RE.test(rawUrl);
                return {
                    url: s.url,
                    format: isAss ? 'ass' : 'srt',
                    fileName: rawName,
                    hearingImpaired: isHi,
                    _isSdh: isHi,
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
    const rawLines = cues.map(c => c.text || '');
    const cuesText = rawLines.join(' ').replace(/\{[^}]*\}|<[^>]*>/g, '');
    const arabicCount = (cuesText.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicCount < 150) {
        return { ok: false, reason: 'arabic=' + arabicCount };
    }
    const replacementCount = (cuesText.match(/\uFFFD/g) || []).length;
    const mojibakeCount = (cuesText.match(/[\u00C0-\u00FF]/g) || []).length;
    if (replacementCount > 5 || mojibakeCount > 15 || mojibakeCount > arabicCount * 0.05) {
        return { ok: false, reason: 'ترميز ويندوز معطوب' };
    }
    const isSdhContent = detectSdhInLines(rawLines);
    const isBadSpelling = hasEgyptianSpelling(cuesText, 7);
    return { ok: true, cuesText, isSdhContent, isBadSpelling };
}

function isCleanArabicAssText(text) {
    if (!text) return { ok: false, reason: 'empty' };
    const lines = String(text).split(/\r?\n/);
    const dialogueParts = [];
    for (const line of lines) {
        if (!/^\s*Dialogue:/i.test(line)) continue;
        const parts = line.split(',');
        const rawDiag = parts.length >= 10 ? parts.slice(9).join(',') : line;
        const cleaned = rawDiag
            .replace(/\{[^}]*\}/g, ' ')
            .replace(/\\[nNh]/g, ' ')
            .trim();
        if (cleaned) dialogueParts.push(cleaned);
    }
    if (dialogueParts.length < 8) {
        return { ok: false, reason: 'dialogues=' + dialogueParts.length };
    }
    const joined = dialogueParts.join(' ');
    const arabicCount = (joined.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicCount < 120) {
        return { ok: false, reason: 'arabic=' + arabicCount };
    }
    const replacementCount = (joined.match(/\uFFFD/g) || []).length;
    const mojibakeCount = (joined.match(/[\u00C0-\u00FF]/g) || []).length;
    if (replacementCount > 5 || mojibakeCount > 15 || mojibakeCount > arabicCount * 0.05) {
        return { ok: false, reason: 'ترميز معطوب' };
    }
    const normalizedForHash = joined.replace(/[^\p{L}\p{N}]+/gu, '');
    const sig = crypto.createHash('md5').update(normalizedForHash).digest('hex');
    const isSdhContent = detectSdhInLines(dialogueParts);
    const isBadSpelling = hasEgyptianSpelling(joined, 7);
    return { ok: true, sig, isSdhContent, isBadSpelling };
}

function detectAssContent(text, item) {
    if (!text) {
        if (item && item.format === 'ass') return true;
        const fName = (item && (item.fileName || item.title || item.url)) || '';
        return assFileRe.test(fName);
    }
    return /^\s*Dialogue:/im.test(text) || /\[Events\]/i.test(text) || /\[Script Info\]/i.test(text);
}

async function verifyArabicSub(s, subsourceKey, epInfo = null, verifyTimeoutMs = VERIFY_TIMEOUT_MS) {
    let timer;
    try {
        const { extractCuesUniversal } = require('./ai').shared;
        const effectiveEpInfo = s._epOverride || resolveEpInfoForUrl(s.url, epInfo);
        const primaryRawKey = makeRawKey(s.url, epInfo);
        const effectiveRawKey = makeRawKey(s.url, effectiveEpInfo);
        let text = getRawCache(primaryRawKey) || getRawCache(effectiveRawKey);
        if (!text) {
            text = await Promise.race([
                loadSubText(s.url, subsourceKey, effectiveEpInfo),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), verifyTimeoutMs); })
            ]);
        }
        if (!text || !String(text).trim()) return null;

        const cacheBoth = txt => {
            setRawCache(primaryRawKey, txt);
            if (effectiveRawKey !== primaryRawKey) setRawCache(effectiveRawKey, txt);
        };

        const metaSdh = isHearingImpairedMeta(s);

        if (detectAssContent(text, s)) {
            const assCheck = isCleanArabicAssText(text);
            if (!assCheck.ok) {
                s._bad = true;
                return null;
            }
            cacheBoth(text);
            const finalSdh = metaSdh || assCheck.isSdhContent;
            return { ...s, format: 'ass', _sig: assCheck.sig, _verified: true, _isSdh: finalSdh, hearingImpaired: finalSdh, _badSpelling: assCheck.isBadSpelling };
        }

        const cues = extractCuesUniversal(text);
        const check = isCleanArabicSrtText(text, cues);
        if (!check.ok) {
            s._bad = true;
            return null;
        }
        const sig = crypto.createHash('md5')
            .update(check.cuesText.replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        cacheBoth(text);
        const finalSdh = metaSdh || check.isSdhContent;
        return { ...s, format: 'srt', _sig: sig, _verified: true, _isSdh: finalSdh, hearingImpaired: finalSdh, _badSpelling: check.isBadSpelling };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function getRawArabicSubContent(targetUrl, subsourceKey, epInfo = null) {
    const effectiveEpInfo = resolveEpInfoForUrl(targetUrl, epInfo);
    const primaryKey = makeRawKey(targetUrl, epInfo);
    const effectiveKey = makeRawKey(targetUrl, effectiveEpInfo);
    const cached = getRawCache(primaryKey) || getRawCache(effectiveKey);
    if (cached) return cached;
    const text = await loadSubText(targetUrl, subsourceKey, effectiveEpInfo);
    if (!text || !String(text).trim()) {
        throw new Error('ملف الترجمة فارغ');
    }
    setRawCache(primaryKey, text);
    if (effectiveKey !== primaryKey) setRawCache(effectiveKey, text);
    return text;
}

function runFastParallelCheck(candidates, subsourceKey, epInfo, windowMs, perItemTimeoutMs = VERIFY_TIMEOUT_MS) {
    const verified = [];
    let done = false, timer, resolveWindow;
    const windowPromise = new Promise(r => { resolveWindow = r; });
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveWindow();
    };
    if (!candidates.length) {
        finish();
        return { verified, windowPromise, allPromise: Promise.resolve() };
    }
    timer = setTimeout(finish, windowMs);
    let idx = 0;
    const workerCount = Math.min(CONCURRENCY_LIMIT, candidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (idx < candidates.length) {
            const item = candidates[idx++];
            if (!item) continue;
            try {
                const res = await verifyArabicSub(item, subsourceKey, epInfo, perItemTimeoutMs);
                if (res) verified.push(res);
            } catch {
            }
        }
    });
    const allPromise = Promise.all(workers).then(finish);
    return { verified, windowPromise, allPromise };
}

function lightweightPreFilter(list, siteKey) {
    const assList = [];
    const srtList = [];
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
        if (!raw || !raw.url) continue;
        const urlStr = String(raw.url);
        if (rarFileRe.test(urlStr)) continue;
        const isHi = isHearingImpairedMeta(raw);
        const item = {
            ...raw,
            hearingImpaired: isHi,
            _isSdh: isHi,
            _source: raw._source || siteKey,
            _site: siteKey
        };
        const isAss = item.format === 'ass' || assFormatRe.test(item.subFormat || '') || assFileRe.test(item.fileName || item.title || urlStr);
        if (isAss) {
            assList.push({ ...item, format: 'ass' });
            continue;
        }
        const cleanU = cleanPath(urlStr);
        if (seenUrls.has(cleanU)) continue;
        if (item._osFileId) {
            if (seenFileIds.has(item._osFileId)) continue;
            seenFileIds.add(item._osFileId);
        }
        seenUrls.add(cleanU);
        const nameKey = normalizeNameSig(item.fileName || item.title || '');
        if (nameKey && nameKey.length > 6 && seenNames.has(nameKey) && srtList.length >= MAX_SRT_PER_SITE) {
            continue;
        }
        if (nameKey) seenNames.add(nameKey);
        const uniqueSig = item._sig || item._osFileId || cleanU;
        srtList.push({ ...item, format: 'srt', _sig: uniqueSig });
    }
    return {
        assList: sortByConsistentTemplate(assList),
        srtList: sortByConsistentTemplate(srtList)
    };
}

function buildFinalArabicLists({ legacyPre, osPre, subdlPre, subsourcePre, oscomPre, verifiedZipItems, strictDedupe = false }) {
    const verifiedUrls = new Set();
    for (const v of verifiedZipItems) {
        if (v && v.url) verifiedUrls.add(cleanPath(v.url));
    }

    // سجلات عالمية عابرة للمواقع لمنع تكرار نفس البصمة النصية (MD5) منذ الضغطة الأولى (للأفلام والمسلسلات)
    const globalSeenAssSigs = new Set();
    const globalSeenSrtSigs = new Set();

    function collectSiteAss(siteKey, preAssList) {
        const verifiedOut = [];
        const unverifiedOut = [];
        const seenUrls = new Set();
        const seenSiteSigs = new Set();

        const siteVerifiedAss = sortByConsistentTemplate(
            verifiedZipItems.filter(v => v && v._site === siteKey && v.format === 'ass' && !v._bad)
        );

        for (const v of siteVerifiedAss) {
            const u = cleanPath(v.url);
            const sig = v._sig || u;
            if (seenUrls.has(u) || seenSiteSigs.has(sig)) continue;
            // منع تكرار البصمة النصية عبر جميع المواقع دائماً (سواء في أول ضغطة أو بالخلفية)
            if (v._sig && globalSeenAssSigs.has(v._sig)) continue;
            seenUrls.add(u);
            seenSiteSigs.add(sig);
            if (v._sig) globalSeenAssSigs.add(v._sig);
            verifiedOut.push(v);
        }

        const sortedPreAss = sortByConsistentTemplate(preAssList);
        for (const a of sortedPreAss) {
            if (a._bad) continue;
            const u = cleanPath(a.url);
            if (seenUrls.has(u) || verifiedUrls.has(u)) continue;
            if (strictDedupe && globalSeenAssSigs.size >= CORRECTOR_MAX) continue;
            const sig = a._sig || normalizeNameSig(a.fileName || u);
            if (sig && (seenSiteSigs.has(sig) || globalSeenAssSigs.has(sig))) continue;
            seenUrls.add(u);
            if (sig) seenSiteSigs.add(sig);
            unverifiedOut.push(a);
        }

        const combinedSiteAss = [...verifiedOut, ...unverifiedOut];
        return [
            ...combinedSiteAss.filter(x => !isHearingImpairedMeta(x) && !x._badSpelling),
            ...combinedSiteAss.filter(x => !isHearingImpairedMeta(x) && x._badSpelling),
            ...combinedSiteAss.filter(x => isHearingImpairedMeta(x) && !x._badSpelling),
            ...combinedSiteAss.filter(x => isHearingImpairedMeta(x) && x._badSpelling)
        ];
    }

    function collectSiteSrt(siteKey, preSrtList) {
        const verifiedOut = [];
        const unverifiedOut = [];
        const seenSigs = new Set();
        const seenCleanUrls = new Set();
        const seenOsIds = new Set();

        const siteVerifiedSrt = sortByConsistentTemplate(
            verifiedZipItems.filter(v => v && v._site === siteKey && v.format === 'srt' && !v._bad)
        );

        for (const v of siteVerifiedSrt) {
            if (verifiedOut.length >= MAX_SRT_PER_SITE) break;
            const uKey = cleanPath(v.url);
            const sKey = v._sig || uKey;
            const osId = v._osFileId || '';
            if (seenCleanUrls.has(uKey) || seenSigs.has(sKey) || (osId && seenOsIds.has(osId))) continue;
            // منع تكرار البصمة النصية (MD5) عبر جميع المواقع منذ الضغطة الأولى
            if (v._sig && globalSeenSrtSigs.has(v._sig)) continue;
            seenCleanUrls.add(uKey);
            seenSigs.add(sKey);
            if (v._sig) globalSeenSrtSigs.add(v._sig);
            if (osId) seenOsIds.add(osId);
            verifiedOut.push(v);
        }

        const sortedPreSrt = sortByConsistentTemplate(preSrtList);
        for (const p of sortedPreSrt) {
            if (verifiedOut.length + unverifiedOut.length >= MAX_SRT_PER_SITE) break;
            if (p._bad) continue;
            const uKey = cleanPath(p.url);
            if (verifiedUrls.has(uKey)) continue;
            const sKey = p._sig || uKey;
            const osId = p._osFileId || '';
            if (seenCleanUrls.has(uKey) || seenSigs.has(sKey) || globalSeenSrtSigs.has(sKey) || (osId && seenOsIds.has(osId))) continue;
            seenCleanUrls.add(uKey);
            seenSigs.add(sKey);
            if (osId) seenOsIds.add(osId);
            unverifiedOut.push(p);
        }

        const combinedSiteSrt = [...verifiedOut, ...unverifiedOut];
        return [
            ...combinedSiteSrt.filter(x => !isHearingImpairedMeta(x) && !x._badSpelling),
            ...combinedSiteSrt.filter(x => !isHearingImpairedMeta(x) && x._badSpelling),
            ...combinedSiteSrt.filter(x => isHearingImpairedMeta(x) && !x._badSpelling),
            ...combinedSiteSrt.filter(x => isHearingImpairedMeta(x) && x._badSpelling)
        ];
    }

    const rawAllAss = [
        ...collectSiteAss('subdl', subdlPre.assList),
        ...collectSiteAss('subsource', subsourcePre.assList),
        ...collectSiteAss('opensubtitles', osPre.assList),
        ...collectSiteAss('os_legacy', legacyPre.assList),
        ...collectSiteAss('oscom', oscomPre.assList)
    ];
    const allAss = [
        ...rawAllAss.filter(x => !isHearingImpairedMeta(x) && !x._badSpelling),
        ...rawAllAss.filter(x => !isHearingImpairedMeta(x) && x._badSpelling),
        ...rawAllAss.filter(x => isHearingImpairedMeta(x) && !x._badSpelling),
        ...rawAllAss.filter(x => isHearingImpairedMeta(x) && x._badSpelling)
    ];

    const subdlSrt = collectSiteSrt('subdl', subdlPre.srtList);
    const subsourceSrt = collectSiteSrt('subsource', subsourcePre.srtList);
    const osSrt = collectSiteSrt('opensubtitles', osPre.srtList);
    const legacySrt = collectSiteSrt('os_legacy', legacyPre.srtList);
    const oscomSrt = collectSiteSrt('oscom', oscomPre.srtList);
    const readySrt = [...subdlSrt, ...subsourceSrt, ...osSrt, ...legacySrt, ...oscomSrt];

    // للمصحح: منع التكرار بالبصمة النصية (MD5) أو بتطابق اسم الإصدار عبر المواقع دائماً (في أول ضغطة وبالخلفية)
    const seenCorr = new Set();
    const seenCorrSigs = new Set();
    const seenCorrNames = new Set();
    const correctorSrt = [];
    for (const allowSdh of [false, true]) {
        for (const allowBad of [false, true]) {
            for (const pass of [true, false]) {
                for (const c of readySrt) {
                    if (correctorSrt.length >= CORRECTOR_MAX) break;
                    const isSdh = isHearingImpairedMeta(c);
                    if (isSdh !== allowSdh) continue;
                    const isBad = !!c._badSpelling;
                    if (isBad !== allowBad) continue;
                    const u = cleanPath(c.url);
                    const sig = c._sig || u;
                    const nameSig = normalizeNameSig(c.fileName || c.title || '');
                    if (c._bad || seenCorr.has(u) || seenCorrSigs.has(sig)) continue;
                    // إذا كان الملف غير مفحوص بعد، نمنع تكراره إذا تطابق اسم ملفه تماماً مع ملف آخر تم اختياره من موقع سابق
                    if (!c._verified && nameSig && nameSig.length > 8 && seenCorrNames.has(nameSig)) continue;
                    if (!!c._verified !== pass) continue;
                    seenCorr.add(u);
                    seenCorrSigs.add(sig);
                    if (nameSig && nameSig.length > 8) seenCorrNames.add(nameSig);
                    correctorSrt.push(c);
                }
            }
        }
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

async function fetchAllSourcesOnce({ imdbId, season, episode, type, subdlKey, subsourceKey, isPrefetch = false }) {
    const timeouts = isPrefetch ? BG_SOURCE_TIMEOUTS : SOURCE_TIMEOUTS;
    const sourceDefs = [
        { key: 'os_legacy', name: 'OS Legacy', run: () => fetchOsLegacyArabic(imdbId, season, episode, isPrefetch) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type, isPrefetch) },
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) },
        { key: 'oscom', name: 'OS.com', run: () => getOsCom({ imdbId, season, episode }) }
    ];
    const settled = await Promise.allSettled(
        sourceDefs.map(d => withTimeout(Promise.resolve().then(d.run), timeouts[d.key], d.name))
    );
    const getList = idx => (settled[idx].status === 'fulfilled' && Array.isArray(settled[idx].value) ? settled[idx].value : []);
    return {
        osLegacyList: getList(0),
        osMirrorList: getList(1),
        subdlRawList: getList(2),
        subsourceRawList: getList(3),
        oscomRawList: getList(4)
    };
}

async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey, isPrefetch = false }) {
    const rawKeysStr = [subdlKey || '', subsourceKey || ''].join('|');
    const keyHash = crypto.createHash('md5').update(rawKeysStr).digest('hex').slice(0, 8);
    const cacheKey = [imdbId, season, episode, keyHash].join(':');
    const hit = resultCache.get(cacheKey);

    if (hit && Date.now() - hit.time < RESULT_TTL) {
        if (!isPrefetch || hit.isComplete) return hit.value;
    }

    let { osLegacyList, osMirrorList, subdlRawList, subsourceRawList, oscomRawList } = await fetchAllSourcesOnce({
        imdbId, season, episode, type, subdlKey, subsourceKey, isPrefetch
    });

    const totalInitial = osLegacyList.length + osMirrorList.length + subdlRawList.length + subsourceRawList.length;
    if (season != null && parseInt(season, 10) > 1 && totalInitial < 2) {
        const absEp = await getAbsoluteEpisodeNumber(imdbId, season, episode);
        if (absEp) {
            console.log('[ترقيم مطلق 🔄] الموسم ' + season + ' الحلقة ' + episode + ' لم يرجع ترجمات كافية (' + totalInitial + '). جاري البحث بالرقم المطلق: الموسم 1 الحلقة ' + absEp + '...');
            const absOverride = { season: '1', episode: String(absEp) };
            const absRes = await fetchAllSourcesOnce({
                imdbId, season: 1, episode: absEp, type, subdlKey, subsourceKey, isPrefetch
            });
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

    const legacyPre = lightweightPreFilter(osLegacyList, 'os_legacy');
    const osPre = lightweightPreFilter(osMirrorList, 'opensubtitles');
    const subdlPre = lightweightPreFilter(subdlRawList, 'subdl');
    const subsourcePre = lightweightPreFilter(subsourceRawList, 'subsource');
    const oscomPre = lightweightPreFilter(oscomRawList, 'oscom');

    const usableCount = [legacyPre, osPre, subdlPre, subsourcePre]
        .reduce((n, p) => n + p.assList.length + p.srtList.length, 0);
    const oscomIsBackup = usableCount === 0;
    if (oscomIsBackup && oscomPre.assList.length + oscomPre.srtList.length > 0) {
        console.log('[جلب عربي - OS.com] المواقع الأخرى ما رجعت أي نتيجة، فـ OS.com يشتغل كاحتياط (أفحص ' + (OSCOM_VERIFY_EACH * 2) + ' ملفات كحد أقصى).');
    }

    const maxPerSite = isPrefetch ? BG_MAX_ZIPS_PER_SITE : 20;
    const zipCandidates = [];
    const subdlZips = [...subdlPre.assList, ...subdlPre.srtList.filter(x => !String(x.url).includes('strem.top'))].slice(0, maxPerSite);
    const subsourceZips = [...subsourcePre.assList, ...subsourcePre.srtList].slice(0, maxPerSite);
    const osZips = [...osPre.assList, ...osPre.srtList].slice(0, maxPerSite);
    const legacyZips = VERIFY_LEGACY ? [...legacyPre.assList, ...legacyPre.srtList].slice(0, maxPerSite) : [];
    const oscomZips = oscomIsBackup ? [...oscomPre.assList.slice(0, OSCOM_VERIFY_EACH), ...oscomPre.srtList.slice(0, OSCOM_VERIFY_EACH)] : [];
    const maxZips = Math.max(subdlZips.length, subsourceZips.length, osZips.length, legacyZips.length, oscomZips.length);

    for (let i = 0; i < maxZips; i++) {
        if (subdlZips[i]) zipCandidates.push(subdlZips[i]);
        if (subsourceZips[i]) zipCandidates.push(subsourceZips[i]);
        if (osZips[i]) zipCandidates.push(osZips[i]);
        if (legacyZips[i]) zipCandidates.push(legacyZips[i]);
        if (oscomZips[i]) zipCandidates.push(oscomZips[i]);
    }

    const epInfo = (season != null && episode != null) ? { season, episode } : null;
    const windowMs = isPrefetch ? BG_VERIFY_WINDOW_MS : FAST_VERIFY_WINDOW_MS;
    const itemTimeoutMs = isPrefetch ? BG_VERIFY_TIMEOUT_MS : VERIFY_TIMEOUT_MS;

    const job = runFastParallelCheck(zipCandidates, subsourceKey, epInfo, windowMs, itemTimeoutMs);
    await job.windowPromise;

    const snapshot = job.verified.slice();
    const value = buildFinalArabicLists({
        legacyPre, osPre, subdlPre, subsourcePre, oscomPre,
        verifiedZipItems: snapshot,
        strictDedupe: isPrefetch
    });

    if (value.ass.length > 0 || value.srt.length > 0) {
        setResultCache(cacheKey, value, isPrefetch);
    }

    if (!isPrefetch) {
        job.allPromise.then(() => {
            if (job.verified.length > snapshot.length) {
                const updated = buildFinalArabicLists({
                    legacyPre, osPre, subdlPre, subsourcePre, oscomPre,
                    verifiedZipItems: job.verified,
                    strictDedupe: true
                });
                setResultCache(cacheKey, updated, true);
            }
        }).catch(() => {});
    }

    return value;
}
