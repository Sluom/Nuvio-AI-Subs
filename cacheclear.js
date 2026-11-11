'use strict';
// مسح ترجمة حلقة كاملة من الكاش: كل التراكات المصححة (SRT وASS، 1–4) تحت الاسمين (موسمي ومطلق)،
// وكاش أسطرها، ومن الذاكرة. الملف الأصلي المحفوظ (rawsrt) وقوائم التثبيت وقاموس الأسماء ما تنلمس.
const db = require('./db');
const { CORRECTOR_REV, TRACKS_TAG } = require('./corrector');
let notify = null;
try { notify = require('./notify'); } catch (e) { notify = null; }
let shared = null;
try { shared = require('./ai').shared; } catch (e) { shared = null; }

const LABELS = ['ARA-SRT', 'ARA-ASS'];
const MAX_TRACK = 4;
const LINE_VERSION = 'ARB2';
const STEP_TIMEOUT_MS = 8000;

const memDrops = [];
function onDrop(fn) { if (typeof fn === 'function') memDrops.push(fn); }

function withTimeout(p, ms) {
  let t;
  const timer = new Promise(resolve => { t = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([Promise.resolve(p).catch(() => undefined), timer]).finally(() => clearTimeout(t));
}

async function idsOf(targetId) {
  const ids = [String(targetId)];
  try {
    const ep = notify && notify.describeEpisode ? await withTimeout(notify.describeEpisode(targetId), 6000) : null;
    if (ep && ep.alt && ep.alt.id && !ids.includes(ep.alt.id)) ids.push(ep.alt.id);
  } catch (e) { /* لا شيء */ }
  return ids;
}

async function pinUrlsOf(id) {
  const out = [];
  try {
    const doc = await withTimeout(db.loadDoc('job', 'corr_pins_' + id + TRACKS_TAG), STEP_TIMEOUT_MS);
    for (const k of ['srt', 'ass']) {
      if (doc && Array.isArray(doc[k])) for (const it of doc[k]) if (it && it.url) out.push(String(it.url));
    }
  } catch (e) { /* لا شيء */ }
  return out;
}

const trackKey = (label, id, n) => [label, id, 'track' + n].join('_') + '_' + CORRECTOR_REV + TRACKS_TAG;
const lineKey = (id, url) => LINE_VERSION + '_' + CORRECTOR_REV + '_' + id + '|' + url;

async function clearEpisode(targetId) {
  const ids = await idsOf(targetId);
  const res = { ids, tracks: 0, lines: 0, failed: 0 };
  const jobs = [];
  for (const id of ids) {
    for (const label of LABELS) {
      for (let n = 1; n <= MAX_TRACK; n++) {
        const key = trackKey(label, id, n);
        for (const fn of memDrops) { try { fn(key); } catch (e) { /* لا شيء */ } }
        jobs.push(withTimeout(db.deleteDoc('job', key), STEP_TIMEOUT_MS).then(r => ({ kind: 'track', r })));
      }
    }
    const urls = [...new Set(await pinUrlsOf(id))];
    for (const url of urls) {
      const key = lineKey(id, url);
      try { if (shared && shared.getLineCache) shared.getLineCache(key).clear(); } catch (e) { /* لا شيء */ }
      jobs.push(withTimeout(db.deleteMap('line', key), STEP_TIMEOUT_MS).then(r => ({ kind: 'line', r })));
    }
  }
  const done = await Promise.all(jobs);
  for (const x of done) {
    if (typeof x.r !== 'number' || x.r < 0) res.failed++;
    else if (x.r > 0) res[x.kind === 'track' ? 'tracks' : 'lines'] += x.r;
  }
  return res;
}

async function clearTrack(targetId, ext, track, withLines) {
  const label = ext === 'ass' ? 'ARA-ASS' : 'ARA-SRT';
  const key = trackKey(label, targetId, track);
  for (const fn of memDrops) { try { fn(key); } catch (e) { /* لا شيء */ } }
  const res = { tracks: 0, lines: 0, failed: 0 };
  const d = await withTimeout(db.deleteDoc('job', key), STEP_TIMEOUT_MS);
  if (typeof d !== 'number' || d < 0) res.failed++; else res.tracks += d;
  if (withLines) {
    const doc = await withTimeout(db.loadDoc('job', 'corr_pins_' + targetId + TRACKS_TAG), STEP_TIMEOUT_MS);
    const it = doc && Array.isArray(doc[ext]) ? doc[ext][track - 1] : null;
    if (it && it.url) {
      const lk = lineKey(targetId, String(it.url));
      try { if (shared && shared.getLineCache) shared.getLineCache(lk).clear(); } catch (e) { /* لا شيء */ }
      const m = await withTimeout(db.deleteMap('line', lk), STEP_TIMEOUT_MS);
      if (typeof m !== 'number' || m < 0) res.failed++; else res.lines += m;
    }
  }
  return res;
}

module.exports = { clearEpisode, clearTrack, onDrop, idsOf };
