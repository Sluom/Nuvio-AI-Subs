// shield.js
// درع الترجمة (خاص بالأفلام فقط): مطابقة زمنية صارمة 100% + هامش 2.5 ثانية + تجاهل صامت وكامل للمسلسلات

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

// ===== 2. إعدادات الدقة الصارمة للأفلام فقط =====
const TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';
const MIN_AI_CONFIDENCE = 90;         // دقة مطابقة صارمة (90%) لمنع أي انحراف بالثواني
const SCENE_PAD_BEFORE_SEC = 2.5;     // هامش 2.5 ثانية فقط قبل المشهد
const SCENE_PAD_AFTER_SEC = 2.5;      // هامش 2.5 ثانية فقط بعد المشهد
const USE_TEST_SCENES = false;        // false = التشغيل الفعلي
const HTTP_TIMEOUT_MS = 8500;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9'
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

// ===== قائمة أولوية يدوية للأفلام (اختيارية) =====
const SCENES_DB = {
  // 'tt0993846': [['01:12', '01:48'], ['11:18', '12:05']],
};

const TEST_SCENES = [
  { start: 20, end: 45, type: 'wall' },
  { start: 300, end: 315, type: 'wall' }
];

// فحص صارم: يقبل معرّف الفلم فقط (tt1234567) ويرفض أي مسلسل يحتوي على نقطتين (:) بصمت تام
function isMovieTargetId(targetId) {
  const raw = String(targetId || '').trim();
  if (!raw || raw.includes(':')) return false;
  return /^tt\d{6,10}$/i.test(raw);
}

// كاش معزول للأفلام وملفات الترجمة
const EVIDENCE_CACHE = new Map();
const RESOLVED_SCENES_CACHE = new Map();
const LATEST_TARGET_SCENES = new Map();
const IN_FLIGHT_EVIDENCE = new Map();
const IN_FLIGHT_TRACKS = new Map();

function getTrackCacheKey(targetId, cues) {
  if (!isMovieTargetId(targetId)) return '';
  if (!Array.isArray(cues) || cues.length === 0) return String(targetId).toLowerCase();
  const first = String(cues[0]?.start || '').trim();
  const last = String(cues[cues.length - 1]?.end || '').trim();
  return `${String(targetId).toLowerCase()}::${cues.length}::${first}::${last}`;
}

function saveTrackScenesToCache(targetId, trackKey, scenes) {
  if (!isMovieTargetId(targetId)) return;
  const cleanId = String(targetId).trim().toLowerCase();
  if (RESOLVED_SCENES_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = RESOLVED_SCENES_CACHE.keys().next().value;
    if (oldestKey !== undefined) RESOLVED_SCENES_CACHE.delete(oldestKey);
  }
  if (trackKey) RESOLVED_SCENES_CACHE.set(trackKey, scenes);
  LATEST_TARGET_SCENES.set(cleanId, scenes);
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
    if (!last || sc.type !== last.type || sc.start > last.end + 3) {
      merged.push({ ...sc });
    } else {
      last.end = Math.max(last.end, sc.end);
    }
  }
  return merged;
}

function getManualScenes(targetId) {
  if (!isMovieTargetId(targetId)) return null;
  const raw = SCENES_DB[targetId] || SCENES_DB[String(targetId).toLowerCase()];
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
  if (!isMovieTargetId(targetId)) return [];
  if (USE_TEST_SCENES) return TEST_SCENES;
  const manual = getManualScenes(targetId);
  if (manual) return manual;
  if (Array.isArray(cues) && cues.length > 0) {
    const tk = getTrackCacheKey(targetId, cues);
    if (RESOLVED_SCENES_CACHE.has(tk)) return RESOLVED_SCENES_CACHE.get(tk) || [];
  }
  const cleanId = String(targetId).trim().toLowerCase();
  if (LATEST_TARGET_SCENES.has(cleanId)) {
    return LATEST_TARGET_SCENES.get(cleanId) || [];
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

function extractRegexTimestampsFromDescriptions(descList) {
  if (!Array.isArray(descList)) return [];
  const extracted = [];
  const rangeRe = /\b(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:to|[-–—]|until)\s*(\d{1,2}:\d{2}(?::\d{2})?)\b/gi;

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
  }
  return extracted;
}

// ===== 1. جلب بيانات الفلم فقط (يرفض المسلسلات تماماً) =====
async function resolveMovieMeta(targetId) {
  if (!isMovieTargetId(targetId)) return null;
  const imdbId = String(targetId).trim().toLowerCase();

  let title = '';
  let year = null;
  let runtimeSec = 0;

  // أ) جلب من TMDB للتأكد من أنه فلم سينمائي وليس مسلسلاً
  try {
    const findEn = await safeHttpGet(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=en-US`, {}, 6500);
    if (Array.isArray(findEn?.tv_results) && findEn.tv_results.length > 0 && (!findEn.movie_results || !findEn.movie_results.length)) {
      return null; // إذا كان مسلسلاً نتجاهله تماماً
    }
    const movieObj = (findEn?.movie_results || [])[0];
    if (movieObj) {
      title = String(movieObj.title || movieObj.original_title || '').trim();
      const dateStr = String(movieObj.release_date || '');
      if (dateStr.length >= 4) year = parseInt(dateStr.slice(0, 4), 10) || null;
    }
  } catch (_) {}

  // ب) جلب من IMDb Suggestion API
  if (!title || !year) {
    try {
      const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/t/${imdbId}.json`);
      const item = Array.isArray(sug?.d) ? sug.d.find(x => x.id === imdbId) || sug.d[0] : null;
      if (item) {
        if (/tvSeries|tvMiniSeries|tvEpisode/i.test(String(item.qid || item.q || ''))) {
          return null; // استبعاد المسلسلات
        }
        if (!title) title = String(item.l || '').trim();
        if (!year && Number.isFinite(Number(item.y))) year = Number(item.y);
      }
    } catch (_) {}
  }

  // ج) جلب احتياطي من Cinemeta للأفلام فقط
  if (!title || !year) {
    try {
      const cm = await safeHttpGet(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
      const meta = cm?.meta;
      if (meta) {
        if (!title && meta.name) title = String(meta.name).trim();
        if (!year && meta.year) {
          const yMatch = String(meta.year).match(/\d{4}/);
          if (yMatch) year = Number(yMatch[0]);
        }
        if (meta.runtime) {
          const rm = String(meta.runtime).match(/(\d+)/);
          if (rm) runtimeSec = parseInt(rm[1], 10) * 60;
        }
      }
    } catch (_) {}
  }

  if (!title) return null;

  return {
    imdbId,
    title,
    year,
    runtimeSec
  };
}

// ===== 2. المصادر الـ 6 للأفلام (مرتبة هرمياً حسب الدقة) =====

// [المصدر 1 - التوقيت الجاهز بالثانية]: CringeMDb
async function fetchCringeMdb(meta) {
  if (!meta || !meta.title) return null;
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

        const isBriefSuggestiveOnly = /Suggestive/i.test(category) && !/\b(naked|nude|sex|breast|topless|lingerie|stripper|underwear|bed|kissing|making out)\b/i.test(details);
        if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && !isBriefSuggestiveOnly) {
          directScenes.push({ start: startSec, end: endSec, type: 'wall', note: `${category}: ${details.slice(0, 180)}` });
          descriptions.push(`[EXACT TIMESTAMP ${m[1]} to ${m[2]} (${startSec}s - ${endSec}s)] (${category}): ${details.slice(0, 220)}`);
        }
      }

      const staffMatch = text.match(/CringeMDb Staff Says:\s*([^.*]+(?:\.[^.*]+){0,4})/i);
      if (staffMatch) descriptions.push(`Staff Note: ${staffMatch[1].trim().slice(0, 300)}`);

      const hasAdult = !isSafe || directScenes.length > 0;
      return {
        source: 'CringeMDb',
        voteWeight: directScenes.length > 0 ? 3 : (hasAdult ? 1 : 0),
        isClean: isSafe && directScenes.length === 0,
        hasAdult,
        directScenes,
        descriptions
      };
    } catch (_) {}
  }
  return null;
}

// [المصدر 2 - الأدق في التسلسل الزمني الكامل]: Kids-In-Mind
async function fetchKidsInMind(meta) {
  if (!meta || !meta.title) return null;
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
      const desc = secMatch[2].trim().slice(0, 3500);
      const hasAdult = score >= 3 || /\b(nudity|nude|naked|sex|intercourse|breasts|topless|prostitute|stripper|orgy|rape|masturbat|thrusting|making love|buttocks)\b/i.test(desc);
      return {
        source: 'Kids-In-Mind',
        score,
        voteWeight: score >= 5 ? 2 : (hasAdult ? 1 : 0),
        isClean: score <= 1 && !hasAdult,
        hasAdult,
        directScenes: extractRegexTimestampsFromDescriptions([desc]),
        descriptions: desc ? [`[Kids-In-Mind Score ${score}/10 - STRICT CHRONOLOGICAL SCENE ORDER]: ${desc}`] : []
      };
    } catch (_) {}
  }
  return null;
}

// [المصدر 3 - الأشمل عالمياً]: IMDb Parents Guide + Plot Synopsis
async function fetchImdbParentsGuide(meta) {
  if (!meta || !meta.imdbId) return null;
  const imdbId = meta.imdbId;

  // 3-أ: عبر api.imdbapi.dev
  try {
    const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${imdbId}/parentsGuide`, { Accept: 'application/json' });
    const guide = data?.parentalGuide || data?.parentsGuide || data;
    const parsed = extractImdbGuideData(guide);
    if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
  } catch (_) {}

  // 3-ب: عبر IMDb GraphQL
  try {
    const { axios } = getAiShared();
    const query = `query { title(id: "${imdbId}") { parentsGuide { guideItems(first: 50) { edges { node { category { id } text { plainText } } } } } } }`;
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
        source: 'IMDb-ParentsGuide',
        itemCount: realNudityItems.length,
        voteWeight: realNudityItems.length >= 2 ? 2 : (realNudityItems.length === 1 ? 1 : 0),
        isClean: realNudityItems.length === 0,
        hasAdult: realNudityItems.length > 0,
        directScenes: extractRegexTimestampsFromDescriptions(realNudityItems),
        descriptions: realNudityItems.slice(0, 35)
      };
    }
  } catch (_) {}

  // 3-ج: عبر صفحة HTML المباشرة
  try {
    const html = await safeHttpGet(`https://www.imdb.com/title/${imdbId}/parentalguide`);
    if (typeof html === 'string' && html.length > 1000) {
      const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (nextMatch) {
        const json = JSON.parse(nextMatch[1]);
        const parsed = extractImdbGuideData(json);
        if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
      }
    }
  } catch (_) {}

  return null;
}

function extractImdbGuideData(obj) {
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
    source: 'IMDb-ParentsGuide',
    severity,
    itemCount: descriptions.length,
    voteWeight: /SEVERE|MODERATE/i.test(severity) || descriptions.length >= 2 ? 2 : (hasAdult ? 1 : 0),
    isClean: isNone,
    hasAdult,
    directScenes: extractRegexTimestampsFromDescriptions(descriptions),
    descriptions: descriptions.slice(0, 35)
  };
}

// [المصدر 4]: Plugged In
async function fetchPluggedIn(meta) {
  if (!meta || !meta.title) return null;
  const slug = slugifyStandard(meta.title);
  if (!slug) return null;

  try {
    const html = await safeHttpGet(`https://www.pluggedin.com/movie-reviews/${slug}/`);
    if (typeof html !== 'string' || html.length < 500) return null;
    const text = stripHtmlTags(html);
    const secMatch = text.match(/Sexual\s*(?:&|and)\s*Romantic Content([\s\S]*?)(?=Violent Content|Crude or Profane Language|Drug\s*(?:&|and)\s*Alcohol Content|Other Noteworthy Elements|Conclusion|$)/i);
    if (!secMatch) return null;

    const desc = secMatch[1].trim().slice(0, 2500);
    if (!desc || desc.length < 15) return null;
    const isClean = /^(none|nothing|not applicable|no sexual content)\b/i.test(desc);
    const hasExplicitKeywords = /\b(nude|nudity|naked|sex|intercourse|breasts|topless|prostitute|stripper|rape|making love|thrusting|orgy|buttocks)\b/i.test(desc);

    return {
      source: 'PluggedIn',
      voteWeight: hasExplicitKeywords ? 1 : 0,
      isClean,
      hasAdult: !isClean && hasExplicitKeywords,
      directScenes: extractRegexTimestampsFromDescriptions([desc]),
      descriptions: [`[PluggedIn Review]: ${desc}`]
    };
  } catch (_) {
    return null;
  }
}

// [المصدر 5]: Parent Previews
async function fetchParentPreviews(meta) {
  if (!meta || !meta.title) return null;
  const slug = slugifyStandard(meta.title);
  if (!slug) return null;

  try {
    const html = await safeHttpGet(`https://parentpreviews.com/movie-reviews/${slug}`);
    if (typeof html !== 'string' || html.length < 500) return null;
    const text = stripHtmlTags(html);
    const secMatch = text.match(/Sexual Content:\s*([\s\S]*?)(?=Profanity:|Alcohol\s*\/\s*Drug Use:|Violence:|Overall\s+[A-F]|$)/i);
    if (!secMatch) return null;

    const desc = secMatch[1].trim().slice(0, 2000);
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
  if (!meta || !meta.title) return null;
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

// ===== 3. محرك جمع الأدلة الهرمي والتصويت للأفلام =====
async function getOrGatherMovieEvidence(targetId) {
  if (!isMovieTargetId(targetId)) return null;
  const cleanId = String(targetId).trim().toLowerCase();

  if (EVIDENCE_CACHE.has(cleanId)) return EVIDENCE_CACHE.get(cleanId);
  if (IN_FLIGHT_EVIDENCE.has(cleanId)) return IN_FLIGHT_EVIDENCE.get(cleanId);

  const p = (async () => {
    try {
      const meta = await resolveMovieMeta(cleanId);
      if (!meta) return null;

      // جلب المصادر الـ 6 للأفلام بالتوازي للحصول على أعلى دقة وتكامل
      const settled = await Promise.allSettled([
        fetchCringeMdb(meta),
        fetchKidsInMind(meta),
        fetchImdbParentsGuide(meta),
        fetchPluggedIn(meta),
        fetchParentPreviews(meta),
        fetchDoesTheDogDie(meta)
      ]);

      const activeSources = settled
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      let cleanVotes = 0;
      let adultVotes = 0;
      let totalVoteWeight = 0;
      const directScenes = [];
      const allDescriptions = [];
      const sourceNames = [];

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
        adultVotes >= 1 && (totalVoteWeight >= cleanVotes || adultVotes >= cleanVotes)
      );

      console.log(`[درع الأفلام 🛡️] ${meta.title} (${meta.year || cleanId}) | المصادر=[${sourceNames.join(', ') || 'لا يوجد'}] | تصويت حجب=${adultVotes} (وزن=${totalVoteWeight}) | نظيف=${cleanVotes} | أوقات مباشرة=${directScenes.length} | القرار=${passedVoting ? 'مفعل' : 'فلم نظيف'}`);

      const bundle = {
        meta,
        evidence: {
          activeCount: activeSources.length,
          cleanVotes,
          adultVotes,
          totalVoteWeight,
          passedVoting,
          rawDirectScenes: normalizeScenes(directScenes),
          combinedReport: allDescriptions.join('\n\n').slice(0, 12000)
        }
      };

      if (EVIDENCE_CACHE.size >= MAX_CACHE_ENTRIES) {
        const oldK = EVIDENCE_CACHE.keys().next().value;
        if (oldK !== undefined) EVIDENCE_CACHE.delete(oldK);
      }
      EVIDENCE_CACHE.set(cleanId, bundle);
      return bundle;
    } finally {
      IN_FLIGHT_EVIDENCE.delete(cleanId);
    }
  })();

  IN_FLIGHT_EVIDENCE.set(cleanId, p);
  return p;
}

// ===== 4. بناء خريطة الترجمة الكاملة ومعايرة التوقيت عبر Gemini (دقة >= 90%) =====
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
      parsedCues.push({ startSec: Math.round(startSec), endSec: Math.round(endSec), text: cleanTxt.slice(0, 90) });
    }
  }

  if (!parsedCues.length) return { summaryText: '', maxEndSec: 0 };
  const maxEndSec = parsedCues[parsedCues.length - 1].endSec;

  // رصد كل الفجوات الصامتة (>= 4 ثوانٍ) لأنها تحدد بداية ونهاية المشاهد البصرية بالثانية
  const gaps = [];
  for (let i = 1; i < parsedCues.length; i++) {
    const prev = parsedCues[i - 1];
    const curr = parsedCues[i];
    const gapDur = curr.startSec - prev.endSec;
    if (gapDur >= 4 && gapDur <= 300) {
      gaps.push({
        gapStart: prev.endSec,
        gapEnd: curr.startSec,
        duration: gapDur,
        beforeText: prev.text,
        afterText: curr.text
      });
    }
  }

  // دمج الأسطر المتقاربة جداً (< 1.5 ثانية) لإرسال خريطة الفلم كاملة (حتى 1500 كتلة حوارية) بدون فقدان أي مشهد
  const mergedTimeline = [];
  for (const c of parsedCues) {
    const last = mergedTimeline[mergedTimeline.length - 1];
    if (last && (c.startSec - last.endSec <= 1) && (last.text.length + c.text.length <= 120)) {
      last.endSec = c.endSec;
      last.text += ' | ' + c.text;
    } else {
      mergedTimeline.push({ ...c });
    }
  }

  const maxLines = 1500;
  const step = mergedTimeline.length <= maxLines ? 1 : Math.ceil(mergedTimeline.length / maxLines);
  const timelineLines = [];
  for (let i = 0; i < mergedTimeline.length; i += step) {
    const c = mergedTimeline[i];
    timelineLines.push(`[${c.startSec}s-${c.endSec}s] ${c.text}`);
  }

  const gapLines = gaps.slice(0, 180).map(g =>
    `GAP [${g.gapStart}s -> ${g.gapEnd}s (${g.duration}s)] Before: "${g.beforeText}" | After: "${g.afterText}"`
  );

  return {
    maxEndSec,
    summaryText: `TOTAL_SUBTITLE_DURATION_SEC: ${maxEndSec}\n\nSILENT_GAPS:\n${gapLines.join('\n')}\n\nCOMPLETE_MOVIE_DIALOGUE_TIMELINE:\n${timelineLines.join('\n')}`
  };
}

async function calibrateMovieScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName) {
  if (!Array.isArray(keysArray) || !keysArray.length) return [];
  const shared = getAiShared();
  if (!shared.acquireKey) return [];

  const { summaryText, maxEndSec } = buildSubtitleTimelineSummary(cues, texts);
  if (!summaryText) return [];

  const cleanModel = shared.normalizeGeminiModelId
    ? shared.normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite')
    : 'gemini-3.1-flash-lite';

  const directJson = JSON.stringify(evidence.rawDirectScenes || []);
  const prompt = `You are an ultra-precise movie timestamp synchronization engine (zero-tolerance for >3 second drift).
Movie: "${meta.title}" (${meta.year || 'Unknown Year'}).

DIRECT_TIMESTAMPS_FROM_CRINGEMDB:
${directJson}

VERIFIED_PARENTAL_GUIDES (Kids-In-Mind Chronological Order, IMDb, PluggedIn, ParentPreviews):
${evidence.combinedReport}

ACTUAL_SUBTITLE_TIMELINE_AND_SILENT_GAPS_OF_THIS_VIDEO_FILE:
${summaryText}

STRICT SYNCHRONIZATION PROTOCOL:
1. Identify ALL explicit sex scenes, nudity scenes (female/male nudity, topless, exposed breasts/buttocks/genitals), strip club/orgy scenes, or sexual violence explicitly described in VERIFIED_PARENTAL_GUIDES or DIRECT_TIMESTAMPS_FROM_CRINGEMDB.
2. ZERO-DRIFT CALIBRATION: Video releases (BluRay vs Web-DL) can differ by a few seconds due to studio intro logos. Anchor every scene to the ACTUAL_SUBTITLE_TIMELINE_AND_SILENT_GAPS_OF_THIS_VIDEO_FILE:
   - Look at the exact dialogue lines spoken right before the scene starts, during the scene, and right after the scene ends.
   - If a nudity/sex scene starts while characters are speaking in that room/bed/party, set "start" to the EXACT second that specific conversation/action begins.
   - Set "end" to the EXACT second the visual nudity/sex scene ends and the next scene/dialogue begins.
3. NEVER flag mere verbal mentions of sex/nudity during normal clothed dialogue.
4. Give a "confidence" score (0-100). Output ONLY scenes with confidence >= ${MIN_AI_CONFIDENCE} where the exact second-level boundaries are verified against the subtitle timeline or CringeMDb.
5. Output ONLY a valid JSON array: [{"start": <number_in_seconds>, "end": <number_in_seconds>, "confidence": <0-100>}].`;

  const apiBase = shared.DEFAULT_GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta';

  for (let attempt = 0; attempt < 3; attempt++) {
    const activeKey = await shared.acquireKey(keysArray);
    if (!activeKey) break;
    const cleanKey = String(activeKey).trim();
    const url = `${apiBase}/models/${cleanModel}:generateContent`;

    try {
      const r = await shared.axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
        safetySettings: shared.SAFETY_SETTINGS_OFF
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey,
          ...(shared.GEMINI_CLIENT_HEADER ? { 'x-goog-api-client': shared.GEMINI_CLIENT_HEADER } : {})
        },
        timeout: 38000,
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
            confidence: Number(x.confidence ?? 95)
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

// ===== الدالة الرئيسية لتحضير الدرع (للأفلام فقط) =====
async function prepareShield(targetId, cues, texts = null, keysArray = [], modelName = null) {
  // إذا لم يكن فلماً (أي مسلسل يحتوي على : أو غير صالح) نخرج فوراً وبصمت تام بدون أي لوغ
  if (!isMovieTargetId(targetId)) return [];
  if (USE_TEST_SCENES) return TEST_SCENES;

  const cleanId = String(targetId).trim().toLowerCase();
  const manual = getManualScenes(cleanId);
  if (manual) return manual;

  const trackKey = getTrackCacheKey(cleanId, cues);
  if (trackKey && RESOLVED_SCENES_CACHE.has(trackKey)) {
    const cached = RESOLVED_SCENES_CACHE.get(trackKey);
    LATEST_TARGET_SCENES.set(cleanId, cached);
    return cached;
  }

  if (trackKey && IN_FLIGHT_TRACKS.has(trackKey)) {
    return IN_FLIGHT_TRACKS.get(trackKey);
  }

  const task = (async () => {
    try {
      const bundle = await getOrGatherMovieEvidence(cleanId);
      if (!bundle) return [];
      const { meta, evidence } = bundle;

      // 1. إذا كان الفلم نظيفاً بالتصويت
      if (!evidence.passedVoting) {
        saveTrackScenesToCache(cleanId, trackKey, []);
        return [];
      }

      // 2. معايرة الأوقات عبر Gemini مع خطوط الترجمة + أوقات CringeMDb
      let calibratedScenes = [];
      if (evidence.combinedReport.length > 0 || evidence.rawDirectScenes.length > 0) {
        const aiScenes = await calibrateMovieScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName);
        if (aiScenes.length > 0) {
          calibratedScenes = aiScenes.map(sc => ({
            start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
            end: sc.end + SCENE_PAD_AFTER_SEC,
            type: 'wall'
          }));
        }
      }

      // 3. إذا لم يستجب Gemini لأي سبب، نستخدم أوقات CringeMDb المباشرة مع هامش الـ 2.5 ثانية
      if (calibratedScenes.length === 0 && evidence.rawDirectScenes.length > 0) {
        calibratedScenes = evidence.rawDirectScenes.map(sc => ({
          start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
          end: sc.end + SCENE_PAD_AFTER_SEC,
          type: 'wall'
        }));
      }

      const finalWalls = normalizeScenes(calibratedScenes);

      if (finalWalls.length > 0) {
        const preview = finalWalls.map(w => `${formatSrtTimeSec(w.start).slice(0, 8)}->${formatSrtTimeSec(w.end).slice(0, 8)}`).join(', ');
        console.log(`[درع الأفلام 🛡️] ${meta.title}: تم تثبيت (${finalWalls.length}) مشهد بدقة عالية (هامش ${SCENE_PAD_BEFORE_SEC}ث): [${preview}]`);
        saveTrackScenesToCache(cleanId, trackKey, finalWalls);
        return finalWalls;
      }

      saveTrackScenesToCache(cleanId, trackKey, []);
      return [];
    } catch (err) {
      console.log(`[درع الأفلام ⚠️] خطأ أثناء فحص الفلم (${cleanId}): ${err && err.message}`);
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

// ===== تطبيق الدرع على SRT (للأفلام فقط) =====
function applyShieldToSrtItems(items, targetId, customScenes = null, originalCues = null) {
  if (!isMovieTargetId(targetId)) return items;
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId, originalCues));
  if (!scenes.length) return items;

  let current = items.slice();
  let prevEnd = 0;

  for (const sc of scenes) {
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

  const shielded = isMovieTargetId(targetId)
    ? applyShieldToSrtItems(rawItems, targetId, null, cues)
    : rawItems;

  let srtOutput = '';
  shielded.forEach((it, idx) => {
    srtOutput += `${idx + 1}\n${formatSrtTimeSec(it.startSec)} --> ${formatSrtTimeSec(it.endSec)}\n${it.text}\n\n`;
  });
  return srtOutput;
}

// ===== دوال ASS (للأفلام فقط) =====
function isCueInsideShield(startStr, endStr, targetId, customScenes = null) {
  if (!isMovieTargetId(targetId)) return false;
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return false;
  const sSec = parseSubTimeSec(startStr);
  const eSec = parseSubTimeSec(endStr);
  return scenes.some(sc => sSec < sc.end && eSec > sc.start);
}

function buildAssShieldLines(targetId, customScenes = null) {
  if (!isMovieTargetId(targetId)) return [];
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return [];

  const warnTopTag = `{\\an8\\1c${WARN_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c&HFFFFFF&\\3c&HFFFFFF&\\bord4\\shad0}`;
  const wall = wallTag + Array.from({ length: ASS_WALL_ROWS }, () => ASS_WALL_ROW).join('\\N');

  const extra = [];
  let prevEnd = 0;

  for (const sc of scenes) {
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
