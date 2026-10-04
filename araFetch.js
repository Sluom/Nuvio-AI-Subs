const axios = require('axios');

// دالة بسيطة لتنظيف الروابط ومنع التكرار
const cleanPath = p => String(p).split('?')[0];

// 1. جلب الترجمات العربية من OpenSubtitles Legacy (القديم)
async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;
    
    const url = hasSE
        ? `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`
        : `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;

    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'VLSub 0.10.3', 'Accept': 'application/json' },
            timeout: 8000
        });
        
        const data = response.data || [];
        if (!Array.isArray(data)) return [];

        return data.filter(e => e.SubDownloadLink).map(e => {
            const format = (e.SubFormat || '').toLowerCase();
            const isAss = format === 'ass' || format === 'ssa';
            return {
                url: e.SubDownloadLink,
                format: isAss ? 'ass' : 'srt',
                fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
                _source: 'os_legacy'
            };
        });
    } catch (e) {
        console.log(`[جلب عربي - OS Legacy] فشل: ${e.message}`);
        return [];
    }
}

// 2. جلب الترجمات العربية من OpenSubtitles Mirror (الحديث v3)
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
        return (data.subtitles || [])
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
    } catch (e) {
        console.log(`[جلب عربي - OS Mirror] فشل: ${e.message}`);
        return [];
    }
}

// 3. جلب الترجمات العربية من SubDL
async function fetchSubDLArabic(imdbId, season, episode, apiKey) {
    const key = String(apiKey || process.env.SUBDL_API_KEY || '').trim();
    if (!key || !imdbId) return [];
    const isSeries = season != null && episode != null;

    const params = new URLSearchParams({
        api_key: key,
        imdb_id: imdbId,
        languages: 'AR', // كود اللغة العربية في SubDL
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
        if (!data.status || !Array.isArray(data.subtitles)) return [];

        return data.subtitles.filter(s => s && s.url && !s.full_season).map(s => {
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
    } catch (e) {
        console.log(`[جلب عربي - SubDL] فشل: ${e.message}`);
        return [];
    }
}

// 4. جلب الترجمات العربية من Subsource (باستخدام إضافة سكرابنج أو API غير رسمي إن وجد)
async function fetchSubsourceArabic(imdbId, season, episode) {
    // Subsource ما يوفر API رسمي ومباشر برقم IMDb بسهولة مثل الباقين.
    // لكن وضعنا هذا الهيكل حتى لو توفر عندك Endpoint جاهز لـ Stremio يخص Subsource، نربطه هنا فوراً.
    // في الوقت الحالي راح نرجع مصفوفة فارغة حتى ما يضرب الكود، ونقدر نحدثها لاحقاً.
    return [];
}

// الدالة الرئيسية اللي تجمع كل المصادر وتفلترها
async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey }) {
    console.log(`[جلب عربي] جاري البحث عن ترجمات عربية جاهزة للتصحيح للعمل: ${imdbId}...`);
    
    const settled = await Promise.allSettled([
        fetchOsLegacyArabic(imdbId, season, episode),
        fetchOsMirrorArabic(imdbId, season, episode, type),
        fetchSubDLArabic(imdbId, season, episode, subdlKey),
        fetchSubsourceArabic(imdbId, season, episode)
    ]);

    const allSubs = settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

    // فلترة المكرر عن طريق الرابط الأساسي
    const seenUrls = new Set();
    const uniqueSubs = allSubs.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    // فصل الترجمات إلى srt و ass لتسهيل اختيار الـ 6 حقول لاحقاً
    const srtSubs = uniqueSubs.filter(s => s.format === 'srt');
    const assSubs = uniqueSubs.filter(s => s.format === 'ass');

    console.log(`[جلب عربي] النتيجة النهائية: ${srtSubs.length} ملف SRT، و ${assSubs.length} ملف ASS.`);

    return { srt: srtSubs, ass: assSubs };
}

module.exports = { getArabicSubsForCorrection };
