// subsource.js
const axios = require('axios');

const SUBSOURCE_BASE = 'https://api.subsource.net/api/v1';
const SUBSOURCE_STREM = 'https://subsource.strem.top';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LANGS = {
  arabic: { iso3: 'ara', prefix: 'ar' },
  english: { iso3: 'eng', prefix: 'en' }
};

const MAX_RESULTS = 60;

const cleanPath = p => String(p).split('?')[0];
const errText = e => `${e?.response?.status || e?.code || ''} ${e?.response?.data?.message || e?.message || ''}`.trim();

function normalizeSubsourceUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^subsource:\/\//i.test(s)) {
    const id = s.replace(/^subsource:\/\//i, '').split('?')[0].replace(/\/+$/, '');
    return id ? `${SUBSOURCE_BASE}/subtitles/${id}/download` : '';
  }
  return s;
}

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
  const ep = Number(episode);

  const se = n.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/i);
  if (se) return Number(se[1]) === Number(season) && Number(se[2]) === ep;

  const range = n.match(/(?:^|[^a-z0-9])(?:e|ep|episodes?)[ ._-]*0*(\d{1,3})\s*(?:-|~|to)\s*(?:e|ep)?[ ._-]*0*(\d{1,3})(?![0-9])/i)
    || n.match(/(?<![a-z0-9])0*(\d{1,3})\s*(?:-|~)\s*0*(\d{1,3})(?![0-9a-z])/i);
  if (range) return ep >= Number(range[1]) && ep <= Number(range[2]);

  const e = n.match(/(?:^|[^a-z0-9])(?:e|ep|episode)[ ._-]*0*(\d{1,3})(?![0-9])/i);
  if (e) return ep === Number(e[1]);

  const seasons = [...n.matchAll(/\bs(\d{1,2})\b/gi)].map(m => Number(m[1]));
  if (seasons.length) return seasons.includes(Number(season));

  return true;
}

function isHi(item, nameStr) {
  const flag = item.hearingImpaired ?? item.hearing_impaired ?? item.hi;
  if (flag === true || flag === 1 || flag === '1') return true;
  return /\bsdh\b|\bhoh\b|hearing[\s._-]*impaired|closed[\s._-]*caption|\bcc\b/i.test(String(nameStr || ''));
}

const formatOf = name => (/\.(ass|ssa)\b|\[(ass\vert{}ssa)\]/i.test(String(name || '')) ? 'ass' : 'srt');

function makeSub({ url, name, language, hi, route }) {
  return {
    url,
    format: formatOf(name),
    fileName: name,
    lang: (LANGS[language] || {}).iso3 || 'eng',
    hearingImpaired: !!hi,
    _source: 'subsource',
    _route: route
  };
}

async function getAllSubtitles(movieId, headers, language) {
  const all = [];
  const seenIds = new Set();
  for (let page = 1; page <= 5; page++) {
    let res;
    try {
      res = await axios.get(`${SUBSOURCE_BASE}/subtitles`, {
        params: { movieId, language, page, limit: 100 }, headers, timeout: 10000
      });
    } catch (e) {
      if (page > 1) break;
      res = await axios.get(`${SUBSOURCE_BASE}/subtitles`, {
        params: { movieId }, headers, timeout: 10000
      });
    }
    const list = pickList(res.data);
    const fresh = list.filter(x => {
      const id = x.subtitleId ?? x.id;
      if (id == null || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    console.log(`[Subsource API] صفحة ${page}: ${list.length} نتيجة، الجديد ${fresh.length}`);
    all.push(...fresh);
    if (fresh.length === 0 || list.length < 20) break;
  }
  return all;
}

async function fetchApi({ key, imdbId, season, episode, isSeries, language }) {
  const headers = { 'X-API-Key': key, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

  const search = await axios.get(`${SUBSOURCE_BASE}/movies/search`, {
    params: { imdb: imdbId, searchType: 'imdb' }, headers, timeout: 8000
  });

  const movies = pickList(search.data);
  if (!movies.length) return [];
  let movie = movies[0];
  if (isSeries) {
    const bySeason = movies.find(m => m && m.season != null && Number(m.season) === Number(season));
    if (bySeason) movie = bySeason;
  }
  const movieId = movie.movieId ?? movie.id;
  if (movieId == null) throw new Error(`لقيت العمل لكن بدون movieId (الحقول: ${Object.keys(movie).join(',')})`);

  const rawList = await getAllSubtitles(movieId, headers, language);

  const pfx = (LANGS[language] || {}).prefix || String(language).slice(0, 2);
  const langList = rawList.filter(x => String(x.language || '').toLowerCase().startsWith(pfx));
  console.log(`[Subsource API] movieId=${movieId} | خام=${rawList.length} | باللغة=${langList.length} | أسماء: ` + langList.slice(0, 3).map(x => [].concat(x.releaseInfo || x.release_info || x.name || '').join(' ')).join(' | '));

  const out = [];
  for (const x of langList) {
    const id = x.subtitleId ?? x.id;
    if (id == null) continue;
    const name = x.releaseInfo || x.release_info || x.name || x.releaseName || `Subsource_${id}`;
    const nameStr = Array.isArray(name) ? name.join(' ') : String(name);
    if (isSeries && !subsourceEpisodeOk(nameStr, season, episode)) continue;
    out.push(makeSub({
      url: `${SUBSOURCE_BASE}/subtitles/${id}/download`,
      name: nameStr, language, hi: isHi(x, nameStr), route: 'api'
    }));
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function stremConfig(key, language) {
  return Buffer.from(`${key}/${language}/hiInclude/type:0/`).toString('base64');
}

async function fetchStrem({ key, imdbId, season, episode, isSeries, language }) {
  const mediaType = isSeries ? 'series' : 'movie';
  const targetId = isSeries ? `${imdbId}:${season}:${episode}` : imdbId;
  const r = await axios.get(`${SUBSOURCE_STREM}/${stremConfig(key, language)}/subtitles/${mediaType}/${targetId}.json`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
    timeout: 9000
  });
  const list = Array.isArray(r.data?.subtitles) ? r.data.subtitles : [];
  const prefix = (LANGS[language] || {}).prefix || String(language).slice(0, 2);

  const out = [];
  for (const item of list) {
    if (!item) continue;
    const url = normalizeSubsourceUrl(item.url);
    if (!url) continue;
    const rawLang = String(item.lang || item.language || '').toLowerCase();
    if (rawLang && !rawLang.startsWith(prefix)) continue;
    const name = String(item.release_name || item.name || item.SubFileName || item.title || item.id || '');
    out.push(makeSub({ url, name, language, hi: isHi(item, `${name} ${item.url}`), route: 'strem.top' }));
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function getSubSource({ imdbId, season, episode, apiKey, language = 'arabic' }) {
  const key = String(apiKey || '').trim();
  if (!key) {
    console.log('[Subsource] لا يوجد مفتاح Subsource في إعدادات الإضافة - تم التخطي.');
    return [];
  }
  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    console.log(`[Subsource] رقم IMDb غير صالح (${imdbId || 'فاضي'})، تخطيت Subsource.`);
    return [];
  }

  const isSeries = season != null && episode != null;
  const tag = `${imdbId}${isSeries ? ` S${season}E${episode}` : ''} [${language}]`;
  const args = { key, imdbId, season, episode, isSeries, language };

  const routes = [
    ['api', () => fetchApi(args)]
  ];
  const settled = await Promise.allSettled(routes.map(([, fn]) => fn()));

  settled.forEach((r, i) => {
    if (r.status === 'rejected') console.log(`[Subsource] مسار ${routes[i][0]} فشل لـ ${tag}: ${errText(r.reason)}`);
  });
  console.log(`[Subsource] ${tag}: ` + settled.map((r, i) => `${routes[i][0]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | '));

  const seen = new Set();
  const unique = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => {
      const k = cleanPath(s.url);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_RESULTS);

  const looksSrt = s => /netflix|webrip|web-dl|amzn|shahid/i.test(s.fileName || '');
  unique.sort((a, b) => (+a.hearingImpaired - +b.hearingImpaired) || (+looksSrt(a) - +looksSrt(b)));
  
  console.log(`[Subsource] المجموع بعد حذف المكرر: ${unique.length} ترجمة لـ ${tag}.`);
  return unique;
}

module.exports = { getSubSource, normalizeSubsourceUrl };
