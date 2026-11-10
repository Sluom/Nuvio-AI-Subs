'use strict';
// بوت التحكم بالترجمة عبر تيليغرام: يسمع أوامرك (long polling) ويعرض لوحة تحكم لآخر تراك مصحح شغلته
// (زر مسح آخر حلقة)، ويستقبل طلب الترجمة اليدوي وأوامر الدفعات. يشتغل بنفس المتغيرين
// TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID، ويستجيب لرقم محادثتك فقط. أي فشل يُبلع ولا يؤثر على الإضافة.
const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const cacheclear = require('./cacheclear');
const tgmanual = require('./tgmanual');
const tgbatch = require('./tgbatch');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }

const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const ENABLED = !!(TG_TOKEN && TG_CHAT);
const API = 'https://api.telegram.org/bot';

const NS = 'adj';
const POLL_SEC = 25;
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

const panels = new Map();
let last = null;
let lastErrLogAt = 0;

// ---------- أدوات ----------
function withTimeout(p, ms) {
  let t;
  const timer = new Promise(resolve => { t = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([Promise.resolve(p).catch(() => undefined), timer]).finally(() => clearTimeout(t));
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

function panelText(head) {
  return [rtl('🎛 لوحة التحكم'), ...head].join('\n');
}

function keyboard(h) {
  return { inline_keyboard: [[{ text: '🗑 امسح آخر حلقة', callback_data: 'cl:' + h }]] };
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

async function sendPanel(chatId) {
  const d = await loadLast();
  if (!d) {
    await tg('sendMessage', { chat_id: chatId, text: rtl('ما في تراك مصحح شغّلته بعد.') + '\n' + rtl('شغّل تراك من Nuvio وبعدها ابعث /panel') });
    return;
  }
  const head = await headOf(d);
  const h = hashOf(d.key);
  panels.delete(h);
  panels.set(h, { d, head });
  while (panels.size > MAX_PANELS) panels.delete(panels.keys().next().value);
  await tg('sendMessage', { chat_id: chatId, text: panelText(head), reply_markup: keyboard(h), disable_web_page_preview: true });
}

async function askClear(chatId, d, head) {
  const h = hashOf(d.key);
  panels.delete(h);
  panels.set(h, { d, head });
  while (panels.size > MAX_PANELS) panels.delete(panels.keys().next().value);
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
  const edit = text => (msg && msg.chat && msg.message_id)
    ? tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, disable_web_page_preview: true }).catch(() => {})
    : Promise.resolve();
  if (op === 'cl') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    await askClear(msg.chat.id, panel.d, panel.head);
    return;
  }
  if (op === 'cn') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'تم الإلغاء' }).catch(() => {});
    await edit(rtl('تم الإلغاء، ما انمسح شي.'));
    return;
  }
  panels.delete(h);
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'جاري المسح...' }).catch(() => {});
  const r = await cacheclear.clearEpisode(panel.d.targetId);
  console.log('[بوت التحكم] مسح الحلقة ' + r.ids.join(' + ') + ': ' + r.tracks + ' تراك، ' + r.lines + ' كاش أسطر' + (r.failed ? ' | ' + r.failed + ' خطوة فشلت' : ''));
  const out = [rtl('🗑 تم مسح الحلقة'), ...panel.head.slice(0, 2),
    rtl('🎞 تراكات انمسحت: ' + r.tracks),
    rtl('📄 كاش أسطر انمسح: ' + r.lines)];
  if (r.failed) out.push(rtl('⚠️ ' + r.failed + ' خطوة ما انمسحت (قاعدة البيانات ما ردّت)، جرّب مرة ثانية.'));
  else out.push(rtl('شغّل الحلقة من Nuvio وتنترجم من جديد.'));
  await edit(out.join('\n'));
}

async function onCallback(cq) {
  const m = /^([a-z]{2}):([0-9a-f]{8})$/.exec(String(cq.data || ''));
  const panel = m && panels.get(m[2]);
  if (m && panel && (m[1] === 'cl' || m[1] === 'cy' || m[1] === 'cn')) return onClearCallback(cq, m[1], m[2], panel);
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'انتهت صلاحية هذي اللوحة، ابعث /panel' }).catch(() => {});
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
    if (cq && /^go:/.test(String(cq.data || ''))) return await tgmanual.onCallback(cq, tg, tgbatch);
    if (cq && /^bn:/.test(String(cq.data || ''))) return await tgbatch.onCount(cq, tg);
    if (cq) return await onCallback(cq);
    const text = String((u.message && u.message.text) || '').trim();
    const rq = tgmanual.parse(text);
    if (rq) await tgmanual.onRequest(chatId, rq, tg, tgbatch.takeCount());
    else if (isBatchCmd(text)) await tgbatch.askCount(chatId, tg);
    else if (isStopCmd(text)) await tgbatch.stop(chatId, tg);
    else if (isClearCmd(text)) await sendAskClear(chatId);
    else if (isPanelCmd(text)) await sendPanel(chatId);
  } catch (e) {
    logErr('خطأ بمعالجة أمر', e);
  }
}

// ---------- الاستماع ----------
let running = false;
let stopped = false;

async function loop() {
  let offset = 0, fails = 0, drained = false;
  tg('setMyCommands', { commands: [{ command: 'panel', description: 'لوحة التحكم' }, { command: 'clear', description: 'امسح ترجمة آخر حلقة' }, { command: 'batch', description: 'جهّز دفعة حلقات (4/6/8/10)' }, { command: 'stop', description: 'أوقف الدفعة الشغالة' }] }).catch(() => {});
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
  console.log('[بوت التحكم] تيليغرام يسمع أوامرك ⟵ ابعث /panel أو /clear.');
  loop().catch(() => { running = false; });
}

function stop() { stopped = true; }

module.exports = { start, stop, noteTrack, noteContext: tgmanual.noteContext, enabled: ENABLED, _t: { handleUpdate, keyOf, hashOf, panels, sendPanel } };
