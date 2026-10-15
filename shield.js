// shield.js
// درع الترجمة: التدرج الذكي للمصادر (أفلام ومسلسلات) + تنبيه مسبق + حجب الشاشة مع إبقاء الحوار

const axiosDefault = require('axios');

const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// ===== إعدادات المظهر والألوان (عدّلها من هنا فقط) =====
const WARN_SEC = 10;                  // مدة التنبيه المسبق بالثواني
const WARN_COLOR_HEX = '#FFD400';     // لون تنبيه "مشهد قادم" (أصفر ذهبي)
const HIDE_COLOR_HEX = '#FF3B30';     // لون تنبيه "مشهد محجوب" أثناء التعتيم (أحمر واضح)
const WALL_COLOR_HEX = '#000000';     // لون جدار التعتيم
const WALL_CHAR = '█';                // رمز بناء الجدار
const WALL_COLS = 42;                 // عرض الجدار في كل سطر
const WALL_ROWS = 16;                 // ارتفاع الجدار الكامل (ينقص تلقائياً سطراً عند وجود حوار)

// ===== إعدادات الهوامش والتشغيل الفعلي =====
const SCENE_PAD_BEFORE_SEC = 6;       // هامش أمان قبل بداية المشهد (لتغطية بداية اللقطة بالكامل)
const SCENE_PAD_AFTER_SEC = 3;        // هامش أمان بعد نهاية المشهد
const USE_TEST_SCENES = false;        // false = التشغيل الفعلي على الأفلام والمسلسلات
const HTTP_TIMEOUT_MS = 8500;         // مهلة جلب كل مصدر خارجي
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;        // أقصى عدد أفلام/حلقات محفوظة في الذاكرة المؤقتة

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9'
};

// تحميل كسول لأدوات ai.js لمنع التعارض الدائري (Circular Dependency)
function getAiShared() {
  try {
    const aiMod = require('./ai');
    if (aiMod && aiMod.shared) return aiMod.shared;
  } catch (_) {}
  return { axios: axiosDefault };
}

// تحويل HEX إلى صيغة ASS (ترتيب BGR)
function hexToAss(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return ('&H' + b + g + r + '&').toUpperCase();
}

const WARN_ASS = hexToAss(WARN_COLOR_HEX);
const HIDE_ASS = hexToAss(HIDE_COLOR_HEX);
const WALL_ASS = hexToAss(WALL_COLOR_HEX);
const WALL_ROW = WALL_CHAR.repeat(WALL_COLS);

// ===== قائمة أولوية يدوية (اختيارية) =====
const SCENES_DB = {
  // 'tt0000000': [['12:30', '13:10'], ['45:00', '46:20']],
};

const TEST_SCENES = [
  { start: 20, end: 45 },
  { start: 300, end: 315 }
];

// كاش الذاكرة للمشاهد وبيانات الحوار
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
    // دمج المشاهد المتداخلة أو التي يفصل بينها أقل من 4 ثوانٍ لمنع رمش الجدار
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

// ===== أدوات تنظيف النصوص والروابط =====
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

// استخراج أي توقيتات مكتوبة صراحةً داخل أوصاف المواقع
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

// ===== 1. التعرّف على الفلم أو الحلقة (الاسم، السنة، ومعرّف الحلقة الخاص) =====
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

  // أ) جلب سريع من IMDb Suggestion API
  try {
    const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/t/${baseImdbId}.json`);
    const item = Array.isArray(sug?.d) ? sug.d.find(x => x.id === baseImdbId) || sug.d[0] : null;
    if (item) {
      title = String(item.l || '').trim();
      if (Number.isFinite(Number(item.y))) year = Number(item.y);
    }
  } catch (_) {}

  // ب) جلب من Cinemeta (لمعرفة معرّف الحلقة في المسلسلات وتأكيد الاسم والسنة)
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

// ===== 2. دوال جلب المصادر المرتبة =====

// [المرتبة 1 - أفلام ومسلسلات]: IMDb Parents Guide + Plot Synopsis
async function fetchImdbById(imdbId, includeSynopsis = false) {
  if (!imdbId) return null;

  // 1-أ: عبر IMDb GraphQL (الأسرع والأدق: يجلب دليل الوالدين + ملخص القصة التفصيلي معاً)
  try {
    const { axios } = getAiShared();
    const synopsisField = includeSynopsis
      ? `plot { plotText { plainText } } plots(first: 5) { edges { node { plotText { plainText } } } }`
      : '';
    const query = `query { title(id: "${imdbId}") { ${synopsisField} parentsGuide { categories { category { id } severity { text } } guideItems(first: 50) { edges { node { category { id } text { plainText } } } } } } }`;
    const gqlRes = await axios.post('https://api.graphql.imdb.com/', { query }, {
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        'x-imdb-client-name': 'imdb-web-next-localized'
      },
      timeout: HTTP_TIMEOUT_MS
    });

    const titleNode = gqlRes.data?.data?.title;
    if (titleNode) {
      const pg = titleNode.parentsGuide;
      const cats = Array.isArray(pg?.categories) ? pg.categories : [];
      const nudityCat = cats.find(c => /NUDITY|SEX/i.test(String(c?.category?.id || '')));
      const severity = String(nudityCat?.severity?.text || '').toUpperCase();

      const edges = Array.isArray(pg?.guideItems?.edges) ? pg.guideItems.edges : [];
      const nudityItems = edges
        .map(e => e?.node)
        .filter(n => n && /NUDITY|SEX/i.test(String(n.category?.id || '')))
        .map(n => String(n.text?.plainText || '').trim())
        .filter(Boolean);

      const plots = [];
      if (titleNode.plot?.plotText?.plainText) plots.push(titleNode.plot.plotText.plainText);
      if (Array.isArray(titleNode.plots?.edges)) {
        for (const pe of titleNode.plots.edges) {
          const pt = pe?.node?.plotText?.plainText;
          if (pt && !plots.includes(pt)) plots.push(pt);
        }
      }

      if (nudityItems.length > 0 || severity || plots.length > 0) {
        const isNone = severity === 'NONE' && nudityItems.length === 0;
        const descOut = nudityItems.slice(0, 30);
        if (plots.length > 0) {
          descOut.push(`[IMDb Episode/Movie Synopsis]: ${plots.join(' | ').slice(0, 2000)}`);
        }
        return {
          source: 'IMDb-ParentsGuide',
          severity,
          itemCount: nudityItems.length,
          isClean: isNone,
          hasAdult: !isNone && (nudityItems.length > 0 || /MODERATE|SEVERE|MILD/i.test(severity)),
          directScenes: extractRegexTimestampsFromDescriptions(nudityItems),
          descriptions: descOut
        };
      }
    }
  } catch (_) {}

  // 1-ب: عبر api.imdbapi.dev الاحتياطي
  try {
    const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${imdbId}/parentsGuide`, { Accept: 'application/json' });
    const guide = data?.parentalGuide || data?.parentsGuide || data;
    const parsed = extractImdbGuideData(guide);
    if (parsed) return parsed;
  } catch (_) {}

  // 1-ج: عبر صفحة HTML المباشرة
  try {
    const html = await safeHttpGet(`https://www.imdb.com/title/${imdbId}/parentalguide`);
    if (typeof html === 'string' && html.length > 1000) {
      const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (nextMatch) {
        const json = JSON.parse(nextMatch[1]);
        const parsed = extractImdbGuideData(json);
        if (parsed) return parsed;
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

// [المرتبة 2 - أفلام]: Kids-In-Mind (الأدق في الترتيب الزمني التسلسلي من بداية الفلم لنهايته)
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
        descriptions: desc ? [`[Kids-In-Mind Score ${score}/10 - STRICT CHRONOLOGICAL ORDER]: ${desc}`] : []
      };
    } catch (_) {}
  }
  return null;
}

// [المرتبة 3 - أفلام]: CringeMDb (الأدق في التوقيت المباشر بالثواني)
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

// [المرتبة 4 - احتياطي أفلام]: Plugged In
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

// [المرتبة 5 - احتياطي أفلام]: Parent Previews
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

// [المرتبة 6 - احتياطي أخير]: DoesTheDogDie
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

// ===== 3. محرك التدرج الذكي (Smart Cascade) للأفلام والمسلسلات =====
async function gatherCascadedEvidence(meta) {
  const activeSources = [];

  // أ) مسار المسلسلات (حلقة بحلقة): IMDb Episode Guide + Episode Synopsis + fallback
  if (meta.isSeries) {
    let epGuide = null;
    if (meta.episodeImdbId) {
      epGuide = await fetchImdbById(meta.episodeImdbId, true);
    }
    // إذا لم يتوفر معرّف للحلقة أو كان فارغاً تماماً، نجلب دليل المسلسل العام مع ملخص الحلقة من Cinemeta
    if (!epGuide || (!epGuide.hasAdult && !epGuide.isClean)) {
      const seriesGuide = await fetchImdbById(meta.baseImdbId, false);
      if (seriesGuide) activeSources.push(seriesGuide);
    } else {
      activeSources.push(epGuide);
    }

    if (meta.episodePlot) {
      activeSources.push({
        source: 'Episode-Plot-Overview',
        isClean: false,
        hasAdult: false,
        directScenes: [],
        descriptions: [`[Season ${meta.season} Episode ${meta.episode} (${meta.episodeTitle}) Overview]: ${meta.episodePlot}`]
      });
    }
  } else {
    // ب) مسار الأفلام بالتدرج المعتمد:
    // الخطوة 1: الثلاثة الكبار معاً (1: IMDb Parents Guide + 2: Kids-In-Mind + 3: CringeMDb)
    const [imdbRes, kimRes, cringeRes] = await Promise.allSettled([
      fetchImdbById(meta.baseImdbId, true),
      fetchKidsInMind(meta),
      fetchCringeMdb(meta)
    ]);

    const imdb = imdbRes.status === 'fulfilled' ? imdbRes.value : null;
    const kim = kimRes.status === 'fulfilled' ? kimRes.value : null;
    const cringe = cringeRes.status === 'fulfilled' ? cringeRes.value : null;

    if (imdb) activeSources.push(imdb);
    if (kim) activeSources.push(kim);
    if (cringe) activeSources.push(cringe);

    // فحص التوقف المبكر: هل نحتاج للنزول إلى المرتبة 4 و 5 و 6؟
    const hasRichPrimary = Boolean(kim && kim.descriptions.length > 0) ||
      Boolean(imdb && imdb.itemCount >= 3 && cringe && cringe.directScenes.length > 0);
    const isDefinitelyClean = Boolean(
      (imdb && imdb.isClean && (!kim || kim.isClean) && (!cringe || cringe.isClean)) ||
      (kim && kim.isClean && (!imdb || !imdb.hasAdult))
    );

    // الخطوة 2 (التدرج الاحتياطي عند غياب Kids-In-Mind أو نقص التفاصيل): 4: PluggedIn -> 5: ParentPreviews -> 6: DoesTheDogDie
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
    combinedReport: allDescriptions.join('\n\n').slice(0, 12000)
  };
}

// ===== 4. بناء خريطة الترجمة الكاملة ومطابقة التوقيت عبر Gemini =====
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

  // رصد الفجوات الصامتة (>= 5 ثوانٍ)
  const gaps = [];
  for (let i = 1; i < parsedCues.length; i++) {
    const prev = parsedCues[i - 1];
    const curr = parsedCues[i];
    const gapDur = curr.startSec - prev.endSec;
    if (gapDur >= 5 && gapDur <= 300) {
      gaps.push({
        gapStart: prev.endSec,
        gapEnd: curr.startSec,
        duration: gapDur,
        beforeText: prev.text,
        afterText: curr.text
      });
    }
  }

  // إرسال كامل أسطر الحوار (حتى 1100 سطر) حتى لا تفوت الموديل بداية المشاهد الحوارية
  const maxLines = 1100;
  const step = parsedCues.length <= maxLines ? 1 : Math.ceil(parsedCues.length / maxLines);
  const timelineLines = [];
  for (let i = 0; i < parsedCues.length; i += step) {
    const c = parsedCues[i];
    timelineLines.push(`[${c.startSec}s-${c.endSec}s] ${c.text}`);
  }

  const gapLines = gaps.slice(0, 120).map(g =>
    `GAP [${g.gapStart}s -> ${g.gapEnd}s (${g.duration}s)] Before: "${g.beforeText}" | After: "${g.afterText}"`
  );

  return {
    maxEndSec,
    summaryText: `TOTAL_DURATION_SEC: ${maxEndSec}\n\nSILENT_GAPS:\n${gapLines.join('\n')}\n\nCOMPLETE_DIALOGUE_TIMELINE:\n${timelineLines.join('\n')}`
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
  const prompt = `You are a high-precision family-safety timestamp synchronization engine for movies and TV episodes.
Media: "${meta.title || meta.targetId}" (${meta.year || 'Unknown Year'})${meta.isSeries ? ` - Season ${meta.season}, Episode ${meta.episode} (${meta.episodeTitle || ''})` : ''}.

DIRECT_TIMESTAMPS_FROM_SOURCES:
${directJson}

PARENTAL_GUIDE_AND_PLOT_EVIDENCE:
${evidence.combinedReport || 'No external guide found. Rely strictly on explicit sexual/nudity indicators in the dialogue timeline.'}

SUBTITLE_TIMELINE_AND_GAPS:
${summaryText}

STRICT SYNCHRONIZATION RULES:
1. Identify ALL explicit sex scenes, nudity scenes (female/male nudity, topless, exposed breasts/buttocks/genitals), brothel/strip club scenes, sexual assault/rape, or passionate bedroom/bath scenes in this specific movie or episode.
2. CRITICAL — DO NOT MISS THE BEGINNING OF A SCENE: In movies and TV shows (like Game of Thrones), nudity and sex scenes almost always START WITH DIALOGUE (20 to 40 seconds of talking, seduction, or conversation while characters are already undressed or in a brothel/bedroom/bath) BEFORE the silent gap begins! You MUST set "start" to the VERY FIRST second that the scene/conversation in that setting begins, NOT when the talking stops!
3. Set "end" to the exact second when the scene fully concludes and transitions to the next plot location.
4. If this is a TV Episode and the Parental Guide contains notes from the whole series, ONLY include scenes that match the dialogue and plot of THIS specific episode (Season ${meta.season}, Episode ${meta.episode}).
5. Do NOT include non-sexual violence/gore or profanity alone.
6. Output ONLY a valid JSON array: [{"start": <number_in_seconds>, "end": <number_in_seconds>}]. If there are no such scenes, output [].`;

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
      if (!meta) {
        saveToMemoryCache(targetId, [], cues);
        return [];
      }

      const evidence = await gatherCascadedEvidence(meta);

      // 1. إذا ثبت أن العمل نظيف تماماً
      if (evidence.isConfirmedClean) {
        console.log(`[درع Nuvio ✅] العمل (${meta.title || targetId}) نظيف عائلياً.`);
        saveToMemoryCache(targetId, [], cues);
        return [];
      }

      // 2. دمج الأوقات المباشرة مع مطابقة Gemini لخط الترجمة الكامل
      let finalScenes = evidence.directScenes.slice();

      if (evidence.adultVotes > 0 || evidence.combinedReport.length > 0 || evidence.activeCount === 0) {
        const aiScenes = await matchScenesWithGemini(meta, evidence, cues, texts, keysArray, modelName);
        if (aiScenes.length > 0) {
          finalScenes = normalizeScenes([...finalScenes, ...aiScenes]);
        }
      }

      // إضافة هامش الأمان (6 ثوانٍ قبل المشهد و 3 ثوانٍ بعده)
      const padded = normalizeScenes(
        finalScenes.map(sc => ({
          start: Math.max(0, sc.start - SCENE_PAD_BEFORE_SEC),
          end: sc.end + SCENE_PAD_AFTER_SEC
        }))
      );

      console.log(`[درع Nuvio 🛡️] اكتمل الفحص لـ (${meta.title || targetId}) -> تم تفعيل الحجب على (${padded.length}) مشهد.`);
      saveToMemoryCache(targetId, padded, cues);
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

// ===== نصوص الرسائل المختصرة =====
const warnMsg = (d) => `مشهد🔞 قادم (${d} ثانية)`;
const hideMsg = (d) => `مشهد🔞 محجوب (${d} ثانية)`;

// ===== تنسيقات SRT =====
function srtTopWarnMsg(text) {
  return `{\\an8\\1c${WARN_ASS}\\3c&H000000&}<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

function srtTopHideMsg(text) {
  return `{\\an8\\1c${HIDE_ASS}\\3c&H000000&}<font color="${HIDE_COLOR_HEX}">${text}</font>`;
}

function srtWarnBanner(text) {
  return `<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

function srtWall(rowsCount = WALL_ROWS) {
  const safeRows = Math.max(10, Math.min(WALL_ROWS, Number(rowsCount) || WALL_ROWS));
  const row = `<font color="${WALL_COLOR_HEX}">${WALL_ROW}</font>`;
  return `{\\an5\\1c${WALL_ASS}\\3c${WALL_ASS}}` + Array.from({ length: safeRows }, () => row).join('\n');
}

// ===== تطبيق الدرع على SRT مع إبقاء الحوار ظاهراً أثناء الحجب =====
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
    const hideBanner = srtTopHideMsg(hideMsg(durationSec));

    const outside = [];
    const inWarnWindow = [];
    const inShieldWindow = [];

    // 1. تقسيم الأسطر بدقة حول نافذة التنبيه [warnStart, start] ونافذة الحجب [start, end] دون حذف الحوار
    for (const it of current) {
      // أ) جزء السطر الذي يسبق warnStart
      if (it.startSec < (hasWarn ? warnStart : start)) {
        const cutEnd = Math.min(it.endSec, hasWarn ? warnStart : start);
        if (cutEnd - it.startSec >= 0.15) {
          outside.push({ startSec: it.startSec, endSec: cutEnd, text: it.text });
        }
      }

      // ب) جزء السطر الواقع داخل نافذة التنبيه [warnStart, start]
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

      // ج) جزء السطر الواقع داخل نافذة الحجب [start, end] (نبقي الحوار ليظهر مع الجدار!)
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

      // د) جزء السطر الذي يلي نهاية المشهد end
      if (it.endSec > end) {
        const afterStart = Math.max(end, it.startSec);
        if (it.endSec - afterStart >= 0.15) {
          outside.push({ startSec: afterStart, endSec: it.endSec, text: it.text });
        }
      }
    }

    const next = outside.slice();

    // 2. بناء نافذة التنبيه المسبق [warnStart, start]
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

    // 3. بناء نافذة الحجب [start, end] مع إظهار الحوار تحت الجدار
    inShieldWindow.sort((a, b) => a.startSec - b.startSec);
    let shieldCursor = start;

    for (const dlg of inShieldWindow) {
      // في الفجوات الصامتة داخل المشهد: جدار كامل + رسالة الحجب
      if (dlg.startSec - shieldCursor >= 0.20) {
        next.push({ startSec: shieldCursor, endSec: dlg.startSec, text: srtWall(WALL_ROWS) });
        next.push({ startSec: shieldCursor, endSec: dlg.startSec, text: hideBanner });
      }
      // أثناء وجود حوار داخل المشهد: ننقص الجدار بمقدار سطور الحوار ونعرض الحوار + رسالة الحجب تحته
      const effectiveStart = Math.max(shieldCursor, dlg.startSec);
      if (dlg.endSec - effectiveStart >= 0.15) {
        const dlgLineCount = String(dlg.text || '').split('\n').filter(Boolean).length;
        next.push({ startSec: effectiveStart, endSec: dlg.endSec, text: srtWall(WALL_ROWS - dlgLineCount) });
        next.push({ startSec: effectiveStart, endSec: dlg.endSec, text: `${dlg.text}\n${hideBanner}` });
        shieldCursor = Math.max(shieldCursor, dlg.endSec);
      }
    }

    // تكملة ما تبقى من وقت المشهد المحجوب بعد آخر حوار
    if (end - shieldCursor >= 0.20) {
      next.push({ startSec: shieldCursor, endSec: end, text: srtWall(WALL_ROWS) });
      next.push({ startSec: shieldCursor, endSec: end, text: hideBanner });
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
  const hideTopTag = `{\\an8\\1c${HIDE_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c${WALL_ASS}\\3c${WALL_ASS}\\bord0\\shad0}`;
  const dlgOverWallTag = `{\\an2\\1c&HFFFFFF&\\3c&H000000&\\bord3\\shad1}`;
  const wall = wallTag + Array.from({ length: WALL_ROWS }, () => WALL_ROW).join('\\N');

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

    // الجدار في طبقة 98، وتنبيه الحجب في طبقة 99 بأعلى الشاشة
    extra.push(`Dialogue: 98,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${wall}`);
    const hideLine = hideTopTag + hideMsg(durationSec);
    extra.push(`Dialogue: 99,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${addAssRlm(hideLine)}`);

    prevEnd = end;
  }

  // إعادة إظهار أسطر الحوار الواقعة داخل المشهد المحجوب في طبقة 100 فوق الجدار الأسود
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
