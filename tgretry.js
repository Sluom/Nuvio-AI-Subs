'use strict';
// زر إعادة التجهيز تحت إشعارات الفشل: "أكمل الناقص فقط" (يحتفظ بالأسطر الناجحة) أو "من الصفر" (يمسح كاش أسطر التراك أيضاً).
const cacheclear = require('./cacheclear');
const manual = require('./tgmanual');

const RLM = '\u200F';
const rtl = t => RLM + t;

async function onCallback(cq, tg) {
  const m = /^rt:([mz]):([sa]):(\d+):(tt\d+(?::\d+:\d+)?)$/.exec(String(cq.data || ''));
  const answer = text => tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  if (!m) { await answer('زر غير صالح'); return; }
  const mode = m[1];
  const ext = m[2] === 'a' ? 'ass' : 'srt';
  const track = +m[3];
  const targetId = m[4];
  if (!manual.getCtx()) { await answer('افتح حلقة من Nuvio مرة وحدة أول'); return; }
  await answer('جاري إعادة التجهيز...');
  const msg = cq.message;
  const edit = suffix => (msg && msg.chat && msg.message_id)
    ? tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: String(msg.text || '') + '\n' + suffix, disable_web_page_preview: true }).catch(() => {})
    : Promise.resolve();
  const cleared = await cacheclear.clearTrack(targetId, ext, track, mode === 'z');
  const type = /^tt\d+$/.test(targetId) ? 'movie' : 'series';
  const tracks = await manual.fetchTracks(type, targetId).catch(() => null);
  const t = tracks && tracks.find(x => x.ext === ext && x.track === track);
  if (!t) { await edit(rtl('⚠️ انمسح التراك، بس ما لقيت ' + ext.toUpperCase() + ' ' + track + ' بالقائمة. شغّله من Nuvio.')); return; }
  const started = await manual.startPath(t.path);
  console.log('[إعادة تجهيز] ' + targetId + ' ' + ext.toUpperCase() + ' ' + track + (mode === 'z' ? ' (من الصفر)' : ' (الناقص فقط)') + (started === null ? ': تعذر البدء' : started ? ': بدأ' : ': جاهز') + (cleared.failed ? ' | خطوة مسح فشلت' : ''));
  if (started === null) { await edit(rtl('⚠️ تعذر بدء التجهيز، جرّب مرة ثانية.')); return; }
  await edit(rtl(started ? '🔁 بدأت إعادة التجهيز (' + (mode === 'z' ? 'من الصفر' : 'الناقص فقط') + ') ⏳ يوصلك إشعار لما يخلص.' : '✅ التراك جاهز، شغّله من Nuvio.'));
}

module.exports = { onCallback };
