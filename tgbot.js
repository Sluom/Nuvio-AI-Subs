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
const settings = require('./settings');

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

let pendingOrder = null;
const orderAsks = new Map();

async function clearOrder(targetId) {
  const ids = await idsOf(targetId);
  const res = { ids, pins: 0, tracks: 0, failed: 0 };
  const jobs = [];
  for (const id of ids) {
    const pinKey = 'corr_pins_' + id + TRACKS_TAG;
    for (const fn of memDrops) { try { fn(pinKey); } catch (e) {} }
    jobs.push(withTimeout(db.deleteDoc('job', pinKey), STEP_TIMEOUT_MS).then(r => ({ kind: 'pins', r })));
    for (const label of LABELS) {
      for (let n = 1; n <= MAX_TRACK; n++) {
        const key = trackKey(label, id, n);
        for (const fn of memDrops) { try { fn(key); } catch (e) {} }
        jobs.push(withTimeout(db.deleteDoc('job', key), STEP_TIMEOUT_MS).then(r => ({ kind: 'tracks', r })));
      }
    }
  }
  const done = await Promise.all(jobs);
  for (const x of done) {
    if (typeof x.r !== 'number' || x.r < 0) res.failed++;
    else if (x.r > 0) res[x.kind] += x.r;
  }
  return res;
}

async function askOrder(chatId) {
  pendingOrder = { at: Date.now() };
  await tg('sendMessage', {
    chat_id: chatId,
    text: rtl('🧹 مسح ترتيب التراكات') + '\n' + rtl('ابعث الـ tt ورقم الموسم والحلقة، مثال: tt1234567 2 5') + '\n' + rtl('(للفلم ابعث الـ tt بس)'),
    reply_markup: { inline_keyboard: [[{ text: 'إلغاء', callback_data: 'od:n:0' }]] }
  }).catch(() => {});
}

async function onOrderTarget(chatId, rq) {
  pendingOrder = null;
  const h = hashOf(rq.targetId + ':' + Date.now());
  orderAsks.set(h, { targetId: rq.targetId, at: Date.now() });
  if (orderAsks.size > 20) orderAsks.delete(orderAsks.keys().next().value);
  await tg('sendMessage', {
    chat_id: chatId,
    text: rtl('تأكيد مسح ترتيب التراكات لهذي الحلقة:') + '\n' + latin(rq.targetId) + '\n' + rtl('(تنمسح التراكات المثبتة + نتائجها؛ كاش الأسطر يبقى)'),
    reply_markup: { inline_keyboard: [[{ text: '🧹 امسح الترتيب', callback_data: 'od:y:' + h }, { text: 'إلغاء', callback_data: 'od:n:' + h }]] }
  }).catch(() => {});
}

async function onOrderCallback(cq) {
  const m = /^od:([yn]):([0-9a-f]{8}|0)$/.exec(String(cq.data || ''));
  if (!m) { await answerCb(cq, 'خيار غير صالح'); return; }
  if (m[1] === 'n') {
    pendingOrder = null; orderAsks.delete(m[2]);
    await answerCb(cq, 'تم الإلغاء');
    await editMsg(cq.message, rtl('تم الإلغاء، ما انمسح شي.'));
    return;
  }
  const a = orderAsks.get(m[2]);
  if (!a || Date.now() - a.at > PENDING_TTL_MS) { orderAsks.delete(m[2]); await answerCb(cq, 'انتهت صلاحية الطلب، ابعث /order من جديد'); return; }
  orderAsks.delete(m[2]);
  await answerCb(cq, 'جاري المسح...');
  const r = await clearOrder(a.targetId);
  console.log('[بوت التحكم] مسح ترتيب التراكات ' + r.ids.join(' + ') + ': ' + r.pins + ' ترتيب، ' + r.tracks + ' تراك' + (r.failed ? ' | ' + r.failed + ' خطوة فشلت' : ''));
  const out = [rtl('🧹 تم مسح ترتيب التراكات'), latin(a.targetId),
    rtl('📌 ترتيب انمسح: ' + r.pins),
    rtl('🎞 تراكات انمسحت: ' + r.tracks)];
  if (r.failed) out.push(rtl('⚠️ ' + r.failed + ' خطوة ما انمسحت (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.'));
  else if (!r.pins && !r.tracks) out.push(rtl('ما كان في ترتيب محفوظ لهذي الحلقة.'));
  else out.push(rtl('أول مرة تشغّل الحلقة من Nuvio ينبني الترتيب من جديد.'));
  await editMsg(cq.message, out.join('\n'));
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
    if (req && req.headers && req.headers['x-nuvio-nonote']) return;   // طلبات الدفعة بموديل مختار: لا تغيّر الإعداد المحفوظ
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

async function fetchTracks(type, targetId, rawOverride) {
  const rawCfg = rawOverride || ctx.rawConfig;
  const path = (rawCfg ? '/' + encodeURIComponent(rawCfg) : '')
    + '/subtitles/' + type + '/' + encodeURIComponent(targetId).replace(/%3A/gi, ':') + '.json?bgq=1';
  const hdrs = { 'x-forwarded-host': ctx.host || ('127.0.0.1:' + PORT), 'x-forwarded-proto': ctx.proto };
  if (rawOverride) hdrs['x-nuvio-nonote'] = '1';
  const r = await axios.get('http://127.0.0.1:' + PORT + path, {
    headers: hdrs,
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
    const wait = await send(rtl('🔎 جاري جلب التراكات لـ ' + latin(title) + '... (جودة التجهيز بالخلفية، قد ياخذ حتى دقيقة)'));
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
    reqs.set(h, { targetId: rq.targetId, head, tracks, count: count || 0, model: '' });
    while (reqs.size > MAX_REQS) reqs.delete(reqs.keys().next().value);
    const rows = trackRows(h, reqs.get(h));
    if (count) head.push(rtl('📦 دفعة: ' + count + ' حلقات (حلقة كل ' + (batchGapMs(count) / 60000) + ' دقائق، وتتوقف بنهاية الموسم)'));
    await finish(head.concat(rtl(count ? 'اختر التراك لبدء الدفعة (الموديل من الأزرار تحت):' : 'اختر التراك اللي تريد تجهزه:')).join('\n'), { inline_keyboard: rows });
  } catch (e) {
    try { await send(rtl('⚠️ صار خطأ أثناء الطلب، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

// اختيار الموديل يظهر فقط بقائمة تراكات الدفعة (الافتراضي = موديل رابطك)
const BATCH_MODELS = [
  { code: 'd', model: '', label: 'الافتراضي' },
  { code: '1', model: 'gemini-3.1-flash-lite', label: '3.1 لايت' },
  { code: '5', model: 'gemini-3.5-flash-lite', label: '3.5 لايت' }
];

function trackRows(h, r) {
  const rows = [];
  for (const ext of ['srt', 'ass']) {
    const row = r.tracks.map((t, i) => ({ t, i })).filter(x => x.t.ext === ext).map(x => ({
      text: ext.toUpperCase() + ' ' + x.t.track + (x.t.site ? ' · ' + x.t.site : ''), callback_data: 'go:' + h + ':' + x.i
    }));
    for (let k = 0; k < row.length; k += 2) rows.push(row.slice(k, k + 2));
  }
  if (r.count) rows.push(BATCH_MODELS.map(m => ({ text: ((r.model || '') === m.model ? '✅ ' : '') + '🧠 ' + m.label, callback_data: 'bm:' + h + ':' + m.code })));
  return rows;
}

async function onModelCallback(cq) {
  const m = /^bm:([0-9a-f]{8}):([d15])$/.exec(String(cq.data || ''));
  const r = m && reqs.get(m[1]);
  const opt = m && BATCH_MODELS.find(x => x.code === m[2]);
  if (!r || !opt || !r.count) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث الرقم من جديد'); return; }
  r.model = opt.model;
  await answerCb(cq, 'الموديل: ' + opt.label);
  await editMsg(cq.message, String((cq.message && cq.message.text) || ''), { inline_keyboard: trackRows(m[1], r) });
}

// نبدّل حقل model داخل الإعداد (JSON) فقط، بدون ما نغيّر الإعداد المحفوظ
function configWithModel(raw, model) {
  try {
    let d;
    try { d = JSON.parse(decodeURIComponent(raw)); } catch (e) { d = JSON.parse(raw); }
    if (!d || typeof d !== 'object') return null;
    d.model = model;
    return JSON.stringify(d);
  } catch (e) { return null; }
}

// مسار التراك أوله الإعداد: نبدّله بالإعداد الجديد (يرجع null اذا شكل المسار غير متوقع)
function swapPathConfig(path, newRaw) {
  try {
    if (!ctx || !ctx.rawConfig || path[0] !== '/') return null;
    const i = path.indexOf('/', 1);
    if (i < 0 || decodeURIComponent(path.slice(1, i)) !== ctx.rawConfig) return null;
    return '/' + encodeURIComponent(newRaw) + path.slice(i);
  } catch (e) { return null; }
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
    const opt = BATCH_MODELS.find(x => x.model === (r.model || ''));
    const head = r.model ? r.head.concat(rtl('🧠 الموديل: ' + latin(opt ? opt.label : r.model))) : r.head;
    await startBatch({ chat: cq.message && cq.message.chat, messageId: cq.message && cq.message.message_id, targetId: r.targetId, head, track: t, count: r.count, model: r.model || '' });
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
const GAP_SMALL_MS = 5 * 60 * 1000;   // دفعة 4 حلقات او اقل
const GAP_BIG_MS = 10 * 60 * 1000;    // دفعة اكثر من 4 حلقات
function batchGapMs(count) { return (count || 0) <= 4 ? GAP_SMALL_MS : GAP_BIG_MS; }
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
        const tracks = await fetchTracks('series', nx.id, b.rawOverride).catch(() => null);
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
      b.nextAt = Date.now() + (res ? batchGapMs(b.count) : READY_GAP_MS);
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

async function startBatch({ chat, messageId, targetId, head, track, count, model }) {
  if (activeBatch) {
    if (chat) await tg('sendMessage', { chat_id: chat.id, text: rtl('في دفعة شغالة حالياً، اكتب /stop لإيقافها قبل ما تبدأ ثانية.') }).catch(() => {});
    return;
  }
  let rawOverride = '';
  let firstPath = track.path;
  if (model) {
    const fail = async why => { if (chat) await tg('sendMessage', { chat_id: chat.id, text: rtl('⚠️ ' + why + ' ما بدأت الدفعة، جرّب مرة ثانية.') }).catch(() => {}); };
    rawOverride = ctx && ctx.rawConfig ? configWithModel(ctx.rawConfig, model) : null;
    if (!rawOverride) { await fail('تعذر تبديل الموديل بإعدادك.'); return; }
    firstPath = swapPathConfig(track.path, rawOverride);
    if (!firstPath) {
      const tr = await fetchTracks(/^tt\d+$/.test(targetId) ? 'movie' : 'series', targetId, rawOverride).catch(() => null);
      const t2 = tr && tr.find(x => x.ext === track.ext && x.track === track.track);
      firstPath = t2 ? t2.path : '';
    }
    if (!firstPath) { await fail('تعذر تجهيز مسار التراك بالموديل المختار.'); return; }
  }
  const b = { chat, messageId, targetId, head, ext: track.ext, track: track.track, firstPath, count, model: model || '', rawOverride, lines: [], final: '', nextAt: 0, stopped: false, timer: null, wake: null };
  activeBatch = b;
  console.log('[دفعة] بدأت: ' + targetId + ' ' + b.ext.toUpperCase() + ' ' + b.track + ' × ' + count + (model ? ' | موديل ' + model : ''));
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

const FIND_MAX_RESULTS = 8;
const SMART_MAX = 7;
const MAX_FINDS = 50;
const MAX_RAW = 400;
const SMART_DEADLINE_MS = 45000;
const GEMINI_STEP_TIMEOUT_MS = 20000;
const CINEMETA_SEARCH_TIMEOUT_MS = 8000;
const CINEMETA_META_TIMEOUT_MS = 6000;
const ESCALATE_SIM = 0.72;
const RESOLVE_MIN_SIM = 0.6;
const POSTERS_MAX = 4;
const POSTERS_TIMEOUT_MS = 10000;
const POSTER_ALBUM_TIMEOUT_MS = 9000;
const POSTER_SINGLE_TIMEOUT_MS = 6000;
const DEFAULT_SEARCH_MODEL = 'gemini-3.1-flash-lite';
const finds = new Map();
let pendingEp = null;

const envList = v => String(v || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
const searchEnv = () => ({
  keys: envList(process.env.SEARCH_GEMINI_KEYS),
  model: String(settings.get('search_model') || '').trim(),
  grounding: !!settings.get('search_grounding')
});

const latinDigits = s => String(s == null ? '' : s).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
const hasArabic = s => /[\u0600-\u06FF]/.test(String(s || ''));
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const KIND_AR = { 'فلم': 'movie', 'فيلم': 'movie', 'افلام': 'movie', 'أفلام': 'movie', 'مسلسل': 'series', 'مسلسلات': 'series', 'انمي': 'anime', 'أنمي': 'anime' };
const KIND_EN = { movie: 'movie', film: 'movie', series: 'series', anime: 'anime' };
const DESC_CUE = /(اتذكر|أتذكر|ما اعرف|ما أعرف|نسيت|احداث|أحداث|قصة|قصته|قصتها|يحكي|يتحدث|تدور|بطولة|بطله|مشهد|ممثل|about a |about the |starring|plot|remember|forgot|scene)/i;
const IDLE_TEXT = /^(شكرا|شكراً|شكرًا|تمام|ok|okay|thanks|thx|هلا|هلو|مرحبا|اهلا|أهلا|سلام|السلام عليكم)$/i;

function parseFind(text) {
  const t = String(text || '').trim();
  const m = /^\/find(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t) || /^(?:بحث|ابحث)(?:\s+([\s\S]*))?$/.exec(t);
  return m ? { q: String(m[1] || '').trim() } : null;
}

function isPlainSearchText(text) {
  const t = String(text || '').trim();
  return !!t && t.length <= 600 && !t.startsWith('/') && /\p{L}/u.test(t) && !IDLE_TEXT.test(t);
}

function parseQuery(raw, max) {
  const s = latinDigits(raw).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 100);
  let kind = '';
  const rest = [];
  for (const w of s.split(' ').filter(Boolean)) {
    const k = KIND_AR[w];
    if (k && !kind) kind = k; else rest.push(w);
  }
  if (!kind && rest.length > 1 && KIND_EN[rest[0].toLowerCase()]) kind = KIND_EN[rest.shift().toLowerCase()];
  let year = 0;
  if (rest.length > 1) {
    const maxYear = new Date().getFullYear() + 2;
    for (let i = rest.length - 1; i >= 0; i--) {
      const ym = /^[(\[]?((?:19|20)\d{2})[)\]]?$/.exec(rest[i]);
      if (ym && +ym[1] <= maxYear) { year = +ym[1]; rest.splice(i, 1); break; }
    }
  }
  return { name: rest.join(' ').trim(), year, kind };
}

function parseEpisode(text) {
  const m = /^(?:s\s*)?(\d{1,3})\s*(?:[:,\-xXeE]|\s)\s*(?:e\s*)?(\d{1,4})$/i.exec(latinDigits(text).trim());
  if (!m) return null;
  const season = +m[1];
  const episode = +m[2];
  return season >= 1 && episode >= 1 ? { season, episode } : null;
}

function foldText(s) {
  return String(s || '').normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').replace(/^the /, '');
}

function osaDistance(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = [];
  for (let i = 0; i <= n; i++) { d[i] = new Array(m + 1); d[i][0] = i; }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}
const levSim = (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - osaDistance(a, b) / m : 1; };

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; m++; break; }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) if (ma[i]) { while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && l < la && l < lb && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

function trigramSim(a, b) {
  const grams = s => {
    const p = '  ' + s + ' ';
    const m = new Map();
    for (let i = 0; i + 3 <= p.length; i++) { const g = p.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = grams(a), B = grams(b);
  let inter = 0, sa = 0, sb = 0;
  for (const [g, c] of A) { sa += c; inter += Math.min(c, B.get(g) || 0); }
  for (const c of B.values()) sb += c;
  return sa + sb ? 2 * inter / (sa + sb) : 0;
}

const tokSim = (x, y) => (x === y ? 1 : Math.max(levSim(x, y), jaroWinkler(x, y)));

function nameSim(q, t) {
  const a = foldText(q), b = foldText(t);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const full = 0.4 * levSim(a, b) + 0.3 * jaroWinkler(a, b) + 0.3 * trigramSim(a, b);
  const bt = b.split(' ');
  let cover = 0;
  const at = a.split(' ');
  for (const x of at) { let best = 0; for (const y of bt) best = Math.max(best, tokSim(x, y)); cover += best; }
  cover /= at.length;
  return Math.min(1, 0.6 * full + 0.4 * cover);
}
const titleSim = (a, b) => Math.max(nameSim(a, b), 0.9 * nameSim(b, a));

function geminiCfg() {
  try {
    const d = JSON.parse(decodeURIComponent(ctx.rawConfig));
    return { keys: Array.isArray(d.keys) ? d.keys.filter(k => k && String(k).trim()) : [], model: d.model || DEFAULT_SEARCH_MODEL };
  } catch (e) {
    return { keys: [], model: '' };
  }
}

async function searchKeys() {
  const env = searchEnv();
  if (env.keys.length) {
    const cfgModel = (ctx && ctx.rawConfig) ? geminiCfg().model : '';
    return { keys: env.keys, model: env.model || cfgModel || DEFAULT_SEARCH_MODEL, src: 'env' };
  }
  if (!ctx) await loadCtx();
  if (!ctx || !ctx.rawConfig) return { keys: [], err: 'nocfg' };
  const c = geminiCfg();
  return { keys: c.keys, model: env.model || c.model || DEFAULT_SEARCH_MODEL, src: 'cfg', err: c.keys.length ? '' : 'nokeys' };
}

function cleanTitle(t) {
  let s = String(t || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  s = s.replace(/[`*"“”]/g, '').replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').replace(/\.$/, '').trim();
  return s && s.length <= 80 && !hasArabic(s) ? s : '';
}

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const i = s.search(/[\[{]/);
  if (i < 0) return null;
  const close = s[i] === '{' ? '}' : ']';
  const j = s.lastIndexOf(close);
  if (j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

const isGemini3Id = m => /^gemini-3/i.test(m) || /^gemini-(flash|flash-lite|pro)-latest$/i.test(m);

function genVariants(model, wantJson, grounded, temperature) {
  const base = { temperature };
  if (wantJson && !grounded) base.responseMimeType = 'application/json';
  if (!isGemini3Id(model)) return [base];
  return [
    Object.assign({}, base, { thinkingConfig: { thinkingLevel: 'low' } }),
    Object.assign({}, base, { thinkingConfig: { thinkingLevel: 'minimal' } }),
    base
  ];
}

const GROUNDING_QUOTA_COOLDOWN_MS = 20 * 60 * 1000;
let groundingBlockedUntil = 0;
const groundingBlockedMin = () => Math.max(0, Math.ceil((groundingBlockedUntil - Date.now()) / 60000));

async function searchGemini({ prompt, deadline, wantJson, grounding, temperature, thinking }) {
  const S = shared;
  if (!S || !S.acquireKey || !S.axios) return { err: 'nocfg' };
  const ks = await searchKeys();
  if (!ks.keys.length) return { err: ks.err || 'nokeys' };
  const model = S.normalizeGeminiModelId(ks.model);
  const url = S.DEFAULT_GEMINI_API_URL + '/models/' + model + ':generateContent';
  let vi = thinking === 'minimal' ? 1 : 0;
  let grounded = !!grounding && groundingBlockedMin() === 0;
  let why = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) return { err: 'busy', why };
    const key = await S.acquireKey(ks.keys, Math.min(8000, remaining));
    if (!key) return { err: 'busy', why };
    const variants = genVariants(model, wantJson, grounded, temperature == null ? 0.2 : temperature);
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: variants[Math.min(vi, variants.length - 1)], safetySettings: S.SAFETY_SETTINGS_OFF };
    if (grounded) body.tools = [{ google_search: {} }];
    try {
      const r = await S.axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(key).trim(), 'x-goog-api-client': S.GEMINI_CLIENT_HEADER },
        timeout: Math.min(GEMINI_STEP_TIMEOUT_MS, Math.max(remaining, 3000)), httpAgent: S.httpAgent, httpsAgent: S.httpsAgent
      });
      const parts = (r && r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
      const text = parts.map(p => (p && p.text) || '').join('');
      return text.trim() ? { text, grounded } : { err: 'empty' };
    } catch (e) {
      const st = (e && e.response && e.response.status) || 0;
      const em = String((e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || '').replace(/\s+/g, ' ').slice(0, 160);
      why = (st ? 'HTTP ' + st : 'timeout/شبكة') + ' | ' + model + (em ? ' | ' + em.slice(0, 70) : '');
      if (S.isGeminiAuthFailure(e)) { console.log('[بحث ذكي] مفتاح مرفوض ' + why); S.deadKeys.add(key); continue; }
      if (grounded) {
        grounded = false;
        if (st === 429) {
          const first = groundingBlockedMin() === 0;
          groundingBlockedUntil = Date.now() + GROUNDING_QUOTA_COOLDOWN_MS;
          if (first) console.log('[بحث ذكي] حصة البحث بجوجل خلصت (429) ⟵ أكمل بدونه، وأعيد المحاولة بعد ' + Math.round(GROUNDING_QUOTA_COOLDOWN_MS / 60000) + ' دقيقة.');
        } else {
          console.log('[بحث ذكي] تعذر البحث بجوجل (' + (st ? 'HTTP ' + st : 'timeout') + ') ⟵ أكمل بدونه.');
        }
        continue;
      }
      console.log('[بحث ذكي] ' + why);
      if (st === 404) return { err: 'config' };
      if (st === 400) {
        if (vi < variants.length - 1) { vi++; continue; }
        return { err: 'config' };
      }
      S.keyCooldowns.set(key, Date.now() + S.cooldownForStatus(st));
      await sleep(600);
    }
  }
  return { err: 'busy', why };
}

async function cinemetaSearch(type, q) {
  try {
    const r = await axios.get('https://v3-cinemeta.strem.io/catalog/' + type + '/top/search=' + encodeURIComponent(q) + '.json', { timeout: CINEMETA_SEARCH_TIMEOUT_MS });
    const metas = r && r.data && Array.isArray(r.data.metas) ? r.data.metas : [];
    return metas.filter(x => x && /^tt\d+$/.test(String(x.id || ''))).map(x => ({
      id: String(x.id), type, name: String(x.name || x.id), year: parseInt(String(x.releaseInfo || x.year || '').slice(0, 4), 10) || 0,
      poster: /^https:\/\//.test(String(x.poster || '')) ? String(x.poster) : ''
    }));
  } catch (e) {
    return null;
  }
}

async function fetchMetaBrief(type, id) {
  try {
    const r = await axios.get('https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json', { timeout: CINEMETA_META_TIMEOUT_MS });
    const m = r && r.data && r.data.meta;
    if (!m) return null;
    const arr = v => (Array.isArray(v) ? v : v ? [v] : []).map(String);
    return { genres: arr(m.genres).slice(0, 4), cast: arr(m.cast).slice(0, 8), director: arr(m.director).slice(0, 2), country: String(m.country || ''), description: String(m.description || '').slice(0, 350) };
  } catch (e) {
    return null;
  }
}

function mergeResults(lists, year) {
  const seen = new Set();
  const all = [];
  const max = Math.max(0, ...lists.map(l => (l || []).length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const x = l && l[i];
      if (x && !seen.has(x.id)) { seen.add(x.id); all.push(x); }
    }
  }
  if (!year) return { items: all.slice(0, FIND_MAX_RESULTS), yearMiss: false };
  const exact = all.filter(x => x.year === year);
  if (!exact.length) return { items: all.slice(0, FIND_MAX_RESULTS), yearMiss: true };
  return { items: exact.concat(all.filter(x => x.year !== year)).slice(0, FIND_MAX_RESULTS), yearMiss: false };
}

async function freeSearch(p) {
  const types = p.kind === 'movie' ? ['movie'] : p.kind === 'series' ? ['series'] : ['movie', 'series'];
  const lists = await Promise.all(types.map(t => cinemetaSearch(t, p.name)));
  return lists.every(l => l === null) ? null : mergeResults(lists, p.year);
}

async function understand(raw, p, deadline) {
  const env = searchEnv();
  const curYear = new Date().getFullYear();
  const hints = [p.kind ? 'type=' + p.kind : '', p.year ? 'year=' + p.year : ''].filter(Boolean).join(', ');
  const prompt = [
    'You are the search engine of a movie / TV series / anime lookup bot. The user wrote the message below in Arabic or English. It may contain typos, a partial title, a transliterated title, or a description from memory (plot, scenes, characters, actors, country, era).',
    'Task: identify up to ' + SMART_MAX + ' movies, TV series or anime this message most likely refers to, best match first.',
    'Rules:',
    '- Return REAL works only. Never invent a title. If you are not sure a work exists, leave it out or give it a low confidence.',
    '- "title" is the official English title as listed on IMDb (never a translation or transliteration of your own). For non-English works use the English release title on IMDb and put the original-language title in "original_title".',
    '- "year" is the first release year as an integer, or null if unsure. "type" is "movie" or "series" (anime TV = "series", anime film = "movie").',
    '- "confidence" is an integer 0-100: how likely this is the work the user means.',
    '- If the message names a work (even misspelled or incomplete), put that work first; add other works of the same franchise only if the name is ambiguous.',
    '- If it describes plot / actors / scenes, rank by how well each work fits ALL the clues together, not just one clue.',
    '- Respect the user hints (type, year) when given.',
    '- If the message holds too little information to identify anything (for example just "an action movie"), return vague=true and an empty list.',
    '- "mode" is "title" when the user is trying to type a name, or "description" when they describe the work.',
    'Output ONLY JSON, no commentary: {"mode":"title","vague":false,"candidates":[{"title":"","original_title":"","year":2020,"type":"movie","confidence":90}]}',
    'Today\'s date: ' + new Date().toISOString().slice(0, 10),
    hints ? 'User hints: ' + hints : '',
    'User message: <<<' + raw + '>>>'
  ].filter(Boolean).join('\n');
  const descLike = DESC_CUE.test(raw) || String(raw).split(/\s+/).filter(Boolean).length >= 7;
  const r = await searchGemini({ prompt, deadline, wantJson: true, grounding: env.grounding, temperature: 0.2, thinking: descLike ? '' : 'minimal' });
  if (!r.text) return { err: r.err || 'empty', why: r.why || '' };
  const j = extractJson(r.text);
  if (!j || typeof j !== 'object') return { err: 'empty' };
  const arr = Array.isArray(j) ? j : (Array.isArray(j.candidates) ? j.candidates : []);
  const seen = new Set();
  const cands = [];
  for (const c of arr) {
    const title = cleanTitle(c && c.title);
    if (!title) continue;
    const y = Math.round(Number(c.year));
    const year = y >= 1880 && y <= curYear + 2 ? y : 0;
    const key = foldText(title) + '|' + year;
    if (seen.has(key)) continue;
    seen.add(key);
    const conf = Number(c.confidence);
    cands.push({ title, original: cleanTitle(c.original_title), year, type: c.type === 'movie' || c.type === 'series' ? c.type : '', confidence: Number.isFinite(conf) ? clamp(conf, 0, 100) : 50 });
  }
  cands.sort((a, b) => b.confidence - a.confidence);
  return { mode: j.mode === 'description' ? 'description' : 'title', vague: !!j.vague || !cands.length, cands: cands.slice(0, SMART_MAX), grounded: !!r.grounded };
}

async function resolveCandidate(c) {
  const types = c.type ? [c.type] : ['movie', 'series'];
  const qs = [c.title];
  const main = c.title.split(/\s*[:\-–—]\s*/)[0].trim();
  if (main.length >= 3 && main !== c.title) qs.push(main);
  if (c.original && c.original !== c.title) qs.push(c.original);
  for (const q of qs) {
    const lists = await Promise.all(types.map(t => cinemetaSearch(t, q)));
    let best = null;
    for (const l of lists) {
      for (const x of (l || [])) {
        const sim = titleSim(c.title, x.name);
        if (sim < RESOLVE_MIN_SIM) continue;
        const yd = c.year && x.year ? Math.abs(c.year - x.year) : null;
        if (yd !== null && yd > 2 && sim < 0.9) continue;
        const score = sim * 0.75 + (yd === null ? 0.5 : yd === 0 ? 1 : yd === 1 ? 0.5 : 0) * 0.25;
        if (!best || score > best.score) best = { x, score };
      }
    }
    if (best) return Object.assign({}, best.x, { c1: c.confidence });
  }
  return null;
}

async function compareByDescription(raw, items, deadline) {
  const metas = await Promise.all(items.map(x => fetchMetaBrief(x.type, x.id)));
  const pack = items.map((x, i) => Object.assign({ id: x.id, type: x.type, title: x.name, year: x.year || null }, metas[i] || {}));
  const prompt = [
    'A user is trying to remember a movie / TV series / anime. Their description (Arabic or English):',
    '<<<' + raw + '>>>',
    'Below are candidate works with data from a database (JSON). For EACH candidate, score 0-100 how well it matches ALL the clues in the description (plot, characters, actors, year, country, genre). Use the data given plus your own knowledge. A clue that contradicts the work (wrong actor, wrong era, wrong country) is a strong negative; a clue that fits is a positive. Do not reward a candidate just for being famous.',
    'Output ONLY JSON, no commentary: [{"id":"tt...","score":85,"why":"<= 12 words in Arabic"}]',
    'Candidates: ' + JSON.stringify(pack)
  ].join('\n');
  const r = await searchGemini({ prompt, deadline, wantJson: true, grounding: false, temperature: 0 });
  if (!r.text) return null;
  const j = extractJson(r.text);
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.results) ? j.results : null);
  if (!arr) return null;
  const ids = new Set(items.map(x => x.id));
  const out = new Map();
  for (const e of arr) {
    const id = String(e && e.id || '');
    const sc = Number(e && e.score);
    if (ids.has(id) && Number.isFinite(sc)) out.set(id, { score: clamp(sc, 0, 100), why: trunc(String(e.why || '').replace(/\s+/g, ' ').trim(), 70) });
  }
  return out.size ? out : null;
}

function rankItems(resolved, cmp, p, mode) {
  const latinQ = mode === 'title' && !hasArabic(p.name) ? p.name : '';
  const scored = resolved.map(x => {
    const c3 = cmp && cmp.has(x.id) ? cmp.get(x.id).score : null;
    const sim = latinQ ? nameSim(latinQ, x.name) : null;
    const parts = [[c3 != null ? 0.35 : 0.65, x.c1]];
    if (c3 != null) parts.push([0.5, c3]);
    if (sim != null) parts.push([c3 != null ? 0.15 : 0.35, sim * 100]);
    let s = parts.reduce((a, q) => a + q[0] * q[1], 0) / parts.reduce((a, q) => a + q[0], 0);
    if (p.year && x.year) { const d = Math.abs(p.year - x.year); s += d === 0 ? 8 : d === 1 ? 3 : -12; }
    if ((p.kind === 'movie' || p.kind === 'series') && x.type !== p.kind) s -= 40;
    return Object.assign({}, x, { score: clamp(Math.round(s), 0, 100), why: c3 != null ? cmp.get(x.id).why : '' });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SMART_MAX);
}

const SMART_FAIL = {
  nokeys: 'ما لقيت مفاتيح جمناي للبحث (لا بمتغير SEARCH_GEMINI_KEYS ولا بإعداداتك). اكتب الاسم بالإنجليزي.',
  nocfg: 'ما عندي إعداداتك بالذاكرة (السيرفر تو اشتغل). افتح أي حلقة من Nuvio مرة وحدة، أو اكتب الاسم بالإنجليزي.',
  busy: 'مفاتيح جمناي مشغولة حالياً، جرّب بعد شوي أو اكتب الاسم بالإنجليزي.',
  config: 'الموديل المحفوظ ما قبل الطلب، غيّره أو اكتب الاسم بالإنجليزي.',
  empty: 'ما كدرت أفهم الطلب، جرّب صياغة ثانية أو اكتب الاسم بالإنجليزي.'
};

async function sendPosters(chatId, items) {
  const pics = items.map((x, i) => ({ x, i })).filter(o => o.x.poster).slice(0, POSTERS_MAX);
  if (!pics.length) return;
  const cap = o => (o.i + 1) + '. ' + trunc(o.x.name, 80) + (o.x.year ? ' (' + o.x.year + ')' : '');
  try {
    if (pics.length === 1) await tg('sendPhoto', { chat_id: chatId, photo: pics[0].x.poster, caption: cap(pics[0]) }, POSTER_ALBUM_TIMEOUT_MS, false);
    else await tg('sendMediaGroup', { chat_id: chatId, media: pics.map(o => ({ type: 'photo', media: o.x.poster, caption: cap(o) })) }, POSTER_ALBUM_TIMEOUT_MS, false);
  } catch (e) {
    if (/timeout|ECONNABORTED/i.test(String(e && e.message))) return;
    for (const o of pics) await tg('sendPhoto', { chat_id: chatId, photo: o.x.poster, caption: cap(o) }, POSTER_SINGLE_TIMEOUT_MS, false).catch(() => {});
  }
}

async function showResults(chatId, o) {
  const { items, p, raw, smart, canSmart, mode } = o;
  const desc = smart && mode === 'description';
  const tags = [{ movie: 'فلم', series: 'مسلسل', anime: 'أنمي' }[p.kind] || '', p.year ? String(p.year) : ''].filter(Boolean);
  const out = [];
  if (desc) out.push(rtl('🧠 رشحت لك حسب وصفك (الأقرب أول):'));
  else out.push(rtl('🔎 نتائج ' + latin('«' + (smart && hasArabic(p.name) ? items[0].name : p.name) + '»') + (tags.length ? ' (' + tags.join(' · ') + ')' : '')));
  if (smart && !desc && hasArabic(p.name) && p.name.length <= 40) out.push(rtl('🌐 ' + p.name + ' ← ' + latin(items[0].name)));
  if (o.yearMiss) out.push(rtl('ما لقيت بسنة ' + p.year + '، هذي أقرب النتائج:'));
  if (o.note) out.push(rtl(o.note));
  if (desc) {
    items.forEach((x, i) => out.push(rtl((i + 1) + '. ' + (x.score >= 75 ? '✅' : x.score >= 50 ? '🔸' : '▫️') + ' ' + latin(x.name + (x.year ? ' (' + x.year + ')' : '')) + (x.why ? ' — ' + x.why : ''))));
    out.push(rtl('✅ قوي · 🔸 محتمل · ▫️ ضعيف'));
  }
  out.push(rtl('🎬 فلم · 📺 مسلسل. اختر العمل الصحيح:'));
  const h = crypto.createHash('sha1').update(raw + ':' + Date.now()).digest('hex').slice(0, 8);
  finds.set(h, { items, at: Date.now(), raw });
  while (finds.size > MAX_FINDS) finds.delete(finds.keys().next().value);
  const rows = items.map((x, i) => [{ text: (i + 1) + '· ' + (x.type === 'movie' ? '🎬 ' : '📺 ') + trunc(x.name, 34) + (x.year ? ' · ' + x.year : ''), callback_data: 'fd:' + h + ':' + i }]);
  if (canSmart && !smart) rows.push([{ text: '🧠 بحث أذكى (وصف/تصحيح أخطاء)', callback_data: 'fs:' + h }]);
  await withTimeout(sendPosters(chatId, items), POSTERS_TIMEOUT_MS);
  await tg('sendMessage', { chat_id: chatId, text: out.join('\n'), reply_markup: { inline_keyboard: rows }, disable_web_page_preview: true });
}

async function runSearch(chatId, rawIn, opts) {
  opts = opts || {};
  const send = (text, markup) => tg('sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });
  let waitId = 0;
  const clearWait = async () => {
    if (!waitId) return;
    const id = waitId;
    waitId = 0;
    await tg('deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
  };
  try {
    pendingEp = null;
    const raw = String(rawIn || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_RAW);
    const p = parseQuery(raw, MAX_RAW);
    if (!p.name) {
      await send([rtl('🔎 البحث بالاسم أو بالوصف'), rtl('اكتب اسم الفلم أو المسلسل، أو وصفاً لما تتذكره، مثل:'), latin('spider man 2026'), rtl('فلم سبايدر مان 2026'), rtl('اتذكر فلم عن شاب يعضه عنكبوت ويتسلق الجدران')].join('\n'));
      return;
    }
    const deadline = Date.now() + SMART_DEADLINE_MS;
    const ks = (await withTimeout(searchKeys(), 4000)) || { keys: [], err: 'nocfg' };
    const canSmart = ks.keys.length > 0;
    const words = p.name.split(' ').length;
    const wantSmart = !!opts.forceSmart || hasArabic(raw) || words >= 7 || DESC_CUE.test(raw);
    let free = null;
    if (!wantSmart) {
      free = await freeSearch(p);
      if (free && free.items.length) {
        const best = Math.max(...free.items.map(x => nameSim(p.name, x.name)));
        if (best >= ESCALATE_SIM || !canSmart) {
          console.log('[بحث] مباشر من Cinemeta (' + free.items.length + ' نتيجة، أفضل تشابه ' + best.toFixed(2) + ')');
          await showResults(chatId, { items: free.items, p, raw, smart: false, canSmart, yearMiss: free.yearMiss });
          return;
        }
        console.log('[بحث] التشابه ضعيف (' + best.toFixed(2) + ') ⟵ أنتقل للبحث الذكي');
      } else if (!canSmart) {
        await send(free === null ? rtl('⚠️ تعذر الاتصال بمصدر البحث (Cinemeta)، جرّب بعد شوي.') : rtl('ما لقيت نتائج لـ ' + latin('«' + p.name + '»')) + '\n' + rtl('جرّب اسم ثاني، أو أضف مفاتيح جمناي للبحث حتى يفهم الوصف والأخطاء.'));
        return;
      }
    }
    if (!canSmart) { await send(rtl('⚠️ ' + SMART_FAIL[ks.err === 'nocfg' ? 'nocfg' : 'nokeys'])); return; }

    const wait = await send(rtl('🧠 جاري البحث الذكي...'));
    waitId = (wait && wait.message_id) || 0;
    const fallbackFree = async note => {
      await clearWait();
      await showResults(chatId, { items: free.items, p, raw, smart: false, canSmart: false, yearMiss: free.yearMiss, note });
    };
    const u = await understand(raw, p, deadline);
    if (u.err) {
      console.log('[بحث ذكي] فشل الفهم: ' + u.err + (u.why ? ' | ' + u.why : ''));
      if (free && free.items.length) { await fallbackFree('تعذر البحث الذكي، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send(rtl('⚠️ ' + (SMART_FAIL[u.err] || SMART_FAIL.empty)) + (u.why ? '\n' + rtl('🔎 السبب:') + ' ' + latin(u.why) : ''));
      return;
    }
    if (u.vague) {
      console.log('[بحث ذكي] الطلب عام/غير محدد');
      if (free && free.items.length) { await fallbackFree('ما كدرت أفهم الطلب أكثر، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send([rtl('🧠 ما كدرت أحدد العمل، المعلومات قليلة.'), rtl('أضف أي من هذي: اسم ممثل، سنة تقريبية، حدث أو مشهد مميز، بلد أو لغة، أو نوعه (فلم / مسلسل / أنمي).')].join('\n'));
      return;
    }
    const resolvedAll = (await Promise.all(u.cands.map(c => resolveCandidate(c)))).filter(Boolean);
    const byId = new Map();
    for (const x of resolvedAll) if (!byId.has(x.id) || byId.get(x.id).c1 < x.c1) byId.set(x.id, x);
    const resolved = [...byId.values()];
    console.log('[بحث ذكي] الوضع=' + u.mode + ' | مرشحين=' + u.cands.length + ' | تحقق منهم=' + resolved.length + (u.grounded ? ' | grounding' : ''));
    if (!resolved.length) {
      if (free && free.items.length) { await fallbackFree('جمناي ما لقى شي أدق، هذي نتائج البحث العادي:'); return; }
      await clearWait();
      await send([rtl('جمناي رجّح هذي الأعمال، بس ما لقيتها بـ Cinemeta:'), ...u.cands.map(c => rtl('• ' + latin(c.title + (c.year ? ' (' + c.year + ')' : '')))), rtl('جرّب تكتب الاسم بالإنجليزي أو أضف تفاصيل.')].join('\n'));
      return;
    }
    let cmp = null;
    if (u.mode === 'description' && resolved.length >= 2 && deadline - Date.now() > 8000) cmp = await compareByDescription(raw, resolved, deadline).catch(() => null);
    if (u.mode === 'description') console.log('[بحث ذكي] مقارنة الأوصاف: ' + (cmp ? cmp.size + ' نتيجة' : 'تعذرت (أكمل بترتيب جمناي الأول)'));
    const items = rankItems(resolved, cmp, p, u.mode);
    await clearWait();
    await showResults(chatId, { items, p, raw, smart: true, canSmart, mode: u.mode });
  } catch (e) {
    logErr('خطأ بالبحث', e);
    await clearWait();
    try { await send(rtl('⚠️ صار خطأ أثناء البحث، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

const onFind = runSearch;

async function askEpisode(chatId, it) {
  pendingEp = { imdb: it.id, name: it.name, at: Date.now() };
  const lines = [rtl('📺 ' + latin(it.name) + (it.year ? ' ' + latin('(' + it.year + ')') : '') + ' ' + latin('(' + it.id + ')')),
    rtl('هذا مسلسل، ابعث الموسم والحلقة مثل:'), latin('1 5')];
  const meta = await getMeta(it.id);
  if (meta && meta.all.size) {
    const ss = [...meta.all.keys()].sort((a, b) => a - b);
    lines.push(rtl('المواسم المتوفرة (موسم:حلقات):'));
    lines.push(latin(ss.slice(0, 15).map(s => s + ':' + meta.all.get(s)).join('  ') + (ss.length > 15 ? '  …' : '')));
  }
  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true });
}

async function onFindCallback(cq) {
  const m = /^fd:([0-9a-f]{8}):(\d+)$/.exec(String(cq.data || ''));
  const f = m && finds.get(m[1]);
  const it = f && f.items[+m[2]];
  if (!it) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث البحث من جديد'); return; }
  if (!ctx) await loadCtx();
  if (!ctx) { await answerCb(cq, 'افتح حلقة من Nuvio مرة وحدة أول'); return; }
  const chatId = cq.message.chat.id;
  if (it.type === 'movie') {
    await answerCb(cq, 'جاري جلب التراكات...');
    await onRequest(chatId, { imdb: it.id, targetId: it.id }, takeCount());
    return;
  }
  await answerCb(cq);
  await askEpisode(chatId, it);
}

async function onSmartCallback(cq) {
  const m = /^fs:([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const f = m && finds.get(m[1]);
  if (!f) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث البحث من جديد'); return; }
  await answerCb(cq, 'جاري البحث الذكي...');
  await runSearch(cq.message.chat.id, f.raw, { forceSmart: true });
}

async function onEpisodeReply(chatId, er) {
  const p = pendingEp;
  if (!p) return;
  const meta = await getMeta(p.imdb);
  if (meta && meta.all.size && !meta.all.has(er.season)) {
    const ss = [...meta.all.keys()].sort((a, b) => a - b);
    await tg('sendMessage', { chat_id: chatId, text: [rtl('الموسم ' + er.season + ' مو موجود لهذا المسلسل.'), rtl('المواسم المتوفرة: ' + latin(ss.join(', '))), rtl('ابعث الموسم والحلقة من جديد.')].join('\n') }).catch(() => {});
    return;
  }
  pendingEp = null;
  await onRequest(chatId, { imdb: p.imdb, season: er.season, episode: er.episode, targetId: p.imdb + ':' + er.season + ':' + er.episode }, takeCount());
}

const isClearCmd = t => /^\/clear(@\w+)?$/i.test(t) || /^(امسح|مسح) (آخر|اخر) حلقة$/.test(t);
const isBatchCmd = t => /^\/batch(@\w+)?$/i.test(t) || t === 'دفعة';
const isOrderCmd = t => /^\/order(@\w+)?$/i.test(t) || t === 'مسح الترتيب' || t === 'امسح الترتيب';
const isStopCmd = t => /^\/stop(@\w+)?$/i.test(t) || t === 'ايقاف' || t === 'إيقاف';
const isPanelCmd = t => /^\/(panel|start)(@\w+)?$/i.test(t) || t === 'لوحة' || t === 'لوحة التحكم' || /^panel$/i.test(t);

// ===== الإعدادات: تتغير من هنا وتنحفظ بـ Mongo (تعديل تلغرام ← متغير ريندر ← الافتراضي) =====
const SLOT_CHOICES = settings.ASS_SLOT_CHOICES;
const SRT_CHOICES = settings.SRT_SLOT_CHOICES;
const SLOT_FIX = { subs: 'subsource', wyz: 'wyzie', wiz: 'wyzie', legacy: 'org', os_legacy: 'org', oscom: 'com', mirror: 'os', opensubtitles: 'os', '*': 'any' };
const SLOT_LABEL = { subsource: 'subsrc' };
const slotLabel = n => SLOT_LABEL[n] || n;
const MODEL_PRESETS = [
  { id: 'gemini-3.5-flash-lite', label: '3.5 lite' },
  { id: 'gemini-3.5-flash', label: '3.5 flash' },
  { id: 'gemini-3.1-flash-lite', label: '3.1 lite' },
  { id: '', label: 'موديل الإضافة' }
];
const SRC_NAME = { tg: 'من تلغرام', env: 'من ريندر', def: 'افتراضي' };
const isSettingsCmd = t => /^\/(settings|setting)(@\w+)?$/i.test(t) || t === 'الاعدادات' || t === 'الإعدادات' || t === 'اعدادات';
const slotsCmd = t => { const m = /^\/slots(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t); return m ? String(m[1] || '').trim() : null; };
const srtSlotsCmd = t => { const m = /^\/srtslots(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t); return m ? String(m[1] || '').trim() : null; };

function currentSlots(key = 'ass_slots') {
  const toks = String(settings.get(key) || '').split(/[\s,;|]+/).filter(Boolean).slice(0, 4).map(t => {
    const l = t.toLowerCase();
    return SLOT_FIX[l] || l;
  });
  while (toks.length < 4) toks.push('any');
  return toks;
}

function settingsText() {
  const slots = String(settings.get('ass_slots') || '').trim() ? currentSlots() : [];
  const srtS = String(settings.get('srt_slots') || '').trim() ? currentSlots('srt_slots') : [];
  const onOff = v => (v ? 'شغّال ✅' : 'مطفأ ⛔');
  const model = String(settings.get('search_model') || '').trim();
  const L = [];
  L.push(rtl('⚙️ الإعدادات'));
  L.push(rtl('🎞 ترتيب ASS (' + SRC_NAME[settings.source('ass_slots')] + '): ') + (slots.length ? latin(slots.join(', ')) : rtl('الترتيب الافتراضي')));
  L.push(rtl('📄 ترتيب SRT (' + SRC_NAME[settings.source('srt_slots')] + '): ') + (srtS.length ? latin(srtS.join(', ')) : rtl('الترتيب الافتراضي')));
  L.push(rtl('🔎 موديل البحث (' + SRC_NAME[settings.source('search_model')] + '): ') + (model ? latin(model) : rtl('موديل الإضافة')));
  L.push(rtl('🌐 البحث بجوجل (' + SRC_NAME[settings.source('search_grounding')] + '): ' + onOff(settings.get('search_grounding'))) + (settings.get('search_grounding') && groundingBlockedMin() > 0 ? rtl(' ⏳ الحصة خلصت، يرجع بعد ') + latin(groundingBlockedMin() + '') + rtl(' دقيقة') : ''));
  L.push(rtl('⏭ تخطي الحشو (' + SRC_NAME[settings.source('filler_skip')] + '): ' + onOff(settings.get('filler_skip'))));
  L.push(rtl('🤖 عرض AI دائماً (' + SRC_NAME[settings.source('show_ai_always')] + '): ' + onOff(settings.get('show_ai_always'))));
  L.push('');
  L.push(rtl('الترتيب يشمل الحلقات الجديدة فقط، والمثبتة تحتاج /clear.'));
  L.push(rtl('أو اكتب مثلاً: ') + latin('/slots subdl,subsource,wyzie,any'));
  L.push(rtl('وللـ SRT: ') + latin('/srtslots subdl,subsource,os,com'));
  L.push(rtl('المواقع: ') + latin(SRT_CHOICES.join(', ')));
  return L.join('\n');
}

function settingsKeyboard() {
  const slots = currentSlots();
  const srtSlots = currentSlots('srt_slots');
  const model = String(settings.get('search_model') || '').trim();
  const tgl = (label, v, op) => ({ text: label + ': ' + (v ? 'شغّال' : 'مطفأ'), callback_data: 'st:' + op });
  const rows = [];
  rows.push(slots.map((n, i) => ({ text: (i + 1) + ': ' + slotLabel(n), callback_data: 'st:s:' + i })));
  rows.push([{ text: '↩️ ترتيب ASS الافتراضي', callback_data: 'st:sd' }]);
  rows.push(srtSlots.map((n, i) => ({ text: 'SRT ' + (i + 1) + ': ' + slotLabel(n), callback_data: 'st:r:' + i })));
  rows.push([{ text: '↩️ ترتيب SRT الافتراضي', callback_data: 'st:rd' }]);
  const mp = MODEL_PRESETS.map((m, i) => ({ text: (m.id === model ? '✅ ' : '') + m.label, callback_data: 'st:m:' + i }));
  rows.push(mp.slice(0, 2), mp.slice(2));
  rows.push([tgl('🌐 البحث بجوجل', settings.get('search_grounding'), 'g')]);
  rows.push([tgl('⏭ تخطي الحشو', settings.get('filler_skip'), 'f'), tgl('🤖 AI دائماً', settings.get('show_ai_always'), 'a')]);
  return { inline_keyboard: rows };
}

async function sendSettings(chatId) {
  await tg('sendMessage', { chat_id: chatId, text: settingsText(), reply_markup: settingsKeyboard(), disable_web_page_preview: true });
}

async function onSettingsCallback(cq) {
  const parts = String(cq.data || '').split(':');
  const op = parts[1];
  const arg = parts[2];
  let r = null;
  let note = 'تم ✅';
  if (op === 's') {
    const i = clamp(parseInt(arg, 10) || 0, 0, 3);
    const cur = currentSlots().map(x => (SLOT_CHOICES.includes(x) ? x : 'any'));
    cur[i] = SLOT_CHOICES[(SLOT_CHOICES.indexOf(cur[i]) + 1) % SLOT_CHOICES.length];
    r = await settings.set('ass_slots', cur.join(','));
  } else if (op === 'r') {
    const i = clamp(parseInt(arg, 10) || 0, 0, 3);
    const cur = currentSlots('srt_slots').map(x => (SRT_CHOICES.includes(x) ? x : 'any'));
    cur[i] = SRT_CHOICES[(SRT_CHOICES.indexOf(cur[i]) + 1) % SRT_CHOICES.length];
    r = await settings.set('srt_slots', cur.join(','));
  } else if (op === 'rd') {
    r = await settings.clear('srt_slots');
  } else if (op === 'sd') {
    r = await settings.clear('ass_slots');
  } else if (op === 'm') {
    const m = MODEL_PRESETS[clamp(parseInt(arg, 10) || 0, 0, MODEL_PRESETS.length - 1)];
    r = await settings.set('search_model', m.id);
  } else if (op === 'g') {
    r = await settings.set('search_grounding', !settings.get('search_grounding'));
  } else if (op === 'f') {
    r = await settings.set('filler_skip', !settings.get('filler_skip'));
  } else if (op === 'a') {
    r = await settings.set('show_ai_always', !settings.get('show_ai_always'));
  } else {
    await answerCb(cq);
    return;
  }
  if (r && r.ok && r.saved === false) note = '⚠️ اشتغل لكن ما انحفظ بالقاعدة (يرجع للقديم بعد إعادة التشغيل)';
  await editMsg(cq.message, settingsText(), settingsKeyboard());
  await answerCb(cq, note);
}

async function onSlotsCmd(chatId, arg, key = 'ass_slots') {
  const choices = key === 'srt_slots' ? SRT_CHOICES : SLOT_CHOICES;
  if (!arg) { await sendSettings(chatId); return; }
  if (/^(default|reset|افتراضي)$/i.test(arg)) {
    await settings.clear(key);
  } else {
    const r = await settings.set(key, arg);
    if (!r.ok) {
      await tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ أسماء غير معروفة: ') + latin((r.bad || []).join(', ') || arg) + '\n' + rtl('المسموح: ') + latin(choices.join(', ')) });
      return;
    }
  }
  await sendSettings(chatId);
}

let searchBusy = false;
let lastSearch = Promise.resolve();

function startSearch(fn) {
  if (searchBusy) return false;
  searchBusy = true;
  lastSearch = Promise.resolve().then(fn).catch(e => logErr('خطأ بالبحث', e)).finally(() => { searchBusy = false; });
  return true;
}

const SEARCH_BUSY_TEXT = '⏳ في بحث شغال هسة، انتظر ينتهي وبعدها ابعث الجديد.';

async function handleUpdate(u) {
  try {
    const cq = u && u.callback_query;
    const msg = cq ? cq.message : (u && u.message);
    const chatId = msg && msg.chat && msg.chat.id;
    if (chatId == null || String(chatId) !== TG_CHAT) return;
    const data = String((cq && cq.data) || '');
    if (cq && /^go:/.test(data)) return await onGoCallback(cq);
    if (cq && /^fd:/.test(data)) return await onFindCallback(cq);
    if (cq && /^fs:/.test(data)) {
      if (!startSearch(() => onSmartCallback(cq))) await answerCb(cq, SEARCH_BUSY_TEXT);
      return;
    }
    if (cq && /^st:/.test(data)) return await onSettingsCallback(cq);
    if (cq && /^bn:/.test(data)) return await onCountCallback(cq);
    if (cq && /^bm:/.test(data)) return await onModelCallback(cq);
    if (cq && /^od:/.test(data)) return await onOrderCallback(cq);
    if (cq && /^rt:/.test(data)) return await onRetryCallback(cq);
    if (cq) return await onPanelCallback(cq);
    const text = String((u.message && u.message.text) || '').trim();
    const rq = parseRequest(text);
    const fq = rq ? null : parseFind(text);
    const er = (!rq && !fq && pendingEp && Date.now() - pendingEp.at < PENDING_TTL_MS) ? parseEpisode(text) : null;
    const po = pendingOrder && Date.now() - pendingOrder.at < PENDING_TTL_MS;
    if (rq && po) await onOrderTarget(chatId, rq);
    else if (rq) { pendingEp = null; await onRequest(chatId, rq, takeCount()); }
    else if (fq) { if (!startSearch(() => onFind(chatId, fq.q))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {}); }
    else if (er) await onEpisodeReply(chatId, er);
    else if (slotsCmd(text) !== null) await onSlotsCmd(chatId, slotsCmd(text));
    else if (srtSlotsCmd(text) !== null) await onSlotsCmd(chatId, srtSlotsCmd(text), 'srt_slots');
    else if (isSettingsCmd(text)) await sendSettings(chatId);
    else if (isBatchCmd(text)) await askCount(chatId);
    else if (isOrderCmd(text)) await askOrder(chatId);
    else if (isStopCmd(text)) await stopBatch(chatId);
    else if (isClearCmd(text)) await sendAskClear(chatId);
    else if (isPanelCmd(text)) await sendPanel(chatId);
    else if (isPlainSearchText(text)) { if (!startSearch(() => onFind(chatId, text))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {}); }
  } catch (e) {
    logErr('خطأ بمعالجة أمر', e);
  }
}

let running = false;
let stopped = false;

async function loop() {
  let offset = 0, fails = 0, drained = false;
  tg('setMyCommands', { commands: [{ command: 'find', description: 'ابحث عن فلم أو مسلسل بالاسم' }, { command: 'panel', description: 'لوحة التحكم' }, { command: 'settings', description: 'الإعدادات (ترتيب ASS وSRT، البحث، الحشو)' }, { command: 'clear', description: 'امسح ترجمة آخر حلقة' }, { command: 'batch', description: 'جهّز دفعة حلقات (4/6/8/10)' }, { command: 'order', description: 'امسح ترتيب تراكات حلقة' }, { command: 'stop', description: 'أوقف الدفعة الشغالة' }] }).catch(() => {});
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
  console.log('[بوت التحكم] تيليغرام يسمع أوامرك ⟵ ابعث /find أو /panel أو /clear.');
  startDbWatch();
  loop().catch(() => { running = false; });
}

function stop() { stopped = true; }

loadCtx().catch(() => {});

module.exports = {
  start, stop, noteTrack, noteContext, onDrop, enabled: ENABLED,
  _t: { sendSettings, onSettingsCallback, onSlotsCmd, settingsText, settingsKeyboard, currentSlots, handleUpdate, keyOf, hashOf, panels, sendPanel, parseRequest, fetchTracks, startPath, leftInSeason, nextOf, getMeta, clearEpisode, clearTrack, clearOrder, configWithModel, swapPathConfig, trackRows, askOrder, onOrderTarget, orderAsks, getPendingOrder: () => pendingOrder, checkDbSize, reqs, finds, parseFind, parseQuery, parseEpisode, isPlainSearchText, cinemetaSearch, mergeResults, nameSim, foldText, osaDistance, jaroWinkler, trigramSim, extractJson, rankItems, onFind, getPendingEp: () => pendingEp, idle: () => lastSearch, isSearchBusy: () => searchBusy, getCtx: () => ctx, isBatchActive: () => !!activeBatch }
};
