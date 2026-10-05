// ==================================================================================
// corrector.js : مسار المصحح العربي المستقل (يجلب ترجمات عربية جاهزة ويصحح الترقيم فقط)
// يعتمد على مشتركات ai.js ولا يغيّر شيئاً في مسار الترجمة.
// ==================================================================================
const {
  axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
  normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
  MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent, parseIdTranslations, buildChunkContext,
  needsTranslation, getLineCache, aliveKeyCount, MAX_MISSING_RETRIES, fetchAndExtractSub,
  extractCuesUniversal, normalizeLineBreakArtifacts, ASS_DEFAULT_HEADER
} = require('./ai').shared;

// ==================================================================================
// ================== مسار المصحح العربي (Arabic Correction Path) ==================
// ==================================================================================

// تنظيف مخرجات المصحح: بدون أقواس مربعة وبدون رموز اتجاه مخفية
const CORRECTOR_STRIP_BRACKETS = true;
const CORRECTOR_WRAP_AT = 42;   // أي سطر مفرد أطول من هذا ينكسر لسطرين متوازنين (0 = إيقاف)
const CORRECTOR_CHUNK = 350;       // حجم الدفعة الأولى
const CORRECTOR_MAX_WORKERS = 8;   // أقصى عدد مفاتيح تعمل بالتوازي

// ترتيب الأسطر وعلامات الترقيم بالكود (لا يعتمد على الموديل)
const TERM_CHARS = '.…!؟?،,؛:';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const DASH_RE = /^[-–—]/;

function visibleLen(s) { return String(s).replace(/<[^>]*>|\{[^}]*\}/g, '').length; }

// نقطة/علامة نهاية في أول السطر (أو قبل شرطة الحوار) تنتقل لآخره
function moveLeadingPunct(line) {
  let t = line.trim();
  let hasDash = false;

  // 1. شرطة الحوار: تُسحب للبداية (سواء كانت بالبداية أو متأخرة بالنهاية)
  if (/^[-–—]\s*/.test(t)) { hasDash = true; t = t.replace(/^[-–—]\s*/, ''); }
  if (/\s*[-–—]$/.test(t)) { hasDash = true; t = t.replace(/\s*[-–—]$/, ''); }

  // 2. علامة نهاية في أول السطر تنتقل لآخره (والنقطتان : تنتقل دائماً لآخره)
  const m = t.match(/^([.…!؟?،,؛:]+)\s*(.+)$/);
  if (m) {
    const lead = m[1], rest = m[2];
    if (HAS_ARABIC.test(rest) && !(lead === '…' || /^\.{3,}$/.test(lead))) {
      if (lead.includes(':')) {
        t = rest.replace(/[.…!؟?،,؛\s]+$/, '') + ':';
      } else {
        const core = rest.replace(/["'”“)\]»\s]+$/, '');
        if (core && !TERM_CHARS.includes(core[core.length - 1])) {
          t = rest + lead;
        } else {
          t = rest;
        }
      }
    }
  }

  return (hasDash ? '- ' : '') + t.trim();
}

function splitSpeakers(line) {
  if (!DASH_RE.test(line)) return [line];
  const parts = line.split(/\s+(?=[-–—]\s)/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [line];
}

function balancedBreak(line) {
  const words = line.split(' ');
  if (words.length < 3) return [line];
  let best = -1, bestDiff = Infinity;
  let acc = 0;
  const total = visibleLen(line);
  for (let i = 0; i < words.length - 1; i++) {
    acc += visibleLen(words[i]) + (i ? 1 : 0);
    const diff = Math.abs(acc - (total - acc - 1));
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  if (best < 0) return [line];
  const a = words.slice(0, best + 1).join(' '), b = words.slice(best + 1).join(' ');
  return (visibleLen(a) >= 8 && visibleLen(b) >= 8) ? [a, b] : [line];
}

// ---------- حارس الكلمات: الموديل ممنوع يغيّر كلمة ----------
function skeleton(s) {
  return String(s || '')
    .replace(/<[^>]*>|\{[^}]*\}/g, '')
    .replace(/\\+[nN]/g, '')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function sameWords(orig, out) {
  const a = skeleton(orig), b = skeleton(out);
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > Math.max(3, a.length * 0.1)) return false;
  if (a.length > 600) return false;
  return levenshtein(a, b) <= Math.max(2, Math.floor(a.length * 0.06));
}

// ---------- تجهيز السطر للموديل: نمسح الترقيم (نقاط، فواصل، تنصيص، أقواس) ونُبقي الشرطة وفواصل الأسطر والنقاط الثلاث والوسوم، وتبقى ؟ ! : منقولة لآخر السطر ----------
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const LINE_SPLIT = /\\+[nN]|\r?\n/;

function stripPunctPart(s) {
  return s
    .replace(/["“”«»()\[\]]/g, '')
    .replace(/(?<!\d)[.,:]+|[.,:]+(?!\d)/g, ' ')   // لا نمسّ 3.5 و 12:30 و 1,600
    .replace(/[!؟?،؛;]+/g, ' ');
}

function prepareForModel(rawText) {
  const out = [];
  for (const rawLine of String(rawText == null ? '' : rawText).split(LINE_SPLIT)) {
    let l = rawLine.trim();
    if (!l) continue;
    const tagPrefix = l.match(LEAD_TAGS)[0];
    l = l.slice(tagPrefix.length).trim();

    // نسحب علامات ؟ ! ونقطتين : من أول السطر أو آخره قبل المسح، وتُلحق بآخر السطر
    let mark = '', colon = false;
    let dash0 = '';
    const dm = l.match(/^[-–—]\s*/);
    if (dm) { dash0 = '-'; l = l.slice(dm[0].length); }
    let lm;
    while ((lm = l.match(/^([!؟?:]+)\s*(?=\S)/))) {
      if (lm[1].includes(':')) colon = true;
      mark += lm[1].replace(/:/g, '');
      l = l.slice(lm[0].length);
    }
    const tm = l.match(/(?<!\d)([!؟?:]+)[\s."”)]*$/);
    if (tm) {
      if (tm[1].includes(':')) colon = true;
      mark = tm[1].replace(/:/g, '') + mark;
      l = l.slice(0, tm.index);
    }
    l = (dash0 ? '- ' : '') + l;

    // مسح باقي الترقيم (النقاط الثلاث والوسوم تبقى)
    l = l.split(/(\{[^}]*\}|<[^>]*>|\.{3,}|…)/)
      .map((part, i) => (i % 2 ? part : stripPunctPart(part)))
      .join('').replace(/[ \t]{2,}/g, ' ').trim();

    // شرطة الحوار: تُسحب للبداية سواء كانت بالبداية أو متأخرة بالنهاية
    let dash = false;
    if (/^[-–—]\s*/.test(l)) { dash = true; l = l.replace(/^[-–—]\s*/, ''); }
    if (/\s*[-–—]$/.test(l)) { dash = true; l = l.replace(/\s*[-–—]$/, ''); }
    l = l.trim();
    if (!l) continue;
    out.push(tagPrefix.trim() + (dash ? '- ' : '') + l + (colon ? ':' : mark));
  }
  return out.join('\\N');
}

// تلميح التنصيص من النص الأصلي: whole = كل السطر اقتباس واحد، open = الاقتباس يكمل بالترجمة اللي بعدها، close = بدأ قبلها
function quoteHint(rawText) {
  const t = String(rawText == null ? '' : rawText).replace(/\{[^}]*\}|<[^>]*>/g, '');
  const lines = t.split(LINE_SPLIT).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.some(l => /^[-–—]/.test(l) || /[-–—]$/.test(l))) return null;
  const total = (t.match(/["“”]/g) || []).length;
  if (!total) return null;
  let edge = 0, startFirst = false, endLast = false;
  lines.forEach((l, i) => {
    const st = /^["“”]/.test(l);
    const en = /["“”][.…!؟?،,؛\s]*$/.test(l);
    const onlyQuote = l.replace(/[.…!؟?،,؛\s]/g, '').length === 1;
    if (st) { edge++; if (i === 0) startFirst = true; }
    if (en && !(st && onlyQuote)) { edge++; if (i === lines.length - 1) endLast = true; }
  });
  if (edge !== total) return null;              // في تنصيص وسط السطر: ما نحكم عليه
  if (total % 2 === 0) return 'whole';
  if (total === 1) { if (startFirst) return 'open'; if (endLast) return 'close'; }
  return null;
}

// شكل النص: عدد الأسطر وعدد الأسطر اللي تبدأ بشرطة (حارس: الموديل ممنوع يغيّرهم)
function shapeOf(text) {
  const lines = String(text == null ? '' : text).split(LINE_SPLIT).map(l => l.trim()).filter(Boolean);
  const dashes = lines.filter(l => /^[-–—]/.test(l.replace(LEAD_TAGS, ''))).length;
  return lines.length + ':' + dashes;
}

// ---------- إصلاح الأقواس بالكود (احتياط لا يعتمد على الموديل) ----------
function parenInfo(line) {
  const stack = [], strayClose = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '(') stack.push(i);
    else if (line[i] === ')') { if (stack.length) stack.pop(); else strayClose.push(i); }
  }
  return { strayOpen: stack, strayClose };
}
function appendClosing(line) {
  const m = line.match(/^(.*?)(\s*[.…!؟?،,؛"”»]*\s*)$/s);
  return m ? m[1] + ')' + m[2] : line + ')';
}
function wordEndAfter(line, p) {
  let i = p + 1;
  while (i < line.length && /\s/.test(line[i])) i++;
  while (i < line.length && !/[\s.…!؟?،,؛()"“”]/.test(line[i])) i++;
  return i;
}
function wordStartBefore(line, p) {
  let i = p;
  while (i > 0 && /\s/.test(line[i - 1])) i--;
  while (i > 0 && !/[\s("“”]/.test(line[i - 1])) i--;
  return i;
}
function fixLineParens(line) {
  if (!/[()]/.test(line)) return line;
  let info = parenInfo(line);
  if (!info.strayOpen.length && !info.strayClose.length) return line;
  const opens = (line.match(/\(/g) || []).length, closes = (line.match(/\)/g) || []).length;
  const pairs = opens - info.strayOpen.length;
  // كل الأقواس معكوسة بالكامل: نقلبها
  if (pairs === 0 && opens === closes && line.search(/[()]/) === line.indexOf(')') ) {
    return line.replace(/[()]/g, c => (c === '(' ? ')' : '('));
  }
  let out = line;
  let strays = info.strayOpen.slice();
  // فتح زائد بأول السطر + فتح زائد ثاني: الأول إغلاق مقلوب، نحذفه
  if (strays.length >= 2 && out.slice(0, strays[0]).replace(/[-–—\s"“”]/g, '') === '') {
    out = out.slice(0, strays[0]) + out.slice(strays[0] + 1);
    strays = strays.slice(1).map(p => p - 1);
  }
  // أقواس فتح بلا إغلاق: نغلقها بعد الكلمة التالية
  for (const p of strays.slice().reverse()) {
    const end = wordEndAfter(out, p);
    if (end > p + 1) out = out.slice(0, end) + ')' + out.slice(end);
    else out = out.slice(0, p) + out.slice(p + 1);
  }
  info = parenInfo(out);
  // أقواس إغلاق زائدة: نفتحها قبل الكلمة السابقة
  for (const p of info.strayClose.slice().reverse()) {
    const st = wordStartBefore(out, p);
    if (st < p) out = out.slice(0, st) + '(' + out.slice(st);
    else out = out.slice(0, p) + out.slice(p + 1);
  }
  return out;
}
function repairParens(text) {
  if (!/[()]/.test(text)) return text;
  const lines = text.split('\n');
  // ")" في أول السطر: إن كان لها "(" مفتوح بالسطر السابق تنتقل لآخره، وإلا تُحذف
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-–—]?\s*)\)\s*/);
    if (m) {
      lines[i] = m[1] + lines[i].slice(m[0].length);
      if (i > 0 && parenInfo(lines[i - 1]).strayOpen.length > 0) lines[i - 1] = appendClosing(lines[i - 1]);
    }
  }
  return lines.map(fixLineParens).join('\n');
}

// تنصيص موزع على سطرين بشكل معكوس: "X \n "Y  ->  "X \n Y"
function fixSplitQuotes(text) {
  const lines = text.split('\n');
  if (lines.length !== 2) return text;
  const a = lines[0].trim(), b = lines[1].trim();
  if (DASH_RE.test(a) || DASH_RE.test(b)) return text;
  const cnt = s => (s.match(/["“”]/g) || []).length;
  if (cnt(a) !== 1 || cnt(b) !== 1) return text;
  if (!/["“”]$/.test(a) || !/^["“”]/.test(b)) return text;
  const aCore = a.replace(/\s*["“”]$/, '');
  if (!aCore || TERM_CHARS.includes(aCore[aCore.length - 1])) return text; // الجملة انتهت: ما نلمسها
  const bCore = b.replace(/^["“”]\s*/, '');
  return '"' + aCore + '\n' + bCore + '"';
}

function polishArabicText(txt) {
  let t = String(txt == null ? '' : txt)
    .replace(/\\+[nN]/g, '\n')
    .replace(/["“”]\(([^()"“”\n]+)\)["“”]/g, '($1)')      // "(اسم)" -> (اسم)
    .replace(/\(["“”]([^()"“”\n]+)["“”]\)/g, '"$1"');     // ("اسم") -> "اسم"
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) out.push(...splitSpeakers(moveLeadingPunct(l)));
  let res = repairParens(out.map(l => moveLeadingPunct(l)).join('\n')).split('\n').filter(Boolean);
  if (CORRECTOR_WRAP_AT > 0 && res.length === 1 && !DASH_RE.test(res[0]) && visibleLen(res[0]) > CORRECTOR_WRAP_AT) {
    res = balancedBreak(res[0]);
  }
  return fixSplitQuotes(res.join('\n'));
}

function cleanCorrectorOutput(txt) {
  let t = String(txt == null ? '' : txt)
    .replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '');
  if (CORRECTOR_STRIP_BRACKETS) t = t.replace(/[\[\]]/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  return polishArabicText(fixArabicTypos(t));
}

// تصحيح أخطاء إملائية شائعة بالكود (كلمة كاملة فقط، بدون لمس كلمات صحيحة مثل إلى/على/دولة)
const TYPO_FIX_RAW = {"لى": "لي", "فى": "في", "الذى": "الذي", "التى": "التي", "لكى": "لكي", "معى": "معي", "بى": "بي", "نفسى": "نفسي", "رأيى": "رأيي", "رأسى": "رأسي", "انتى": "أنتِ", "حتي": "حتى", "باقى": "باقي", "ثوانى": "ثواني", "ماضى": "ماضي", "أصدقائى": "أصدقائي", "أبنائى": "أبنائي", "اخى": "أخي", "رئيسى": "رئيسي", "سيدى": "سيدي", "عزيزى": "عزيزي", "زوجتى": "زوجتي", "عائلتى": "عائلتي", "صديقى": "صديقي", "محامى": "محامي", "عالى": "عالي", "غالى": "غالي", "كرسى": "كرسي", "مبانى": "مباني", "اغانى": "أغاني", "ليالى": "ليالي", "حرامى": "حرامي", "عادى": "عادي", "قاضى": "قاضي", "فاضى": "فاضي", "اعطنى": "أعطني", "دعنى": "دعني", "ارنى": "أرني", "اخبرنى": "أخبرني", "صدقنى": "صدقني", "اسمعنى": "اسمعني", "سامحنى": "سامحني", "توقفى": "توقفي", "اذهبى": "اذهبي", "انظرى": "انظري", "ابتعدى": "ابتعدي", "اهربى": "اهربي", "مستشفي": "مستشفى", "فوضي": "فوضى", "اعمي": "أعمى", "سيدتى": "سيدتي", "امى": "أمي", "ابنتى": "ابنتي", "مقهي": "مقهى", "حوالى": "حوالي", "شخصى": "شخصي", "طبيعى": "طبيعي", "حقيقى": "حقيقي", "نهائى": "نهائي", "مبدئى": "مبدئي", "كافى": "كافي", "شكوي": "شكوى", "فتوي": "فتوى", "حلوي": "حلوى", "متي": "متى", "عسي": "عسى", "جدوي": "جدوى", "فحوي": "فحوى", "قصوي": "قصوى", "رؤي": "رؤى", "منتدي": "منتدى", "مسعي": "مسعى", "مغزي": "مغزى", "افعي": "أفعى", "مأوي": "مأوى", "مثوي": "مثوى", "مصطفي": "مصطفى", "مجتبي": "مجتبى", "مستلقي": "مستلقى", "مرتضي": "مرتضى", "اللة": "الله", "واللة": "والله", "لة": "له", "عنة": "عنه", "منة": "منه", "علية": "عليه", "إلية": "إليه", "فية": "فيه", "معة": "معه", "نفسة": "نفسه", "هذة": "هذه", "مفاجأه": "مفاجأة", "دقيقه": "دقيقة", "حقيقه": "حقيقة", "طريقه": "طريقة", "فجأه": "فجأة", "عائله": "عائلة", "غرفه": "غرفة", "مشكله": "مشكلة", "فكره": "فكرة", "سياره": "سيارة", "قوه": "قوة", "لحظه": "لحظة", "مهمه": "مهمة", "فرصه": "فرصة", "رساله": "رسالة", "نهايه": "نهاية", "بدايه": "بداية", "جريمه": "جريمة", "امرأه": "امرأة", "طاقه": "طاقة", "علاقه": "علاقة", "معركه": "معركة", "رحله": "رحلة", "شجره": "شجرة", "لعبه": "لعبة", "فتره": "فترة", "ورقه": "ورقة", "شرطه": "شرطة", "خطوه": "خطوة", "حفله": "حفلة", "مكالمه": "مكالمة", "مدرسه": "مدرسة", "رؤيه": "رؤية", "رصاصه": "رصاصة", "قنبله": "قنبلة", "اسلحه": "أسلحة", "فرقه": "فرقة", "حقيبه": "حقيبة", "بصمه": "بصمة", "قهوه": "قهوة", "طاوله": "طاولة", "مسأله": "مسألة", "اسئله": "أسئلة", "رائعه": "رائعة", "سرعه": "سرعة", "نافذه": "نافذة", "شاشه": "شاشة", "فائده": "فائدة", "عاصفه": "عاصفة", "سفينه": "س سفينة", "طائره": "طائرة", "سياده": "سيادة", "جلاله": "جلالة", "عمده": "عمدة", "محطه": "محطة", "شركه": "شركة", "ابوة": "أبوه", "اسمة": "اسمه", "مياة": "مياه", "وجة": "وجه", "اتجاة": "اتجاه", "انتباة": "انتباه", "شبة": "شبه", "سهوله": "سهولة", "صعوبه": "صعوبة", "مجموعه": "مجموعة", "مساحه": "مساحة", "عاهره": "عاهرة", "عصابه": "عصابة", "خزنه": "خزنة", "بوابه": "بوابة", "قمامه": "قمامة", "ادله": "أدلة", "مباشره": "مباشرة", "كامله": "كاملة", "جديده": "جديدة", "كبيره": "كبيرة", "صغيره": "صغيرة", "محكمه": "محكمة", "حكومه": "حكومة", "عقوبه": "عقوبة", "معجزه": "معجزة", "خريطه": "خريطة", "ثلاجه": "ثلاجة", "قائمه": "قائمة", "قضيه": "قضية", "ضحيه": "ضحية", "رهينه": "رهينة", "عشيقه": "عشيقة", "خطيئه": "خطيئة", "مستحيله": "مستحيلة", "غريبه": "غريبة", "مجنونه": "مجنونة", "مؤخره": "مؤخرة", "مقدمه": "مقدمة", "نتيجه": "نتيجة", "اجهزه": "أجهزة", "اسطوره": "أسطورة", "ثقه": "ثقة", "صدفه": "صدفة", "معامله": "معاملة", "مواجهه": "مواجهة", "سيطره": "سيطرة", "بيئه": "بيئة", "هيئه": "هيئة", "مائده": "مائدة", "بطاقه": "بطاقة", "طبيعه": "طبيعة", "فضيحه": "فضيحة", "مصلحه": "مصلحة", "اسطوانه": "أسطوانة", "استماره": "استمارة", "شريحه": "شريحة", "مكافأه": "مكافأة", "جرأه": "جرأة", "بأكملة": "بأكمله", "تجاة": "تجاه", "افواة": "أفواه", "اشباة": "أشباه", "دوله": "دولة", "مدينه": "مدينة", "اشاره": "إشارة", "قياده": "قيادة", "شهاده": "شهادة", "عقيده": "عقيدة", "جائزه": "جائزة", "سياسه": "سياسة", "شئ": "شيء", "شئيا": "شيئا", "سئ": "سيء", "مسئول": "مسؤول", "دايما": "دائما", "بطئ": "بطيء", "قرائة": "قراءة", "برائة": "براءة", "الأن": "الآن", "شئون": "شؤون", "كئوس": "كؤوس", "يقراء": "يقرأ", "مليئ": "مليء", "سيئه": "سيئة", "ذالك": "ذلك", "هاذا": "هذا", "لاكن": "لكن", "مالذي": "ما الذي", "مابك": "ما بك", "كفائة": "كفاءة", "مايحدث": "ما يحدث", "مابه": "ما به", "مابها": "ما بها", "ياأمي": "يا أمي", "ياأبي": "يا أبي", "ياأخي": "يا أخي", "ارجوك": "أرجوك", "يارجل": "يا رجل", "ياإلهي": "يا إلهي", "يارفاق": "يا رفاق", "ياشباب": "يا شباب", "لاشئ": "لا شيء", "ياسيدي": "يا سيدي", "ياصديقي": "يا صديقي", "هاكذا": "هكذا", "لااحد": "لا أحد", "يافتاة": "يا فتاة", "بالتاكيد": "بالتأكيد", "لابأس": "لا بأس", "لايمكن": "لا يمكن", "لااعرف": "لا أعرف", "لااعلم": "لا أعلم", "ماالامر": "ما الأمر", "ماالخطب": "ما الخطب", "ايها": "أيها", "ايتها": "أيتها", "كلشئ": "كل شيء", "ايشئ": "أي شيء", "ياولدي": "يا ولدي", "يابني": "يا بني", "طاريء": "طارئ", "هاديء": "هادئ", "مفاجيء": "مفاجئ", "دافيء": "دافئ", "مباديء": "مبادئ", "لاداعي": "لا داعي", "لامشكلة": "لا مشكلة", "مالعمل": "ما العمل", "ماالمشكلة": "ما المشكلة", "خاطيء": "خاطئ", "مخطيء": "مخطئ", "قاريء": "قارئ", "رجائا": "رجاء", "مسائا": "مساء", "هاؤلاء": "هؤلاء", "اولائك": "أولئك", "بالظبط": "بالضبط", "انشاءالله": "إن شاء الله", "بماان": "بما أن", "كيفحالك": "كيف حالك", "بخيرشكرا": "بخير شكرا"};
const TYPO_ALL = new Map(Object.entries(TYPO_FIX_RAW));
// الكلمات الطويلة (5+ حروف) أو اللي تبدأ بـ "ال" يُسمح لها بالبوادئ (و ف ب ل ك ال)، والقصيرة تُصحَّح وحدها فقط
const TYPO_SAFE = new Map([...TYPO_ALL].filter(([k]) => k.length >= 5 || k.startsWith('ال')));
const TYPO_PREFIX = new Set(['و', 'ف', 'ب', 'ل', 'ك']);

function fixTypoToken(tok) {
  if (TYPO_ALL.has(tok)) return TYPO_ALL.get(tok);
  let pre = '';
  let rest = tok;
  for (let n = 0; n < 3 && rest.length > 2; n++) {
    if (rest.startsWith('لل') && rest.length > 4) {
      const r = rest.slice(2);
      if (TYPO_SAFE.has(r)) return pre + 'لل' + TYPO_SAFE.get(r);
    }
    if (rest.startsWith('ال') && rest.length > 4) {
      const r = rest.slice(2);
      if (TYPO_SAFE.has(r)) return pre + 'ال' + TYPO_SAFE.get(r);
    }
    if (!TYPO_PREFIX.has(rest[0])) break;
    pre += rest[0];
    rest = rest.slice(1);
    if (TYPO_SAFE.has(rest)) return pre + TYPO_SAFE.get(rest);
  }
  return tok;
}

function fixArabicTypos(txt) {
  return String(txt == null ? '' : txt).replace(/[\p{L}\p{M}]+/gu, tok => (/[\u0600-\u06FF]/.test(tok) ? fixTypoToken(tok) : tok));
}


// دالة لمعالجة دفعة من الترجمات العربية (فقط تصحيح وإضافة علامات ترقيم، بالترتيب المنطقي LTR)
async function correctChunkStrict(items, keysArray, modelName, ctx = null) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };

  const ctxBlock = ctx && (ctx.before.length || ctx.after.length)
    ? `\nCONTEXT (READ-ONLY): Use these lines ONLY to understand if a sentence continues across entries.\ncontext_before: ${JSON.stringify(ctx.before)}\ncontext_after: ${JSON.stringify(ctx.after)}\n`
    : '';

  const prompt = `You will receive a JSON array of Arabic subtitle entries: {"id": <number>, "text": "<Arabic words>"}. Some entries also have "q" (a quotation hint, see rule 7).
Most punctuation of every entry was REMOVED on purpose. What was kept: the speaker dashes "-", the line-break markers \\N, any "...", and any "?", "!", "؟" or ":" that stands at the very end of a line.
Your job: write the punctuation of each entry from scratch, correctly, in logical Unicode order for modern right-to-left Arabic.

STRICT RULE: do NOT change, add, remove, reorder or replace any WORD. No synonyms, no grammar fixes, no spelling fixes, no gender changes. You may only ADD punctuation marks, quotation marks and parentheses. There is nothing to translate and nothing to guess about who is speaking.

Rules:
1. Return a JSON array: [{"id": <same number>, "text": "<the same words with punctuation>"}] with exactly one object per input id, in the same order. Never output "q".
2. Keep every \\N line break exactly where it is. NEVER merge lines, split lines or add lines.
3. Keep every dash "-" exactly at the start of its line. Never add a dash to a line that has none.
4. Sentence marks: end each sentence with . or ! or ؟ as the meaning requires, and use ، and ؛ where natural. Keep every existing "..." exactly where it is. Use the read-only context to see whether a sentence continues in the next entry or continues from the previous one: do NOT end an entry with a full stop if its sentence continues in the next entry. Any line that already ends with "؟", "!" or ":" keeps it EXACTLY; never remove it, never change it, never add another mark after it.
5. PERSON NAMES (names of people or characters, even when a prefix such as ل ب و ك ف is attached to the word): wrap the whole word in quotation marks, like "كيلوا". Never use parentheses for people.
6. OTHER PROPER NOUNS that are not people (places, cities, countries, companies, brands, organizations, food or dish names): wrap them in parentheses, like (طوكيو). Never use quotation marks for them. If you are not sure that a word is a name, leave it with no mark at all.
7. "q" tells you how the original entry was quoted. "whole" = the whole entry is ONE quotation: put one opening quotation mark right before the first word of the first line and one closing quotation mark right after the last word of the last line, and add NO other quotation marks inside this entry. "open" = the quotation continues in the next entry: put only one opening quotation mark right before the first word, and no other quotation marks. "close" = the quotation began in an earlier entry: put only one closing quotation mark right after the last word, and no other quotation marks. An entry without "q" is not quoted as a whole.
8. NEVER output square brackets [ ].
9. ONLY output the JSON array. No explanations.
${ctxBlock}
Content to punctuate:
${JSON.stringify(items)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const activeKey = await acquireKey(keysArray);
    if (!activeKey) return { status: 'no_keys', map: new Map() };

    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;

    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: SAFETY_SETTINGS_OFF
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: 60000,
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const responseText = parts.map(p => p?.text || '').join('');
      const map = parseIdTranslations(responseText);

      if (map) {
        const allowedIds = new Set(items.map(i => i.id));
        let extraIds = 0;
        for (const id of map.keys()) if (!allowedIds.has(id)) extraIds++;
        if (extraIds > Math.max(3, Math.floor(items.length * 0.02))) {
          console.log(`[حارس الأرقام - مصحح] الرد فيه ${extraIds} رقم ما طلبته. أرفضه.`);
          return { status: 'bad_ids', map: new Map() };
        }
        if (items.length >= 40) console.log(`[مصحح عربي - نجاح] طلب ${items.length} سطر، رجع ${map.size} عبر ...${cleanKey.slice(-4)}`);
        return { status: 'ok', map };
      }

      return { status: 'bad_format', map: new Map() };
    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status})`);
        continue;
      }
      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ - مصحح] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s`);
      if (attempt < 3) await delay(2000 + (Math.random() * 2000));
    }
  }
  return { status: 'api_exhausted', map: new Map() };
}

// دالة المداورة (Recovery) الخاصة بالمصحح العربي (مطابقة لدالة الترجمة)
async function correctItemsWithRecovery(items, keysArray, modelName, ctx = null) {
  const done = new Map();
  if (!items || items.length === 0) return done;

  let pending = items;

  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    const result = await correctChunkStrict(pending, keysArray, modelName, ctx);

    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ - مصحح] السيرفرات مختنقة. تم تجاوز (${pending.length}) سطر للحفاظ على التزامن.`);
      break;
    }

    if ((result.status === 'bad_ids' || result.status === 'bad_format') && pending.length > 60) {
      const mid = Math.ceil(pending.length / 2);
      console.log(`[حارس الأرقام - مصحح] أقسم الدفعة (${pending.length}) لنصفين وأعيد.`);
      const left = await correctItemsWithRecovery(pending.slice(0, mid), keysArray, modelName, ctx);
      const right = await correctItemsWithRecovery(pending.slice(mid), keysArray, modelName, ctx);
      for (const [id, text] of left) done.set(id, text);
      for (const [id, text] of right) done.set(id, text);
      pending = pending.filter(it => !done.has(it.id));
      break;
    }

    if (result.status === 'ok') {
      const wanted = new Set(pending.map(it => it.id));
      for (const [id, text] of result.map) {
        if (wanted.has(id) && text) done.set(id, text);
      }
    }

    const before = pending.length;
    pending = pending.filter(it => !done.has(it.id));

    if (pending.length > 0 && round < MAX_MISSING_RETRIES) {
      console.log(`[إعادة الناقص - مصحح 🔁] ناقص ${pending.length} من ${before}. أعيد طلبهم...`);
    }
  }

  return done;
}

// معالجة كافة الأسطر العربية: دفعات 350، والناقص يرجع لحوض تجميع ذكي يُعالج بانتظام
async function correctAllCues(cues, keysArray, modelName, cacheKey) {
  const tStart = Date.now();
  const CHUNK = CORRECTOR_CHUNK;   // حجم الدفعة الأولى
  const RETRY_PIECE = 100;     // الحد الأقصى لوجبة الاسترداد
  const MAX_TRIES = 5;        // محاولات الأسطر الناقصة من ردود سليمة
  const MAX_RL = 12;          // محاولات بسبب الخنق (429): لا تُحسب من الـ 5
  const cache = getLineCache('ARB2_' + cacheKey);  // كاش منفصل للمصحح (نسخة جديدة: إعادة كتابة الترقيم)

  const results = new Array(cues.length).fill(null);
  const toDo = [];
  const sentText = new Map();   // id -> النص المجهز (بلا ترقيم) اللي أُرسل للموديل
  let fromCache = 0;

  cues.forEach((c, i) => {
    if (!needsTranslation(c.text)) { results[i] = c.text; return; }
    if (cache.has(i)) { results[i] = cache.get(i); fromCache++; return; }
    const prepared = prepareForModel(c.text);
    sentText.set(i, prepared);
    const item = { id: i, text: prepared };
    const q = quoteHint(c.text);
    if (q) item.q = q;
    toDo.push(item);
  });

  if (fromCache > 0) console.log(`[كاش الأسطر - مصحح] ${fromCache} سطر جاهز من قبل، أصحح الباقي (${toDo.length}) فقط.`);

  const queue = [];
  for (let i = 0; i < toDo.length; i += CHUNK) queue.push({ items: toDo.slice(i, i + CHUNK), tries: 0, rl: 0 });

  let inFlight = 0, requeued = 0, rejected = 0, pauseUntil = 0;
  const rawOut = new Map();
  const workerCount = Math.max(1, Math.min(aliveKeyCount(keysArray), CORRECTOR_MAX_WORKERS));

  // متغيرات التجميع الذكي (حوض الانتظار)
  let retryPool = [];
  let retryTimer = null;

  const flushRetryPool = (force = false) => {
    if (retryPool.length === 0) return;
    
    // إذا لم يكن مقبطاً ولم نجبره على الكرف، نكتفي بالتأكد من تشغيل العداد
    if (!force && retryPool.length < RETRY_PIECE) {
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          console.log(`[نظام التجميع الذكي 🧠] انتهت الـ 3 ثواني. جاري كرف الأسطر المتبقية.`);
          flushRetryPool(true);
        }, 3000);
      }
      return;
    }

    // هنا يتم الكرف (بحد أقصى 100 سطر)
    const chunkItems = retryPool.splice(0, RETRY_PIECE);
    const maxTries = Math.max(...chunkItems.map(x => x._tries));
    const maxRl = Math.max(...chunkItems.map(x => x._rl));
    
    // تنظيف المتغيرات المؤقتة قبل إرسالها للـ worker
    const cleanItems = chunkItems.map(x => {
      const { _tries, _rl, ...rest } = x;
      return rest;
    });

    queue.unshift({ items: cleanItems, tries: maxTries, rl: maxRl });
    console.log(`[نظام التجميع الذكي 🧠] تم كرف ${cleanItems.length} سطر مسترد כدفعة واحدة ودخلت أول الطابور.`);
    
    // التعامل مع ما تبقى في الحوض
    if (retryPool.length === 0) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } else if (retryPool.length >= RETRY_PIECE) {
      flushRetryPool(); // إذا بقى 100 ثانية، نكرفها فوراً بدون انتظار
    } else {
      // تبقى فتات أقل من 100، نضبط لها عداد جديد
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          console.log(`[نظام التجميع الذكي 🧠] انتهت الـ 3 ثواني للدفعة المتبقية بالحوض.`);
          flushRetryPool(true);
        }, 3000);
      }
    }
  };

  const applyLine = (id, text) => {
    rawOut.set(id, text);
    const orig = cues[id].text;
    let src = text;
    if (!sameWords(orig, text) || shapeOf(text) !== shapeOf(sentText.get(id) || orig)) { rejected++; src = orig; }
    const clean = cleanCorrectorOutput(src) || cleanCorrectorOutput(orig);
    results[id] = clean;
    cache.set(id, clean);
  };

  const requeueLeft = (job, leftover, why, isRL) => {
    if (!leftover.length) return;
    const tries = isRL ? job.tries : job.tries + 1;
    const rl = isRL ? job.rl + 1 : job.rl;
    
    if (tries >= MAX_TRIES || rl > MAX_RL) {
      console.log(`[مصحح - تجاوز] ${leftover.length} سطر بعد ${tries} محاولات (${rl} بسبب الخنق)، يبقون بنصهم الأصلي مع التنظيف المحلي.`);
      return;
    }
    
    // إلقاء النواقص في حوض الانتظار بدل الطابور
    leftover.forEach(item => {
      retryPool.push({ ...item, _tries: tries, _rl: rl });
    });
    requeued += leftover.length;
    
    console.log(`[نظام التجميع الذكي 🧠] ${why}: رمي ${leftover.length} سطر في الحوض (الإجمالي الآن: ${retryPool.length} سطر).`);
    flushRetryPool();
  };

  async function worker() {
    while (true) {
      if (keysArray.every(k => deadKeys.has(k))) return;
      if (Date.now() < pauseUntil) { await delay(500); continue; }
      
      const job = queue.shift();
      if (!job) {
        // حماية للخروج: لا يخرج المفتاح إذا كان الحوض فيه شغل ديطبخ
        if (inFlight === 0 && retryPool.length === 0) return;
        
        // تسريع إضافي: إذا المفاتيح فارغة تماماً والطابور فارغ بس اكو شغل بالحوض، نفرغه فوراً بدون ما ننتظر تخلص الـ 3 ثواني
        if (inFlight === 0 && queue.length === 0 && retryPool.length > 0) {
          console.log(`[نظام التجميع الذكي 🧠] كل المفاتيح فارغة والطابور نظيف. تفريغ الحوض فوراً لإنهاء العمل.`);
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          flushRetryPool(true);
        }
        await delay(100);
        continue;
      }
      
      inFlight++;
      try {
        const ctx0 = buildChunkContext(cues, job.items);
        const ctx = { before: ctx0.before.map(prepareForModel).filter(Boolean), after: ctx0.after.map(prepareForModel).filter(Boolean) };
        const r = await correctChunkStrict(job.items, keysArray, modelName, ctx);
        const left = () => job.items.filter(it => results[it.id] == null);
        
        if (r.status === 'ok') {
          const wanted = new Set(job.items.map(it => it.id));
          for (const [id, text] of r.map) if (wanted.has(id) && text) applyLine(id, text);
          const leftover = left();
          requeueLeft(job, leftover, `ناقص ${leftover.length} من ${job.items.length}`, false);
        } else if (r.status === 'api_exhausted' || r.status === 'no_keys') {
          pauseUntil = Math.max(pauseUntil, Date.now() + 15000);
          requeueLeft(job, left(), `السيرفر مختنق (${r.status})`, true);
        } else {
          requeueLeft(job, left(), `رد غير صالح (${r.status})`, false);
        }
      } catch (e) {
        console.log(`[مصحح] خطأ بمهمة: ${e && e.message}`);
        requeueLeft(job, job.items.filter(it => results[it.id] == null), 'خطأ', false);
      } finally {
        inFlight--;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const unprocessed = toDo.filter(it => results[it.id] == null);
  const missing = unprocessed.length;
  console.log(`[ملخص المصحح] أسطر=${cues.length} | للتصحيح=${toDo.length} | أُعيد لحوض التجميع=${requeued} | رفض (كلمات/أسطر/شرطات)=${rejected} | ناقص=${missing} | عمّال=${workerCount} | الزمن=${Date.now() - tStart}ms`);

  const finalTexts = cues.map((c, i) => cleanCorrectorOutput(normalizeLineBreakArtifacts(results[i] || c.text)));

  // تشخيص: CORRECTOR_DEBUG=1 (عينة) و CORRECTOR_FIND=كلمة (أسطر تحتوي كلمة)
  const seq = str => [...String(str)].filter(ch => ch === '(' || ch === ')').map(ch => (ch === '(' ? 'O' : 'C')).join(' ') || '-';
  const show = (tag, id) => console.log(`[${tag}] #${id} أصل=${JSON.stringify(cues[id].text)} | مرسل=${JSON.stringify(sentText.has(id) ? sentText.get(id) : null)} | خام=${JSON.stringify(rawOut.has(id) ? rawOut.get(id) : null)} | ناتج=${JSON.stringify(finalTexts[id])} | أقواس(أصل/خام/ناتج)=${seq(cues[id].text)} / ${rawOut.has(id) ? seq(rawOut.get(id)) : '?'} / ${seq(finalTexts[id])}`);
  if (process.env.CORRECTOR_DEBUG === '1' && toDo.length > 0) {
    const step = Math.max(1, Math.floor(toDo.length / 12));
    for (let k = 0; k < toDo.length && k < step * 12; k += step) show('فحص مصحح', toDo[k].id);
    unprocessed.slice(0, 8).forEach(it => show('مصحح - لم يُصحَّح بالموديل', it.id));
  }
  const FIND = String(process.env.CORRECTOR_FIND || '').trim();
  if (FIND) {
    let re = null;
    try { re = new RegExp(FIND, 'iu'); } catch (e) { console.log(`[بحث مصحح] تعبير غير صالح: ${e.message}`); }
    if (re) {
      let n = 0;
      for (const it of toDo) {
        if (re.test(cues[it.id].text) || re.test(finalTexts[it.id])) { show('بحث مصحح', it.id); if (++n >= 15) break; }
      }
      console.log(`[بحث مصحح] "${FIND}": ${n} سطر مطبوع.`);
    }
  }

  return {
    texts: finalTexts,
    missing
  };
}

// الدوال النهائية لتشغيل المصحح العربي (SRT و ASS) وتصديرها للـ index.js
async function handleCorrectionSrt(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey); }
  
  catch (e) {
    console.log(`[مصحح Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message} <- ${subUrl}`);
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة العربية الأصلي.\n\n", missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n", missing: 0, total: 0, failed: true };

  console.log(`[مصحح Nuvio SRT] ${cues.length} أسطر عربية -> CHUNK=${CORRECTOR_CHUNK} | مفاتيح=${keysArray.length}`);
  const { texts: finalCorrections, missing } = await correctAllCues(cues, keysArray, modelName, subUrl);

  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    let text = finalCorrections[idx];
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    let sTime = c.start.replace('.', ','), eTime = c.end.replace('.', ',');
    if (sTime.length === 10) sTime = '0' + sTime;
    if (eTime.length === 10) eTime = '0' + eTime;
    if (sTime.split(',')[1].length === 2) sTime += '0';
    if (eTime.split(',')[1].length === 2) eTime += '0';
    srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
    counter++;
  });
  return { content: srtOutput, missing, total: cues.length, failed: false };
}

async function handleCorrectionAss(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl, extraKeys.subsourceKey); }
  
  catch (e) {
    console.log(`[مصحح Nuvio ASS] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف العربي.`, missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };

  console.log(`[مصحح Nuvio ASS] ${cues.length} أسطر عربية -> CHUNK=${CORRECTOR_CHUNK} | مفاتيح=${keysArray.length}`);
  const { texts: finalCorrections, missing } = await correctAllCues(cues, keysArray, modelName, subUrl);

  const assLines = [];
  cues.forEach((c, idx) => {
    let text = finalCorrections[idx];
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${text.trim().replace(/\n/g, '\\N')}`);
  });
  return { content: ASS_DEFAULT_HEADER + assLines.join('\n') + '\n', missing, total: cues.length, failed: false };
}


module.exports = {
  handleCorrectionSrt,
  handleCorrectionAss
};
