// shield.js
// درع الترجمة: ربط مباشر مع أوقات حجب سينمانا (cee.buzz / cinemana) + نظام التصويت الصارم + جدار كامل الشاشة

const axiosDefault = require('axios');

const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// ===== 1. إعدادات الجدار الكامل والتنبيه =====
const WARN_SEC = 10;                  // مدة التنبيه المسبق قبل المشهد بالثواني (يختفي تماماً عند بدء الجدار)
const WARN_COLOR_HEX = '#FFD400';     // لون التنبيه
const WALL_CHAR = '█';                // المربع المصمت المتلاصق
const WALL_COLS = 46;                 // 46 عمود لتغطية عرض الشاشة بالكامل
const WALL_ROWS = 16;                 // 16 سطر لتغطية ارتفاع الشاشة بالكامل
const ASS_WALL_COLS = 54;             // عرض الجدار لملفات ASS
const ASS_WALL_ROWS = 18;             // ارتفاع الجدار لملفات ASS

// ===== 2. إعدادات سينمانا (Cee / Cinemana) ونظام التصويت والثقة =====
const TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';
const CEE_API_BASES = [
  'https://cee.buzz/api/android',
  'https://cinemana.shabakaty.cc/api/android'
];
const MIN_AI_CONFIDENCE = 85;         // أقل نسبة ثقة (85%) لتفعيل الجدار عند غياب أوقات سينمانا
const SCENE_PAD_BEFORE_SEC = 4;       // هامش أمان قبل المشهد
const SCENE_PAD_AFTER_SEC = 3;        // هامش أمان بعد نهاية المشهد
const USE_TEST_SCENES = false;        // false = التشغيل الفعلي
const HTTP_TIMEOUT_MS = 8500;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  'Accept': 'application/json, text/html, application/xhtml+xml, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8'
};

function getAiShared() {
  try {
    const aiMod = require('./ai');
    if (aiMod && aiMod.shared) return aiMod.shared;
  } catch (_) {}
  return { axios: axiosDefault };
}

function hexToAss(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return ('&H' + b + g + r + '&').toUpperCase();
}

const WARN_ASS = hexToAss(WARN_COLOR_HEX);
const WALL_ROW = WALL_CHAR.repeat(WALL_COLS);
const FULL_SRT_WALL = Array.from({ length: WALL_ROWS }, () => WALL_ROW).join('\n');
const ASS_WALL_ROW = WALL_CHAR.repeat(ASS_WALL_COLS);

// ===== قائمة أولوية يدوية (اختيارية) =====
const SCENES_DB = {
  // 'tt0000000': [['12:30', '13:10'], ['45:00', '46:20']],
};

const TEST_SCENES = [
  { start: 20, end: 45, type: 'wall' },
  { start: 300, end: 315, type: 'wall' }
];

// كاش معزول للمصادر وللروابط
const EVIDENCE_CACHE = new Map();
const RESOLVED_SCENES_CACHE = new Map();
const LATEST_TARGET_SCENES = new Map();
const IN_FLIGHT_EVIDENCE = new Map();
const IN_FLIGHT_TRACKS = new Map();

function getTrackCacheKey(targetId, cues) {
  if (!targetId) return '';
  if (!Array.isArray(cues) || cues.length === 0) return String(targetId);
  const first = String(cues[0]?.start || '').trim();
  const last = String(cues[cues.length - 1]?.end || '').trim();
  return `${targetId}::${cues.length}::${first}::${last}`;
}

function saveTrackScenesToCache(targetId, trackKey, scenes) {
  if (!targetId) return;
  if (RESOLVED_SCENES_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = RESOLVED_SCENES_CACHE.keys().next().value;
    if (oldestKey !== undefined) RESOLVED_SCENES_CACHE.delete(oldestKey);
  }
  if (trackKey) RESOLVED_SCENES_CACHE.set(trackKey, scenes);
  LATEST_TARGET_SCENES.set(targetId, scenes);
}

function toSec(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v || '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const p = s.split(':').map(Number);
  if (!p.length || p.some(n => !Number.isFinite(n))) return NaN;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

function parseSubTimeSec(t) {
  if (!t) return 0;
  const clean = String(t).trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length !== 3) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseFloat(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return 0;
  return Math.max(0, (h * 3600) + (m * 60) + s);
}

function formatSrtTimeSec(sec) {
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function formatAssTimeSec(sec) {
  const totalCs = Math.max(0, Math.round((Number(sec) || 0) * 100));
  const hrs = Math.floor(totalCs / 360000);
  const mins = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  const pad = (n) => String(n).padStart(2, '0');
  return `${hrs}:${pad(mins)}:${pad(secs)}.${pad(cs)}`;
}

function normalizeScenes(rawScenes) {
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) return [];
  const valid = rawScenes
    .map(sc => ({
      start: Number(sc.start),
      end: Number(sc.end),
      type: sc.type || 'wall',
      msg: sc.msg || ''
    }))
    .filter(sc => Number.isFinite(sc.start) && Number.isFinite(sc.end) && sc.end > sc.start && sc.start >= 0)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const sc of valid) {
    const last = merged[merged.length - 1];
    if (!last || sc.type !== last.type || sc.start > last.end + 4) {
      merged.push({ ...sc });
    } else {
      last.end = Math.max(last.end, sc.end);
    }
  }
  return merged;
}

function getManualScenes(targetId) {
  const raw = SCENES_DB[targetId];
  if (!Array.isArray(raw) || !raw.length) return null;
  const list = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = toSec(pair[0]);
    const b = toSec(pair[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      list.push({ start: Math.max(0, a - SCENE_PAD_BEFORE_SEC), end: b + SCENE_PAD_AFTER_SEC, type: 'wall' });
    }
  }
  return normalizeScenes(list);
}

function getScenesForMedia(targetId, cues = null) {
  if (USE_TEST_SCENES) return TEST_SCENES;
  const manual = getManualScenes(targetId);
  if (manual) return manual;
  if (Array.isArray(cues) && cues.length > 0) {
    const tk = getTrackCacheKey(targetId, cues);
    if (RESOLVED_SCENES_CACHE.has(tk)) return RESOLVED_SCENES_CACHE.get(tk) || [];
  }
  if (targetId && LATEST_TARGET_SCENES.has(targetId)) {
    return LATEST_TARGET_SCENES.get(targetId) || [];
  }
  return [];
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  );
}

function slugifyStandard(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugifyKidsInMind(title) {
  const clean = String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9]/g, '');
  const firstLetter = clean ? clean[0] : 'a';
  const fullNoArticles = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return { firstLetter, clean, fullNoArticles };
}

async function safeHttpGet(url, extraHeaders = {}, customTimeout = HTTP_TIMEOUT_MS) {
  const { axios } = getAiShared();
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    timeout: customTimeout,
    maxContentLength: MAX_HTTP_BYTES,
    validateStatus: s => s >= 200 && s < 300
  });
  return res.data;
}

// ===== تطبيع الأسماء العربية والإنجليزية لمطابقة بحث سينمانا و Cee =====
function normalizeSearchTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

function uniqueStrings(list) {
  const out = [];
  for (const x of list) {
    const s = String(x || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function calcCinemanaTitleScore(itemTitle, normalizedTargetNames) {
  const t = normalizeSearchTitle(itemTitle);
  if (!t) return 0;
  if (normalizedTargetNames.includes(t)) return 100;
  const partial = normalizedTargetNames.some(n => {
    if (Math.min(n.length, t.length) < 3) return false;
    return t.includes(n) || n.includes(t);
  });
  return partial ? 50 : 0;
}

function pickBestCinemanaItem(results, meta) {
  if (!Array.isArray(results) || !results.length) return null;
  const wantSeries = Boolean(meta.isSeries);
  const normNames = (meta.searchTerms || [meta.title]).map(normalizeSearchTitle).filter(Boolean);
  let best = null;
  let bestScore = 0;

  for (const it of results) {
    if (!it || !it.nb) continue;

    if (it.imdbUrlRef && meta.baseImdbId && String(it.imdbUrlRef).toLowerCase().includes(meta.baseImdbId)) {
      return it;
    }

    if (it.kind !== undefined && it.kind !== null) {
      const isItemSeries = parseInt(it.kind, 10) === 2;
      if (isItemSeries !== wantSeries) continue;
    }

    let score = Math.max(
      calcCinemanaTitleScore(it.en_title, normNames),
      calcCinemanaTitleScore(it.ar_title, normNames)
    );
    if (score === 0) continue;

    const y = parseInt(it.year, 10);
    if (meta.year && y) {
      if (y === meta.year) score += 30;
      else if (Math.abs(y - meta.year) === 1) score += 10;
      else if (!wantSeries) score -= 60;
    }

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  return bestScore >= 50 ? best : null;
}

// استخراج فترات الحجب من حقل skippingDurations
function parseSkippingDurationsField(rawField) {
  if (!rawField) return [];
  let data = rawField;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return []; }
  }

  const scenes = [];

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const starts = Array.isArray(data.start) ? data.start : [];
    const ends = Array.isArray(data.end) ? data.end : [];
    const count = Math.min(starts.length, ends.length);
    for (let i = 0; i < count; i++) {
      const s = toSec(starts[i]);
      const e = toSec(ends[i]);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 && (e - s <= 1200)) {
        scenes.push({ start: s, end: e, type: 'wall' });
      }
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (!item) continue;
      const s = toSec(item.start ?? item[0]);
      const e = toSec(item.end ?? item[1]);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 && (e - s <= 1200)) {
        scenes.push({ start: s, end: e, type: 'wall' });
      }
    }
  }

  return normalizeScenes(scenes);
}

// ===== المصدر الأساسي الأول (Tier 0): جلب أوقات القطع الرسمية من Cee.buzz / Cinemana =====
async function fetchCeeCinemanaSkipping(meta) {
  if (!meta) return null;
  const searchTerms = uniqueStrings(meta.searchTerms && meta.searchTerms.length ? meta.searchTerms : [meta.title]);
  if (!searchTerms.length) return null;

  const searchType = meta.isSeries ? 'series' : 'movies';
  const currentYear = new Date().getFullYear();

  for (const apiBase of CEE_API_BASES) {
    const providerLabel = apiBase.includes('cee.buzz') ? 'Cee.buzz' : 'Cinemana';
    try {
      let matchedItem = null;

      for (const term of searchTerms) {
        const enc = encodeURIComponent(term);
        const searchUrl = `${apiBase}/AdvancedSearch?level=0&videoTitle=${enc}&staffTitle=${enc}&year=1900,${currentYear}&page=0&type=${searchType}&itemsPerPage=12`;
        try {
          const list = await safeHttpGet(searchUrl, {}, 9000);
          matchedItem = pickBestCinemanaItem(list, meta);
          if (matchedItem) break;
        } catch (_) {}
      }

      if (!matchedItem || !matchedItem.nb) continue;

      let videoId = String(matchedItem.nb);
      if (meta.isSeries) {
        const sNum = Number(meta.season) || 1;
        const eNum = Number(meta.episode) || 1;
        const eps = await safeHttpGet(`${apiBase}/videoSeason/id/${matchedItem.nb}`, {}, 9000);
        if (!Array.isArray(eps)) continue;
        const foundEp = eps.find(ep =>
          parseInt(ep?.season, 10) === sNum &&
          parseInt(ep?.episodeNummer ?? ep?.episodeNumber, 10) === eNum
        );
        if (!foundEp || !foundEp.nb) continue;
        videoId = String(foundEp.nb);
      }

      const info = await safeHttpGet(`${apiBase}/allVideoInfo/id/${videoId}`, {}, 9000);
      if (!info || typeof info !== 'object') continue;

      if (info.imdbUrlRef && meta.baseImdbId) {
        const refMatch = String(info.imdbUrlRef).match(/tt\d+/i);
        if (refMatch && refMatch[0].toLowerCase() !== meta.baseImdbId && refMatch[0].toLowerCase() !== meta.episodeImdbId) {
          continue;
        }
      }

      const scenes = parseSkippingDurationsField(info.skippingDurations);
      console.log(`[درع Nuvio 🎯 ${providerLabel}] تم العثور على العمل (nb=${videoId}) | الفترات في skippingDurations=${scenes.length}`);

      return {
        source: `${providerLabel}(nb:${videoId})`,
        videoId,
        scenes,
        hasSkipping: scenes.length > 0
      };
    } catch (_) {}
  }

  return null;
}

function extractRegexTimestampsFromDescriptions(descList) {
  if (!Array.isArray(descList)) return [];
  const extracted = [];
  const rangeRe = /\b(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:to|[-–—]|until)\s*(\d{1,2}:\d{2}(?::\d{2})?)\b/gi;
  const pointRe = /\b(?:at|around|mark|timestamp)\s+(\d{1,2}:\d{2}(?::\d{2})?)\b/gi;

  for (const text of descList) {
    const s = String(text || '');
    let m;
    while ((m = rangeRe.exec(s)) !== null) {
      const a = toSec(m[1]);
      const b = toSec(m[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= 900) {
        extracted.push({ start: a, end: b, type: 'wall' });
      }
    }
    while ((m = pointRe.exec(s)) !== null) {
      const a = toSec(m[1]);
      if (Number.isFinite(a) && a > 0) {
        extracted.push({ start: Math.max(0, a - 5), end: a + 35, type: 'wall' });
      }
    }
  }
  return extracted;
}

// ===== استخراج رقم IMDb الخاص بالحلقة =====
async function resolveEpisodeSpecificImdbId(baseImdbId, season, episode, seriesTitle, episodeTitle) {
  if (episodeTitle) {
    try {
      const cleanEp = episodeTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanEp.length >= 3) {
        const firstLetter = cleanEp[0];
        const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/${firstLetter}/${encodeURIComponent(cleanEp.slice(0, 35))}.json`);
        const list = Array.isArray(sug?.d) ? sug.d : [];
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const targetNorm = norm(episodeTitle);
        const found = list.find(x =>
          /^tt\d+$/i.test(x.id) &&
          x.id !== baseImdbId &&
          (norm(x.l) === targetNorm || norm(x.l).includes(targetNorm)) &&
          /episode/i.test(String(x.q || x.qid || ''))
        ) || list.find(x => /^tt\d+$/i.test(x.id) && x.id !== baseImdbId && /episode/i.test(String(x.q || x.qid || '')));

        if (found) {
          return { episodeImdbId: found.id.toLowerCase(), episodeTitle };
        }
      }
    } catch (_) {}
  }

  try {
    const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${baseImdbId}/episodes?season=${season}`, { Accept: 'application/json' });
    const eps = data?.episodes || data?.items || (Array.isArray(data) ? data : []);
    if (Array.isArray(eps) && eps.length > 0) {
      const epItem = eps.find(e => Number(e?.episodeNumber || e?.episode) === Number(episode)) || eps[episode - 1];
      const epId = epItem?.id || epItem?.imdbId || epItem?.tconst;
      if (epId && /^tt\d+$/i.test(String(epId))) {
        return {
          episodeImdbId: String(epId).toLowerCase(),
          episodeTitle: String(epItem?.title || epItem?.primaryTitle || episodeTitle || '').trim()
        };
      }
    }
  } catch (_) {}

  try {
    const { axios } = getAiShared();
    const query = `query { title(id: "${baseImdbId}") { episodes { episodes(first: 50) { edges { node { id titleText { text } series { displayableEpisodeNumber { episodeNumber { episodeNumber } seasonNumber { seasonNumber } } } } } } } } }`;
    const gqlRes = await axios.post('https://api.graphql.imdb.com/', { query }, {
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        'x-imdb-client-name': 'imdb-web-next-localized'
      },
      timeout: HTTP_TIMEOUT_MS
    });
    const edges = gqlRes.data?.data?.title?.episodes?.episodes?.edges;
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const node = edge?.node;
        const sNum = Number(node?.series?.displayableEpisodeNumber?.seasonNumber?.seasonNumber);
        const eNum = Number(node?.series?.displayableEpisodeNumber?.episodeNumber?.episodeNumber);
        if (sNum === Number(season) && eNum === Number(episode) && /^tt\d+$/i.test(String(node?.id || ''))) {
          return {
            episodeImdbId: String(node.id).toLowerCase(),
            episodeTitle: String(node?.titleText?.text || episodeTitle || '').trim()
          };
        }
      }
    }
  } catch (_) {}

  return null;
}

// ===== جلب معلومات الفلم أو الحلقة (مع الأسماء الإنجليزية والعربية من TMDB لبحث سينمانا) =====
async function resolveMediaMeta(targetId) {
  const raw = String(targetId || '').trim();
  const parts = raw.split(':');
  const imdbMatch = parts[0].match(/^(tt\d{6,10})$/i);
  if (!imdbMatch) return null;

  const baseImdbId = imdbMatch[1].toLowerCase();
  const isSeries = parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]);
  const season = isSeries ? parseInt(parts[1], 10) : null;
  const episode = isSeries ? parseInt(parts[2], 10) : null;

  let title = '';
  let arTitle = '';
  let originalTitle = '';
  let year = null;
  let episodeImdbId = null;
  let episodeTitle = '';
  let episodePlot = '';

  try {
    const findEn = await safeHttpGet(`https://api.themoviedb.org/3/find/${baseImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=en-US`, {}, 6500);
    const listEn = isSeries ? (findEn?.tv_results || []) : (findEn?.movie_results || []);
    const itemEn = listEn[0] || (findEn?.movie_results || [])[0] || (findEn?.tv_results || [])[0];
    if (itemEn) {
      title = String(itemEn.title || itemEn.name || '').trim();
      originalTitle = String(itemEn.original_title || itemEn.original_name || '').trim();
      const dateStr = String(itemEn.release_date || itemEn.first_air_date || '');
      if (dateStr.length >= 4) year = parseInt(dateStr.slice(0, 4), 10) || null;

      if (itemEn.id) {
        const kind = isSeries ? 'tv' : 'movie';
        const infoAr = await safeHttpGet(`https://api.themoviedb.org/3/${kind}/${itemEn.id}?api_key=${TMDB_API_KEY}&language=ar`, {}, 5500).catch(() => null);
        if (infoAr) {
          arTitle = String(infoAr.title || infoAr.name || '').trim();
        }
      }
    }
  } catch (_) {}

  if (!title || !year) {
    try {
      const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/t/${baseImdbId}.json`);
      const item = Array.isArray(sug?.d) ? sug.d.find(x => x.id === baseImdbId) || sug.d[0] : null;
      if (item) {
        if (!title) title = String(item.l || '').trim();
        if (!year && Number.isFinite(Number(item.y))) year = Number(item.y);
      }
    } catch (_) {}
  }

  if (!title || !year || isSeries) {
    try {
      const type = isSeries ? 'series' : 'movie';
      const cm = await safeHttpGet(`https://v3-cinemeta.strem.io/meta/${type}/${baseImdbId}.json`);
      const meta = cm?.meta;
      if (meta) {
        if (!title && meta.name) title = String(meta.name).trim();
        if (!year && meta.year) {
          const yMatch = String(meta.year).match(/\d{4}/);
          if (yMatch) year = Number(yMatch[0]);
        }
        if (isSeries && Array.isArray(meta.videos)) {
          const epObj = meta.videos.find(v => Number(v.season) === season && Number(v.episode) === episode);
          if (epObj) {
            if (epObj.imdb_id && /^tt\d+$/i.test(epObj.imdb_id)) episodeImdbId = epObj.imdb_id.toLowerCase();
            if (epObj.name || epObj.title) episodeTitle = String(epObj.name || epObj.title).trim();
            if (epObj.overview || epObj.description) episodePlot = String(epObj.overview || epObj.description).trim();
          }
        }
      }
    } catch (_) {}
  }

  if (isSeries && !episodeImdbId) {
    const epResolved = await resolveEpisodeSpecificImdbId(baseImdbId, season, episode, title, episodeTitle);
    if (epResolved && epResolved.episodeImdbId) {
      episodeImdbId = epResolved.episodeImdbId;
      if (!episodeTitle && epResolved.episodeTitle) episodeTitle = epResolved.episodeTitle;
    }
  }

  const searchTerms = uniqueStrings([title, arTitle, originalTitle]);

  return {
    targetId: raw,
    baseImdbId,
    episodeImdbId,
    isSeries,
    season,
    episode,
    title,
    arTitle,
    originalTitle,
    searchTerms,
    year,
    episodeTitle,
    episodePlot
  };
}

// ===== المصادر الستة ونظام التصويت الاحتياطي =====

// [المصدر 1]: IMDb Parents Guide
async function fetchImdbParentsGuide(meta) {
  if (!meta) return null;
  const idsToTry = meta.isSeries
    ? [meta.episodeImdbId].filter(Boolean)
    : [meta.baseImdbId].filter(Boolean);

  for (const imdbId of idsToTry) {
    try {
      const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${imdbId}/parentsGuide`, { Accept: 'application/json' });
      const guide = data?.parentalGuide || data?.parentsGuide || data;
      const parsed = extractImdbGuideData(guide, imdbId);
      if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
    } catch (_) {}

    try {
      const { axios } = getAiShared();
      const query = `query { title(id: "${imdbId}") { parentsGuide { guideItems(first: 45) { edges { node { category { id } text { plainText } } } } } } }`;
      const gqlRes = await axios.post('https://api.graphql.imdb.com/', { query }, {
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'x-imdb-client-name': 'imdb-web-next-localized'
        },
        timeout: HTTP_TIMEOUT_MS
      });
      const edges = gqlRes.data?.data?.title?.parentsGuide?.guideItems?.edges;
      if (Array.isArray(edges) && edges.length > 0) {
        const nudityItems = edges
          .map(e => e?.node)
          .filter(n => n && /NUDITY|SEX/i.test(String(n.category?.id || '')))
          .map(n => String(n.text?.plainText || '').trim())
          .filter(Boolean);

        const realNudityItems = nudityItems.filter(txt => !/^(none|no nudity|no sex|nothing|n\/a)\.?$/i.test(txt));

        return {
          source: `IMDb-GraphQL(${imdbId})`,
          itemCount: realNudityItems.length,
          voteWeight: realNudityItems.length >= 2 ? 2 : (realNudityItems.length === 1 ? 1 : 0),
          isClean: realNudityItems.length === 0,
          hasAdult: realNudityItems.length > 0,
          directScenes: extractRegexTimestampsFromDescriptions(realNudityItems),
          descriptions: realNudityItems.slice(0, 30)
        };
      }
    } catch (_) {}

    try {
      const html = await safeHttpGet(`https://www.imdb.com/title/${imdbId}/parentalguide`);
      if (typeof html === 'string' && html.length > 1000) {
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextMatch) {
          const json = JSON.parse(nextMatch[1]);
          const parsed = extractImdbGuideData(json, imdbId);
          if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
        }
      }
    } catch (_) {}
  }
  return null;
}

function extractImdbGuideData(obj, imdbId = '') {
  if (!obj || typeof obj !== 'object') return null;
  const rawStr = JSON.stringify(obj);
  const descriptions = [];
  let severity = '';

  const nudityRegex = /"category"\s*:\s*\{[^}]*"id"\s*:\s*"NUDITY"[^}]*\}[^}]*"text"\s*:\s*\{[^}]*"plainText"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  let m;
  while ((m = nudityRegex.exec(rawStr)) !== null) {
    try {
      const decoded = JSON.parse(`"${m[1]}"`).trim();
      if (decoded && !/^(none|no nudity|no sex|nothing)\.?$/i.test(decoded) && !descriptions.includes(decoded)) {
        descriptions.push(decoded);
      }
    } catch (_) {}
  }

  if (Array.isArray(obj.categories)) {
    for (const cat of obj.categories) {
      if (/NUDITY|SEX/i.test(String(cat.category || cat.id || cat.title || ''))) {
        severity = String(cat.severity || cat.level || '').toUpperCase();
        const list = cat.items || cat.entries || cat.texts || [];
        for (const it of list) {
          const txt = String(typeof it === 'string' ? it : (it?.text || it?.plainText || '')).trim();
          if (txt && !/^(none|no nudity|no sex|nothing)\.?$/i.test(txt) && !descriptions.includes(txt)) {
            descriptions.push(txt);
          }
        }
      }
    }
  }

  if (!descriptions.length && !severity) return null;
  const isNone = (severity === 'NONE' || descriptions.length === 0) && !/MODERATE|SEVERE/i.test(severity);
  const hasAdult = !isNone && (descriptions.length > 0 || /MODERATE|SEVERE/i.test(severity));
  return {
    source: `IMDb-Guide(${imdbId})`,
    severity,
    itemCount: descriptions.length,
    voteWeight: /SEVERE|MODERATE/i.test(severity) || descriptions.length >= 2 ? 2 : (hasAdult ? 1 : 0),
    isClean: isNone,
    hasAdult,
    directScenes: extractRegexTimestampsFromDescriptions(descriptions),
    descriptions: descriptions.slice(0, 30)
  };
}

// [المصدر 2 - أفلام]: Kids-In-Mind
async function fetchKidsInMind(meta) {
  if (!meta || !meta.title || meta.isSeries) return null;
  const { firstLetter, clean, fullNoArticles } = slugifyKidsInMind(meta.title);
  if (!clean) return null;

  const candidates = [
    `https://kids-in-mind.com/${firstLetter}/${clean}.htm`,
    `https://kids-in-mind.com/${firstLetter}/${fullNoArticles}.htm`,
    meta.year ? `https://kids-in-mind.com/${firstLetter}/${clean}${meta.year}.htm` : null
  ].filter(Boolean);

  for (const url of candidates) {
    try {
      const html = await safeHttpGet(url);
      if (typeof html !== 'string' || html.length < 500) continue;
      if (meta.year && !html.includes(String(meta.year))) continue;

      const text = stripHtmlTags(html);
      const secMatch = text.match(/SEX\/NUDITY\s*(\d{1,2})\s*[-–—]\s*([\s\S]*?)(?=VIOLENCE\/GORE|LANGUAGE|PROFANITY|SUBSTANCE USE|DISCUSSION TOPICS|MESSAGE|$)/i);
      if (!secMatch) continue;

      const score = parseInt(secMatch[1], 10);
      const desc = secMatch[2].trim().slice(0, 3000);
      const hasAdult = score >= 3 || /\b(nudity|nude|naked|sex|intercourse|breasts|topless|prostitute|stripper|orgy|rape|masturbat|thrusting|making love)\b/i.test(desc);
      return {
        source: 'Kids-In-Mind',
        score,
        voteWeight: score >= 5 ? 2 : (hasAdult ? 1 : 0),
        isClean: score <= 1 && !hasAdult,
        hasAdult,
        directScenes: extractRegexTimestampsFromDescriptions([desc]),
        descriptions: desc ? [`[Kids-In-Mind Score ${score}/10]: ${desc}`] : []
      };
    } catch (_) {}
  }
  return null;
}

// [المصدر 3 - أفلام]: CringeMDb
async function fetchCringeMdb(meta) {
  if (!meta || !meta.title || meta.isSeries) return null;
  const slug = slugifyStandard(meta.title);
  if (!slug) return null;

  const urls = [];
  if (meta.year) urls.push(`https://cringemdb.com/movie/${slug}-${meta.year}`);
  urls.push(`https://cringemdb.com/movie/${slug}`);

  for (const url of urls) {
    try {
      const html = await safeHttpGet(url);
      if (typeof html !== 'string' || html.length < 500) continue;

      const text = stripHtmlTags(html);
      const isSafe = /is SAFE to watch with parents/i.test(text) ||
        (/Sex Scene\s*NO/i.test(text) && /Nudity\s*NO/i.test(text) && /Sexual Violence\s*NO/i.test(text));

      const timeRegex = /(\d{1,2}:\d{2}(?::\d{2})?)\s+to\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*\.?\s*(Sex scene|Nudity|Sexual Violence|Suggestive)\b([^.*]*?)(?=(?:\d{1,2}:\d{2}\s+to\s+\d{1,2}:\d{2}|CringeMDb Staff Says|Top Billed Cast|$))/gi;
      const directScenes = [];
      const descriptions = [];
      let m;

      while ((m = timeRegex.exec(text)) !== null) {
        const startSec = toSec(m[1]);
        const endSec = toSec(m[2]);
        const category = String(m[3] || '').trim();
        const details = String(m[4] || '')
          .replace(/Unverified.*$/i, '')
          .replace(/Skippable without missing the plot/gi, '')
          .trim();

        const isBriefSuggestiveOnly = /Suggestive/i.test(category) && !/\b(naked|nude|sex|breast|topless|lingerie|stripper|underwear|bed)\b/i.test(details);
        if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && !isBriefSuggestiveOnly) {
          directScenes.push({ start: startSec, end: endSec, type: 'wall' });
          descriptions.push(`[${m[1]} - ${m[2]}] (${category}): ${details.slice(0, 200)}`);
        }
      }

      const hasAdult = !isSafe || directScenes.length > 0;
      return {
        source: 'CringeMDb',
        voteWeight: directScenes.length > 0 ? 2 : (hasAdult ? 1 : 0),
        isClean: isSafe && directScenes.length === 0,
        hasAdult,
        directScenes,
        descriptions
      };
    } catch (_) {}
  }
  return null;
}

// [المصدر 4]: Plugged In
async function fetchPluggedIn(meta) {
  if (!meta || !meta.title || meta.isSeries) return null;
  const slug = slugifyStandard(meta.title);
  if (!slug) return null;

  try {
    const html = await safeHttpGet(`https://www.pluggedin.com/movie-reviews/${slug}/`);
    if (typeof html !== 'string' || html.length < 500) return null;
    const text = stripHtmlTags(html);
    const secMatch = text.match(/Sexual\s*(?:&|and)\s*Romantic Content([\s\S]*?)(?=Violent Content|Crude or Profane Language|Drug\s*(?:&|and)\s*Alcohol Content|Other Noteworthy Elements|Conclusion|$)/i);
    if (!secMatch) return null;

    const desc = secMatch[1].trim().slice(0, 2200);
    if (!desc || desc.length < 15) return null;
    const isClean = /^(none|nothing|not applicable|no sexual content)\b/i.test(desc);
    const hasExplicitKeywords = /\b(nude|nudity|naked|sex|intercourse|breasts|topless|prostitute|stripper|rape|making love|thrusting|orgy)\b/i.test(desc);

    return {
      source: 'PluggedIn',
      voteWeight: hasExplicitKeywords ? 1 : 0,
      isClean,
      hasAdult: !isClean && hasExplicitKeywords,
      directScenes: extractRegexTimestampsFromDescriptions([desc]),
      descriptions: [`[PluggedIn]: ${desc}`]
    };
  } catch (_) {
    return null;
  }
}

// [المصدر 5]: Parent Previews
async function fetchParentPreviews(meta) {
  if (!meta || !meta.title || meta.isSeries) return null;
  const slug = slugifyStandard(meta.title);
  if (!slug) return null;

  try {
    const html = await safeHttpGet(`https://parentpreviews.com/movie-reviews/${slug}`);
    if (typeof html !== 'string' || html.length < 500) return null;
    const text = stripHtmlTags(html);
    const secMatch = text.match(/Sexual Content:\s*([\s\S]*?)(?=Profanity:|Alcohol\s*\/\s*Drug Use:|Violence:|Overall\s+[A-F]|$)/i);
    if (!secMatch) return null;

    const desc = secMatch[1].trim().slice(0, 1800);
    if (!desc) return null;
    const isClean = /^none\b/i.test(desc);
    const hasExplicitKeywords = /\b(nude|nudity|naked|sex|intercourse|breasts|topless|prostitute|stripper|rape|thrusting|post coital)\b/i.test(desc);

    return {
      source: 'ParentPreviews',
      voteWeight: hasExplicitKeywords ? 1 : 0,
      isClean,
      hasAdult: !isClean && hasExplicitKeywords,
      directScenes: extractRegexTimestampsFromDescriptions([desc]),
      descriptions: [`[ParentPreviews]: ${desc}`]
    };
  } catch (_) {
    return null;
  }
}

// [المصدر 6]: DoesTheDogDie
async function fetchDoesTheDogDie(meta) {
  if (!meta || !meta.title || meta.isSeries) return null;
  try {
    const searchData = await safeHttpGet(`https://www.doesthedogdie.com/dddsearch?q=${encodeURIComponent(meta.title)}`, {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    });
    const items = Array.isArray(searchData?.items) ? searchData.items : [];
    const matched = items.find(it => !meta.year || String(it.releaseYear) === String(meta.year)) || items[0];
    if (!matched || !matched.id) return null;

    const mediaData = await safeHttpGet(`https://www.doesthedogdie.com/media/${matched.id}`, {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    });
    const stats = Array.isArray(mediaData?.topicItemStats) ? mediaData.topicItemStats : [];
    const sexTopics = stats.filter(st => /sex|nudity|nude|obscene|rape|assault/i.test(String(st?.topic?.name || st?.topic?.doesName || '')));
    if (!sexTopics.length) return null;

    let yesVotes = 0;
    let noVotes = 0;
    const notes = [];
    for (const st of sexTopics) {
      const y = Number(st.yesSum || 0);
      const n = Number(st.noSum || 0);
      if (y > n && y >= 3) {
        yesVotes++;
        const comment = Array.isArray(st.comments) && st.comments[0]?.comment ? st.comments[0].comment : '';
        notes.push(`${st.topic?.name || 'Sexual Content'}: YES (${y} vs ${n}) ${comment}`.trim());
      } else if (n > y * 2 && n >= 3) {
        noVotes++;
      }
    }

    return {
      source: 'DoesTheDogDie',
      voteWeight: yesVotes > 0 ? 1 : 0,
      isClean: yesVotes === 0 && noVotes > 0,
      hasAdult: yesVotes > 0,
      directScenes: extractRegexTimestampsFromDescriptions(notes),
      descriptions: notes.slice(0, 10)
    };
  } catch (_) {
    return null;
  }
}

// ===== 3. محرك جمع الأدلة: يفحص Cee/Cinemana أولاً، ثم ينتقل للتصويت الاحتياطي =====
async function getOrGatherEvidence(targetId) {
  if (EVIDENCE_CACHE.has(targetId)) return EVIDENCE_CACHE.get(targetId);
  if (IN_FLIGHT_EVIDENCE.has(targetId)) return IN_FLIGHT_EVIDENCE.get(targetId);

  const p = (async () => {
    try {
      const meta = await resolveMediaMeta(targetId);
      if (!meta) return null;

      // الخطوة 0 (الأساسية): فحص حقل skippingDurations من Cee.buzz / Cinemana
      const ceeResult = await fetchCeeCinemanaSkipping(meta);
      if (ceeResult && ceeResult.hasSkipping) {
        const paddedCeeScenes = normalizeScenes(
          ceeResult.scenes.map(sc => ({
            start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
            end: sc.end + SCENE_PAD_AFTER_SEC,
            type: 'wall'
          }))
        );

        const label = meta.isSeries
          ? `${meta.title} S${meta.season}E${meta.episode}`
          : (meta.title || meta.targetId);

        console.log(`[درع Nuvio 🛡️] ${label} | تم اعتماد أوقات الحجب المباشرة من [${ceeResult.source}] بنجاح (${paddedCeeScenes.length} مشهد).`);

        const ceeBundle = {
          meta,
          evidence: {
            fromCinemana: true,
            activeCount: 1,
            cleanVotes: 0,
            adultVotes: 1,
            totalVoteWeight: 3,
            passedVoting: true,
            directScenes: paddedCeeScenes,
            combinedReport: ''
          }
        };

        if (EVIDENCE_CACHE.size >= MAX_CACHE_ENTRIES) {
          const oldK = EVIDENCE_CACHE.keys().next().value;
          if (oldK !== undefined) EVIDENCE_CACHE.delete(oldK);
        }
        EVIDENCE_CACHE.set(targetId, ceeBundle);
        return ceeBundle;
      }

      // الخطوة الاحتياطية: إذا لم تتوفر أوقات في سينمانا/Cee، نشغّل المصادر الستة ونظام التصويت
      const activeSources = [];
      if (meta.isSeries) {
        const imdbGuide = await fetchImdbParentsGuide(meta);
        if (imdbGuide) activeSources.push(imdbGuide);
      } else {
        const [imdbRes, kimRes, cringeRes] = await Promise.allSettled([
          fetchImdbParentsGuide(meta),
          fetchKidsInMind(meta),
          fetchCringeMdb(meta)
        ]);

        const imdb = imdbRes.status === 'fulfilled' ? imdbRes.value : null;
        const kim = kimRes.status === 'fulfilled' ? kimRes.value : null;
        const cringe = cringeRes.status === 'fulfilled' ? cringeRes.value : null;

        if (imdb) activeSources.push(imdb);
        if (kim) activeSources.push(kim);
        if (cringe) activeSources.push(cringe);

        const [pluggedRes, ppRes, dddRes] = await Promise.allSettled([
          fetchPluggedIn(meta),
          fetchParentPreviews(meta),
          fetchDoesTheDogDie(meta)
        ]);

        if (pluggedRes.status === 'fulfilled' && pluggedRes.value) activeSources.push(pluggedRes.value);
        if (ppRes.status === 'fulfilled' && ppRes.value) activeSources.push(ppRes.value);
        if (dddRes.status === 'fulfilled' && dddRes.value) activeSources.push(dddRes.value);
      }

      let cleanVotes = 0;
      let adultVotes = 0;
      let totalVoteWeight = 0;
      const directScenes = [];
      const allDescriptions = [];
      const sourceNames = [];

      if (ceeResult) sourceNames.push(`${ceeResult.source}:0-skips`);

      for (const src of activeSources) {
        sourceNames.push(src.source);
        if (src.isClean) cleanVotes++;
        if (src.hasAdult) {
          adultVotes++;
          totalVoteWeight += (src.voteWeight || 1);
        }
        if (Array.isArray(src.directScenes) && src.directScenes.length > 0) {
          directScenes.push(...src.directScenes);
        }
        if (Array.isArray(src.descriptions) && src.descriptions.length > 0) {
          allDescriptions.push(`=== ${src.source} ===\n${src.descriptions.join('\n')}`);
        }
      }

      const passedVoting = directScenes.length > 0 || (
        meta.isSeries
          ? adultVotes >= 1
          : (adultVotes >= 1 && (totalVoteWeight >= cleanVotes || adultVotes >= cleanVotes))
      );

      const label = meta.isSeries
        ? `${meta.title} S${meta.season}E${meta.episode} (${meta.episodeImdbId || 'no-ep-id'})`
        : (meta.title || meta.targetId);

      console.log(`[درع Nuvio 🛡️] ${label} | المصادر=[${sourceNames.join(', ') || 'لا يوجد'}] | تصويت حجب=${adultVotes} (وزن=${totalVoteWeight}) | نظيف=${cleanVotes} | أوقات مباشرة=${directScenes.length} | قرار التصويت=${passedVoting ? 'مفعل' : 'متخطى'}`);

      const bundle = {
        meta,
        evidence: {
          fromCinemana: false,
          activeCount: activeSources.length,
          cleanVotes,
          adultVotes,
          totalVoteWeight,
          passedVoting,
          directScenes: normalizeScenes(
            directScenes.map(sc => ({
              start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
              end: sc.end + SCENE_PAD_AFTER_SEC,
              type: 'wall'
            }))
          ),
          combinedReport: allDescriptions.join('\n\n').slice(0, 9500)
        }
      };

      if (EVIDENCE_CACHE.size >= MAX_CACHE_ENTRIES) {
        const oldK = EVIDENCE_CACHE.keys().next().value;
        if (oldK !== undefined) EVIDENCE_CACHE.delete(oldK);
      }
      EVIDENCE_CACHE.set(targetId, bundle);
      return bundle;
    } finally {
      IN_FLIGHT_EVIDENCE.delete(targetId);
    }
  })();

  IN_FLIGHT_EVIDENCE.set(targetId, p);
  return p;
}

// ===== 4. بناء خريطة الترجمة ومطابقتها عبر Gemini بنظام الثقة (احتياطي عند غياب أوقات سينمانا) =====
function buildSubtitleTimelineSummary(cues, texts) {
  if (!Array.isArray(cues) || !cues.length) return { summaryText: '', maxEndSec: 0 };

  const parsedCues = [];
  for (let i = 0; i < cues.length; i++) {
    const startSec = parseSubTimeSec(cues[i].start);
    const endSec = parseSubTimeSec(cues[i].end);
    const rawTxt = texts && texts[i] != null ? texts[i] : cues[i].text;
    const cleanTxt = String(rawTxt || '')
      .replace(/<[^>]+>|\{[^}]+\}/g, '')
      .replace(/\\+[nN]|\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (endSec > startSec && cleanTxt) {
      parsedCues.push({ startSec: Math.round(startSec), endSec: Math.round(endSec), text: cleanTxt.slice(0, 85) });
    }
  }

  if (!parsedCues.length) return { summaryText: '', maxEndSec: 0 };
  const maxEndSec = parsedCues[parsedCues.length - 1].endSec;

  const gaps = [];
  for (let i = 1; i < parsedCues.length; i++) {
    const prev = parsedCues[i - 1];
    const curr = parsedCues[i];
    const gapDur = curr.startSec - prev.endSec;
    if (gapDur >= 5 && gapDur <= 260) {
      gaps.push({
        gapStart: prev.endSec,
        gapEnd: curr.startSec,
        duration: gapDur,
        beforeText: prev.text,
        afterText: curr.text
      });
    }
  }

  const mergedTimeline = [];
  for (const c of parsedCues) {
    const last = mergedTimeline[mergedTimeline.length - 1];
    if (last && (c.startSec - last.endSec <= 2) && (last.text.length + c.text.length <= 130)) {
      last.endSec = c.endSec;
      last.text += ' / ' + c.text;
    } else {
      mergedTimeline.push({ ...c });
    }
  }

  const maxLines = 650;
  const step = mergedTimeline.length <= maxLines ? 1 : Math.ceil(mergedTimeline.length / maxLines);
  const timelineLines = [];
  for (let i = 0; i < mergedTimeline.length; i += step) {
    const c = mergedTimeline[i];
    timelineLines.push(`[${c.startSec}s-${c.endSec}s] ${c.text}`);
  }

  const gapLines = gaps.slice(0, 120).map(g =>
    `GAP [${g.gapStart}s -> ${g.gapEnd}s (${g.duration}s)] Before: "${g.beforeText}" | After: "${g.afterText}"`
  );

  return {
    maxEndSec,
    summaryText: `TOTAL_SUBTITLE_DURATION_SEC: ${maxEndSec}\n\nSILENT_GAPS:\n${gapLines.join('\n')}\n\nDIALOGUE_TIMELINE:\n${timelineLines.join('\n')}`
  };
}

async function matchScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName) {
  if (!Array.isArray(keysArray) || !keysArray.length) return [];
  const shared = getAiShared();
  if (!shared.acquireKey) return [];

  const { summaryText, maxEndSec } = buildSubtitleTimelineSummary(cues, texts);
  if (!summaryText) return [];

  const cleanModel = shared.normalizeGeminiModelId
    ? shared.normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite')
    : 'gemini-3.1-flash-lite';

  const directJson = JSON.stringify(evidence.directScenes || []);
  const prompt = `You are a high-precision parental-control synchronization engine.
Media: "${meta.title || meta.targetId}" (${meta.year || 'Unknown Year'})${meta.isSeries ? ` - Season ${meta.season}, Episode ${meta.episode} ("${meta.episodeTitle || ''}")` : ''}.

DIRECT_TIMESTAMPS_FROM_SOURCES:
${directJson}

VERIFIED_PARENTAL_GUIDE_FOR_THIS_TITLE:
${evidence.combinedReport}

SUBTITLE_TIMELINE_AND_SILENT_GAPS:
${summaryText}

STRICT RULES (READ CAREFULLY):
1. You may ONLY locate visual nudity/sex scenes that are explicitly described in VERIFIED_PARENTAL_GUIDE_FOR_THIS_TITLE.
2. FORBIDDEN FALSE POSITIVES: NEVER flag a scene just because characters talk about a brothel, a whore, Ros, bastards, stripping, or sex while having a normal clothed conversation! Verbal mentions in dialogue are NOT visual nudity scenes!
3. For each visual nudity/sex scene in VERIFIED_PARENTAL_GUIDE_FOR_THIS_TITLE, find the exact timestamp in SUBTITLE_TIMELINE_AND_SILENT_GAPS where that specific physical scene/bath/brothel action actually takes place on screen.
4. Assign a "confidence" score (0 to 100) for each matched timestamp. Give >= 85 ONLY if the scene setting, characters present, and silent gap/action clearly match the visual description in the Parental Guide. If you are guessing or unsure of the exact time, give confidence < 50.
5. Output ONLY a JSON array: [{"start": <seconds>, "end": <seconds>, "confidence": <0-100>}]. If no scene can be pinpointed with certainty, output [].`;

  const apiBase = shared.DEFAULT_GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta';

  for (let attempt = 0; attempt < 3; attempt++) {
    const activeKey = await shared.acquireKey(keysArray);
    if (!activeKey) break;
    const cleanKey = String(activeKey).trim();
    const url = `${apiBase}/models/${cleanModel}:generateContent`;

    try {
      const r = await shared.axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.05, responseMimeType: 'application/json' },
        safetySettings: shared.SAFETY_SETTINGS_OFF
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey,
          ...(shared.GEMINI_CLIENT_HEADER ? { 'x-goog-api-client': shared.GEMINI_CLIENT_HEADER } : {})
        },
        timeout: 35000,
        httpAgent: shared.httpAgent,
        httpsAgent: shared.httpsAgent
      });

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const rawOut = parts.map(p => p?.text || '').join('').trim();
      const jsonMatch = rawOut.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .map(x => ({
            start: Number(x.start),
            end: Number(x.end),
            confidence: Number(x.confidence ?? 90)
          }))
          .filter(x =>
            Number.isFinite(x.start) &&
            Number.isFinite(x.end) &&
            x.end > x.start &&
            x.start >= 0 &&
            x.confidence >= MIN_AI_CONFIDENCE &&
            (maxEndSec <= 0 || x.start <= maxEndSec + 120) &&
            (x.end - x.start <= 600)
          );
      }
    } catch (e) {
      console.log(`[درع Nuvio ⚠️] محاولة Gemini ${attempt + 1} فشلت: ${e && e.message}`);
      if (shared.isGeminiAuthFailure && shared.isGeminiAuthFailure(e)) {
        if (shared.deadKeys) shared.deadKeys.add(activeKey);
        continue;
      }
      if (shared.keyCooldowns && shared.cooldownForStatus) {
        const status = e.response?.status || 0;
        shared.keyCooldowns.set(activeKey, Date.now() + shared.cooldownForStatus(status));
      }
    }
  }
  return [];
}

// ===== الدالة الرئيسية لتحضير الدرع =====
async function prepareShield(targetId, cues, texts = null, keysArray = [], modelName = null) {
  if (USE_TEST_SCENES) return TEST_SCENES;
  if (!targetId) return [];

  const manual = getManualScenes(targetId);
  if (manual) return manual;

  const trackKey = getTrackCacheKey(targetId, cues);
  if (trackKey && RESOLVED_SCENES_CACHE.has(trackKey)) {
    const cached = RESOLVED_SCENES_CACHE.get(trackKey);
    LATEST_TARGET_SCENES.set(targetId, cached);
    return cached;
  }

  if (trackKey && IN_FLIGHT_TRACKS.has(trackKey)) {
    return IN_FLIGHT_TRACKS.get(trackKey);
  }

  const task = (async () => {
    try {
      const bundle = await getOrGatherEvidence(targetId);
      if (!bundle) return [];
      const { meta, evidence } = bundle;

      // 1. إذا جُلبت الأوقات مباشرة من سينمانا (cee.buzz / cinemana) نعتمدها فوراً بدون استدعاء الذكاء الاصطناعي
      if (evidence.fromCinemana && evidence.directScenes.length > 0) {
        saveTrackScenesToCache(targetId, trackKey, evidence.directScenes);
        return evidence.directScenes;
      }

      // 2. بوابة التصويت الصارمة عند عدم توفر أوقات سينمانا
      if (!evidence.passedVoting) {
        saveTrackScenesToCache(targetId, trackKey, []);
        return [];
      }

      let highConfidenceWalls = evidence.directScenes.slice();

      // 3. مطابقة التوقيت عبر Gemini بثقة عالية (>= 85%)
      if (evidence.combinedReport.length > 0) {
        const aiScenes = await matchScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName);
        if (aiScenes.length > 0) {
          const paddedAi = aiScenes.map(sc => ({
            start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
            end: sc.end + SCENE_PAD_AFTER_SEC,
            type: 'wall'
          }));
          highConfidenceWalls = normalizeScenes([...highConfidenceWalls, ...paddedAi]);
        }
      }

      if (highConfidenceWalls.length > 0) {
        console.log(`[درع Nuvio 🛡️] تم تثبيت (${highConfidenceWalls.length}) جدار حجب كامل الشاشة بثقة عالية (>=${MIN_AI_CONFIDENCE}%).`);
        saveTrackScenesToCache(targetId, trackKey, highConfidenceWalls);
        return highConfidenceWalls;
      }

      // 4. صمام الأمان (التنبيه المبكر بأول 10 ثوانٍ)
      const earlyAdvisory = [{
        start: 3,
        end: 13,
        type: 'advisory',
        msg: `🟨⚠️ تنبيه عائلي: العمل يحتوي على مشاهد غير عائلية (تصويت المصادر: ${evidence.adultVotes}) ⚠️🟨`
      }];
      console.log(`[درع Nuvio ⚠️] التصويت إيجابي (${evidence.adultVotes}) بدون توقيت مؤكد -> تم تفعيل التنبيه المبكر بأول 10 ثواني بدلاً من التخمين.`);
      saveTrackScenesToCache(targetId, trackKey, earlyAdvisory);
      return earlyAdvisory;
    } catch (err) {
      console.log(`[درع Nuvio ⚠️] خطأ غير متوقع أثناء فحص (${targetId}): ${err && err.message}`);
      return [];
    } finally {
      if (trackKey) IN_FLIGHT_TRACKS.delete(trackKey);
    }
  })();

  if (trackKey) IN_FLIGHT_TRACKS.set(trackKey, task);
  return task;
}

function calcSceneDurationSec(startSec, endSec) {
  const rawDuration = Math.max(1, Math.round(endSec - startSec));
  return Math.max(10, Math.ceil(rawDuration / 10) * 10);
}

function addAssRlm(text) {
  return String(text).split(/(\\N|\\n|\r?\n)/).map((p, i) => {
    if (i % 2 || !p.trim()) return p;
    const lead = p.match(LEAD_TAGS)[0];
    const rest = p.slice(lead.length);
    const tail = rest.match(TAIL_TAGS)[0];
    const body = rest.slice(0, rest.length - tail.length);
    if (!HAS_ARABIC.test(body)) return p;
    return lead + RLM + body + RLM + tail;
  }).join('');
}

const warnMsg = (d) => `🟨⚠️ مشهد🔞 قادم (${d} ثانية - قدّم ${d / 10} مرات) ⚠️🟨`;

function srtWarnBanner(text) {
  return `<b><font color="${WARN_COLOR_HEX}">${text}</font></b>`;
}

// ===== تطبيق الدرع على SRT (جدار كامل الشاشة بدون أي كلمة أو ترجمة أثناء التفعيل) =====
function applyShieldToSrtItems(items, targetId, customScenes = null, originalCues = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId, originalCues));
  if (!scenes.length) return items;

  let current = items.slice();
  let prevEnd = 0;

  for (const sc of scenes) {
    if (sc.type === 'advisory') {
      const advStart = sc.start;
      const advEnd = sc.end;
      const advBanner = srtWarnBanner(sc.msg);
      const next = [];
      const overlaps = [];

      for (const it of current) {
        if (it.endSec <= advStart || it.startSec >= advEnd) {
          next.push(it);
        } else {
          if (it.startSec < advStart) next.push({ startSec: it.startSec, endSec: advStart, text: it.text });
          const oS = Math.max(advStart, it.startSec);
          const oE = Math.min(advEnd, it.endSec);
          if (oE - oS >= 0.15) overlaps.push({ startSec: oS, endSec: oE, text: `${advBanner}\n${it.text}` });
          if (it.endSec > advEnd) next.push({ startSec: advEnd, endSec: it.endSec, text: it.text });
        }
      }

      overlaps.sort((a, b) => a.startSec - b.startSec);
      let cursor = advStart;
      for (const ov of overlaps) {
        if (ov.startSec - cursor >= 0.25) next.push({ startSec: cursor, endSec: ov.startSec, text: advBanner });
        next.push(ov);
        cursor = Math.max(cursor, ov.endSec);
      }
      if (advEnd - cursor >= 0.25) next.push({ startSec: cursor, endSec: advEnd, text: advBanner });

      next.sort((a, b) => a.startSec - b.startSec);
      current = next;
      continue;
    }

    const start = sc.start;
    const end = sc.end;
    const durationSec = calcSceneDurationSec(start, end);
    const warnStart = Math.max(prevEnd, start - WARN_SEC);
    const hasWarn = start - warnStart >= 1;
    const warnBanner = srtWarnBanner(warnMsg(durationSec));

    const outside = [];
    const inWarnWindow = [];

    for (const it of current) {
      if (it.startSec < (hasWarn ? warnStart : start)) {
        const cutEnd = Math.min(it.endSec, hasWarn ? warnStart : start);
        if (cutEnd - it.startSec >= 0.15) {
          outside.push({ startSec: it.startSec, endSec: cutEnd, text: it.text });
        }
      }

      if (hasWarn && it.endSec > warnStart && it.startSec < start) {
        const wStart = Math.max(warnStart, it.startSec);
        const wEnd = Math.min(start, it.endSec);
        if (wEnd - wStart >= 0.15) {
          inWarnWindow.push({
            startSec: wStart,
            endSec: wEnd,
            text: `${warnBanner}\n${it.text}`
          });
        }
      }

      if (it.endSec > end) {
        const afterStart = Math.max(end, it.startSec);
        if (it.endSec - afterStart >= 0.15) {
          outside.push({ startSec: afterStart, endSec: it.endSec, text: it.text });
        }
      }
    }

    const next = outside.slice();

    if (hasWarn) {
      inWarnWindow.sort((a, b) => a.startSec - b.startSec);
      let cursor = warnStart;
      for (const ov of inWarnWindow) {
        if (ov.startSec - cursor >= 0.25) {
          next.push({ startSec: cursor, endSec: ov.startSec, text: warnBanner });
        }
        next.push(ov);
        cursor = Math.max(cursor, ov.endSec);
      }
      if (start - cursor >= 0.25) {
        next.push({ startSec: cursor, endSec: start, text: warnBanner });
      }
    }

    next.push({ startSec: start, endSec: end, text: FULL_SRT_WALL });

    next.sort((a, b) => a.startSec - b.startSec);
    current = next;
    prevEnd = end;
  }

  return current;
}

function buildShieldedSrt(cues, texts, targetId, drawingRe = null) {
  const rawItems = [];
  cues.forEach((c, idx) => {
    if (drawingRe && drawingRe.test(c.text)) return;
    const rawTxt = texts ? texts[idx] : c.text;
    const text = String(rawTxt || '').replace(/\\+[nN]/g, '\n').trim();
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    const startSec = parseSubTimeSec(c.start);
    const endSec = parseSubTimeSec(c.end);
    if (endSec > startSec) rawItems.push({ startSec, endSec, text });
  });

  const shielded = applyShieldToSrtItems(rawItems, targetId, null, cues);
  let srtOutput = '';
  shielded.forEach((it, idx) => {
    srtOutput += `${idx + 1}\n${formatSrtTimeSec(it.startSec)} --> ${formatSrtTimeSec(it.endSec)}\n${it.text}\n\n`;
  });
  return srtOutput;
}

// ===== دوال ASS =====
function isCueInsideShield(startStr, endStr, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return false;
  const sSec = parseSubTimeSec(startStr);
  const eSec = parseSubTimeSec(endStr);
  return scenes.some(sc => sc.type !== 'advisory' && sSec < sc.end && eSec > sc.start);
}

function buildAssShieldLines(targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return [];

  const warnTopTag = `{\\an8\\1c${WARN_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c&HFFFFFF&\\3c&HFFFFFF&\\bord4\\shad0}`;
  const wall = wallTag + Array.from({ length: ASS_WALL_ROWS }, () => ASS_WALL_ROW).join('\\N');

  const extra = [];
  let prevEnd = 0;

  for (const sc of scenes) {
    if (sc.type === 'advisory') {
      const advLine = warnTopTag + sc.msg;
      extra.push(`Dialogue: 99,${formatAssTimeSec(sc.start)},${formatAssTimeSec(sc.end)},Default,,0,0,0,,${addAssRlm(advLine)}`);
      continue;
    }

    const start = sc.start;
    const end = sc.end;
    const durationSec = calcSceneDurationSec(start, end);
    const warnStart = Math.max(prevEnd, start - WARN_SEC);

    if (start - warnStart >= 1) {
      const warnLine = warnTopTag + warnMsg(durationSec);
      extra.push(`Dialogue: 99,${formatAssTimeSec(warnStart)},${formatAssTimeSec(start)},Default,,0,0,0,,${addAssRlm(warnLine)}`);
    }

    extra.push(`Dialogue: 99,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${wall}`);
    prevEnd = end;
  }

  return extra;
}

module.exports = {
  prepareShield,
  buildShieldedSrt,
  isCueInsideShield,
  buildAssShieldLines
};
