'use strict';
const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const { CORRECTOR_REV, TRACKS_TAG } = require('./corrector');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = 'https://api.telegram.org/bot';
const PORT = process.env.PORT || 7000;
const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

const LIST_TIMEOUT_MS = 120000;
const FILE_TIMEOUT_MS = 30000;
const STEP_TIMEOUT_MS = 8000;
const MAX_GETS = 60;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const NOOP = '-';

let H = {};
function init(h) { H = h || {}; }

const gets = new Map();

const trackKey = (label, id, n) => [label, id, 'track' + n].join('_') + '_' + CORRECTOR_REV + TRACKS_TAG;
const pad2 = n => String(n).padStart(2, '0');

function getCmd(text) {
  const m = /^\/(?:get|download)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text || '').trim());
  return m ? String(m[1] || '').trim() : null;
}

function slugTitle(title, fallback) {
  const s = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 50).replace(/\.+$/, '');
  return s || fallback;
}

function fileNameOf(slug, targetId, site, ext) {
  const m = /^tt\d+:(\d+):(\d+)$/.exec(String(targetId));
  const se = m ? '.S' + pad2(m[1]) + 'E' + pad2(m[2]) : '';
  const st = String(site || '').replace(/[^A-Za-z0-9.]+/g, '') || 'sub';
  return slug + se + '.' + st + '.' + ext;
}

// تصنيف عناصر قائمة /subtitles: مصحّح SRT، مصحّح ASS، جاهز SRT، جاهز ASS (بنفس ترتيب صفحة الفحص)
function classify(subs) {
  const out = { 'trans-srt': [], 'trans-ass': [], 'raw-srt': [], 'raw-ass': [] };
  for (const s of subs || []) {
    try {
      const u = new URL(s.url);
      const id = String(s.id || '');
      let m = /^trans-(.+)-ara-(srt|ass)-\d+$/.exec(id);
      let kind = 'trans';
      if (!m || !/\/stream-ara\.(srt|ass)$/i.test(u.pathname)) {
        m = /^nuvio-(srt|ass)-(.+)-ara-\d+$/.exec(id);
        if (!m || !/\/stream-raw\.(srt|ass)$/i.test(u.pathname)) continue;
        kind = 'raw';
        m = [m[0], m[2], m[1]];
      }
      const site = m[1];
      const ext = m[2];
      out[kind + '-' + ext].push({
        kind, ext, site, id,
        track: +(u.searchParams.get('track') || 0) || 0,
        rel: String(s.rel || '').trim(),
        srcUrl: kind === 'raw' ? String(u.searchParams.get('url') || '') : '',
        path: u.pathname + u.search,
        ready: kind === 'raw'
      });
    } catch (e) {}
  }
  return ['trans-srt', 'trans-ass', 'raw-srt', 'raw-ass'].reduce((a, k) => a.concat(out[k]), []);
}

async function isReady(it, ids) {
  const label = it.ext === 'ass' ? 'ARA-ASS' : 'ARA-SRT';
  for (const id of ids) {
    try {
      const doc = await H.withTimeout(db.loadDoc('job', trackKey(label, id, it.track)), STEP_TIMEOUT_MS);
      if (doc && doc.content) return true;
    } catch (e) {}
  }
  return false;
}

const GROUPS = {
  'trans-srt': '— مصحّح SRT —',
  'trans-ass': '— مصحّح ASS —',
  'raw-srt': '— جاهز SRT (بدون تصحيح) —',
  'raw-ass': '— جاهز ASS (بدون تصحيح) —'
};

function keyboardOf(h, g) {
  const rows = [];
  for (const gk of ['trans-srt', 'trans-ass', 'raw-srt', 'raw-ass']) {
    const idx = g.items.map((it, i) => ({ it, i })).filter(x => x.it.kind + '-' + x.it.ext === gk);
    if (!idx.length) continue;
    rows.push([{ text: GROUPS[gk], callback_data: 'gt:' + h + ':' + NOOP }]);
    const btns = idx.map(({ it, i }) => ({
      text: it.track + ' · ' + it.site + (it.kind === 'trans' ? (it.ready ? ' ✅' : ' ⏳') : (it.site === 'wyzie' ? ' 🔗' : '')),
      callback_data: 'gt:' + h + ':' + i
    }));
    const n = idx[0].it.kind === 'trans' ? 2 : 3;
    for (let k = 0; k < btns.length; k += n) rows.push(btns.slice(k, k + n));
  }
  return { inline_keyboard: rows };
}

async function fetchList(type, targetId) {
  const ctx = H.getCtx();
  const path = (ctx.rawConfig ? '/' + encodeURIComponent(ctx.rawConfig) : '')
    + '/subtitles/' + type + '/' + encodeURIComponent(targetId).replace(/%3A/gi, ':') + '.json?bgq=1';
  const r = await axios.get('http://127.0.0.1:' + PORT + path, {
    headers: { 'x-forwarded-host': ctx.host || ('127.0.0.1:' + PORT), 'x-forwarded-proto': ctx.proto || 'https' },
    timeout: LIST_TIMEOUT_MS, validateStatus: () => true
  });
  let data = r.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return (r.status === 200 && data && Array.isArray(data.subtitles)) ? data.subtitles : null;
}

async function onGetCmd(chatId, arg) {
  const send = (text, markup) => H.tg('sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });
  try {
    let rq = arg ? H.parseRequest(arg) : null;
    if (!rq && !arg) {
      const l = await H.loadLast();
      rq = l && l.targetId ? H.parseRequest(String(l.targetId).replace(/:/g, ' ')) : null;
    }
    if (!rq) {
      await send([rtl('اكتب الأمر مع رقم العمل مثل:'), latin('/get tt33043892 2 1'), rtl('أو اكتب /get لحاله لآخر حلقة اشتغلت.')].join('\n'));
      return;
    }
    const isEp = !!rq.season;
    const type = isEp ? 'series' : 'movie';
    const title = notify && notify.titleOf ? await notify.titleOf(rq.targetId, type) : null;
    if (!title) { await send(rtl('❌ ما لقيت عمل بهذا الرقم ') + latin(rq.imdb)); return; }
    if (!H.getCtx()) await H.loadCtx();
    if (!H.getCtx()) {
      await send([rtl('🎬 ' + latin(title) + ' ' + latin('(' + rq.imdb + ')')),
        rtl('ما عندي إعداداتك بالذاكرة (السيرفر تو اشتغل).'),
        rtl('افتح أي حلقة من Nuvio مرة وحدة وبعدها ارجع.')].join('\n'));
      return;
    }
    const wait = await send(rtl('🔎 جاري جلب القائمة لـ ' + latin(title) + '... (قد ياخذ حتى دقيقة)'));
    const subs = await fetchList(type, rq.targetId);
    const mid = wait && wait.message_id;
    const finish = (text, markup) => mid
      ? H.tg('editMessageText', { chat_id: chatId, message_id: mid, text, reply_markup: markup, disable_web_page_preview: true })
      : send(text, markup);
    const head = [rtl('📥 ' + 'تحميل الترجمات'), rtl('🎬 ' + latin(title) + ' ' + latin('(' + rq.imdb + ')'))];
    if (isEp) {
      let ep = null;
      try { ep = notify && notify.describeEpisode ? await notify.describeEpisode(rq.targetId) : null; } catch (e) { ep = null; }
      head.push(rtl('📺 ' + ((ep && ep.text) || ('الموسم ' + rq.season + ' الحلقة ' + rq.episode))));
    }
    if (!subs) { await finish(head.concat(rtl('⚠️ تعذر جلب القائمة، جرّب بعد شوي.')).join('\n')); return; }
    const items = classify(subs);
    if (!items.length) { await finish(head.concat(rtl('ما لقيت تراكات لهذا العمل.')).join('\n')); return; }
    let ids = [rq.targetId];
    try { ids = await H.idsOf(rq.targetId); } catch (e) {}
    await Promise.all(items.filter(it => it.kind === 'trans').map(async it => { it.ready = await isReady(it, ids); }));
    const h = crypto.createHash('sha1').update(rq.targetId + ':' + Date.now()).digest('hex').slice(0, 8);
    const g = { targetId: rq.targetId, title, slug: slugTitle(title, rq.imdb), items, ids };
    gets.set(h, g);
    while (gets.size > MAX_GETS) gets.delete(gets.keys().next().value);
    head.push(rtl('✅ جاهز للتحميل   ⏳ ما انصحّح (الضغطة تبدأ التصحيح)   🔗 رابط'));
    await finish(head.join('\n'), keyboardOf(h, g));
  } catch (e) {
    H.logErr('خطأ بأمر /get', e);
    try { await send(rtl('⚠️ صار خطأ أثناء جلب القائمة، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

async function sendDoc(chatId, name, buf, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', new Blob([buf], { type: 'application/octet-stream' }), name);
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  const r = await fetch(API + TG_TOKEN + '/sendDocument', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  if (!r.ok) {
    let d = '';
    try { d = (await r.json()).description || ''; } catch (e) {}
    throw new Error(H.scrub('sendDocument HTTP ' + r.status + (d ? ' | ' + d : '')));
  }
}

const dispName = res => {
  const cd = String((res.headers && res.headers['content-disposition']) || '');
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : '';
};

async function onGetCallback(cq) {
  const m = /^gt:([0-9a-f]{8}):(\d+|-)$/.exec(String(cq.data || ''));
  if (!m) return;
  if (m[2] === NOOP) { await H.answerCb(cq); return; }
  const g = gets.get(m[1]);
  const it = g && g.items[+m[2]];
  if (!it) { await H.answerCb(cq, 'انتهت صلاحية القائمة، اكتب /get من جديد'); return; }
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!H.getCtx()) await H.loadCtx();
  const ctx = H.getCtx();
  if (!ctx) { await H.answerCb(cq, 'افتح حلقة من Nuvio مرة وحدة أول'); return; }
  const tag = it.ext.toUpperCase() + ' تراك ' + it.track;
  try {
    const res = await axios.get('http://127.0.0.1:' + PORT + it.path + (it.kind === 'raw' ? '&prefetch=1' : '&nopf=1'), {
      headers: { 'x-forwarded-host': ctx.host || ('127.0.0.1:' + PORT), 'x-forwarded-proto': ctx.proto || 'https' },
      timeout: FILE_TIMEOUT_MS, validateStatus: () => true, responseType: 'arraybuffer', maxRedirects: 0
    });
    const fname = dispName(res);
    if (it.kind === 'trans') {
      if (/^Trans-Track/i.test(fname) && res.status === 200) {
        await deliver(cq, chatId, g, it, Buffer.from(res.data));
        if (!it.ready) {
          it.ready = true;
          H.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: keyboardOf(m[1], g) }).catch(() => {});
        }
        return;
      }
      if (/^Trans-Failed/i.test(fname)) {
        await H.answerCb(cq, 'هذا التراك فشل قبل، اضغط مرة ثانية لإعادة المحاولة');
        return;
      }
      console.log('[طلب يدوي] ' + g.targetId + ' ' + tag + ': بدأ التجهيز (من /get)');
      await H.answerCb(cq, 'بدأ تصحيح ' + tag + ' ⏳');
      return;
    }
    if (res.status === 200 && res.data && res.data.length) {
      await deliver(cq, chatId, g, it, Buffer.from(res.data));
      return;
    }
    await sendLink(cq, chatId, g, it, res);
  } catch (e) {
    H.logErr('خطأ بتحميل تراك /get', e);
    await H.answerCb(cq, 'تعذر التحميل، جرّب مرة ثانية');
  }
}

async function deliver(cq, chatId, g, it, buf) {
  if (buf.length > MAX_FILE_BYTES) { await H.answerCb(cq, 'الملف كبير جداً'); return; }
  await H.answerCb(cq, 'جاري الإرسال 📥');
  const name = fileNameOf(g.slug, g.targetId, it.site, it.ext);
  const caption = it.id + (it.rel ? ' · ' + it.rel : '');
  await sendDoc(chatId, name, buf, caption);
}

async function sendLink(cq, chatId, g, it, res) {
  const loc = String((res.headers && res.headers.location) || '');
  const link = /^https?:\/\//i.test(loc) ? loc : it.srcUrl;
  await H.answerCb(cq, 'السيرفر ما يقدر ينزله، أرسلت لك الرابط');
  const lines = [rtl('🔗 ' + latin(it.id) + ' — السيرفر ما يقدر ينزل هذا التراك، افتح الرابط من جهازك:')];
  if (link) lines.push(link);
  if (it.rel) lines.push(latin(it.rel));
  await H.tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true });
}

const SITE_LABELS = { subdl: 'subdl', subsource: 'subsource', os_legacy: 'opensubtitles.org', os_mirror: 'opensubtitles', opensubtitles: 'opensubtitles', oscom: 'opensubtitles.com', wyzie: 'wyzie' };

// زر "📥 تحميل" تحت إشعار الاكتمال: callback_data = dl:<s|a>:<تراك>:<targetId> (بدون حالة، يشتغل حتى بعد إعادة تشغيل السيرفر)
async function onDlCallback(cq) {
  const m = /^dl:([sa]):(\d+):(.+)$/.exec(String(cq.data || ''));
  if (!m) return;
  const ext = m[1] === 'a' ? 'ass' : 'srt';
  const label = ext === 'ass' ? 'ARA-ASS' : 'ARA-SRT';
  const track = +m[2];
  const targetId = m[3];
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  try {
    const doc = await H.withTimeout(db.loadDoc('job', trackKey(label, targetId, track)), STEP_TIMEOUT_MS);
    if (!doc || !doc.content) { await H.answerCb(cq, 'هذا التراك غير محفوظ (انمسح أو ما اكتمل)'); return; }
    const buf = Buffer.from(String(doc.content), 'utf8');
    if (buf.length > MAX_FILE_BYTES) { await H.answerCb(cq, 'الملف كبير جداً'); return; }
    let site = '';
    let rel = '';
    try {
      const pins = await H.withTimeout(db.loadDoc('job', 'corr_pins_' + targetId + TRACKS_TAG), STEP_TIMEOUT_MS);
      const it = pins && Array.isArray(pins[ext]) ? pins[ext][track - 1] : null;
      if (it) {
        const raw = it._site || it._source || '';
        site = SITE_LABELS[raw] || raw;
        rel = String(it.name || '').trim();
      }
    } catch (e) {}
    const imdb = String(targetId).split(':')[0];
    const isMovie = /^tt\d+$/.test(targetId);
    let title = null;
    try { title = notify && notify.titleOf ? await notify.titleOf(targetId, isMovie ? 'movie' : 'series') : null; } catch (e) { title = null; }
    await H.answerCb(cq, 'جاري الإرسال 📥');
    const name = fileNameOf(slugTitle(title, imdb), targetId, site, ext);
    const caption = 'trans-' + (site || 'sub') + '-ara-' + ext + '-' + track + (rel ? ' · ' + rel : '');
    await sendDoc(chatId, name, buf, caption);
  } catch (e) {
    H.logErr('خطأ بزر التحميل', e);
    await H.answerCb(cq, 'تعذر التحميل، جرّب مرة ثانية');
  }
}

module.exports = { init, getCmd, onGetCmd, onGetCallback, onDlCallback, classify, keyboardOf, slugTitle, fileNameOf, gets };
