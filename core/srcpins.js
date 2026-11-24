'use strict';
const db = require('./db');

const MAX_PINS_PER_SERIES = 8;
const FRESH_MS = 60 * 1000;
const READ_MS = 1500;

const mem = new Map();
const listeners = [];
let pending = Promise.resolve();

function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
function fire() { for (const f of listeners) { try { f(); } catch (e) { } } }

const imdbOf = id => { const m = /^(tt\d+)/.exec(String(id || '')); return m ? m[1] : ''; };
const kindOf = k => (k === 'a' || k === 'ass' ? 'ass' : (k === 's' || k === 'srt' ? 'srt' : ''));

function packOf(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  let path = '';
  try { path = new URL(u).pathname; } catch (e) { path = u.split('?')[0]; }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return '';
  let last = segs[segs.length - 1].toLowerCase();
  if (last === 'download' && segs.length > 1) last = segs[segs.length - 2];
  last = last.replace(/\.(zip|srt|ass|ssa|gz|rar|7z)$/i, '').slice(0, 40);
  return (last.length >= 4 && /\d/.test(last)) ? last : '';
}

const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const nameOfItem = x => String((x && (x.name || x.fileName || x.title || x.origName)) || '').trim();
const siteOfItem = x => String((x && (x._site || x._source)) || '').toLowerCase();

function matches(pin, item) {
  if (!pin || !item || !item.url) return false;
  const s = siteOfItem(item);
  if (pin.site && s && pin.site !== s) return false;
  if (pin.pack && packOf(item.url) === pin.pack) return true;
  const n = normName(nameOfItem(item));
  return !!(pin.name && n && n === normName(pin.name));
}

const sigOf = x => (x && x._sig && !/^wyzie:/.test(String(x._sig))) ? String(x._site) + '|' + String(x._sig) : '';

function applyPins(list, pins, kind) {
  const mine = (pins || []).filter(p => p && p.kind === kind && p.track >= 1).sort((a, b) => a.track - b.track);
  const none = { list, placed: [], missing: mine };
  if (!mine.length || !Array.isArray(list) || !list.length) return none;
  const locked = new Map();
  const lockedItems = new Set();
  const missing = [];
  const lockedBy = new Map();
  for (const p of mine) {
    const idx = p.track - 1;
    if (locked.has(idx)) { missing.push(p); continue; }
    const hit = list.find(x => x && !lockedItems.has(x) && matches(p, x));
    if (!hit) { missing.push(p); continue; }
    locked.set(idx, hit);
    lockedItems.add(hit);
    lockedBy.set(hit, p);
  }
  if (!locked.size) return { list, placed: [], missing };
  const lockedSigs = new Set([...lockedItems].map(sigOf).filter(Boolean));
  const rest = [];
  const dups = [];
  for (const x of list) {
    if (lockedItems.has(x)) continue;
    const sg = sigOf(x);
    (sg && lockedSigs.has(sg) ? dups : rest).push(x);
  }
  const maxIdx = Math.max(...locked.keys());
  const out = [];
  const fill = dups.slice();
  for (let i = 0; i <= maxIdx || rest.length; i++) {
    if (locked.has(i)) out.push(locked.get(i));
    else if (rest.length) out.push(rest.shift());
    else if (i < maxIdx && fill.length) out.push(fill.shift());
  }
  const final = [...out, ...fill];
  const placed = [...lockedItems].map(item => ({ pin: lockedBy.get(item), track: final.indexOf(item) + 1, item }));
  return { list: final, placed, missing };
}

const clean = v => {
  const arr = v && Array.isArray(v.pins) ? v.pins : [];
  return arr.filter(p => p && kindOf(p.kind) && Number.isInteger(p.track) && p.track >= 1 && p.track <= 4);
};

async function forSeries(id) {
  const imdb = imdbOf(id);
  if (!imdb) return [];
  const hit = mem.get(imdb);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.pins.slice();
  let timer;
  const r = await Promise.race([
    db.loadSrcPins(imdb),
    new Promise(res => { timer = setTimeout(() => res(null), READ_MS); })
  ]).catch(() => null).finally(() => clearTimeout(timer));
  if (r && r.ok) {
    const pins = clean(r.value);
    mem.set(imdb, { at: Date.now(), pins });
    return pins.slice();
  }
  return hit ? hit.pins.slice() : [];
}

function peek(id) {
  const hit = mem.get(imdbOf(id));
  return hit ? hit.pins.slice() : [];
}

function serialized(fn) {
  const run = pending.then(fn, fn);
  pending = run.catch(() => {});
  return run;
}

async function readFresh(imdb) {
  const r = await db.loadSrcPins(imdb);
  if (!r.ok) return null;
  return clean(r.value);
}

async function save(imdb, pins) {
  const ok = pins.length ? await db.saveSrcPins(imdb, { pins }) : await db.deleteSrcPins(imdb);
  if (!ok) return false;
  mem.set(imdb, { at: Date.now(), pins: pins.slice() });
  fire();
  return true;
}

async function add(id, pin) {
  const imdb = imdbOf(id);
  const kind = kindOf(pin && pin.kind);
  if (!imdb || !kind || !(pin.track >= 1 && pin.track <= 4)) return { ok: false, reason: 'bad' };
  return serialized(async () => {
    const cur = await readFresh(imdb);
    if (cur === null) return { ok: false, reason: 'db' };
    const old = cur.find(p => p.kind === kind && p.track === pin.track) || null;
    const next = cur.filter(p => !(p.kind === kind && p.track === pin.track));
    const rec = {
      kind, track: pin.track,
      site: String(pin.site || '').toLowerCase(),
      pack: String(pin.pack || ''),
      name: String(pin.name || '').slice(0, 200),
      title: String(pin.title || '').slice(0, 80),
      at: new Date().toISOString()
    };
    if (!rec.pack && !rec.name) return { ok: false, reason: 'noid' };
    next.push(rec);
    if (next.length > MAX_PINS_PER_SERIES) return { ok: false, reason: 'full' };
    next.sort((a, b) => (a.kind === b.kind ? a.track - b.track : (a.kind < b.kind ? -1 : 1)));
    const ok = await save(imdb, next);
    return ok ? { ok: true, replaced: old, pin: rec } : { ok: false, reason: 'db' };
  });
}

async function remove(id, k, track) {
  const imdb = imdbOf(id);
  const kind = kindOf(k);
  if (!imdb || !kind) return { ok: false, reason: 'bad' };
  return serialized(async () => {
    const cur = await readFresh(imdb);
    if (cur === null) return { ok: false, reason: 'db' };
    const gone = cur.find(p => p.kind === kind && p.track === track) || null;
    if (!gone) return { ok: true, removed: null };
    const ok = await save(imdb, cur.filter(p => p !== gone));
    return ok ? { ok: true, removed: gone } : { ok: false, reason: 'db' };
  });
}

async function listAll() {
  const r = await db.listSrcPins();
  if (!r.ok) return null;
  const rows = [];
  for (const row of r.rows) {
    const pins = clean(row.value);
    if (!pins.length) continue;
    mem.set(row.imdb, { at: Date.now(), pins });
    rows.push({ imdb: row.imdb, pins });
  }
  return rows;
}

function statusFor(id, k, track, item) {
  const kind = kindOf(k);
  const pin = peek(id).find(p => p.kind === kind && p.track === Number(track));
  if (!pin) return { state: 'none', pin: null };
  return { state: matches(pin, item) ? 'on' : 'missing', pin };
}

module.exports = { onChange, forSeries, peek, add, remove, listAll, statusFor, applyPins, matches, packOf, imdbOf, kindOf, MAX_PINS_PER_SERIES };
