const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');
module.exports = { getArabicSubsForCorrection, getRawArabicSubContent, resolveEpInfoForUrl };
const cleanPath = p => String(p || '').split('?')[0];
const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];
const SOURCE_TIMEOUTS = { os_legacy: 3500, os_mirror: 3200, subdl: 3800, subsource: 3800 };
const FAST_VERIFY_WINDOW_MS = 2800;
const VERIFY_TIMEOUT_MS = 2600;
const CONCURRENCY_LIMIT = 8;
const MAX_SRT_PER_SITE = 20;
const RESULT_TTL = 30 * 60 * 1000;
const MAX_RESULT_CACHE = 100;
const resultCache = new Map();
const MAX_RAW_CACHE = 150;
const rawTextCache = new Map();
const seriesMetaCache = new Map();
const urlEpOverrideMap = new Map();
const assFormatRe = /^(ass|ssa)$/i;
const assFileRe = /\.(ass|ssa)(\b|$)/i;
const rarFileRe = /\.(rar|7z)(\?|$)/i;
const osFileIdRe = /\/file\/(\d+)/i;
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
        const out = [];
        for (const e of data) {
            if (!e || !e.SubDownloadLink) continue;
            if (!isAssEntry(e)) continue;
            out.push({
                url: e.SubDownloadLink,
                format: 'ass',
                fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara_ASS',
                _source: 'os_legacy',
                _site: 'os_legacy',
                _osFileId: String(e.IDSubtitleFile || extractOsFileId(e.SubDownloadLink) || ''),
                _sig: e.SubHash || normalizeNameSig(e.SubFileName || e.SubDownloadLink)
            });
        }
        return out;
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
async function verifyArabicSub(s, subsourceKey, epInfo = null) {
    let timer;
    try {
       const { fetchAndExtractSub, extractCuesUniversal } = require('../ai/ai').shared;
        const effectiveEpInfo = s._epOverride || resolveEpInfoForUrl(s.url, epInfo);
        const primaryRawKey = makeRawKey(s.url, epInfo);
        const effectiveRawKey = makeRawKey(s.url, effectiveEpInfo);
        let text = getRawCache(primaryRawKey) || getRawCache(effectiveRawKey);
        if (!text) {
            text = await Promise.race([
                fetchAndExtractSub(s.url, subsourceKey, effectiveEpInfo),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), VERIFY_TIMEOUT_MS); })
            ]);
        }
        if (!text || !String(text).trim()) return null;
        const cacheBoth = txt => {
            setRawCache(primaryRawKey, txt);
            if (effectiveRawKey !== primaryRawKey) setRawCache(effectiveRawKey, txt);
        };
        if (detectAssContent(text, s)) {
            cacheBoth(text);
            return { ...s, format: 'ass', _verified: true };
        }
        const cues = extractCuesUniversal(text);
        const check = isCleanArabicSrtText(text, cues);
        if (!check.ok) {
            return null;
        }
        const sig = crypto.createHash('md5')
            .update(check.cuesText.replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        cacheBoth(text);
        return { ...s, format: 'srt', _sig: sig, _verified: true };
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
    const { fetchAndExtractSub } = require('../ai/ai').shared;
    const text = await fetchAndExtractSub(targetUrl, subsourceKey, effectiveEpInfo);
    if (!text || !String(text).trim()) {
        throw new Error('ملف الترجمة فارغ');
    }
    setRawCache(primaryKey, text);
    if (effectiveKey !== primaryKey) setRawCache(effectiveKey, text);
    return text;
}
function runFastParallelCheck(candidates, subsourceKey, epInfo, windowMs) {
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
                const res = await verifyArabicSub(item, subsourceKey, epInfo);
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
    return { assList, srtList };
}
function buildFinalArabicLists({ osLegacyAss, osPre, subdlPre, subsourcePre, verifiedZipItems }) {
    const allAss = [];
    const verifiedUrls = new Set();
    for (const v of verifiedZipItems) {
        if (v && v.url) verifiedUrls.add(cleanPath(v.url));
        if (v && v.format === 'ass') allAss.push(v);
    }
    for (const a of [...subdlPre.assList, ...subsourcePre.assList, ...osPre.assList]) {
        if (!verifiedUrls.has(cleanPath(a.url))) {
            allAss.push(a);
        }
    }
    for (const o of osLegacyAss) {
        if (o && o.format === 'ass') {
            allAss.push(o);
        }
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
    const subdlSrt = collectSiteSrt('subdl', subdlPre.srtList);
    const subsourceSrt = collectSiteSrt('subsource', subsourcePre.srtList);
    const osSrt = collectSiteSrt('opensubtitles', osPre.srtList);
    const readySrt = [...subdlSrt, ...subsourceSrt, ...osSrt];
    const correctorCandidates = [
        ...verifiedZipItems.filter(v => v && v.format === 'srt'),
        ...subdlSrt,
        ...subsourceSrt,
        ...osSrt
    ];
    const seenCorr = new Set();
    const correctorSrt = [];
    for (const c of correctorCandidates) {
        const u = cleanPath(c.url);
        if (seenCorr.has(u)) continue;
        seenCorr.add(u);
        correctorSrt.push(c);
        if (correctorSrt.length >= 4) break;
    }
    return {
        ass: allAss,
        srt: readySrt,
        correctorSrt,
        counts: {
            ass: allAss.length,
            subdlSrt: subdlSrt.length,
            subsourceSrt: subsourceSrt.length,
            osSrt: osSrt.length
        }
    };
}
async function fetchAllSourcesOnce({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const sourceDefs = [
        { key: 'os_legacy', name: 'OS Legacy', run: () => fetchOsLegacyArabic(imdbId, season, episode) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type) },
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) }
    ];
    const settled = await Promise.allSettled(
        sourceDefs.map(d => withTimeout(Promise.resolve().then(d.run), SOURCE_TIMEOUTS[d.key], d.name))
    );
    const getList = idx => (settled[idx].status === 'fulfilled' && Array.isArray(settled[idx].value) ? settled[idx].value : []);
    return {
        osLegacyAss: getList(0),
        osMirrorList: getList(1),
        subdlRawList: getList(2),
        subsourceRawList: getList(3)
    };
}
async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const rawKeysStr = [subdlKey || '', subsourceKey || ''].join('|');
    const keyHash = crypto.createHash('md5').update(rawKeysStr).digest('hex').slice(0, 8);
    const cacheKey = [imdbId, season, episode, keyHash].join(':');
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.time < RESULT_TTL) return hit.value;
    let { osLegacyAss, osMirrorList, subdlRawList, subsourceRawList } = await fetchAllSourcesOnce({
        imdbId, season, episode, type, subdlKey, subsourceKey
    });
    const totalInitial = osLegacyAss.length + osMirrorList.length + subdlRawList.length + subsourceRawList.length;
    if (season != null && parseInt(season, 10) > 1 && totalInitial < 2) {
        const absEp = await getAbsoluteEpisodeNumber(imdbId, season, episode);
        if (absEp) {
            console.log('[ترقيم مطلق 🔄] الموسم ' + season + ' الحلقة ' + episode + ' لم يرجع ترجمات كافية (' + totalInitial + '). جاري البحث بالرقم المطلق: الموسم 1 الحلقة ' + absEp + '...');
            const absOverride = { season: '1', episode: String(absEp) };
            const absRes = await fetchAllSourcesOnce({
                imdbId, season: 1, episode: absEp, type, subdlKey, subsourceKey
            });
            const tagAbs = list => list.map(item => {
                if (item && item.url) rememberUrlEpOverride(item.url, absOverride);
                return { ...item, _epOverride: absOverride };
            });
            osLegacyAss = [...osLegacyAss, ...tagAbs(absRes.osLegacyAss)];
            osMirrorList = [...osMirrorList, ...tagAbs(absRes.osMirrorList)];
            subdlRawList = [...subdlRawList, ...tagAbs(absRes.subdlRawList)];
            subsourceRawList = [...subsourceRawList, ...tagAbs(absRes.subsourceRawList)];
        }
    }
    const osPre = lightweightPreFilter(osMirrorList, 'opensubtitles');
    const subdlPre = lightweightPreFilter(subdlRawList, 'subdl');
    const subsourcePre = lightweightPreFilter(subsourceRawList, 'subsource');
    const zipCandidates = [];
    const subdlZips = [...subdlPre.assList, ...subdlPre.srtList.filter(x => !String(x.url).includes('strem.top'))].slice(0, 20);
    const subsourceZips = [...subsourcePre.assList, ...subsourcePre.srtList].slice(0, 20);
    const osZips = [...osPre.assList, ...osPre.srtList].slice(0, 20);
    const maxZips = Math.max(subdlZips.length, subsourceZips.length, osZips.length);
    for (let i = 0; i < maxZips; i++) {
        if (subdlZips[i]) zipCandidates.push(subdlZips[i]);
        if (subsourceZips[i]) zipCandidates.push(subsourceZips[i]);
        if (osZips[i]) zipCandidates.push(osZips[i]);
    }
    const epInfo = (season != null && episode != null) ? { season, episode } : null;
    const job = runFastParallelCheck(zipCandidates, subsourceKey, epInfo, FAST_VERIFY_WINDOW_MS);
    await job.windowPromise;
    const snapshot = job.verified.slice();
    const value = buildFinalArabicLists({ osLegacyAss, osPre, subdlPre, subsourcePre, verifiedZipItems: snapshot });
    if (value.ass.length > 0 || value.srt.length > 0) {
        setResultCache(cacheKey, value);
    }
    job.allPromise.then(() => {
        if (job.verified.length > snapshot.length) {
            const updated = buildFinalArabicLists({ osLegacyAss, osPre, subdlPre, subsourcePre, verifiedZipItems: job.verified });
            setResultCache(cacheKey, updated);
        }
    }).catch(() => {});
    return value;
}
