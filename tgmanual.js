'use strict';
// طلب ترجمة يدوي من تيليغرام: تبعث رقم العمل (tt...) فيرد باسمه للتأكد، ويعرض تراكات SRT وASS الموجودة،
// وضغطة على تراك تبدأ تجهيزه مثل الضغط الطبيعي من Nuvio. الإعدادات (المفاتيح) تنحفظ بالذاكرة فقط من آخر طلب حقيقي.
const crypto = require('crypto');
const axios = require('axios');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }

const PORT = process.env.PORT || 7000;
const LIST_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 20000;
const MAX_REQS = 100;
const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

let ctx = null;
const reqs = new Map();

function noteContext(req) {
  try {
    const raw = req && req.params && req.params.config;
    if (!raw) return;
    ctx = {
      rawConfig: String(raw),
      host: (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '',
      proto: (req.headers && req.headers['x-forwarded-proto']) || 'https'
    };
  } catch (e) { /* لا شيء */ }
}

function parse(text) {
  const m = /^(tt\d{5,10})(?:\s*[:\s]\s*(\d{1,3})\s*[:\s]\s*(\d{1,4}))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const imdb = m[1].toLowerCase();
  return m[2] ? { imdb, season: +m[2], episode: +m[3], targetId: imdb + ':' + +m[2] + ':' + +m[3] } : { imdb, targetId: imdb };
}

async function fetchTracks(type, targetId) {
  const path = (ctx.rawConfig ? '/' + encodeURIComponent(ctx.rawConfig) : '')
    + '/subtitles/' + type + '/' + encodeURIComponent(targetId).replace(/%3A/gi, ':') + '.json';
  const r = await axios.get('http://127.0.0.1:' + PORT + path, {
    headers: { 'x-forwarded-host': ctx.host || ('127.0.0.1:' + PORT), 'x-forwarded-proto': ctx.proto },
    timeout: LIST_TIMEOUT_MS, validateStatus: () => true
  });
  let data = r.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  const subs = (r.status === 200 && data && Array.isArray(data.subtitles)) ? data.subtitles : null;
  if (!subs) return null;
  const out = [];
  for (const s of subs) {
    try {
      const u = new URL(s.url);
      const pm = /\/stream-ara\.(srt|ass)$/i.exec(u.pathname);
      if (!pm) continue;
      const site = (/^trans-(.+)-ara-(?:srt|ass)-\d+$/.exec(String(s.id || '')) || [])[1] || '';
      out.push({ ext: pm[1].toLowerCase(), track: +(u.searchParams.get('track') || 0) || 0, site, path: u.pathname + u.search });
    } catch (e) { /* لا شيء */ }
  }
  out.sort((a, b) => (a.ext === b.ext ? a.track - b.track : a.ext === 'srt' ? -1 : 1));
  return out;
}

async function startPath(path) {
  try {
    const res = await axios.get('http://127.0.0.1:' + PORT + path, {
      headers: { 'x-forwarded-host': (ctx && ctx.host) || ('127.0.0.1:' + PORT), 'x-forwarded-proto': (ctx && ctx.proto) || 'https' },
      timeout: START_TIMEOUT_MS, validateStatus: () => true, responseType: 'text'
    });
    return /قيد التنفيذ/.test(String(res.data || ''));
  } catch (e) {
    return null;
  }
}

async function onRequest(chatId, rq, tg, count) {
  const send = text => tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  try {
    const isEp = !!rq.season;
    if (count && !isEp) {
      await send(rtl('الدفعة للمسلسلات فقط، اكتب الموسم والحلقة مثل:') + '\n' + latin(rq.imdb + ' 1 5'));
      return;
    }
    let title = notify && notify.titleOf ? await notify.titleOf(rq.targetId, isEp ? 'series' : 'movie') : null;
    let type = isEp ? 'series' : 'movie';
    if (!title && !isEp && notify && notify.titleOf) {
      const sTitle = await notify.titleOf(rq.imdb, 'series');
      if (sTitle) {
        await send([rtl('🎬 ' + latin(sTitle) + ' ' + latin('(' + rq.imdb + ')')), rtl('هذا مسلسل، اكتب الموسم والحلقة مثل:'), latin(rq.imdb + ' 1 5')].join('\n'));
        return;
      }
    }
    if (!title) {
      await send(rtl('❌ ما لقيت عمل بهذا الرقم ') + latin(rq.imdb) + '\n' + rtl('تأكد من الرقم وجرّب مرة ثانية.'));
      return;
    }
    if (!ctx) {
      await send([rtl('🎬 ' + latin(title) + ' ' + latin('(' + rq.imdb + ')')),
        rtl('الرقم صحيح، بس ما عندي إعداداتك بالذاكرة (السيرفر تو اشتغل).'),
        rtl('افتح أي حلقة من Nuvio مرة وحدة وبعدها ارجع ابعث الرقم.')].join('\n'));
      return;
    }
    const wait = await send(rtl('🔎 جاري جلب التراكات لـ ' + latin(title) + '...'));
    const tracks = await fetchTracks(type, rq.targetId);
    const head = [rtl('🎬 ' + latin(title) + ' ' + latin('(' + rq.imdb + ')'))];
    if (isEp) {
      let ep = null;
      try { ep = notify && notify.describeEpisode ? await notify.describeEpisode(rq.targetId) : null; } catch (e) { ep = null; }
      head.push(rtl('📺 ' + ((ep && ep.text) || ('الموسم ' + rq.season + ' الحلقة ' + rq.episode))));
    }
    const mid = wait && wait.message_id;
    const finish = (text, markup) => mid
      ? tg('editMessageText', { chat_id: chatId, message_id: mid, text, reply_markup: markup, disable_web_page_preview: true })
      : tg('sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });
    if (!tracks) { await finish(head.concat(rtl('⚠️ تعذر جلب قائمة التراكات، جرّب بعد شوي.')).join('\n')); return; }
    if (!tracks.length) { await finish(head.concat(rtl('ما لقيت تراكات عربية لهذا العمل.')).join('\n')); return; }
    const h = crypto.createHash('sha1').update(rq.targetId + ':' + Date.now()).digest('hex').slice(0, 8);
    reqs.set(h, { targetId: rq.targetId, head, tracks, count: count || 0 });
    while (reqs.size > MAX_REQS) reqs.delete(reqs.keys().next().value);
    const rows = [];
    for (const ext of ['srt', 'ass']) {
      const row = tracks.map((t, i) => ({ t, i })).filter(x => x.t.ext === ext).map(x => ({
        text: ext.toUpperCase() + ' ' + x.t.track + (x.t.site ? ' · ' + x.t.site : ''), callback_data: 'go:' + h + ':' + x.i
      }));
      for (let k = 0; k < row.length; k += 2) rows.push(row.slice(k, k + 2));
    }
    if (count) head.push(rtl('📦 دفعة: ' + count + ' حلقات (حلقة كل 5 دقائق، وتتوقف بنهاية الموسم)'));
    await finish(head.concat(rtl(count ? 'اختر التراك لبدء الدفعة:' : 'اختر التراك اللي تريد تجهزه:')).join('\n'), { inline_keyboard: rows });
  } catch (e) {
    try { await send(rtl('⚠️ صار خطأ أثناء الطلب، جرّب مرة ثانية.')); } catch (e2) { /* لا شيء */ }
  }
}

async function onCallback(cq, tg, batch) {
  const m = /^go:([0-9a-f]{8}):(\d+)$/.exec(String(cq.data || ''));
  const r = m && reqs.get(m[1]);
  const t = r && r.tracks[+m[2]];
  const answer = text => tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  if (!t) { await answer('انتهت صلاحية هذي القائمة، ابعث الرقم من جديد'); return; }
  if (!ctx) { await answer('افتح حلقة من Nuvio مرة وحدة أول'); return; }
  const label = t.ext.toUpperCase() + ' تراك ' + t.track;
  if (r.count && batch) {
    await answer('بدأت الدفعة');
    reqs.delete(m[1]);
    await batch.start({ chat: cq.message && cq.message.chat, messageId: cq.message && cq.message.message_id, tg, targetId: r.targetId, head: r.head, track: t, count: r.count });
    return;
  }
  const started = await startPath(t.path);
  if (started === null) {
    await answer('تعذر بدء التجهيز، جرّب مرة ثانية');
    return;
  }
  console.log('[طلب يدوي] ' + r.targetId + ' ' + label + (started ? ': بدأ التجهيز' : ': جاهز أصلاً'));
  await answer(started ? 'بدأ التجهيز ⏳' : 'هذا التراك جاهز أصلاً ✅');
  const msg = cq.message;
  if (msg && msg.chat && msg.message_id) {
    const status = started
      ? rtl('⏳ بدأ تجهيز ' + label + ' — يوصلك إشعار لما يخلص.')
      : rtl('✅ ' + label + ' جاهز أصلاً، شغّله من Nuvio.');
    await tg('editMessageText', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: r.head.concat(status, rtl('تقدر تضغط تراك ثاني.')).join('\n'),
      reply_markup: cq.message.reply_markup, disable_web_page_preview: true
    }).catch(() => {});
  }
}

module.exports = { noteContext, parse, onRequest, onCallback, fetchTracks, startPath, getCtx: () => ctx, _t: { fetchTracks, reqs, getCtx: () => ctx } };
