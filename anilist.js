const axios = require('axios');
let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const ANILIST_URL = 'https://graphql.anilist.co';
const KITSU_URL = 'https://kitsu.io/api/edge';
const ARM_URL = 'https://arm.haglund.dev/api/v2/ids';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEG_TTL_MS = 60 * 60 * 1000;
const MAX_CAST = 40;
const cache = new Map();

const cacheSet = (key, entry) => {
  cache.set(key, entry);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
};

const QUERY = `query ($search: String, $idMal: Int, $id: Int) { Media(search: $search, idMal: $idMal, id: $id, type: ANIME) { id title { romaji english } description(asHtml: false) characters(sort: [ROLE, FAVOURITES_DESC], perPage: 30) { edges { role node { name { full } gender } } } } }`;

async function resolveKitsu(kitsuId) {
  const out = { malId: null, title: '' };
  try {
    const m = await axios.get(`${KITSU_URL}/anime/${kitsuId}/mappings`, {
      params: { 'filter[externalSite]': 'myanimelist/anime' },
      headers: { Accept: 'application/vnd.api+json' },
      timeout: 8000, httpAgent, httpsAgent
    });
    const row = (m.data && m.data.data || [])[0];
    if (row && row.attributes && row.attributes.externalId) out.malId = parseInt(row.attributes.externalId, 10);
  } catch (e) {}
  if (!out.malId) {
    try {
      const a = await axios.get(`${KITSU_URL}/anime/${kitsuId}`, {
        headers: { Accept: 'application/vnd.api+json' }, timeout: 8000, httpAgent, httpsAgent
      });
      const t = a.data && a.data.data && a.data.data.attributes && a.data.data.attributes.titles;
      out.title = (t && (t.en || t.en_jp)) || '';
    } catch (e) {}
  }
  return out;
}

async function getTitleFromCinemeta(imdbId) {
  for (const kind of ['series', 'movie']) {
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { timeout: 6000 });
      if (r.data && r.data.meta && r.data.meta.name) return r.data.meta.name;
    } catch (e) {}
  }
  return null;
}

async function resolveExternal({ imdbId, tvdbId }) {
  const out = { anilistId: null, malId: null, notFound: false, error: null };
  const attempts = [];
  if (imdbId) attempts.push({ source: 'imdb', id: imdbId });
  if (tvdbId) attempts.push({ source: 'tvdb', id: tvdbId });

  let sawError = false;
  for (const param of attempts) {
    try {
      const r = await axios.get(`${ARM_URL}?source=${param.source}&id=${param.id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
        timeout: 8000, httpAgent, httpsAgent
      });
      let d = r.data || {};
      if (Array.isArray(d)) d = d[0] || {};
      const al = parseInt(d.anilist, 10);
      const mal = parseInt(d.myanimelist, 10);
      if (al) out.anilistId = al;
      if (mal) out.malId = mal;
      if (out.anilistId || out.malId) return out;
    } catch (e) {
      if (!(e.response && e.response.status === 404)) {
        sawError = true;
        out.error = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      }
    }
  }
  out.notFound = !sawError;
  return out;
}

function genderLetter(g) {
  const s = String(g || '').toLowerCase();
  return s === 'male' ? 'M' : s === 'female' ? 'F' : null;
}

async function getAnilistCast({ kitsuId, malId, imdbId, tvdbId, title } = {}) {
  const cacheKey = `${kitsuId || ''}|${malId || ''}|${imdbId || ''}|${tvdbId || ''}|${title || ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < (hit.ttl || CACHE_TTL_MS)) return hit.data;

  try {
    let mal = malId ? parseInt(malId, 10) : null;
    let anilistId = null;
    let search = title || '';

    if (kitsuId && !mal) {
      const k = await resolveKitsu(kitsuId);
      mal = k.malId;
      if (!mal) search = k.title;
    }

    if (!mal && !anilistId && (imdbId || tvdbId)) {
      const x = await resolveExternal({ imdbId, tvdbId });
      anilistId = x.anilistId;
      mal = x.malId;

      if (!anilistId && !mal && imdbId) {
        const cinemetaTitle = await getTitleFromCinemeta(imdbId);
        if (cinemetaTitle) search = cinemetaTitle;
      }

      if (!anilistId && !mal && !search) {
        const data = {
          ok: false,
          reason: x.notFound ? 'غير موجود بقاعدة ARM (غالباً ليس أنمي)' : `ARM فشل: ${x.error}`,
          cast: [], promptBlock: ''
        };
        if (x.notFound) cacheSet(cacheKey, { t: Date.now(), ttl: NEG_TTL_MS, data });
        return data;
      }
    }

    if (!mal && !anilistId && !search) return { ok: false, reason: 'ما قدرت أحدد الأنمي', cast: [], promptBlock: '' };

    const variables = anilistId ? { id: anilistId } : (mal ? { idMal: mal } : { search });
    const r = await axios.post(ANILIST_URL, { query: QUERY, variables }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000, httpAgent, httpsAgent
    });
    const media = r.data && r.data.data && r.data.data.Media;
    if (!media) return { ok: false, reason: 'ما لقيت الأنمي على AniList', cast: [], promptBlock: '' };

    const cleanDesc = (media.description || '').replace(/<[^>]*>?/gm, '').trim();

    const cast = [];
    const seen = new Set();
    for (const e of (media.characters && media.characters.edges) || []) {
      const name = e.node && e.node.name && e.node.name.full;
      const g = genderLetter(e.node && e.node.gender);
      if (!name || !g) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      cast.push({ character: name, gender: g, role: e.role });
      if (cast.length >= MAX_CAST) break;
    }

    const promptBlock = cast.length
      ? `STORY OVERVIEW:\n${cleanDesc || 'No overview available.'}\n\nKNOWN CHARACTERS (from AniList; M = male, F = female). Use only to decide gender when the line or story clearly refers to this character:\n` +
        cast.map(c => `${c.character} = ${c.gender}`).join('\n')
      : '';

    const data = {
      ok: cast.length > 0, source: 'anilist', kind: 'anime',
      title: (media.title && (media.title.english || media.title.romaji)) || '',
      cast, promptBlock
    };
    cacheSet(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, reason: `AniList فشل: ${e.message}`, cast: [], promptBlock: '' };
  }
}

module.exports = { getAnilistCast };
