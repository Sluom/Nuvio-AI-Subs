'use strict';
// بوت التحكم بالترجمة عبر تيليغرام: يسمع أوامرك (long polling) ويعرض لوحة أزرار لآخر تراك مصحح شغلته:
// توقيت (SRT وASS)، حجم وارتفاع (ASS فقط). القيم تنحفظ بقاعدة البيانات (ns=adj) وتتطبق وقت التسليم فقط
// (adjust.js) ولا تنلمس الترجمة المحفوظة. يشتغل بنفس المتغيرين TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID،
// ويستجيب لرقم محادثتك فقط. أي فشل يُبلع ولا يؤثر على الإضافة.
const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const adjust = require('./adjust');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const ENABLED = !!(TG_TOKEN && TG_CHAT);
const API = 'https://api.telegram.org/bot';

const NS = 'adj';
const POLL_SEC = 25;
const NONE_TTL_MS = 30 * 60 * 1000;
const READ_TIMEOUT_MS = 1500;
const ERR_LOG_GAP_MS = 10 * 60 * 1000;
const MAX_PANELS = 200;
const RLM = '\u200F';
const LRI = '\u2066';
const PDI = '\u2069';
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

const mem = new Map();
const noneUntil = new Map();
const panels = new Map();
let last = null;
let lastErrLogAt = 0;

// ---------- القيم المحفوظة ----------
function withTimeout(p, ms) {
  let t;
  const timer = new Promise(resolve => { t = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([Promise.resolve(p).catch(() => undefined), timer]).finally(() => clearTimeout(t));
}

async function getSettings(key) {
  if (mem.has(key)) return mem.get(key);
  const until = noneUntil.get(key);
  if (until && until > Date.now()) return null;
  const doc = await withTimeout(db.loadDoc(NS, key), READ_TIMEOUT_MS);
  if (doc && typeof doc === 'object' && doc.s) {
    const s = adjust.normalize(doc.s);
    mem.set(key, s);
    return s;
  }
  noneUntil.set(key, Date.now() + NONE_TTL_MS);
  return null;
}

function putSettings(key, d, s) {
  mem.set(key, s);
  noneUntil.delete(key);
  try {
    Promise.resolve(db.saveDoc(NS, key, { s, label: d.label, targetId: d.targetId, trackNum: d.trackNum, at: Date.now() })).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

// ---------- الواجهة لـ index.js ----------
function noteTrack(d) {
  try {
    if (!ENABLED || !d || !d.targetId) return;
    const key = keyOf(d);
    if (last && last.key === key) return;
    last = { key, label: d.label, targetId: d.targetId, trackNum: d.trackNum, ext: d.ext, tracksTag: d.tracksTag || '' };
    Promise.resolve(db.saveDoc(NS, 'last', { d: last, at: Date.now() })).catch(() => {});
  } catch (e) { /* لا شيء */ }
}

// يرجع { content, touched }: touched = فيه قيم محفوظة لهذا التراك (حتى لو رجعت للافتراضي)
async function adjustSub(d, content) {
  try {
    if (!ENABLED || !d || !d.targetId) return { content, touched: false };
    const key = keyOf(d);
    const s = await getSettings(key);
    if (!s) return { content, touched: false };
    if (adjust.isDefault(s)) return { content, touched: true };
    const out = adjust.apply(content, d.ext, s);
    console.log('[تعديل الترجمة] ' + String(d.ext).toUpperCase() + ' تراك ' + d.trackNum + ' (' + d.targetId + '): '
      + 'توقيت ' + midMs(s.ms) + (d.ext === 'ass' ? ' | حجم ' + s.size + '% | ارتفاع ' + midPct(s.up) : ''));
    return { content: out, touched: true };
  } catch (e) {
    return { content, touched: false };
  }
}

// ---------- تيليغرام ----------
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

// ---------- نص اللوحة والأزرار ----------
const midMs = ms => (ms > 0 ? '+' : ms < 0 ? '-' : '') + (Math.abs(ms) / 1000).toFixed(1) + ' s';
const midPct = n => (n > 0 ? '+' : '') + n + '%';
const fmtDelay = ms => (!ms ? 'بدون تغيير' : (ms > 0 ? 'تأخير ' : 'تقديم ') + (Math.abs(ms) / 1000).toFixed(1) + ' ثانية');

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

function panelText(head, s, ext) {
  const out = [rtl('🎛 لوحة التحكم'), ...head, rtl('⏱ التوقيت: ' + fmtDelay(s.ms))];
  if (ext === 'ass') {
    out.push(rtl('🔠 الحجم: ' + s.size + '%'));
    out.push(rtl('↕️ الارتفاع: ' + (s.up ? midPct(s.up) : 'بدون تغيير')));
  }
  return out.join('\n');
}

function keyboard(h, s, ext) {
  const b = (text, op) => ({ text, callback_data: op + ':' + h });
  const rows = [[b('تقديم − 0.1 ث', 'tm'), b(midMs(s.ms), 'rt'), b('تأخير + 0.1 ث', 'tp')]];
  if (ext === 'ass') {
    rows.push([b('حجم −', 'sm'), b(s.size + '%', 'rs'), b('حجم +', 'sp')]);
    rows.push([b('نزّل ↓', 'lo'), b(midPct(s.up), 'ru'), b('ارفع ↑', 'hi')]);
  }
  rows.push([b(ext === 'ass' ? 'إعادة ضبط الكل' : 'إعادة ضبط', 'ra')]);
  return { inline_keyboard: rows };
}

const OPS = {
  tm: s => ({ ...s, ms: s.ms - adjust.STEP_MS }),
  tp: s => ({ ...s, ms: s.ms + adjust.STEP_MS }),
  rt: s => ({ ...s, ms: 0 }),
  sm: s => ({ ...s, size: s.size - adjust.STEP_SIZE }),
  sp: s => ({ ...s, size: s.size + adjust.STEP_SIZE }),
  rs: s => ({ ...s, size: 100 }),
  lo: s => ({ ...s, up: s.up - adjust.STEP_UP }),
  hi: s => ({ ...s, up: s.up + adjust.STEP_UP }),
  ru: s => ({ ...s, up: 0 }),
  ra: () => ({ ms: 0, size: 100, up: 0 })
};
const ASS_ONLY = new Set(['sm', 'sp', 'rs', 'lo', 'hi', 'ru']);

async function loadLast() {
  if (last) return last;
  const doc = await withTimeout(db.loadDoc(NS, 'last'), 3000);
  if (doc && doc.d && doc.d.targetId) {
    const d = doc.d;
    last = { key: keyOf(d), label: d.label, targetId: d.targetId, trackNum: d.trackNum, ext: d.ext, tracksTag: d.tracksTag || '' };
  }
  return last;
}

async function sendPanel(chatId) {
  const d = await loadLast();
  if (!d) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('ما في تراك مصحح شغّلته بعد.') + '\n' + rtl('شغّل تراك من Nuvio وبعدها ابعث /panel') });
    return;
  }
  const s = (await getSettings(d.key)) || adjust.normalize({});
  const head = await headOf(d);
  const h = hashOf(d.key);
  panels.delete(h);
  panels.set(h, { d, head });
  while (panels.size > MAX_PANELS) panels.delete(panels.keys().next().value);
  await tg('sendMessage', { chat_id: chatId, text: panelText(head, s, d.ext), reply_markup: keyboard(h, s, d.ext), disable_web_page_preview: true });
}

async function onCallback(cq) {
  const m = /^([a-z]{2}):([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const panel = m && panels.get(m[2]);
  if (!m || !panel || !OPS[m[1]]) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'انتهت صلاحية هذي اللوحة، ابعث /panel' }).catch(() => {});
    return;
  }
  const { d, head } = panel;
  const op = m[1];
  if (ASS_ONLY.has(op) && d.ext !== 'ass') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'هذا الزر لتراك ASS فقط' }).catch(() => {});
    return;
  }
  const cur = (await getSettings(d.key)) || adjust.normalize({});
  const next = adjust.normalize(OPS[op](cur));
  putSettings(d.key, d, next);
  const toast = op === 'ra' ? 'رجعت كل شي للأصل'
    : op === 'tm' || op === 'tp' || op === 'rt' ? 'التوقيت: ' + midMs(next.ms)
    : op === 'sm' || op === 'sp' || op === 'rs' ? 'الحجم: ' + next.size + '%'
    : 'الارتفاع: ' + midPct(next.up);
  console.log('[بوت التحكم] ' + String(d.ext).toUpperCase() + ' تراك ' + d.trackNum + ' (' + d.targetId + '): ' + toast);
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: toast }).catch(() => {});
  const msg = cq.message;
  if (msg && msg.chat && msg.message_id) {
    await tg('editMessageText', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: panelText(head, next, d.ext), reply_markup: keyboard(m[2], next, d.ext), disable_web_page_preview: true
    }).catch(e => { if (!/not modified/i.test(String(e && e.message))) logErr('تعذر تحديث اللوحة', e); });
  }
}

const isPanelCmd = t => /^\/(panel|start)(@\w+)?$/i.test(t) || t === 'لوحة' || t === 'لوحة التحكم' || /^panel$/i.test(t);

async function handleUpdate(u) {
  try {
    const cq = u && u.callback_query;
    const msg = cq ? cq.message : (u && u.message);
    const chatId = msg && msg.chat && msg.chat.id;
    if (chatId == null || String(chatId) !== TG_CHAT) return;
    if (cq) return await onCallback(cq);
    const text = String((u.message && u.message.text) || '').trim();
    if (isPanelCmd(text)) await sendPanel(chatId);
  } catch (e) {
    logErr('خطأ بمعالجة أمر', e);
  }
}

// ---------- الاستماع ----------
let running = false;
let stopped = false;

async function loop() {
  let offset = 0, fails = 0, drained = false;
  tg('setMyCommands', { commands: [{ command: 'panel', description: 'لوحة تحكم الترجمة (توقيت، حجم، ارتفاع)' }] }).catch(() => {});
  while (!stopped) {
    try {
      if (!drained) {
        // نتجاوز الأوامر القديمة المتراكمة (مثلا أثناء توقف السيرفر) حتى لا تتطبق ضغطات قديمة
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
  console.log('[بوت التحكم] تيليغرام يسمع أوامرك ⟵ ابعث /panel للوحة التوقيت والحجم والارتفاع.');
  loop().catch(() => { running = false; });
}

function stop() { stopped = true; }

module.exports = { start, stop, noteTrack, adjustSub, enabled: ENABLED, _t: { handleUpdate, keyOf, hashOf, mem, panels, getSettings, sendPanel } };
