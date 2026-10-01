// anilist.js — يجيب أسماء شخصيات الأنمي وأجناسهم من AniList (بدون مفتاح)
// الاستخدام داخل الكود:
//   const { getAnilistCast } = require('./anilist');
//   await getAnilistCast({ kitsuId: 7442 });      // رقم Kitsu (يتحول لرقم MAL تلقائياً)
//   await getAnilistCast({ malId: 16498 });
//   await getAnilistCast({ title: 'Attack on Titan' });
// الاختبار لحاله:  node anilist.js kitsu:7442   |   node anilist.js mal:16498   |   node anilist.js "Attack on Titan"

const axios = require('axios');
let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const ANILIST_URL = 'https://graphql.anilist.co';
const KITSU_URL = 'https://kitsu.io/api/edge';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CAST = 40;
const cache = new Map();

const QUERY = `
query ($search: String, $idMal: Int) {
  Media(search: $search, idMal: $idMal, type: ANIME) {
    id
    title { romaji english }
    characters(sort: [ROLE, FAVOURITES_DESC], perPage: 30) {
      edges { role node { name { full } gender } }
    }
  }
}`;

// Kitsu -> رقم MAL + العنوان
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

function genderLetter(g) {
  const s = String(g || '').toLowerCase();
  if (s === 'male') return 'M';
  if (s === 'female') return 'F';
  return null;
}

async function getAnilistCast({ kitsuId, malId, title } = {}) {
  const cacheKey = `${kitsuId || ''}|${malId || ''}|${title || ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;

  try {
    let mal = malId ? parseInt(malId, 10) : null;
    let search = title || '';
    if (kitsuId && !mal) {
      const k = await resolveKitsu(kitsuId);
      mal = k.malId;
      if (!mal) search = k.title;
    }
    if (!mal && !search) return { ok: false, reason: 'ما قدرت أحدد الأنمي', cast: [], promptBlock: '' };

    const variables = mal ? { idMal: mal } : { search };
    const r = await axios.post(ANILIST_URL, { query: QUERY, variables }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000, httpAgent, httpsAgent
    });
    const media = r.data && r.data.data && r.data.data.Media;
    if (!media) return { ok: false, reason: 'ما لقيت الأنمي على AniList', cast: [], promptBlock: '' };

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
      ? 'KNOWN CHARACTERS (from AniList; M = male, F = female). Use only to decide gender when the line or story clearly refers to this character:\n' +
        cast.map(c => `${c.character} = ${c.gender}`).join('\n')
      : '';

    const data = {
      ok: cast.length > 0, source: 'anilist', kind: 'anime',
      title: (media.title && (media.title.english || media.title.romaji)) || '',
      cast, promptBlock
    };
    cache.set(cacheKey, { t: Date.now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return data;
  } catch (e) {
    return { ok: false, reason: `AniList فشل: ${e.message}`, cast: [], promptBlock: '' };
  }
}

module.exports = { getAnilistCast };

// ---------- اختبار مباشر ----------
if (require.main === module) {
  (async () => {
    const arg = process.argv.slice(2).join(' ').trim();
    if (!arg) { console.log('مثال: node anilist.js kitsu:7442  أو  node anilist.js mal:16498  أو  node anilist.js "Attack on Titan"'); process.exit(1); }
    const input = arg.startsWith('kitsu:') ? { kitsuId: arg.slice(6) }
      : arg.startsWith('mal:') ? { malId: arg.slice(4) }
      : { title: arg };
    const t0 = Date.now();
    const r = await getAnilistCast(input);
    console.log(`النتيجة: ${r.ok ? 'نجح' : 'فشل'} | ${r.title || ''} | ${Date.now() - t0}ms`);
    if (!r.ok) console.log('السبب:', r.reason);
    r.cast.forEach(c => console.log(`  ${c.character}  ->  ${c.gender}`));
    console.log('\n--- النص اللي يروح للذكاء الاصطناعي ---\n' + r.promptBlock);
  })();
}
