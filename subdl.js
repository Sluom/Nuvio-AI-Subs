// subdl.js
const axios = require('axios');

const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DL = 'https://dl.subdl.com';
const SUBDL_STREM = 'https://subdl.strem.top';
const SUBDL_MIRROR = 'https://subdl-stremio.vercel.app';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const USER_AGENTS = [BROWSER_UA, 'NuvioSubtitles v1.0.0'];

const SUBDL_LANGS = {
  EN: 'eng', JA: 'jpn', TR: 'tur', FA: 'per', RU: 'rus',
  KO: 'kor', FR: 'fre', ES: 'spa', HI: 'hin', PT: 'por',
  BR_PT: 'pob', ZH: 'chi', DE: 'ger', IT: 'ita', ID: 'ind',
  AR: 'ara'
};
const FOREIGN_LANGS = Object.keys(SUBDL_LANGS).filter(c => c !== 'AR');

const NAME_TO_CODE = {
  english: 'EN', japanese: 'JA', turkish: 'TR', farsi_persian: 'FA', persian: 'FA',
  russian: 'RU', korean: 'KO', french: 'FR', spanish: 'ES', hindi: 'HI',
  portuguese: 'PT', brazilian_portuguese: 'BR_PT', chinese: 'ZH',
  german: 'DE', italian: 'IT', indonesian: 'ID', arabic: 'AR'
};

const ALIAS_TO_CODE = {
  en: 'EN', eng: 'EN', ja: 'JA', jpn: 'JA', jap: 'JA', tr: 'TR', tur: 'TR',
  fa: 'FA', per: 'FA', fas: 'FA', ru: 'RU', rus: 'RU', ko: 'KO', kor: 'KO',
  fr: 'FR', fre: 'FR', fra: 'FR', es: 'ES', spa: 'ES', hi: 'HI', hin: 'HI',
  pt: 'PT', por: 'PT', pt_br: 'BR_PT', br_pt: 'BR_PT', pb: 'BR_PT', pob: 'BR_PT',
  zh: 'ZH', zho: 'ZH', chi: 'ZH', chs: 'ZH', cht: 'ZH',
  de: 'DE', ger: 'DE', deu: 'DE', it: 'IT', ita: 'IT', id: 'ID', ind: 'ID',
  ar: 'AR', ara: 'AR', ar_sa: 'AR'
};

function detectLang(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (ALIAS_TO_CODE[s]) return ALIAS_TO_CODE[s];
  if (NAME_TO_CODE[s]) return NAME_TO_CODE[s];
  const first = s.split(/[_(]/)[0];
  return ALIAS_TO_CODE[first] || NAME_TO_CODE[first] || null;
}

const HI_REGEX = /\bsdh\b|\bcc\b|hearing[\s._-]*impaired|hard[\s._-]*of[\s._-]*hearing|\bhoh\b|closed[\s._-]*caption|\bdeaf\b|\bh\.i\b/;

function looksHearingImpaired(item, langCode) {
  if (item.hi === true || item.hi === 1 || item.hi === '1') return true;
  const text = [item.release_name, item.name, item.SubFileName, item.title, item.id, item.url]
    .filter(Boolean).map(x => String(x).toLowerCase()).join(' ');
  if (HI_REGEX.test(text)) return true;
  return langCode !== 'HI' && /[\s._-]hi[\s._-]/.test(` ${text} `);
}

function guessFormat(item, url) {
  const t = [url, item.release_name, item.name, item.SubFileName, item.title]
    .filter(Boolean).join(' ').toLowerCase();
  return (/\.(ass|ssa)(?:$|[?\s])/.test(t) || /\[(ass\vert{}ssa)\]/.test(t)) ? 'ass' : 'srt';
}

const cleanPath = p => String(p).split('?')[0];
const errText = e => `${e?.response?.status || e?.code || ''} ${e?.message || ''}`.trim();

function absUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `${SUBDL_DL}${s.startsWith('/') ? '' : '/'}${s}`;
}

function makeSub({ url, name, langCode, hi, format, route }) {
  return {
    url,
    fileName: name || 'SubDL',
    lang: SUBDL_LANGS[langCode] || 'eng',
    langCode,
    hearingImpaired: !!hi,
    format,
    _source: 'subdl',
    _route: route
  };
}

async function getJson(url, timeout) {
  let lastErr = null;
  for (let i = 0; i < USER_AGENTS.length; i++) {
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENTS[i], 'Accept': 'application/json' },
        timeout
      });
      return r.data;
    } catch (e) {
      lastErr = e;
      if (e?.response?.status !== 403) break;
    }
  }
  throw lastErr;
}

async function fetchOfficial({ key, imdbId, season, episode, isSeries, wanted, includePacks }) {
  const baseParams = {
    imdb_id: imdbId,
    languages: wanted.join(','),
    type: isSeries ? 'tv' : 'movie',
    subs_per_page: '30'
  };
  if (isSeries) {
    baseParams.season_number = String(season);
    baseParams.episode_number = String(episode);
    baseParams.season = String(season);
    baseParams.episode = String(episode);
  }

  const query = async extra => {
    const params = new URLSearchParams({ api_key: key, ...baseParams, ...extra });
    const data = (await getJson(`${SUBDL_API}?${params.toString()}`, 10000)) || {};
    if (!data.status || !Array.isArray(data.subtitles)) {
      console.log(`[SubDL] رد غير متوقع: ${data.error || 'بدون تفاصيل'}`);
      return [];
    }
    return data.subtitles;
  };

  const [normalRes, hiRes] = await Promise.allSettled([query({}), query({ hi: '1' })]);
  if (normalRes.status === 'rejected' && hiRes.status === 'rejected') throw normalRes.reason;

  const normal = normalRes.status === 'fulfilled' ? normalRes.value : [];
  const hiList = hiRes.status === 'fulfilled' ? hiRes.value : [];
  const hiPaths = new Set(hiList.filter(s => s && s.url && s.hi === true).map(s => cleanPath(s.url)));
  const wantedSet = new Set(wanted);

  console.log(`[SubDL API] عادي=${normal.length} HI=${hiList.length} | ` + normal.slice(0, 4).map(s => `S${s.season}E${s.episode} full=${s.full_season} ${s.release_name || s.name}`).join(' | '));

  const out = [];
  for (const s of [...normal, ...hiList]) {
    if (!s || !s.url) continue;
    if (s.full_season) {
      if (!includePacks) continue;
      if (isSeries && s.season != null && Number(s.season) !== Number(season)) continue;
    } else if (isSeries && s.episode != null && Number(s.episode) !== Number(episode)) continue;
    
    const langCode = detectLang(s.language) || detectLang(s.lang);
    if (!langCode || !wantedSet.has(langCode)) continue;
    const path = cleanPath(s.url);
    out.push(makeSub({
      url: absUrl(path),
      name: s.release_name || s.name,
      langCode,
      hi: hiPaths.has(path) || looksHearingImpaired(s, langCode),
      format: guessFormat(s, path),
      route: 'official'
    }));
  }
  return out;
}

function mapStremioList(list, route, wantedSet, fallbackLang) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.url) continue;
    const langCode = detectLang(item.lang || item.language) || fallbackLang || null;
    if (!langCode || !wantedSet.has(langCode)) continue;
    const url = absUrl(item.url);
    const name = item.release_name || item.name || item.SubFileName || item.title || item.id;
    out.push(makeSub({
      url,
      name: name ? String(name) : '',
      langCode,
      hi: looksHearingImpaired(item, langCode),
      format: guessFormat(item, url),
      route
    }));
  }
  return out;
}

function stremConfig(key, langCode) {
  return Buffer.from(`${key}/${langCode}/hiInclude/`).toString('base64').replace(/=/g, '');
}

async function fetchStremTop({ key, imdbId, season, episode, isSeries, langCode, wantedSet }) {
  const mediaType = isSeries ? 'series' : 'movie';
  const targetId = isSeries ? `${imdbId}:${season}:${episode}` : imdbId;
  const data = await getJson(`${SUBDL_STREM}/${stremConfig(key, langCode)}/subtitles/${mediaType}/${targetId}.json`, 9000);
  return mapStremioList(data && data.subtitles, 'strem.top', wantedSet, langCode);
}

async function fetchMirror({ imdbId, season, episode, isSeries, wanted, wantedSet }) {
  const mediaType = isSeries ? 'series' : 'movie';
  const targetId = isSeries ? `${imdbId}:${season}:${episode}` : imdbId;
  const data = await getJson(`${SUBDL_MIRROR}/subtitles/${mediaType}/${targetId}.json`, 5000);
  return mapStremioList(data && data.subtitles, 'mirror', wantedSet, wanted.length === 1 ? wanted[0] : null);
}

async function getSubDL({ imdbId, season, episode, apiKey, languages, includePacks }) {
  const key = String(apiKey || '').trim();
  if (!key) {
    console.log('[SubDL] لا يوجد مفتاح SubDL في إعدادات الإضافة، تخطيت SubDL.');
    return [];
  }
  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    console.log(`[SubDL] رقم IMDb غير صالح (${imdbId || 'فاضي'})، تخطيت SubDL.`);
    return [];
  }

  const isSeries = season != null && episode != null;
  const wanted = (languages && languages.length ? languages : FOREIGN_LANGS)
    .map(c => String(c).toUpperCase()).filter(c => SUBDL_LANGS[c]);
  if (!wanted.length) return [];
  const wantedSet = new Set(wanted);
  const proxyLang = wanted.includes('EN') ? 'EN' : wanted[0];
  const tag = `${imdbId}${isSeries ? ` S${season}E${episode}` : ''} [${wanted.length === 1 ? wanted[0] : 'عدة لغات'}]`;

  const routes = [
    ['official', () => fetchOfficial({ key, imdbId, season, episode, isSeries, wanted, includePacks })],
    ['strem.top', () => fetchStremTop({ key, imdbId, season, episode, isSeries, langCode: proxyLang, wantedSet })]
  ];
  const settled = await Promise.allSettled(routes.map(([, fn]) => fn()));

  settled.forEach((r, i) => {
    if (r.status === 'rejected') console.log(`[SubDL] مسار ${routes[i][0]} فشل لـ ${tag}: ${errText(r.reason)}`);
  });
  console.log(`[SubDL] ${tag}: ` + settled.map((r, i) => `${routes[i][0]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | '));

  const seen = new Set();
  const unique = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => {
      const k = cleanPath(s.url);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  unique.sort((a, b) => (+a.hearingImpaired - +b.hearingImpaired) || ((b.lang === 'eng') - (a.lang === 'eng')));

  const hiCount = unique.filter(s => s.hearingImpaired).length;
  console.log(`[SubDL] المجموع بعد حذف المكرر: ${unique.length} ترجمة لـ ${tag} (${hiCount} SDH/HI بالنهاية).`);
  return unique;
}

module.exports = { getSubDL, SUBDL_LANGS, FOREIGN_LANGS };
