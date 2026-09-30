const axios = require('axios');

// جلب ترجمات انجليزية من SubDL عبر الـ API الرسمي فقط (بمفتاحك من ريندر: SUBDL_API_KEY)
// الوثائق الرسمية: https://subdl.com/api-doc
// - type لازم يكون movie أو tv (مو series)
// - رابط التحميل = https://dl.subdl.com + المسار اللي يرجع بالرد
// - الملف غالباً zip، والدالة fetchAndExtractSub بملف ai.js تفتحه وتاخذ منه srt/ass

const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DL = 'https://dl.subdl.com';

async function getSubDLEnglish({ imdbId, season, episode, apiKey }) {
  const key = String(apiKey || process.env.SUBDL_API_KEY || '').trim();

  if (!key) {
    console.log('[SubDL] المتغير SUBDL_API_KEY مفقود بريندر، تخطيت SubDL.');
    return [];
  }
  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    console.log(`[SubDL] رقم IMDb غير صالح (${imdbId || 'فاضي'})، تخطيت SubDL.`);
    return [];
  }

  const isSeries = season != null && episode != null;

  const params = new URLSearchParams({
    api_key: key,
    imdb_id: imdbId,
    languages: 'EN',
    type: isSeries ? 'tv' : 'movie',
    subs_per_page: '30',
    hi: '1'
  });
  if (isSeries) {
    params.set('season_number', String(season));
    params.set('episode_number', String(episode));
  }

  try {
    const res = await axios.get(`${SUBDL_API}?${params.toString()}`, {
      headers: { 'User-Agent': 'NuvioSubtitles v1.0.0', 'Accept': 'application/json' },
      timeout: 10000
    });

    const data = res.data || {};
    if (!data.status || !Array.isArray(data.subtitles)) {
      console.log(`[SubDL] رد غير متوقع لـ ${imdbId}: ${data.error || 'بدون تفاصيل'}`);
      return [];
    }

    const list = data.subtitles
      .filter(s => s && s.url && !s.full_season)
      .filter(s => {
        const lang = String(s.lang || s.language || 'en').toLowerCase();
        return lang.startsWith('en');
      })
      .map(s => {
        const path = String(s.url);
        const url = path.startsWith('http') ? path : `${SUBDL_DL}${path.startsWith('/') ? '' : '/'}${path}`;
        const name = s.release_name || s.name || 'SubDL';
        const isHi = s.hi === true || s.hi === 1 || s.hi === '1';
        return { url, fileName: name, hearingImpaired: isHi, _source: 'subdl' };
      });

    // النسخ العادية أولاً، ونسخ الصم وضعاف السمع للآخر
    list.sort((a, b) => (a.hearingImpaired ? 1 : 0) - (b.hearingImpaired ? 1 : 0));

    // إزالة التكرار
    const seen = new Set();
    const unique = list.filter(s => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    console.log(`[SubDL] رجّع ${unique.length} ترجمة انجليزية لـ ${imdbId}${isSeries ? ` (S${season}E${episode})` : ''}.`);
    return unique;
  } catch (e) {
    const status = e.response?.status || 0;
    const msg = e.response?.data?.error || e.message;
    console.log(`[SubDL] فشل الطلب لـ ${imdbId} (status:${status}) ${msg}`);
    return [];
  }
}

module.exports = { getSubDLEnglish };
