// shield.js
// درع الترجمة: التدرج الذكي المضمون + تنبيه مسبق يختفي أثناء المشهد + جدار أسود مع إبقاء الحوار

const axiosDefault = require('axios');

const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// ===== إعدادات المظهر والألوان (عدّلها من هنا فقط) =====
const WARN_SEC = 10;                  // مدة التنبيه المسبق قبل المشهد بالثواني (يختفي عند بدء المشهد)
const WARN_COLOR_HEX = '#FFD400';     // لون تنبيه "مشهد🔞 قادم" (أصفر ذهبي)
const WALL_COLOR_HEX = '#000000';     // لون الجدار في المشغلات التي تدعم الألوان
const WALL_CHAR = '⬛';                // إيموجي المربع الأسود (يضمن ظهور الجدار بالأسود حتى في مشغلات SRT البيضاء)
const WALL_COLS = 24;                 // عدد المربعات السوداء في كل سطر (24 مربع إيموجي عريض يغطي عرض الشاشة)
const WALL_ROWS = 14;                 // عدد أسطر الجدار لتغطية ارتفاع الشاشة

// ===== إعدادات الهوامش والتشغيل الفعلي =====
const SCENE_PAD_BEFORE_SEC = 7;       // هامش أمان مبكر قبل المشهد (لتغطية أول 20 ثانية بالكامل)
const SCENE_PAD_AFTER_SEC = 3;        // هامش أمان بعد نهاية المشهد
const USE_TEST_SCENES = false;        // false = التشغيل الفعلي على الأفلام والمسلسلات
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
const WALL_ASS = hexToAss(WALL_COLOR_HEX);
const WALL_ROW = WALL_CHAR.repeat(WALL_COLS);
const ASS_WALL_ROW = '█'.repeat(42);

// ===== قائمة أولوية يدوية (اختيارية) =====
const SCENES_DB = {
  // 'tt0000000': [['12:30', '13:10'], ['45:00', '46:20']],
};

const TEST_SCENES = [
  { start: 20, end: 45 },
  { start: 300, end: 315 }
];

// كاش الذاكرة (يحفظ فقط النتائج الناجحة أو المؤكدة)
const RESOLVED_SCENES_CACHE = new Map();
const CUES_MEMORY_CACHE = new Map();
const IN_FLIGHT_REQUESTS = new Map();

function saveToMemoryCache(key, scenes, cues = null) {
  if (!key) return;
  if (RESOLVED_SCENES_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = RESOLVED_SCENES_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      RESOLVED_SCENES_CACHE.delete(oldestKey);
      CUES_MEMORY_CACHE.delete(oldestKey);
    }
  }
  RESOLVED_SCENES_CACHE.set(key, scenes);
  if (Array.isArray(cues) && cues.length > 0) {
    CUES_MEMORY_CACHE.set(key, cues);
  }
}

function toSec(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const p = String(v || '').trim().split(':').map(Number);
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
    .map(sc => ({ start: Number(sc.start), end: Number(sc.end) }))
    .filter(sc => Number.isFinite(sc.start) && Number.isFinite(sc.end) && sc.end > sc.start && sc.start >= 0)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const sc of valid) {
    if (!merged.length || sc.start > merged[merged.length - 1].end + 4) {
      merged.push({ ...sc });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, sc.end);
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
      list.push({ start: Math.max(0, a - SCENE_PAD_BEFORE_SEC), end: b + SCENE_PAD_AFTER_SEC });
    }
  }
  return normalizeScenes(list);
}

function getScenesForMedia(targetId) {
  if (USE_TEST_SCENES) return TEST_SCENES;
  const manual = getManualScenes(targetId);
  if (manual) return manual;
  if (targetId && RESOLVED_SCENES_CACHE.has(targetId)) {
    return RESOLVED_SCENES_CACHE.get(targetId) || [];
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

async function safeHttpGet(url, extraHeaders = {}) {
  const { axios } = getAiShared();
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    timeout: HTTP_TIMEOUT_MS,
    maxContentLength: MAX_HTTP_BYTES,
    validateStatus: s => s >= 200 && s < 300
  });
  return res.data;
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
        extracted.push({ start: a, end: b });
      }
    }
    while ((m = pointRe.exec(s)) !== null) {
      const a = toSec(m[1]);
      if (Number.isFinite(a) && a > 0) {
        extracted.push({ start: Math.max(0, a - 5), end: a + 35 });
      }
    }
  }
  return extracted;
}

// ===== 1. جلب معلومات الفلم أو الحلقة =====
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
  let year = null;
  let episodeImdbId = null;
  let episodeTitle = '';
  let episodePlot = '';

  try {
    const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/t/${baseImdbId}.json`);
    const item = Array.isArray(sug?.d) ? sug.d.find(x => x.id === baseImdbId) || sug.d[0] : null;
    if (item) {
      title = String(item.l || '').trim();
      if (Number.isFinite(Number(item.y))) year = Number(item.y);
    }
  } catch (_) {}

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
            else if (epObj.id && /^tt\d+$/i.test(epObj.id)) episodeImdbId = epObj.id.toLowerCase();
            if (epObj.name || epObj.title) episodeTitle = String(epObj.name || epObj.title).trim();
            if (epObj.overview || epObj.description) episodePlot = String(epObj.overview || epObj.description).trim();
          }
        }
      }
    } catch (_) {}
  }

  return {
    targetId: raw,
    baseImdbId,
    episodeImdbId,
    isSeries,
    season,
    episode,
    title,
    year,
    episodeTitle,
    episodePlot
  };
}

// ===== 2. المصادر المرتبة (بالنسخة المضمونة التي أثبتت نجاحها في اللوغ الأول) =====

// [المرتبة 1]: IMDb Parents Guide (يجرب api.imdbapi.dev ثم GraphQL البسيط ثم HTML لضمان عدم ضياع أي مشهد)
async function fetchImdbParentsGuide(meta) {
  if (!meta) return null;
  const idsToTry = [meta.episodeImdbId, meta.baseImdbId].filter(Boolean);

  for (const imdbId of idsToTry) {
    // 1-أ: عبر api.imdbapi.dev (الأضمن والأغنى بالتفاصيل)
    try {
      const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${imdbId}/parentsGuide`, { Accept: 'application/json' });
      const guide = data?.parentalGuide || data?.parentsGuide || data;
      const parsed = extractImdbGuideData(guide);
      if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
    } catch (_) {}

    // 1-ب: عبر IMDb GraphQL البسيط والمضمون
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

        if (nudityItems.length > 0 || imdbId === meta.baseImdbId) {
          return {
            source: 'IMDb-GraphQL',
            itemCount: nudityItems.length,
            isClean: nudityItems.length === 0,
            hasAdult: nudityItems.length > 0,
            directScenes: extractRegexTimestampsFromDescriptions(nudityItems),
            descriptions: nudityItems.slice(0, 30)
          };
        }
      }
    } catch (_) {}

    // 1-ج: عبر صفحة HTML المباشرة
    try {
      const html = await safeHttpGet(`https://www.imdb.com/title/${imdbId}/parentalguide`);
      if (typeof html === 'string' && html.length > 1000) {
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextMatch) {
          const json = JSON.parse(nextMatch[1]);
          const parsed = extractImdbGuideData(json);
          if (parsed && (parsed.descriptions.length > 0 || parsed.isClean)) return parsed;
        }
        const nuditySec = html.match(/id="advisory-nudity"[\s\S]*?(?=id="advisory-violence"|id="advisory-profanity"|<\/section>)/i);
        if (nuditySec) {
          const items = [];
          const liRe = /<li[^>]*class="[^"]*ipl-zebra-list__item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
          let m;
          while ((m = liRe.exec(nuditySec[0])) !== null) {
            const cleanItem = stripHtmlTags(m[1]).replace(/Edit\s*$/i, '').trim();
            if (cleanItem) items.push(cleanItem);
          }
          if (items.length > 0) {
            return {
              source: 'IMDb-HTML',
              itemCount: items.length,
              isClean: false,
              hasAdult: true,
              directScenes: extractRegexTimestampsFromDescriptions(items),
              descriptions: items.slice(0, 30)
            };
          }
        }
      }
    } catch (_) {}
  }
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
      if (decoded && !descriptions.includes(decoded)) descriptions.push(decoded);
    } catch (_) {}
  }

  if (Array.isArray(obj.categories)) {
    for (const cat of obj.categories) {
      if (/NUDITY|SEX/i.test(String(cat.category || cat.id || cat.title || ''))) {
        severity = String(cat.severity || cat.level || '').toUpperCase();
        const list = cat.items || cat.entries || cat.texts || [];
        for (const it of list) {
          const txt = typeof it === 'string' ? it : (it?.text || it?.plainText || '');
          if (txt && !descriptions.includes(txt)) descriptions.push(String(txt).trim());
        }
      }
    }
  }

  if (!descriptions.length && !severity) return null;
  const isNone = severity === 'NONE' && descriptions.length === 0;
  return {
    source: 'IMDb-ParentsGuide',
    severity,
    itemCount: descriptions.length,
    isClean: isNone,
    hasAdult: !isNone && (descriptions.length > 0 || /MODERATE|SEVERE|MILD/i.test(severity)),
    directScenes: extractRegexTimestampsFromDescriptions(descriptions),
    descriptions: descriptions.slice(0, 30)
  };
}

// [المرتبة 2 - أفلام]: Kids-In-Mind
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
      return {
        source: 'Kids-In-Mind',
        score,
        isClean: score === 0,
        hasAdult: score >= 2 || /\b(nudity|nude|naked|sex|intercourse|breasts|topless|prostitute|stripper|orgy|rape|masturbat|thrusting|cleavage|making love)\b/i.test(desc),
        directScenes: extractRegexTimestampsFromDescriptions([desc]),
        descriptions: desc ? [`[Kids-In-Mind Score ${score}/10 - CHRONOLOGICAL ORDER]: ${desc}`] : []
      };
    } catch (_) {}
  }
  return null;
}

// [المرتبة 3 - أفلام]: CringeMDb
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

        const isBriefSuggestiveOnly = /Suggestive/i.test(category) && /\bBrief\b/i.test(details) && !/\b(naked|nude|sex|breast|topless|lingerie|stripper|underwear|kissing|bed)\b/i.test(details);
        if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && !isBriefSuggestiveOnly) {
          directScenes.push({ start: startSec, end: endSec, category, details: details.slice(0, 220) });
          descriptions.push(`[${m[1]} - ${m[2]}] (${category}): ${details.slice(0, 200)}`);
        }
      }

      const staffMatch = text.match(/CringeMDb Staff Says:\s*([^.*]+(?:\.[^.*]+){0,4})/i);
      if (staffMatch) descriptions.push(`Staff Note: ${staffMatch[1].trim().slice(0, 300)}`);

      return {
        source: 'CringeMDb',
        isClean: isSafe && directScenes.length === 0,
        hasAdult: !isSafe || directScenes.length > 0,
        directScenes,
        descriptions
      };
    } catch (_) {}
  }
  return null;
}

// [المرتبة 4]: Plugged In
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

    const desc = secMatch[1].trim().slice(0, 2200);
    if (!desc || desc.length < 15) return null;
    const isClean = /^(none|nothing|not applicable|no sexual content)\b/i.test(desc);
    const hasExplicitKeywords = /\b(nude|nudity|naked|sex|intercourse|breasts|topless|lingerie|underwear|prostitute|stripper|rape|bedroom|passionate|making love|thrusting|orgy)\b/i.test(desc);

    return {
      source: 'PluggedIn',
      isClean,
      hasAdult: !isClean && hasExplicitKeywords,
      directScenes: extractRegexTimestampsFromDescriptions([desc]),
      descriptions: [`[PluggedIn Sexual Content]: ${desc}`]
    };
  } catch (_) {
    return null;
  }
}

// [المرتبة 5]: Parent Previews
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
    const hasExplicitKeywords = /\b(nude|nudity|naked|sex|intercourse|breasts|topless|lingerie|underwear|prostitute|stripper|rape|thrusting|post coital)\b/i.test(desc);

    return {
      source: 'ParentPreviews',
      isClean,
      hasAdult: !isClean && hasExplicitKeywords,
      directScenes: extractRegexTimestampsFromDescriptions([desc]),
      descriptions: [`[ParentPreviews]: ${desc}`]
    };
  } catch (_) {
    return null;
  }
}

// [المرتبة 6]: DoesTheDogDie
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
      if (y > n && y >= 2) {
        yesVotes++;
        const comment = Array.isArray(st.comments) && st.comments[0]?.comment ? st.comments[0].comment : '';
        notes.push(`${st.topic?.name || 'Sexual Content'}: YES (${y} vs ${n}) ${comment}`.trim());
      } else if (n > y * 2 && n >= 3) {
        noVotes++;
      }
    }

    return {
      source: 'DoesTheDogDie',
      isClean: yesVotes === 0 && noVotes > 0,
      hasAdult: yesVotes > 0,
      directScenes: extractRegexTimestampsFromDescriptions(notes),
      descriptions: notes.slice(0, 10)
    };
  } catch (_) {
    return null;
  }
}

// ===== 3. محرك التدرج الذكي المضمون =====
async function gatherCascadedEvidence(meta) {
  const activeSources = [];

  if (meta.isSeries) {
    // للمسلسلات: نجلب دليل الحلقة (أو المسلسل إن كانت الحلقة مدمجة فيه) + ملخص الحلقة
    const imdbGuide = await fetchImdbParentsGuide(meta);
    if (imdbGuide) activeSources.push(imdbGuide);

    if (meta.episodePlot) {
      activeSources.push({
        source: 'Episode-Plot',
        isClean: false,
        hasAdult: false,
        directScenes: [],
        descriptions: [`[Season ${meta.season} Episode ${meta.episode} (${meta.episodeTitle}) Overview]: ${meta.episodePlot}`]
      });
    }
  } else {
    // للأفلام بالتدرج: (1: IMDb + 2: Kids-In-Mind + 3: CringeMDb)
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

    const hasRichPrimary = Boolean(kim && kim.descriptions.length > 0) ||
      Boolean(imdb && imdb.itemCount >= 3 && cringe && cringe.directScenes.length > 0);
    const isDefinitelyClean = Boolean(
      (imdb && imdb.isClean && (!kim || kim.isClean) && (!cringe || cringe.isClean)) ||
      (kim && kim.isClean && (!imdb || !imdb.hasAdult))
    );

    // التدرج إلى 4: PluggedIn -> 5: ParentPreviews -> 6: DoesTheDogDie عند الحاجة
    if (!hasRichPrimary && !isDefinitelyClean) {
      const plugged = await fetchPluggedIn(meta);
      if (plugged) {
        activeSources.push(plugged);
      } else {
        const pp = await fetchParentPreviews(meta);
        if (pp) {
          activeSources.push(pp);
        } else {
          const ddd = await fetchDoesTheDogDie(meta);
          if (ddd) activeSources.push(ddd);
        }
      }
    }
  }

  let cleanVotes = 0;
  let adultVotes = 0;
  const directScenes = [];
  const allDescriptions = [];
  const sourceNames = [];

  for (const src of activeSources) {
    sourceNames.push(src.source);
    if (src.isClean) cleanVotes++;
    if (src.hasAdult) adultVotes++;
    if (Array.isArray(src.directScenes) && src.directScenes.length > 0) {
      directScenes.push(...src.directScenes);
    }
    if (Array.isArray(src.descriptions) && src.descriptions.length > 0) {
      allDescriptions.push(`=== ${src.source} ===\n${src.descriptions.join('\n')}`);
    }
  }

  console.log(`[درع Nuvio 🛡️] ${meta.title || meta.targetId} | المصادر=[${sourceNames.join(', ')}] | إشارات حجب=${adultVotes} | نظيف=${cleanVotes} | أوقات مباشرة=${directScenes.length}`);

  return {
    activeCount: activeSources.length,
    cleanVotes,
    adultVotes,
    isConfirmedClean: cleanVotes >= 1 && adultVotes === 0 && directScenes.length === 0,
    directScenes: normalizeScenes(directScenes),
    combinedReport: allDescriptions.join('\n\n').slice(0, 9500)
  };
}

// ===== 4. بناء خريطة الترجمة ومطابقتها عبر Gemini =====
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
      parsedCues.push({ startSec: Math.round(startSec), endSec: Math.round(endSec), text: cleanTxt.slice(0, 80) });
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

  // حجم مثالي (450 سطر) يضمن سرعة وعدم فشل JSON في Gemini مع تغطية الحوار بالكامل
  const maxLines = 450;
  const step = parsedCues.length <= maxLines ? 1 : Math.ceil(parsedCues.length / maxLines);
  const timelineLines = [];
  for (let i = 0; i < parsedCues.length; i += step) {
    const c = parsedCues[i];
    timelineLines.push(`[${c.startSec}s-${c.endSec}s] ${c.text}`);
  }

  const gapLines = gaps.slice(0, 100).map(g =>
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
  const prompt = `You are an expert family-safety timestamp synchronization engine for movies and TV episodes.
Media: "${meta.title || meta.targetId}" (${meta.year || 'Unknown Year'})${meta.isSeries ? ` - Season ${meta.season}, Episode${meta.episode}` : ''}.

DIRECT_TIMESTAMPS_FROM_CRINGEMDB:
${directJson}

PARENTAL_SOURCES_EVIDENCE:
${evidence.combinedReport || 'No external text report available.'}

SUBTITLE_TIMELINE_AND_GAPS:
${summaryText}

YOUR TASK:
1. Identify ALL explicit sex scenes, nudity scenes (full nudity, topless, exposed breasts/genitals/buttocks), brothel/strip club scenes, sexual violence/rape, or intense bedroom/bath sexual activity in this specific movie/episode.
2. CRITICAL FOR SCENE START TIME: Many nudity/brothel/bedroom scenes begin WHILE characters are talking (20 to 30 seconds of dialogue in that room BEFORE the silent gap starts). Set "start" to the VERY FIRST second that the dialogue/scene in that setting begins, NOT just when the silent gap starts!
3. Do NOT include non-sexual violence or profanity alone.
4. Output ONLY a valid JSON array of objects: [{"start": <number_in_seconds>, "end": <number_in_seconds>}]. If there are NO such scenes, output [].`;

  const apiBase = shared.DEFAULT_GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta';

  for (let attempt = 0; attempt < 3; attempt++) {
    const activeKey = await shared.acquireKey(keysArray);
    if (!activeKey) break;
    const cleanKey = String(activeKey).trim();
    const url = `${apiBase}/models/${cleanModel}:generateContent`;

    try {
      const r = await shared.axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
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
          .map(x => ({ start: Number(x.start), end: Number(x.end) }))
          .filter(x =>
            Number.isFinite(x.start) &&
            Number.isFinite(x.end) &&
            x.end > x.start &&
            x.start >= 0 &&
            (maxEndSec <= 0 || x.start <= maxEndSec + 120) &&
            (x.end - x.start <= 900)
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

  if (Array.isArray(cues) && cues.length > 0) {
    CUES_MEMORY_CACHE.set(targetId, cues);
  }

  const manual = getManualScenes(targetId);
  if (manual) return manual;

  if (RESOLVED_SCENES_CACHE.has(targetId)) {
    return RESOLVED_SCENES_CACHE.get(targetId);
  }

  if (IN_FLIGHT_REQUESTS.has(targetId)) {
    return IN_FLIGHT_REQUESTS.get(targetId);
  }

  const task = (async () => {
    try {
      const meta = await resolveMediaMeta(targetId);
      if (!meta) return [];

      const evidence = await gatherCascadedEvidence(meta);

      if (evidence.isConfirmedClean) {
        console.log(`[درع Nuvio ✅] العمل (${meta.title || targetId}) نظيف عائلياً.`);
        saveToMemoryCache(targetId, [], cues);
        return [];
      }

      let finalScenes = evidence.directScenes.slice();

      if (evidence.adultVotes > 0 || evidence.combinedReport.length > 0) {
        const aiScenes = await matchScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName);
        if (aiScenes.length > 0) {
          finalScenes = normalizeScenes([...finalScenes, ...aiScenes]);
        }
      }

      const padded = normalizeScenes(
        finalScenes.map(sc => ({
          start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
          end: sc.end + SCENE_PAD_AFTER_SEC
        }))
      );

      console.log(`[درع Nuvio 🛡️] اكتمل الفحص لـ (${meta.title || targetId}) -> تم تفعيل الحجب على (${padded.length}) مشهد.`);
      // لا نحفظ نتيجة فارغة في الكاش إذا كان هناك تصويت إباحي وفشل الموديل مؤقتاً، ليتمكن من المحاولة مجدداً
      if (padded.length > 0 || evidence.adultVotes === 0) {
        saveToMemoryCache(targetId, padded, cues);
      }
      return padded;
    } catch (err) {
      console.log(`[درع Nuvio ⚠️] خطأ غير متوقع أثناء فحص (${targetId}): ${err && err.message}`);
      return [];
    } finally {
      IN_FLIGHT_REQUESTS.delete(targetId);
    }
  })();

  IN_FLIGHT_REQUESTS.set(targetId, task);
  return task;
}

function calcSceneDurationSec(startSec, endSec) {
  const rawDuration = Math.max(1, Math.round(endSec - startSec));
  return Math.max(5, Math.ceil(rawDuration / 5) * 5);
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

// ===== نص التنبيه المسبق فقط (يختفي أثناء المشهد بناءً على طلبك) =====
const warnMsg = (d) => `مشهد🔞 قادم (${d} ثانية)`;

// ===== تنسيقات SRT =====
function srtTopWarnMsg(text) {
  return `{\\an8\\1c${WARN_ASS}\\3c&H000000&}<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

function srtWarnBanner(text) {
  return `<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

function srtWall(rowsCount = WALL_ROWS) {
  const safeRows = Math.max(8, Math.min(WALL_ROWS, Number(rowsCount) || WALL_ROWS));
  const row = `<font color="${WALL_COLOR_HEX}">${WALL_ROW}</font>`;
  return `{\\an5\\1c${WALL_ASS}\\3c${WALL_ASS}}` + Array.from({ length: safeRows }, () => row).join('\n');
}

// ===== تطبيق الدرع على SRT (تنبيه قبل المشهد + جدار أسود وحوار أثناء المشهد بدون نص تنبيه) =====
function applyShieldToSrtItems(items, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
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
    const inShieldWindow = [];

    for (const it of current) {
      // 1. قبل نافذة التنبيه
      if (it.startSec < (hasWarn ? warnStart : start)) {
        const cutEnd = Math.min(it.endSec, hasWarn ? warnStart : start);
        if (cutEnd - it.startSec >= 0.15) {
          outside.push({ startSec: it.startSec, endSec: cutEnd, text: it.text });
        }
      }

      // 2. داخل نافذة التنبيه المسبق [warnStart, start]
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

      // 3. داخل وقت المشهد المحجوب [start, end] (نحتفظ بالحوار ليظهر مع الجدار)
      if (it.endSec > start && it.startSec < end) {
        const sStart = Math.max(start, it.startSec);
        const sEnd = Math.min(end, it.endSec);
        if (sEnd - sStart >= 0.15) {
          inShieldWindow.push({
            startSec: sStart,
            endSec: sEnd,
            text: it.text
          });
        }
      }

      // 4. بعد انتهاء المشهد
      if (it.endSec > end) {
        const afterStart = Math.max(end, it.startSec);
        if (it.endSec - afterStart >= 0.15) {
          outside.push({ startSec: afterStart, endSec: it.endSec, text: it.text });
        }
      }
    }

    const next = outside.slice();

    // أ) إضافة التنبيه المسبق فقط قبل المشهد
    if (hasWarn) {
      inWarnWindow.sort((a, b) => a.startSec - b.startSec);
      let cursor = warnStart;
      for (const ov of inWarnWindow) {
        if (ov.startSec - cursor >= 0.25) {
          next.push({ startSec: cursor, endSec: ov.startSec, text: srtTopWarnMsg(warnMsg(durationSec)) });
        }
        next.push(ov);
        cursor = Math.max(cursor, ov.endSec);
      }
      if (start - cursor >= 0.25) {
        next.push({ startSec: cursor, endSec: start, text: srtTopWarnMsg(warnMsg(durationSec)) });
      }
    }

    // ب) أثناء المشهد: الجدار الأسود + الحوار فقط (يختفي نص التنبيه أثناء المشهد)
    inShieldWindow.sort((a, b) => a.startSec - b.startSec);
    let shieldCursor = start;

    for (const dlg of inShieldWindow) {
      if (dlg.startSec - shieldCursor >= 0.20) {
        next.push({ startSec: shieldCursor, endSec: dlg.startSec, text: srtWall(WALL_ROWS) });
      }
      const effectiveStart = Math.max(shieldCursor, dlg.startSec);
      if (dlg.endSec - effectiveStart >= 0.15) {
        const dlgLineCount = String(dlg.text || '').split('\n').filter(Boolean).length;
        next.push({
          startSec: effectiveStart,
          endSec: dlg.endSec,
          text: `${srtWall(WALL_ROWS - dlgLineCount)}\n${dlg.text}`
        });
        shieldCursor = Math.max(shieldCursor, dlg.endSec);
      }
    }

    if (end - shieldCursor >= 0.20) {
      next.push({ startSec: shieldCursor, endSec: end, text: srtWall(WALL_ROWS) });
    }

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

  const shielded = applyShieldToSrtItems(rawItems, targetId);
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
  return scenes.some(sc => sSec < sc.end && eSec > sc.start);
}

function buildAssShieldLines(targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return [];

  const warnTopTag = `{\\an8\\1c${WARN_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c${WALL_ASS}\\3c${WALL_ASS}\\bord0\\shad0}`;
  const dlgOverWallTag = `{\\an2\\1c&HFFFFFF&\\3c&H000000&\\bord3\\shad1}`;
  const wall = wallTag + Array.from({ length: 16 }, () => ASS_WALL_ROW).join('\\N');

  const extra = [];
  let prevEnd = 0;

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const durationSec = calcSceneDurationSec(start, end);
    const warnStart = Math.max(prevEnd, start - WARN_SEC);

    // التنبيه يظهر فقط قبل المشهد ويختفي عند بدء الجدار
    if (start - warnStart >= 1) {
      const warnLine = warnTopTag + warnMsg(durationSec);
      extra.push(`Dialogue: 99,${formatAssTimeSec(warnStart)},${formatAssTimeSec(start)},Default,,0,0,0,,${addAssRlm(warnLine)}`);
    }

    // الجدار الأسود في طبقة 98 أثناء المشهد فقط
    extra.push(`Dialogue: 98,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${wall}`);
    prevEnd = end;
  }

  // إظهار الحوار فوق الجدار في طبقة 100
  const cachedCues = targetId ? CUES_MEMORY_CACHE.get(targetId) : null;
  if (Array.isArray(cachedCues) && cachedCues.length > 0) {
    for (const c of cachedCues) {
      const sSec = parseSubTimeSec(c.start);
      const eSec = parseSubTimeSec(c.end);
      if (eSec <= sSec) continue;
      if (scenes.some(sc => sSec < sc.end && eSec > sc.start)) {
        const cleanTxt = String(c.text || '').replace(/\r?\n/g, '\\N').trim();
        if (cleanTxt) {
          extra.push(`Dialogue: 100,${formatAssTimeSec(sSec)},${formatAssTimeSec(eSec)},Default,,0,0,0,,${dlgOverWallTag}${addAssRlm(cleanTxt)}`);
        }
      }
    }
  }

  return extra;
}

module.exports = {
  prepareShield,
  buildShieldedSrt,
  isCueInsideShield,
  buildAssShieldLines
};
