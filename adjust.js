'use strict';
// تعديل ترجمة جاهزة وقت التسليم فقط: التوقيت (SRT وASS) + الحجم والارتفاع (ASS فقط).
// دوال نقية: تاخذ النص وترجع نص جديد. النسخة المحفوظة ما تنلمس أبدا، وإذا الإعدادات افتراضية يرجع نفس النص حرفيا.

const STEP_MS = 100;
const STEP_SIZE = 5;
const STEP_UP = 1;
const LIM_MS = 600000;
const LIM_SIZE = [50, 200];
const LIM_UP = [-40, 40];
const FALLBACK_PLAYRESY = 288;
const MAIN_MIN_SHARE = 0.5;
const DRAWING_RE = /\{[^}]*\\p0*[1-9][^}]*\}/;
const POS_RE = /\\(?:pos|move)\s*\(/i;
const AN_RE = /\{[^}]*?\\an([1-9])[^}]*\}/;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

function normalize(s) {
  const o = s || {};
  return {
    ms: clamp(Math.round(num(o.ms) / STEP_MS) * STEP_MS, -LIM_MS, LIM_MS),
    size: clamp(Math.round(num(o.size == null ? 100 : o.size)), LIM_SIZE[0], LIM_SIZE[1]),
    up: clamp(Math.round(num(o.up)), LIM_UP[0], LIM_UP[1])
  };
}
const isDefault = s => !s.ms && s.size === 100 && !s.up;

const p2 = n => String(n).padStart(2, '0');
const fracMs = f => Number(String(f).padEnd(3, '0').slice(0, 3));

// ---------- SRT ----------
const SRT_TIME_RE = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})(\s*-->\s*)(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
const srtMs = (h, m, s, f) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + fracMs(f);
function fmtSrt(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60, f = t % 1000;
  return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + String(f).padStart(3, '0');
}
function shiftSrt(text, ms) {
  return text.replace(SRT_TIME_RE, (all, h1, m1, s1, f1, arrow, h2, m2, s2, f2) =>
    fmtSrt(srtMs(h1, m1, s1, f1) + ms) + arrow + fmtSrt(srtMs(h2, m2, s2, f2) + ms));
}

// ---------- ASS ----------
const ASS_TIME_RE = /^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/;
function shiftAssTime(str, ms) {
  const m = ASS_TIME_RE.exec(String(str).trim());
  if (!m) return str;
  const total = Math.max(0, Math.round((srtMs(m[1], m[2], m[3], m[4]) + ms) / 10));
  const h = Math.floor(total / 360000), mi = Math.floor(total / 6000) % 60, se = Math.floor(total / 100) % 60, cs = total % 100;
  return h + ':' + p2(mi) + ':' + p2(se) + '.' + p2(cs);
}

const SECT_RE = /^\s*\[([^\]]+)\]\s*$/;
const FORMAT_RE = /^\s*Format\s*:(.*)$/i;
const STYLE_RE = /^(\s*Style\s*:\s*)(.*)$/i;
const EVENT_RE = /^(\s*(Dialogue|Comment)\s*:\s*)(.*)$/i;
const STD_EVENTS = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

function fieldIdx(fmt, name) { return fmt.indexOf(name); }
function splitEvent(body, n) {
  const parts = [];
  let rest = body;
  for (let k = 0; k < n - 1; k++) {
    const i = rest.indexOf(',');
    if (i < 0) return null;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

function applyAss(content, s) {
  const lines = content.split('\n');
  let sect = '', playResY = 0, stFmt = null, evFmt = null;
  const styles = new Map();
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].replace(/^\uFEFF/, '');
    const sm = L.match(SECT_RE);
    if (sm) { sect = sm[1].trim().toLowerCase(); continue; }
    if (sect === 'script info') {
      const pm = L.match(/^\s*PlayResY\s*:\s*([\d.]+)/i);
      if (pm && parseFloat(pm[1]) > 0) playResY = parseFloat(pm[1]);
    } else if (/^v4\+? styles$/.test(sect)) {
      const fm = L.match(FORMAT_RE);
      if (fm) { stFmt = fm[1].split(',').map(x => x.trim().toLowerCase()); continue; }
      const st = L.match(STYLE_RE);
      if (st && stFmt) {
        const vals = st[2].split(',');
        const nm = (vals[fieldIdx(stFmt, 'name')] || '').trim();
        styles.set(nm, { i, prefix: st[1], vals });
      }
    } else if (sect === 'events') {
      const fm = L.match(FORMAT_RE);
      if (fm) { evFmt = fm[1].split(',').map(x => x.trim().toLowerCase()); continue; }
      const ev = L.match(EVENT_RE);
      if (ev) events.push({ i, prefix: ev[1], kind: ev[2].toLowerCase(), body: ev[3] });
    }
  }
  const fmt = evFmt && evFmt.includes('start') && evFmt.includes('end') && evFmt.includes('text') ? evFmt : STD_EVENTS;
  const N = fmt.length;
  const iStart = fieldIdx(fmt, 'start'), iEnd = fieldIdx(fmt, 'end'), iStyle = fieldIdx(fmt, 'style');
  const iMV = fieldIdx(fmt, 'marginv'), iEff = fieldIdx(fmt, 'effect'), iText = fieldIdx(fmt, 'text');
  const findStyle = nm => {
    let sv = styles.get(nm);
    if (!sv) for (const [k, v] of styles) if (k.toLowerCase() === nm.toLowerCase()) { sv = v; break; }
    return sv || null;
  };
  const stI = n => (stFmt ? stFmt.indexOf(n) : -1);
  const iSize = stI('fontsize'), iOut = stI('outline'), iSh = stI('shadow'), iAl = stI('alignment'), iStMV = stI('marginv');

  const rows = events.map(e => ({ e, f: splitEvent(e.body, N) }));
  const isDialogue = r => r.f && r.e.kind === 'dialogue' && iStyle >= 0 && iText >= 0 &&
    !(iEff >= 0 && /fx/i.test(r.f[iEff] || '')) && !DRAWING_RE.test(r.f[iText]);

  // ----- الحجم: نفس منطق اختيار الستايل الرئيسي بالمصحح (أكثر مجموعة حجم أسطر) -----
  let scaled = null;
  if (s.size !== 100 && iSize >= 0) {
    const counts = new Map();
    let total = 0;
    for (const r of rows) {
      if (!isDialogue(r)) continue;
      const nm = (r.f[iStyle] || '').trim();
      counts.set(nm, (counts.get(nm) || 0) + 1);
      total++;
    }
    const groups = new Map();
    for (const [nm, n] of counts) {
      const sv = findStyle(nm);
      const sz = sv ? parseFloat(sv.vals[iSize]) : NaN;
      if (!(sz > 0)) continue;
      groups.set(sz, (groups.get(sz) || 0) + n);
    }
    let oldSize = 0, best = 0;
    for (const [sz, n] of groups) if (n > best) { best = n; oldSize = sz; }
    if (total && best / total >= MAIN_MIN_SHARE) {
      const k = s.size / 100;
      const done = new Set();
      scaled = [];
      for (const nm of counts.keys()) {
        const sv = findStyle(nm);
        if (!sv || done.has(sv.i) || parseFloat(sv.vals[iSize]) !== oldSize) continue;
        done.add(sv.i);
        const lead = x => x.match(/^\s*/)[0];
        const mul = (idx, dec) => {
          if (idx < 0 || idx >= sv.vals.length) return;
          const n = parseFloat(sv.vals[idx]);
          if (!isFinite(n)) return;
          const p = Math.pow(10, dec);
          sv.vals[idx] = lead(sv.vals[idx]) + String(Math.round(n * k * p) / p);
        };
        mul(iSize, 1); mul(iOut, 2); mul(iSh, 2);
        lines[sv.i] = sv.prefix + sv.vals.join(',');
        scaled.push(nm);
      }
    }
  }

  // ----- الارتفاع + التوقيت: تعديل حقول كل سطر -----
  const dyBase = s.up ? Math.round((playResY > 0 ? playResY : FALLBACK_PLAYRESY) * STEP_UP / 100) * s.up : 0;
  const maxMV = Math.round((playResY > 0 ? playResY : FALLBACK_PLAYRESY) * 0.6);
  for (const r of rows) {
    if (!r.f) continue;
    const f = r.f;
    let touched = false;
    if (s.ms) {
      if (iStart >= 0) f[iStart] = shiftAssTime(f[iStart], s.ms);
      if (iEnd >= 0) f[iEnd] = shiftAssTime(f[iEnd], s.ms);
      touched = true;
    }
    if (dyBase && iMV >= 0 && isDialogue(r) && !(iEff >= 0 && (f[iEff] || '').trim())) {
      const text = f[iText];
      const sv = findStyle((f[iStyle] || '').trim());
      if (sv && !POS_RE.test(text)) {
        const an = AN_RE.exec(text);
        const al = an ? parseInt(an[1], 10) : (iAl >= 0 ? parseInt(sv.vals[iAl], 10) : NaN);
        if (al >= 1 && al <= 3) {
          const own = parseFloat(f[iMV]);
          const base = own > 0 ? own : (iStMV >= 0 ? parseFloat(sv.vals[iStMV]) : 0);
          if (isFinite(base)) {
            const nv = clamp(Math.round(base + dyBase), 0, maxMV);
            const orig = String(f[iMV]).trim();
            f[iMV] = /^0\d+$/.test(orig) ? String(nv).padStart(orig.length, '0') : String(nv);
            touched = true;
          }
        }
      }
    }
    if (touched) lines[r.e.i] = r.e.prefix + f.join(',');
  }
  return lines.join('\n');
}

// ext: 'srt' أو 'ass'. إعدادات افتراضية = نفس النص حرفيا.
function apply(content, ext, settings) {
  const s = normalize(settings);
  const text = String(content == null ? '' : content);
  if (isDefault(s)) return content;
  if (ext === 'ass') return applyAss(text, s);
  if (ext === 'srt') return s.ms ? shiftSrt(text, s.ms) : content;
  return content;
}

module.exports = { apply, normalize, isDefault, STEP_MS, STEP_SIZE, STEP_UP, LIM_MS, LIM_SIZE, LIM_UP, shiftSrt, shiftAssTime };
