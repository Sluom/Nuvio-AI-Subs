'use strict';
const fs = require('fs');
function readGoldRows(logText) {
  const rows = [];
  const seen = new Set();
  for (const line of String(logText || '').split(/\r?\n/)) {
    const i = line.indexOf('[GOLD] {');
    if (i < 0) continue;
    try {
      const o = JSON.parse(line.slice(i + 7));
      if (o && Number.isInteger(o.id) && !seen.has(o.id)) {
        seen.add(o.id);
        rows.push({ id: o.id, en: o.en || '', g: o.g || '', ar: o.ar || '' });
      }
    } catch (e) {}
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}
function buildSheet(rows) {
  return rows.map(r => ({ id: r.id, en: r.en, g: r.g, ar: r.ar, truth: '', arOk: null }));
}
function compareCodes(truth, pred) {
  const t = String(truth || '').toUpperCase().replace(/\s+/g, '').split('/');
  const p = String(pred || '').toUpperCase().replace(/\s+/g, '').split('/');
  if (!String(pred || '').trim()) {
    return { wrong: 0, unknown: t.join('').replace(/[UN]/g, '').length, known: t.join('').replace(/[UN]/g, '').length, shape: false };
  }
  if (t.length !== p.length) return { wrong: 1, unknown: 0, known: 1, shape: true };
  let wrong = 0;
  let unknown = 0;
  let known = 0;
  for (let i = 0; i < t.length; i++) {
    for (let k = 0; k < 2; k++) {
      const tl = t[i][k];
      const pl = p[i][k];
      if (!tl || tl === 'U') continue;
      known++;
      if (pl === tl) continue;
      if (!pl || pl === 'U') unknown++;
      else wrong++;
    }
  }
  return { wrong, unknown, known, shape: false };
}
function scoreSheet(sheet) {
  const s = { labelled: 0, lineCorrect: 0, lineUnknown: 0, lineWrong: 0, letters: 0, lettersCorrect: 0, lettersWrong: 0, lettersUnknown: 0, arChecked: 0, arBad: 0, arBadAnnotationOk: 0, arBadAnnotationBad: 0, wrongIds: [], unknownIds: [], ignoredGIds: [] };
  for (const r of sheet) {
    if (!r || !String(r.truth || '').trim()) continue;
    s.labelled++;
    const c = compareCodes(r.truth, r.g);
    s.letters += c.known;
    s.lettersWrong += c.wrong;
    s.lettersUnknown += c.unknown;
    s.lettersCorrect += c.known - c.wrong - c.unknown;
    let annotationOk = false;
    if (c.wrong > 0) { s.lineWrong++; s.wrongIds.push(r.id); }
    else if (c.unknown > 0) { s.lineUnknown++; s.unknownIds.push(r.id); }
    else { s.lineCorrect++; annotationOk = true; }
    if (r.arOk === true || r.arOk === false) {
      s.arChecked++;
      if (r.arOk === false) {
        s.arBad++;
        if (annotationOk) { s.arBadAnnotationOk++; s.ignoredGIds.push(r.id); }
        else s.arBadAnnotationBad++;
      }
    }
  }
  return s;
}
function pct(a, b) {
  return b > 0 ? (100 * a / b).toFixed(1) + '%' : '-';
}
function printReport(s) {
  console.log(`أسطر مصنفة: ${s.labelled}`);
  console.log(`أسطر صحيحة بالكامل: ${s.lineCorrect} (${pct(s.lineCorrect, s.labelled)})`);
  console.log(`أسطر فيها U فقط بدون خطأ: ${s.lineUnknown} (${pct(s.lineUnknown, s.labelled)})`);
  console.log(`أسطر فيها حرف خاطئ: ${s.lineWrong} (${pct(s.lineWrong, s.labelled)})`);
  console.log(`على مستوى الحروف: صحيح ${s.lettersCorrect}/${s.letters} (${pct(s.lettersCorrect, s.letters)}) | خاطئ ${s.lettersWrong} | مجهول ${s.lettersUnknown}`);
  if (s.arChecked > 0) {
    console.log(`ترجمة عربية مفحوصة: ${s.arChecked} | خاطئة: ${s.arBad}`);
    console.log(`  منها التحليل صحيح لكن الترجمة تجاهلته: ${s.arBadAnnotationOk}`);
    console.log(`  منها سببها خطأ أو نقص بالتحليل: ${s.arBadAnnotationBad}`);
  }
  if (s.wrongIds.length) console.log(`ids فيها حرف خاطئ: ${s.wrongIds.slice(0, 60).join(',')}`);
  if (s.unknownIds.length) console.log(`ids فيها U: ${s.unknownIds.slice(0, 60).join(',')}`);
  if (s.ignoredGIds.length) console.log(`ids التحليل صحيح والترجمة تجاهلته: ${s.ignoredGIds.slice(0, 60).join(',')}`);
}
function main(argv) {
  const [cmd, a, b] = argv;
  if (cmd === 'sheet' && a && b) {
    const rows = readGoldRows(fs.readFileSync(a, 'utf8'));
    fs.writeFileSync(b, JSON.stringify(buildSheet(rows), null, 2), 'utf8');
    console.log(`كتبت ${rows.length} سطر إلى ${b}`);
    return;
  }
  if (cmd === 'score' && a) {
    printReport(scoreSheet(JSON.parse(fs.readFileSync(a, 'utf8'))));
    return;
  }
  console.log('node goldSet.js sheet <render.log> <sheet.json>');
  console.log('node goldSet.js score <sheet.json>');
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { readGoldRows, buildSheet, compareCodes, scoreSheet, printReport };
