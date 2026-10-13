// corrector-marks.js
// الفكرة: الموديل يقترح، والكود يقرر ويصلح. هنا كل ما يخص التنصيص والأقواس وعلامات الأسماء.
//
// السياسة:
//  1) أسماء الأشخاص = تنصيص " "     |  الشركات والدول والأماكن والأكلات = أقواس ( )
//     الموديل يقرر النوع (حسب القاعدتين 5 و6 في البرومبت)، والكود يضمن الاتساق:
//     نفس الاسم يأخذ نفس العلامة في كل الملف (حسب الأغلبية).
//  2) داخل الأسطر المنقولة (q) لا نلمس الأسماء، لأن القاعدة 7 تمنع التنصيص الداخلي.
//  3) الكود يفرض: لا مسافات داخل العلامات، توازن العلامات، علامة تنصيص واحدة مستقيمة " (لا تنعكس بالـRTL).
//  4) الاسم الذي علّمه الموديل في أغلب ظهوره يُعلَّم في كل مكان (حتى الأسطر التي نسيها).

const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const LETTER = /[\p{L}\p{N}]/u;

const NAME_MIN_WRAPS = 2;      // أقل عدد مرات لُفّ فيها الاسم (تنصيص أو أقواس) حتى نعممه
const NAME_MIN_RATIO = 0.6;    // نسبة المرات الملفوفة من كل ظهور
const NAME_MIN_LEN = 3;

function maskTags(text) {
  const tags = [];
  const masked = String(text).replace(TAG_RE, t => { tags.push(t); return '\uE000' + (tags.length - 1) + '\uE001'; });
  return { masked, tags };
}
const unmaskTags = (text, tags) => text.replace(PH_RE, (_, i) => tags[+i]);

// ينظف سطرًا واحدًا: يوحّد شكل التنصيص، يشيل المسافات الداخلية، ويكشف التنصيص غير المغلق
function tidyQuotes(line) {
  line = line.replace(/[“”„«»]/g, '"');
  let out = '', open = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== '"') { out += ch; continue; }
    if (!open) {
      open = true;
      if (LETTER.test(out.slice(-1))) out += ' ';
      out += '"';
      while (line[i + 1] === ' ') i++;
    } else {
      open = false;
      out = out.replace(/ +$/, '') + '"';
      if (LETTER.test(line[i + 1] || '')) out += ' ';
    }
  }
  return { text: out, unclosed: open };
}

function tidyParens(line) {
  return line
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\)([\p{L}\p{N}])/gu, ') $1');
}

const DASH_LEAD = /^[-–—]\s*/;
const stripQ = s => s.replace(/"/g, '').replace(/ {2,}/g, ' ').trim();

// يفرض تلميح q (محسوب من الأصل): لا تنصيص داخلي إطلاقًا، فقط علامة الحافة المطلوبة
function enforceHint(lines, q) {
  const split = lines.map(l => {
    const dm = l.match(DASH_LEAD);
    return { dash: dm ? '- ' : '', body: stripQ(dm ? l.slice(dm[0].length) : l) };
  });
  if (Array.isArray(q)) {
    if (q.length !== split.length) return null;
    return split.map((s, i) => {
      const h = q[i];
      const b = h === 'whole' ? '"' + s.body + '"' : h === 'open' ? '"' + s.body : h === 'close' ? s.body + '"' : s.body;
      return s.dash + b;
    });
  }
  const first = split[0], last = split[split.length - 1];
  // العلامة تأتي بعد وسوم أول السطر وقبل وسوم آخره
  if (q === 'whole' || q === 'open') first.body = first.body.replace(/^((?:\uE000\d+\uE001|\s)*)/, '$1"');
  if (q === 'whole' || q === 'close') last.body = last.body.replace(/((?:\uE000\d+\uE001|\s)*)$/, '"$1');
  return split.map(s => s.dash + s.body);
}

// نقطة الدخول: تُستدعى على نص السطر النهائي (فواصل \n) بعد cleanCorrectorOutput
function fixMarks(text, q = null) {
  const { masked, tags } = maskTags(text);
  let lines = masked.split('\n');

  if (q) {
    const forced = enforceHint(lines, q);
    if (forced) lines = forced;
  } else {
    lines = lines.map(l => {
      let t = tidyQuotes(l);
      if (t.unclosed || (t.text.match(/"/g) || []).length % 2) t = tidyQuotes(l.replace(/["“”„«»]/g, ''));
      return t.text;
    });
  }
  return unmaskTags(lines.map(tidyParens).join('\n'), tags);
}

// ============================================================
// اتساق الأسماء على مستوى الملف كله
// ============================================================
const AR_TOKEN = /"([^"\n]*)"|\(([^()\n]*)\)|([\u0621-\u065F\u0670-\u06D3]+)/g;
const ONE_WORD = /^[\u0621-\u065F\u0670-\u06D3]+$/;
const nameKey = w => w.replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا');

// texts: النصوص النهائية
// eligible[i]: هل نلمس السطر؟ (عربي ومصحح وليس سطر كلام منقول q ولا رسم)
function propagateNames(texts, eligible) {
  const st = new Map();   // key -> { q, p, b }
  const get = k => { let o = st.get(k); if (!o) st.set(k, o = { q: 0, p: 0, b: 0 }); return o; };

  texts.forEach((t, i) => {
    if (!eligible[i]) return;
    for (const m of String(t).matchAll(AR_TOKEN)) {
      if (m[3]) get(nameKey(m[3])).b++;
      else if (m[1] && ONE_WORD.test(m[1])) get(nameKey(m[1])).q++;
      else if (m[2] && ONE_WORD.test(m[2])) get(nameKey(m[2])).p++;
    }
  });

  // الاسم = كلمة علّمها الموديل (تنصيص أو أقواس) في أغلب ظهورها. العلامة الفائزة = الأكثر (تعادل = تنصيص)
  const names = new Map();
  for (const [k, o] of st) {
    const marked = o.q + o.p;
    if (k.length >= NAME_MIN_LEN && marked >= NAME_MIN_WRAPS && marked / (marked + o.b) >= NAME_MIN_RATIO) {
      names.set(k, o.q >= o.p ? 'q' : 'p');
    }
  }
  if (!names.size) return texts;

  const wrap = (w, kind) => (kind === 'q' ? '"' + w + '"' : '(' + w + ')');
  return texts.map((t, i) => {
    if (!eligible[i]) return t;
    return String(t).replace(AR_TOKEN, (all, q, p, bare) => {
      const word = bare || (q != null && ONE_WORD.test(q) ? q : null) || (p != null && ONE_WORD.test(p) ? p : null);
      if (!word) return all;
      const kind = names.get(nameKey(word));
      return kind ? wrap(word, kind) : all;
    });
  });
}

module.exports = { fixMarks, propagateNames, tidyQuotes, tidyParens };
