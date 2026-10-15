// shield.js
// درع الترجمة: تقصّي المشاهد من 6 مصادر + تصويت ومطابقة ذكية + تنبيه وحجب الشاشة

const axiosDefault = require('axios');

const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// ===== إعدادات المظهر (عدّلها من هنا فقط) =====
const WARN_SEC = 10;                // مدة التنبيه المسبق بالثواني
const WARN_COLOR_HEX = '#FFD400';   // لون الرسالة: أصفر. برتقالي #FFA500 ، ماروني #800000
const WALL_COLS = 42;               // عدد المربعات في كل سطر من الجدار
const WALL_ROWS = 16;               // عدد أسطر الجدار

// ===== إعدادات الفحص والتشغيل الفعلي =====
const SCENE_PAD_SEC = 2;            // هامش أمان قبل المشهد وبعده بالثواني
const USE_TEST_SCENES = false;      // false = التشغيل الفعلي على الأفلام والمسلسلات
const HTTP_TIMEOUT_MS = 8500;       // مهلة جلب كل مصدر خارجي
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;      // الحد الأقصى للكاش في الذاكرة لمنع استهلاك الرام

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9'
};

// تحميل كسول لأدوات ai.js لمنع أي تعارض دائري (Circular Dependency) مستقبلاً
function getAiShared() {
  try {
    const aiMod = require('./ai');
    if (aiMod && aiMod.shared) return aiMod.shared;
  } catch (_) {}
  return { axios: axiosDefault };
}

// تحويل HEX إلى صيغة ASS (ترتيب BGR)
function hexToAss(hex) {
  const h = String(hex).replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return ('&H' + b + g + r + '&').toUpperCase();
}
const WARN_ASS = hexToAss(WARN_COLOR_HEX);
const WALL_ROW = '█'.repeat(WALL_COLS);

// ===== قائمة أولوية يدوية (اختيارية: تتجاوز الفحص التلقائي إن وُجدت) =====
const SCENES_DB = {
  // 'tt0000000': [['12:30', '13:10'], ['45:00', '46:20'], [3400, 3450]],
};

const TEST_SCENES = [
  { start: 20, end: 45 },
  { start: 300, end: 315 }
];

// كاش الذاكرة لنتائج الأفلام والحلقات التي تم فحصها
const RESOLVED_SCENES_CACHE = new Map();
const IN_FLIGHT_REQUESTS = new Map();

function saveToMemoryCache(key, scenes) {
  if (!key) return;
  if (RESOLVED_SCENES_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = RESOLVED_SCENES_CACHE.keys().next().value;
    if (oldestKey !== undefined) RESOLVED_SCENES_CACHE.delete(oldestKey);
  }
  RESOLVED_SCENES_CACHE.set(key, scenes);
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
    if (!merged.length || sc.start > merged[merged.length - 1].end) {
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
      list.push({ start: Math.max(0, a - SCENE_PAD_SEC), end: b + SCENE_PAD_SEC });
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

// ===== أدوات مساعدة لتنظيف HTML وبناء الروابط =====
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
  return decodeHtmlEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '));
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

// ===== 1. جلب بيانات الفلم أو الحلقة (الاسم الإنجليزي، السنة، ومعرّف الحلقة) =====
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

  // أ) جلب سريع من IMDb Suggestion JSON (معفى من WAF)
  try {
    const sug = await safeHttpGet(`https://v3.sg.media-imdb.com/suggestion/t/${baseImdbId}.json`);
    const item = Array.isArray(sug?.d) ? sug.d.find(x => x.id === baseImdbId) || sug.d[0] : null;
    if (item) {
      title = String(item.l || '').trim();
      if (Number.isFinite(Number(item.y))) year = Number(item.y);
    }
  } catch (_) {}

  // ب) جلب من Cinemeta (إلزامي للمسلسلات لمعرفة معرّف الحلقة، واحتياطي للأفلام)
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
    episodeTitle
  };
}

// ===== 2. المصادر الـ 6 لفحص المشاهد =====

// المصدر 1: CringeMDb (يعطي أوقاتاً مباشرة بالثواني + حكم الأمان العائلي)
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

      // استخراج الأوقات بصيغة: 02:32 to 02:48. Sex scene Moderate...
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

        // نستبعد المشاهد العنيفة غير الجنسية، ونقبل الجنس والعري والإيحاء الصريح
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

// المصدر 2: Kids-In-Mind (وصف تفصيلي مرتب زمنياً من بداية الفلم لنهايته + تقييم من 0 إلى 10)
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
      const desc = secMatch[2].trim().slice(0, 2500);
      return {
        source: 'Kids-In-Mind',
        score,
        isClean: score === 0,
        hasAdult: score >= 3 || /\b(nudity|nude|naked|sex|intercourse|breasts|topless|prostitute|stripper|orgy|rape|masturbat|thrusting)\b/i.test(desc),
        directScenes: [],
        descriptions: desc ? [`[Kids-In-Mind Score ${score}/10 Chronological]: ${desc}`] : []
      };
    } catch (_) {}
  }
  return null;
}

// المصدر 3: IMDb Parents Guide (يدعم الأفلام والمسلسلات والحلقات عبر API + GraphQL + HTML)
async function fetchImdbParentsGuide(meta) {
  if (!meta) return null;
  const idsToTry = [meta.episodeImdbId, meta.baseImdbId].filter(Boolean);

  for (const imdbId of idsToTry) {
    // 3-أ: عبر واجهة api.imdbapi.dev العامة
    try {
      const data = await safeHttpGet(`https://api.imdbapi.dev/titles/${imdbId}/parentsGuide`, { Accept: 'application/json' });
      const guide = data?.parentalGuide || data?.parentsGuide || data;
      const parsed = extractImdbGuideData(guide);
      if (parsed) return parsed;
    } catch (_) {}

    // 3-ب: عبر واجهة IMDb GraphQL الرسمية
    try {
      const { axios } = getAiShared();
      const query = `query { title(id: "${imdbId}") { parentsGuide { guideItems(first: 40) { edges { node { category { id } text { plainText } } } } } } }`;
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

        return {
          source: 'IMDb-GraphQL',
          isClean: nudityItems.length === 0,
          hasAdult: nudityItems.length > 0,
          directScenes: extractRegexTimestampsFromDescriptions(nudityItems),
          descriptions: nudityItems.slice(0, 25)
        };
      }
    } catch (_) {}

    // 3-ج: عبر صفحة parentalguide المباشرة (__NEXT_DATA__ أو HTML)
    try {
      const html = await safeHttpGet(`https://www.imdb.com/title/${imdbId}/parentalguide`);
      if (typeof html === 'string' && html.length > 1000) {
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextMatch) {
          const json = JSON.parse(nextMatch[1]);
          const parsed = extractImdbGuideData(json);
          if (parsed) return parsed;
        }
        // استخراج احتياطي من HTML لقسمadvisory-nudity
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
              isClean: false,
              hasAdult: true,
              directScenes: extractRegexTimestampsFromDescriptions(items),
              descriptions: items.slice(0, 25)
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

  // البحث عن نصوص قسم NUDITY داخل JSON
  const nudityRegex = /"category"\s*:\s*\{[^}]*"id"\s*:\s*"NUDITY"[^}]*\}[^}]*"text"\s*:\s*\{[^}]*"plainText"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  let m;
  while ((m = nudityRegex.exec(rawStr)) !== null) {
    try {
      const decoded = JSON.parse(`"${m[1]}"`).trim();
      if (decoded && !descriptions.includes(decoded)) descriptions.push(decoded);
    } catch (_) {}
  }

  // صيغة بديلة في imdbapi.dev
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
    isClean: isNone,
    hasAdult: !isNone && (descriptions.length > 0 || /MODERATE|SEVERE/i.test(severity)),
    directScenes: extractRegexTimestampsFromDescriptions(descriptions),
    descriptions: descriptions.slice(0, 25)
  };
}

// المصدر 4: Plugged In (مراجعات تفصيلية لقسم Sexual & Romantic Content)
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

    const desc = secMatch[1].trim().slice(0, 2000);
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

// المصدر 5: Parent Previews (قسم Sexual Content)
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

// المصدر 6: DoesTheDogDie (تصويت المجتمع على المشاهد الجنسية)
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

// استخراج أي توقيتات مكتوبة صراحةً داخل أوصاف المواقع (مثل "at 1:12:30" أو "42:10 - 43:00" أو "minute 34")
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

// ===== 3. محرك التصويت والدمج بين المصادر =====
async function evaluateAndVoteSources(meta) {
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
  const directScenes = [];
  const allDescriptions = [];

  for (const src of activeSources) {
    if (src.isClean) cleanVotes++;
    if (src.hasAdult) adultVotes++;
    if (Array.isArray(src.directScenes) && src.directScenes.length > 0) {
      directScenes.push(...src.directScenes);
    }
    if (Array.isArray(src.descriptions) && src.descriptions.length > 0) {
      allDescriptions.push(`=== ${src.source} ===\n${src.descriptions.join('\n')}`);
    }
  }

  console.log(`[درع Nuvio 🛡️] ${meta.title || meta.targetId} | مصادر استجابت=${activeSources.length} | تصويت إباحي=${adultVotes} | تصويت نظيف=${cleanVotes} | أوقات مباشرة=${directScenes.length}`);

  return {
    activeCount: activeSources.length,
    cleanVotes,
    adultVotes,
    isConfirmedClean: cleanVotes >= 1 && adultVotes === 0 && directScenes.length === 0,
    directScenes: normalizeScenes(directScenes),
    combinedReport: allDescriptions.join('\n\n').slice(0, 9000)
  };
}

// ===== 4. مطابقة الأوصاف والتوقيتات مع ملف الترجمة عبر Gemini =====
function buildSubtitleTimelineSummary(cues, texts) {
  if (!Array.isArray(cues) || !cues.length) return { summaryText: '', maxEndSec: 0 };

  const parsedCues = [];
  for (let i = 0; i < cues.length; i++) {
    const startSec = parseSubTimeSec(cues[i].start);
    const endSec = parseSubTimeSec(cues[i].end);
    const rawTxt = texts && texts[i] != null ? texts[i] : cues[i].text;
    const cleanTxt = String(rawTxt || '').replace(/<[^>]+>|\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim();
    if (endSec > startSec && cleanTxt) {
      parsedCues.push({ startSec: Math.round(startSec), endSec: Math.round(endSec), text: cleanTxt.slice(0, 75) });
    }
  }

  if (!parsedCues.length) return { summaryText: '', maxEndSec: 0 };
  const maxEndSec = parsedCues[parsedCues.length - 1].endSec;

  // رصد الفجوات الصامتة (5 ثوانٍ إلى 180 ثانية) لأن المشاهد الجنسية كثيراً ما تقع داخلها
  const gaps = [];
  for (let i = 1; i < parsedCues.length; i++) {
    const prev = parsedCues[i - 1];
    const curr = parsedCues[i];
    const gapDur = curr.startSec - prev.endSec;
    if (gapDur >= 6 && gapDur <= 240) {
      gaps.push({
        gapStart: prev.endSec,
        gapEnd: curr.startSec,
        duration: gapDur,
        beforeText: prev.text,
        afterText: curr.text
      });
    }
  }

  // أخذ عينات منتظمة من الحوار + الأسطر المحيطة بالفجوات لتكوين خريطة زمنية دقيقة وخفيفة
  const step = Math.max(1, Math.ceil(parsedCues.length / 260));
  const sampledLines = [];
  for (let i = 0; i < parsedCues.length; i += step) {
    const c = parsedCues[i];
    sampledLines.push(`[${c.startSec}s-${c.endSec}s] ${c.text}`);
  }

  const gapLines = gaps.slice(0, 100).map(g =>
    `GAP [${g.gapStart}s -> ${g.gapEnd}s (${g.duration}s)] Before: "${g.beforeText}" | After: "${g.afterText}"`
  );

  return {
    maxEndSec,
    summaryText: `TOTAL_SUBTITLE_DURATION_SEC: ${maxEndSec}\n\nSILENT_GAPS:\n${gapLines.join('\n')}\n\nDIALOGUE_TIMELINE_SAMPLE:\n${sampledLines.join('\n')}`
  };
}

async function matchScenesWithGemini(meta, voteResult, cues, texts, keysArray, modelName) {
  if (!Array.isArray(keysArray) || !keysArray.length) return [];
  const shared = getAiShared();
  if (!shared.acquireKey) return [];

  const { summaryText, maxEndSec } = buildSubtitleTimelineSummary(cues, texts);
  if (!summaryText) return [];

  const cleanModel = shared.normalizeGeminiModelId
    ? shared.normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite')
    : 'gemini-3.1-flash-lite';

  const directJson = JSON.stringify(voteResult.directScenes || []);
  const prompt = `You are an expert family-safety timestamp synchronization engine for movies and TV episodes.
Media: "${meta.title || meta.targetId}" (${meta.year || 'Unknown Year'})${meta.isSeries ? ` - Season ${meta.season}, Episode${meta.episode}` : ''}.

Below is multi-source parental guide evidence (from CringeMDb, Kids-In-Mind chronological review, IMDb Parents Guide, Plugged In, Parent Previews, DoesTheDogDie) AND the actual subtitle timeline + silent gaps of the user's video file.

DIRECT_TIMESTAMPS_FROM_CRINGEMDB:
${directJson}

PARENTAL_SOURCES_EVIDENCE:
${voteResult.combinedReport || 'No external text report available.'}

SUBTITLE_TIMELINE_AND_GAPS:
${summaryText}

YOUR TASK:
1. Identify ALL explicit sex scenes, nudity scenes (full nudity, topless, exposed genitals/buttocks), sexual violence/rape, strip club/orgy scenes, or intense sexual activity in this specific movie/episode.
2. Do NOT include normal non-sexual violence, profanity/cursing alone, or brief fully-clothed romantic hugs.
3. Combine the DIRECT_TIMESTAMPS_FROM_CRINGEMDB (adjusting slightly if the subtitle dialogue/gaps show a small version offset) WITH any additional scenes described in Kids-In-Mind, IMDb, Plugged In, or Parent Previews that CringeMDb missed!
4. Use the chronological order of Kids-In-Mind / Plugged In and match the surrounding plot events to the SUBTITLE_TIMELINE_AND_GAPS to pinpoint the exact start and end in seconds.
5. Output ONLY a valid JSON array of objects: [{"start": <number_in_seconds>, "end": <number_in_seconds>}]. If there are NO such scenes, output [].`;

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

// ===== الدالة الرئيسية لتحضير الدرع قبل بناء SRT أو ASS =====
async function prepareShield(targetId, cues, texts = null, keysArray = [], modelName = null) {
  if (USE_TEST_SCENES) return TEST_SCENES;
  if (!targetId) return [];

  const manual = getManualScenes(targetId);
  if (manual) return manual;

  if (RESOLVED_SCENES_CACHE.has(targetId)) {
    return RESOLVED_SCENES_CACHE.get(targetId);
  }

  // منع تكرار نفس الطلب إذا تم استدعاؤه مرتين في نفس اللحظة
  if (IN_FLIGHT_REQUESTS.has(targetId)) {
    return IN_FLIGHT_REQUESTS.get(targetId);
  }

  const task = (async () => {
    try {
      const meta = await resolveMediaMeta(targetId);
      if (!meta) {
        saveToMemoryCache(targetId, []);
        return [];
      }

      const voteResult = await evaluateAndVoteSources(meta);

      // 1. إذا صوتت المصادر بالإجماع على نظافة العمل ولا يوجد أي مشهد مسجل
      if (voteResult.isConfirmedClean) {
        console.log(`[درع Nuvio ✅] العمل (${meta.title || targetId}) نظيف عائلياً بالتصويت.`);
        saveToMemoryCache(targetId, []);
        return [];
      }

      // 2. إذا وجدت مشاهد أو أوصاف، ندمج الأوقات المباشرة مع مطابقة Gemini
      let finalScenes = voteResult.directScenes.slice();

      if (voteResult.adultVotes > 0 || voteResult.combinedReport.length > 0) {
        const aiScenes = await matchScenesWithGemini(meta, voteResult, cues, texts, keysArray, modelName);
        if (aiScenes.length > 0) {
          // دمج أوقات المصادر المباشرة مع الأوقات التي استخرجها أو صححها الذكاء الاصطناعي
          finalScenes = normalizeScenes([...finalScenes, ...aiScenes]);
        }
      }

      // إضافة هامش الأمان قبل وبعد كل مشهد
      const padded = normalizeScenes(
        finalScenes.map(sc => ({
          start: Math.max(0, sc.start - SCENE_PAD_SEC),
          end: sc.end + SCENE_PAD_SEC
        }))
      );

      console.log(`[درع Nuvio 🛡️] اكتمل الفحص لـ (${meta.title || targetId}) -> تم تفعيل الحجب على (${padded.length}) مشهد.`);
      saveToMemoryCache(targetId, padded);
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

function calcSceneMetrics(startSec, endSec) {
  const rawDuration = Math.max(1, endSec - startSec);
  const roundedDuration = Math.max(10, Math.ceil(rawDuration / 10) * 10);
  const presses = roundedDuration / 10;
  return { roundedDuration, presses };
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

// ===== نصوص الرسائل =====
const warnMsg = (d, p) => `⚠️ تنبيه: مشهد غير عائلي بعد قليل (مدته ${d} ثانية - قدّم ${p} مرات) ⚠️`;
const hideMsg = (d, p) => `⚠️ مشهد محجوب (${d} ثانية - قدّم ${p} مرات) ⚠️`;

// ===== SRT: رسالة ملونة في أعلى الشاشة (an8) =====
function srtTopMsg(text) {
  return `{\\an8\\1c${WARN_ASS}\\3c&H000000&}<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

function srtBanner(text) {
  return `<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

// ===== SRT: جدار التعتيم في منتصف الشاشة (an5) =====
function srtWall() {
  const row = `<font color="#000000">${WALL_ROW}</font>`;
  return `{\\an5\\1c&H000000&\\3c&H000000&}` + Array.from({ length: WALL_ROWS }, () => row).join('\n');
}

function applyShieldToSrtItems(items, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return items;

  let current = items.slice();
  let prevEnd = 0;

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const { roundedDuration, presses } = calcSceneMetrics(start, end);

    // 1. قص أو حذف أي حوار يتداخل مع وقت التعتيم
    const kept = [];
    for (const it of current) {
      if (it.endSec <= start || it.startSec >= end) {
        kept.push(it);
        continue;
      }
      if (it.startSec < start) {
        kept.push({ startSec: it.startSec, endSec: start, text: it.text });
      }
      if (it.endSec > end) {
        kept.push({ startSec: end, endSec: it.endSec, text: it.text });
      }
    }

    // 2. التنبيه المسبق فوق الحوار وملء الفراغات
    const warnStart = Math.max(prevEnd, start - WARN_SEC);
    const banner = srtBanner(warnMsg(roundedDuration, presses));
    const hasWarn = start - warnStart >= 1;
    const next = [];
    const inWindow = [];
    for (const it of kept) {
      if (!hasWarn || it.endSec <= warnStart || it.startSec >= start) {
        next.push(it);
        continue;
      }
      if (it.startSec < warnStart) {
        next.push({ startSec: it.startSec, endSec: warnStart, text: it.text });
      }
      inWindow.push({
        startSec: Math.max(warnStart, it.startSec),
        endSec: Math.min(start, it.endSec),
        text: `${banner}\n${it.text}`
      });
    }
    if (hasWarn) {
      inWindow.sort((a, b) => a.startSec - b.startSec);
      let cursor = warnStart;
      for (const ov of inWindow) {
        if (ov.startSec - cursor >= 0.25) next.push({ startSec: cursor, endSec: ov.startSec, text: banner });
        next.push(ov);
        cursor = Math.max(cursor, ov.endSec);
      }
      if (start - cursor >= 0.25) next.push({ startSec: cursor, endSec: start, text: banner });
    }

    // 3. الجدار ثم رسالة الحجب بعده
    next.push({ startSec: start, endSec: end, text: srtWall() });
    next.push({ startSec: start, endSec: end, text: srtTopMsg(hideMsg(roundedDuration, presses)) });

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

  const topTag = `{\\an8\\1c${WARN_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c&H000000&\\3c&H000000&\\bord0\\shad0}`;
  const wall = wallTag + Array.from({ length: WALL_ROWS }, () => WALL_ROW).join('\\N');

  const extra = [];
  let prevEnd = 0;

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const { roundedDuration, presses } = calcSceneMetrics(start, end);
    const warnStart = Math.max(prevEnd, start - WARN_SEC);

    if (start - warnStart >= 1) {
      const warnLine = topTag + warnMsg(roundedDuration, presses);
      extra.push(`Dialogue: 99,${formatAssTimeSec(warnStart)},${formatAssTimeSec(start)},Default,,0,0,0,,${addAssRlm(warnLine)}`);
    }

    extra.push(`Dialogue: 98,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${wall}`);
    const hideLine = topTag + hideMsg(roundedDuration, presses);
    extra.push(`Dialogue: 99,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${addAssRlm(hideLine)}`);

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
