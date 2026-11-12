// إشعارات التصحيح: سطر ملخص في اللوغ لكل تراك مصحح، ونفس السطر يُرسل إلى تيليغرام إن وُجد المتغيران
// TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID. كل شيء هنا محمي: أي فشل يُبلع بصمت ولا يؤثر على الإضافة.
const axios = require('axios');

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const ENABLED = !!(TG_TOKEN && TG_CHAT);

const SEND_GAP_MS = 1200;
const MAX_QUEUE = 30;
const SAME_TEXT_GAP_MS = 60 * 1000;
const ERR_LOG_GAP_MS = 10 * 60 * 1000;
const CINEMETA_TTL_MS = 6 * 3600 * 1000;
const CINEMETA_MAX = 100;
const RLM = '‏';
const KIND = { 'ARA-ASS': 'ASS', 'ARA-SRT': 'SRT' };

const queue = [];
const recentTexts = new Map();
const metaCache = new Map();
const nameCache = new Map();
let pumping = false;
let lastSentAt = 0;
let lastErrLogAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// لا يظهر الرمز أبدا في أي سطر لوغ
function scrub(s) {
  let out = String(s == null ? '' : s);
  if (TG_TOKEN) out = out.split(TG_TOKEN).join('***');
  return out;
}

async function sendOne(text, markup) {
  try {
    await axios.post(
      'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage',
      { chat_id: TG_CHAT, text: String(text).slice(0, 3500), disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) },
      { timeout: 8000 }
    );
  } catch (e) {
    const now = Date.now();
    if (now - lastErrLogAt < ERR_LOG_GAP_MS) return;
    lastErrLogAt = now;
    const status = e && e.response && e.response.status;
    const desc = e && e.response && e.response.data && e.response.data.description;
    let hint = '';
    if (status === 401) hint = ' | الرمز غير صحيح';
    else if (status === 400 || status === 403) hint = ' | تأكد أنك ضغطت Start عند بوتك وأن رقم المحادثة صحيح';
    console.log('[إشعار] تعذر إرسال رسالة تيليغرام' + (status ? ' (HTTP ' + status + ')' : '') + ': ' + scrub(desc || (e && e.message)) + hint + ' ⟵ عمل الإضافة لم يتأثر.');
  }
}

// رسالة وحدة كل ثانية وزيادة (حد تيليغرام للمحادثة الواحدة) مهما تتابعت الأحداث
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const wait = SEND_GAP_MS - (Date.now() - lastSentAt);
      if (wait > 0) await sleep(wait);
      const item = queue.shift();
      lastSentAt = Date.now();
      await sendOne(typeof item === 'string' ? item : item.text, typeof item === 'string' ? null : item.markup);
    }
  } finally {
    pumping = false;
  }
}

function enqueue(text, markup) {
  if (!ENABLED) return;
  try {
    const now = Date.now();
    const last = recentTexts.get(text);
    if (last && now - last < SAME_TEXT_GAP_MS) return;
    recentTexts.set(text, now);
    if (recentTexts.size > 200) {
      for (const [k, t] of recentTexts) if (now - t > SAME_TEXT_GAP_MS) recentTexts.delete(k);
      if (recentTexts.size > 200) recentTexts.clear();
    }
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(markup ? { text, markup } : text);
    pump().catch(() => {});
  } catch (e) { /* لا شيء */ }
}

// أحجام المواسم من Cinemeta (عدد الحلقات بكل موسم) لحساب الرقم المطلق والاسم البديل للحلقة
async function getSeasonSizes(imdbId) {
  const hit = metaCache.get(imdbId);
  if (hit && Date.now() - hit.at < CINEMETA_TTL_MS) return hit.sizes;
  let sizes = null;
  try {
    const res = await axios.get('https://v3-cinemeta.strem.io/meta/series/' + imdbId + '.json', { timeout: 4000 });
    const videos = (res.data && res.data.meta && Array.isArray(res.data.meta.videos)) ? res.data.meta.videos : [];
    rememberName('series:' + imdbId, res.data && res.data.meta && res.data.meta.name);
    const m = new Map();
    for (const v of videos) {
      const s = parseInt(v.season, 10);
      if (!isNaN(s) && s > 0) m.set(s, (m.get(s) || 0) + 1);
    }
    if (m.size) sizes = m;
  } catch (e) {
    sizes = null;
  }
  if (sizes) {
    if (metaCache.size >= CINEMETA_MAX) {
      const oldest = metaCache.keys().next().value;
      if (oldest) metaCache.delete(oldest);
    }
    metaCache.set(imdbId, { sizes, at: Date.now() });
  }
  return sizes;
}

function rememberName(key, name) {
  const n = String(name || '').trim();
  if (!n) return;
  if (nameCache.size >= CINEMETA_MAX) {
    const oldest = nameCache.keys().next().value;
    if (oldest) nameCache.delete(oldest);
  }
  nameCache.set(key, { name: n, at: Date.now() });
}

// اسم العمل (مسلسل أو فيلم) من Cinemeta. لا يرمي خطأ أبدا؛ يرجع null إن لم يوجد
async function titleOf(id, type) {
  try {
    const m = /^(tt\d+)/.exec(String(id || ''));
    if (!m) return null;
    const kind = type === 'movie' ? 'movie' : 'series';
    const key = kind + ':' + m[1];
    const hit = nameCache.get(key);
    if (hit && Date.now() - hit.at < CINEMETA_TTL_MS) return hit.name;
    const res = await axios.get('https://v3-cinemeta.strem.io/meta/' + kind + '/' + m[1] + '.json', { timeout: 2500 });
    const name = res && res.data && res.data.meta && res.data.meta.name;
    rememberName(key, name);
    return name ? String(name).trim() : null;
  } catch (e) {
    return null;
  }
}

// وصف الحلقة بكلام مقروء + الاسم البديل لنفس الحلقة (ترقيم المواسم <-> الترقيم المطلق) إن أمكن
async function describeEpisode(targetId) {
  const id = String(targetId || '');
  let m = /^(tt\d+):(\d+):(\d+)$/.exec(id);
  if (m) {
    const imdb = m[1];
    const s = parseInt(m[2], 10);
    const e = parseInt(m[3], 10);
    const base = 'الموسم ' + s + ' الحلقة ' + e;
    const sizes = await getSeasonSizes(imdb);
    if (!sizes) return { text: base, alt: null };
    if (s > 1) {
      let before = 0;
      for (const [k, n] of sizes) if (k < s) before += n;
      if (before > 0) {
        const abs = before + e;
        return { text: base + ' (= ' + abs + ')', alt: { id: imdb + ':1:' + abs, text: 'الحلقة ' + abs } };
      }
    } else if (s === 1) {
      const n1 = sizes.get(1) || 0;
      if (n1 && e > n1) {
        let cum = 0;
        for (const k of [...sizes.keys()].sort((a, b) => a - b)) {
          const n = sizes.get(k);
          if (e <= cum + n) {
            const se = e - cum;
            return { text: 'الحلقة ' + e + ' (= الموسم ' + k + ' الحلقة ' + se + ')', alt: { id: imdb + ':' + k + ':' + se, text: 'الموسم ' + k + ' الحلقة ' + se } };
          }
          cum += n;
        }
      }
    }
    return { text: base, alt: null };
  }
  m = /^kitsu:(\d+):(\d+)$/.exec(id);
  if (m) return { text: 'الحلقة ' + m[2] + ' (kitsu ' + m[1] + ')', alt: null };
  if (/^tt\d+$/.test(id)) return { text: 'فيلم ' + id, alt: null };
  return { text: id || '؟', alt: null };
}

// اسم الموقع + معرّف الحزمة من رابط التراك (بدون أي مفاتيح)
function siteOfUrl(url) {
  const u = String(url || '');
  let host = '';
  let path = '';
  try {
    const p = new URL(u);
    host = p.hostname.toLowerCase();
    path = p.pathname;
  } catch (e) {
    host = u.toLowerCase().slice(0, 30);
  }
  const site = host.includes('subsource') ? 'subsource'
    : host.includes('subdl') ? 'subdl'
    : host.includes('opensubtitles') ? 'opensubtitles'
    : host.includes('wyzie') ? 'wyzie'
    : (host || 'مصدر');
  let pack = '';
  const segs = path.split('/').filter(Boolean);
  if (segs.length) {
    let last = segs[segs.length - 1].toLowerCase();
    if (last === 'download' && segs.length > 1) last = segs[segs.length - 2];
    last = last.replace(/\.(zip|srt|ass|ssa|gz|rar|7z)$/i, '');
    pack = last.slice(0, 24);
  }
  return site + (pack ? ' ' + pack : '');
}

const LRI = '⁦';
const PDI = '⁩';
// سطر كامل يُقرأ من اليمين لليسار؛ الأجزاء اللاتينية (اسم، رقم، ASS) تُعزل حتى لا تنقلب
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

// الثواني بالعربي الصحيح: ثانية، ثانيتان، 3 ثوانٍ، 12 ثانية، دقيقة و12 ثانية
function arSeconds(n) {
  const x = Math.max(0, Math.round(Number(n) || 0));
  const secWord = k => (k === 1 ? 'ثانية واحدة' : k === 2 ? 'ثانيتان' : k <= 10 ? k + ' ثوانٍ' : k + ' ثانية');
  const minWord = k => (k === 1 ? 'دقيقة' : k === 2 ? 'دقيقتان' : k <= 10 ? k + ' دقائق' : k + ' دقيقة');
  if (x === 0) return 'أقل من ثانية';
  if (x < 60) return secWord(x);
  const m = Math.floor(x / 60);
  const sec = x % 60;
  return minWord(m) + (sec ? ' و' + secWord(sec) : '');
}

function spellDetail(spell) {
  if (!Array.isArray(spell) || !spell.length) return [];
  const MAX = 15;
  const items = spell.slice(0, MAX).map(([k, n]) => String(k).replace(' → ', ' ← ') + (n > 1 ? ' ×' + n : ''));
  const rest = spell.length - MAX;
  return [
    '📝 الإملاء: ' + spell.length + ' تحويل مختلف',
    items.join(' | ') + (rest > 0 ? ' | +' + rest + ' أخرى (الباقي في لوغ ريندر)' : '')
  ];
}

async function report(ev) {
  statTrack(ev);
  let ep;
  try { ep = await describeEpisode(ev.targetId); } catch (e) { ep = null; }
  if (!ep) ep = { text: String(ev.targetId || ''), alt: null };

  // اسم العمل (لا يرمي خطأ أبدا)
  const idStr = String(ev.targetId || '');
  const isMovie = /^tt\d+$/.test(idStr);
  let title = null;
  try { title = await titleOf(ev.targetId, isMovie ? 'movie' : 'series'); } catch (e) { title = null; }
  const ttMatch = /^(tt\d+)/.exec(idStr);
  const workId = ttMatch ? ttMatch[1] : idStr;

  const kindName = KIND[ev.label] || ev.label;
  const head = kindName + ' تراك ' + ev.trackNum;
  const why = ev.isPrefetch ? 'تجهيز تلقائي للحلقة التالية' : 'بضغطة منك';
  const src = siteOfUrl(ev.url);
  const secs = Math.max(0, Math.round((ev.ms || 0) / 1000));
  let line = '';
  let warn = false;
  let badge = '✅';
  let title1 = '';
  let detail = [];
  let retryKinds = null;

  // رأس الرسالة بتيليغرام: "تراك 1 ASS" بترتيب يُقرأ صح من اليمين لليسار
  const tgHead = 'تراك ' + ev.trackNum + ' ' + latin(kindName);

  if (ev.kind === 'done') {
    line = head + ' | ' + ep.text + ' | ' + src + ' | ' + secs + ' ثانية | ' + (ev.total || 0) + ' سطر'
      + (ev.rejected > 0 ? ' | ' + ev.rejected + ' مرفوض' : '')
      + (ev.healed ? ' | ملف بديل (الأصلي فشل)' : '')
      + ' | ' + why;
    title1 = 'اكتمل: ' + tgHead;
    detail = ['work', 'ep', 'src',
      '📄 الأسطر: ' + (ev.total || 0) + (ev.rejected > 0 ? ' — مرفوض: ' + ev.rejected : ''),
      '⏱ الوقت: ' + arSeconds(secs), ...spellDetail(ev.spell)];
    if (ev.healed) detail.push('🔁 ملف بديل (الأصلي فشل)');
    detail.push('🔔 ' + why);
  } else if (ev.kind === 'partial') {
    warn = true; badge = '⚠️';
    line = head + ' | ' + ep.text + ' | ' + src + ' | اكتمل جزئيا: ناقص ' + ev.missing + ' من ' + ev.total + ' سطر بعد ' + (ev.rounds || '?') + ' جولات | ' + why;
    const fi = ev.failInfo;
    const allFailed = !!(fi && fi.all);
    title1 = (allFailed ? 'فشل كلي: ' : 'اكتمل جزئياً: ') + tgHead;
    detail = ['src', 'work', 'ep', '📄 ناقص ' + ev.missing + ' من ' + ev.total + ' سطر بعد ' + (ev.rounds || '?') + ' جولات', ...spellDetail(ev.spell)];
    if (fi && Array.isArray(fi.ranges) && fi.ranges.length) {
      detail.push('🧩 الأسطر الناقصة: ' + fi.ranges.slice(0, 6).map(r => latin(r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1])).join('، ') + (fi.ranges.length > 6 ? ' ...' : ''));
      if (fi.totalChunks > 1 && Array.isArray(fi.chunks)) detail.push('🔹 القطع: ' + fi.chunks.slice(0, 8).join(' و') + ' من ' + fi.totalChunks);
    }
    detail.push('🔔 ' + why);
    retryKinds = allFailed ? ['z'] : ['m', 'z'];
  } else if (ev.kind === 'failed') {
    warn = true; badge = '❌';
    line = 'فشل ' + head + ' | ' + ep.text + ' | ' + src + ' | الملف الأصلي لم يُحمَّل أو لم يُستخرج'
      + (ev.healTried ? ' (وجرّبت بديلا فلم أنجح)' : '')
      + ' | ستُعاد المحاولة عند الضغطة القادمة | ' + why;
    title1 = 'فشل: ' + tgHead;
    detail = ['src', 'work', 'ep',
      '💬 الملف الأصلي لم يُحمَّل أو لم يُستخرج' + (ev.healTried ? ' (وجرّبت بديلاً فلم أنجح)' : ''),
      '🔁 ستُعاد المحاولة عند الضغطة القادمة', '🔔 ' + why];
    retryKinds = ['z'];
  } else {
    warn = true; badge = '⚠️';
    const msg = scrub(ev.error).slice(0, 150);
    line = 'خطأ غير متوقع في ' + head + ' | ' + ep.text + ' | ' + msg + ' | ' + why;
    title1 = 'خطأ غير متوقع: ' + tgHead;
    detail = ['src', 'work', 'ep', '💬 ' + msg, '🔔 ' + why];
    retryKinds = ['z'];
  }

  // تنبيه التكرار: نفس الحلقة ونفس التراك محفوظان أيضا تحت الاسم الآخر (الموسم/المطلق)
  let dupText = '';
  if (ev.kind === 'done' && ep.alt && typeof ev.loadDoc === 'function' && ev.cacheKey && ev.cacheKey.includes('_' + ev.targetId + '_track')) {
    try {
      const altKey = ev.cacheKey.replace('_' + ev.targetId + '_track', '_' + ep.alt.id + '_track');
      const other = await ev.loadDoc(altKey);
      if (other && other.content) {
        warn = true; badge = '⚠️';
        dupText = 'نفس الحلقة محفوظة أيضا باسم (' + ep.alt.text + ') لنفس التراك ⟵ صُحّحت مرتين بسبب اختلاف الاسم.';
      }
    } catch (e) { /* لا شيء */ }
  }

  // سطر اللوغ (مضغوط كما كان) — بدون رموز اتجاه
  const epLog = title ? (isMovie ? 'فيلم ' + title : title + ' ' + ep.text) : ep.text;
  console.log('[ملخص التراك] ' + (warn ? '⚠️ ' : '✅ ') + line.replace(ep.text, epLog) + (dupText ? '\n⚠️ ' + dupText : ''));

  // رسالة تيليغرام: كل معلومة بسطر
  const workLine = '🎬 ' + latin((title ? title + ' (' + workId + ')' : workId));
  const epLine = isMovie ? null : '📺 ' + ep.text;
  const lines = [rtl(badge + ' ' + title1)];
  for (const d of detail) {
    if (d === 'src') {
      lines.push(rtl('📦 المصدر: ' + latin(src)));
    } else if (d === 'work') {
      lines.push(rtl(workLine));
    } else if (d === 'ep') {
      if (epLine) lines.push(rtl(epLine));
    } else {
      lines.push(rtl(d));
    }
  }
  if (dupText) {
    lines.push('');
    lines.push(rtl('⚠️ نفس الحلقة محفوظة باسمين'));
    lines.push(rtl('📺 ' + ep.text));
    lines.push(rtl('💬 صُحّحت مرتين بسبب اختلاف الاسم'));
  }
  let markup = null;
  const slot = ev.label === 'ARA-ASS' ? 'a' : ev.label === 'ARA-SRT' ? 's' : '';
  if (retryKinds && slot && ev.targetId && ev.trackNum && /^\d+$/.test(String(ev.trackNum))) {
    const cb = k => 'rt:' + k + ':' + slot + ':' + ev.trackNum + ':' + ev.targetId;
    const row = retryKinds.map(k => ({ text: k === 'm' ? '🔁 أكمل الناقص فقط' : (retryKinds.length === 1 ? '🔁 أعد المحاولة' : '🗑 من الصفر'), callback_data: cb(k) }));
    if (row.every(b => Buffer.byteLength(b.callback_data) <= 64)) markup = { inline_keyboard: [row] };
  }
  enqueue(lines.join('\n'), markup);
}

// أحداث الموديل (اختناق، تشغيل الاحتياطي...). للتيليغرام فقط، ولا يرمي خطأ أبدا.
const modelSeen = new Map();
const MODEL_EVENT_GAP_MS = 5 * 60 * 1000;
async function modelReport(ev) {
  if (!ENABLED) return;
  const kind = String(ev && ev.kind || '');
  statModel(kind);
  const key = [kind, ev.label, ev.targetId, ev.trackNum].join('|');
  const now = Date.now();
  const last = modelSeen.get(key);
  if (last && now - last < MODEL_EVENT_GAP_MS) return;
  modelSeen.set(key, now);
  if (modelSeen.size > 200) modelSeen.clear();

  let ep = null;
  try { ep = await describeEpisode(ev.targetId); } catch (e) { ep = null; }
  const idStr = String(ev.targetId || '');
  const isMovie = /^tt\d+$/.test(idStr);
  let title = null;
  try { title = await titleOf(ev.targetId, isMovie ? 'movie' : 'series'); } catch (e) { title = null; }
  const ttMatch = /^(tt\d+)/.exec(idStr);
  const workId = ttMatch ? ttMatch[1] : idStr;
  const m1 = ev.model ? latin(String(ev.model)) : '؟';
  const m2 = ev.other ? latin(String(ev.other)) : '؟';
  const trk = (KIND[ev.label] || ev.label || '') ? 'تراك ' + (ev.trackNum || '؟') + ' ' + latin(KIND[ev.label] || ev.label) : '';

  const out = [];
  if (kind === 'choke') {
    out.push('⚠️ اختناق الموديل');
    const f = ev.fails || 2;
    out.push('🧠 الموديل ' + m1 + ' فشل ' + (f === 2 ? 'مرتين' : f <= 10 ? f + ' مرات' : f + ' مرة') + ' على نفس الدفعة');
  } else if (kind === 'fallback-won') {
    out.push('✅ الاحتياطي ' + m1 + ' سبق وأنجز الدفعة');
  } else if (kind === 'both-failed') {
    out.push('❌ الموديلان ' + m1 + ' و' + m2 + ' فشلا');
  } else if (kind === 'rescue') {
    out.push('🚑 إنقاذ تلقائي');
    out.push('🧠 حوّلت الباقي من الموديل ' + m1 + ' إلى ' + m2);
  } else {
    return;
  }
  out.push('🎬 ' + latin(title ? title + ' (' + workId + ')' : workId));
  if (!isMovie && ep) out.push('📺 ' + ep.text + (trk ? ' — ' + trk : ''));
  else if (trk) out.push('📺 ' + trk);
  if (kind === 'choke') out.push('↪️ شغّلت الموديل ' + m2 + ' جنبه، والأسرع يفوز');
  if (kind === 'both-failed') out.push('🔁 ستُعاد المحاولة لاحقاً');
  enqueue(out.map(rtl).join('\n'));
}

function modelEvent(ev) {
  try { modelReport(ev || {}).catch(() => {}); } catch (e) { /* لا شيء */ }
}


const STATS_TZ_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const STATS_SAVE_DELAY_MS = 3000;
const SUMMARY_FIRST_CHECK_MS = 90 * 1000;
const SUMMARY_FIRE_DELAY_MS = 5000;
const STATS_MAX_EPS = 500;
const SOURCES_EVENT_GAP_MS = 3 * 60 * 1000;

const getDb = () => { try { return require('./db'); } catch (e) { return null; } };
const baghdadDay = (t = Date.now()) => new Date(t + STATS_TZ_MS).toISOString().slice(0, 10);
const emptyStats = day => ({ day, tracks: { ASS: 0, SRT: 0 }, eps: [], lines: 0, partial: 0, failed: 0, error: 0, src: {}, choke: 0, fbwon: 0, rescue: 0, bothFailed: 0 });

let statsPromise = null;
let statsPromiseDay = '';
let statsDirty = null;
let statsTimer = null;

function statsFor(day) {
  if (statsPromise && statsPromiseDay === day) return statsPromise;
  statsPromiseDay = day;
  statsPromise = (async () => {
    let data = null;
    try { const db = getDb(); data = db ? await db.loadDoc('dailystats', day) : null; } catch (e) { data = null; }
    const base = emptyStats(day);
    if (data && typeof data === 'object') {
      Object.assign(base, data, { tracks: Object.assign(base.tracks, data.tracks || {}), src: Object.assign({}, data.src || {}), eps: Array.isArray(data.eps) ? data.eps : [] });
    }
    return base;
  })();
  return statsPromise;
}

function flushStats() {
  statsTimer = null;
  const s = statsDirty;
  statsDirty = null;
  if (!s) return;
  try {
    const db = getDb();
    if (db) Promise.resolve(db.saveDoc('dailystats', s.day, s)).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

function statBump(fn) {
  if (!ENABLED) return;
  try {
    statsFor(baghdadDay()).then(s => {
      fn(s);
      if (statsDirty && statsDirty !== s) flushStats();
      statsDirty = s;
      if (!statsTimer) {
        statsTimer = setTimeout(flushStats, STATS_SAVE_DELAY_MS);
        if (statsTimer.unref) statsTimer.unref();
      }
    }).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

function statTrack(ev) {
  try {
    const kind = String(ev && ev.kind || '');
    statBump(s => {
      if (kind === 'done') {
        const k = ev.label === 'ARA-ASS' ? 'ASS' : 'SRT';
        s.tracks[k] = (s.tracks[k] || 0) + 1;
        s.lines += Number(ev.total) || 0;
        const id = String(ev.targetId || '');
        if (id && !s.eps.includes(id) && s.eps.length < STATS_MAX_EPS) s.eps.push(id);
        const name = siteOfUrl(ev.url).split(' ')[0] || 'مصدر';
        s.src[name] = (s.src[name] || 0) + 1;
      } else if (kind === 'partial') s.partial++;
      else if (kind === 'failed') s.failed++;
      else s.error++;
    });
  } catch (e) { /* لا شيء */ }
}

function statModel(kind) {
  const field = { choke: 'choke', 'fallback-won': 'fbwon', rescue: 'rescue', 'both-failed': 'bothFailed' }[kind];
  if (field) statBump(s => { s[field] = (s[field] || 0) + 1; });
}

function summaryText(s) {
  const done = (s.tracks.ASS || 0) + (s.tracks.SRT || 0);
  const [, mm, dd] = String(s.day).split('-');
  const lines = [rtl('📊 ملخص يوم ' + latin(dd + '/' + mm))];
  lines.push(rtl('🎞 الحلقات: ' + s.eps.length + ' | التراكات المكتملة: ' + done + ' (' + latin('ASS ' + (s.tracks.ASS || 0) + ' · SRT ' + (s.tracks.SRT || 0)) + ')'));
  lines.push(rtl('📄 الأسطر: ' + (s.lines || 0)));
  lines.push(rtl('⚠️ جزئي: ' + s.partial + ' | ❌ فشل: ' + s.failed + ' | 💥 خطأ: ' + s.error));
  if (s.choke || s.bothFailed) lines.push(rtl('🧠 اختناق الموديل: ' + s.choke + (s.bothFailed ? ' | فشل الموديلين: ' + s.bothFailed : '')));
  const top = Object.entries(s.src || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) lines.push(rtl('🏆 أكثر المصادر: ' + top.map(([n, c]) => latin(n) + ' (' + c + ')').join(' · ')));
  return lines.join('\n');
}

let lastSummaryDay = '';

async function sendDailySummary(day) {
  if (!ENABLED || !day || lastSummaryDay >= day) return;
  const db = getDb();
  let sent = null;
  try { sent = db ? await db.loadDoc('dailystats', '_sent') : null; } catch (e) { sent = null; }
  if (sent && sent.day && String(sent.day) >= day) { lastSummaryDay = String(sent.day); return; }
  let s = null;
  if (statsPromise && statsPromiseDay === day) s = await statsPromise;
  else {
    try { s = db ? await db.loadDoc('dailystats', day) : null; } catch (e) { s = null; }
  }
  lastSummaryDay = day;
  try { if (db) await db.saveDoc('dailystats', '_sent', { day }); } catch (e) { /* لا شيء */ }
  if (!s || typeof s !== 'object') return;
  s = Object.assign(emptyStats(day), s, { tracks: Object.assign({ ASS: 0, SRT: 0 }, s.tracks || {}), src: s.src || {}, eps: Array.isArray(s.eps) ? s.eps : [] });
  const total = (s.tracks.ASS || 0) + (s.tracks.SRT || 0) + s.partial + s.failed + s.error + (s.choke || 0);
  if (!total) return;
  enqueue(summaryText(s));
}

function msToNextBaghdadMidnight() {
  const local = Date.now() + STATS_TZ_MS;
  return (Math.floor(local / DAY_MS) + 1) * DAY_MS - local;
}

function startDailySummary() {
  if (!ENABLED) return;
  const arm = () => {
    const t = setTimeout(() => {
      sendDailySummary(baghdadDay(Date.now() - 3600 * 1000)).catch(() => {}).finally(arm);
    }, msToNextBaghdadMidnight() + SUMMARY_FIRE_DELAY_MS);
    if (t.unref) t.unref();
  };
  const first = setTimeout(() => { sendDailySummary(baghdadDay(Date.now() - DAY_MS)).catch(() => {}); }, SUMMARY_FIRST_CHECK_MS);
  if (first.unref) first.unref();
  arm();
}

const sourcesSeen = new Map();

async function sourcesReport(ev) {
  if (!ENABLED || !ev || !/^tt\d+$/.test(String(ev.imdbId || ''))) return;
  const isSeries = ev.season != null && ev.episode != null;
  const targetId = isSeries ? ev.imdbId + ':' + ev.season + ':' + ev.episode : ev.imdbId;
  const now = Date.now();
  const last = sourcesSeen.get(targetId);
  if (last && now - last < SOURCES_EVENT_GAP_MS) return;
  sourcesSeen.set(targetId, now);
  if (sourcesSeen.size > 200) sourcesSeen.clear();
  let ep = null;
  try { ep = await describeEpisode(targetId); } catch (e) { ep = null; }
  let title = null;
  try { title = await titleOf(targetId, isSeries ? 'series' : 'movie'); } catch (e) { title = null; }
  const wyzieText = ev.wyzieState === 'off' ? 'غير مفعّل' : ev.wyzieState === 'paused' ? 'متوقف مؤقتاً' : ev.wyzie > 0 ? latin(ev.wyzie + ' ASS') : 'ما لقى';
  const orgText = ev.org > 0 ? latin(ev.org + (ev.orgAss > 0 ? ' (' + ev.orgAss + ' ASS)' : '')) : 'ما لقى';
  const out = [rtl('📡 مصادر الأنمي' + (ev.isPrefetch ? ' (تجهيز تلقائي)' : ''))];
  out.push(rtl('🎬 ' + latin(title ? title + ' (' + ev.imdbId + ')' : ev.imdbId)));
  if (isSeries && ep) out.push(rtl('📺 ' + ep.text));
  out.push(rtl('🔹 ' + latin('Wyzie') + ': ' + wyzieText));
  out.push(rtl('🔹 ' + latin('org') + ': ' + orgText));
  enqueue(out.join('\n'));
}

function sourcesEvent(ev) {
  try { sourcesReport(ev).catch(() => {}); } catch (e) { /* لا شيء */ }
}

// الواجهة الوحيدة: ترجع فورا ولا ترمي خطأ أبدا
function trackEvent(ev) {
  try {
    report(ev).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

if (ENABLED) {
  console.log('[إشعار] تيليغرام مفعّل ⟵ يصلك ملخص كل تراك يُصحَّح وتنبيهات المشاكل.');
  const t = setTimeout(() => enqueue(rtl('🟢 ' + latin('Nuvio AI') + ' اشتغل') + '\n' + rtl('🔔 إشعارات التصحيح مفعّلة')), 8000);
  if (t && t.unref) t.unref();
  startDailySummary();
} else {
  console.log('[إشعار] تيليغرام غير مفعّل (أحد المتغيرين غير موجود) ⟵ أكتفي بسطر الملخص في اللوغ.');
}

module.exports = { trackEvent, modelEvent, sourcesEvent, enabled: ENABLED, describeEpisode, siteOfUrl, titleOf, arSeconds, _t: { sendDailySummary, summaryText, baghdadDay, msToNextBaghdadMidnight } };
