const axios = require('axios');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// مراحل الإضافات المجانية بعد OpenSubtitles v3 (بالترتيب)
const ADDONS = [
  ['Wizdom', 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club'],
  ['fusiontv', 'https://stremiosubs.fusiontv.co']
];

const LANGS = {
  he: { re: /^he(b|$|[-_])/, iso3: 'heb', subdl: 'HE', subsource: 'hebrew', name: 'العبرية' },
  hi: { re: /^hi(n|$|[-_])/, iso3: 'hin', subdl: 'HI', subsource: 'hindi', name: 'الهندية' }
};

const SDH_RE = /\bsdh\b|\bhoh\b|\bcc\b|\bdeaf\b|hearing[\s._-]*impaired|closed[\s._-]*caption/;
const ASS_RE = /\.(ass|ssa)(?:$|[?\s])|\[(ass|ssa)\]/;

const textOf = s => [s.title, s.id, s.url, s.name, s.fileName, s.SubFileName, s.subtitleFileName]
  .filter(Boolean).map(x => String(x).toLowerCase()).join(' ');

// غير SDH وSRT فقط
function usable(s, code) {
  if (!s || !s.url) return false;
  if (s.hearingImpaired === true || s.SubHearingImpaired === '1' || s.SubHearingImpaired === 1) return false;
  const t = textOf(s);
  if (SDH_RE.test(t) || (code === 'he' && /\bhi\b/.test(t))) return false;
  if (s.format === 'ass' || s.format === 'ssa' || ASS_RE.test(t)) return false;
  return true;
}

const pick = (s, code, src) => ({
  url: s.url,
  lang: LANGS[code].iso3,
  fileName: s.fileName || s.title || s.name || s.SubFileName || s.subtitleFileName || src,
  format: 'srt',
  hearingImpaired: false,
  _source: src
});

const langOk = (s, code) => LANGS[code].re.test(String((s && s.lang) || '').toLowerCase());

// المرحلة 1: OpenSubtitles v3 (القائمة جاهزة من index.js، بدون طلب إضافي)
const stageOs = (osList, code) =>
  (osList || []).filter(s => s && langOk(s, code) && usable(s, code)).map(s => pick(s, code, 'opensubtitles'));

// المرحلتان 2 و3: إضافات ستريميو (Wizdom ثم fusiontv)
async function stageAddon(base, type, targetId, code, src) {
  const r = await axios.get(base + '/subtitles/' + type + '/' + targetId + '.json', {
    timeout: 8000,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const list = Array.isArray(r.data && r.data.subtitles) ? r.data.subtitles : [];
  return list.filter(s => s && langOk(s, code) && usable(s, code)).map(s => pick(s, code, src));
}

// المرحلة 4: SubDL
async function stageSubdl(a, code) {
  const list = await getSubDL({
    imdbId: a.imdbId, season: a.season, episode: a.episode,
    apiKey: a.subdlKey, languages: [LANGS[code].subdl]
  });
  return list.filter(s => usable(s, code)).map(s => pick(s, code, 'subdl'));
}

// المرحلة 5: Subsource
async function stageSubsource(a, code) {
  const list = await getSubSource({
    imdbId: a.imdbId, season: a.season, episode: a.episode,
    apiKey: a.subsourceKey, language: LANGS[code].subsource
  });
  return list.filter(s => usable(s, code)).map(s => pick(s, code, 'subsource'));
}

// العبرية أولًا ثم الهندية، حتى يكتمل العدد (want) من روابط غير SDH وبصيغة SRT
const BUDGET_MS = 7000;
const CACHE_TTL = 30 * 60 * 1000;
const SHORT_TTL = 2 * 60 * 1000;
const cache = new Map();

async function getHebHindiSubs(a) {
  const want = a.want || 4;
  if (!a.imdbId) return [];
  const cKey = a.targetId || [a.imdbId, a.season, a.episode].join(':');
  const hit = cache.get(cKey);
  if (hit && Date.now() - hit.time < hit.ttl) return hit.list;
  const out = [];
  const store = (list, ttl) => {
    cache.set(cKey, { time: Date.now(), list, ttl });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
  };
  const run = collect(a, want, out).then(() => store(out.slice(), CACHE_TTL));
  const timer = new Promise(resolve => setTimeout(() => {
    console.log('[عبري/هندي] انتهت المهلة (' + (BUDGET_MS / 1000) + 's)، أكمل بما وُجد: ' + out.length + '/' + want);
    store(out.slice(), SHORT_TTL);
    resolve();
  }, BUDGET_MS));
  await Promise.race([run.catch(() => {}), timer]);
  return out.slice();
}

async function collect(a, want, out) {
  const take = list => {
    for (const s of list) {
      if (out.length >= want) return;
      if (!out.some(o => o.url === s.url)) out.push(s);
    }
  };
  const safe = (label, p) => Promise.resolve(p).catch(e => {
    console.log('[' + label + '] فشل: ' + (e && e.message));
    return [];
  });
  for (const code of ['he', 'hi']) {
    if (out.length >= want) break;
    const parts = [];
    const fromOs = stageOs(a.osList, code);
    parts.push('OpenSubtitles v3=' + fromOs.length);
    take(fromOs);
    if (out.length < want) {
      const addons = await Promise.all(
        ADDONS.map(([name, base]) => safe(name, stageAddon(base, a.type, a.targetId, code, name.toLowerCase())))
      );
      addons.forEach((l, i) => { parts.push(ADDONS[i][0] + '=' + l.length); take(l); });
    } else {
      ADDONS.forEach(([name]) => parts.push(name + '=-'));
    }
    if (out.length < want) {
      const keyed = await Promise.all([
        safe('SubDL', stageSubdl(a, code)),
        safe('Subsource', stageSubsource(a, code))
      ]);
      parts.push('SubDL=' + keyed[0].length, 'Subsource=' + keyed[1].length);
      keyed.forEach(take);
    } else {
      parts.push('SubDL=-', 'Subsource=-');
    }
    console.log('[' + LANGS[code].name + '] ' + parts.join(' | ') + ' | المجموع=' + out.length + '/' + want);
  }
}

module.exports = { getHebHindiSubs };
