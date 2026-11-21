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
const search = require('./tgsearch');
const getter = require('./tgget');
const { finds, latinDigits, clamp, maskKey, groundingBlockedMin, onFindCallback, onSmartCallback, IMAGE_MIMES, onImage, serpKeyCmd, onSerpKeyCmd, actorCmd, onActor, parseFind, parseEpisode, onFind, isPlainSearchText, parseQuery, cinemetaSearch, mergeResults, nameSim, foldText, osaDistance, jaroWinkler, trigramSim, extractJson, rankItems } = search;
const { seriesInfoFromTarget, bookKey } = require('./name-book');

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

let pendingPurge = null;
let purgeAsk = null;
const BAGHDAD_OFFSET_MS = 3 * 3600 * 1000;
const PURGE_KINDS = {
  t: { name: 'ترجمات الحساب الأساسي', what: 'كاش الأسطر ونتائج التراكات المترجمة', statKey: 'primary' },
  k: { name: 'تراكات الحساب الثاني', what: 'ملفات التراكات الخام', statKey: 'tracks' }
};

function parsePurgeDates(text) {
  const t = latinDigits(String(text || '')).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s*(?:الى|إلى|to|[-–—>→])?\s*(\d{4})-(\d{1,2})-(\d{1,2}))?$/i.exec(t);
  if (!m) return null;
  const mk = (y, mo, d) => {
    const x = new Date(Date.UTC(+y, +mo - 1, +d));
    return x.getUTCFullYear() === +y && x.getUTCMonth() === +mo - 1 && x.getUTCDate() === +d ? x : null;
  };
  const a = mk(m[1], m[2], m[3]);
  const b = m[4] ? mk(m[4], m[5], m[6]) : a;
  if (!a || !b) return null;
  const from = a.getTime() - BAGHDAD_OFFSET_MS;
  const to = b.getTime() + 24 * 3600 * 1000 - BAGHDAD_OFFSET_MS;
  if (!(from < to)) return null;
  const f = x => x.toISOString().slice(0, 10);
  return { from: new Date(from), to: new Date(to), fromStr: f(a), toStr: f(b) };
}

async function askPurge(chatId) {
  pendingPurge = null; purgeAsk = null;
  await tg('sendMessage', {
    chat_id: chatId,
    text: [rtl('🧹 مسح بيانات بتاريخ'), rtl('اختر شنو تمسح (الباقي كله ما ينمس ويبقى حسب مدته):')].join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '🗑 مسح ترجمات (الحساب الأساسي)', callback_data: 'pg:t' }],
      [{ text: '🗑 مسح تراكات (الحساب الثاني)', callback_data: 'pg:k' }],
      [{ text: 'إلغاء', callback_data: 'pg:n' }]
    ] }
  }).catch(() => {});
}

async function onPurgeDates(chatId, r) {
  const k = PURGE_KINDS[pendingPurge.kind];
  const kind = pendingPurge.kind;
  pendingPurge = null;
  const cnt = await db.purgeRange(kind === 'k' ? 'tracks' : 'translations', r.from, r.to, true);
  if (!cnt) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ ما قدرت أوصل لقاعدة البيانات، جرّب مرة ثانية.') }).catch(() => {});
    return;
  }
  const total = cnt.docs + cnt.maps;
  const range = r.fromStr === r.toStr ? r.fromStr : r.fromStr + ' ⟵ ' + r.toStr;
  if (!total) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('ما لقيت شي يخص ' + k.name + ' بهذا التاريخ:') + '\n' + latin(range) }).catch(() => {});
    return;
  }
  purgeAsk = { kind, from: r.from, to: r.to, at: Date.now() };
  const lines = [rtl('⚠️ تأكيد المسح'), rtl('🗂 ' + k.name + ' (' + k.what + ')'), rtl('📅 ') + latin(range)];
  if (kind === 't') { lines.push(rtl('🎞 نتائج تراكات: ' + cnt.docs)); lines.push(rtl('📄 كاش أسطر: ' + cnt.maps)); }
  else lines.push(rtl('🎞 تراكات خام: ' + cnt.docs));
  lines.push(rtl('المسح ما له رجعة. متأكد؟'));
  await tg('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '✅ نعم، امسح', callback_data: 'pg:y' }, { text: 'إلغاء', callback_data: 'pg:n' }]] }
  }).catch(() => {});
}

async function onPurgeCallback(cq) {
  const m = /^pg:([tkywn])$/.exec(String(cq.data || ''));
  if (!m) { await answerCb(cq, 'خيار غير صالح'); return; }
  const op = m[1];
  if (op === 'w') { await answerCb(cq); await askPurge(cq.message.chat.id); return; }
  if (op === 'n') {
    pendingPurge = null; purgeAsk = null;
    await answerCb(cq, 'تم الإلغاء');
    await editMsg(cq.message, rtl('تم الإلغاء، ما انمسح شي.'));
    return;
  }
  if (op === 't' || op === 'k') {
    pendingPurge = { kind: op, at: Date.now() };
    purgeAsk = null;
    await answerCb(cq);
    await editMsg(cq.message, [rtl('🧹 ' + PURGE_KINDS[op].name), rtl('ابعث التاريخين (من ⟵ إلى) بهذا الشكل:'), latin('2026-10-01 2026-10-20'), rtl('أو تاريخ واحد لو تريد يوم واحد. التاريخ هو تاريخ آخر حفظ، بتوقيت بغداد.')].join('\n'), { inline_keyboard: [[{ text: 'إلغاء', callback_data: 'pg:n' }]] });
    return;
  }
  const a = purgeAsk;
  if (!a || Date.now() - a.at > PENDING_TTL_MS) { purgeAsk = null; await answerCb(cq, 'انتهت صلاحية الطلب، ابعث /purge من جديد'); return; }
  purgeAsk = null;
  await answerCb(cq, 'جاري المسح...');
  const k = PURGE_KINDS[a.kind];
  const before = await db.stats().catch(() => null);
  const r = await db.purgeRange(a.kind === 'k' ? 'tracks' : 'translations', a.from, a.to, false);
  if (!r) { await editMsg(cq.message, rtl('⚠️ فشل المسح (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.')); return; }
  const after = await db.stats().catch(() => null);
  console.log('[بوت التحكم] مسح بالتاريخ (' + k.name + '): ' + r.docs + ' وثيقة، ' + r.maps + ' خريطة');
  const out = [rtl('🧹 تم المسح: ' + k.name)];
  if (a.kind === 't') { out.push(rtl('🎞 نتائج تراكات انمسحت: ' + r.docs)); out.push(rtl('📄 كاش أسطر انمسح: ' + r.maps)); }
  else out.push(rtl('🎞 تراكات خام انمسحت: ' + r.docs));
  const b = before && before[k.statKey], f = after && after[k.statKey];
  if (b && f) out.push(rtl('💾 الحجم: ' + Math.round(b.usedMB) + ' ⟵ ' + Math.round(f.usedMB) + ' ميغا (قد لا ينزل فوراً بحسب Atlas)'));
  await editMsg(cq.message, out.join('\n'));
}

async function clearOrder(targetId) {
  const ids = await idsOf(targetId);
  const res = { ids, pins: 0, tracks: 0, raws: 0, lists: 0, failed: 0 };
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
    for (const prefix of ['', 'ass_']) {
      for (let n = 1; n <= MAX_TRACK; n++) {
        const rawKey = prefix + id + '_track' + n + TRACKS_TAG;
        jobs.push(withTimeout(db.deleteDoc('rawsrt', rawKey), STEP_TIMEOUT_MS).then(r => ({ kind: 'raws', r })));
      }
    }
  }
  jobs.push(withTimeout(db.deleteLists(ids), STEP_TIMEOUT_MS).then(r => ({ kind: 'lists', r })));
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
    text: rtl('تأكيد مسح ترتيب التراكات لهذي الحلقة:') + '\n' + latin(rq.targetId) + '\n' + rtl('(تنمسح التراكات المثبتة + نتائجها + الملفات الأصلية المحفوظة + القائمة المحفوظة؛ كاش الأسطر يبقى)'),
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
  console.log('[بوت التحكم] مسح ترتيب التراكات ' + r.ids.join(' + ') + ': ' + r.pins + ' ترتيب، ' + r.tracks + ' تراك، ' + r.raws + ' ملف أصلي، ' + r.lists + ' قائمة' + (r.failed ? ' | ' + r.failed + ' خطوة فشلت' : ''));
  const out = [rtl('🧹 تم مسح ترتيب التراكات'), latin(a.targetId),
    rtl('📌 ترتيب انمسح: ' + r.pins),
    rtl('🎞 تراكات انمسحت: ' + r.tracks),
    rtl('📦 ملفات أصلية انمسحت: ' + r.raws),
    rtl('🗂 قوائم محفوظة انمسحت: ' + r.lists)];
  if (r.failed) out.push(rtl('⚠️ ' + r.failed + ' خطوة ما انمسحت (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.'));
  else if (!r.pins && !r.tracks && !r.raws && !r.lists) out.push(rtl('ما كان في ترتيب محفوظ لهذي الحلقة.'));
  else out.push(rtl('أول مرة تشغّل الحلقة من Nuvio ينبني الترتيب من جديد.'));
  await editMsg(cq.message, out.join('\n'));
}

async function onPanelCallback(cq) {
  const m = /^([a-z]{2}):([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const panel = m && panels.get(m[2]);
  if (m && panel && (m[1] === 'cy' || m[1] === 'cn')) return onClearCallback(cq, m[1], m[2], panel);
  await answerCb(cq, 'انتهت صلاحية هذي الرسالة، ابعث /clear من جديد');
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
  const started = await startPath(t.path, true);
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
    if (req && req.headers && req.headers['x-nuvio-nonote']) return;
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

async function fetchTracks(type, targetId, rawOverride, batch) {
  const rawCfg = rawOverride || ctx.rawConfig;
  const path = (rawCfg ? '/' + encodeURIComponent(rawCfg) : '')
    + '/subtitles/' + type + '/' + encodeURIComponent(targetId).replace(/%3A/gi, ':') + '.json?bgq=1' + (batch ? '&batch=1' : '');
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
    const tracks = await fetchTracks(type, rq.targetId, undefined, !!count);
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
    reqs.set(h, { targetId: rq.targetId, head, tracks, count: count || 0, model: '', gapMin: 0, lineIdx: -1 });
    while (reqs.size > MAX_REQS) reqs.delete(reqs.keys().next().value);
    const rows = trackRows(h, reqs.get(h));
    if (count) { reqs.get(h).lineIdx = head.length; head.push(rtl(batchLineText(count, 0))); }
    await finish(head.concat(rtl(count ? BATCH_PICK_TEXT : 'اختر التراك اللي تريد تجهزه:')).join('\n'), { inline_keyboard: rows });
  } catch (e) {
    try { await send(rtl('⚠️ صار خطأ أثناء الطلب، جرّب مرة ثانية.')); } catch (e2) {}
  }
}

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
  if (r.count) rows.push(GAP_CHOICES_MIN.map(min => ({ text: (gapMinOf(r.count, r.gapMin) === min ? '✅ ' : '') + '⏱ ' + min + ' دقائق', callback_data: 'bg:' + h + ':' + min })));
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

async function onGapCallback(cq) {
  const m = /^bg:([0-9a-f]{8}):(5|10)$/.exec(String(cq.data || ''));
  const r = m && reqs.get(m[1]);
  if (!r || !r.count) { await answerCb(cq, 'انتهت صلاحية هذي القائمة، ابعث الرقم من جديد'); return; }
  r.gapMin = +m[2];
  await answerCb(cq, 'الفاصل: ' + r.gapMin + ' دقائق');
  if (r.lineIdx >= 0 && r.head[r.lineIdx] !== undefined) r.head[r.lineIdx] = rtl(batchLineText(r.count, r.gapMin));
  await editMsg(cq.message, r.head.concat(rtl(BATCH_PICK_TEXT)).join('\n'), { inline_keyboard: trackRows(m[1], r) });
}

function configWithModel(raw, model) {
  try {
    let d;
    try { d = JSON.parse(decodeURIComponent(raw)); } catch (e) { d = JSON.parse(raw); }
    if (!d || typeof d !== 'object') return null;
    d.model = model;
    return JSON.stringify(d);
  } catch (e) { return null; }
}

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
    await startBatch({ chat: cq.message && cq.message.chat, messageId: cq.message && cq.message.message_id, targetId: r.targetId, head, track: t, count: r.count, model: r.model || '', gapMs: r.gapMin ? r.gapMin * 60000 : 0 });
    return;
  }
  const started = await startPath(t.path, true);
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

const COUNTS = [4, 6, 8, 10, 20];
const GAP_SMALL_MS = 5 * 60 * 1000;
const GAP_BIG_MS = 10 * 60 * 1000;
function batchGapMs(count) { return (count || 0) <= 4 ? GAP_SMALL_MS : GAP_BIG_MS; }
const GAP_CHOICES_MIN = [5, 10];
const gapMinOf = (count, chosen) => chosen || (batchGapMs(count) / 60000);
const batchLineText = (count, chosen) => '📦 دفعة: ' + count + ' حلقات (حلقة كل ' + gapMinOf(count, chosen) + ' دقائق، وتتوقف بنهاية الموسم)';
const BATCH_PICK_TEXT = 'اختر التراك لبدء الدفعة (الموديل والفاصل من الأزرار تحت):';
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

const NAMES_AR_RE = /^[ء-ٰٟ-ۓ]+(?: [ء-ٰٟ-ۓ]+){0,2}$/;
const NAMES_MAX_PINS = 300;
const NAMES_AUTO_SHOW = 15;
const NAMES_SERIES_PREFIX = 'ARB2_snames_';
let namesCur = null;
let pendingNames = null;

const namesSidOf = tok => {
  const t = String(tok || '').trim();
  if (/^tt\d+$/i.test(t)) return t.toLowerCase();
  if (/^kitsu:\d+$/i.test(t)) return t.toLowerCase();
  return null;
};

async function loadNamePins(sid) {
  const r = await withTimeout(db.loadPins(sid), 4000).catch(() => null);
  const v = r && r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  const clean = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : []);
  return { p: clean(v.p), c: clean(v.c), ok: !!(r && r.ok) };
}

async function listAutoNames(sid, pinned) {
  const out = { p: [], c: [] };
  try {
    const stored = await withTimeout(db.loadMap('names', NAMES_SERIES_PREFIX + sid), 4000);
    const raw = stored && stored.has(1) ? JSON.parse(stored.get(1)) : null;
    if (!raw || typeof raw !== 'object') return out;
    const rows = [];
    for (const [k, rec] of Object.entries(raw)) {
      if (k === '~' || !rec || typeof rec !== 'object' || pinned.has(k)) continue;
      const codes = Object.values(rec).filter(n => Number.isInteger(n));
      if (codes.length < 2) continue;
      const persons = codes.filter(n => n & 1).length;
      rows.push({ k, n: codes.length, kind: persons * 2 >= codes.length ? 'p' : 'c' });
    }
    rows.sort((a, b) => b.n - a.n);
    for (const r of rows) if (out[r.kind].length < NAMES_AUTO_SHOW) out[r.kind].push(r.k);
  } catch (e) {}
  return out;
}

const namesKeyboard = () => ({ inline_keyboard: [
  [{ text: '➕ اسم شخص', callback_data: 'nm:p' }, { text: '➕ مكان / منظمة', callback_data: 'nm:c' }],
  [{ text: '🗑 شيل اسم', callback_data: 'nm:d' }, { text: '🔄 غيّر المسلسل', callback_data: 'nm:s' }]
] });

async function namesViewText(sid, head) {
  const pins = await loadNamePins(sid);
  let title = null;
  try { title = notify && notify.titleOf ? await withTimeout(notify.titleOf(sid, 'series'), 6000) : null; } catch (e) { title = null; }
  const lines = [];
  if (head && head.length) lines.push(...head, '');
  lines.push(rtl('📖 أسماء المسلسل'));
  lines.push(rtl(title ? latin(title) + ' ' + latin('(' + sid + ')') : latin(sid)));
  lines.push('');
  lines.push(rtl('🔒 المثبّتة (تنطبق من الحلقة الجاية):'));
  lines.push(rtl('👤 الأسماء: ' + (pins.p.length ? pins.p.join(' · ') : '—')));
  lines.push(rtl('📍 الأماكن والمنظمات: ' + (pins.c.length ? pins.c.join(' · ') : '—')));
  const auto = await listAutoNames(sid, new Set([...pins.p, ...pins.c].map(bookKey)));
  if (auto.p.length || auto.c.length) {
    lines.push('');
    lines.push(rtl('🤖 المكتشفة تلقائياً من الحلقات:'));
    if (auto.p.length) lines.push(rtl('👤 ' + auto.p.join(' · ')));
    if (auto.c.length) lines.push(rtl('📍 ' + auto.c.join(' · ')));
  }
  lines.push('');
  lines.push(rtl('اضغط الزر وابعث الكلمة، وتنثبّت للحلقات القادمة.'));
  return { text: lines.join('\n'), pins };
}

async function sendNamesView(chatId, sid, head) {
  namesCur = { sid, at: Date.now() };
  const v = await namesViewText(sid, head);
  await tg('sendMessage', { chat_id: chatId, text: v.text, reply_markup: namesKeyboard(), disable_web_page_preview: true }).catch(() => {});
}

async function onNamesCmd(chatId, arg) {
  pendingNames = null;
  let sid = null;
  const tok = String(arg || '').trim().split(/\s+/)[0];
  if (tok) {
    sid = namesSidOf(tok);
    if (!sid) {
      await tg('sendMessage', { chat_id: chatId, text: rtl('اكتب الأمر مع معرّف المسلسل، مثال:') + '\n' + latin('/names tt0409591') }).catch(() => {});
      return;
    }
  } else {
    const d = await loadLast();
    const info = d && seriesInfoFromTarget(d.targetId);
    if (!info) {
      await tg('sendMessage', { chat_id: chatId, text: rtl(d ? 'آخر عمل اشتغلت عليه فلم، والأسماء المثبّتة للمسلسلات فقط.' : 'ما في مسلسل شغّلته بعد.') + '\n' + rtl('ابعث معرّف المسلسل مع الأمر، مثال:') + '\n' + latin('/names tt0409591') }).catch(() => {});
      return;
    }
    sid = info.seriesId;
  }
  await sendNamesView(chatId, sid);
}

async function namesAsk(cq, mode) {
  if (mode === 's') {
    pendingNames = { mode, at: Date.now() };
    await editMsg(cq.message, [rtl('🔄 ابعث معرّف المسلسل:'), latin('tt0409591'), rtl('أو لمسلسلات kitsu:'), latin('kitsu:123')].join('\n'), { inline_keyboard: [[{ text: 'إلغاء', callback_data: 'nm:n' }]] });
    return;
  }
  if (!namesCur) { await answerCb(cq, 'ابعث /names من جديد'); return; }
  pendingNames = { mode, sid: namesCur.sid, at: Date.now() };
  const what = mode === 'p' ? '👤 ابعث اسم الشخص' : '📍 ابعث اسم المكان أو المنظمة';
  await editMsg(cq.message, [rtl(what), rtl('(ممكن أكثر من واحد، كل اسم بسطر)'), rtl('عربي فقط، لحد 3 كلمات للاسم الواحد.')].join('\n'), { inline_keyboard: [[{ text: 'إلغاء', callback_data: 'nm:n' }]] });
}

async function showNamesDelete(cq) {
  if (!namesCur) { await answerCb(cq, 'ابعث /names من جديد'); return; }
  const pins = await loadNamePins(namesCur.sid);
  const all = [...pins.p.map((w, i) => ({ w, k: 'p', i })), ...pins.c.map((w, i) => ({ w, k: 'c', i }))];
  if (!all.length) { await answerCb(cq, 'ما في أسماء مثبّتة'); return; }
  const rows = [];
  all.slice(0, 40).forEach((x, j) => {
    const b = { text: '🗑 ' + (x.k === 'p' ? '👤 ' : '📍 ') + x.w, callback_data: 'nm:x:' + x.k + ':' + x.i };
    if (j % 2 === 0) rows.push([b]); else rows[rows.length - 1].push(b);
  });
  rows.push([{ text: 'رجوع', callback_data: 'nm:b' }]);
  await editMsg(cq.message, rtl('اضغط على اللي تريد تشيل تثبيته:'), { inline_keyboard: rows });
}

async function onNamesCallback(cq) {
  const m = /^nm:([pcdsnbx])(?::([pc]):(\d+))?$/.exec(String(cq.data || ''));
  if (!m) { await answerCb(cq, 'خيار غير صالح'); return; }
  const op = m[1];
  await answerCb(cq);
  if (op === 'n') { pendingNames = null; await editMsg(cq.message, rtl('تم الإلغاء، ما تغيّر شي.')); return; }
  if (op === 'p' || op === 'c' || op === 's') { await namesAsk(cq, op); return; }
  if (op === 'd') { pendingNames = null; await showNamesDelete(cq); return; }
  if (!namesCur) { await editMsg(cq.message, rtl('انتهت صلاحية الرسالة، ابعث /names من جديد.')); return; }
  if (op === 'x') {
    const pins = await loadNamePins(namesCur.sid);
    const list = m[2] === 'p' ? pins.p : pins.c;
    const w = list[Number(m[3])];
    if (w == null) { await showNamesDelete(cq); return; }
    list.splice(Number(m[3]), 1);
    const ok = await db.savePins(namesCur.sid, { p: pins.p, c: pins.c });
    if (!ok) { await editMsg(cq.message, rtl('⚠️ ما انحفظ التعديل (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.')); return; }
    const v = await namesViewText(namesCur.sid, [rtl('🗑 انشال التثبيت: ' + w)]);
    await editMsg(cq.message, v.text, namesKeyboard());
    return;
  }
  const v = await namesViewText(namesCur.sid);
  await editMsg(cq.message, v.text, namesKeyboard());
}

async function onNamesText(chatId, text) {
  const pn = pendingNames;
  if (!pn) return false;
  if (pn.mode === 's') {
    const sid = namesSidOf(String(text).trim().split(/\s+/)[0]);
    pendingNames = null;
    if (!sid) return false;
    await sendNamesView(chatId, sid);
    return true;
  }
  if (!/[ء-ي]/.test(String(text))) { pendingNames = null; return false; }
  const kind = pn.mode;
  const pins = await loadNamePins(pn.sid);
  if (!pins.ok) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ ما قدرت أقرأ الأسماء المثبّتة (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.') }).catch(() => {});
    return true;
  }
  const same = kind === 'p' ? pins.p : pins.c;
  const other = kind === 'p' ? pins.c : pins.p;
  const added = [], moved = [], dup = [], bad = [];
  for (const raw of latinDigits(String(text)).split(/\r?\n/)) {
    const w = raw.replace(/["'“”«»()\[\]]/g, '').replace(/[ً-ٰٟـ]/g, '').replace(/\s+/g, ' ').trim();
    if (!w) continue;
    if (!NAMES_AR_RE.test(w) || bookKey(w).replace(/ /g, '').length < 2) { bad.push(raw.trim()); continue; }
    const key = bookKey(w);
    if (same.some(x => bookKey(x) === key)) { dup.push(w); continue; }
    const oi = other.findIndex(x => bookKey(x) === key);
    if (oi >= 0) { other.splice(oi, 1); moved.push(w); } else added.push(w);
    same.push(w);
  }
  if (pins.p.length + pins.c.length > NAMES_MAX_PINS) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ وصلت الحد الأعلى للأسماء المثبّتة (' + NAMES_MAX_PINS + ').') }).catch(() => {});
    pendingNames = null;
    return true;
  }
  const head = [];
  const icon = kind === 'p' ? '👤' : '📍';
  if (added.length || moved.length) {
    const ok = await db.savePins(pn.sid, { p: pins.p, c: pins.c });
    if (!ok) {
      await tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ ما انحفظ (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.') }).catch(() => {});
      return true;
    }
    head.push(rtl('✅ تثبّت للحلقات القادمة'));
    for (const w of [...added, ...moved]) head.push(rtl(icon + ' ' + w));
    if (moved.length) head.push(rtl('(' + moved.length + ' منها انتقل من القسم الثاني)'));
  } else if (!bad.length) {
    head.push(rtl('ما في جديد، الأسماء هذي مثبّتة أصلاً بهذا القسم.'));
  } else {
    head.push(rtl('⚠️ ما انثبّت شي.'));
  }
  if (bad.length) head.push(rtl('⚠️ تجاهلت (عربي فقط، لحد 3 كلمات): ' + bad.join(' ، ')));
  pendingNames = (added.length || moved.length || dup.length) ? null : pn;
  await sendNamesView(chatId, pn.sid, head);
  return true;
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
        const tracks = await fetchTracks('series', nx.id, b.rawOverride, true).catch(() => null);
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
      b.nextAt = Date.now() + (res ? (b.gapMs || batchGapMs(b.count)) : READY_GAP_MS);
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

async function startBatch({ chat, messageId, targetId, head, track, count, model, gapMs }) {
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
      const tr = await fetchTracks(/^tt\d+$/.test(targetId) ? 'movie' : 'series', targetId, rawOverride, true).catch(() => null);
      const t2 = tr && tr.find(x => x.ext === track.ext && x.track === track.track);
      firstPath = t2 ? t2.path : '';
    }
    if (!firstPath) { await fail('تعذر تجهيز مسار التراك بالموديل المختار.'); return; }
  }
  const b = { chat, messageId, targetId, head, ext: track.ext, track: track.track, firstPath, count, gapMs: gapMs || 0, model: model || '', rawOverride, lines: [], final: '', nextAt: 0, stopped: false, timer: null, wake: null };
  activeBatch = b;
  console.log('[دفعة] بدأت: ' + targetId + ' ' + b.ext.toUpperCase() + ' ' + b.track + ' × ' + count + ' | فاصل ' + ((gapMs || batchGapMs(count)) / 60000) + ' د' + (model ? ' | موديل ' + model : ''));
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
    await tg('sendMessage', { chat_id: TG_CHAT, text: lines.join('\n'), reply_markup: { inline_keyboard: [[{ text: '🧹 نظّف بتاريخ', callback_data: 'pg:w' }]] } });
    await db.saveDoc('dbwatch', 'last', { at: Date.now() });
  } catch (e) {}
}

function startDbWatch() {
  setTimeout(() => {
    checkDbSize();
    setInterval(checkDbSize, DB_CHECK_MS);
  }, DB_FIRST_CHECK_MS);
}

async function onEpisodeReply(chatId, er) {
  const p = search.getPendingEp();
  if (!p) return;
  const meta = await getMeta(p.imdb);
  if (meta && meta.all.size && !meta.all.has(er.season)) {
    const ss = [...meta.all.keys()].sort((a, b) => a - b);
    await tg('sendMessage', { chat_id: chatId, text: [rtl('الموسم ' + er.season + ' مو موجود لهذا المسلسل.'), rtl('المواسم المتوفرة: ' + latin(ss.join(', '))), rtl('ابعث الموسم والحلقة من جديد.')].join('\n') }).catch(() => {});
    return;
  }
  search.setPendingEp(null);
  await onRequest(chatId, { imdb: p.imdb, season: er.season, episode: er.episode, targetId: p.imdb + ':' + er.season + ':' + er.episode }, takeCount());
}

const isClearCmd = t => /^\/clear(@\w+)?$/i.test(t) || /^(امسح|مسح) (آخر|اخر) حلقة$/.test(t);
const isBatchCmd = t => /^\/batch(@\w+)?$/i.test(t) || t === 'دفعة';
const isOrderCmd = t => /^\/order(@\w+)?$/i.test(t) || t === 'مسح الترتيب' || t === 'امسح الترتيب';
const isPurgeCmd = t => /^\/purge(@\w+)?$/i.test(t);
const isStopCmd = t => /^\/stop(@\w+)?$/i.test(t) || t === 'ايقاف' || t === 'إيقاف';
const isStartCmd = t => /^\/start(@\w+)?$/i.test(t);

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
  const serp = String(settings.get('serpapi_key') || '').trim();
  L.push(rtl('🖼 Lens للبحث بالصورة (' + SRC_NAME[settings.source('serpapi_key')] + '): ') + (serp ? latin(maskKey(serp)) + rtl(' ✅') : rtl('غير مفعّل ⛔ (ابعث ') + latin('/serpkey KEY') + rtl(')')));
  L.push(rtl('🌐 البحث بجوجل (' + SRC_NAME[settings.source('search_grounding')] + '): ' + onOff(settings.get('search_grounding'))) + (settings.get('search_grounding') && groundingBlockedMin() > 0 ? rtl(' ⏳ الحصة خلصت، يرجع بعد ') + latin(groundingBlockedMin() + '') + rtl(' دقيقة') : ''));
  L.push(rtl('⏭ تخطي الحشو (' + SRC_NAME[settings.source('filler_skip')] + '): ' + onOff(settings.get('filler_skip'))));
  L.push(rtl('🤖 عرض AI دائماً (' + SRC_NAME[settings.source('show_ai_always')] + '): ' + onOff(settings.get('show_ai_always'))));
  L.push(rtl('⏩ تجهيز ASS بالخلفية للحلقة التالية (' + SRC_NAME[settings.source('prefetch_ass')] + '): ' + onOff(settings.get('prefetch_ass'))));
  L.push(rtl('⏩ تجهيز SRT بالخلفية للحلقة التالية (' + SRC_NAME[settings.source('prefetch_srt')] + '): ' + onOff(settings.get('prefetch_srt'))));
  L.push(rtl('(الإيقاف يخص التجهيز التلقائي من المشغل فقط، ودفعات تلغرام تبقى شغالة)'));
  L.push(rtl('🛡 حاجز الانفجار (' + SRC_NAME[settings.source('burst_guard')] + '): ' + onOff(settings.get('burst_guard'))));
  L.push(rtl('(تراك جديد بنفس الحلقة يوصل خلال 10 ثوانٍ من تراك قبله يُتجاهل. الجاهز ما يتأثر، والبوت والدفعات مستثناة)'));
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
  rows.push([tgl('⏩ ASS بالخلفية', settings.get('prefetch_ass'), 'p'), tgl('⏩ SRT بالخلفية', settings.get('prefetch_srt'), 'q')]);
  rows.push([tgl('🛡 حاجز الانفجار (10 ث)', settings.get('burst_guard'), 'h')]);
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
  } else if (op === 'p') {
    r = await settings.set('prefetch_ass', !settings.get('prefetch_ass'));
  } else if (op === 'q') {
    r = await settings.set('prefetch_srt', !settings.get('prefetch_srt'));
  } else if (op === 'h') {
    r = await settings.set('burst_guard', !settings.get('burst_guard'));
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
    if (cq && /^gt:/.test(data)) return await getter.onGetCallback(cq);
    if (cq && /^dl:/.test(data)) return await getter.onDlCallback(cq);
    if (cq && /^fd:/.test(data)) return await onFindCallback(cq);
    if (cq && /^fs:/.test(data)) {
      if (!startSearch(() => onSmartCallback(cq))) await answerCb(cq, SEARCH_BUSY_TEXT);
      return;
    }
    if (cq && /^st:/.test(data)) return await onSettingsCallback(cq);
    if (cq && /^bn:/.test(data)) return await onCountCallback(cq);
    if (cq && /^bm:/.test(data)) return await onModelCallback(cq);
    if (cq && /^bg:/.test(data)) return await onGapCallback(cq);
    if (cq && /^od:/.test(data)) return await onOrderCallback(cq);
    if (cq && /^pg:/.test(data)) return await onPurgeCallback(cq);
    if (cq && /^nm:/.test(data)) return await onNamesCallback(cq);
    if (cq && /^rt:/.test(data)) return await onRetryCallback(cq);
    if (cq) return await onPanelCallback(cq);
    const text = String((u.message && u.message.text) || '').trim();
    const mm = u.message;
    const isImg = !!(mm && ((Array.isArray(mm.photo) && mm.photo.length) || (mm.document && IMAGE_MIMES.test(String(mm.document.mime_type || '')))));
    if (isImg) {
      if (!startSearch(() => onImage(chatId, mm))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {});
      return;
    }
    const gc = getter.getCmd(text);
    if (gc !== null) { await getter.onGetCmd(chatId, gc); return; }
    const skc = serpKeyCmd(text);
    if (skc !== null) { await onSerpKeyCmd(chatId, skc, mm && mm.message_id); return; }
    const acc = actorCmd(text);
    if (acc !== null) {
      if (!startSearch(() => onActor(chatId, acc))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {});
      return;
    }
    if (pendingPurge && Date.now() - pendingPurge.at < PENDING_TTL_MS) {
      const pr = parsePurgeDates(text);
      if (pr) { await onPurgeDates(chatId, pr); return; }
    }
    const nmc = /^\/names(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
    if (nmc) { await onNamesCmd(chatId, nmc[1] || ''); return; }
    if (pendingNames && Date.now() - pendingNames.at < PENDING_TTL_MS && !/^\//.test(text)) { if (await onNamesText(chatId, text)) return; }
    const rq = parseRequest(text);
    const fq = rq ? null : parseFind(text);
    const er = (!rq && !fq && search.getPendingEp() && Date.now() - search.getPendingEp().at < PENDING_TTL_MS) ? parseEpisode(text) : null;
    const po = pendingOrder && Date.now() - pendingOrder.at < PENDING_TTL_MS;
    if (rq && po) await onOrderTarget(chatId, rq);
    else if (rq) { search.setPendingEp(null); await onRequest(chatId, rq, takeCount()); }
    else if (fq) { if (!startSearch(() => onFind(chatId, fq.q))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {}); }
    else if (er) await onEpisodeReply(chatId, er);
    else if (slotsCmd(text) !== null) await onSlotsCmd(chatId, slotsCmd(text));
    else if (srtSlotsCmd(text) !== null) await onSlotsCmd(chatId, srtSlotsCmd(text), 'srt_slots');
    else if (isSettingsCmd(text)) await sendSettings(chatId);
    else if (isBatchCmd(text)) await askCount(chatId);
    else if (isOrderCmd(text)) await askOrder(chatId);
    else if (isPurgeCmd(text)) await askPurge(chatId);
    else if (isStopCmd(text)) await stopBatch(chatId);
    else if (isClearCmd(text)) await sendAskClear(chatId);
    else if (isStartCmd(text)) await tg('sendMessage', { chat_id: chatId, text: [rtl('أهلاً 👋 الأوامر المتاحة:'), rtl('/find ابحث عن فلم أو مسلسل'), rtl('🖼 ابعث صورة (بوستر أو لقطة) أعرف شنو العمل'), rtl('/actor أعمال ممثل'), rtl('/get حمّل ترجمات حلقة كملفات'), rtl('/serpkey مفتاح SerpApi (Lens)'), rtl('/settings الإعدادات'), rtl('/clear امسح ترجمة آخر حلقة'), rtl('/batch جهّز دفعة حلقات'), rtl('/order امسح ترتيب تراكات حلقة'), rtl('/stop أوقف الدفعة الشغالة')].join('\n') });
    else if (isPlainSearchText(text)) { if (!startSearch(() => onFind(chatId, text))) await tg('sendMessage', { chat_id: chatId, text: rtl(SEARCH_BUSY_TEXT) }).catch(() => {}); }
  } catch (e) {
    logErr('خطأ بمعالجة أمر', e);
  }
}

let running = false;
let stopped = false;

async function loop() {
  let offset = 0, fails = 0, drained = false;
  tg('setMyCommands', { commands: [{ command: 'settings', description: 'الإعدادات (ترتيب ASS وSRT، البحث، الحشو)' }, { command: 'clear', description: 'امسح ترجمة آخر حلقة' }, { command: 'batch', description: 'جهّز دفعة حلقات (4/6/8/10/20)' }, { command: 'order', description: 'امسح ترتيب تراكات حلقة' }, { command: 'stop', description: 'أوقف الدفعة الشغالة' }, { command: 'names', description: 'ثبّت أسماء وأماكن مسلسل للتنصيص' }, { command: 'purge', description: 'امسح ترجمات (الأساسي) أو تراكات (الثاني) بتاريخ' }, { command: 'find', description: 'ابحث عن فلم أو مسلسل بالاسم' }, { command: 'actor', description: 'أعمال ممثل بالاسم' }, { command: 'get', description: 'حمّل ترجمات حلقة كملفات' }] }).catch(() => {});
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
  console.log('[بوت التحكم] تيليغرام يسمع أوامرك ⟵ ابعث /find أو /clear.');
  startDbWatch();
  loop().catch(() => { running = false; });
}

function stop() { stopped = true; }

search.init({ tg, withTimeout, logErr, answerCb, scrub, loadCtx, getCtx: () => ctx, getMeta, onRequest, takeCount });
getter.init({ tg, withTimeout, logErr, answerCb, scrub, loadCtx, getCtx: () => ctx, parseRequest, loadLast, idsOf });
loadCtx().catch(() => {});

module.exports = {
  start, stop, noteTrack, noteContext, onDrop, enabled: ENABLED,
  _t: { sendSettings, onSettingsCallback, onSlotsCmd, settingsText, settingsKeyboard, currentSlots, handleUpdate, keyOf, hashOf, panels, parseRequest, fetchTracks, startPath, leftInSeason, nextOf, getMeta, clearEpisode, clearTrack, clearOrder, configWithModel, swapPathConfig, trackRows, askOrder, onOrderTarget, orderAsks, getPendingOrder: () => pendingOrder, checkDbSize, reqs, finds, parseFind, parseQuery, parseEpisode, isPlainSearchText, cinemetaSearch, mergeResults, nameSim, foldText, osaDistance, jaroWinkler, trigramSim, extractJson, rankItems, onFind, getPendingEp: () => search.getPendingEp(), idle: () => lastSearch, isSearchBusy: () => searchBusy, getCtx: () => ctx, isBatchActive: () => !!activeBatch }
};
