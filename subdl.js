const axios = require('axios');

const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DL = 'https://dl.subdl.com';

// الكود في SubDL -> الكود المستخدم عندك بالـ index (بدون أي أولوية)
const SUBDL_LANGS = {
  EN: 'eng', JA: 'jpn', TR: 'tur', FA: 'per', RU: 'rus',
  KO: 'kor', FR: 'fre', ES: 'spa', HI: 'hin', PT: 'por',
  BR_PT: 'pob', ZH: 'chi', DE: 'ger', IT: 'ita', ID: 'ind'
};
const ALL_LANGS = Object.keys(SUBDL_LANGS);

const NAME_TO_CODE = {
  english: 'EN', japanese: 'JA', turkish: 'TR', farsi_persian: 'FA', persian: 'FA',
  russian: 'RU', korean: 'KO', french: 'FR', spanish: 'ES', hindi: 'HI',
  portuguese: 'PT', brazilian_portuguese: 'BR_PT', chinese: 'ZH',
  german: 'DE', italian: 'IT', indonesian: 'ID'
};

function detectLang(s) {
  const code = String(s.language || '').toUpperCase().trim();
  if (SUBDL_LANGS[code]) return code;
  const name = String(s.lang || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return NAME_TO_CODE[name] || null;
}

// كشف نسخ الصم وضعاف السمع: الحقل الرسمي أولاً، ثم الأسماء البديلة
function isHearingImpaired(s, langCode) {
  if (s.hi === true || s.hi === 1 || s.hi === '1') return true;

  const text = [s.release_name, s.name, s.url]
    .filter(Boolean).map(x => String(x).toLowerCase()).join(' ');

  const patterns = [
    /\bsdh\b/,
    /\bcc\b/,
    /hearing[\s._-]*impaired/,
    /hard[\s._-]*of[\s._-]*hearing/,
    /\bhoh\b/,
    /closed[\s._-]*caption/,
    /\bdeaf\b/,
    /\bh\.i\b/
  ];
  if (patterns.some(p => p.test(text))) return true;

  // "hi" لوحدها تعني Hearing Impaired، لكن نتجاهلها مع الهندية لأنها كود لغتها
  if (langCode !== 'HI' && /[\s._-]hi[\s._-]/.test(` ${text} `)) return true;

  return false;
}

async function querySubDL(key, baseParams, extra) {
  const params = new URLSearchParams({ api_key: key, ...baseParams, ...extra });
  const res = await axios.get(`${SUBDL_API}?${params.toString()}`, {
    headers: { 'User-Agent': 'NuvioSubtitles v1.0.0', 'Accept': 'application/json' },
    timeout: 10000
  });
  const data = res.data || {};
  if (!data.status || !Array.isArray(data.subtitles)) {
    console.log(`[SubDL] رد غير متوقع: ${data.error || 'بدون تفاصيل'}`);
    return [];
  }
  return data.subtitles;
}

// رابط بدون ?api_key=... عشان المفتاح ما يوصل للمستخدمين
const cleanPath = p => String(p).split('?')[0];

async function getSubDLEnglish({ imdbId, season, episode, apiKey, languages }) {
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
  const wanted = (languages && languages.length ? languages : ALL_LANGS);

  const baseParams = {
    imdb_id: imdbId,
    languages: wanted.join(','),
    type: isSeries ? 'tv' : 'movie',
    subs_per_page: '30'
  };
  if (isSeries) {
    baseParams.season_number = String(season);
    baseParams.episode_number = String(episode);
  }

  try {
    // طلب عادي (كل الترجمات) + طلب hi=1 (لمعرفة نسخ SDH فقط) بالتوازي
    const [normalRes, hiRes] = await Promise.allSettled([
      querySubDL(key, baseParams, {}),
      querySubDL(key, baseParams, { hi: '1' })
    ]);

    const normal = normalRes.status === 'fulfilled' ? normalRes.value : [];
    const hiList = hiRes.status === 'fulfilled' ? hiRes.value : [];

    if (normalRes.status === 'rejected') {
      console.log(`[SubDL] فشل الطلب العادي لـ ${imdbId}: ${normalRes.reason.message}`);
    }

    // روابط نسخ SDH المؤكدة من الحقل الرسمي
    const hiPaths = new Set(
      hiList.filter(s => s && s.url && s.hi === true).map(s => cleanPath(s.url))
    );

    const list = [...normal, ...hiList]
      .filter(s => s && s.url && !s.full_season)
      .map(s => {
        const langCode = detectLang(s);
        if (!langCode || !wanted.includes(langCode)) return null;

        const path = cleanPath(s.url);
        const url = path.startsWith('http') ? path : `${SUBDL_DL}${path.startsWith('/') ? '' : '/'}${path}`;

        return {
          url,
          fileName: s.release_name || s.name || 'SubDL',
          lang: SUBDL_LANGS[langCode],
          langCode,
          hearingImpaired: hiPaths.has(path) || isHearingImpaired(s, langCode),
          _source: 'subdl'
        };
      })
      .filter(Boolean);

    // إزالة التكرار
    const seen = new Set();
    const unique = list.filter(s => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    // الاحترافي أولاً، SDH/HI بالنهاية (sort مستقر)
    unique.sort((a, b) => (a.hearingImpaired ? 1 : 0) - (b.hearingImpaired ? 1 : 0));

    const hiCount = unique.filter(s => s.hearingImpaired).length;
    console.log(`[SubDL] رجّع ${unique.length} ترجمة لـ ${imdbId}${isSeries ? ` (S${season}E${episode})` : ''} (${hiCount} SDH/HI بالنهاية).`);
    return unique;
  } catch (e) {
    console.log(`[SubDL] فشل لـ ${imdbId}: ${e.message}`);
    return [];
  }
}
module.exports = { getSubDLEnglish, SUBDL_LANGS };
