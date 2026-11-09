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

async function sendOne(text) {
  try {
    await axios.post(
      'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage',
      { chat_id: TG_CHAT, text: String(text).slice(0, 3500), disable_web_page_preview: true },
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
      const text = queue.shift();
      lastSentAt = Date.now();
      await sendOne(text);
    }
  } finally {
    pumping = false;
  }
}

function enqueue(text) {
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
    queue.push(text);
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

async function report(ev) {
  let ep;
  try { ep = await describeEpisode(ev.targetId); } catch (e) { ep = null; }
  if (!ep) ep = { text: String(ev.targetId || ''), alt: null };

  const head = (KIND[ev.label] || ev.label) + ' تراك ' + ev.trackNum;
  const why = ev.isPrefetch ? 'تجهيز تلقائي للحلقة التالية' : 'بضغطة منك';
  const src = siteOfUrl(ev.url);
  const secs = Math.max(0, Math.round((ev.ms || 0) / 1000)) + ' ثانية';
  let line = '';
  let warn = false;

  if (ev.kind === 'done') {
    line = head + ' | ' + ep.text + ' | ' + src + ' | ' + secs + ' | ' + (ev.total || 0) + ' سطر'
      + (ev.rejected > 0 ? ' | ' + ev.rejected + ' مرفوض' : '')
      + (ev.healed ? ' | ملف بديل (الأصلي فشل)' : '')
      + ' | ' + why;
  } else if (ev.kind === 'partial') {
    warn = true;
    line = head + ' | ' + ep.text + ' | ' + src + ' | اكتمل جزئيا: ناقص ' + ev.missing + ' من ' + ev.total + ' سطر بعد ' + (ev.rounds || '?') + ' جولات | ' + why;
  } else if (ev.kind === 'failed') {
    warn = true;
    line = 'فشل ' + head + ' | ' + ep.text + ' | ' + src + ' | الملف الأصلي لم يُحمَّل أو لم يُستخرج'
      + (ev.healTried ? ' (وجرّبت بديلا فلم أنجح)' : '')
      + ' | ستُعاد المحاولة عند الضغطة القادمة | ' + why;
  } else {
    warn = true;
    line = 'خطأ غير متوقع في ' + head + ' | ' + ep.text + ' | ' + scrub(ev.error).slice(0, 150) + ' | ' + why;
  }

  // تنبيه التكرار: نفس الحلقة ونفس التراك محفوظان أيضا تحت الاسم الآخر (الموسم/المطلق)
  let dupLine = '';
  if (ev.kind === 'done' && ep.alt && typeof ev.loadDoc === 'function' && ev.cacheKey && ev.cacheKey.includes('_' + ev.targetId + '_track')) {
    try {
      const altKey = ev.cacheKey.replace('_' + ev.targetId + '_track', '_' + ep.alt.id + '_track');
      const other = await ev.loadDoc(altKey);
      if (other && other.content) {
        warn = true;
        dupLine = 'نفس الحلقة محفوظة أيضا باسم (' + ep.alt.text + ') لنفس التراك ⟵ صُحّحت مرتين بسبب اختلاف الاسم.';
      }
    } catch (e) { /* لا شيء */ }
  }

  const text = RLM + (warn ? '⚠️ ' : '✅ ') + line + (dupLine ? '\n' + RLM + '⚠️ ' + dupLine : '');
  console.log('[ملخص التراك] ' + text.replace(/‏/g, ''));
  enqueue(text);
}

// الواجهة الوحيدة: ترجع فورا ولا ترمي خطأ أبدا
function trackEvent(ev) {
  try {
    report(ev).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

if (ENABLED) {
  console.log('[إشعار] تيليغرام مفعّل ⟵ يصلك ملخص كل تراك يُصحَّح وتنبيهات المشاكل.');
  const t = setTimeout(() => enqueue(RLM + '🟢 Nuvio AI اشتغل (أو أُعيد تشغيله). إشعارات التصحيح مفعّلة.'), 8000);
  if (t && t.unref) t.unref();
} else {
  console.log('[إشعار] تيليغرام غير مفعّل (أحد المتغيرين غير موجود) ⟵ أكتفي بسطر الملخص في اللوغ.');
}

module.exports = { trackEvent, enabled: ENABLED, describeEpisode, siteOfUrl };
