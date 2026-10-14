// shield.js
// درع الترجمة: تنبيه قبل المشهد + حجب الشاشة أثناءه

const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// ===== إعدادات المظهر (عدّلها من هنا فقط) =====
const WARN_SEC = 10;                // مدة التنبيه المسبق بالثواني
const WARN_COLOR_HEX = '#FFD400';   // لون الرسالة: أصفر. برتقالي #FFA500 ، ماروني #800000
const WALL_COLS = 42;               // عدد المربعات في كل سطر من الجدار
const WALL_ROWS = 16;               // عدد أسطر الجدار

// تحويل HEX إلى صيغة ASS (ترتيب BGR)
function hexToAss(hex) {
  const h = String(hex).replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return ('&H' + b + g + r + '&').toUpperCase();
}
const WARN_ASS = hexToAss(WARN_COLOR_HEX);
const WALL_ROW = '█'.repeat(WALL_COLS);

// مشاهد تجريبية للفحص (تشتغل تلقائياً على أي فلم حالياً)
// لاحقاً نربطها بقاعدة البيانات أو الكشف التلقائي حسب targetId
const TEST_SCENES = [
  { start: 20, end: 45 },   // تجربة 1: التنبيه من 00:10 والتعتيم من 00:20 إلى 00:45
  { start: 300, end: 315 }  // تجربة 2: التنبيه من 04:50 والتعتيم من 05:00 إلى 05:15
];

function getScenesForMedia(targetId) {
  // حالياً نرجع المشاهد التجريبية للتأكد من عمل المشغل
  return TEST_SCENES;
}

function parseSubTimeSec(t) {
  if (!t) return 0;
  const clean = String(t).trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length !== 3) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseFloat(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return 0;
  return Math.max(0, (h * 3600) + (m * 60) + s);
}

function formatSrtTimeSec(sec) {
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function formatAssTimeSec(sec) {
  const totalCs = Math.max(0, Math.round((Number(sec) || 0) * 100));
  const hrs = Math.floor(totalCs / 360000);
  const mins = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  const pad = (n) => String(n).padStart(2, '0');
  return `${hrs}:${pad(mins)}:${pad(secs)}.${pad(cs)}`;
}

function normalizeScenes(rawScenes) {
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) return [];
  const valid = rawScenes
    .map(sc => ({ start: Number(sc.start), end: Number(sc.end) }))
    .filter(sc => Number.isFinite(sc.start) && Number.isFinite(sc.end) && sc.end > sc.start && sc.start >= 0)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const sc of valid) {
    if (!merged.length || sc.start > merged[merged.length - 1].end) {
      merged.push({ ...sc });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, sc.end);
    }
  }
  return merged;
}

function calcSceneMetrics(startSec, endSec) {
  const rawDuration = Math.max(1, endSec - startSec);
  const roundedDuration = Math.max(10, Math.ceil(rawDuration / 10) * 10);
  const presses = roundedDuration / 10;
  return { roundedDuration, presses };
}

function addAssRlm(text) {
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

// ===== نصوص الرسائل =====
const warnMsg = (d, p) => `⚠️ تنبيه: مشهد غير عائلي بعد قليل (مدته ${d} ثانية - قدّم ${p} مرات) ⚠️`;
const hideMsg = (d, p) => `⚠️ مشهد محجوب (${d} ثانية - قدّم ${p} مرات) ⚠️`;

// ===== SRT: رسالة ملونة في أعلى الشاشة (an8) =====
// نستخدم وسم ASS (للمشغلات التي تدعمه) مع وسم font (للمشغلات الأخرى)
function srtTopMsg(text) {
  return `{\\an8\\1c${WARN_ASS}\\3c&H000000&}<font color="${WARN_COLOR_HEX}">${text}</font>`;
}

// ===== SRT: جدار التعتيم في منتصف الشاشة (an5) =====
function srtWall() {
  const row = `<font color="#000000">${WALL_ROW}</font>`;
  return `{\\an5\\1c&H000000&\\3c&H000000&}` + Array.from({ length: WALL_ROWS }, () => row).join('\n');
}

function applyShieldToSrtItems(items, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return items;

  let current = items.slice();
  let prevEnd = 0;

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const { roundedDuration, presses } = calcSceneMetrics(start, end);

    // 1. قص أو حذف أي حوار يتداخل مع وقت التعتيم
    const kept = [];
    for (const it of current) {
      if (it.endSec <= start || it.startSec >= end) {
        kept.push(it);
        continue;
      }
      if (it.startSec < start) {
        kept.push({ startSec: it.startSec, endSec: start, text: it.text });
      }
      if (it.endSec > end) {
        kept.push({ startSec: end, endSec: it.endSec, text: it.text });
      }
    }

    // 2. التنبيه المسبق: سطر مستقل في أعلى الشاشة، لا يلمس الحوار ولا يغيّره
    const warnStart = Math.max(prevEnd, start - WARN_SEC);
    if (start - warnStart >= 1) {
      kept.push({ startSec: warnStart, endSec: start, text: srtTopMsg(warnMsg(roundedDuration, presses)) });
    }

    // 3. الجدار ثم رسالة الحجب بعده (لتُرسم فوقه إن أمكن)
    kept.push({ startSec: start, endSec: end, text: srtWall() });
    kept.push({ startSec: start, endSec: end, text: srtTopMsg(hideMsg(roundedDuration, presses)) });

    kept.sort((a, b) => a.startSec - b.startSec);
    current = kept;
    prevEnd = end;
  }

  return current;
}

// دالة جاهزة لبناء ملف SRT النهائي مع الدرع (تُستدعى من المصحح أو ترجمة AI أو الترجمات الجاهزة)
function buildShieldedSrt(cues, texts, targetId, drawingRe = null) {
  const rawItems = [];
  cues.forEach((c, idx) => {
    if (drawingRe && drawingRe.test(c.text)) return;
    const rawTxt = texts ? texts[idx] : c.text;
    const text = String(rawTxt || '').replace(/\\+[nN]/g, '\n').trim();
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    const startSec = parseSubTimeSec(c.start);
    const endSec = parseSubTimeSec(c.end);
    if (endSec > startSec) rawItems.push({ startSec, endSec, text });
  });

  const shielded = applyShieldToSrtItems(rawItems, targetId);
  let srtOutput = '';
  shielded.forEach((it, idx) => {
    srtOutput += `${idx + 1}\n${formatSrtTimeSec(it.startSec)} --> ${formatSrtTimeSec(it.endSec)}\n${it.text}\n\n`;
  });
  return srtOutput;
}

// ===== دوال ASS =====

// يرجع true لأي سطر حوار يتداخل (كلياً أو جزئياً) مع مشهد محجوب
function isCueInsideShield(startStr, endStr, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return false;
  const sSec = parseSubTimeSec(startStr);
  const eSec = parseSubTimeSec(endStr);
  return scenes.some(sc => sSec < sc.end && eSec > sc.start);
}

function buildAssShieldLines(targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return [];

  const topTag = `{\\an8\\1c${WARN_ASS}\\3c&H000000&\\bord3\\shad0}`;
  const wallTag = `{\\an5\\1c&H000000&\\3c&H000000&\\bord0\\shad0}`;
  const wall = wallTag + Array.from({ length: WALL_ROWS }, () => WALL_ROW).join('\\N');

  const extra = [];
  let prevEnd = 0;

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const { roundedDuration, presses } = calcSceneMetrics(start, end);
    const warnStart = Math.max(prevEnd, start - WARN_SEC);

    if (start - warnStart >= 1) {
      const warnLine = topTag + warnMsg(roundedDuration, presses);
      extra.push(`Dialogue: 99,${formatAssTimeSec(warnStart)},${formatAssTimeSec(start)},Default,,0,0,0,,${addAssRlm(warnLine)}`);
    }

    // الجدار في طبقة 98 والرسالة في طبقة 99 فتظهر الرسالة فوق الجدار
    extra.push(`Dialogue: 98,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${wall}`);
    const hideLine = topTag + hideMsg(roundedDuration, presses);
    extra.push(`Dialogue: 99,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${addAssRlm(hideLine)}`);

    prevEnd = end;
  }
  return extra;
}

module.exports = {
  buildShieldedSrt,
  isCueInsideShield,
  buildAssShieldLines
};
