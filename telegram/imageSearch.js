'use strict';
const axios = require('axios');

const SERP_UPLOAD_URL = 'https://serpapi.com/image';
const SERP_SEARCH_URL = 'https://serpapi.com/search.json';
const TRACE_URL = 'https://api.trace.moe/search';
const LENS_MAX_BYTES = 500 * 1024;
const LENS_UPLOAD_TIMEOUT_MS = 15000;
const LENS_SEARCH_TIMEOUT_MS = 25000;
const TRACE_TIMEOUT_MS = 25000;
const TRACE_MIN_SIM = 0.87;
const TRACE_MAX_HITS = 3;
const LENS_MAX_MATCHES = 12;
const LENS_MAX_RELATED = 6;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const scrubKey = (s, key) => (key ? String(s).split(key).join('***') : String(s));

async function lensSearch(buf, mime, key) {
  if (!key) return { skipped: 'nokey' };
  if (!buf || !buf.length) return { skipped: 'noimage' };
  if (buf.length > LENS_MAX_BYTES) return { skipped: 'toobig' };
  try {
    const fd = new FormData();
    fd.append('api_key', key);
    fd.append('image', new Blob([buf], { type: mime || 'image/jpeg' }), 'image.jpg');
    const up = await fetch(SERP_UPLOAD_URL, { method: 'POST', body: fd, signal: AbortSignal.timeout(LENS_UPLOAD_TIMEOUT_MS) });
    const upText = await up.text();
    let upJson = null;
    try { upJson = JSON.parse(upText); } catch (e) {}
    if (!up.ok || !upJson) return { err: 'upload HTTP ' + up.status + (upJson && upJson.error ? ' | ' + clip(upJson.error, 80) : '') };
    const imageId = upJson.image_id || upJson.id;
    if (!imageId) return { err: 'upload بدون image_id' };
    const r = await axios.get(SERP_SEARCH_URL, {
      params: { engine: 'google_lens', image_id: imageId, api_key: key, hl: 'en' },
      timeout: LENS_SEARCH_TIMEOUT_MS,
      validateStatus: () => true
    });
    const d = r.data || {};
    if (r.status !== 200 || d.error) return { err: 'search HTTP ' + r.status + (d.error ? ' | ' + clip(d.error, 80) : '') };
    const seen = new Set();
    const matches = [];
    for (const m of (Array.isArray(d.visual_matches) ? d.visual_matches : [])) {
      const title = clip(m && m.title, 120);
      if (!title) continue;
      const k = title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      matches.push({ title, source: clip(m.source, 40) });
      if (matches.length >= LENS_MAX_MATCHES) break;
    }
    const rawKg = Array.isArray(d.knowledge_graph) ? d.knowledge_graph : (d.knowledge_graph && typeof d.knowledge_graph === 'object' ? [d.knowledge_graph] : []);
    const kg = rawKg.map(x => clip(x && (x.title ? (x.subtitle ? x.title + ' (' + x.subtitle + ')' : x.title) : x.subtitle), 100)).filter(Boolean).slice(0, 3);
    const related = (Array.isArray(d.related_content) ? d.related_content : []).map(x => clip(x && x.query, 80)).filter(Boolean).slice(0, LENS_MAX_RELATED);
    return { matches, related, knowledge: kg };
  } catch (e) {
    return { err: scrubKey((e && e.name === 'TimeoutError') ? 'timeout' : (e && e.message) || 'خطأ', key) };
  }
}

async function traceMoe(buf, mime) {
  if (!buf || !buf.length) return { skipped: 'noimage' };
  try {
    const r = await axios.post(TRACE_URL + '?cutBorders&anilistInfo', buf, {
      headers: { 'Content-Type': mime || 'image/jpeg' },
      timeout: TRACE_TIMEOUT_MS,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });
    if (r.status === 402 || r.status === 429) return { err: 'الحصة خلصت (HTTP ' + r.status + ')' };
    const d = r.data || {};
    if (r.status !== 200 || d.error) return { err: 'HTTP ' + r.status + (d.error ? ' | ' + clip(d.error, 80) : '') };
    const list = Array.isArray(d.result) ? d.result : [];
    const hits = [];
    let best = 0;
    for (const x of list) {
      const sim = Number(x && x.similarity) || 0;
      if (sim > best) best = sim;
      if (sim < TRACE_MIN_SIM) continue;
      const a = x.anilist && typeof x.anilist === 'object' ? x.anilist : {};
      const t = a.title || {};
      const title = clip(t.english || t.romaji || t.native || '', 80);
      if (!title) continue;
      hits.push({ title, romaji: clip(t.romaji, 80), native: clip(t.native, 80), episode: x.episode == null ? '' : String(x.episode), similarity: sim, from: Number(x.from) || 0 });
      if (hits.length >= TRACE_MAX_HITS) break;
    }
    return { hits, best };
  } catch (e) {
    return { err: (e && e.code === 'ECONNABORTED') ? 'timeout' : clip((e && e.message) || 'خطأ', 80) };
  }
}

async function gather({ buf, mime, lensBuf, lensMime, serpKey }) {
  const [lens, trace] = await Promise.all([
    lensSearch(lensBuf || buf, lensMime || mime, serpKey).catch(e => ({ err: clip(e && e.message, 80) })),
    traceMoe(buf, mime).catch(e => ({ err: clip(e && e.message, 80) }))
  ]);
  return { lens, trace };
}

function evidenceLines({ lens, trace }) {
  const out = [];
  if (lens && lens.matches && lens.matches.length) {
    out.push('- Google Lens visual matches (page titles; may contain the movie/series title OR the actor/actress/character name):');
    lens.matches.forEach(m => out.push('  * ' + m.title + (m.source ? ' [' + m.source + ']' : '')));
  }
  if (lens && lens.knowledge && lens.knowledge.length) out.push('- Google Lens knowledge graph (actor or work): ' + lens.knowledge.join(' | '));
  if (lens && lens.related && lens.related.length) out.push('- Google Lens related searches: ' + lens.related.join(' | '));
  if (trace && trace.hits && trace.hits.length) {
    out.push('- trace.moe anime frame matches (frame-level image retrieval; similarity >= 0.92 is almost always correct):');
    trace.hits.forEach(h => out.push('  * ' + h.title + (h.episode ? ' episode ' + h.episode : '') + ' similarity ' + h.similarity.toFixed(2)));
  }
  return out;
}

function buildPrompt({ caption, lens, trace, maxCands, today }) {
  const ev = evidenceLines({ lens, trace });
  return [
    'You are the image-search engine of a movie / TV series / anime lookup bot. The attached image may be a screenshot, scene still, poster, or a photo/portrait of an actor or actress.',
    'Task: identify up to ' + maxCands + ' works (movies, TV series or anime) the user is looking for, best match first.',
    'Rules:',
    '- Use ALL clues together: faces/actors in the image, Google Lens matches (which often reveal the actor/actress name or character), trace.moe anime matches, visible text/subtitles, costumes, and the User note.',
    '- ACTOR + DESCRIPTION MATCHING: If the image shows an actor/actress (or Lens evidence names a person) rather than a specific movie poster, identify the actor first, then use Google Search and your knowledge to find which movies or TV series in that actor\'s filmography match the User note (country, language, genre, plot, role, era, or type). If there is no User note, return the specific work the photo is from, or that actor\'s most famous works.',
    '- Return REAL works only. Never invent a title. If unsure a work exists, leave it out or give low confidence.',
    '- "title" is the official English title as listed on IMDb (never your own translation). For non-English works use the English release title and put the original-language title in "original_title".',
    '- "year" is the first release year (integer) or null. "type" is "movie" or "series" (anime TV = "series", anime film = "movie").',
    '- "confidence" is an integer 0-100. Multiple clues agreeing (e.g. actor identified via Lens + matches user\'s country/plot note) means high confidence.',
    '- "why" is a brief explanation in Arabic (at most 12 words, mentioning the actor name or scene clue that matched).',
    '- Return vague=true and an empty list ONLY if you cannot identify any work AND cannot identify any actor/character from the image or evidence.',
    '- Always use Google Search, when available, to verify the actor\'s filmography and match it against the User note.',
    'Output ONLY JSON, no commentary: {"vague":false,"candidates":[{"title":"","original_title":"","year":2020,"type":"movie","confidence":90,"why":""}]}',
    'Today\'s date: ' + today,
    caption ? 'User note (crucial filter — may hold country, genre, era, plot, type, or dialogue): <<<' + caption + '>>>' : 'User note: none',
    ev.length ? 'Evidence collected from other engines:' : 'No evidence from other engines.',
    ...ev
  ].join('\n');
}

function traceCands(trace, cleanTitle) {
  const out = [];
  for (const h of ((trace && trace.hits) || [])) {
    const title = cleanTitle(h.title) || cleanTitle(h.romaji);
    if (!title) continue;
    const pct = Math.round(h.similarity * 100);
    out.push({
      title, original: cleanTitle(h.romaji) !== title ? cleanTitle(h.romaji) : '', year: 0, type: '',
      confidence: pct, why: 'تطابق أنمي ' + pct + '%' + (h.episode ? ' (حلقة ' + h.episode + ')' : ''), via: 'trace'
    });
  }
  return out;
}

function summary({ lens, trace }) {
  const L = lens && lens.matches ? lens.matches.length + ' نتيجة' : lens && lens.skipped === 'nokey' ? 'ما في مفتاح' : lens && lens.skipped === 'toobig' ? 'الصورة أكبر من 500KB' : lens && lens.err ? 'فشل' : '—';
  const T = trace && trace.hits && trace.hits.length ? Math.round(trace.hits[0].similarity * 100) + '%' : trace && trace.err ? 'فشل' : trace && trace.best ? 'ضعيف ' + Math.round(trace.best * 100) + '%' : '—';
  return { L, T };
}

module.exports = {
  gather, buildPrompt, traceCands, summary, lensSearch, traceMoe,
  LENS_MAX_BYTES, TRACE_MIN_SIM
};
