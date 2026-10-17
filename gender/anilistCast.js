'use strict';
const ANILIST_URL = 'https://graphql.anilist.co';
const KITSU_URL = 'https://kitsu.io/api/edge';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAGES = 4;
const MAX_LINES = 150;
const MAX_ALIASES = 4;
const MAX_MEM = 60;
const memCache = new Map();
const QUERY = `query ($id: Int, $idMal: Int, $search: String, $page: Int) {
  Media(id: $id, idMal: $idMal, search: $search, type: ANIME) {
    id
    characters(page: $page, perPage: 25, sort: [ROLE, RELEVANCE]) {
      pageInfo { hasNextPage }
      nodes { name { full alternative } gender }
    }
  }
}`;
function genderLetter(g) {
  const s = String(g || '').trim().toLowerCase();
  if (s === 'male') return 'M';
  if (s === 'female') return 'F';
  return null;
}
function cleanName(n) {
  const s = String(n || '').replace(/[\r\n=]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 40 ? s : '';
}
async function fetchJson(url, options, fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, status: 0, json: null };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await f(url, { ...options, signal: ctrl ? ctrl.signal : undefined });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { ok: !!res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function kitsuToMal(kitsuId, fetchImpl) {
  const url = `${KITSU_URL}/anime/${encodeURIComponent(kitsuId)}/mappings?${encodeURIComponent('filter[externalSite]')}=${encodeURIComponent('myanimelist/anime')}`;
  const r = await fetchJson(url, { headers: { Accept: 'application/vnd.api+json' } }, fetchImpl);
  if (!r.ok || !r.json || !Array.isArray(r.json.data) || !r.json.data.length) return null;
  const id = parseInt(r.json.data[0] && r.json.data[0].attributes && r.json.data[0].attributes.externalId, 10);
  return Number.isInteger(id) ? id : null;
}
async function fetchCharacters(variables, fetchImpl) {
  const nodes = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchJson(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { ...variables, page } })
    }, fetchImpl);
    if (r.status === 429) return { nodes, rateLimited: true };
    const chars = r.ok && r.json && r.json.data && r.json.data.Media && r.json.data.Media.characters;
    if (!chars) return { nodes, rateLimited: false };
    nodes.push(...(Array.isArray(chars.nodes) ? chars.nodes : []));
    if (!(chars.pageInfo && chars.pageInfo.hasNextPage)) break;
  }
  return { nodes, rateLimited: false };
}
function buildLines(nodes) {
  const byName = new Map();
  const blocked = new Set();
  const order = [];
  const put = (name, letter) => {
    const n = cleanName(name);
    if (!n) return;
    const k = n.toLowerCase();
    if (blocked.has(k)) return;
    const cur = byName.get(k);
    if (!cur) { byName.set(k, { name: n, letter }); order.push(k); return; }
    if (cur.letter !== letter) { byName.delete(k); blocked.add(k); }
  };
  for (const node of nodes) {
    if (!node || !node.name) continue;
    const letter = genderLetter(node.gender);
    if (!letter) continue;
    put(node.name.full, letter);
    const alts = (Array.isArray(node.name.alternative) ? node.name.alternative : []).slice(0, MAX_ALIASES);
    for (const a of alts) put(a, letter);
  }
  return order.filter(k => byName.has(k)).slice(0, MAX_LINES).map(k => `${byName.get(k).name} = ${byName.get(k).letter}`);
}
function remember(key, lines) {
  memCache.set(key, lines);
  if (memCache.size > MAX_MEM) memCache.delete(memCache.keys().next().value);
}
async function getAnimeCastBlock({ anilistId, malId, kitsuId, title, db, fetchImpl } = {}) {
  const key = [anilistId || '', malId || '', kitsuId || '', String(title || '').trim().toLowerCase()].join('|');
  if (!anilistId && !malId && !kitsuId && !String(title || '').trim()) return '';
  if (memCache.has(key)) return memCache.get(key).join('\n');
  if (db) {
    try {
      const stored = await db.loadDoc('anilist', key);
      if (Array.isArray(stored) && stored.length > 0) {
        remember(key, stored);
        return stored.join('\n');
      }
    } catch (e) {}
  }
  let variables = null;
  if (anilistId && Number.isInteger(Number(anilistId))) variables = { id: Number(anilistId) };
  else if (malId && Number.isInteger(Number(malId))) variables = { idMal: Number(malId) };
  else if (kitsuId) {
    const mal = await kitsuToMal(kitsuId, fetchImpl);
    if (mal) variables = { idMal: mal };
  }
  if (!variables && String(title || '').trim()) variables = { search: String(title).trim() };
  if (!variables) return '';
  const { nodes, rateLimited } = await fetchCharacters(variables, fetchImpl);
  if (rateLimited && nodes.length === 0) return '';
  const lines = buildLines(nodes);
  if (lines.length === 0) return '';
  remember(key, lines);
  if (db) {
    try { db.saveDoc('anilist', key, lines); } catch (e) {}
  }
  return lines.join('\n');
}
function mergeCastBlocks(...blocks) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    for (const l of String(b || '').split('\n')) {
      const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
      if (!m) continue;
      const k = m[1].trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(`${m[1].trim()} = ${m[2].toUpperCase()}`);
    }
  }
  return out.join('\n');
}
module.exports = { getAnimeCastBlock, mergeCastBlocks };
