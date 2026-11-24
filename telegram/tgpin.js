'use strict';
const db = require('../core/db');
const srcpins = require('../core/srcpins');
const { TRACKS_TAG } = require('../ai/corrector');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }

const RLM = '‏';
const LRI = '⁦';
const PDI = '⁩';
const rtl = t => RLM + t;
const latin = t => LRI + t + PDI;

const STEP_TIMEOUT_MS = 8000;
const MAX_SHOWN = 20;
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

let H = {};
function init(h) { H = h || {}; }

const kindName = k => (k === 'ass' ? 'ASS' : 'SRT');
const slotOf = k => (k === 'ass' ? 'a' : 's');
const idPart = p => String(p.pack || p.name || '').trim();

function pinCmd(text) {
  const m = /^\/pins?(?:@\w+)?\s*$/i.exec(String(text || '').trim());
  return m ? true : null;
}

function pinLines(pin, imdb, withTitle) {
  const out = [];
  if (withTitle) out.push(rtl('🎬 ' + latin((pin.title ? pin.title + ' ' : '') + '(' + imdb + ')')));
  out.push(rtl('🔢 ' + latin(kindName(pin.kind)) + ' تراك ' + pin.track));
  out.push(rtl('📦 ' + latin(pin.site + (pin.pack ? ' ' + pin.pack : ''))));
  if (pin.name) out.push(rtl('📝 ' + latin(pin.name)));
  return out;
}

function listView(rows) {
  const flat = [];
  for (const r of rows || []) for (const p of r.pins) flat.push({ imdb: r.imdb, pin: p });
  if (!flat.length) {
    return { text: [rtl('📌 ما عندك تثبيتات حالياً.'), rtl('اضغط 📌 ثبّت هذا المصدر تحت إشعار «اكتمل» لتثبيت مصدر لمسلسل.')].join('\n'), markup: null };
  }
  const shown = flat.slice(0, MAX_SHOWN);
  const lines = [rtl('📌 التثبيتات الحالية (' + flat.length + ')')];
  const buttons = [];
  shown.forEach((x, i) => {
    const n = KEYCAPS[i] || String(i + 1);
    lines.push('');
    lines.push(rtl(n + ' 🎬 ' + latin((x.pin.title || x.imdb) + ' (' + x.imdb + ')')));
    lines.push(rtl('   ' + latin(kindName(x.pin.kind)) + ' تراك ' + x.pin.track + ' ← ' + latin(x.pin.site + (x.pin.pack ? ' ' + x.pin.pack : ''))));
    if (x.pin.name) lines.push(rtl('   📝 ' + latin(x.pin.name)));
    const short = String(x.pin.title || x.imdb).slice(0, 14);
    buttons.push({ text: '🗑 ألغِ ' + (i + 1) + ' (' + short + ')', callback_data: 'pd:' + x.imdb + ':' + slotOf(x.pin.kind) + ':' + x.pin.track + ':l' });
  });
  if (flat.length > shown.length) lines.push('', rtl('+' + (flat.length - shown.length) + ' تثبيت آخر ما انعرض'));
  const kb = [];
  for (let i = 0; i < buttons.length; i += 2) kb.push(buttons.slice(i, i + 2));
  return { text: lines.join('\n'), markup: { inline_keyboard: kb } };
}

async function onPinCmd(chatId) {
  try {
    const rows = await H.withTimeout(srcpins.listAll(), STEP_TIMEOUT_MS);
    if (!rows) {
      await H.tg('sendMessage', { chat_id: chatId, text: rtl('⚠️ ما قدرت أقرأ التثبيتات (قاعدة البيانات ما ردّت). جرّب بعد شوي.') }).catch(() => {});
      return;
    }
    const v = listView(rows);
    await H.tg('sendMessage', { chat_id: chatId, text: v.text, disable_web_page_preview: true, ...(v.markup ? { reply_markup: v.markup } : {}) });
  } catch (e) {
    H.logErr('خطأ بأمر التثبيت', e);
  }
}

function swapPinRow(msg, slot, track, targetId, on) {
  const kb = msg && msg.reply_markup && Array.isArray(msg.reply_markup.inline_keyboard) ? msg.reply_markup.inline_keyboard : null;
  if (!kb) return null;
  const tail = slot + ':' + track + ':' + targetId;
  return kb.map(row => row.map(b => {
    const d = String(b.callback_data || '');
    if (d === 'pn:' + tail || d === 'pu:' + tail) {
      return on
        ? { text: '📌 مثبّت ✓ (اضغط للإلغاء)', callback_data: 'pu:' + tail }
        : { text: '📌 ثبّت هذا المصدر', callback_data: 'pn:' + tail };
    }
    return b;
  }));
}

async function setRow(cq, slot, track, targetId, on) {
  const next = swapPinRow(cq.message, slot, track, targetId, on);
  if (!next || !cq.message || !cq.message.chat) return;
  await H.tg('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: next } }).catch(() => {});
}

const FAIL_TEXT = {
  db: 'قاعدة البيانات ما ردّت، جرّب مرة ثانية',
  full: 'وصلت الحد الأعلى للتثبيتات لهذا المسلسل (' + srcpins.MAX_PINS_PER_SERIES + ')',
  noid: 'ما قدرت أحدد هوية هذا المصدر',
  bad: 'طلب غير صالح'
};

async function onPin(cq, m) {
  const slot = m[1];
  const kind = srcpins.kindOf(slot);
  const track = +m[2];
  const targetId = m[3];
  const imdb = srcpins.imdbOf(targetId);
  if (!imdb || !/^tt\d+:\d+:\d+$/.test(targetId)) { await H.answerCb(cq, 'التثبيت للمسلسلات فقط'); return; }
  const doc = await H.withTimeout(db.loadDoc('job', 'corr_pins_' + targetId + TRACKS_TAG), STEP_TIMEOUT_MS);
  const entry = doc && Array.isArray(doc[kind]) ? doc[kind][track - 1] : null;
  if (!entry || !entry.url) { await H.answerCb(cq, 'ما لقيت معلومات هذا التراك (يمكن انمسح ترتيبه)'); return; }
  let title = null;
  try { title = notify && notify.titleOf ? await notify.titleOf(targetId, 'series') : null; } catch (e) { title = null; }
  const pin = {
    kind, track,
    site: String(entry._site || entry._source || '').toLowerCase(),
    pack: srcpins.packOf(entry.url),
    name: String(entry.name || '').trim(),
    title: title || ''
  };
  const res = await srcpins.add(imdb, pin);
  if (!res.ok) { await H.answerCb(cq, FAIL_TEXT[res.reason] || 'تعذر التثبيت'); return; }
  console.log('[تثبيت 📌] ' + imdb + ' ' + kindName(kind) + ' تراك ' + track + ' ⟵ ' + pin.site + ' ' + (pin.pack || pin.name));
  await H.answerCb(cq, '📌 تم التثبيت');
  await setRow(cq, slot, track, targetId, true);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const lines = [rtl('📌 تم تثبيت المصدر'), ...pinLines(res.pin, imdb, true)];
  if (res.replaced) lines.push(rtl('🔄 استبدل تثبيت سابق: ' + latin(res.replaced.site + (res.replaced.pack ? ' ' + res.replaced.pack : ''))));
  lines.push('', rtl('✅ يسري من الحلقات الجاية.'), rtl('ℹ️ الحلقات المجهّزة قبل تبقى مثل ما هي.'));
  await H.tg('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '🗑 ألغِ التثبيت', callback_data: 'pd:' + imdb + ':' + slot + ':' + track + ':c' }]] }
  }).catch(() => {});
}

async function onUnpinFromNotice(cq, m) {
  const slot = m[1];
  const track = +m[2];
  const targetId = m[3];
  const imdb = srcpins.imdbOf(targetId);
  const res = await srcpins.remove(imdb, slot, track);
  if (!res.ok) { await H.answerCb(cq, FAIL_TEXT[res.reason] || 'تعذر الإلغاء'); return; }
  console.log('[تثبيت 🗑] ' + imdb + ' ' + kindName(srcpins.kindOf(slot)) + ' تراك ' + track + ' أُلغي');
  await H.answerCb(cq, res.removed ? '🗑 أُلغي التثبيت — رجع الترتيب العادي' : 'ما كان مثبّت');
  await setRow(cq, slot, track, targetId, false);
}

async function onDelete(cq, m) {
  const imdb = m[1];
  const slot = m[2];
  const track = +m[3];
  const from = m[4];
  const res = await srcpins.remove(imdb, slot, track);
  if (!res.ok) { await H.answerCb(cq, FAIL_TEXT[res.reason] || 'تعذر الإلغاء'); return; }
  console.log('[تثبيت 🗑] ' + imdb + ' ' + kindName(srcpins.kindOf(slot)) + ' تراك ' + track + ' أُلغي');
  const who = res.removed ? (res.removed.title || imdb) : imdb;
  await H.answerCb(cq, res.removed ? '🗑 أُلغي تثبيت ' + who + ' — رجع الترتيب العادي' : 'ما كان مثبّت');
  const msg = cq.message;
  if (!msg || !msg.chat) return;
  if (from === 'l') {
    const rows = await H.withTimeout(srcpins.listAll(), STEP_TIMEOUT_MS);
    if (!rows) return;
    const v = listView(rows);
    await H.tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: v.text, disable_web_page_preview: true, ...(v.markup ? { reply_markup: v.markup } : {}) }).catch(() => {});
  } else {
    const lines = [rtl('🗑 أُلغي التثبيت'), ...(res.removed ? pinLines(res.removed, imdb, true) : []), '', rtl('الحلقات الجاية ترجع للخانات العادية.')];
    await H.tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: lines.join('\n'), disable_web_page_preview: true }).catch(() => {});
  }
}

async function onPinCallback(cq) {
  const data = String((cq && cq.data) || '');
  try {
    let m = /^pn:([sa]):(\d+):(.+)$/.exec(data);
    if (m) return await onPin(cq, m);
    m = /^pu:([sa]):(\d+):(.+)$/.exec(data);
    if (m) return await onUnpinFromNotice(cq, m);
    m = /^pd:(tt\d+):([sa]):(\d+):([lc])$/.exec(data);
    if (m) return await onDelete(cq, m);
  } catch (e) {
    H.logErr('خطأ بأزرار التثبيت', e);
    await H.answerCb(cq, 'تعذر تنفيذ الطلب، جرّب مرة ثانية');
  }
}

module.exports = { init, pinCmd, onPinCmd, onPinCallback, listView };
