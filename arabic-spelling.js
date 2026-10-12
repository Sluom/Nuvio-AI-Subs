'use strict';

const HAS_ARABIC = /[\u0600-\u06FF]/;
const TOKEN_RE = /\{[^}]*\}|<[^>]*>|\\+[nN]|[\p{L}\p{M}]+/gu;
const WORD_START = /^[\p{L}\p{M}]/u;
const PREFIX = new Set(['و', 'ف', 'ب', 'ك', 'ل', 'س']);

const norm = s => String(s).replace(/[\u0640\u064B-\u065F\u0670]/g, '').replace(/[أإآٱ]/g, 'ا');
const mk = str => new Set(String(str).split(/\s+/).filter(Boolean).map(norm));

// ============================================================
// القائمة 1: أسماء تبقى بـ ى (صافية 100%)
// ============================================================
const NAMES_KEEP = mk(`
سلوى نجوى فدوى رضوى سجى لمى سهى زلفى مهى رؤى مصطفى موسى عيسى مرتضى مجتبى مرتجى
سلمى لبنى كسرى مثنى ضحى سعدى عبد العزى بحيرى
`);

// ============================================================
// القائمة 2: الكلمات المزدوجة (تُترك كما كتبها المترجم)
// ============================================================
const NAMES_ASIS = mk(`
هدى بشرى منى يسرى ندى ليلى تقى جنى ذكرى يحيى رضى مقتدى نهى غنى على
يسمى يدعى يعفى يرجى يخفى يلقى ينهى يسقى يرمى يبلى يطوى يجلى يهدى يرضى يفنى يروى يشوى يكوى يطلى يعمى
محتوى مستدعى معطى مفتى متبنى مبنى مرمى مسعى مغشى مشتكى معافى مرتجى يمنى يسرى منتهى معنى مبتغى
كبرى صغرى مسمى يلغى يعطى يبنى ينفى يجرى يبدى يولى يثنى يجنى يصلى مدعى ملتقى منفى مغنى مستثنى 
مقتنى ملقى مبقى معلى مغطى مزكى مصلى أعلى أغلى أدنى أقوى أقصى أحلى أوفى أبقى ألقى أخفى أمضى أرضى أنهى
مرضى قتلى أسرى جرحى موتى صرعى سمى أوحى أدى تشترى يشترى تعطى أعطى بصرى ماعدى عدى نعطى يرثى ترثى نرثى أرثى مستوى
أغمى يغمى تغمى نغمى دعى ندعى تدعى أسمى علفى المستوى أفشى يفشى تفشى نفشى ارتدى المحلى تمحى مغزى بنى
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
يرى ترى أرى نرى أخرى أولى أعمى مأوى وثقى عطاشى أتوانى إحدى 
أغبى لاتنسى أتبنى مشفى أترى أفعى أتعرى أذكى دمى أسى
`);

// ============================================================
// القائمة 4: الإجبار العكسي (تُكتب بالـ ي خطأً ويجب إجبارها على الـ ى)
// ============================================================
const FORCE_ALIF = mk(`
مستشفى مقهى ملهى حتى متى بلى إحدى أخرى أولى أدنى أقصى أعلى أغلى
مصطفى عيسى موسى كسرى شتى دعوى شكوى فتوى جدوى قصارى فوضى
`);

// بناء الأفعال تلقائياً
(function expandVerbs() {
  const stems = 'بقى سعى نسى خشى لقى شفى رضى هوى رعى شقى أبى نأى حظى طغى تعدى تلوى وصى'.split(' ');
  for (const s of stems) for (const p of 'يتأن') WORDS_KEEP.add(norm(p + s));
  for (const s of stems) if (s !== 'هوى' && s !== 'أبى') WORDS_KEEP.add(norm('ا' + s));
  for (const s of 'تمنى تحدى تخلى تولى تخطى تلقى تعافى تسلى تغذى تصدى تفادى تمادى تعالى'.split(' ')) {
    WORDS_KEEP.add(norm('ا' + s));
  }
})();

const FORM_V = /^[يتن]ت\p{L}{2,}ى$/u;

const KEEP_YA = new Set([...NAMES_KEEP, ...NAMES_ASIS, ...WORDS_KEEP]);

// تصحيحات لكلمات كاملة فقط
const EXACT = new Map([
  ['الى', 'إلى'], ['اى', 'أي'], ['كى', 'كي'],
  ['لاننى', 'لأنني'], ['لانني', 'لأنني'], ['اننى', 'أنني'], ['انني', 'أنني']
]);

// توليد التصحيحات العكسية تلقائياً من قائمة FORCE_ALIF
for (const w of FORCE_ALIF) {
  if (w.endsWith('ى')) {
    EXACT.set(w.slice(0, -1) + 'ي', w); // يحول "مستشفي" إلى "مستشفى"
    // معالجة حالة الكلمات اللي تبدأ بهمزة (إحدي/احدي)
    if (w.startsWith('ا')) EXACT.set('ا' + w.slice(1, -1) + 'ي', w);
  }
}

module.exports = function createSpellFixer(fixTypoToken) {
  const LOG = new Map();
  const bump = (a, b) => { const k = a + ' → ' + b; LOG.set(k, (LOG.get(k) || 0) + 1); };

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
    const viaDict = fixTypoToken(tok);
    if (viaDict !== tok) return viaDict;
    const last = tok[tok.length - 1];
    if (last === 'ى') return fixYa(tok);
    return tok;
  }

  function fix(txt) {
    return String(txt == null ? '' : txt).replace(TOKEN_RE, t =>
      (WORD_START.test(t) && HAS_ARABIC.test(t)) ? fixToken(t) : t);
  }

  const arabicTokens = s => (String(s).match(TOKEN_RE) || []).filter(t => WORD_START.test(t) && HAS_ARABIC.test(t));

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

  function flushLog(limit = 60) {
    if (!LOG.size) return;
    const rows = [...LOG.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    console.log(`\u200F[إملاء 📝] ${LOG.size} تحويل مختلف: ${rows.join(' | ')}`);
    LOG.clear();
  }

  return { fix, restoreFinalYa, flushLog };
};
