'use strict';
const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const { CORRECTOR_REV, TRACKS_TAG } = require('./corrector');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }
let filler = null;
try { filler = require('./filler'); } catch (e) { filler = null; }
let shared = null;
try { shared = require('./ai').shared; } catch (e) { shared = null; }

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const ENABLED = !!(TG_TOKEN && TG_CHAT);
const API = 'https://api.telegram.org/bot';
const PORT = process.env.PORT || 7000;

const NS = 'adj';
const POLL_SEC = 25;
const ERR_LOG_GAP_MS = 10 * 60 * 1000;
const MAX_PANELS = 200;
const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const scrub = s => {
  let out = String(s == null ? '' : s);
  if (TG_TOKEN) out = out.split(TG_TOKEN).join('***');
  return out;
};

const keyOf = d => [d.label, d.targetId, 'track' + d.trackNum].join('_') + (d.tracksTag || '');
const hashOf = key => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8);

const panels = new Map();
let last = null;
let lastErrLogAt = 0;

function withTimeout(p, ms) {
  let t;
  const timer = new Promise(resolve => { t = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([Promise.resolve(p).catch(() => undefined), timer]).finally(() => clearTimeout(t));
}

function noteTrack(d) {
  try {
    if (!ENABLED || !d || !d.targetId) return;
    const key = keyOf(d);
    if (last && last.key === key) return;
    last = { key, label: d.label, targetId: d.targetId, trackNum: d.trackNum, ext: d.ext, tracksTag: d.tracksTag || '' };
    Promise.resolve(db.saveDoc(NS, 'last', { d: last, at: Date.now() })).catch(() => {});
  } catch (e) {}
}

async function tg(method, body, timeoutMs, retry) {
  try {
    const r = await axios.post(API + TG_TOKEN + '/' + method, body, { timeout: timeoutMs || 10000 });
    return r && r.data && r.data.result;
  } catch (e) {
    const st = e && e.response && e.response.status;
    const data = e && e.response && e.response.data;
    if (retry !== false && st === 429) {
      const ra = Number(data && data.parameters && data.parameters.retry_after) || 2;
      await sleep(Math.min(10, ra) * 1000);
      return tg(method, body, timeoutMs, false);
    }
    const err = new Error(scrub((data && data.description) || (e && e.message)));
    err.status = st;
    throw err;
  }
}

function logErr(what, e) {
  const now = Date.now();
  if (now - lastErrLogAt < ERR_LOG_GAP_MS) return;
  lastErrLogAt = now;
  console.log('[بوت التحكم] ' + what + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + ': ' + scrub(e && e.message) + ' ⟵ عمل الإضافة لم يتأثر.');
}

const answerCb = (cq, text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
const editMsg = (msg, text, markup) => (msg && msg.chat && msg.message_id)
  ? tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, reply_markup: markup, disable_web_page_preview: true }).catch(() => {})
  : Promise.resolve();

const LABELS = ['ARA-SRT', 'ARA-ASS'];
const MAX_TRACK = 4;
const LINE_VERSION = 'ARB2';
const STEP_TIMEOUT_MS = 8000;

const memDrops = [];
function onDrop(fn) { if (typeof fn === 'function') memDrops.push(fn); }

async function idsOf(targetId) {
  const ids = [String(targetId)];
  try {
    const ep = notify && notify.describeEpisode ? await withTimeout(notify.describeEpisode(targetId), 6000) : null;
    if (ep && ep.alt && ep.alt.id && !ids.includes(ep.alt.id)) ids.push(ep.alt.id);
  } catch (e) {}
  return ids;
}

async function pinUrlsOf(id) {
  const out = [];
  try {
    const doc = await withTimeout(db.loadDoc('job', 'corr_pins_' + id + TRACKS_TAG), STEP_TIMEOUT_MS);
    for (const k of ['srt', 'ass']) {
      if (doc && Array.isArray(doc[k])) for (const it of doc[k]) if (it && it.url) out.push(String(it.url));
    }
  } catch (e) {}
  return out;
}

const trackKey = (label, id, n) => [label, id, 'track' + n].join('_') + '_' + CORRECTOR_REV + TRACKS_TAG;
const lineKey = (id, url) => LINE_VERSION + '_' + CORRECTOR_REV + '_' + id + '|' + url;

async function clearEpisode(targetId) {
  const ids = await idsOf(targetId);
  const res = { ids, tracks: 0, lines: 0, failed: 0 };
  const jobs = [];
  for (const id of ids) {
    for (const label of LABELS) {
      for (let n = 1; n <= MAX_TRACK; n++) {
        const key = trackKey(label, id, n);
        for (const fn of memDrops) { try { fn(key); } catch (e) {} }
        jobs.push(withTimeout(db.deleteDoc('job', key), STEP_TIMEOUT_MS).then(r => ({ kind: 'track', r })));
      }
    }
    const urls = [...new Set(await pinUrlsOf(id))];
    for (const url of urls) {
      const key = lineKey(id, url);
      try { if (shared && shared.getLineCache) shared.getLineCache(key).clear(); } catch (e) {}
      jobs.push(withTimeout(db.deleteMap('line', key), STEP_TIMEOUT_MS).then(r => ({ kind: 'line', r })));
    }
  }
  const done = await Promise.all(jobs);
  for (const x of done) {
    if (typeof x.r !== 'number' || x.r < 0) res.failed++;
    else if (x.r > 0) res[x.kind === 'track' ? 'tracks' : 'lines'] += x.r;
  }
  return res;
}

async function clearTrack(targetId, ext, track, withLines) {
  const label = ext === 'ass' ? 'ARA-ASS' : 'ARA-SRT';
  const key = trackKey(label, targetId, track);
  for (const fn of memDrops) { try { fn(key); } catch (e) {} }
  const res = { tracks: 0, lines: 0, failed: 0 };
  const d = await withTimeout(db.deleteDoc('job', key), STEP_TIMEOUT_MS);
  if (typeof d !== 'number' || d < 0) res.failed++; else res.tracks += d;
  if (withLines) {
    const doc = await withTimeout(db.loadDoc('job', 'corr_pins_' + targetId + TRACKS_TAG), STEP_TIMEOUT_MS);
    const it = doc && Array.isArray(doc[ext]) ? doc[ext][track - 1] : null;
    if (it && it.url) {
      const lk = lineKey(targetId, String(it.url));
      try { if (shared && shared.getLineCache) shared.getLineCache(lk).clear(); } catch (e) {}
      const m = await withTimeout(db.deleteMap('line', lk), STEP_TIMEOUT_MS);
      if (typeof m !== 'number' || m < 0) res.failed++; else res.lines += m;
    }
  }
  return res;
}

async function headOf(d) {
  const id = String(d.targetId || '');
  const isMovie = /^tt\d+$/.test(id);
  let title = null, ep = null;
  if (notify) {
    const a = notify.titleOf ? withTimeout(notify.titleOf(id, isMovie ? 'movie' : 'series'), 6000) : Promise.resolve(null);
    const b = (!isMovie && notify.describeEpisode) ? withTimeout(notify.describeEpisode(id), 6000) : Promise.resolve(null);
    [title, ep] = await Promise.all([a, b]);
  }
  const lines = [];
  lines.push(rtl('🎬 ' + latin(title || id)));
  if (!isMovie) lines.push(rtl('📺 ' + ((ep && ep.text) || id)));
  lines.push(rtl('📄 تراك ' + d.trackNum + ' ' + latin(String(d.ext).toUpperCase())));
  return lines;
}

const panelText = head => [rtl('🎛 لوحة التحكم'), ...head].join('\n');
const keyboard = h => ({ inline_keyboard: [[{ text: '🗑 امسح آخر حلقة', callback_data: 'cl:' + h }]] });

async function loadLast() {
  if (last) return last;
  const doc = await withTimeout(db.loadDoc(NS, 'last'), 3000);
  if (doc && doc.d && doc.d.targetId) {
    const d = doc.d;
    last = { key: keyOf(d), label: d.label, targetId: d.targetId, trackNum: d.trackNum, ext: d.ext, tracksTag: d.tracksTag || '' };
  }
  return last;
}

function rememberPanel(d, head) {
  const h = hashOf(d.key);
  panels.delete(h);
  panels.set(h, { d, head });
  while (panels.size > MAX_PANELS) panels.delete(panels.keys().next().value);
  return h;
}

async function sendPanel(chatId) {
  const d = await loadLast();
  if (!d) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('ما في تراك مصحح شغّلته بعد.') + '\n' + rtl('شغّل تراك من Nuvio وبعدها ابعث /panel') });
    return;
  }
  const head = await headOf(d);
  const h = rememberPanel(d, head);
  await tg('sendMessage', { chat_id: chatId, text: panelText(head), reply_markup: keyboard(h), disable_web_page_preview: true });
}

async function askClear(chatId, d, head) {
  const h = rememberPanel(d, head);
  const text = [rtl('🗑 مسح آخر حلقة'), ...head.slice(0, 2),
    rtl('راح أمسح كل تراكاتها (SRT وASS) من الذاكرة، وتنترجم من جديد بالضغطة الجاية.'),
    rtl('الملف الأصلي المحفوظ يبقى. متأكد؟')].join('\n');
  const b = (t, op) => ({ text: t, callback_data: op + ':' + h });
  await tg('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [[b('✅ نعم، امسح', 'cy'), b('إلغاء', 'cn')]] }, disable_web_page_preview: true });
}

async function sendAskClear(chatId) {
  const d = await loadLast();
  if (!d) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('ما في حلقة شغّلتها بعد حتى أمسحها.') });
    return;
  }
  await askClear(chatId, d, await headOf(d));
}

async function onClearCallback(cq, op, h, panel) {
  const msg = cq.message;
  if (op === 'cl') {
    await answerCb(cq);
    await askClear(msg.chat.id, panel.d, panel.head);
    return;
  }
  if (op === 'cn') {
    await answerCb(cq, 'تم الإلغاء');
    await editMsg(msg, rtl('تم الإلغاء، ما انمسح شي.'));
    return;
  }
  panels.delete(h);
  await answerCb(cq, 'جاري المسح...');
  const r = await clearEpisode(panel.d.targetId);
  console.log('[بوت التحكم] مسح الحلقة ' + r.ids.join(' + ') + ': ' + r.tracks + ' تراك، ' + r.lines + ' كاش أسطر' + (r.failed ? ' | ' + r.failed + ' خطوة فشلت' : ''));
  const out = [rtl('🗑 تم مسح الحلقة'), ...panel.head.slice(0, 2),
    rtl('🎞 تراكات انمسحت: ' + r.tracks),
    rtl('📄 كاش أسطر انمسح: ' + r.lines)];
  if (r.failed) out.push(rtl('⚠️ ' + r.failed + ' خطوة ما انمسحت (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.'));
  else out.push(rtl('شغّل الحلقة من Nuvio وتنترجم من جديد.'));
  await editMsg(msg, out.join('\n'));
}

async function onPanelCallback(cq) {
  const m = /^([a-z]{2}):([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const panel = m && panels.get(m[2]);
  if (m && panel && (m[1] === 'cl' || m[1] === 'cy' || m[1] === 'cn')) return onClearCallback(cq, m[1], m[2], panel);
  await answerCb(cq, 'انتهت صلاحية هذي اللوحة، ابعث /panel');
}

async function onRetryCallback(cq) {
  const m = /^rt:([mz]):([sa]):(\d+):(tt\d+(?::\d+:\d+)?)$/.exec(String(cq.data || ''));
  if (!m) { await answerCb(cq, 'زر غير صالح'); return; }
  const mode = m[1];
  const ext = m[2] === 'a' ? 'ass' : 'srt';
  const track = +m[3];
  const targetId = m[4];
  if (!ctx) await loadCtx();
  if (!ctx) { await answerCb(cq, 'افتح حلقة من Nuvio مرة وحدة أول'); return; }
  await answerCb(cq, 'جاري إعادة التجهيز...');
  const msg = cq.message;
  const edit = suffix => editMsg(msg, String((msg && msg.text) || '') + '\n' + suffix);
  const cleared = await clearTrack(targetId, ext, track, mode === 'z');
  const type = /^tt\d+$/.test(targetId) ? 'movie' : 'series';
  const tracks = await fetchTracks(type, targetId).catch(() => null);
  const t = tracks && tracks.find(x => x.ext === ext && x.track === track);
  if (!t) { await edit(rtl('⚠️ انمسح التراك، بس ما لقيت ' + ext.toUpperCase() + ' ' + track + ' بالقائمة. شغّله من Nuvio.')); return; }
  const started = await startPath(t.path);
  console.log('[إعادة تجهيز] ' + targetId + ' ' + ext.toUpperCase() + ' ' + track + (mode === 'z' ? ' (من الصفر)' : ' (الناقص فقط)') + (started === null ? ': تعذر البدء' : started ? ': بدأ' : ': جاهز') + (cleared.failed ? ' | خطوة مسح فشلت' : ''));
  if (started === null) { await edit(rtl('⚠️ تعذر بدء التجهيز، جرّب مرة ثانية.')); return; }
  await edit(rtl(started ? '🔁 بدأت إعادة التجهيز (' + (mode === 'z' ? 'من الصفر' : 'الناقص فقط') + ') ⏳ يوصلك إشعار لما يخلص.' : '✅ التراك جاهز، شغّله من Nuvio.'));
}

const LIST_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 20000;
const MAX_REQS = 100;
const CTX_NS = 'tgctx';
const CTX_RESAVE_MS = 12 * 60 * 60 * 1000;

let ctx = null;
let ctxSavedRaw = '';
let ctxSavedAt = 0;
const reqs = new Map();

function saveCtx() {
  try {
    if (!ctx) return;
    if (ctx.rawConfig === ctxSavedRaw && Date.now() - ctxSavedAt < CTX_RESAVE_MS) return;
    ctxSavedRaw = ctx.rawConfig;
    ctxSavedAt = Date.now();
    Promise.resolve(db.saveDoc(CTX_NS, 'ctx', ctx)).catch(() => {});
  } catch (e) {}
}

async function loadCtx() {
  if (ctx) return ctx;
  try {
    const d = await db.loadDoc(CTX_NS, 'ctx');
    if (!ctx && d && d.rawConfig) {
      ctx = { rawConfig: String(d.rawConfig), host: d.host || '', proto: d.proto || 'https' };
      ctxSavedRaw = ctx.rawConfig;
      ctxSavedAt = Date.now();
      console.log('[طلب يدوي] تم استرجاع الإعدادات من قاعدة البيانات');
    }
  } catch (e) {}
  return ctx;
}

function noteContext(req) {
  try {
    const raw = req && req.params && req.params.config;
    if (!raw) return;
    ctx = {
      rawConfig: String(raw),
      host: (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '',
      proto: (req.headers && req.headers['x-forwarded-proto']) || 'https'
    };
    saveCtx();
  } catch (e) {}
}

function parseRequest(text) {
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
    } catch (e) {}
  }
  out.sort((a, b) => (a.ext === b.ext ? a.track - b.track : a.ext === 'srt' ? -1 : 1));
  return out;
}

async function startPath(path, nopf) {
  try {
    const res = await axios.get('http://127.0.0.1:' + PORT + path + (nopf ? '&nopf=1' : ''), {
      headers: { 'x-forwarded-host': (ctx && ctx.host) || ('127.0.0.1:' + PORT), 'x-forwarded-proto': (ctx && ctx.proto) || 'https' },
      timeout: START_TIMEOUT_MS, validateStatus: () => true, responseType: 'text'
    });
    return /قيد التنفيذ/.test(String(res.data || ''));
  } catch (e) {
    return null;
  }
}

async function onRequest(chatId, rq, count) {
  const send = text => tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  try {
    const isEp = !!rq.season;
    if (count && !isEp) {
      await send(rtl('الدفعة للمسلسلات فقط، اكتب الموسم والحلقة مثل:') + '\n' + latin(rq.imdb + ' 1 5'));
      return;
    }
    const title = notify && notify.titleOf ? await notify.titleOf(rq.targetId, isEp ? 'series' : 'movie') : null;
    const type = isEp ? 'series' : 'movie';
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
    if (!ctx) await loadCtx();
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
    try { await send(rtl('⚠️ صار خطأ أثناء الطلب، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

async function onGoCallback(cq) {
  const m = /^go:([0-9a-f]{8}):(\d+)$/.exec(String(cq.data || ''));
  const r = m && reqs.get(m[1]);
  const t = r && r.tracks[+m[2]];
  if (!t) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث الرقم من جديد'); return; }
  if (!ctx) await loadCtx();
  if (!ctx) { await answerCb(cq, 'افتح حلقة من Nuvio مرة وحدة أول'); return; }
  const label = t.ext.toUpperCase() + ' تراك ' + t.track;
  if (r.count) {
    await answerCb(cq, 'بدأت الدفعة');
    reqs.delete(m[1]);
    await startBatch({ chat: cq.message && cq.message.chat, messageId: cq.message && cq.message.message_id, targetId: r.targetId, head: r.head, track: t, count: r.count });
    return;
  }
  const started = await startPath(t.path);
  if (started === null) {
    await answerCb(cq, 'تعذر بدء التجهيز، جرّب مرة ثانية');
    return;
  }
  console.log('[طلب يدوي] ' + r.targetId + ' ' + label + (started ? ': بدأ التجهيز' : ': جاهز أصلاً'));
  await answerCb(cq, started ? 'بدأ التجهيز ⏳' : 'هذا التراك جاهز أصلاً ✅');
  const status = started
    ? rtl('⏳ بدأ تجهيز ' + label + ' — يوصلك إشعار لما يخلص.')
    : rtl('✅ ' + label + ' جاهز أصلاً، شغّله من Nuvio.');
  await editMsg(cq.message, r.head.concat(status, rtl('تقدر تضغط تراك ثاني.')).join('\n'), cq.message && cq.message.reply_markup);
}

const COUNTS = [4, 6, 8, 10];
const GAP_MS = 5 * 60 * 1000;
const READY_GAP_MS = 3000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const META_TTL_MS = 6 * 3600 * 1000;

let pendingCount = null;
let activeBatch = null;
const metaCache = new Map();

function takeCount() {
  const p = pendingCount;
  pendingCount = null;
  return p && Date.now() - p.at < PENDING_TTL_MS ? p.n : 0;
}

async function askCount(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: rtl('📦 تجهيز دفعة حلقات') + '\n' + rtl('اختر عدد الحلقات (تحسب الحلقة اللي تبدأ منها):'),
    reply_markup: { inline_keyboard: [COUNTS.map(n => ({ text: String(n), callback_data: 'bn:' + n })), [{ text: 'إلغاء', callback_data: 'bn:0' }]] }
  });
}

async function onCountCallback(cq) {
  const m = /^bn:(\d+)$/.exec(String(cq.data || ''));
  const n = m ? +m[1] : -1;
  if (n === 0) { pendingCount = null; await answerCb(cq, 'تم الإلغاء'); await editMsg(cq.message, rtl('تم إلغاء الدفعة.')); return; }
  if (!COUNTS.includes(n)) { await answerCb(cq, 'خيار غير صالح'); return; }
  pendingCount = { n, at: Date.now() };
  await answerCb(cq, 'تمام: ' + n + ' حلقات');
  await editMsg(cq.message, [rtl('📦 دفعة: ' + n + ' حلقات'), rtl('الآن ابعث رقم العمل مع الموسم والحلقة اللي تبدأ منها، مثل:'), latin('tt0409591 1 5')].join('\n'));
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

const arCount = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? n + ' ' + few : n + ' ' + many);

async function nextOf(cur, left) {
  if (!(left >= 1)) return { end: 'انتهت حلقات الموسم المتوفرة' };
  const m = /^(tt\d+):(\d+):(\d+)$/.exec(String(cur));
  const season = +m[2];
  const ep = +m[3];
  let id = m[1] + ':' + season + ':' + (ep + 1);
  let consumed = 1;
  let skipped = 0;
  let from = '';
  let to = '';
  if (filler && filler.skipFillerAhead) {
    try {
      const sk = await filler.skipFillerAhead(cur, null, null, true);
      if (sk && sk.allFiller) return { end: 'باقي الموسم حشو، توقفت حتى ما أحرق مفاتيح' };
      const sm = sk && sk.targetId ? /^(tt\d+):(\d+):(\d+)$/.exec(sk.targetId) : null;
      if (sm) {
        const delta = +sm[3] - ep;
        if (+sm[2] !== season || delta > left) return { end: 'باقي الموسم حشو، توقفت حتى ما أحرق مفاتيح' };
        id = sk.targetId;
        consumed = delta;
        skipped = sk.skipped || (delta - 1);
        from = sk.from || '';
        to = sk.to || '';
      }
    } catch (e) {}
  }
  return { id, consumed, skipped, from, to };
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
  } catch (e) {}
  return id;
}

function renderBatch(b) {
  const out = [rtl('📦 دفعة تجهيز: ' + b.count + ' حلقات'), ...b.head.slice(0, 1), rtl('📄 التراك: ' + latin(b.ext.toUpperCase() + ' ' + b.track))];
  b.lines.forEach(l => out.push(rtl(l)));
  if (b.final) out.push(rtl(b.final));
  else if (b.nextAt) out.push(rtl('⏳ التالية بعد ' + Math.max(1, Math.round((b.nextAt - Date.now()) / 60000)) + ' دقيقة تقريباً (/stop للإيقاف)'));
  return out.join('\n');
}

function batchNotice(b, lines) {
  if (!b.chat) return Promise.resolve();
  return tg('sendMessage', { chat_id: b.chat.id, text: lines.map(rtl).join('\n'), disable_web_page_preview: true }).catch(() => {});
}

function pushBatch(b) {
  if (!b.chat) return Promise.resolve();
  return editMsg({ chat: b.chat, message_id: b.messageId }, renderBatch(b));
}

async function runBatch(b) {
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
        const tracks = await fetchTracks('series', nx.id).catch(() => null);
        const t = tracks && tracks.find(x => x.ext === b.ext && x.track === b.track);
        if (!t) { b.final = '⏹ توقفت: ما لقيت ' + b.ext.toUpperCase() + ' ' + b.track + ' بالحلقة ' + nx.id.split(':').slice(1).join(':') + ' (جهزت ' + started + ' من ' + b.count + ')'; break; }
        path = t.path;
        left -= nx.consumed;
        cur = nx.id;
        if (nx.skipped > 0) {
          const skippedText = arCount(nx.skipped, 'حلقة حشو', 'حلقتين حشو', 'حلقات حشو', 'حلقة حشو');
          b.lines.push('⏭ تجاوزت ' + skippedText);
          const nxText = await epText(nx.id);
          batchNotice(b, ['⏭ تجاوز حلقات الحشو', ...b.head.slice(0, 1), 'تجاوزت ' + skippedText + (nx.skipped > 1 && nx.from && nx.to ? ' (من ' + nx.from + ' إلى ' + (/^\d+$/.test(nx.to) ? +nx.to - 1 : nx.to) + ')' : ''), '➡️ التالية: ' + nxText]);
        }
      }
      const res = await startPath(path, true);
      const txt = await epText(cur);
      if (res === null) { b.final = '⏹ توقفت: تعذر بدء ' + txt + ' (جهزت ' + started + ' من ' + b.count + ')'; break; }
      started++;
      b.lines.push((res ? '⏳ ' : '✅ جاهزة أصلاً: ') + started + '. ' + txt);
      console.log('[دفعة] ' + started + '/' + b.count + ' ' + cur + (res ? ': بدأ التجهيز' : ': جاهزة أصلاً'));
      b.nextAt = Date.now() + (res ? GAP_MS : READY_GAP_MS);
      if (started >= b.count) break;
      await pushBatch(b);
    }
    if (!b.final && !b.stopped) b.final = '🏁 انتهت الدفعة: جهزت ' + started + ' من ' + b.count;
  } catch (e) {
    b.final = '⏹ توقفت بسبب خطأ (جهزت ' + started + ' من ' + b.count + ')';
    console.log('[دفعة] خطأ: ' + (e && e.message));
  }
  if (b.stopped) b.final = '⏹ تم الإيقاف (جهزت ' + started + ' من ' + b.count + ')، واللي بدأت تكمل بالخلفية.';
  b.nextAt = 0;
  if (activeBatch === b) activeBatch = null;
  await pushBatch(b);
  await batchNotice(b, ['📦 انتهت الدفعة', ...b.head.slice(0, 1), b.final.replace(/^[^ ]+ /, '')]);
}

async function startBatch({ chat, messageId, targetId, head, track, count }) {
  if (activeBatch) {
    if (chat) await tg('sendMessage', { chat_id: chat.id, text: rtl('في دفعة شغالة حالياً، اكتب /stop لإيقافها قبل ما تبدأ ثانية.') }).catch(() => {});
    return;
  }
  const b = { chat, messageId, targetId, head, ext: track.ext, track: track.track, firstPath: track.path, count, lines: [], final: '', nextAt: 0, stopped: false, timer: null, wake: null };
  activeBatch = b;
  console.log('[دفعة] بدأت: ' + targetId + ' ' + b.ext.toUpperCase() + ' ' + b.track + ' × ' + count);
  runBatch(b).catch(() => { if (activeBatch === b) activeBatch = null; });
}

async function stopBatch(chatId) {
  if (!activeBatch) { await tg('sendMessage', { chat_id: chatId, text: rtl('ما في دفعة شغالة.') }).catch(() => {}); return; }
  activeBatch.stopped = true;
  if (activeBatch.timer) clearTimeout(activeBatch.timer);
  if (activeBatch.wake) activeBatch.wake();
  await tg('sendMessage', { chat_id: chatId, text: rtl('⏹ جاري إيقاف الدفعة...') }).catch(() => {});
}

const DB_LIMIT_MB = Number(process.env.MONGO_LIMIT_MB) || 512;
const DB_WARN_RATIO = 0.8;
const DB_CHECK_MS = 24 * 60 * 60 * 1000;
const DB_FIRST_CHECK_MS = 90 * 1000;
const DB_WARN_GAP_MS = 20 * 60 * 60 * 1000;

async function checkDbSize() {
  try {
    const s = await db.stats();
    if (!s) return;
    const rows = [['💾 الأساسية', s.primary], ['🗂 قاعدة التراكات', s.tracks]].filter(r => r[1]);
    if (!rows.some(r => r[1].usedMB / DB_LIMIT_MB >= DB_WARN_RATIO)) return;
    const prev = await withTimeout(db.loadDoc('dbwatch', 'last'), 5000);
    if (prev && prev.at && Date.now() - prev.at < DB_WARN_GAP_MS) return;
    const lines = [rtl('⚠️ قاعدة MongoDB قاربت تمتلئ')];
    for (const [name, v] of rows) {
      lines.push(rtl(name + ': ' + Math.round(v.usedMB) + ' من ' + DB_LIMIT_MB + ' ميغا (' + Math.round(v.usedMB / DB_LIMIT_MB * 100) + '%)'));
    }
    await tg('sendMessage', { chat_id: TG_CHAT, text: lines.join('\n') });
    await db.saveDoc('dbwatch', 'last', { at: Date.now() });
  } catch (e) {}
}

function startDbWatch() {
  setTimeout(() => {
    checkDbSize();
    setInterval(checkDbSize, DB_CHECK_MS);
  }, DB_FIRST_CHECK_MS);
}

const isClearCmd = t => /^\/clear(@\w+)?$/i.test(t) || /^(امسح|مسح) (آخر|اخر) حلقة$/.test(t);
const isBatchCmd = t => /^\/batch(@\w+)?$/i.test(t) || t === 'دفعة';
const isStopCmd = t => /^\/stop(@\w+)?$/i.test(t) || t === 'ايقاف' || t === 'إيقاف';
const isPanelCmd = t => /^\/(panel|start)(@\w+)?$/i.test(t) || t === 'لوحة' || t === 'لوحة التحكم' || /^panel$/i.test(t);

async function handleUpdate(u) {
  try {
    const cq = u && u.callback_query;
    const msg = cq ? cq.message : (u && u.message);
    const chatId = msg && msg.chat && msg.chat.id;
    if (chatId == null || String(chatId) !== TG_CHAT) return;
    const data = String((cq && cq.data) || '');
    if (cq && /^go:/.test(data)) return await onGoCallback(cq);
    if (cq && /^bn:/.test(data)) return await onCountCallback(cq);
    if (cq && /^rt:/.test(data)) return await onRetryCallback(cq);
    if (cq) return await onPanelCallback(cq);
    const text = String((u.message && u.message.text) || '').trim();
    const rq = parseRequest(text);
    if (rq) await onRequest(chatId, rq, takeCount());
    else if (isBatchCmd(text)) await askCount(chatId);
    else if (isStopCmd(text)) await stopBatch(chatId);
    else if (isClearCmd(text)) await sendAskClear(chatId);
    else if (isPanelCmd(text)) await sendPanel(chatId);
  } catch (e) {
    logErr('خطأ بمعالجة أمر', e);
  }
}

let running = false;
let stopped = false;

async function loop() {
  let offset = 0, fails = 0, drained = false;
  tg('setMyCommands', { commands: [{ command: 'panel', description: 'لوحة التحكم' }, { command: 'clear', description: 'امسح ترجمة آخر حلقة' }, { command: 'batch', description: 'جهّز دفعة حلقات (4/6/8/10)' }, { command: 'stop', description: 'أوقف الدفعة الشغالة' }] }).catch(() => {});
  while (!stopped) {
    try {
      if (!drained) {
        const first = await tg('getUpdates', { offset: -1, limit: 1, timeout: 0 }, 10000, false);
        if (Array.isArray(first) && first.length) offset = first[first.length - 1].update_id + 1;
        drained = true;
        fails = 0;
        continue;
      }
      const ups = await tg('getUpdates', { offset, timeout: POLL_SEC, allowed_updates: ['message', 'callback_query'] }, (POLL_SEC + 10) * 1000, false);
      fails = 0;
      if (Array.isArray(ups)) {
        for (const u of ups) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u);
        }
      }
    } catch (e) {
      fails++;
      if (e && e.status === 409) logErr('تعارض: نسخة ثانية أو webhook يسأل نفس البوت', e);
      else if (e && e.status === 401) logErr('الرمز غير صحيح', e);
      else logErr('تعذر الاستماع', e);
      await sleep(e && e.status === 409 ? 5000 : e && e.status === 401 ? 60000 : Math.min(30000, 1000 * Math.pow(2, Math.min(fails, 5))));
    }
  }
  running = false;
}

function start() {
  if (!ENABLED || running) return;
  running = true;
  stopped = false;
  console.log('[بوت التحكم] تيليغرام يسمع أوامرك ⟵ ابعث /panel أو /clear.');
  startDbWatch();
  loop().catch(() => { running = false; });
}

function stop() { stopped = true; }

loadCtx().catch(() => {});

module.exports = {
  start, stop, noteTrack, noteContext, onDrop, enabled: ENABLED,
  _t: { handleUpdate, keyOf, hashOf, panels, sendPanel, parseRequest, fetchTracks, startPath, leftInSeason, nextOf, getMeta, clearEpisode, clearTrack, checkDbSize, reqs, getCtx: () => ctx, isBatchActive: () => !!activeBatch }
};
