// anilist.js — يجيب أسماء شخصيات الأنمي وأجناسهم من AniList (بدون مفتاح)
// الاستخدام داخل الكود:
//   const { getAnilistCast } = require('./anilist');
//   await getAnilistCast({ kitsuId: 7442 });      // رقم Kitsu (يتحول لرقم MAL تلقائياً)
//   await getAnilistCast({ malId: 16498 });
//   await getAnilistCast({ imdbId: 'tt0388629' }); // رقم IMDb (يتحول عبر ARM)
//   await getAnilistCast({ tvdbId: 81797 });       // رقم TVDB (يتحول عبر ARM)
//   await getAnilistCast({ title: 'Attack on Titan' });
// الاختبار لحاله:  node anilist.js kitsu:7442 | mal:16498 | imdb:tt0388629 | tvdb:81797 | "Attack on Titan"

const axios = require('axios');
let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const ANILIST_URL = 'https://graphql.anilist.co';
const KITSU_URL = 'https://kitsu.io/api/edge';
const ARM_URL = 'https://arm.haglund.dev/api/v2/ids'; // تحويل IMDb / TVDB -> AniList / MAL
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEG_TTL_MS = 60 * 60 * 1000; // كاش "مو أنمي" لساعة حتى ما نكرر الطلب
const MAX_CAST = 40;
const cache = new Map();

const QUERY = `
query ($search: String, $idMal: Int, $id: Int) {
  Media(search: $search, idMal: $idMal, id: $id, type: ANIME) {
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

// IMDb / TVDB -> رقم AniList + MAL (عن طريق ARM)
// notFound=true يعني ARM رد وما لقى العمل (غالباً مو أنمي)، error يعني فشل الاتصال
async function resolveExternal({ imdbId, tvdbId }) {
  const out = { anilistId: null, malId: null, notFound: false, error: null };
  const attempts = [];
  if (imdbId) attempts.push({ source: 'imdb', id: imdbId });
  if (tvdbId) attempts.push({ source: 'thetvdb', id: tvdbId });
  let sawError = false;
  for (const params of attempts) {
    try {
      const r = await axios.get(ARM_URL, { params, timeout: 8000, httpAgent, httpsAgent });
      let d = r.data || {};
      if (Array.isArray(d)) d = d[0] || {};
      const al = parseInt(d.anilist, 10);
      const mal = parseInt(d.myanimelist, 10);
      if (al) out.anilistId = al;
      if (mal) out.malId = mal;
      if (out.anilistId || out.malId) return out;
    } catch (e) {
      if (!(e.response && e.response.status === 404)) { sawError = true; out.error = e.message; }
    }
  }
  out.notFound = !sawError;
  return out;
}

function genderLetter(g) {
  const s = String(g || '').toLowerCase();
  if (s === 'male') return 'M';
  if (s === 'female') return 'F';
  return null;
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
      if (!anilistId && !mal) {
        const data = {
          ok: false,
          reason: x.notFound ? 'غير موجود بقاعدة ARM (غالباً ليس أنمي)' : `ARM فشل: ${x.error}`,
          cast: [], promptBlock: ''
        };
        if (x.notFound) {
          cache.set(cacheKey, { t: Date.now(), ttl: NEG_TTL_MS, data });
          if (cache.size > 200) cache.delete(cache.keys().next().value);
        }
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
    if (!arg) { console.log('مثال: node anilist.js kitsu:7442  أو  mal:16498  أو  imdb:tt0388629  أو  tvdb:81797  أو  "Attack on Titan"'); process.exit(1); }
    const input = arg.startsWith('kitsu:') ? { kitsuId: arg.slice(6) }
      : arg.startsWith('mal:') ? { malId: arg.slice(4) }
      : arg.startsWith('imdb:') ? { imdbId: arg.slice(5) }
      : arg.startsWith('tvdb:') ? { tvdbId: arg.slice(5) }
      : { title: arg };
    const t0 = Date.now();
    const r = await getAnilistCast(input);
    console.log(`النتيجة: ${r.ok ? 'نجح' : 'فشل'} | ${r.title || ''} | ${Date.now() - t0}ms`);
    if (!r.ok) console.log('السبب:', r.reason);
    r.cast.forEach(c => console.log(`  ${c.character}  ->  ${c.gender}`));
    console.log('\n--- النص اللي يروح للذكاء الاصطناعي ---\n' + r.promptBlock);
  })();
}
