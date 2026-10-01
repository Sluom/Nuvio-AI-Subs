// tmdb.js — يجيب أسماء الشخصيات وجنس الممثلين من TMDB
const axios = require('axios');
let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CAST = 40;
const cache = new Map();

// التعديل هنا: صار يقبل المفتاح اللي يجي من المستخدم كأولوية أولى
function authConfig(userKey) {
  const rawKey = userKey || process.env.TMDB_API_KEY || '';
  const key = String(rawKey).replace(/["'\s]/g, '').replace(/^Bearer/i, '');
  if (!key) return null;
  if (key.length > 40) return { headers: { Authorization: `Bearer ${key}` }, params: {} };
  return { headers: {}, params: { api_key: key } };
}

async function tmdbGet(path, params = {}, userKey = null) {
  const auth = authConfig(userKey);
  if (!auth) throw new Error('TMDB API Key غير موجود (لا في الإعدادات ولا في السيرفر)');
  const r = await axios.get(BASE + path, {
    headers: auth.headers,
    params: { ...auth.params, ...params },
    timeout: 8000,
    httpAgent, httpsAgent
  });
  return r.data;
}

function parseStremioId(id) {
  const parts = String(id || '').trim().split(':');
  const imdbId = parts[0];
  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  return { imdbId, season: Number.isInteger(season) ? season : null, episode: Number.isInteger(episode) ? episode : null };
}

function genderLetter(g) {
  if (g === 1) return 'F';
  if (g === 2) return 'M';
  return null;
}

function cleanCharacter(name) {
  let n = String(name || '')
    .replace(/\((?:[^)]*)\)/g, '')
    .replace(/\[(?:[^\]]*)\]/g, '')
    .split('/')[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return '';
  if (/^(self|himself|herself|themselves|narrator|uncredited|various|extra)$/i.test(n)) return '';
  return n;
}

function addEntry(list, seen, character, actor, gender, order) {
  const ch = cleanCharacter(character);
  const g = genderLetter(gender);
  if (!ch || !g) return;
  const k = ch.toLowerCase();
  if (seen.has(k)) return;
  seen.add(k);
  list.push({ character: ch, actor: actor || '', gender: g, order: order ?? 999 });
}

// التعديل هنا: استلام userKey وتمريره
async function getTmdbCast(stremioId, userKey = null) {
  const { imdbId, season, episode } = parseStremioId(stremioId);
  if (!/^tt\d+$/.test(imdbId || '')) return { ok: false, reason: 'الرقم ليس IMDb صالح', cast: [], promptBlock: '' };

  // سوينا مفتاح الكاش يتضمن جزء من مفتاح المستخدم حتى ما يصير تداخل إذا أكثر من مستخدم استخدموا مفاتيح مختلفة
  const safeKeySuffix = userKey ? userKey.slice(-4) : 'env';
  const cacheKey = `${imdbId}:${season || ''}:${episode || ''}-${safeKeySuffix}`;
  
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;

  try {
    const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' }, userKey);
    const wantTv = season !== null;
    const movie = (found.movie_results || [])[0];
    const tv = (found.tv_results || [])[0];
    const ep = (found.tv_episode_results || [])[0];

    let kind, id, title;
    if (wantTv && tv) { kind = 'tv'; id = tv.id; title = tv.name; }
    else if (!wantTv && movie) { kind = 'movie'; id = movie.id; title = movie.title; }
    else if (tv) { kind = 'tv'; id = tv.id; title = tv.name; }
    else if (movie) { kind = 'movie'; id = movie.id; title = movie.title; }
    else if (ep) { kind = 'tv'; id = ep.show_id; title = ep.name; }
    else return { ok: false, reason: 'ما لقيت العمل على TMDB', cast: [], promptBlock: '' };

    const list = [];
    const seen = new Set();

    if (kind === 'movie') {
      const c = await tmdbGet(`/movie/${id}/credits`, {}, userKey);
      for (const p of (c.cast || [])) addEntry(list, seen, p.character, p.name, p.gender, p.order);
    } else {
      const jobs = [tmdbGet(`/tv/${id}/aggregate_credits`, {}, userKey)];
      if (season !== null && episode !== null) jobs.push(tmdbGet(`/tv/${id}/season/${season}/episode/${episode}/credits`, {}, userKey));
      const [agg, epc] = await Promise.allSettled(jobs);

      if (epc && epc.status === 'fulfilled') {
        for (const p of [...(epc.value.cast || []), ...(epc.value.guest_stars || [])]) {
          addEntry(list, seen, p.character, p.name, p.gender, p.order);
        }
      }
      if (agg.status === 'fulfilled') {
        for (const p of (agg.value.cast || [])) {
          const roles = (p.roles || []).slice().sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0));
          addEntry(list, seen, roles[0] && roles[0].character, p.name, p.gender, p.order);
        }
      }
    }

    list.sort((a, b) => a.order - b.order);
    const cast = list.slice(0, MAX_CAST);

    const promptBlock = cast.length
      ? 'KNOWN CHARACTERS (from TMDB; M = male, F = female). Use only to decide gender when the line or story clearly refers to this character:\n' +
        cast.map(c => `${c.character} = ${c.gender}`).join('\n')
      : '';

    const data = { ok: cast.length > 0, source: 'tmdb', kind, title, cast, promptBlock };
    cache.set(cacheKey, { t: Date.now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return data;
  } catch (e) {
    const msg = (e.response && e.response.data && e.response.data.status_message) || e.message;
    return { ok: false, reason: `TMDB فشل: ${msg}`, cast: [], promptBlock: '' };
  }
}

module.exports = { getTmdbCast, parseStremioId };

// ---------- اختبار مباشر: node tmdb.js tt0111161 ----------
if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!id) { console.log('اكتب رقم IMDb، مثال: node tmdb.js tt0111161'); process.exit(1); }
    const t0 = Date.now();
    const r = await getTmdbCast(id);
    console.log(`النتيجة: ${r.ok ? 'نجح' : 'فشل'} | ${r.title || ''} | ${r.kind || ''} | ${Date.now() - t0}ms`);
    if (!r.ok) console.log('السبب:', r.reason);
    r.cast.forEach(c => console.log(`  ${c.character}  (${c.actor})  ->  ${c.gender}`));
    console.log('\n--- النص اللي يروح للذكاء الاصطناعي ---\n' + r.promptBlock);
  })();
}
