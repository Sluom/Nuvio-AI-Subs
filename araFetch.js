const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];

async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;
    
    const primaryUrl = hasSE
        ? `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`
        : `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;

    // دالة السحب اللي تفتر على الـ User-Agents مثل كودك الأصلي
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
        return await response.json();
    }

    try {
        let data = await fetchLegacyData(primaryUrl);
        
        // إذا مسلسل وما رجع ASS، نجرب نبحث بالـ ID مال المسلسل كامل (نفس فكرتك بالكود الأصلي)
        if (hasSE && !data.some(r => /ass|ssa/i.test(r.SubFormat || ''))) {
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;
            const fallbackData = await fetchLegacyData(fallbackUrl);
            const filteredFallback = fallbackData.filter(r => 
                (/ass|ssa/i.test(r.SubFormat || '')) && 
                new RegExp(`(?:e|ep|episode)[._ -]*0*${episode}(?:[^0-9]|$)`, 'i').test(r.SubFileName || '')
            );
            data = [...data, ...filteredFallback];
        }

        if (!Array.isArray(data)) return [];

        return data.filter(e => e.SubDownloadLink).map(e => {
            const format = (e.SubFormat || '').toLowerCase();
            const rawName = (e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara').toLowerCase();
            const isAss = format === 'ass' || format === 'ssa' || rawName.includes('.ass') || rawName.includes('.ssa');
            return {
                url: e.SubDownloadLink,
                format: isAss ? 'ass' : 'srt',
                fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
                _source: 'os_legacy'
            };
        });
    } catch (e) {
        console.log(`[جلب عربي - OS Legacy] خطأ: ${e.message}`);
        return [];
    }
}
