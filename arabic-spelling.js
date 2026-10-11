// arabic-spelling.js
// تصحيح الإملاء بالكود (بدل البرومبت):
//   1) كل كلمة تنتهي بـ ى تتحول إلى ي، ما عدا الكلمات الموجودة بقوائم الاستثناء.
//   2) تم إلغاء قاعدة تحويل (ه -> ة) بناءً على الطلب.
//   3) حارس: لو الموديل غيّر آخر حرف (ى/ي) بكلمة، نرجّع حرف المترجم الأصلي، والقاعدة بالكود هي اللي تقرر.
//   4) سجل: كل تحويل يُطبع بالـ log حتى تكمّل الاستثناءات بعد التجربة.

'use strict';

const HAS_ARABIC = /[\u0600-\u06FF]/;
// وسم ASS/HTML، أو \N، أو كلمة. الوسوم و\N تُترك كما هي.
const TOKEN_RE = /\{[^}]*\}|<[^>]*>|\\+[nN]|[\p{L}\p{M}]+/gu;
const WORD_START = /^[\p{L}\p{M}]/u;

// تم إضافة حرف الـ (س) لمعالجة أفعال المستقبل مثل (سنتولى، سيبقى)
const PREFIX = new Set(['و', 'ف', 'ب', 'ك', 'ل', 'س']);

const norm = s => String(s).replace(/[\u0640\u064B-\u065F\u0670]/g, '').replace(/[أإآٱ]/g, 'ا');
const mk = str => new Set(String(str).split(/\s+/).filter(Boolean).map(norm));

// ============================================================
// القائمة 1: أسماء تبقى بـ ى (صافية 100%)
// ============================================================
const NAMES_KEEP = mk(`
سلوى نجوى فدوى رضوى سجى لمى سهى زلفى مهى رؤى مصطفى موسى عيسى مرتضى مجتبى مرتجى
سلمى لبنى كسرى مثنى ضحى سعدى
`);

// ============================================================
// القائمة 2: الكلمات المزدوجة (تُترك كما كتبها المترجم - المصحح يغلس عليها)
// ============================================================
const NAMES_ASIS = mk(`
هدى بشرى منى يسرى ندى ليلى تقى جنى ذكرى يحيى رضى مقتدى نهى غنى على
يسمى يدعى يعفى يرجى يخفى يلقى ينهى يسقى يرمى يبلى يطوى يجلى يهدى يرضى يفنى يروى يشوى يكوى يطلى يعمى
محتوى مستدعى معطى مفتى متبنى مبنى مرمى مسعى مغشى مشتكى معافى مرتجى يمنى يسرى منتهى معنى مبتغى
كبرى صغرى مسمى يلغى يعطى يبنى ينفى يجرى يبدى يولى يثنى يجنى يصلى مدعى ملتقى منفى مغنى مستثنى 
مقتنى ملقى مبقى معلى مغطى مزكى مصلى أعلى أغلى أدنى أقوى أقصى أحلى أوفى أبقى ألقى أخفى أمضى أرضى أنهى
 مرضى قتلى أسرى جرحى موتى صرعى 
 
`);

// ============================================================
// القائمة 3: كلمات عربية أصلها ى (صافية 100%)
// ============================================================
const WORDS_KEEP = mk(`
الى إلى حتى متى لدى بلى سوى أنى شتى مرحى حاشى
موسيقى فوضى جدوى قصارى طوبى عقبى حمقى غرقى جوعى عطشى عذارى غيارى شكاوى فتاوى دعاوى أسارى
مستشفى مقهى ملهى فتوى شكوى دعوى حلوى تقوى فحوى بلوى عدوى هوى قوى أذى صدى مدى فتى حصى رحى حمى عصى شذى خطى قرى ظبى لظى ذرى
حسنى أنثى حبلى نصارى كسالى يتامى حيارى سكارى
أتى مضى مشى رمى رأى بكى سعى رعى هوى شفى جرى حكى روى سقى كفى وفى قضى نوى طوى غوى نأى
انتهى التقى اشترى ارتقى استوى اعتدى اهتدى احتوى اقتضى ارتدى انحنى ادعى اشتكى اكتفى
ابتغى ارتضى اعتنى اصطفى استقصى استخفى استهوى استولى استعلى استثنى استسقى استحى استلقى
التوى انطوى انزوى انتوى ارتوى اكتوى احتمى اتقى ابتلى ابتنى اقتنى افترى اعتلى امتطى
تولى تمنى تحدى تخطى تخلى تلقى تجلى تعالى تغذى تسلى توارى تلاشى تفادى تعافى تفانى تمادى تصدى تهاوى تراءى تبنى تسمى تدلى تحلى تلهى تنحى توخى
صلى حلى لبى لاقى ناجى عانى قاسى داوى راعى واسى جازى ساوى
يرى ترى أرى نرى
`);

// بناء الأفعال تلقائياً
(function expandVerbs() {
  // تم إضافة جذر "حظى" للتعرف على: يحظى، تحظى، الخ
  const stems = 'بقى سعى نسى خشى لقى شفى رضى هوى رعى شقى أبى نأى حظى'.split(' ');
  for (const s of stems) for (const p of 'يتأن') WORDS_KEEP.add(norm(p + s));
  for (const s of stems) if (s !== 'هوى' && s !== 'أبى') WORDS_KEEP.add(norm('ا' + s));
  // مضارع الباب الخامس/السادس مع أ
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
module.exports = function createSpellFixer(fixTypoToken) {
  const LOG = new Map();
  const bump = (a, b) => { const k = a + ' → ' + b; LOG.set(k, (LOG.get(k) || 0) + 1); };

  // الكلمة مع/بدون السوابق و"ال"/"لل"
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

  function fixToken(tok) {
    const ex = EXACT.get(tok);
    if (ex) return ex;
    const viaDict = fixTypoToken(tok); // القاموس المغلق الموجود بالمصحح
    if (viaDict !== tok) return viaDict;
    const last = tok[tok.length - 1];
    if (last === 'ى') return fixYa(tok);
    // تم إلغاء تحويل (هـ) إلى (ة)
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

  // اطبع التحويلات (الأكثر تكرارًا أولًا)
  function flushLog(limit = 60) {
    if (!LOG.size) return;
    const rows = [...LOG.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    console.log(`\u200F[إملاء 📝] ${LOG.size} تحويل مختلف: ${rows.join(' | ')}`);
    LOG.clear();
  }

  return { fix, restoreFinalYa, flushLog };
};
