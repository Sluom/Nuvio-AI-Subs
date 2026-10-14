// shield.js
const RLM = '\u200F';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const LEAD_TAGS = /^(?:\{[^}]*\}|<[^>]*>|\s)*/;
const TAIL_TAGS = /(?:\{[^}]*\}|<[^>]*>|\s)*$/;

// مشاهد تجريبية للفحص (تشتغل تلقائياً على أي فلم حالياً)
// لاحقاً نربطها بقاعدة البيانات أو الكشف التلقائي حسب targetId
const TEST_SCENES = [
  { start: 20, end: 45 },   // تجربة 1: التنبيه بالثانية 00:10 والتعتيم من 00:20 إلى 00:45 (يحسبها 30 ثانية - 3 ضغطات)
  { start: 300, end: 315 }  // تجربة 2: التنبيه بالدقيقة 04:50 والتعتيم من 05:00 إلى 05:15 (يحسبها 20 ثانية - ضغطتين)
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

function applyShieldToSrtItems(items, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return items;

  let current = items.slice();

  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const warnStart = Math.max(0, start - 10);
    const { roundedDuration, presses } = calcSceneMetrics(start, end);

    const warnBanner = `<font color="#FFFF00">⚠️ تنبيه: مشهد غير عائلي بعد قليل (مدته ${roundedDuration} ثانية - قدّم ${presses} مرات) ⚠️</font>`;
    const wallRow = `<font color="#000000">██████████████████████████████</font>`;
    const blackoutText = `<font color="#FFFF00">⚠️ مشهد محجوب (${roundedDuration} ثانية - قدّم ${presses} مرات) ⚠️</font>\n` + Array.from({ length: 12 }, () => wallRow).join('\n');

    // 1. قص أو حذف أي ترجمة تتداخل مع وقت التعتيم الفعلي [start, end]
    const afterBlackout = [];
    for (const it of current) {
      if (it.endSec <= start || it.startSec >= end) {
        afterBlackout.push(it);
      } else {
        if (it.startSec < start) {
          afterBlackout.push({ startSec: it.startSec, endSec: start, text: it.text });
        }
        if (it.endSec > end) {
          afterBlackout.push({ startSec: end, endSec: it.endSec, text: it.text });
        }
      }
    }

    // 2. معالجة نافذة التنبيه المسبق [warnStart, start] مع الحفاظ على الحوارات وملء الفراغات
    const finalItems = [];
    const warnOverlaps = [];

    for (const it of afterBlackout) {
      if (it.endSec <= warnStart || it.startSec >= start) {
        finalItems.push(it);
      } else {
        if (it.startSec < warnStart) {
          finalItems.push({ startSec: it.startSec, endSec: warnStart, text: it.text });
        }
        const wS = Math.max(warnStart, it.startSec);
        const wE = Math.min(start, it.endSec);
        if (wE > wS) {
          warnOverlaps.push({ startSec: wS, endSec: wE, text: `${warnBanner}\n${it.text}` });
        }
        if (it.endSec > start) {
          finalItems.push({ startSec: start, endSec: it.endSec, text: it.text });
        }
      }
    }

    warnOverlaps.sort((a, b) => a.startSec - b.startSec);
    let cursor = warnStart;
    for (const ov of warnOverlaps) {
      if (ov.startSec - cursor >= 0.25) {
        finalItems.push({ startSec: cursor, endSec: ov.startSec, text: warnBanner });
      }
      finalItems.push(ov);
      cursor = Math.max(cursor, ov.endSec);
    }
    if (start - cursor >= 0.25) {
      finalItems.push({ startSec: cursor, endSec: start, text: warnBanner });
    }

    // 3. حقن جدار التعتيم الأسود
    finalItems.push({ startSec: start, endSec: end, text: blackoutText });
    finalItems.sort((a, b) => a.startSec - b.startSec);
    current = finalItems;
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

// دوال مساعدة لملفات ASS
function isCueInsideShield(startStr, endStr, targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return false;
  const sSec = parseSubTimeSec(startStr);
  const eSec = parseSubTimeSec(endStr);
  return scenes.some(sc => sSec >= sc.start && eSec <= sc.end);
}

function buildAssShieldLines(targetId, customScenes = null) {
  const scenes = normalizeScenes(customScenes || getScenesForMedia(targetId));
  if (!scenes.length) return [];
  const extra = [];
  for (const sc of scenes) {
    const start = sc.start;
    const end = sc.end;
    const warnStart = Math.max(0, start - 10);
    const { roundedDuration, presses } = calcSceneMetrics(start, end);

    const warnLine = `{\\an8\\1c&H00FFFF&\\3c&H000000&\\bord3}⚠️ تنبيه: مشهد غير عائلي بعد قليل (مدته ${roundedDuration} ثانية - قدّم ${presses} مرات) ⚠️`;
    const wallRow = `██████████████████████████████`;
    const blackoutBlock = `{\\an2\\1c&H00FFFF&}⚠️ مشهد محجوب (${roundedDuration} ثانية - قدّم ${presses} مرات) ⚠️\\N{\\1c&H000000&\\3c&H000000&}` + Array.from({ length: 12 }, () => wallRow).join('\\N');

    extra.push(`Dialogue: 99,${formatAssTimeSec(warnStart)},${formatAssTimeSec(start)},Default,,0,0,0,,${addAssRlm(warnLine)}`);
    extra.push(`Dialogue: 99,${formatAssTimeSec(start)},${formatAssTimeSec(end)},Default,,0,0,0,,${addAssRlm(blackoutBlock)}`);
  }
  return extra;
}

module.exports = {
  buildShieldedSrt,
  isCueInsideShield,
  buildAssShieldLines
};
