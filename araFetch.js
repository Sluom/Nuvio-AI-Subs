const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');

module.exports = { getArabicSubsForCorrection };

const cleanPath = p => String(p).split('?')[0];

const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];

const VERIFY_LIMIT = 12;
const VERIFY_TIMEOUT_MS = 12000;
const RESULT_TTL = 30 * 60 * 1000;
const resultCache = new Map();

async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;

    const primaryUrl = hasSE
        ? `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`
        : `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;

    async function fetchLegacyData(url) {
        let response;
        for (let i = 0; i < LEGACY_AGENTS.length; i++) {
            const ua = LEGACY_AGENTS[i];
            response = await fetch(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' }
            });
            console.log(`[جلب عربي - OS Legacy] ${response.status}${i > 0 ? ` (محاولة ثانية: ${ua})` : ''} <- ${url}`);
            if (response.status !== 403) break;
        }
        if (!response || !response.ok) return [];
        const json = await response.json();
        return Array.isArray(json) ? json : [];
    }

    const isAssEntry = r => /^(ass|ssa)$/i.test(r.SubFormat || '') || /\.(ass|ssa)\b/i.test(r.SubFileName || '');

    try {
        let data = await fetchLegacyData(primaryUrl);

        if (hasSE && !data.some(isAssEntry)) {
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;
            const fallbackData = await fetchLegacyData(fallbackUrl);
            const epRe = new RegExp(`(?:e|ep|episode)[._ -]*0*${parseInt(episode, 10)}(?:[^0-9]|$)`, 'i');
            data = [...data, ...fallbackData.filter(r => isAssEntry(r) && epRe.test(r.SubFileName || ''))];
        }

        const total = data.length;
        const assOnly = data.filter(e => e.SubDownloadLink && isAssEntry(e)).map(e => ({
            url: e.SubDownloadLink,
            format: 'ass',
            fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
            _source: 'os_legacy'
        }));
        console.log(`[جلب عربي - OS Legacy] رجع ${total} نتيجة، المعتمد ASS فقط: ${assOnly.length} (الـ SRT مستبعد).`);
        return assOnly;
    } catch (e) {
        console.log(`[جلب عربي - OS Legacy] خطأ: ${e.message}`);
        return [];
    }
}

async function fetchOsMirrorArabic(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    try {
        const response = await axios.get(`https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`, {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' },
            timeout: 8000
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
        console.log(`[جلب عربي - OS Mirror] ${out.length} ترجمة عربية.`);
        return out;
    } catch (e) {
        console.log(`[جلب عربي - OS Mirror] فشل: ${e.message}`);
        return [];
    }
}

async function verifyArabicSub(s, subsourceKey) {
    const { fetchAndExtractSub, extractCuesUniversal } = require('./ai').shared;
    try {
        const text = await Promise.race([
            fetchAndExtractSub(s.url, subsourceKey),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), VERIFY_TIMEOUT_MS))
        ]);
        const cues = extractCuesUniversal(text);
        const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
        if (cues.length < 10 || arabic < 200) {
            console.log(`[فحص عربي] ✗ ${s._source}: ليس عربياً أو فارغ (cues=${cues.length}, arabic=${arabic}) <- ${s.url}`);
            return null;
        }
        const sig = crypto.createHash('md5')
            .update(cues.map(c => c.text).join('').replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        return { ...s, _sig: sig };
    } catch (e) {
        console.log(`[فحص عربي] ✗ ${s._source}: ${e.message} <- ${s.url}`);
        return null;
    }
}

async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    console.log(`[جلب عربي] جاري البحث عن ترجمات عربية جاهزة للتصحيح للعمل: ${imdbId}...`);

    const keyHash = crypto.createHash('md5').update(`${subdlKey || ''}|${subsourceKey || ''}`).digest('hex').slice(0, 8);
    const cacheKey = `${imdbId}:${season}:${episode}:${keyHash}`;
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.time < RESULT_TTL) {
        console.log('[جلب عربي] النتيجة من الكاش.');
        return hit.value;
    }

    const names = ['OS Legacy (ASS)', 'OS Mirror', 'SubDL', 'Subsource'];
    const settled = await Promise.allSettled([
        fetchOsLegacyArabic(imdbId, season, episode),
        fetchOsMirrorArabic(imdbId, season, episode, type),
        getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'] }),
        getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' })
    ]);

    settled.forEach((r, i) => {
        if (r.status === 'rejected') console.log(`[جلب عربي - ${names[i]}] خطأ غير متوقع: ${r.reason && r.reason.message}`);
    });
    console.log('[جلب عربي] ملخص المصادر: ' + settled.map((r, i) => `${names[i]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | '));

    const lists = settled.map(r => (r.status === 'fulfilled' ? r.value : []));
    const interleaved = [];
    const maxLen = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) for (const l of lists) if (l[i]) interleaved.push(l[i]);

    const seenUrls = new Set();
    const uniqueSubs = interleaved.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    const toVerify = uniqueSubs.slice(0, VERIFY_LIMIT);
    const verified = (await Promise.all(toVerify.map(s => verifyArabicSub(s, subsourceKey)))).filter(Boolean);

    const seenSig = new Set();
    const good = verified.filter(s => !seenSig.has(s._sig) && seenSig.add(s._sig));

    const srtSubs = good.filter(s => s.format === 'srt');
    const assSubs = good.filter(s => s.format === 'ass');

    console.log(`[جلب عربي] بعد الفحص: ${verified.length}/${toVerify.length} شغالة، ${good.length} بعد حذف المكرر → ${srtSubs.length} SRT و ${assSubs.length} ASS.`);

    const value = { srt: srtSubs, ass: assSubs };
    if (good.length > 0) resultCache.set(cacheKey, { time: Date.now(), value });
    return value;
}
