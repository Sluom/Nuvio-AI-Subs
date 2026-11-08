const {
  axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
  normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
  MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent, parseIdTranslations, buildChunkContext,
  needsTranslation, loadLineCache, aliveKeyCount, MAX_MISSING_RETRIES, fetchAndExtractSub,
  extractCuesUniversal, normalizeLineBreakArtifacts, ASS_DEFAULT_HEADER
} = require('./ai').shared;
const db = require('./db');
const { resolveEpInfoForUrl, getRawArabicSubContent } = require('./araFetch');
const { fixMarks, propagateNames, collectNameCandidates, classifyNames, nameKey, TRANSLATOR_MODE, translatorFlags, splitGluedPrefixes, wrapMaddaNames, collectNameCandidatesT, propagateNamesT } = require('./corrector-marks');
const { buildNameBook, applyNameBook, makeBook, describeBook, mergeSeriesNames } = require('./name-book');

function shortModel(m) {
  const s = String(m || '').replace(/^models\//, '').trim();
  let r = s.match(/^gemini-(\d+(?:\.\d+)?)-flash-lite/i);
  if (r) return r[1] + ' لايت';
  r = s.match(/^gemini-(\d+(?:\.\d+)?)-flash/i);
  if (r) return r[1] + ' فلاش';
  return s;
}

const CORRECTOR_STRIP_BRACKETS = true;
const CORRECTOR_WRAP_AT = 42;
const CORRECTOR_CHUNK = 250;
const CORRECTOR_MAX_WORKERS = 8;
const CORRECTOR_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_WAIT_MS = 10000;
const HEDGE_AFTER_FAILS = 2;
const CORRECTOR_REV = String(process.env.CORRECTOR_REV || 'r2').trim();
const TRACKS_REV = String(process.env.TRACKS_REV || '').trim();
const TRACKS_TAG = (TRACKS_REV && TRACKS_REV !== '0') ? '_t' + TRACKS_REV : '';
const ELLIPSIS_AUTO = process.env.ELLIPSIS_AUTO !== '0';
const DROP_DRAWINGS = true;
// ===== حجم خط ASS (غيّر الأرقام من هنا) =====
const ASS_FONT_PCT = 7.4;            // حجم خط الحوار الرئيسي = PlayResY × هذي النسبة %. إذا شفته كبير صغّرها، وإذا صغير كبّرها
const ASS_FALLBACK_PLAYRESY = 288;   // إذا الملف ما فيه PlayResY
const ASS_FONT_DECIMALS = 0;         // 0 = رقم صحيح، 1 = يسمح بكسر عشري (مثل 22.5)
const ASS_MAIN_MIN_SHARE = 0.5;      // أقل حصة من أسطر الحوار لازم تغطيها مجموعة الستايلات ذات الحجم الواحد حتى ينكبر الملف (0.5 = 50%)
const ASS_SCALE_OUTLINE = true;      // true = يكبّر الـOutline مع الخط. false = يبقى مثل الملف الأصلي
const ASS_OUTLINE_AMOUNT = 1;      // كم من التكبير ينطبق على الـOutline: 1 كامل، 0.5 نص، 0.25 ربع، 0 = بدون
const ASS_SCALE_SHADOW = true;       // true = يكبّر الـShadow مع الخط. false = يبقى مثل الملف الأصلي
const ASS_SHADOW_AMOUNT = 1;       // كم من التكبير ينطبق على الـShadow: 1 كامل، 0.5 نص، 0.25 ربع، 0 = بدون
const ASS_BOLD_OFF = false;          // true = يطفّي الـBold بالستايل الرئيسي (وبالستايلات اللي معه). false = ما ينلمس
const ASS_SCALE_OTHER_STYLES = true; // true = أي ستايل ثاني حجمه الأصلي يساوي الرئيسي (مثل Italics) يتكبّر معه. false = الرئيسي فقط
const TERM_CHARS = '.…!؟?،,؛:';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const DASH_RE = /^[-–—]/;
const TAG_RE = /\{[^}]*\}|<[^>]*>/g;
const TAG_ONE = /\{[^}]*\}|<[^>]*>/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;
const DRAWING_RE = /\{[^}]*\\p0*[1-9][^}]*\}/;
const DASH_BEFORE_ELL_RE = /\s*[-–—]\s*(\.{3,}|…)$/;

function visibleLen(s) { return String(s).replace(/<[^>]*>|\{[^}]*\}/g, '').length; }
function needsCorrection(text) {
  const raw = String(text == null ? '' : text);
  if (DRAWING_RE.test(raw)) return false;
  return HAS_ARABIC.test(raw.replace(TAG_RE, ''));
}
function moveLeadingPunct(line) {
  let t = line.trim();
  let hasDash = false;
  if (/^[-–—]\s*/.test(t)) { hasDash = true; t = t.replace(/^[-–—]\s*/, ''); }
  const dm2 = t.match(/^(.*?)\s*[-–—]\s*(\.{3,}|…)$/);
  if (dm2) { hasDash = true; t = dm2[1] + dm2[2]; }
  if (/\s*[-–—]$/.test(t)) { hasDash = true; t = t.replace(/\s*[-–—]$/, ''); }
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
const LEAK_SCRIPTS = [
  ['hangul', /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/],
  ['kana', /[぀-ヿㇰ-ㇿ]/],
  ['cjk', /[㐀-䶿一-鿿豈-﫿]/],
  ['cyrillic', /[Ѐ-ԯ]/],
  ['greek', /[Ͱ-Ͽ]/],
  ['hebrew', /[֐-׿]/],
  ['thai', /[฀-๿]/],
  ['latin', /[A-Za-zÀ-ɏ]/]
];
const LEAK_MASK_RE = /\{[^}]*\}|<[^>]*>|\\+[nN]/g;
const LEAK_TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;
const leakScriptsOf = s => new Set(LEAK_SCRIPTS.filter(([, re]) => re.test(s)).map(c => c[0]));
function fixForeignLeak(orig, out) {
  const origVis = String(orig == null ? '' : orig).replace(LEAK_MASK_RE, ' ');
  const held = [];
  const masked = String(out == null ? '' : out).replace(LEAK_MASK_RE, m => { held.push(m); return ''; });
  const base = leakScriptsOf(origVis);
  const bad = LEAK_SCRIPTS.filter(([n, re]) => leakScriptsOf(masked).has(n) && !base.has(n));
  if (!bad.length) return { text: out, fixed: 0 };
  const isBad = tok => bad.some(([, re]) => re.test(tok));
  const oTokens = origVis.match(LEAK_TOKEN_RE) || [];
  const oSk = oTokens.map(skeleton);
  let fixed = 0, failed = false;
  const res = masked.replace(LEAK_TOKEN_RE, tok => {
    if (!isBad(tok)) return tok;
    const sk = skeleton(tok);
    let best = -1, bd = Infinity, bs = Infinity;
    oSk.forEach((o, i) => {
      if (!o) return;
      const d = levenshtein(sk, o);
      const score = d / Math.max(sk.length, o.length);
      if (score < bs) { bs = score; bd = d; best = i; }
    });
    if (best < 0 || bd > Math.floor(Math.max(sk.length, oSk[best].length) / 2)) { failed = true; return tok; }
    fixed++;
    return oTokens[best];
  });
  if (failed) return null;
  let k = 0;
  return { text: res.replace(//g, () => (k < held.length ? held[k++] : '')), fixed };
}
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const LINE_SPLIT = /\\+[nN]|\r?\n/;
function restoreTags(orig, out) {
  const vis = l => l.replace(TAG_RE, '').trim();
  const o = String(orig == null ? '' : orig).split(LINE_SPLIT).map(l => l.trim()).filter(l => l && vis(l));
  const n = String(out == null ? '' : out).split(LINE_SPLIT).map(l => l.trim()).filter(Boolean);
  if (o.length !== n.length) return null;
  const res = [];
  for (let i = 0; i < o.length; i++) {
    const lead = o[i].match(LEAD_TAGS)[0];
    const rest = o[i].slice(lead.length);
    const tail = rest.match(TAIL_TAGS)[0];
    const body = rest.slice(0, rest.length - tail.length);
    if (TAG_ONE.test(body)) return null;
    res.push(lead.trim() + n[i].replace(TAG_RE, '').trim() + tail.trim());
  }
  return res.join('\n');
}
function stripPunctPart(s) {
  return s
    .replace(/(^|\s)(يا)(?=["“«(\[]+\p{L})/gu, '$1$2 ')
    .replace(/["“”«»()\[\]]/g, '')
    .replace(/(?<!\d)[.,:]+|[.,:]+(?!\d)/g, ' ')
    .replace(/[!؟?،؛;]+/g, ' ');
}
function prepareForModel(rawText) {
  const out = [];
  for (const rawLine of String(rawText == null ? '' : rawText).split(LINE_SPLIT)) {
    let l = rawLine.trim();
    if (!l) continue;
    const tagPrefix = l.match(LEAD_TAGS)[0];
    l = l.slice(tagPrefix.length).trim();
    l = l.replace(TAG_RE, '').trim();
    if (!l) continue;
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
    l = l.split(/(\{[^}]*\}|<[^>]*>|\.{3,}|…)/)
      .map((part, i) => (i % 2 ? part : stripPunctPart(part)))
      .join('').replace(/[ \t]{2,}/g, ' ').trim();
    let dash = false;
    if (/^[-–—]\s*/.test(l)) { dash = true; l = l.replace(/^[-–—]\s*/, ''); }
    if (DASH_BEFORE_ELL_RE.test(l)) { dash = true; l = l.replace(DASH_BEFORE_ELL_RE, '$1'); }
    if (/\s*[-–—]$/.test(l)) { dash = true; l = l.replace(/\s*[-–—]$/, ''); }
    l = l.trim();
    if (!l) continue;
    out.push((dash ? '- ' : '') + l + (colon ? ':' : mark));
  }
  return out.join('\\N');
}
const QUOTE_CH = /["“”]/g;
const quoteWords = s => (s.replace(QUOTE_CH, '').match(/[\p{L}\p{N}]+/gu) || []).length;
function quoteHint(rawText) {
  const t = String(rawText == null ? '' : rawText).replace(/\{[^}]*\}|<[^>]*>/g, '');
  const lines = t.split(LINE_SPLIT).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.some(l => /^[-–—]/.test(l) || /[-–—]$/.test(l))) {
    const per = lines.map(l => {
      const s = l.replace(/^[-–—]\s*/, '');
      const st = /^["“”]/.test(s);
      const en = /["“”][.…!؟?،,؛\s]*$/.test(s);
      const n = (s.match(QUOTE_CH) || []).length;
      if (st && en) return n === 2 && quoteWords(s) > 2 ? 'whole' : null;
      if (st) return n === 1 ? 'open' : null;
      if (en) return n === 1 ? 'close' : null;
      return null;
    });
    return per.some(Boolean) ? per : null;
  }
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
  if (edge !== total) return null;
  if (total % 2 === 0) return (total === 2 && quoteWords(t) <= 2) ? null : 'whole';
  if (total === 1) { if (startFirst) return 'open'; if (endLast) return 'close'; }
  return null;
}
function shapeOf(text) {
  const lines = String(text == null ? '' : text).split(LINE_SPLIT).map(l => l.trim()).filter(Boolean);
  const dashes = lines.filter(l => /^[-–—]/.test(l.replace(LEAD_TAGS, ''))).length;
  return lines.length + ':' + dashes;
}
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
  if (pairs === 0 && opens === closes && line.search(/[()]/) === line.indexOf(')') ) {
    return line.replace(/[()]/g, c => (c === '(' ? ')' : '('));
  }
  let out = line;
  let strays = info.strayOpen.slice();
  if (strays.length >= 2 && out.slice(0, strays[0]).replace(/[-–—\s"“”]/g, '') === '') {
    out = out.slice(0, strays[0]) + out.slice(strays[0] + 1);
    strays = strays.slice(1).map(p => p - 1);
  }
  for (const p of strays.slice().reverse()) {
    const end = wordEndAfter(out, p);
    if (end > p + 1) out = out.slice(0, end) + ')' + out.slice(end);
    else out = out.slice(0, p) + out.slice(p + 1);
  }
  info = parenInfo(out);
  for (const p of info.strayClose.slice().reverse()) {
    const st = wordStartBefore(out, p);
    if (st < p) out = out.slice(0, st) + '(' + out.slice(st);
    else out = out.slice(0, p) + out.slice(p + 1);
  }
  return out;
}
function repairParens(text) {
  if (!/[()]/.test(text)) return text;
  const held = [];
  const masked = text.replace(/\{[^}]*\}|<[^>]*>/g, m => { held.push(m); return '\uE000'; });
  if (!/[()]/.test(masked)) return text;
  let k = 0;
  return repairParensPlain(masked).replace(/\uE000/g, () => (k < held.length ? held[k++] : ''));
}
function repairParensPlain(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-–—]?\s*)\)\s*/);
    if (m) {
      lines[i] = m[1] + lines[i].slice(m[0].length);
      if (i > 0 && parenInfo(lines[i - 1]).strayOpen.length > 0) lines[i - 1] = appendClosing(lines[i - 1]);
    }
  }
  return lines.map(fixLineParens).join('\n');
}
function fixSplitQuotes(text) {
  const lines = text.split('\n');
  if (lines.length !== 2) return text;
  const a = lines[0].trim(), b = lines[1].trim();
  if (DASH_RE.test(a) || DASH_RE.test(b)) return text;
  const cnt = s => (s.match(/["“”]/g) || []).length;
  if (cnt(a) !== 1 || cnt(b) !== 1) return text;
  if (!/["“”]$/.test(a) || !/^["“”]/.test(b)) return text;
  const aCore = a.replace(/\s*["“”]$/, '');
  if (!aCore || TERM_CHARS.includes(aCore[aCore.length - 1])) return text;
  const bCore = b.replace(/^["“”]\s*/, '');
  return '"' + aCore + '\n' + bCore + '"';
}
function polishArabicText(txt) {
  let t = String(txt == null ? '' : txt)
    .replace(/\\+[nN]/g, '\n')
    .replace(/["“”]\(([^()"“”\n]+)\)["“”]/g, '($1)')
    .replace(/\(["“”]([^()"“”\n]+)["“”]\)/g, '"$1"');
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) out.push(...splitSpeakers(moveLeadingPunct(l)));
  let res = repairParens(out.map(l => moveLeadingPunct(l)).join('\n')).split('\n').filter(Boolean);
  if (CORRECTOR_WRAP_AT > 0 && res.length === 1 && !DASH_RE.test(res[0]) && !TAG_ONE.test(res[0]) && visibleLen(res[0]) > CORRECTOR_WRAP_AT) {
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
const TYPO_FIX_RAW = {"لى": "لي", "فى": "في", "الذى": "الذي", "التى": "التي", "لكى": "لكي", "معى": "معي", "بى": "بي", "نفسى": "نفسي", "رأيى": "رأيي", "رأسى": "رأسي", "انتى": "أنتِ", "حتي": "حتى", "باقى": "باقي", "ثوانى": "ثواني", "ماضى": "ماضي", "أصدقائى": "أصدقائي", "أبنائى": "أبنائي", "اخى": "أخي", "رئيسى": "رئيسي", "سيدى": "سيدي", "عزيزى": "عزيزي", "زوجتى": "زوجتي", "عائلتى": "عائلتي", "صديقى": "صديقي", "محامى": "محامي", "عالى": "عالي", "غالى": "غالي", "كرسى": "كرسي", "مبانى": "مباني", "اغانى": "أغاني", "ليالى": "ليالي", "حرامى": "حرامي", "عادى": "عادي", "قاضى": "قاضي", "فاضى": "فاضي", "اعطنى": "أعطني", "دعنى": "دعني", "ارنى": "أرني", "اخبرنى": "أخبرني", "صدقنى": "صدقني", "اسمعنى": "اسمعني", "سامحنى": "سامحني", "توقفى": "توقفي", "اذهبى": "اذهبي", "انظرى": "انظري", "ابتعدى": "ابتعدي", "اهربى": "اهربي", "مستشفي": "مستشفى", "فوضي": "فوضى", "اعمي": "أعمى", "سيدتى": "سيدتي", "امى": "أمي", "ابنتى": "ابنتي", "مقهي": "مقهى", "حوالى": "حوالي", "شخصى": "شخصي", "طبيعى": "طبيعي", "حقيقى": "حقيقي", "نهائى": "نهائي", "مبدئى": "مبدئي", "كافى": "كافي", "شكوي": "شكوى", "فتوي": "فتوى", "حلوي": "حلوى", "متي": "متى", "عسي": "عسى", "جدوي": "جدوى", "فحوي": "فحوى", "قصوي": "قصوى", "رؤي": "رؤى", "منتدي": "منتدى", "مسعي": "مسعى", "مغزي": "مغزى", "افعي": "أفعى", "مأوي": "مأوى", "مثوي": "مثوى", "مصطفي": "مصطفى", "مجتبي": "مجتبى", "مستلقي": "مستلقى", "مرتضي": "مرتضى", "اللة": "الله", "واللة": "والله", "لة": "له", "عنة": "عنه", "منة": "منه", "علية": "عليه", "إلية": "إليه", "فية": "فيه", "معة": "معه", "نفسة": "نفسه", "هذة": "هذه", "مفاجأه": "مفاجأة", "دقيقه": "دقيقة", "حقيقه": "حقيقة", "طريقه": "طريقة", "فجأه": "فجأة", "عائله": "عائلة", "غرفه": "غرفة", "مشكله": "مشكلة", "فكره": "فكرة", "سياره": "سيارة", "قوه": "قوة", "لحظه": "لحظة", "مهمه": "مهمة", "فرصه": "فرصة", "رساله": "رسالة", "نهايه": "نهاية", "بدايه": "بداية", "جريمه": "جريمة", "امرأه": "امرأة", "طاقه": "طاقة", "علاقه": "علاقة", "معركه": "معركة", "رحله": "رحلة", "شجره": "شجرة", "لعبه": "لعبة", "فتره": "فترة", "ورقه": "ورقة", "شرطه": "شرطة", "خطوه": "خطوة", "حفله": "حفلة", "مكالمه": "مكالمة", "مدرسه": "مدرسة", "رؤيه": "رؤية", "رصاصه": "رصاصة", "قنبله": "قنبلة", "اسلحه": "أسلحة", "فرقه": "فرقة", "حقيبه": "حقيبة", "بصمه": "بصمة", "قهوه": "قهوة", "طاوله": "طاولة", "مسأله": "مسألة", "اسئله": "أسئلة", "رائعه": "رائعة", "سرعه": "سرعة", "نافذه": "نافذة", "شاشه": "شاشة", "فائده": "فائدة", "عاصفه": "عاصفة", "سفينه": "سفينة", "طائره": "طائرة", "سياده": "سيادة", "جلاله": "جلالة", "عمده": "عمدة", "محطه": "محطة", "شركه": "شركة", "ابوة": "أبوه", "اسمة": "اسمه", "مياة": "مياه", "وجة": "وجه", "اتجاة": "اتجاه", "انتباة": "انتباه", "شبة": "شبه", "سهوله": "سهولة", "صعوبه": "صعوبة", "مجموعه": "مجموعة", "مساحه": "مساحة", "عاهره": "عاهرة", "عصابه": "عصابة", "خزنه": "خزنة", "بوابه": "بوابة", "قمامه": "قمامة", "ادله": "أدلة", "مباشره": "مباشرة", "كامله": "كاملة", "جديده": "جديدة", "كبيره": "كبيرة", "صغيره": "صغيرة", "محكمه": "محكمة", "حكومه": "حكومة", "عقوبه": "عقوبة", "معجزه": "معجزة", "خريطه": "خريطة", "ثلاجه": "ثلاجة", "قائمه": "قائمة", "قضيه": "قضية", "ضحيه": "ضحية", "رهينه": "رهينة", "عشيقه": "عشيقة", "خطيئه": "خطيئة", "مستحيله": "مستحيلة", "غريبه": "غريبة", "مجنونه": "مجنونة", "مؤخره": "مؤخرة", "مقدمه": "مقدمة", "نتيجه": "نتيجة", "اجهزه": "أجهزة", "اسطوره": "أسطورة", "ثقه": "ثقة", "صدفه": "صدفة", "معامله": "معاملة", "مواجهه": "مواجهة", "سيطره": "سيطرة", "بيئه": "بيئة", "هيئه": "هيئة", "مائده": "مائدة", "بطاقه": "بطاقة", "طبيعه": "طبيعة", "فضيحه": "فضيحة", "مصلحه": "مصلحة", "اسطوانه": "أسطوانة", "استماره": "استمارة", "شريحه": "شريحة", "مكافأه": "مكافأة", "جرأه": "جرأة", "بأكملة": "بأكمله", "تجاة": "تجاه", "افواة": "أفواه", "اشباة": "أشباه", "دوله": "دولة", "مدينه": "مدينة", "اشاره": "إشارة", "قياده": "قيادة", "شهاده": "شهادة", "عقيده": "عقيدة", "جائزه": "جائزة", "سياسه": "سياسة", "شئ": "شيء", "شئيا": "شيئا", "سئ": "سيء", "مسئول": "مسؤول", "دايما": "دائما", "بطئ": "بطيء", "قرائة": "قراءة", "برائة": "براءة", "الأن": "الآن", "شئون": "شؤون", "كئوس": "كؤوس", "يقراء": "يقرأ", "مليئ": "مليء", "سيئه": "سيئة", "ذالك": "ذلك", "هاذا": "هذا", "لاكن": "لكن", "مالذي": "ما الذي", "مابك": "ما بك", "كفائة": "كفاءة", "مايحدث": "ما يحدث", "مابه": "ما به", "مابها": "ما بها", "ياأمي": "يا أمي", "ياأبي": "يا أبي", "ياأخي": "يا أخي", "ارجوك": "أرجوك", "يارجل": "يا رجل", "ياإلهي": "يا إلهي", "يارفاق": "يا رفاق", "ياشباب": "يا شباب", "لاشئ": "لا شيء", "ياسيدي": "يا سيدي", "ياصديقي": "يا صديقي", "هاكذا": "هكذا", "لااحد": "لا أحد", "يافتاة": "يا فتاة", "بالتاكيد": "بالتأكيد", "لابأس": "لا بأس", "لايمكن": "لا يمكن", "لااعرف": "لا أعرف", "لااعلم": "لا أعلم", "ماالامر": "ما الأمر", "ماالخطب": "ما الخطب", "ايها": "أيها", "ايتها": "أيتها", "كلشئ": "كل شيء", "ايشئ": "أي شيء", "ياولدي": "يا ولدي", "يابني": "يا بني", "طاريء": "طارئ", "هاديء": "هادئ", "مفاجيء": "مفاجئ", "دافيء": "دافئ", "مباديء": "مبادئ", "لاداعي": "لا داعي", "لامشكلة": "لا مشكلة", "مالعمل": "ما العمل", "ماالمشكلة": "ما المشكلة", "خاطيء": "خاطئ", "مخطيء": "مخطئ", "قاريء": "قارئ", "رجائا": "رجاء", "مسائا": "مساء", "هاؤلاء": "هؤلاء", "اولائك": "أولئك", "بالظبط": "بالضبط", "انشاءالله": "إن شاء الله", "بماان": "بما أن", "كيفحالك": "كيف حالك", "بخيرشكرا": "بخير شكرا"};
const TYPO_ALL = new Map(Object.entries(TYPO_FIX_RAW));
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
const spell = require('./arabic-spelling')(fixTypoToken);
function fixArabicTypos(txt) { return spell.fix(txt); }
const OLD_FILE_MIN_LINES = 20;
const OLD_FILE_MIN_RATIO = 0.03;
function isVisualOrderFile(cues) {
  let total = 0, lead = 0;
  for (const c of cues) {
    if (!needsCorrection(c.text)) continue;
    for (const raw of String(c.text).split(LINE_SPLIT)) {
      const l = raw.replace(TAG_RE, '').trim().replace(/^[-–—]\s*/, '');
      if (!HAS_ARABIC.test(l)) continue;
      total++;
      if (/^[.!؟?،,؛:]/.test(l) && !/^(\.{3,}|…)/.test(l)) lead++;
    }
  }
  return total >= OLD_FILE_MIN_LINES && lead / total >= OLD_FILE_MIN_RATIO;
}
const ELL_RE = /^([-–—]\s*)?(\.{3,}|…)?\s*([\s\S]*?)\s*(\.{3,}|…)?$/;
const FLIP_BIDI_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const VIEW_HIDDEN_RE = /[\u200B\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const SPACED_DOTS_RE = /\.(?:[ \t\u00A0]\.){2,}/g;
function flipEllipsisLine(line) {
  const lead = line.match(LEAD_TAGS)[0];
  const rest = line.slice(lead.length);
  const tail = rest.match(TAIL_TAGS)[0];
  const body = rest.slice(0, rest.length - tail.length).replace(SPACED_DOTS_RE, '...');
  const m = body.match(ELL_RE);
  if (!m || (!m[2] && !m[4])) return line;
  let dash = m[1] || '';
  let core = m[3];
  const td = core.match(/\s*[-–—]$/);
  if (td) { core = core.slice(0, td.index); if (!dash) dash = '- '; }
  return lead + dash + (m[4] || '') + core + (m[2] || '') + tail;
}
function flipEllipsisText(text) {
  if (!needsCorrection(text)) return text;
  return String(text)
    .replace(FLIP_BIDI_RE, '')
    .split(/(\\+[nN]|\r?\n)/)
    .map((p, i) => (i % 2 ? p : flipEllipsisLine(p)))
    .join('');
}
const ELL_MIN_LINES = 20;
const ELL_MIN_COUNT = 10;
const ELL_COUNT_DOMINANCE = 4;
const ELL_MIN_PAIRS = 3;
const ELL_PAIR_DOMINANCE = 3;
const ELL_START_RE = /^(\.{3,}|…)/;
const ELL_END_RE = /(\.{3,}|…)$/;
function ellView(raw) {
  return String(raw).replace(TAG_RE, '').replace(VIEW_HIDDEN_RE, '').replace(SPACED_DOTS_RE, '...').trim().replace(/^[-–—]\s*/, '');
}
function analyzeEllipsis(cues) {
  let total = 0, startN = 0, endN = 0, pairOk = 0, pairRev = 0, prev = null;
  for (const c of cues) {
    if (!needsCorrection(c.text)) { prev = null; continue; }
    const lines = String(c.text).split(LINE_SPLIT).map(ellView).filter(l => l && HAS_ARABIC.test(l));
    if (!lines.length) { prev = null; continue; }
    for (const l of lines) {
      total++;
      if (ELL_START_RE.test(l)) startN++;
      if (ELL_END_RE.test(l)) endN++;
    }
    const cur = { s: ELL_START_RE.test(lines[0]), e: ELL_END_RE.test(lines[lines.length - 1]) };
    if (prev) {
      if (prev.e && cur.s) pairOk++;
      if (prev.s && cur.e) pairRev++;
    }
    prev = cur;
  }
  const countRev = startN >= ELL_MIN_COUNT && startN >= ELL_COUNT_DOMINANCE * endN;
  const countOk = endN >= ELL_MIN_COUNT && endN >= ELL_COUNT_DOMINANCE * startN;
  const pairsRev = pairRev >= ELL_MIN_PAIRS && pairRev >= ELL_PAIR_DOMINANCE * pairOk;
  const pairsOk = pairOk >= ELL_MIN_PAIRS && pairOk >= ELL_PAIR_DOMINANCE * pairRev;
  const reversed = total >= ELL_MIN_LINES && (countRev || pairsRev) && !(countOk || pairsOk);
  return { total, startN, endN, pairOk, pairRev, reversed };
}
async function correctChunkStrict(items, keysArray, modelName, ctx = null, hook = null) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };
  const ctxBlock = ctx && (ctx.before.length || ctx.after.length)
    ? `\nCONTEXT (READ-ONLY): Use these lines ONLY to understand if a sentence continues across entries.\ncontext_before: ${JSON.stringify(ctx.before)}\ncontext_after: ${JSON.stringify(ctx.after)}\n`
    : '';
  const prompt = `You will receive a JSON array of Arabic subtitle entries: {"id": <number>, "text": "<Arabic words>"}. Some entries also have "q" (a quotation hint, see rule 7).
Most punctuation of every entry was REMOVED on purpose. What was kept: the speaker dashes "-", the line-break markers \\N, any "...", and any "?", "!", "؟" or ":" that stands at the very end of a line.
Your job: write the punctuation of each entry from scratch, correctly, in logical Unicode order for modern right-to-left Arabic.

STRICT RULE: do NOT change, add, remove, reorder or replace any WORD. No synonyms, no grammar fixes, no gender changes. You may only ADD punctuation marks, quotation marks, parentheses. There is nothing to translate and nothing to guess about who is speaking.

Rules:
1. Return a JSON array: [{"id": <same number>, "text": "<the same words with punctuation>"}] with exactly one object per input id, in the same order. Never output "q".
2. Keep every \\N line break exactly where it is. NEVER merge lines, split lines or add lines.
3. Keep every dash "-" exactly at the start of its line. Never add a dash to a line that has none.
4. Sentence marks: end each sentence with . or ! or ؟ as the meaning requires, and use ، and ؛ where natural. Keep every existing "..." exactly where it is. Use the read-only context to see whether a sentence continues in the next entry or continues from the previous one: do NOT end an entry with a full stop if its sentence continues in the next entry. Any line that already ends with "؟", "!" or ":" keeps it EXACTLY; never remove it, never change it, never add another mark after it.
5. PERSON NAMES (names of people or characters, even when a prefix such as ل ب و ك ف is attached to the word): wrap the whole name in quotation marks ONLY, like "سالي". NEVER use parentheses () for people.
6. ENTITIES & PLACES (companies, brands, cities, countries, institutions, organizations, dishes): wrap them in parentheses ONLY, like (لندن) or (أبل). NEVER use quotation marks "" for them. If you are not sure that a word is a name, leave it with no mark.
7. "q" tells you how the original entry was quoted. "whole" = the whole entry is ONE quotation: put one opening quotation mark right before the first word of the first line and one closing quotation mark right after the last word of the last line, and add NO other quotation marks inside this entry. "open" = the quotation continues in the next entry: put only one opening quotation mark right before the first word, and no other quotation marks. "close" = the quotation began in an earlier entry: put only one closing quotation mark right after the last word, and no other quotation marks. An entry without "q" is not quoted as a whole.If "q" is an array, it has one value per line, in order: apply each value to its own line only; null means that line is not quoted.
8. NEVER output square brackets [ ].
9. ONLY output the JSON array. No explanations.

EXAMPLES:
Input: [{"id": 1, "text": "هل اخبرت مصطفى عن شركة ابل"}]
Output: [{"id": 1, "text": "هل أخبرت \\"مصطفى\\" عن شركة (أبل)؟"}]

${ctxBlock}
Content to punctuate:
${JSON.stringify(items)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (hook && hook.cancelled) return { status: 'cancelled', map: new Map() };
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
        if (items.length >= 40) console.log(`[Success ✅] (${shortModel(cleanModel)}) طلب ${items.length} سطر، رجع ${map.size} عبر ...${cleanKey.slice(-4)}`);
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
      console.log(`[تبريد طارئ - مصحح] (${shortModel(cleanModel)}) ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s`);
      if (hook && hook.onFail) hook.onFail();
      if (attempt < 3) await delay(2000 + (Math.random() * 2000));
    }
  }
  return { status: 'api_exhausted', map: new Map() };
}
async function correctItemsWithRecovery(items, keysArray, modelName, ctx = null, hook = null) {
  const done = new Map();
  if (!items || items.length === 0) return done;
  let pending = items;
  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    if (hook && hook.cancelled) break;
    const result = await correctChunkStrict(pending, keysArray, modelName, ctx, hook);
    if (result.status === 'cancelled') break;
    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ - مصحح] (${shortModel(modelName)}) مختنق. تأجيل (${pending.length}) سطر لجولة الإنقاذ.`);
      break;
    }
    if ((result.status === 'bad_ids' || result.status === 'bad_format' || (result.status === 'ok' && result.map.size === 0)) && pending.length > 1) {
      const mid = Math.ceil(pending.length / 2);
      console.log(`[عزل مسموم - مصحح] الموديل مختنق بـ (${pending.length}) سطر. أقسمها لنصفين وأعيد.`);
      const left = await correctItemsWithRecovery(pending.slice(0, mid), keysArray, modelName, ctx, hook);
      const right = await correctItemsWithRecovery(pending.slice(mid), keysArray, modelName, ctx, hook);
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
      console.log(`[إعادة الناقص - مصحح 🔁] ناقص ${pending.length} من ${before}. أعيد طلبهم فقط...`);
    }
  }
  return done;
}
const fallbackModelOf = m => (String(m || 'gemini-3.1-flash-lite').trim() === CORRECTOR_FALLBACK_MODEL ? 'gemini-3.1-flash-lite' : CORRECTOR_FALLBACK_MODEL);
function hedgedCorrectItems(items, keysArray, primaryModel, ctx) {
  const fbModel = fallbackModelOf(primaryModel);
  const ids = items.map(it => it.id);
  const isComplete = m => !!m && ids.every(id => m.get(id));
  const priHook = { cancelled: false, fails: 0, onFail: null };
  const fbHook = { cancelled: false };
  return new Promise(resolve => {
    let priMap = null, fbMap = null, fbStarted = false, settled = false;
    const finish = (map, winner) => {
      if (settled) return;
      settled = true;
      if (winner === 'fb') {
        priHook.cancelled = true;
        console.log(`\u200F[طلب احتياطي ✅] (${shortModel(fbModel)}) أنجز الدفعة (${items.length} سطر) قبل (${shortModel(primaryModel)}).`);
      } else if (winner === 'pri') {
        fbHook.cancelled = true;
        if (fbStarted) console.log(`\u200F[طلب احتياطي] (${shortModel(primaryModel)}) نجح أولاً، ألغيت الاحتياطي.`);
      }
      resolve(map);
    };
    const check = () => {
      if (settled) return;
      if (isComplete(priMap)) return finish(priMap, 'pri');
      if (isComplete(fbMap)) return finish(fbMap, 'fb');
      if (priMap !== null && (!fbStarted || fbMap !== null)) {
        const merged = new Map(fbMap || []);
        for (const [id, text] of priMap) if (text) merged.set(id, text);
        finish(merged, 'merge');
      }
    };
    priHook.onFail = () => {
      if (++priHook.fails !== HEDGE_AFTER_FAILS || fbStarted || settled) return;
      fbStarted = true;
      console.log(`\u200F[طلب احتياطي 🏇] (${shortModel(primaryModel)}) فشل ${HEDGE_AFTER_FAILS} مرات ⟵ أطلق (${shortModel(fbModel)}) بالتوازي لنفس الدفعة (${items.length} سطر).`);
      correctItemsWithRecovery(items, keysArray, fbModel, ctx, fbHook)
        .catch(() => new Map())
        .then(m => { fbMap = m; check(); });
    };
    correctItemsWithRecovery(items, keysArray, primaryModel, ctx, priHook)
      .catch(() => new Map())
      .then(m => { priMap = m; check(); });
  });
}
const NAMES_PARALLEL = process.env.NAMES_PARALLEL !== '0';
const secsOf = ms => (ms / 1000).toFixed(1);
const plainForBook = texts => texts
  .map(t => String(t).replace(TAG_RE, '').replace(/"([^"\n]*)"|\(([^()\n]*)\)/g, '$1$2').split(LINE_SPLIT).join(' ').replace(/\s+/g, ' ').trim())
  .filter(Boolean);
  
async function correctAllCues(cues, keysArray, modelName, cacheKey, opts = {}) {
  const tStart = Date.now();
  const oldFile = isVisualOrderFile(cues);
  const ell = analyzeEllipsis(cues);
  const flipNow = oldFile || (ELLIPSIS_AUTO && ell.reversed);
  if (flipNow) {
    if (oldFile) console.log('[مصحح] ملف قديم: أقلب مكان الثلاث نقاط (...)');
    cues = cues.map(c => ({ ...c, text: flipEllipsisText(c.text) }));
  }
  const CHUNK = CORRECTOR_CHUNK;
  const cacheVersion = 'ARB2';
  const lineCacheKey = cacheVersion + '_' + CORRECTOR_REV + '_' + cacheKey;
  const nameCacheKey = cacheVersion + '_names_' + cacheKey;
  const seriesTid = String(cacheKey).split('|')[0];
  const seriesParts = seriesTid.split(':');
  const seriesKey = seriesParts.length >= 3 ? cacheVersion + '_snames_' + (/^tt\d+$/.test(seriesParts[0]) ? seriesParts[0] : seriesParts[0] + ':' + seriesParts[1]) : null;
  const seriesEp = seriesTid;

  const cache = await loadLineCache(lineCacheKey);
  const namesStored = await db.loadMap('names', nameCacheKey);
  
  let book = null;
  let kinds = new Map();
  let namesLoadedFromCache = false;

  if (namesStored && namesStored.has(1)) {
    try {
      const parsedBookMap = JSON.parse(namesStored.get(1));
      const parsedKinds = JSON.parse(namesStored.get(2) || '[]');
      book = makeBook(new Map(parsedBookMap));
      kinds = new Map(parsedKinds);
      namesLoadedFromCache = true;
    } catch (e) {
      console.log(`[كاش الأسماء] فشل قراءة الكاش الدائم، سأعيد بناء القاموس من الصفر.`);
    }
  }

  const results = new Array(cues.length).fill(null);
  const toDo = [];
  const sentText = new Map();
  let fromCache = 0;
  
  cues.forEach((c, i) => {
    if (!needsCorrection(c.text)) { results[i] = c.text; return; }
    if (cache.has(i)) { results[i] = cache.get(i); fromCache++; return; }
    const prepared = prepareForModel(c.text);
    sentText.set(i, prepared);
    const item = { id: i, text: prepared };
    const q = quoteHint(c.text);
    if (q) item.q = q;
    toDo.push(item);
  });
  
  if (fromCache > 0) console.log(`[كاش الأسطر - مصحح] ${fromCache} سطر جاهز من قبل، أصحح الباقي (${toDo.length}) فقط.`);
  if (namesLoadedFromCache && toDo.length > 0 && opts.round === 1) console.log(`\u200F[كاش الأسماء 💾] تم استرجاع قاموس الأسماء المحفوظ (${book.size} اسم) بدل بنائه من جديد.`);
  
  const namesDeps = {
    axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
    normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
    MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent
  };
  const startBook = texts => buildNameBook(texts, keysArray, modelName, namesDeps, [], Math.min(3, Math.max(1, aliveKeyCount(keysArray))))
    .catch(e => { console.log(`[مصحح] تعذر بناء قاموس الأسماء: ${e && e.message}`); return null; });
    
  let bookPromise = null;
  if (!namesLoadedFromCache && NAMES_PARALLEL && toDo.length > 0) {
    const sourceTexts = cues.filter(c => needsCorrection(c.text)).map(c => c.text);
    bookPromise = startBook(plainForBook(sourceTexts));
  }
  
  let rejected = 0, leakFixed = 0, leakRejected = 0;
  const dirty = [];
  const workerCount = Math.max(1, Math.min(aliveKeyCount(keysArray), CORRECTOR_MAX_WORKERS));
  
  const applyLine = (id, text) => {
    const orig = cues[id].text;
    text = spell.restoreFinalYa(orig, text);
    let leakBad = false;
    const lk = fixForeignLeak(orig, text);
    if (lk == null) { leakBad = true; leakRejected++; } else if (lk.fixed) { text = lk.text; leakFixed++; }
    let src = text;
    if (leakBad || !sameWords(orig, text) || shapeOf(text) !== shapeOf(sentText.get(id) || orig)) {
      rejected++; src = orig;
    } else {
      const withTags = restoreTags(orig, text);
      if (withTags == null) { rejected++; src = orig; } else src = withTags;
    }
    const clean = fixMarks(cleanCorrectorOutput(src) || cleanCorrectorOutput(orig), quoteHint(orig));
    results[id] = clean;
    cache.set(id, clean);
    dirty.push([id, clean]);
  };
  
  const persistDirty = () => {
    if (dirty.length === 0) return;
    db.saveMap('line', lineCacheKey, dirty.splice(0));
  };
  
  const runBatchWithModel = async (itemsToRun, activeModel, hedge = false) => {
    const chunks = [];
    for (let i = 0; i < itemsToRun.length; i += CHUNK) chunks.push(itemsToRun.slice(i, i + CHUNK));
    const currentWorkers = Math.max(1, Math.min(aliveKeyCount(keysArray), CORRECTOR_MAX_WORKERS, chunks.length));
    async function batchWorker() {
      while (chunks.length > 0) {
        if (keysArray.every(k => deadKeys.has(k))) return;
        const chunk = chunks.shift();
        if (!chunk) break;
        try {
          const ctx0 = buildChunkContext(cues, chunk);
          const ctx = { before: ctx0.before.map(prepareForModel).filter(Boolean), after: ctx0.after.map(prepareForModel).filter(Boolean) };
          const map = hedge
            ? await hedgedCorrectItems(chunk, keysArray, activeModel, ctx)
            : await correctItemsWithRecovery(chunk, keysArray, activeModel, ctx);
          for (const it of chunk) {
            const text = map.get(it.id);
            if (text) applyLine(it.id, text);
          }
          persistDirty();
        } catch (e) {
          console.log(`[مصحح] خطأ بمهمة (${shortModel(activeModel)}): ${e && e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: currentWorkers }, () => batchWorker()));
  };
  
  if (toDo.length > 0) {
    await runBatchWithModel(toDo, modelName, true);
  }
  
  let unprocessed = toDo.filter(it => results[it.id] == null);
  if (unprocessed.length > 0 && !keysArray.every(k => deadKeys.has(k))) {
    const primaryClean = String(modelName || 'gemini-3.1-flash-lite').trim();
    const fallbackModel = primaryClean === CORRECTOR_FALLBACK_MODEL ? 'gemini-3.1-flash-lite' : CORRECTOR_FALLBACK_MODEL;
    console.log(`\u200F[إنقاذ تلقائي 🚑] بقى (${unprocessed.length}) سطر بسبب اختناق (${shortModel(primaryClean)}). أنتظر ${FALLBACK_WAIT_MS / 1000} ثواني لتبريد المفاتيح وأحول على (${shortModel(fallbackModel)})...`);
    await delay(FALLBACK_WAIT_MS);
    await runBatchWithModel(unprocessed, fallbackModel);
    unprocessed = toDo.filter(it => results[it.id] == null);
  }
  
  const missing = unprocessed.length;
  if (leakFixed || leakRejected) console.log(`\u200F[حارس الأحرف الغريبة 🛡] أصلحت ${leakFixed} سطر (حرف غريب دخل من Gemini) | أرجعت ${leakRejected} سطر للأصلي`);
  console.log(`\u200F[ملخص المصحح 📊] كلي=${cues.length} | مصحح=${toDo.length} | رفض=${rejected} | نواقص=${missing} | مفاتيح=${workerCount} | زمن مرحلة الأسطر=${Math.round((Date.now() - tStart)/1000)} ثانية`);
  spell.flushLog();
  
  const finalTexts = cues.map((c, i) =>
    needsCorrection(c.text) ? (results[i] != null ? results[i] : cleanCorrectorOutput(c.text)) : c.text
  );
  
  const eligible = cues.map(c => needsCorrection(c.text) && !quoteHint(c.text));
  let outTexts = finalTexts;
  
  if (toDo.length > 0) {
    const tNames = Date.now();
    let tBookWait = 0, tCls = 0;
    if (!book) {
      book = bookPromise
        ? await bookPromise
        : await startBook(plainForBook(finalTexts.filter((_, i) => needsCorrection(cues[i].text))));
      tBookWait = Date.now() - tNames;
      console.log(`\u200F[مرحلة الأسماء - القاموس] ${book ? `جاهز (${book.size} اسم)` : 'فشل بناؤه'} | ${bookPromise ? `كان يعمل بالتوازي مع الأسطر، انتظرته بعدها ${secsOf(tBookWait)} ثانية` : `بنيته بعد الأسطر في ${secsOf(tBookWait)} ثانية`}`);
    } else {
      console.log(`\u200F[مرحلة الأسماء - القاموس] من الكاش (${book.size} اسم)`);
      { const d = describeBook(book); if (d) console.log(d); }
    }

    if (seriesKey) {
      try {
        const stored = await db.loadMap('names', seriesKey);
        const ser = stored && stored.has(1) ? JSON.parse(stored.get(1)) : {};
        if (!book && Object.keys(ser).length) { book = makeBook(new Map()); book.complete = false; }
        if (book) {
          const r = mergeSeriesNames(book, ser, seriesEp, book.complete !== false);
          if (r.changed) db.saveMap('names', seriesKey, [[1, JSON.stringify(r.ser)]]);
          console.log(`\u200F[ذاكرة المسلسل 🧠] أسماء من حلقات سابقة أضفتها: ${r.added.length}${r.added.length ? ' (' + r.added.slice(0, 15).join('، ') + ')' : ''} | أسماء محفوظة للمسلسل: ${Object.keys(r.ser).length}${r.changed ? ' | تم تحديث الذاكرة' : ''}`);
        }
      } catch (e) { console.log(`[ذاكرة المسلسل] تعذر: ${e && e.message}`); }
    }

    let tflags = null;
    if (TRANSLATOR_MODE) {
      cues.forEach((c, i) => { if (eligible[i]) finalTexts[i] = splitGluedPrefixes(c.text, finalTexts[i]); });
      tflags = cues.map((c, i) => (eligible[i] ? translatorFlags(c.text, finalTexts[i]) : null));
      if (book) {
        try {
          const cands = collectNameCandidatesT(finalTexts, eligible, tflags, 300, book).filter(x => !kinds.has(nameKey(x.w)));
          if (cands.length) {
            const tC = Date.now();
            const nk = await classifyNames(cands, keysArray, modelName, namesDeps);
            tCls = Date.now() - tC;
            for (const [k, v] of nk) kinds.set(k, v);
          }
          if ((!namesLoadedFromCache || cands.length) && book.complete !== false) {
            db.saveMap('names', nameCacheKey, [
              [1, JSON.stringify(Array.from(book.map.entries()))],
              [2, JSON.stringify(Array.from(kinds.entries()))]
            ]);
          }
        } catch (e) { console.log(`[مصحح] تعذر تصنيف/حفظ الأسماء: ${e && e.message}`); }
      }
      outTexts = applyNameBook(propagateNamesT(finalTexts, eligible, kinds, book, tflags), eligible, book, tflags);
    } else {
      if (!namesLoadedFromCache && book) {
        try {
          kinds = await classifyNames(collectNameCandidates(finalTexts, eligible, 300, book), keysArray, modelName, namesDeps);
          const dataToSave = [
            [1, JSON.stringify(Array.from(book.map.entries()))],
            [2, JSON.stringify(Array.from(kinds.entries()))]
          ];
          if (book.complete !== false) db.saveMap('names', nameCacheKey, dataToSave);
        } catch (e) { console.log(`[مصحح] تعذر تصنيف/حفظ الأسماء: ${e && e.message}`); }
      }
      outTexts = applyNameBook(propagateNames(finalTexts, eligible, kinds, book), eligible, book);
    }
    
    outTexts = outTexts.map((t, i) => (eligible[i] ? wrapMaddaNames(cues[i].text, t) : t));

    const changed = [];
    outTexts.forEach((t, i) => {
      if (t !== finalTexts[i] && cache.has(i)) {
        cache.set(i, t);
        changed.push([i, t]);
      }
    });
    if (changed.length) db.saveMap('line', lineCacheKey, changed);
    
    console.log(`\u200F[مرحلة الأسماء بعد الأسطر ⏱] ${secsOf(Date.now() - tNames)} ثانية (انتظار القاموس ${secsOf(tBookWait)} + تصنيف ${secsOf(tCls)} + تطبيق وحفظ) | ${namesLoadedFromCache ? 'قاموس من الكاش' : 'قاموس جديد'}`);
  }
  
  console.log(`\u200F[المصحح كامل ⏱ الزمن الكلي الحقيقي] ${secsOf(Date.now() - tStart)} ثانية (الأسطر + مرحلة الأسماء)`);
  return { texts: outTexts, missing };
}

const epInfoOf = id => {
  const p = String(id || '').split(':');
  return (p.length >= 3 && /^\d+$/.test(p[2])) ? { season: p[1], episode: p[2] } : null;
};
function loadArabicSub(url, subsourceKey, targetId) {
  if (/\/oscom\/file\//i.test(url)) return getRawArabicSubContent(url, subsourceKey, epInfoOf(targetId));
  return fetchAndExtractSub(url, subsourceKey, resolveEpInfoForUrl(url, epInfoOf(targetId)));
}
async function loadSavedOrFetch(url, subsourceKey, targetId, trackNum) {
  if (targetId && trackNum) {
    const saved = await db.loadDoc('rawsrt', targetId + '_track' + trackNum + TRACKS_TAG);
    if (saved && saved.text) {
      console.log(`[مصحح Nuvio] Track ${trackNum}: المصدر جاهز من التخزين الدائم، ما أحتاج الموقع.`);
      return saved.text;
    }
  }
  return loadArabicSub(url, subsourceKey, targetId);
}
async function handleCorrectionSrt(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let originalText = "";
  try { originalText = extraKeys.preloadedText || await loadSavedOrFetch(subUrl, extraKeys.subsourceKey, targetId, extraKeys.trackNum); }
  catch (e) {
    console.log(`[مصحح Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message} <- ${subUrl}`);
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة العربية الأصلي.\n\n", missing: 0, total: 0, failed: true };
  }
  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n", missing: 0, total: 0, failed: true };
  console.log(`[تشخيص] ${subUrl.slice(0, 120)} | أول سطر: ${String(cues[0].text).slice(0, 50)} | آخر وقت: ${cues[cues.length - 1].end}`);
  console.log(`[مصحح Nuvio SRT] ${cues.length} أسطر عربية -> CHUNK=${CORRECTOR_CHUNK} | مفاتيح=${keysArray.length}`);
  const { texts: finalCorrections, missing } = await correctAllCues(cues, keysArray, modelName, `${targetId}|${subUrl}`, { round: extraKeys.round });
  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    if (DRAWING_RE.test(c.text)) return;
    let text = String(finalCorrections[idx] || '').replace(/\\+[nN]/g, '\n');
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
const ASS_DLG_RE = /^(Dialogue:\s*[^,]*,[^,]*,[^,]*,(?:[^,]*,){6})(.*)$/i;
const ASS_RTL_MARKS = true;
const RLM = '\u200F';
function addRlm(text) {
  if (!ASS_RTL_MARKS) return text;
  return String(text).split(/(\\N|\\n|\r?\n)/).map((p, i) => {
    if (i % 2 || !p.trim()) return p;
    const lead = p.match(LEAD_TAGS)[0];
    const rest = p.slice(lead.length);
    const tail = rest.match(TAIL_TAGS)[0];
    const body = rest.slice(0, rest.length - tail.length);
    if (!HAS_ARABIC.test(body)) return p;
    return lead + RLM + body + RLM + tail;
  }).join('');
}
function parseAssKeepingStructure(text) {
  const lines = String(text).split(/\r?\n/);
  const cues = [], slots = [];
  lines.forEach((line, i) => {
    const m = line.match(ASS_DLG_RE);
    if (!m) return;
    const f = m[1].split(',');
    cues.push({ start: f[1].trim(), end: f[2].trim(), text: m[2] });
    slots.push(i);
  });
  return { lines, cues, slots };
}
function applyAssFontSize(lines) {
  const info = { changed: false };
  const fail = why => { info.reason = why; console.log('[حجم ASS] ما تغيّر شي: ' + why); return info; };
  let sect = '', playResY = 0, fmt = null;
  const styles = new Map();
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].replace(/^\uFEFF/, '');
    const sm = L.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sm) { sect = sm[1].trim().toLowerCase(); continue; }
    if (sect === 'script info') {
      const pm = L.match(/^\s*PlayResY\s*:\s*([\d.]+)/i);
      if (pm && parseFloat(pm[1]) > 0) playResY = parseFloat(pm[1]);
    } else if (/^v4\+? styles$/.test(sect)) {
      const fm = L.match(/^\s*Format\s*:(.*)$/i);
      if (fm) { fmt = fm[1].split(',').map(s => s.trim().toLowerCase()); continue; }
      const st = L.match(/^(\s*Style\s*:\s*)(.*)$/i);
      if (st && fmt) {
        const vals = st[2].split(',');
        const nm = (vals[fmt.indexOf('name')] || '').trim();
        styles.set(nm, { i, prefix: st[1], vals });
      }
    }
  }
  if (!fmt) return fail('ما لقيت سطر Format تحت [V4+ Styles]');
  const iName = fmt.indexOf('name'), iSize = fmt.indexOf('fontsize'), iOut = fmt.indexOf('outline'), iSh = fmt.indexOf('shadow');
  if (iName < 0 || iSize < 0) return fail('سطر Format ما فيه Name أو Fontsize');
  const counts = new Map();
  let total = 0;
  for (const line of lines) {
    const m = line.match(ASS_DLG_RE);
    if (!m) continue;
    const f = m[1].split(',');
    if (/fx/i.test(f[8] || '')) continue;
    if (DRAWING_RE.test(m[2])) continue;
    const nm = (f[3] || '').trim();
    counts.set(nm, (counts.get(nm) || 0) + 1);
    total++;
  }
  if (!total) return fail('ما في أسطر حوار (كلها fx أو رسم)');
  const findStyle = nm => {
    let sv = styles.get(nm);
    if (!sv) for (const [k2, v2] of styles) if (k2.toLowerCase() === nm.toLowerCase()) { sv = v2; break; }
    return sv || null;
  };
  // نجمّع ستايلات الحوار حسب حجمها الأصلي، ونختار مجموعة الحجم اللي عليها أكثر أسطر
  const groups = new Map();
  for (const [nm, n] of counts) {
    const sv = findStyle(nm);
    const sz = sv ? parseFloat(sv.vals[iSize]) : NaN;
    if (!(sz > 0)) continue;
    const g = groups.get(sz) || { n: 0, top: null, topN: 0 };
    g.n += n;
    if (n > g.topN) { g.top = nm; g.topN = n; }
    groups.set(sz, g);
  }
  if (!groups.size) return fail('ما لقيت حجم ستايلات الحوار تحت [V4+ Styles]');
  let oldSize = 0, grp = null;
  for (const [sz, g] of groups) if (!grp || g.n > grp.n) { oldSize = sz; grp = g; }
  if (grp.n / total < ASS_MAIN_MIN_SHARE) return fail(`ما في مجموعة حجم واضحة (الأكبر: حجم ${oldSize} = ${grp.n} من ${total})`);
  const top = grp.top, topN = grp.n;
  const st = findStyle(top);
  const usedFallback = !(playResY > 0);
  if (usedFallback) playResY = ASS_FALLBACK_PLAYRESY;
  const k = Math.pow(10, ASS_FONT_DECIMALS);
  const target = Math.round(playResY * ASS_FONT_PCT / 100 * k) / k;
  if (!(target > 0)) return fail('الحجم الجديد طلع صفر');
  const sizeChanged = target !== oldSize;
  const ratio = target / oldSize;
  const lead = s => s.match(/^\s*/)[0];
  const scale = (entry, idx, amount) => {
    if (!sizeChanged || idx < 0 || idx >= entry.vals.length) return null;
    const n = parseFloat(entry.vals[idx]);
    const a = Number(amount);
    if (!isFinite(n) || !isFinite(a)) return null;
    const to = Math.round(n * (1 + (ratio - 1) * a) * 100) / 100;
    if (to === n) return null;
    entry.vals[idx] = lead(entry.vals[idx]) + String(to);
    return { from: n, to };
  };
  const iBold = fmt.indexOf('bold');
  const restyle = entry => {
    const r = { outline: null, shadow: null, bold: null };
    if (ASS_SCALE_OUTLINE) r.outline = scale(entry, iOut, ASS_OUTLINE_AMOUNT);
    if (ASS_SCALE_SHADOW) r.shadow = scale(entry, iSh, ASS_SHADOW_AMOUNT);
    if (ASS_BOLD_OFF && iBold >= 0 && iBold < entry.vals.length) {
      const bv = parseFloat(entry.vals[iBold]);
      if (isFinite(bv) && bv !== 0) { r.bold = { from: bv, to: 0 }; entry.vals[iBold] = lead(entry.vals[iBold]) + '0'; }
    }
    if (sizeChanged) entry.vals[iSize] = lead(entry.vals[iSize]) + String(target);
    return r;
  };
  const main = restyle(st);
  if (!sizeChanged && !main.bold) return fail(`الستايل ${top} حجمه أصلاً ${oldSize} (نفس الهدف، PlayResY=${playResY})`);
  lines[st.i] = st.prefix + st.vals.join(',');
  const others = [];
  if (ASS_SCALE_OTHER_STYLES) {
    const done = new Set([st.i]);
    for (const nm of counts.keys()) {
      let sv = styles.get(nm);
      if (!sv) for (const [k2, v2] of styles) if (k2.toLowerCase() === nm.toLowerCase()) { sv = v2; break; }
      if (!sv || done.has(sv.i)) continue;
      done.add(sv.i);
      if (parseFloat(sv.vals[iSize]) !== oldSize) continue;
      const before = sv.vals.join(',');
      restyle(sv);
      if (sv.vals.join(',') !== before) { lines[sv.i] = sv.prefix + sv.vals.join(','); others.push(nm); }
    }
  }
  const { outline, shadow, bold } = main;
  const extra = (outline ? ` | Outline ${outline.from}→${outline.to}` : '') + (shadow ? ` | Shadow ${shadow.from}→${shadow.to}` : '') + (bold ? ' | Bold طافي' : '') + (others.length ? ` | معه: ${others.join('، ')}` : '');
  console.log(`[حجم ASS] الستايل=${top} ${sizeChanged ? `من ${oldSize} إلى ${target}` : `الحجم بقى ${oldSize}`} (PlayResY=${playResY}${usedFallback ? ' افتراضي' : ''})${extra}`);
  return Object.assign(info, { changed: true, style: top, from: oldSize, to: target, playResY, usedFallback, outline, shadow, bold, others, share: topN / total });
}
function rebuildAss(parsed, texts) {
  const out = parsed.lines.slice();
  try { applyAssFontSize(out); } catch (e) { console.log('[حجم ASS] تعذر: ' + (e && e.message)); }
  const drop = new Set();
  parsed.slots.forEach((lineIdx, k) => {
    if (DROP_DRAWINGS && DRAWING_RE.test(texts[k])) { drop.add(lineIdx); return; }
    const m = out[lineIdx].match(ASS_DLG_RE);
    out[lineIdx] = m[1] + addRlm(String(texts[k]).replace(/\r?\n/g, '\\N'));
  });
  return out.filter((_, i) => !drop.has(i)).join('\n');
}
async function handleCorrectionAss(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId, extraKeys = {}) {
  let originalText = "";
  try { originalText = extraKeys.preloadedText || await loadArabicSub(subUrl, extraKeys.subsourceKey, targetId); }
  catch (e) {
    console.log(`[مصحح Nuvio ASS] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف العربي.`, missing: 0, total: 0, failed: true };
  }
  const parsed = parseAssKeepingStructure(originalText);
  const isRealAss = parsed.cues.length > 0;
  const cues = isRealAss ? parsed.cues : extractCuesUniversal(originalText);
  if (!cues.length) return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };
  console.log(`[مصحح Nuvio ASS] ${cues.length} أسطر عربية -> CHUNK=${CORRECTOR_CHUNK} | مفاتيح=${keysArray.length} | ملف ASS أصلي=${isRealAss}`);
  const { texts, missing } = await correctAllCues(cues, keysArray, modelName, `${targetId}|${subUrl}`, { round: extraKeys.round });
  if (isRealAss) {
    return { content: rebuildAss(parsed, texts) + '\n', missing, total: cues.length, failed: false };
  }
  const assLines = [];
  cues.forEach((c, idx) => {
    const text = texts[idx];
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${addRlm(text.trim().replace(/\r?\n/g, '\\N'))}`);
  });
  return { content: ASS_DEFAULT_HEADER + assLines.join('\n') + '\n', missing, total: cues.length, failed: false };
}
module.exports = {
  handleCorrectionSrt,
  handleCorrectionAss,
  CORRECTOR_REV,
  TRACKS_TAG,
  analyzeEllipsis,
  flipEllipsisText,
  isVisualOrderFile,
  correctAllCues
};
