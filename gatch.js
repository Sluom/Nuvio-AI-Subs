'use strict';
// تجهيز دفعة حلقات من تيليغرام: /batch ثم عدد الحلقات (4/6/8/10) ثم رقم العمل ثم التراك.
// حلقة كل 5 دقائق من لحظة الأمر (أو فوراً إن كانت الحلقة جاهزة)، تتجاوز الحشو، وتتوقف بنهاية الموسم (ما تنتقل لموسم ثاني).
const axios = require('axios');
const manual = require('./tgmanual');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }
let filler = null;
try { filler = require('./filler'); } catch (e) { filler = null; }

const COUNTS = [4, 6, 8, 10];
const GAP_MS = 5 * 60 * 1000;
const READY_GAP_MS = 3000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const META_TTL_MS = 6 * 3600 * 1000;
const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

let pending = null;
let active = null;
const metaCache = new Map();

function takeCount() {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at < PENDING_TTL_MS ? p.n : 0;
}

async function askCount(chatId, tg) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: rtl('📦 تجهيز دفعة حلقات') + '\n' + rtl('اختر عدد الحلقات (تحسب الحلقة اللي تبدأ منها):'),
    reply_markup: { inline_keyboard: [COUNTS.map(n => ({ text: String(n), callback_data: 'bn:' + n })), [{ text: 'إلغاء', callback_data: 'bn:0' }]] }
  });
}

async function onCount(cq, tg) {
  const m = /^bn:(\d+)$/.exec(String(cq.data || ''));
  const n = m ? +m[1] : -1;
  const answer = text => tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const edit = text => (cq.message && cq.message.chat)
    ? tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text, disable_web_page_preview: true }).catch(() => {})
    : Promise.resolve();
  if (n === 0) { pending = null; await answer('تم الإلغاء'); await edit(rtl('تم إلغاء الدفعة.')); return; }
  if (!COUNTS.includes(n)) { await answer('خيار غير صالح'); return; }
  pending = { n, at: Date.now() };
  await answer('تمام: ' + n + ' حلقات');
  await edit([rtl('📦 دفعة: ' + n + ' حلقات'), rtl('الآن ابعث رقم العمل مع الموسم والحلقة اللي تبدأ منها، مثل:'), latin('tt0409591 1 5')].join('\n'));
}

async function getMeta(imdb) {
  const hit = metaCache.get(imdb);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.v;
  try {
    const res = await axios.get('https://v3-cinemeta.strem.io/meta/series/' + imdb + '.json', { timeout: 5000 });
    const videos = (res.data && res.data.meta && Array.isArray(res.data.meta.videos)) ? res.data.meta.videos : [];
    const all = new Map();
    const aired = new Map();
    const now = Date.now();
    for (const v of videos) {
      const s = parseInt(v.season, 10);
      const e = parseInt(v.episode != null ? v.episode : v.number, 10);
      if (!(s > 0) || !(e > 0)) continue;
      if (e > (all.get(s) || 0)) all.set(s, e);
      const t = v.released ? Date.parse(v.released) : NaN;
      if ((isNaN(t) || t <= now) && e > (aired.get(s) || 0)) aired.set(s, e);
    }
    const v = all.size ? { all, aired } : null;
    if (v) metaCache.set(imdb, { v, at: Date.now() });
    return v;
  } catch (e) {
    return null;
  }
}

async function leftInSeason(targetId) {
  const m = /^(tt\d+):(\d+):(\d+)$/.exec(String(targetId));
  if (!m) return Infinity;
  const meta = await getMeta(m[1]);
  if (!meta) return Infinity;
  let season = +m[2];
  let ep = +m[3];
  const size = s => meta.all.get(s) || 0;
  if (season === 1 && ep > size(1) && meta.all.size > 1) {
    let cum = 0;
    let found = false;
    for (const k of [...meta.all.keys()].sort((a, b) => a - b)) {
      if (ep <= cum + size(k)) { season = k; ep = ep - cum; found = true; break; }
      cum += size(k);
    }
    if (!found) return Infinity;
  }
  if (!meta.all.has(season) || ep > size(season)) return Infinity;
  return Math.max(0, (meta.aired.get(season) || 0) - ep);
}

async function nextOf(cur, left) {
  if (!(left >= 1)) return { end: 'انتهت حلقات الموسم المتوفرة' };
  const m = /^(tt\d+):(\d+):(\d+)$/.exec(String(cur));
  const season = +m[2];
  const ep = +m[3];
  let id = m[1] + ':' + season + ':' + (ep + 1);
  let consumed = 1;
  let skipped = 0;
  if (filler && filler.skipFillerAhead) {
    try {
      const sk = await filler.skipFillerAhead(cur, null, null);
      const sm = sk && sk.targetId ? /^(tt\d+):(\d+):(\d+)$/.exec(sk.targetId) : null;
      if (sm) {
        const delta = +sm[3] - ep;
        if (+sm[2] !== season || delta > left) return { end: 'باقي الموسم حشو، توقفت حتى ما أحرق مفاتيح' };
        id = sk.targetId;
        consumed = delta;
        skipped = sk.skipped || (delta - 1);
      }
    } catch (e) { /* لا شيء */ }
  }
  return { id, consumed, skipped };
}

function sleepFor(b, ms) {
  return new Promise(resolve => {
    b.wake = resolve;
    b.timer = setTimeout(resolve, Math.max(0, ms));
  }).finally(() => { b.wake = null; b.timer = null; });
}

async function epText(id) {
  try {
    const ep = notify && notify.describeEpisode ? await notify.describeEpisode(id) : null;
    if (ep && ep.text) return ep.text;
  } catch (e) { /* لا شيء */ }
  return id;
}

function render(b) {
  const out = [rtl('📦 دفعة تجهيز: ' + b.count + ' حلقات'), ...b.head.slice(0, 1), rtl('📄 التراك: ' + latin(b.ext.toUpperCase() + ' ' + b.track))];
  b.lines.forEach(l => out.push(rtl(l)));
  if (b.final) out.push(rtl(b.final));
  else if (b.nextAt) out.push(rtl('⏳ التالية بعد ' + Math.max(1, Math.round((b.nextAt - Date.now()) / 60000)) + ' دقيقة تقريباً (/stop للإيقاف)'));
  return out.join('\n');
}

function push(b) {
  if (!b.chat) return Promise.resolve();
  return b.tg('editMessageText', { chat_id: b.chat.id, message_id: b.messageId, text: render(b), disable_web_page_preview: true }).catch(() => {});
}

async function run(b) {
  let cur = b.targetId;
  let left = await leftInSeason(cur);
  let started = 0;
  try {
    while (started < b.count && !b.stopped) {
      let path = b.firstPath;
      if (started > 0) {
        const nx = await nextOf(cur, left);
        if (nx.end) { b.final = '🏁 ' + nx.end + ' (جهزت ' + started + ' من ' + b.count + ')'; break; }
        await sleepFor(b, b.nextAt - Date.now());
        if (b.stopped) break;
        const tracks = await manual.fetchTracks('series', nx.id).catch(() => null);
        const t = tracks && tracks.find(x => x.ext === b.ext && x.track === b.track);
        if (!t) { b.final = '⏹ توقفت: ما لقيت ' + b.ext.toUpperCase() + ' ' + b.track + ' بالحلقة ' + nx.id.split(':').slice(1).join(':') + ' (جهزت ' + started + ' من ' + b.count + ')'; break; }
        path = t.path;
        left -= nx.consumed;
        cur = nx.id;
        if (nx.skipped > 0) b.lines.push('⏭ تجاوزت ' + nx.skipped + ' حلقة حشو');
      }
      const res = await manual.startPath(path);
      const txt = await epText(cur);
      if (res === null) { b.final = '⏹ توقفت: تعذر بدء ' + txt + ' (جهزت ' + started + ' من ' + b.count + ')'; break; }
      started++;
      b.lines.push((res ? '⏳ ' : '✅ جاهزة أصلاً: ') + started + '. ' + txt);
      console.log('[دفعة] ' + started + '/' + b.count + ' ' + cur + (res ? ': بدأ التجهيز' : ': جاهزة أصلاً'));
      b.nextAt = Date.now() + (res ? GAP_MS : READY_GAP_MS);
      if (started >= b.count) break;
      await push(b);
    }
    if (!b.final && !b.stopped) b.final = '🏁 انتهت الدفعة: جهزت ' + started + ' من ' + b.count;
  } catch (e) {
    b.final = '⏹ توقفت بسبب خطأ (جهزت ' + started + ' من ' + b.count + ')';
    console.log('[دفعة] خطأ: ' + (e && e.message));
  }
  if (b.stopped) b.final = '⏹ تم الإيقاف (جهزت ' + started + ' من ' + b.count + ')، واللي بدأت تكمل بالخلفية.';
  b.nextAt = 0;
  if (active === b) active = null;
  await push(b);
}

async function start({ chat, messageId, tg, targetId, head, track, count }) {
  if (active) {
    if (chat) await tg('sendMessage', { chat_id: chat.id, text: rtl('في دفعة شغالة حالياً، اكتب /stop لإيقافها قبل ما تبدأ ثانية.') }).catch(() => {});
    return;
  }
  const b = { chat, messageId, tg, targetId, head, ext: track.ext, track: track.track, firstPath: track.path, count, lines: [], final: '', nextAt: 0, stopped: false, timer: null, wake: null };
  active = b;
  console.log('[دفعة] بدأت: ' + targetId + ' ' + b.ext.toUpperCase() + ' ' + b.track + ' × ' + count);
  run(b).catch(() => { if (active === b) active = null; });
}

async function stop(chatId, tg) {
  if (!active) { await tg('sendMessage', { chat_id: chatId, text: rtl('ما في دفعة شغالة.') }).catch(() => {}); return; }
  active.stopped = true;
  if (active.timer) clearTimeout(active.timer);
  if (active.wake) active.wake();
  await tg('sendMessage', { chat_id: chatId, text: rtl('⏹ جاري إيقاف الدفعة...') }).catch(() => {});
}

module.exports = { askCount, onCount, takeCount, start, stop, _t: { leftInSeason, nextOf, getMeta, isActive: () => !!active } };
