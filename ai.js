const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const zlib = require('zlib');

let httpAgent, httpsAgent;
try { ({ httpAgent, httpsAgent } = require('../../utils/httpAgents')); } catch (e) {}

const ASS_DEFAULT_HEADER = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'Collisions: Normal',
  'PlayDepth: 0',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,26,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ''
].join('\n');

// ==================================================================
// كل المتغيرات (الثوابت) في مكان واحد
// ==================================================================
const DEFAULT_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CLIENT_HEADER = 'stremio-submaker/1.4.94';
const MAX_AI_RESPONSE_BYTES = 20 * 1024 * 1024;

// عدد مرات إعادة طلب الأسطر الناقصة فقط (بعد الطلب الأول)
const MAX_MISSING_RETRIES = 3;
// عدد الجولات الإضافية لإعادة الأسطر اللي انتجاوزت بسبب الخنق (429/503)
const MAX_RETRY_PASSES = 4;

// ---------- مصادر الأجناس (الترتيب: AniList للأنمي ثم TMDB ثم تحليل الضمائر) ----------
const MAX_CAST_CHARACTERS = 40;         // أقصى عدد شخصيات تنرسل للبرومبت
const MAX_CAST_HINTS = 100;             // حجم كاش TMDB / AniList
const MIN_GENDERED_CHARACTERS = 2;      // أقل عدد شخصيات بجنس معروف حتى نعتبر المصدر "موثوق"
// في الأنيميشن جنس الممثل الصوتي غالباً لا يطابق جنس الشخصية (مثل بارت سيمبسون)
const USE_ACTOR_GENDER_FOR_ANIMATION = false;

// AniList (مجاني وبلا مفتاح، ويعطي جنس الشخصية نفسها مو الممثل الصوتي)
const ANILIST_API_URL = 'https://graphql.anilist.co';
const ANILIST_PER_PAGE = 25;            // الحد الأقصى المسموح للحقول المتداخلة
const ANILIST_MAX_PAGES = 2;            // 2 x 25 = حتى 50 شخصية (الرئيسية أولاً)
const ANILIST_TIMEOUT_MS = 8000;

// ---------- تحليل الضمائر (الاحتياطي الأخير) ----------
const ENABLE_GENDER_ANALYSIS = true;
const ANNOTATION_MIN_COVERAGE = 0.8;         // إذا 80% من الأسطر محللة نكتفي
const ANNOTATION_BUDGET_MS = 90000;          // أقصى وقت للتحليل كله، بعده نكمل الترجمة بدونه
const ANNOTATION_SLICE_SIZE = 300;           // أقصى عدد أسطر بالطلب الواحد
const ANNOTATION_MIN_SLICE = 150;            // أقل عدد أسطر بالطلب (حتى يبقى فيه سياق كافي)
const ANNOTATION_MAX_CONCURRENCY = 12;       // أقصى عدد طلبات تحليل بنفس الوقت (لكل مفتاح طلب)
const ANNOTATION_PASSES = 2;                 // جولة أساسية + جولة إعادة للناقص
const ANNOTATION_REQUEST_TIMEOUT_MS = 45000;
const ANNOTATION_ATTEMPTS = 2;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ================== نظام المفاتيح - تبريد ذكي ==================
const keyCooldowns = new Map();
const deadKeys = new Set();
let currentKeyIndex = 0;

function normalizeGeminiModelId(m) {
  return String(m || '').trim().replace(/^models\//, '');
}

function isGemini3Model(m) {
  const id = normalizeGeminiModelId(m).toLowerCase();
  if (id.startsWith('gemini-3')) return true;
  if (id === 'gemini-flash-latest' || id === 'gemini-flash-lite-latest' || id === 'gemini-pro-latest') return true;
  return false;
}

function getFallbackOutputTokenLimit(model) {
  const n = normalizeGeminiModelId(model).toLowerCase();
  if (n.includes('2.0') || n.includes('-flash-001') || n.includes('-flash-lite-001')) return 8192;
  if (n.includes('2.5') || isGemini3Model(n)) return 65536;
  return 8192;
}

function isGeminiAuthFailure(e) {
  const s = e?.response?.status;
  if (s === 401 || s === 403) return true;
  if (s !== 400) return false;
  const msg = String(e?.response?.data?.error?.message || '').toLowerCase();
  return msg.includes('api key') && (msg.includes('invalid') || msg.includes('not valid') || msg.includes('permission'));
}

function getDynamicChunkSize(modelName) {
  const limit = getFallbackOutputTokenLimit(modelName);
  const safetyMargin = Math.floor(limit * 0.05);
  const available = limit - safetyMargin;
  if (available >= 60000) return 280;
  if (available >= 30000) return 100;
  return 80;
}

function aliveKeyCount(keysArray) {
  return (keysArray || []).filter(k => !deadKeys.has(k)).length;
}

// maxWaitMs: أقصى انتظار مسموح للتبريد. إذا أطول منه نرجع null بدل ما نعلّق.
async function acquireKey(keysArray, maxWaitMs = Infinity) {
  if (!keysArray || keysArray.length === 0) return null;
  while (true) {
    const now = Date.now();
    for (let i = 0; i < keysArray.length; i++) {
      const key = keysArray[currentKeyIndex % keysArray.length];
      currentKeyIndex = (currentKeyIndex + 1) % keysArray.length;
      if (deadKeys.has(key)) continue;
      if ((keyCooldowns.get(key) || 0) <= now) return key;
    }
    let bestTime = Infinity;
    for (const k of keysArray) {
      if (!deadKeys.has(k)) bestTime = Math.min(bestTime, keyCooldowns.get(k) || 0);
    }
    if (bestTime === Infinity) return null;
    const wait = bestTime - now;
    if (wait > maxWaitMs) return null;
    if (wait > 0) {
      console.log(`[تبريد جماعي] كل المفاتيح الحية بالتبريد. انتظار ${Math.ceil(wait / 1000)}s...`);
      // تأخير عشوائي (Jitter) حتى العمال ما يصحون كلهم بنفس اللحظة
      await delay(wait + (Math.random() * 3000));
    }
  }
}

// يحسب مدة التبريد حسب حالة الخطأ
function cooldownForStatus(status) {
  if (status === 503 || status === 500 || status === 502) return 3000 + Math.random() * 2000;
  if (status === 429) return 60000;
  if (status === 400) return 10000;
  if (status === 0) return 2000; // مهلة/شبكة: المفتاح سليم، لا نبرّده دقيقة
  return 60000;
}

function shortErr(e) {
  const m = e?.response?.data?.error?.message || e?.message || '';
  return String(m).replace(/\s+/g, ' ').slice(0, 140);
}

// ================== دوال المعالجة ==================
function fixArabicEncoding(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    try { return Buffer.from(iconv.decode(buffer, 'utf16-le'), 'utf-8'); } catch (e) {}
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try { return Buffer.from(iconv.decode(buffer, 'utf16-be'), 'utf-8'); } catch (e) {}
  }
  const utf8Text = buffer.toString('utf-8');
  if (!utf8Text.includes('\uFFFD')) return buffer;
  if (/[\u0600-\u06FF]/.test(utf8Text)) return buffer;
  try {
    const decodedWin = iconv.decode(buffer, 'windows-1256');
    if (/[\u0600-\u06FF]/.test(decodedWin)) return Buffer.from(decodedWin, 'utf-8');
  } catch (e) {}
  try {
    const decodedIso = iconv.decode(buffer, 'iso-8859-6');
    if (/[\u0600-\u06FF]/.test(decodedIso)) return Buffer.from(decodedIso, 'utf-8');
  } catch (e) {}
  return buffer;
}

function srtTimeToAss(t) {
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return '0:00:00.00';
  const h = parseInt(m[1], 10);
  const cs = Math.floor(parseInt(m[4], 10) / 10).toString().padStart(2, '0');
  return `${h}:${m[2]}:${m[3]}.${cs}`;
}

function extractCuesUniversal(text) {
  const assLines = text.split(/\r?\n/).filter(l => /^Dialogue:/i.test(l.trim()));
  if (assLines.length > 0) {
    const cues = [];
    for (const line of assLines) {
      const m = line.match(/^Dialogue:\s*[^,]*,([^,]*),([^,]*),(?:[^,]*,){6}(.*)$/i);
      if (m) cues.push({ start: m[1].trim(), end: m[2].trim(), text: m[3] });
    }
    if (cues.length) return cues;
  }
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length);
    if (lines.length < 2) continue;
    let idx = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const tm = (lines[idx] || '').match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const text2 = lines.slice(idx + 1).join('\\N');
    if (text2.trim()) cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

function normalizeLineBreakArtifacts(txt) {
  if (!txt) return txt;
  return String(txt)
    .replace(/\\"/g, '"')
    .replace(/\\\\n/gi, '\n')
    .replace(/\\\\N/g, '\n')
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\r/g, '');
}

// (قديمة - تبقى موجودة لأن ملفات ثانية ممكن تستعملها)
function parseRobustJsonArray(raw, expectedLength) {
  if (!raw) return null;
  let clean = raw.trim();
  if (clean.startsWith('```json')) clean = clean.substring(7);
  else if (clean.startsWith('```')) clean = clean.substring(3);
  if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);
  clean = clean.trim();

  try {
    const parsed = JSON.parse(clean);
    let arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
    if (Array.isArray(arr) && arr.length === expectedLength) {
      return arr.map(x => {
        let txt = String(x || '').replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪');
        return normalizeLineBreakArtifacts(txt).trim();
      });
    }
  } catch (e) {
    const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
    if (stringMatches.length === expectedLength) {
      return stringMatches.filter(s => s !== 'translations' && s !== 'data').map(s => normalizeLineBreakArtifacts(s).replace(/âTM./gi, '♪').trim());
    }
  }
  return null;
}

// ================== قراءة الرد بالأرقام (id) ==================
// ترجع Map: رقم السطر -> الترجمة. حتى لو الرد ناقص أو مقطوع، تاخذ اللي سليم منه.
function parseIdTranslations(raw) {
  if (!raw) return null;
  let clean = String(raw).trim();
  if (clean.startsWith('```json')) clean = clean.substring(7);
  else if (clean.startsWith('```')) clean = clean.substring(3);
  if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);
  clean = clean.trim();

  const map = new Map();
  const fix = s => normalizeLineBreakArtifacts(
    String(s == null ? '' : s).replace(/âTM./gi, '♪').replace(/â™ª/gi, '♪')
  ).trim();

  try {
    const parsed = JSON.parse(clean);
    const arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o === 'object' && o.id !== undefined) {
          const id = Number(o.id);
          const t = fix(o.text);
          if (Number.isInteger(id) && t) map.set(id, t);
        }
      }
    }
    if (map.size) return map;
  } catch (e) {}

  // إذا الرد مقطوع أو فيه خلل: ننقذ كل سطر سليم لحاله
  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    let t;
    try { t = JSON.parse('"' + m[2] + '"'); } catch (e) { t = m[2]; }
    t = fix(t);
    if (t) map.set(Number(m[1]), t);
  }
  return map.size ? map : null;
}

async function runConcurrentPool(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try { results[current] = await tasks[current](); }
      catch (err) {
        console.log(`[Pool] مهمة ${current + 1}/${tasks.length} فشلت: ${err && err.message}`);
        results[current] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ==================================================================
// مصدر الأجناس 1: AniList (للأنمي فقط) - جنس الشخصية نفسها
// يحتاج anilistId (يجي من خدمة ARM عند تحويل Kitsu). بلا مفتاح.
// ترجع { hint, hasGender, source }
// ==================================================================
const anilistHintCache = new Map();

const ANILIST_QUERY = `
query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    id
    format
    title { romaji english }
    characters(page: $page, perPage: $perPage, sort: [ROLE, RELEVANCE]) {
      pageInfo { hasNextPage }
      edges {
        role
        node { name { full } gender }
      }
    }
  }
}`;

async function anilistRequest(variables) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.post(ANILIST_API_URL, { query: ANILIST_QUERY, variables }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: ANILIST_TIMEOUT_MS,
        httpAgent, httpsAgent
      });
      return r.data && r.data.data ? r.data.data : null;
    } catch (e) {
      const status = e.response?.status || 0;
      if (status === 429 && attempt === 0) {
        const ra = parseInt(e.response?.headers?.['retry-after'], 10);
        const waitMs = Math.min((Number.isFinite(ra) ? ra : 5) * 1000, 15000);
        console.log(`[AniList] 429 (ضغط). انتظار ${Math.ceil(waitMs / 1000)}s ثم إعادة المحاولة...`);
        await delay(waitMs);
        continue;
      }
      throw e;
    }
  }
  return null;
}

function anilistGenderToCode(g) {
  const s = String(g || '').trim().toLowerCase();
  if (s === 'male') return 'M';
  if (s === 'female') return 'F';
  return '?';
}

async function getAnilistCastHint(anilistId) {
  const empty = { hint: '', hasGender: false, source: 'AniList' };
  const id = parseInt(anilistId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    console.log(`[AniList] معرّف غير صالح (${anilistId || 'فاضي'})، تخطيت AniList.`);
    return empty;
  }
  if (anilistHintCache.has(id)) {
    const c = anilistHintCache.get(id);
    console.log(`[AniList] ${id}: من الكاش (${c.hint.split(', ').length} شخصية، hasGender=${c.hasGender}).`);
    return c;
  }

  const t0 = Date.now();
  const rawChars = [];
  let title = '';
  let format = '';

  for (let page = 1; page <= ANILIST_MAX_PAGES; page++) {
    try {
      const data = await anilistRequest({ id, page, perPage: ANILIST_PER_PAGE });
      const media = data && data.Media;
      if (!media) {
        console.log(`[AniList] ${id}: الرد بدون Media (صفحة ${page}).`);
        break;
      }
      if (page === 1) {
        title = (media.title && (media.title.english || media.title.romaji)) || '';
        format = media.format || '';
      }
      const conn = media.characters;
      for (const edge of (conn && conn.edges) || []) {
        rawChars.push({
          name: edge && edge.node && edge.node.name ? edge.node.name.full : '',
          gender: edge && edge.node ? edge.node.gender : null,
          role: edge ? edge.role : ''
        });
      }
      if (!(conn && conn.pageInfo && conn.pageInfo.hasNextPage)) break;
    } catch (e) {
      const apiMsg = e.response?.data?.errors?.[0]?.message || e.message;
      console.log(`[AniList] ${id}: فشل الطلب صفحة ${page} (status:${e.response?.status || 0}) ${String(apiMsg).slice(0, 140)}`);
      break;
    }
  }

  const seen = new Set();
  const parts = [];
  let cM = 0, cF = 0, cU = 0;
  for (const c of rawChars) {
    if (parts.length >= MAX_CAST_CHARACTERS) break;
    const name = String(c.name || '').replace(/,/g, ' ').replace(/=/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const g = anilistGenderToCode(c.gender);
    if (g === 'M') cM++; else if (g === 'F') cF++; else cU++;
    parts.push(`${name} = ${g}`);
  }

  const genderCount = cM + cF;
  const result = { hint: parts.join(', '), hasGender: genderCount >= MIN_GENDERED_CHARACTERS, source: 'AniList' };

  console.log(`[AniList] ${id} "${title}" ${format}: ${rawChars.length} شخصية مستلمة، ${parts.length} بعد التنظيف (M=${cM} F=${cF} ?=${cU}) في ${Date.now() - t0}ms.`);
  if (parts.length) console.log(`[AniList] ${id} عينة: ${parts.slice(0, 8).join(' | ')}`);

  if (result.hint) {
    anilistHintCache.set(id, result); // لا نخزن النتائج الفارغة
    if (anilistHintCache.size > MAX_CAST_HINTS) anilistHintCache.delete(anilistHintCache.keys().next().value);
  } else {
    console.log(`[AniList] ${id}: ما لقيت شخصيات.`);
  }
  return result;
}

// ==================================================================
// مصدر الأجناس 2: TMDB (أفلام + مسلسلات + أنيميشن)
// يحتاج متغير بيئة TMDB_API_KEY (v3 أو توكن v4 يبدأ بـ eyJ) ورقم IMDb.
// ترجع { hint, hasGender, source }
// ==================================================================
const castHintCache = new Map();

async function getCastHint(imdbId) {
  const empty = { hint: '', hasGender: false, source: 'TMDB' };
  const apiKey = String(process.env.TMDB_API_KEY || '').trim();
  const m = String(imdbId || '').match(/tt\d+/i);
  console.log(`[TMDB] imdbId=${imdbId || 'مفقود'} | key=${apiKey ? 'موجود' : 'مفقود'}`);
  if (!m || !apiKey) return empty;
  const tt = m[0].toLowerCase();
  if (castHintCache.has(tt)) {
    const c = castHintCache.get(tt);
    console.log(`[TMDB] ${tt}: من الكاش (${c.hint.split(', ').length} شخصية، hasGender=${c.hasGender}).`);
    return c;
  }

  const t0 = Date.now();
  const base = 'https://api.themoviedb.org/3';
  const isBearer = apiKey.startsWith('eyJ'); // دعم توكن v4 أيضاً
  const headers = isBearer ? { Authorization: `Bearer ${apiKey}` } : {};
  const get = (path, params = {}) => axios.get(`${base}${path}`, {
    timeout: 8000, httpAgent, httpsAgent, headers,
    params: isBearer ? params : { ...params, api_key: apiKey }
  });

  try {
    const found = await get(`/find/${tt}`, { external_source: 'imdb_id' });
    const fd = found.data || {};
    console.log(`[TMDB] find ${tt}: tv=${fd.tv_results?.length || 0} episode=${fd.tv_episode_results?.length || 0} movie=${fd.movie_results?.length || 0}`);

    const tv = fd.tv_results?.[0];
    const tvId = tv?.id || fd.tv_episode_results?.[0]?.show_id;
    const movieId = fd.movie_results?.[0]?.id;
    let genreIds = tv?.genre_ids || fd.movie_results?.[0]?.genre_ids || [];

    // إذا وصلنا للمسلسل عن طريق حلقة، ما عندنا genre_ids: نجيبها من تفاصيل المسلسل
    if (tvId && genreIds.length === 0) {
      try {
        const d = await get(`/tv/${tvId}`);
        genreIds = (d.data?.genres || []).map(g => g.id);
      } catch (e) {
        console.log(`[TMDB] ${tt}: ما قدرت أجيب تصنيف المسلسل (${e.response?.status || 0}).`);
      }
    }
    const isAnimation = genreIds.includes(16);

    let rawCast = [];
    if (tvId) {
      const r = await get(`/tv/${tvId}/aggregate_credits`);
      rawCast = (r.data?.cast || []).map(a => ({ gender: a.gender, character: a.roles?.[0]?.character }));
      if (rawCast.length === 0) {
        const r2 = await get(`/tv/${tvId}/credits`);
        rawCast = (r2.data?.cast || []).map(a => ({ gender: a.gender, character: a.character }));
      }
    } else if (movieId) {
      const r = await get(`/movie/${movieId}/credits`);
      rawCast = (r.data?.cast || []).map(a => ({ gender: a.gender, character: a.character }));
    }
    console.log(`[TMDB] ${tt}: ${rawCast.length} ممثل${isAnimation ? ' (أنيميشن)' : ''}`);

    const trustGender = !isAnimation || USE_ACTOR_GENDER_FOR_ANIMATION;
    if (!trustGender) console.log(`[TMDB] ${tt}: أنيميشن، جنس الممثل الصوتي غير موثوق، أرسل الأسماء فقط.`);

    const seen = new Set();
    const parts = [];
    let cM = 0, cF = 0, cU = 0;
    for (const a of rawCast) {
      if (parts.length >= MAX_CAST_CHARACTERS) break;
      const name = String(a.character || '')
        .replace(/\([^)]*\)/g, '').split('/')[0].replace(/,/g, ' ').replace(/=/g, ' ').replace(/\s+/g, ' ').trim();
      if (!name || /^(self|himself|herself|themselves|uncredited|narrator)$/i.test(name)) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);

      let g = '?';
      if (trustGender) g = a.gender === 1 ? 'F' : (a.gender === 2 ? 'M' : '?');
      if (g === 'M') cM++; else if (g === 'F') cF++; else cU++;
      parts.push(`${name} = ${g}`);
    }

    const genderCount = cM + cF;
    const result = { hint: parts.join(', '), hasGender: genderCount >= MIN_GENDERED_CHARACTERS, source: 'TMDB' };
    if (result.hint) {
      console.log(`[TMDB] ${tt}: ${parts.length} شخصية (M=${cM} F=${cF} ?=${cU}) في ${Date.now() - t0}ms.`);
      console.log(`[TMDB] ${tt} عينة: ${parts.slice(0, 8).join(' | ')}`);
      castHintCache.set(tt, result); // لا نخزن النتائج الفارغة
      if (castHintCache.size > MAX_CAST_HINTS) castHintCache.delete(castHintCache.keys().next().value);
    } else {
      console.log(`[TMDB] ${tt}: ما لقيت شخصيات.`);
    }
    return result;
  } catch (e) {
    console.log(`[TMDB] فشل (status:${e.response?.status || 0}) ${e.response?.data?.status_message || e.message}`);
    return empty;
  }
}

// يختار مصدر الأجناس بالترتيب: AniList (لو فيه anilistId) -> TMDB -> (تحليل الضمائر يجي بعدين)
// hasGender=true يعني المصدر أعطى أجناس موثوقة وما نحتاج تحليل الضمائر
async function resolveCastInfo(imdbId, anilistId) {
  const t0 = Date.now();
  let anilistResult = null;

  if (anilistId) {
    anilistResult = await getAnilistCastHint(anilistId);
    if (anilistResult.hasGender) {
      console.log(`[مصدر الأجناس] ✅ AniList (${Date.now() - t0}ms).`);
      return anilistResult;
    }
    console.log('[مصدر الأجناس] AniList ما أعطى أجناس كافية، أجرب TMDB...');
  } else {
    console.log('[مصدر الأجناس] ما فيه anilistId (مو أنمي من Kitsu أو ARM ما رجّع رقم)، أبدأ بـ TMDB.');
  }

  const tmdbResult = await getCastHint(imdbId);
  if (tmdbResult.hasGender) {
    console.log(`[مصدر الأجناس] ✅ TMDB (${Date.now() - t0}ms).`);
    return tmdbResult;
  }

  // لا أحد أعطى أجناس موثوقة: نستخدم الأسماء فقط (AniList أفضل للأنمي)
  if (anilistResult && anilistResult.hint) {
    console.log(`[مصدر الأجناس] أسماء فقط من AniList، التحليل الاحتياطي سيكمل (${Date.now() - t0}ms).`);
    return anilistResult;
  }
  if (tmdbResult.hint) {
    console.log(`[مصدر الأجناس] أسماء فقط من TMDB، التحليل الاحتياطي سيكمل (${Date.now() - t0}ms).`);
    return tmdbResult;
  }
  console.log(`[مصدر الأجناس] ⚠️ لا AniList ولا TMDB أعطوا شخصيات (${Date.now() - t0}ms).`);
  return { hint: '', hasGender: false, source: 'none' };
}

// ================== الترجمة الأساسية (بالأرقام) ==================
// items = [{ id: 5, text: "..." }, ...]
// ترجع: { status, map }  حيث map = رقم السطر -> الترجمة
async function translateChunkStrict(items, keysArray, modelName, castHint) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const isGemini3 = isGemini3Model(cleanModel);
  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };
  if (isGemini3) { generationConfig.thinkingConfig = { thinkingLevel: 'minimal' }; }

  const castBlock = castHint
    ? `CHARACTER REFERENCE (from the cast list; M = male, F = female, ? = unknown so infer from context; use it to choose the correct Arabic gender when these characters speak, are addressed, or are mentioned by name; these are person names, so apply the person-name quotation rule; never output this list): ${castHint}\n`
    : '';

  const prompt = `You will receive a JSON array of subtitle entries. Each entry is an object: {"id": <number>, "text": "<subtitle text>"} and may also include "g": a two-letter hint code.
"g" = first letter is the SPEAKER's gender, second letter is the gender of the person being ADDRESSED. M = male, F = female, G = group or mixed, U = unknown, N = none. Never output "g".
Translate the "text" of every entry to Arabic while:
1. Returning a JSON array of objects in the exact same shape: [{"id": <same number>, "text": "<Arabic translation>"}].
   - Return exactly ONE object for EVERY input id, using the SAME id. Never merge entries, never split an entry, never skip an entry, never invent ids.
   - Keep each translation inside its own id, even if a sentence continues in the next entry.
2. If an entry contains multiple lines separated by a real line break, the translation must contain the exact same number of lines, in the same order, separated by a real line break only, within the JSON string value.
3. Preserving any formatting tags or special characters.
4. Any text wrapped entirely in square brackets [ ] represents on-screen text or action tags. Translate it accurately and strictly keep the square brackets in the Arabic output.
5. Wrap place names, city names, country names, food/dish names, brand names, and other foreign proper nouns (non-person) in Arabic parentheses: (الاسم).
6. Wrap person names (character names) in Arabic quotation marks: "الاسم" — quotation marks are reserved for person names only, never for places/food/brands.
7. When an entire entry is off-screen narration, a voice-over, a letter being read aloud, or a voice heard through a phone/radio/TV with no visible speaker on screen, wrap the WHOLE entry in ONE single pair of quotation marks (one at the start, one at the end). Do not add internal quotes for names if the whole entry is already quoted.
8. GENDER ENFORCEMENT & NEUTRALITY: Arabic requires gendered grammar (verbs, adjectives, pronouns, vocatives) for I/me/my/you/your and for anyone referred to. When an entry has "g", use it to pick the correct Arabic gender for the speaker (first letter) and the person addressed (second letter). Treat "g" as a strong hint, but if the text itself clearly contradicts it (explicit names, titles, "he said"/"she said"), trust the text. When "g" is missing or a letter is U or N, infer gender from the dialogue context in this chunk; if it is still impossible to determine, formulate the Arabic to be naturally GENDER-NEUTRAL (passive voice or verbal nouns) instead of guessing.
9. Pay close attention to split sentences (sentences that start in one entry and continue into the next, often indicated by "..."). Ensure the Arabic grammar and phrasing flow logically and seamlessly across these sequential entries, while still keeping each entry's translation under its own id.
10. Act as an expert cinematic subtitler. Translate idioms/slang naturally into Arabic rather than literally.
=== CINEMATIC CONSTITUTION (CRITICAL RULES) ===
11. RELIGIOUS EXCLAMATIONS: Translate words like 'Jesus', 'Christ', or 'Oh my God' contextually as exclamations (e.g., يا إلهي، بحق السماء) and NEVER literally as a person's name.
12. EPILOGUES & LONG TEXTS: Never ignore, skip, or summarize long blocks of on-screen text. Translate them completely and accurately.
13. FOREIGN LANGUAGES: If dialogue is in a third language or has a tag (e.g., [speaks Spanish]), translate BOTH the tag and the actual meaning entirely into Arabic (e.g., [يتحدث الإسبانية] يا صديقي). Leave NO English or foreign text behind.
14. PROFANITY: Translate swear words into standard cinematic Arabic equivalents without literal awkwardness.
${castBlock}Do NOT overthink. Do NOT overplan.
Do NOT include acknowledgements, explanations, notes or alternative translations.
Output ONLY A VALID JSON ARRAY OF OBJECTS {"id","text"}, nothing else.
Content to translate:
${JSON.stringify(items)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const activeKey = await acquireKey(keysArray);
    if (!activeKey) return { status: 'no_keys', map: new Map() };

    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;

    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
        ]
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: 60000,
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const responseText = parts.map(p => p?.text || '').join('');
      const map = parseIdTranslations(responseText);

      if (map) {
        if (items.length >= 80) console.log(`[Success] chunk ${items.length} via ...${cleanKey.slice(-4)} (${map.size} رجعت)`);
        return { status: 'ok', map };
      }

      return { status: 'bad_format', map: new Map() };

    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status}) ${shortErr(e)}`);
        continue;
      }

      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s (status:${status}) ${shortErr(e)}`);

      if (attempt < 3) {
        const backoffDelay = 2000 + (Math.random() * 2000);
        await delay(backoffDelay);
      }
    }
  }
  return { status: 'api_exhausted', map: new Map() };
}

// يترجم الدفعة، وإذا نقصت أسطر يعيد طلب الناقصة فقط (مو الدفعة كلها)
async function translateItemsWithRecovery(items, keysArray, modelName, castHint) {
  const done = new Map();
  if (!items || items.length === 0) return done;

  let pending = items;

  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    const result = await translateChunkStrict(pending, keysArray, modelName, castHint);

    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ] السيرفرات مختنقة. تم تجاوز (${pending.length}) سطر للحفاظ على تزامن الفلم.`);
      break;
    }

    if (result.status === 'ok') {
      const wanted = new Set(pending.map(it => it.id));
      for (const [id, text] of result.map) {
        if (wanted.has(id) && text) done.set(id, text);
      }
    }
    // (bad_format: نعيد الطلب لنفس الأسطر)

    const before = pending.length;
    pending = pending.filter(it => !done.has(it.id));

    if (pending.length > 0 && round < MAX_MISSING_RETRIES) {
      console.log(`[إعادة الناقص 🔁] ناقص ${pending.length} من ${before}. أعيد طلبهم فقط...`);
    }
  }

  if (pending.length > 0) {
    console.log(`[تجاوز سطر] ${pending.length} سطر بقوا بنصهم الأصلي للحفاظ على التزامن.`);
  }
  return done;
}

async function fetchAndExtractSub(subUrl) {
  const decodedUrl = decodeURIComponent(subUrl);
  const response = await axios.get(decodedUrl, {
    responseType: 'arraybuffer', timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
  });
  let buffer = Buffer.from(response.data);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find(e => !e.isDirectory && /\.(srt|ass|ssa)$/i.test(e.entryName));
    if (entry) buffer = entry.getData();
  }
  return fixArabicEncoding(buffer).toString('utf-8');
}

// يجهز نص السطر قبل الإرسال
function prepCueText(t) {
  if (/[A-Z]/.test(t) && t === t.toUpperCase() && !t.includes('[')) return `[${t}]`;
  return t;
}

// ================== كاش الأسطر (يحفظ كل سطر ترجم) ==================
// رابط الترجمة -> Map(رقم السطر -> الترجمة)
// إذا المحاولة الأولى نقصت أسطر، المحاولة الثانية تترجم الناقصة فقط
const lineCaches = new Map();
const MAX_LINE_CACHES = 40;

function getLineCache(key) {
  if (!lineCaches.has(key)) {
    lineCaches.set(key, new Map());
    if (lineCaches.size > MAX_LINE_CACHES) lineCaches.delete(lineCaches.keys().next().value);
  }
  return lineCaches.get(key);
}

// الأسطر اللي فيها رموز أو أرقام أو وسوم بس (مثل ♪ أو {\an8}) ما تحتاج ترجمة
function needsTranslation(text) {
  const t = String(text || '').replace(/<[^>]*>|\{[^}]*\}|\\N|\\n/g, '');
  return /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(t);
}

// ================== تحليل المتكلم والمخاطَب (الاحتياطي الأخير) ==================
// رابط الترجمة -> Map(رقم السطر -> رمز من حرفين، مثل "FM" = المتكلم أنثى والمخاطَب ذكر)
const annotationCaches = new Map();
const MAX_ANNOTATION_CACHES = 40;

function getAnnotationCache(key) {
  if (!annotationCaches.has(key)) {
    annotationCaches.set(key, new Map());
    if (annotationCaches.size > MAX_ANNOTATION_CACHES) annotationCaches.delete(annotationCaches.keys().next().value);
  }
  return annotationCaches.get(key);
}

// الأسطر اللي فيها أنا/أنت/نحن/هو/هي فقط هي اللي تحتاج تحليل جنس (الباقي مثل "Okay." تنتجاوز)
const NEEDS_GENDER = /\b(i|i'm|i've|i'll|i'd|me|my|myself|you|you're|you've|you'll|your|yours|yourself|we|us|our|he|she|him|her|his)\b/i;

const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
];

// طلب نصي عام لجيمناي بنفس نظام المفاتيح والتبريد، مع مهلة كلية (deadline)
async function callGeminiText({ prompt, keysArray, modelName, generationConfig, timeout = 120000, attempts = 4, deadline = Infinity }) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 2000) return { status: 'deadline', text: '' };
    const activeKey = await acquireKey(keysArray, remaining);
    if (!activeKey) return { status: 'no_keys', text: '' };
    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;
    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: SAFETY_SETTINGS_OFF
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: Math.min(timeout, Math.max(deadline - Date.now(), 2000)),
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      return { status: 'ok', text: parts.map(p => p?.text || '').join('') };
    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status}) ${shortErr(e)}`);
        continue;
      }
      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s (status:${status}) ${shortErr(e)}`);
      if (attempt < attempts - 1) await delay(1000 + Math.random() * 1000);
    }
  }
  return { status: 'api_exhausted', text: '' };
}

// يقرأ رد التحليل: كل عنصر بشكل "رقم:حرفين" مثل "45:FM"
function parseAnnotationCodes(raw) {
  const map = new Map();
  if (!raw) return map;
  const re = /(\d+)\s*[:=]\s*([MFGUNmfgun])\s*([MFGUNmfgun])/g;
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    map.set(Number(m[1]), (m[2] + m[3]).toUpperCase());
  }
  return map;
}

// نص السطر للتحليل: بدون وسوم، و\N تصير مسافة (الشرطات "-" تبقى عشان نعرف المتكلمين)
function cleanForAnalysis(t) {
  return String(t || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function annotateSlice(items, keysArray, modelName, deadline, castHint, sliceLabel) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const generationConfig = { temperature: 0.1, responseMimeType: 'application/json' };
  if (isGemini3Model(cleanModel)) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };

  const castLine = castHint
    ? `Known character names from the cast list (M = male, F = female, ? = unknown; use them only to recognize who is who): ${castHint}\n`
    : '';

  const prompt = `You will receive numbered subtitle lines from one film or episode, in order, as a JSON array of {"id","text"}. Some lines of the story are not included; that is expected.
Read the whole story first. Then, for EVERY line, work out WHO IS SPEAKING and WHO IS BEING ADDRESSED, and output only their genders.
Codes: M = male, F = female, G = group or mixed, U = unknown, N = none (narration, on-screen text, sound effects, or speaking to oneself or the audience).
Answer with TWO letters per line: first the speaker's gender, then the addressee's gender. Examples: "FM" = a woman speaking to a man, "MG" = a man speaking to a group, "UU" = cannot tell.
Use the story: character names, titles (sir, ma'am, mother, king...), words like "he said"/"she said", who was just spoken to, and the alternation of dialogue. If a single line contains two speakers (lines starting with "-"), answer "UU". If you are not reasonably sure, answer U for that side. Do not guess randomly.
Output ONLY a valid JSON array of strings, exactly one string per input id, in the same order, each formatted "<id>:<two letters>", for example ["0:UU","1:FM","2:MF"]. No explanations.
${castLine}Lines:
${JSON.stringify(items)}`;

  const t0 = Date.now();
  const res = await callGeminiText({
    prompt, keysArray, modelName: cleanModel, generationConfig,
    timeout: ANNOTATION_REQUEST_TIMEOUT_MS, attempts: ANNOTATION_ATTEMPTS, deadline
  });
  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${sliceLabel}: فشل (${res.status}) بعد ${Date.now() - t0}ms.`);
    return new Map();
  }
  const map = parseAnnotationCodes(res.text);
  console.log(`[تحليل الضمائر] ${sliceLabel}: رجع ${map.size} من ${items.length} سطر في ${Date.now() - t0}ms.`);
  return map;
}

// يحلل الأسطر اللي فيها ضمائر فقط ويرجع Map: رقم السطر -> رمز الجنس
// بطلبات متوازية (طلب لكل مفتاح تقريباً) + جولة إعادة للناقص + مهلة كلية
async function getAnnotations(cues, keysArray, modelName, cacheKey, deadline, castHint) {
  const cache = getAnnotationCache(cacheKey);
  const tStart = Date.now();

  const eligibleItems = [];
  cues.forEach((c, i) => {
    if (!NEEDS_GENDER.test(c.text)) return;
    eligibleItems.push({ id: i, text: cleanForAnalysis(c.text) });
  });
  const eligible = eligibleItems.length;

  const alive = aliveKeyCount(keysArray);
  const conc = Math.max(1, Math.min(alive, ANNOTATION_MAX_CONCURRENCY));

  for (let pass = 1; pass <= ANNOTATION_PASSES; pass++) {
    const pending = eligibleItems.filter(it => !cache.has(it.id));

    if (pending.length === 0) break;
    if (pending.length <= eligible * (1 - ANNOTATION_MIN_COVERAGE)) {
      console.log(`[تحليل الضمائر] التغطية كافية (باقي ${pending.length} من ${eligible}), أكتفي بالموجود.`);
      break;
    }
    if (deadline - Date.now() <= 3000) {
      console.log(`[تحليل الضمائر] انتهت الميزانية الزمنية (${ANNOTATION_BUDGET_MS}ms)، أكمل بما تحلل.`);
      break;
    }

    // نقسم على قد عدد المفاتيح الحية، لكن ما ننزل عن أقل حجم يحفظ السياق ولا نتعدى الأقصى
    const perSlice = Math.min(ANNOTATION_SLICE_SIZE, Math.max(ANNOTATION_MIN_SLICE, Math.ceil(pending.length / conc)));
    const slices = [];
    for (let i = 0; i < pending.length; i += perSlice) slices.push(pending.slice(i, i + perSlice));

    console.log(`[تحليل الضمائر] جولة ${pass}/${ANNOTATION_PASSES}: ${pending.length} سطر مؤهل (من ${eligible}) → ${slices.length} طلب بالتوازي (تزامن ${Math.min(conc, slices.length)}، مفاتيح حية ${alive}).`);

    const tasks = slices.map((slice, si) => async () => {
      const map = await annotateSlice(slice, keysArray, modelName, deadline, castHint, `جولة ${pass} شريحة ${si + 1}/${slices.length}`);
      const wanted = new Set(slice.map(it => it.id));
      for (const [id, code] of map) if (wanted.has(id)) cache.set(id, code);
    });
    await runConcurrentPool(tasks, conc);
  }

  // إحصائيات للمراجعة في اللوغ
  const dist = new Map();
  let covered = 0;
  for (const it of eligibleItems) {
    const code = cache.get(it.id);
    if (!code) continue;
    covered++;
    dist.set(code, (dist.get(code) || 0) + 1);
  }
  const distStr = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`[تحليل الضمائر] النتيجة: ${covered}/${eligible} سطر محلل في ${Date.now() - tStart}ms | التوزيع: ${distStr || 'لا شيء'}`);

  // عينة موزعة على الفلم كله للمراجعة اليدوية
  const sampled = eligibleItems.filter(it => cache.has(it.id));
  if (sampled.length > 0) {
    const step = Math.max(1, Math.floor(sampled.length / 6));
    const lines = [];
    for (let i = 0; i < sampled.length && lines.length < 6; i += step) {
      const it = sampled[i];
      lines.push(`#${it.id} "${it.text.slice(0, 45)}" -> ${cache.get(it.id)}`);
    }
    console.log(`[تحليل الضمائر] عينة للمراجعة: ${lines.join(' | ')}`);
  }
  return cache;
}

// يترجم الأسطر اللي ناقصة فقط، ويرجع { texts, missing }
// texts بنفس ترتيب الأسطر الأصلية بالضبط، وmissing = عدد الأسطر اللي بقت بدون ترجمة
async function translateAllCues(cues, keysArray, modelName, concurrency, cacheKey, imdbId, anilistId) {
  const tStart = Date.now();
  const CHUNK = getDynamicChunkSize(modelName);
  const cache = getLineCache(cacheKey);

  const results = new Array(cues.length).fill(null); // رقم السطر -> الترجمة
  const toDo = [];
  let fromCache = 0;
  cues.forEach((c, i) => {
    if (!needsTranslation(c.text)) { results[i] = c.text; return; }
    if (cache.has(i)) { results[i] = cache.get(i); fromCache++; return; }
    toDo.push({ id: i, text: prepCueText(c.text) });
  });
  if (fromCache > 0) console.log(`[كاش الأسطر] ${fromCache} سطر جاهز من قبل، أترجم الباقي (${toDo.length}) فقط.`);

  // 1) مصدر الأجناس: AniList (للأنمي) -> TMDB
  let cast = { hint: '', hasGender: false, source: 'none' };
  if (toDo.length > 0) cast = await resolveCastInfo(imdbId, anilistId);
  const castHint = cast.hint;

  // 2) تحليل الضمائر: احتياطي أخير، فقط إذا المصادر ما أعطت أجناس موثوقة
  let annotationSummary = 'لم يُستخدم';
  if (toDo.length > 0) {
    if (cast.hasGender) {
      console.log(`[الجندر] ✅ ${cast.source} أعطى أجناس موثوقة، تحليل الضمائر غير مطلوب.`);
      annotationSummary = `غير مطلوب (المصدر ${cast.source})`;
    } else if (!ENABLE_GENDER_ANALYSIS) {
      console.log('[الجندر] المصادر ما أعطت أجناس، وتحليل الضمائر موقوف (ENABLE_GENDER_ANALYSIS=false).');
      annotationSummary = 'موقوف';
    } else {
      console.log(`[الجندر] المصادر ما أعطت أجناس موثوقة (المصدر: ${cast.source})، أشغّل تحليل الضمائر كاحتياطي...`);
      try {
        const tA = Date.now();
        const deadline = Date.now() + ANNOTATION_BUDGET_MS;
        const annotations = await getAnnotations(cues, keysArray, modelName, cacheKey, deadline, castHint);
        let attached = 0;
        for (const it of toDo) {
          const g = annotations.get(it.id);
          if (g && /[MFG]/.test(g)) { it.g = g; attached++; }
        }
        annotationSummary = `أُرفق بـ ${attached} من ${toDo.length} سطر (${Date.now() - tA}ms)`;
        console.log(`[تحليل الضمائر] أرفقت معلومة الجنس بـ ${attached} من ${toDo.length} سطر.`);
      } catch (e) {
        annotationSummary = `فشل (${e.message})`;
        console.log(`[تحليل الضمائر] فشل (${e.message})، أكمل الترجمة بدونه.`);
      }
    }
  }

  // 3) الترجمة نفسها
  const tTrans = Date.now();
  let pendingChunks = [];
  for (let i = 0; i < toDo.length; i += CHUNK) pendingChunks.push(toDo.slice(i, i + CHUNK));

  for (let pass = 0; pass <= MAX_RETRY_PASSES && pendingChunks.length > 0; pass++) {
    if (pass > 0) {
      const left = pendingChunks.reduce((n, ch) => n + ch.length, 0);
      if (keysArray.every(k => deadKeys.has(k))) {
        console.log('[توقف] كل المفاتيح ميتة، ما فايدة من إعادة المحاولة.');
        break;
      }
      console.log(`[جولة إعادة ${pass}/${MAX_RETRY_PASSES} 🔁] باقي ${left} سطر انتجاوزوا بسبب الخنق. راحة ثم أعيدهم...`);
      await delay(5000 + Math.random() * 3000);
    }

    const tasks = pendingChunks.map(chunk => async () => {
      const map = await translateItemsWithRecovery(chunk, keysArray, modelName, castHint);
      for (const [id, text] of map) {
        results[id] = text;
        cache.set(id, text);
      }
    });

    // بالجولات الإضافية نخفف الضغط: دفعتين بنفس الوقت بالأكثر
    await runConcurrentPool(tasks, pass === 0 ? concurrency : Math.min(2, concurrency));

    pendingChunks = pendingChunks
      .map(ch => ch.filter(it => results[it.id] == null))
      .filter(ch => ch.length > 0);
  }

  const missing = results.filter(r => r == null).length;
  if (missing > 0) {
    console.log(`[تنبيه] ${missing} سطر بقوا بنصهم الأصلي بعد كل المحاولات (محفوظ الباقي بالكاش).`);
  }

  console.log(`[ملخص] أسطر=${cues.length} | للترجمة=${toDo.length} | ناقص=${missing} | مصدر الأجناس=${cast.source} (hasGender=${cast.hasGender}) | تحليل الضمائر: ${annotationSummary} | زمن الترجمة=${Date.now() - tTrans}ms | الكلي=${Date.now() - tStart}ms`);

  return {
    texts: cues.map((c, i) => normalizeLineBreakArtifacts(results[i] || c.text)),
    missing
  };
}

// ترجع { content, missing, total, failed }
// failed = true يعني فشل تحميل الملف الأصلي أو استخراج النص (ما تنحفظ كترجمة جاهزة)
// imdbId اختياري (مثل tt0421384 أو tt0421384:1:1) - anilistId اختياري (للأنمي)
async function handleTranslationSrtDetailed(subUrl, keysArray, modelName, imdbId, anilistId) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة الأصلي.\n\n", missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي.');
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n", missing: 0, total: 0, failed: true };
  }

  console.log(`[Nuvio] ${cues.length} cues -> CHUNK=${getDynamicChunkSize(modelName)} | Model=${normalizeGeminiModelId(modelName)} | imdb=${imdbId || '-'} | anilist=${anilistId || '-'} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)})`);

  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 5, subUrl, imdbId, anilistId);

  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    let text = finalTranslations[idx];
    if (!text) return;
    if (text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    let sTime = c.start.replace('.', ','), eTime = c.end.replace('.', ',');
    if (sTime.length === 10) sTime = '0' + sTime;
    if (eTime.length === 10) eTime = '0' + eTime;
    if (sTime.split(',')[1].length === 2) sTime += '0';
    if (eTime.split(',')[1].length === 2) eTime += '0';
    srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
    counter++;
  });
  return { content: srtOutput, missing, total: cues.length, failed: false };
}

async function handleTranslationAssDetailed(subUrl, keysArray, modelName, imdbId, anilistId) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) {
    console.log(`[Nuvio] فشل تحميل ملف الترجمة الأصلي (ASS): ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف.`, missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) {
    console.log('[Nuvio] فشل استخراج الأسطر من الملف الأصلي (ASS).');
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };
  }

  console.log(`[Nuvio-ASS] ${cues.length} cues | Model=${normalizeGeminiModelId(modelName)} | imdb=${imdbId || '-'} | anilist=${anilistId || '-'} | مفاتيح=${keysArray.length} (حية ${aliveKeyCount(keysArray)})`);

  const { texts: finalTranslations, missing } = await translateAllCues(cues, keysArray, modelName, 8, subUrl, imdbId, anilistId);

  const assLines = [];
  cues.forEach((c, idx) => {
    let text = finalTranslations[idx];
    if (!text) return;
    if (text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${text.trim().replace(/\n/g, '\\N')}`);
  });
  return { content: ASS_DEFAULT_HEADER + assLines.join('\n') + '\n', missing, total: cues.length, failed: false };
}

// نسخ قديمة ترجع نص فقط (للتوافق)
async function handleTranslationSrt(subUrl, keysArray, modelName, imdbId, anilistId) {
  return (await handleTranslationSrtDetailed(subUrl, keysArray, modelName, imdbId, anilistId)).content;
}
async function handleTranslationAss(subUrl, keysArray, modelName, imdbId, anilistId) {
  return (await handleTranslationAssDetailed(subUrl, keysArray, modelName, imdbId, anilistId)).content;
}

module.exports = {
  handleTranslationSrt,
  handleTranslationAss,
  handleTranslationSrtDetailed,
  handleTranslationAssDetailed,
  normalizeLineBreakArtifacts,
  parseRobustJsonArray,
  parseIdTranslations,
  translateItemsWithRecovery,
  getCastHint,
  getAnilistCastHint,
  resolveCastInfo
};
