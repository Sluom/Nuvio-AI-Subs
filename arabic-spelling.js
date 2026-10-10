// arabic-spelling.js
// تصحيح الإملاء بالكود (بدل البرومبت):
//   1) كل كلمة تنتهي بـ ى تتحول إلى ي، ما عدا الكلمات الموجودة بقوائم الاستثناء.
//   2) كل كلمة تبدأ بـ "ال" وتنتهي بـ ه تتحول إلى ة، ما عدا الاستثناءات.
//   3) حارس: لو الموديل غيّر آخر حرف (ى/ي) بكلمة، نرجّع حرف المترجم الأصلي، والقاعدة بالكود هي اللي تقرر.
//   4) سجل: كل تحويل يُطبع بالـ log حتى تكمّل الاستثناءات بعد التجربة.
//
// القوائم تعدّلها بإيدك: أضف الكلمة بين الأقواس وافصل بمسافة. لا يهم الهمزة (أ/ا) ولا التشكيل.

'use strict';

const HAS_ARABIC = /[\u0600-\u06FF]/;
// وسم ASS/HTML، أو \N، أو كلمة. الوسوم و\N تُترك كما هي.
const TOKEN_RE = /\{[^}]*\}|<[^>]*>|\\+[nN]|[\p{L}\p{M}]+/gu;
const WORD_START = /^[\p{L}\p{M}]/u;
const PREFIX = new Set(['و', 'ف', 'ب', 'ك', 'ل']);

const norm = s => String(s).replace(/[\u0640\u064B-\u065F\u0670]/g, '').replace(/[أإآٱ]/g, 'ا');
const mk = str => new Set(String(str).split(/\s+/).filter(Boolean).map(norm));

// ============================================================
// القائمة 1: أسماء تبقى بـ ى
// ============================================================
// (أ) تبقى ى دائمًا
const NAMES_KEEP = mk(`
سلوى نجوى فدوى رضوى سجى لمى سهى زلفى مهى رؤى مصطفى موسى عيسى مرتضى مجتبى مرتجى
سلمى لبنى كسرى مثنى ضحى سعدى
`);
// (ب) أسماء/كلمات تحتمل الشكلين: تبقى كما كتبها المترجم
const NAMES_ASIS = mk(`
هدى بشرى منى يسرى ندى ليلى تقى جنى ذكرى يحيى رضى مقتدى نهى غنى على
`);

// ============================================================
// القائمة 2: كلمات عربية أصلها ى
// ============================================================
const WORDS_KEEP = mk(`
على الى إلى حتى متى لدى بلى سوى أنى شتى مرحى حاشى

مستشفى مقهى ملهى معنى مبنى مغزى مرعى منتدى مأوى مثوى مجرى مسعى ملتقى مستوى منتهى منفى مرمى منحنى مبتغى
فتوى شكوى دعوى حلوى تقوى فحوى بلوى عدوى هوى قوى أذى صدى مدى فتى حصى رحى حمى عصى شذى خطى قرى ظبى لظى ذرى

أعلى أدنى أقصى أغلى أحلى أقوى أسمى أعمى أشقى أولى أخرى كبرى صغرى وسطى قصوى عظمى حسنى أنثى حبلى

قتلى جرحى مرضى أسرى موتى صرعى سكارى حيارى يتامى نصارى كسالى

أتى مضى مشى رمى رأى بكى سعى رعى هوى شفى جرى حكى روى سقى كفى وفى قضى نوى طوى غوى نأى

أعطى أنهى أبقى أمضى أخفى أرضى أوفى أوصى أغنى أفنى أوحى ألقى أبكى أسقى أبلى أمسى أضحى
انتهى التقى اشترى ارتقى استوى استدعى استغنى اعتدى اهتدى احتوى اقتضى ارتدى انحنى ادعى اشتكى اكتفى
ابتغى ارتضى اعتنى اصطفى استقصى استخفى استهوى استولى استعلى استثنى استسقى استحى استلقى
التوى انطوى انزوى انتوى ارتوى اكتوى احتمى اتقى ابتلى ابتنى اقتنى افترى اعتلى امتطى
تولى تمنى تحدى تخطى تخلى تلقى تجلى تعالى تغذى تسلى توارى تلاشى تفادى تعافى تفانى تمادى تصدى تهاوى تراءى تبنى تسمى تدلى تحلى تلهى تنحى توخى
صلى حلى لبى لاقى ناجى عانى قاسى داوى راعى واسى جازى ساوى

يرى ترى أرى نرى
`);

// المضارع (يبقى/تبقى/أبقى/نبقى ...) والأمر (ابقى ...) نولّدها من الجذور
(function expandVerbs() {
  const stems = 'بقى سعى نسى خشى لقى شفى رضى هوى رعى شقى أبى نأى'.split(' ');
  for (const s of stems) for (const p of 'يتأن') WORDS_KEEP.add(norm(p + s));
  for (const s of stems) if (s !== 'هوى' && s !== 'أبى') WORDS_KEEP.add(norm('ا' + s));
  // أتمنى، أتحدى ... (مضارع الباب الخامس/السادس مع أ)
  for (const s of 'تمنى تحدى تخلى تولى تخطى تلقى تعافى تسلى تغذى تصدى تفادى تمادى تعالى'.split(' ')) {
    WORDS_KEEP.add(norm('ا' + s));
  }
})();

// مضارع الباب الخامس/السادس (يتمنى، تتحدى، نتعافى...) دائمًا بـ ى
const FORM_V = /^[يتن]ت\p{L}{2,}ى$/u;

const KEEP_YA = new Set([...NAMES_KEEP, ...NAMES_ASIS, ...WORDS_KEEP]);

// ============================================================
// تصحيحات لكلمات كاملة فقط (بدون سوابق)
// ============================================================
const EXACT = new Map([
  ['الى', 'إلى'], ['اى', 'أي'], ['كى', 'كي'],
  ['لاننى', 'لأنني'], ['لانني', 'لأنني'], ['اننى', 'أنني'], ['انني', 'أنني']
]);

// ============================================================
// القائمة 3: ة بدل ه بعد "ال"
// ============================================================
// تبقى ه
const TA_KEEP_H = mk(`
الله الاله الوجه الفقه الشبه السفه التافه الاتفه الابله المنتزه المتنزه الانزه الاوجه
`);
// تنتهي بـ اه وهي بالأصل ة (تتحول رغم القاعدة العامة)
const TA_FORCE = mk(`
الحياه الصلاه الزكاه النجاه الوفاه النواه القناه
`);

// ============================================================
module.exports = function createSpellFixer(fixTypoToken) {
  const LOG = new Map();
  const bump = (a, b) => { const k = a + ' → ' + b; LOG.set(k, (LOG.get(k) || 0) + 1); };

  // الكلمة مع/بدون السوابق (و ف ب ك ل) و"ال"/"لل"
  function candidates(n) {
    const out = [n];
    let t = n;
    for (let i = 0; i < 3 && t.length > 2; i++) {
      if (t.startsWith('لل') && t.length > 4) out.push(t.slice(2));
      if (t.startsWith('ال') && t.length > 4) out.push(t.slice(2));
      if (!PREFIX.has(t[0])) break;
      t = t.slice(1);
      out.push(t);
    }
    return out;
  }

  function fixYa(tok) {
    if (tok.length < 3) return tok;
    const n = norm(tok);
    for (const c of candidates(n)) {
      if (KEEP_YA.has(c) || FORM_V.test(c)) return tok;
    }
    const out = tok.slice(0, -1) + 'ي';
    bump(tok, out);
    return out;
  }

  function fixTa(tok) {
    if (tok.length < 5) return tok;
    const m = norm(tok).match(/^([وف]?[بكل]?)(ال|لل)(.+)$/);
    if (!m || m[3].length < 3) return tok;
    const base = 'ال' + m[3];
    if (TA_FORCE.has(base)) { const o = tok.slice(0, -1) + 'ة'; bump(tok, o); return o; }
    if (TA_KEEP_H.has(base)) return tok;
    if (/[اوي]ه$/.test(base)) return tok;           // نهايات ملتبسة: اتجاه، توجيه، مياه ...
    const o = tok.slice(0, -1) + 'ة';
    bump(tok, o);
    return o;
  }

  function fixToken(tok) {
    const ex = EXACT.get(tok);
    if (ex) return ex;
    const viaDict = fixTypoToken(tok);                 // القاموس المغلق الموجود بالمصحح
    if (viaDict !== tok) return viaDict;
    const last = tok[tok.length - 1];
    if (last === 'ى') return fixYa(tok);
    if (last === 'ه') return fixTa(tok);
    return tok;
  }

  function fix(txt) {
    return String(txt == null ? '' : txt).replace(TOKEN_RE, t =>
      (WORD_START.test(t) && HAS_ARABIC.test(t)) ? fixToken(t) : t);
  }

  const arabicTokens = s => (String(s).match(TOKEN_RE) || []).filter(t => WORD_START.test(t) && HAS_ARABIC.test(t));

  // لو الموديل غيّر آخر حرف (ى <-> ي) نرجّع حرف المترجم الأصلي.
  function restoreFinalYa(orig, out) {
    const a = arabicTokens(orig), b = arabicTokens(out);
    if (!a.length || a.length !== b.length) return out;
    let k = 0;
    return String(out).replace(TOKEN_RE, t => {
      if (!WORD_START.test(t) || !HAS_ARABIC.test(t)) return t;
      const o = a[k++];
      const lo = o.slice(-1), lt = t.slice(-1);
      if (lo !== lt && (lo === 'ى' || lo === 'ي') && (lt === 'ى' || lt === 'ي')
          && norm(o.slice(0, -1)) === norm(t.slice(0, -1))) {
        return t.slice(0, -1) + lo;
      }
      return t;
    });
  }

  // اطبع التحويلات (الأكثر تكرارًا أولًا) حتى تراجعها وتضيف الاستثناءات الناقصة
  function flushLog(limit = 60) {
    if (!LOG.size) return;
    const rows = [...LOG.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    console.log(`\u200F[إملاء 📝] ${LOG.size} تحويل مختلف: ${rows.join(' | ')}`);
    LOG.clear();
  }

  return { fix, restoreFinalYa, flushLog };
};
