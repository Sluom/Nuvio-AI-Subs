const axios = require('axios');

// التصدير بالأعلى (الدوال تُرفع تلقائياً) حتى لا يضيع لو انقطع آخر الملف عند النسخ
module.exports = { getArabicSubsForCorrection };

// دالة بسيطة لتنظيف الروابط ومنع التكرار
const cleanPath = p => String(p).split('?')[0];

const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];

// 1. OpenSubtitles Legacy (rest.opensubtitles.org): ASS فقط. الـ SRT مستبعد نهائياً من هذا المصدر.
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

        // مسلسل وما رجع ASS: نبحث بـ ID المسلسل كامل ونفلتر بالحلقة
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

// 2. OpenSubtitles Mirror (strem.io) - بدون تغيير
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

// 3. SubDL (مع لوغات واضحة)
async function fetchSubDLArabic(imdbId, season, episode, apiKey) {
    const key = String(apiKey || process.env.SUBDL_API_KEY || '').trim();
    if (!key) { console.log('[جلب عربي - SubDL] لا يوجد مفتاح (SUBDL_API_KEY) - تم التخطي.'); return []; }
    if (!imdbId) return [];
    const isSeries = season != null && episode != null;

    const params = new URLSearchParams({
        api_key: key,
        imdb_id: imdbId,
        languages: 'AR',
        type: isSeries ? 'tv' : 'movie',
        subs_per_page: '30'
    });

    if (isSeries) {
        params.append('season_number', String(season));
        params.append('episode_number', String(episode));
    }

    try {
        const res = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, { timeout: 8000 });
        const data = res.data || {};
        if (!data.status || !Array.isArray(data.subtitles)) {
            console.log(`[جلب عربي - SubDL] رد بدون ترجمات (status=${data.status}) ${String(data.error || '').slice(0, 100)}`);
            return [];
        }

        const out = data.subtitles.filter(s => s && s.url && !s.full_season).map(s => {
            const path = cleanPath(s.url);
            const url = path.startsWith('http') ? path : `https://dl.subdl.com${path.startsWith('/') ? '' : '/'}${path}`;
            const isAss = path.endsWith('.ass') || path.endsWith('.ssa');
            return {
                url,
                format: isAss ? 'ass' : 'srt',
                fileName: s.release_name || s.name || 'SubDL_Ara',
                _source: 'subdl'
            };
        });
        console.log(`[جلب عربي - SubDL] ${out.length} ترجمة عربية (من ${data.subtitles.length} نتيجة).`);
        return out;
    } catch (e) {
        console.log(`[جلب عربي - SubDL] فشل: ${e.response?.status || e.code || ''} ${e.message}`);
        return [];
    }
}

// 4. Subsource (API الرسمي: api.subsource.net/api/v1 ، المفتاح بالهيدر X-API-Key)
const SUBSOURCE_BASE = 'https://api.subsource.net/api/v1';

function pickList(d) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of ['data', 'results', 'subtitles', 'movies', 'items']) {
        if (Array.isArray(d[k])) return d[k];
        if (d[k] && typeof d[k] === 'object') {
            const inner = pickList(d[k]);
            if (inner.length) return inner;
        }
    }
    return [];
}

function subsourceEpisodeOk(name, season, episode) {
    const n = String(name || '');
    const se = n.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/i);
    if (se) return Number(se[1]) === Number(season) && Number(se[2]) === Number(episode);
    const e = n.match(/(?:^|[^a-z0-9])(?:e|ep|episode)[ ._-]*0*(\d{1,3})(?![0-9])/i);
    if (e) return Number(e[1]) === Number(episode);
    return false;
}

const ssErr = e => `${e.response?.status || e.code || ''} ${e.response?.data?.message || e.message}`.trim();

async function fetchSubsourceArabic(imdbId, season, episode, apiKey) {
    const key = String(apiKey || process.env.SUBSOURCE_API_KEY || '').trim();
    if (!key) { console.log('[جلب عربي - Subsource] لا يوجد مفتاح (SUBSOURCE_API_KEY) - تم التخطي.'); return []; }
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = season != null && episode != null;
    const headers = { 'X-API-Key': key, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

    try {
        // أ) إيجاد movieId من IMDb
        let search;
        try {
            search = await axios.get(`${SUBSOURCE_BASE}/movies/search`, {
                params: isSeries ? { searchType: 'imdb', imdb: imdbId, type: 'series', season } : { searchType: 'imdb', imdb: imdbId },
                headers, timeout: 8000
            });
        } catch (e1) {
            const st = e1.response?.status;
            if (st === 400 || st === 422) {
                console.log(`[جلب عربي - Subsource] البحث رفض المعاملات (${st})، أعيد بـ imdb فقط.`);
                search = await axios.get(`${SUBSOURCE_BASE}/movies/search`, {
                    params: { searchType: 'imdb', imdb: imdbId }, headers, timeout: 8000
                });
            } else throw e1;
        }

        const movies = pickList(search.data);
        if (!movies.length) {
            console.log(`[جلب عربي - Subsource] ما لقيت العمل ${imdbId} (status ${search.status}) رد: ${JSON.stringify(search.data).slice(0, 120)}`);
            return [];
        }
        let movie = movies[0];
        if (isSeries) {
            const bySeason = movies.find(m => m && m.season != null && Number(m.season) === Number(season));
            if (bySeason) movie = bySeason;
        }
        const movieId = movie.movieId ?? movie.id;
        if (movieId == null) {
            console.log(`[جلب عربي - Subsource] لقيت العمل لكن بدون movieId. الحقول: ${Object.keys(movie).join(',')}`);
            return [];
        }

        // ب) ترجمات العربية لهذا العمل
        const subsRes = await axios.get(`${SUBSOURCE_BASE}/subtitles`, {
            params: { movieId, language: 'arabic' }, headers, timeout: 10000
        });
        const list = pickList(subsRes.data);
        if (!list.length) {
            console.log(`[جلب عربي - Subsource] movieId=${movieId}: 0 ترجمة عربية. رد: ${JSON.stringify(subsRes.data).slice(0, 120)}`);
            return [];
        }

        const out = [];
        for (const x of list) {
            const id = x.subtitleId ?? x.id;
            if (id == null) continue;
            const name = x.releaseInfo || x.release_info || x.name || x.releaseName || `Subsource_${id}`;
            const nameStr = Array.isArray(name) ? name.join(' ') : String(name);
            if (isSeries && !subsourceEpisodeOk(nameStr, season, episode)) continue;
            out.push({
                url: `${SUBSOURCE_BASE}/subtitles/${id}/download`,
                format: /\.(ass|ssa)\b/i.test(nameStr) ? 'ass' : 'srt',
                fileName: nameStr,
                _source: 'subsource'
            });
            if (out.length >= 30) break;
        }
        console.log(`[جلب عربي - Subsource] movieId=${movieId}: ${out.length} ترجمة عربية معتمدة (من ${list.length} نتيجة${isSeries ? '، بعد فلتر الحلقة' : ''}).`);
        return out;
    } catch (e) {
        console.log(`[جلب عربي - Subsource] فشل: ${ssErr(e)} ${e.response?.data ? JSON.stringify(e.response.data).slice(0, 120) : ''}`);
        return [];
    }
}

// الدالة الرئيسية
async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    console.log(`[جلب عربي] جاري البحث عن ترجمات عربية جاهزة للتصحيح للعمل: ${imdbId}...`);

    const names = ['OS Legacy (ASS)', 'OS Mirror', 'SubDL', 'Subsource'];
    const settled = await Promise.allSettled([
        fetchOsLegacyArabic(imdbId, season, episode),
        fetchOsMirrorArabic(imdbId, season, episode, type),
        fetchSubDLArabic(imdbId, season, episode, subdlKey),
        fetchSubsourceArabic(imdbId, season, episode, subsourceKey)
    ]);

    settled.forEach((r, i) => {
        if (r.status === 'rejected') console.log(`[جلب عربي - ${names[i]}] خطأ غير متوقع: ${r.reason && r.reason.message}`);
    });
    console.log('[جلب عربي] ملخص المصادر: ' + settled.map((r, i) => `${names[i]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | '));

    const allSubs = settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

    const seenUrls = new Set();
    const uniqueSubs = allSubs.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    const srtSubs = uniqueSubs.filter(s => s.format === 'srt');
    const assSubs = uniqueSubs.filter(s => s.format === 'ass');

    console.log(`[جلب عربي] النتيجة النهائية: ${srtSubs.length} ملف SRT، و ${assSubs.length} ملف ASS.`);

    return { srt: srtSubs, ass: assSubs };
}

module.exports = { getArabicSubsForCorrection };
