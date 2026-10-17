'use strict';
let nlp, genderDetect;
try {
  nlp = require('compromise');
  genderDetect = require('gender-detection');
} catch (e) {
  console.log('[تنبيه] مكتبات (compromise) أو (gender-detection) غير منصبة. تعمل الترجمة بدون التحليل المحلي.');
}
const MALE_VOCATIVES = [
  'sir', 'mister', 'dad', 'daddy', 'father', 'papa', 'son', 'brother', 'bro',
  'my lord', 'lord', 'king', 'prince', 'gentleman', 'young man', 'uncle',
  'grandpa', 'grandfather', 'husband', 'boy', 'man', 'dude', 'buddy', 'pal', 'mate'
];
const FEMALE_VOCATIVES = [
  "ma'am", 'madam', 'miss', 'mom', 'mommy', 'mama', 'mum', 'mother',
  'daughter', 'sister', 'sis', 'my lady', 'lady', 'queen', 'princess', 'aunt',
  'auntie', 'grandma', 'grandmother', 'young lady', 'wife', 'girl', 'woman'
];
const GROUP_VOCATIVES = [
  'ladies and gentlemen', 'boys and girls', 'gentlemen', 'ladies', 'guys',
  'everyone', 'everybody', 'folks', 'boys', 'girls', 'kids', 'children', 'brothers', 'sisters'
];
const MALE_TITLES = ['mr', 'mister', 'sir', 'lord', 'father', 'brother', 'king', 'prince', 'uncle', 'grandpa'];
const FEMALE_TITLES = ['mrs', 'ms', 'miss', 'madam', 'lady', 'dame', 'mother', 'sister', 'queen', 'princess', 'aunt', 'grandma'];
const MALE_ROLES = [
  'father', 'dad', 'daddy', 'papa', 'husband', 'brother', 'son', 'uncle', 'grandfather',
  'grandpa', 'boyfriend', 'king', 'prince', 'gentleman', 'man', 'boy', 'guy', 'widower', 'waiter', 'actor'
];
const FEMALE_ROLES = [
  'mother', 'mom', 'mommy', 'mama', 'wife', 'sister', 'daughter', 'aunt', 'grandmother',
  'grandma', 'girlfriend', 'queen', 'princess', 'lady', 'woman', 'girl', 'widow', 'waitress', 'actress', 'pregnant'
];
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = terms => [...terms].sort((a, b) => b.length - a.length)
  .map(t => esc(t).replace(/ /g, '\\s+')).join('|');
const BEFORE = '(?:^|[,.!?;:…"“(\\[—–]\\s*|\\b(?:hey|hi|hello|yes|no|yeah|yep|nope|thanks|thank you|please|sorry|excuse me|pardon me|okay|ok|well|oh|look|listen|good morning|good evening|good night|goodbye|bye|welcome|come on|sure)\\s*,?\\s+)';
const AFTER = '(?=\\s*(?:[,.!?…:;")\\]]|$))';
const RE_MALE_VOC = new RegExp(`${BEFORE}(${alt(MALE_VOCATIVES)})${AFTER}`, 'gi');
const RE_FEMALE_VOC = new RegExp(`${BEFORE}(${alt(FEMALE_VOCATIVES)})${AFTER}`, 'gi');
const RE_GROUP_VOC = new RegExp(`${BEFORE}(${alt(GROUP_VOCATIVES)})${AFTER}`, 'gi');
const NAME = "([a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*)?)";
const RE_MALE_TITLE = new RegExp(`${BEFORE}(${alt(MALE_TITLES)})\\.?\\s+${NAME}\\s*${AFTER}`, 'gi');
const RE_FEMALE_TITLE = new RegExp(`${BEFORE}(${alt(FEMALE_TITLES)})\\.?\\s+${NAME}\\s*${AFTER}`, 'gi');
const DET = '(?:(?:a|an|the|your|his|her|their|our)\\s+)?';
const ADJ = '(?:(?:very|really|proud|loving|real|new|old|poor|good|bad|single|young|just)\\s+)?';
const RE_SELF_NEG = /\bi(?:'m| am| was)\s+(?:not|no|never)\b/i;
const RE_SELF_MALE = new RegExp(`\\bi(?:'m| am| was)\\s+${DET}${ADJ}(?:${alt(MALE_ROLES)})\\b`, 'i');
const RE_SELF_FEMALE = new RegExp(`\\bi(?:'m| am| was)\\s+${DET}${ADJ}(?:${alt(FEMALE_ROLES)})\\b`, 'i');
const RE_AS_MALE = new RegExp(`\\bas\\s+${DET}(?:${alt(MALE_ROLES)})\\s*,\\s*i\\b`, 'i');
const RE_AS_FEMALE = new RegExp(`\\bas\\s+${DET}(?:${alt(FEMALE_ROLES)})\\s*,\\s*i\\b`, 'i');
const ROSTER_ROLE_EXCLUDE = new Set(['actor', 'waiter']);
const ROSTER_MALE_ROLES = MALE_ROLES.filter(r => !ROSTER_ROLE_EXCLUDE.has(r));
const ROSTER_FEMALE_ROLES = FEMALE_ROLES.filter(r => !ROSTER_ROLE_EXCLUDE.has(r));
const WB_L = '(?<![\\p{L}\\p{N}])';
const WB_R = '(?![\\p{L}\\p{N}])';
const RE_ROSTER_MALE_ROLE = new RegExp(`${WB_L}(?:${alt(ROSTER_MALE_ROLES)})${WB_R}`, 'iu');
const RE_ROSTER_FEMALE_ROLE = new RegExp(`${WB_L}(?:${alt(ROSTER_FEMALE_ROLES)})${WB_R}`, 'iu');
const ANNOTATION_MODEL = String(process.env.ANNOTATION_MODEL || '').trim();
const ANNOTATION_BUDGET_MS = 75000;
const ANNOTATION_SLICE_SIZE = 200;
const ANNOTATION_OVERLAP = 8;
const ANNOTATION_MAX_CONCURRENCY = 8;
const ANNOTATION_REQUEST_TIMEOUT_MS = 60000;
const ANNOTATION_ATTEMPTS = 3;
const ANNOTATION_TEMPERATURE = 0.1;
const SCENE_BREAK_SECONDS = 4;
const RESCUE_CONTEXT = 10;
const RESCUE_MAX_ASK = 80;
const RESCUE_MAX_SPAN = 250;
const ROSTER_ENABLED = process.env.ROSTER_PASS !== '0';
const ROSTER_VOTE_MIN = 2;
const ROSTER_ALT_MAX_GAP_SECONDS = 2.5;
const STRIP_SDH_ENABLED = process.env.STRIP_SDH !== '0';
const VERIFY_RUN_MIN = 6;
const VERIFY_MAX_REQUESTS = 6;
const VERIFY_CONTEXT = 10;
const REGISTRY_BUDGET_MS = 30000;
const REGISTRY_MAX_CHARS = 250000;
const REGISTRY_MAX_CHARACTERS = 60;
const ENGLISH_PRONOUNS = /\b(i|i'm|i've|i'll|i'd|me|my|myself|you|you're|you've|you'll|your|yours|yourself|we|us|our|he|she|him|her|his)\b/i;
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mister', 'dr', 'doctor', 'sir', 'lord', 'lady', 'madam', 'dame',
  'father', 'mother', 'brother', 'sister', 'king', 'queen', 'prince', 'princess', 'captain', 'officer', 'detective',
  'sr', 'sra', 'srta', 'senhor', 'senhora', 'señor', 'señora', 'monsieur', 'madame', 'mademoiselle', 'herr', 'frau',
  'signor', 'signora', 'don', 'dona', 'dom'
]);
const ALIAS_STOP = new Set(['may', 'will', 'can', 'you', 'the', 'and', 'but', 'mom', 'dad', 'man', 'boy', 'girl', 'guy', 'boss', 'baby']);
const ASS_GENERIC_ACTORS = new Set(['default', 'main', 'top', 'sign', 'signs', 'song', 'lyrics', 'text', 'title', 'ntp', 'comment', 'unknown', 'narrator', 'all', 'both', 'crowd']);
const INTERJECTIONS = 'hey|hi|hello|oh|ok|okay|look|listen|please|yes|no|well|come on|thanks|thank you|sorry|olá|oi|ei|ouça|escuta|olha|vamos|obrigado|obrigada|sim|não|hola|oye|mira|oiga|gracias|sí|salut|écoute|regarde|merci|oui|non|ciao|ehi|senti|guarda|grazie|sì|hallo|hör|sieh|danke|ja|nein';
const INTRO_PHRASES = "i'm|i am|my name is|eu sou|meu nome é|me chamo|soy|me llamo|mi nombre es|je suis|je m'appelle|sono|mi chiamo|ich bin|ich heiße|mein name ist";
const SDH_BRACKET_MAX = 60;
const SDH_PAREN_MAX = 40;
const RE_SDH_KEEP = /^\s*(?:sign|text|title|caption|note|letter|banner|poster|screen|display|on[\s-]?screen|subtitle|written|reads?)\b/i;
const RE_SDH_BRACKET = /\[([^\]\n]*)\]/g;
const RE_SDH_PAREN = /\(([^)\n]*)\)/g;
const RE_SDH_UPPER_LABEL = /^((?:[-–—]\s*)?)([A-Z][A-Z0-9 .'’-]{0,30}):\s+/;
const RE_HAS_CONTENT = /[\p{L}\p{N}]/u;
const SDH_LABEL_STOP = new Set(['YES', 'NO', 'OK', 'OKAY', 'STOP', 'WAIT', 'HELP', 'WARNING', 'NOTE', 'PLEASE', 'NOW', 'WHAT', 'WHY', 'NEVER']);
let annotationModelBroken = false;
const annotationCaches = new Map();
const MAX_ANNOTATION_CACHES = 40;
const registryCaches = new Map();
const MAX_REGISTRY_CACHES = 40;
const hydratedMaps = new WeakSet();
function splitTurns(rawText) {
  const lines = String(rawText || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .split(/\\N|\\n|\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [lines.join(' ')];
  const isDash = l => /^[-–—]/.test(l);
  const dashCount = lines.filter(isDash).length;
  if (dashCount === 0) return [lines.join(' ')];
  if (dashCount === 1 && isDash(lines[0])) return [lines.join(' ')];
  const turns = [];
  for (const l of lines) {
    if (isDash(l) || turns.length === 0) turns.push(l);
    else turns[turns.length - 1] += ' ' + l;
  }
  return turns;
}
function normalizeForRules(raw) {
  return String(raw || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—]+/, '')
    .trim();
}
function cleanForAnalysis(t) {
  return String(t || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripSdhTurn(turn) {
  let t = String(turn || '');
  let changed = false;
  const drop = (re, max) => {
    t = t.replace(re, (m, inner) => {
      if (inner.length > max || RE_SDH_KEEP.test(inner)) return m;
      changed = true;
      return ' ';
    });
  };
  drop(RE_SDH_BRACKET, SDH_BRACKET_MAX);
  drop(RE_SDH_PAREN, SDH_PAREN_MAX);
  t = t.replace(/\s+/g, ' ').trim();
  const lm = RE_SDH_UPPER_LABEL.exec(t);
  if (lm) {
    const label = lm[2].trim();
    if (label.split(/\s+/).length <= 3 && /[A-Z]{2}/.test(label) && !SDH_LABEL_STOP.has(label)) {
      t = (lm[1] + t.slice(lm[0].length)).trim();
      changed = true;
    }
  }
  if (!changed) return { text: t, changed: false, empty: false };
  t = t
    .replace(/^([-–—]\s*)?[:;]\s*/, '$1')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const empty = !RE_HAS_CONTENT.test(t);
  return { text: empty ? '' : t, changed: true, empty };
}
function splitLabelLines(rawText) {
  const lines = String(rawText || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .split(/\\N|\\n|\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const labelled = lines.filter(l => /^[-–—]?\s*[\[(]/.test(l)).length;
  return labelled >= 2 ? lines : null;
}
function stripSdhCue(rawText, g) {
  const baseTurns = splitTurns(rawText);
  const labelLines = baseTurns.length === 1 ? splitLabelLines(rawText) : null;
  const turns = labelLines || baseTurns;
  const segs = g ? String(g).split('/') : null;
  const segOk = !labelLines && !!segs && segs.length === turns.length && segs.every(s => /^[MFGUN]{2}$/.test(s));
  const keptTurns = [];
  const keptSegs = [];
  let changed = false;
  turns.forEach((t, i) => {
    const r = stripSdhTurn(t);
    if (r.changed) changed = true;
    if (!r.empty) {
      keptTurns.push(r.text);
      if (segOk) keptSegs.push(segs[i]);
    }
  });
  if (!changed) return { changed: false, removed: false, turns: null, g };
  if (keptTurns.length === 0) return { changed: true, removed: true, turns: [], g: null };
  if (keptTurns.length === 1) keptTurns[0] = keptTurns[0].replace(/^[-–—]\s*/, '');
  let nextG = null;
  if (segOk) nextG = keptSegs.join('/');
  else if (g && (labelLines ? keptTurns.length === labelLines.length : keptTurns.length === turns.length)) nextG = g;
  return { changed: true, removed: false, turns: keptTurns, g: nextG };
}
function applySdhStrip(cues, toDo) {
  const removedIds = [];
  const keep = [];
  let changed = 0;
  for (const it of toDo) {
    const cue = cues[it.id];
    const raw = cue ? cue.text : it.text;
    const r = stripSdhCue(raw, it.g);
    if (!r.changed) {
      keep.push(it);
      continue;
    }
    changed++;
    if (r.removed) {
      removedIds.push(it.id);
      if (cue) cue.text = '';
      continue;
    }
    const lead = (String(raw).match(/^(?:\{[^}]*\})+/) || [''])[0];
    const sepCue = /\\N/.test(String(raw)) ? '\\N' : '\n';
    const itText = String(it.text || '');
    const sepIt = /\\N/.test(itText) ? '\\N' : (/\n/.test(itText) || r.turns.length > 1 ? '\n' : ' ');
    if (cue) cue.text = lead + r.turns.join(sepCue);
    it.text = r.turns.join(sepIt);
    if (r.g) it.g = r.g; else delete it.g;
    keep.push(it);
  }
  toDo.length = 0;
  for (const it of keep) toDo.push(it);
  return { changed, removedIds };
}
function collect(re, clean, genderOfMatch, out, requireCapitalName) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++;
    if (requireCapitalName && !/^[A-Z]/.test(m[2] || '')) continue;
    out.add(genderOfMatch);
  }
}
function findVocativeGender(clean) {
  const found = new Set();
  collect(RE_MALE_VOC, clean, 'M', found, false);
  collect(RE_FEMALE_VOC, clean, 'F', found, false);
  collect(RE_GROUP_VOC, clean, 'G', found, false);
  collect(RE_MALE_TITLE, clean, 'M', found, true);
  collect(RE_FEMALE_TITLE, clean, 'F', found, true);
  if (found.size === 0) return null;
  if (found.size === 1) return [...found][0];
  return 'G';
}
function findSelfGender(clean) {
  if (RE_SELF_NEG.test(clean)) return null;
  const male = RE_SELF_MALE.test(clean) || RE_AS_MALE.test(clean);
  const female = RE_SELF_FEMALE.test(clean) || RE_AS_FEMALE.test(clean);
  if (male && !female) return 'M';
  if (female && !male) return 'F';
  return null;
}
function extractRuleEvidenceForCue(rawText) {
  const turns = splitTurns(rawText);
  let any = false;
  const ev = turns.map(t => {
    const clean = normalizeForRules(t);
    const e = {};
    if (!clean) return e;
    const s = findSelfGender(clean);
    const a = findVocativeGender(clean);
    if (s) { e.s = s; e.sT = 'cast'; any = true; }
    if (a) { e.a = a; e.aT = 'cast'; any = true; }
    return e;
  });
  return any ? ev : null;
}
function applyVocativeRules(rawText, existingG) {
  const turns = splitTurns(rawText);
  const segs = existingG ? String(existingG).split('/') : [];
  let changed = false;
  const out = turns.map((t, i) => {
    const base = (segs[i] && /^[MFGUN]{2}$/.test(segs[i])) ? segs[i] : 'UU';
    const clean = normalizeForRules(t);
    if (!clean) return base;
    const speaker = findSelfGender(clean);
    const addressee = findVocativeGender(clean);
    const next = (speaker || base[0]) + (addressee || base[1]);
    if (next !== base) changed = true;
    return next;
  });
  return changed ? out.join('/') : null;
}
function isVocativeName(text, name) {
  const n = esc(name).replace(/\s+/g, '\\s+');
  const start = new RegExp(`^\\W*(?:(?:hey|oh|ok|okay|look|listen|please|yes|no|well|come on)\\s*,?\\s+)?${n}\\s*[,!?:]`, 'i');
  const end = new RegExp(`,\\s*${n}\\s*[.!?…"]*\\s*$`, 'i');
  return start.test(String(text || '')) || end.test(String(text || ''));
}
function assTimeToSec(t) {
  const m = String(t || '').match(/(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseFloat('0.' + m[4]);
}
function fmtClock(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function normName(s) {
  return String(s || '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}
function startsCapital(s) {
  const c = String(s || '')[0] || '';
  return c !== c.toLowerCase() || (c === c.toUpperCase() && c === c.toLowerCase());
}
function roleGenderOfName(name) {
  const n = String(name || '');
  if (!n) return null;
  const m = RE_ROSTER_MALE_ROLE.test(n);
  const f = RE_ROSTER_FEMALE_ROLE.test(n);
  if (m && !f) return 'M';
  if (f && !m) return 'F';
  return null;
}
function getAnnotationCache(key) {
  if (!annotationCaches.has(key)) {
    annotationCaches.set(key, new Map());
    if (annotationCaches.size > MAX_ANNOTATION_CACHES) annotationCaches.delete(annotationCaches.keys().next().value);
  }
  return annotationCaches.get(key);
}
async function loadAnnotationCache(key, db) {
  const cache = getAnnotationCache(key);
  if (!hydratedMaps.has(cache) && db) {
    hydratedMaps.add(cache);
    const stored = await db.loadMap('annot', key);
    let restored = 0;
    for (const [id, code] of stored) {
      if (!cache.has(id)) { cache.set(id, code); restored++; }
    }
    if (restored > 0) console.log(`[MongoDB] استرجعت ${restored} كود تحليل ضمائر من التخزين الدائم.`);
  }
  return cache;
}
function buildAnnotationItems(cues, needsTranslation) {
  const items = [];
  const turnsById = new Map();
  let prevEnd = null;
  cues.forEach((c, i) => {
    const s = assTimeToSec(c.start);
    const e = assTimeToSec(c.end);
    if (needsTranslation(c.text)) {
      const turns = splitTurns(c.text);
      const text = turns.join(' ⏎ ');
      if (text.trim()) {
        const it = { id: i, t: fmtClock(s), text };
        if (prevEnd != null && s != null && s - prevEnd > SCENE_BREAK_SECONDS) it.b = 1;
        if (turns.length > 1) it.turns = turns.length;
        items.push(it);
        turnsById.set(i, turns.length);
      }
    }
    if (e != null) prevEnd = e;
  });
  return { items, turnsById };
}
function parseAnnotationCodes(raw) {
  const map = new Map();
  if (!raw) return map;
  const re = /(\d+)\s*[:=]\s*([MFGUN]{2}(?:\s*\/\s*[MFGUN]{2})*)(?![A-Za-z0-9])/gi;
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    map.set(Number(m[1]), m[2].toUpperCase().replace(/\s+/g, ''));
  }
  if (map.size > 0) return map;
  try {
    const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(clean);
    const arr = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([k, v]) => ({ id: k, code: v }));
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      const code = String(o.code ?? o.codes ?? o.g ?? '').toUpperCase().replace(/\s+/g, '');
      const id = Number(o.id);
      if (Number.isInteger(id) && /^[MFGUN]{2}(?:\/[MFGUN]{2})*$/.test(code)) map.set(id, code);
    }
  } catch (e) {}
  return map;
}
function normalizeCode(raw, turns) {
  if (!raw) return null;
  const segs = String(raw).toUpperCase().split('/').map(s => s.trim());
  if (segs.length !== (turns || 1)) return null;
  if (!segs.every(s => /^[MFGUN]{2}$/.test(s))) return null;
  return segs.join('/');
}
function mergeCodes(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const b = String(base).split('/');
  const e = String(extra).split('/');
  if (b.length !== e.length) return base;
  return b.map((seg, i) => {
    let out = '';
    for (let k = 0; k < 2; k++) {
      out += (seg[k] === 'U' && e[i][k] && e[i][k] !== 'U') ? e[i][k] : seg[k];
    }
    return out;
  }).join('/');
}
function makeCoreRanges(n, size) {
  const ranges = [];
  let start = 0;
  while (start < n) {
    let end = Math.min(n, start + size);
    if (n - end < Math.floor(size / 3)) end = n;
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}
function annotationConfig(model, baseModel, isGemini3Model) {
  const cfg = { temperature: ANNOTATION_TEMPERATURE, responseMimeType: 'application/json' };
  if (isGemini3Model(model)) cfg.thinkingConfig = { thinkingLevel: model === baseModel ? 'minimal' : 'low' };
  return cfg;
}
function buildAnnotationPrompt(windowItems, mode, castPromptBlock) {
  const scope = mode === 'verify'
    ? 'Answer ONLY for items with "ask":1. Every other item is read-only context. "p" is the code an earlier pass gave. That pass said that ALL the "ask" lines are spoken between two women (FF). This is unusual, so check it carefully: work out who the two sides of this conversation are (names, forms of address, the other lines of the scene), and remember that the two sides can be a woman and a man. Do not assume the earlier pass is right or wrong. Use U for a side you cannot justify.'
    : mode === 'rescue'
    ? 'Answer ONLY for items with "ask":1. Every other item is read-only context. "p" is the code an earlier, less careful pass gave (U = that side was not decided). "p" codes on context items are usually right: use them as evidence about who is in the conversation. For "ask" items, re-read the surrounding lines carefully before answering U.'
    : 'Items with "ctx":1 are read-only context from the neighbouring parts of the story: never answer for them. Answer for every other item.';
  return `You will receive consecutive subtitle lines from ONE film or episode, in story order, as a JSON array of objects {"id": <number>, "t": "<m:ss start time>", "text": "<subtitle text>"}.
Optional fields: "b":1 = a pause of several seconds before this line (often a new scene or a change of speakers); "turns": N = the text holds N speaker turns separated by "⏎"; "ctx":1 = read-only context; "p" = code from an earlier pass; "ask":1 = answer this item.
The subtitles can be in ANY language. Read the story first.
For each item you must answer, work out WHO IS SPEAKING and WHO IS BEING ADDRESSED, and output only their genders.
Codes: M = male, F = female, G = group or mixed, U = unknown, N = none (narration, on-screen text, sound effects, or the person talks to themselves or to the audience).
Answer with TWO letters per line: first the speaker's gender, then the addressee's gender. "FM" = a woman speaking to a man, "MG" = a man speaking to a group, "UU" = cannot tell.
If an item has "turns": N, give N codes separated by "/", one per turn in order (each turn usually starts with "-"), for example "FM/MF".
Evidence to use:
- names, titles and forms of address (sir, ma'am, mother, king, senhora, señor...), and who was just spoken to
- grammatical gender inside the line itself, in languages where adjectives and participles agree with the speaker or the listener (for example Portuguese "obrigada" = a woman is speaking, "obrigado" = a man; "cansada"/"cansado"; Spanish "estoy cansada"; French "je suis fatiguée"; Russian "я устала" / "я устал")
- "he said" / "she said", the alternation of replies in a conversation, and pauses
Use the whole conversation, not only the single line. If you are not reasonably sure about one side, answer U for that side. Do not guess randomly.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}
${scope}
Output ONLY a valid JSON array of strings, exactly one string per item you must answer, in the same order, each formatted "<id>:<codes>", for example ["12:UU","13:FM","14:MF/FM"]. No explanations.
Lines:
${JSON.stringify(windowItems)}`;
}
async function callAnnotationLLM({ prompt, keysArray, modelName, deadline, deps, timeout = ANNOTATION_REQUEST_TIMEOUT_MS, attempts = ANNOTATION_ATTEMPTS, stopOn429 = false }) {
  const baseModel = deps.normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  let model = (!annotationModelBroken && ANNOTATION_MODEL) ? deps.normalizeGeminiModelId(ANNOTATION_MODEL) : baseModel;
  const call = m => deps.callGeminiText({
    prompt, keysArray, modelName: m, generationConfig: annotationConfig(m, baseModel, deps.isGemini3Model),
    timeout, attempts, deadline, stopOn429
  });
  let res = await call(model);
  if (res.status === 'config_error' && model !== baseModel) {
    annotationModelBroken = true;
    console.log(`[تحليل الضمائر] موديل التحليل (${model}) غير صالح. أرجع لموديل الترجمة (${baseModel}) لباقي الطلبات.`);
    model = baseModel;
    res = await call(model);
  }
  return { res, model };
}
async function annotateWindow({ windowItems, mode, keysArray, modelName, deadline, label, castPromptBlock, deps, depth = 0, state = null }) {
  if (state && state.aborted) return new Map();
  const prompt = buildAnnotationPrompt(windowItems, mode, castPromptBlock);
  const t0 = Date.now();
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline, deps, stopOn429: !!state });
  if (res.status === 'rate_limited') {
    if (state) state.aborted = true;
    console.log(`[تحليل الضمائر] ${label}: 429 (حصة الموديل). أوقف باقي الطلبات الاختيارية.`);
    return new Map();
  }
  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${label}: فشل (${res.status}) بعد ${deps.secs(Date.now() - t0)}.`);
    return new Map();
  }
  const map = parseAnnotationCodes(res.text);
  console.log(`[تحليل الضمائر] ${label}: رجع ${map.size} كود من ${windowItems.length} سطر في ${deps.secs(Date.now() - t0)} (${model}).`);
  if (map.size === 0) {
    const head = String(res.text || '').replace(/\s+/g, ' ').slice(0, 100);
    const fin = res.finishReason || '-';
    const blk = res.blockReason || '-';
    console.log(`[تحليل الضمائر] ${label}: ما رجع أي كود (finish=${fin} block=${blk}) الرد: "${head}"`);
    const isAnswer = it => ((mode === 'rescue' || mode === 'verify') ? !!it.ask : !it.ctx);
    const answerable = windowItems.filter(isAnswer);
    if (depth < 1 && answerable.length >= 20 && deadline - Date.now() > 4000) {
      const half = Math.floor(answerable.length / 2);
      const keepA = new Set(answerable.slice(0, half).map(it => it.id));
      const keepB = new Set(answerable.slice(half).map(it => it.id));
      const demote = keep => windowItems.map(it => {
        if (!isAnswer(it) || keep.has(it.id)) return it;
        const o = { ...it };
        delete o.ask;
        o.ctx = 1;
        return o;
      });
      console.log(`[تحليل الضمائر] ${label}: أقسم الطلب لنصفين وأعيده.`);
      const common = { mode, keysArray, modelName, deadline, castPromptBlock, deps, depth: depth + 1, state };
      const [mA, mB] = await Promise.all([
        annotateWindow({ ...common, windowItems: demote(keepA), label: `${label} (نصف 1)` }),
        annotateWindow({ ...common, windowItems: demote(keepB), label: `${label} (نصف 2)` })
      ]);
      return new Map([...mA, ...mB]);
    }
  }
  return map;
}
function buildRosterPrompt(windowItems, castPromptBlock) {
  return `You will receive consecutive subtitle lines from ONE film or episode, in story order, as a JSON array of objects {"id": <number>, "t": "<m:ss start time>", "text": "<subtitle text>"}.
Optional fields: "b":1 = a pause of several seconds before this line (often a new scene or a change of speakers); "turns": N = the text holds N speaker turns separated by "⏎"; "ctx":1 = read-only context from the neighbouring parts of the story.
The subtitles can be in ANY language. Read the story first.
STEP 1 - PEOPLE: list every person who speaks or is spoken to in the lines that are not "ctx". For each person give "id" ("P1", "P2", ...), "name" (the name used in the subtitles or in the known characters list below; if the person is never named, a short description such as "woman in black" or "waiter"), and "gender" ("M", "F", or "U" only if the story really does not show it). A person has ONE gender, valid for every line. If a person is a known character from the list below, use that name and that gender.
STEP 2 - LINES: for every line that is not "ctx", say who speaks and who is addressed, using the person ids: "<id>:<speaker>><addressee>".
- Use "G" for a group or mixed audience, "N" for none (narration, on-screen text, sound effects, songs, or talking to oneself), and "?" when you cannot tell.
- If an item has "turns": N, give N pairs separated by "/", one per turn in order (each turn usually starts with "-"), for example "14:P1>P2/P2>P1".
Evidence to use: names, titles and forms of address, who was just spoken to, the alternation of replies (in a conversation between two people the speakers alternate and each one is the addressee of the other, and the two can be a woman and a man), pauses ("b":1), "he said" / "she said", and grammatical gender inside the line (for example Portuguese "obrigada" = a woman is speaking, "obrigado" = a man; Spanish "estoy cansada"; French "je suis fatiguée"; Russian "я устала"). Do not guess randomly: use "?" or "U" when unsure.
${castPromptBlock ? '\n' + castPromptBlock + '\n' : ''}
Output ONLY valid JSON: {"people":[{"id":"P1","name":"Harry","gender":"M"}],"lines":["12:P1>P2","13:P2>P1","14:N>N"]}
Lines:
${JSON.stringify(windowItems)}`;
}
function parseRosterResponse(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(clean); }
  catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { parsed = JSON.parse(clean.slice(a, b + 1)); } catch (e2) {} }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const people = new Map();
  for (const p of (Array.isArray(parsed.people) ? parsed.people : [])) {
    if (!p || p.id == null) continue;
    const id = String(p.id).trim().toUpperCase();
    let g = String(p.gender || 'U').trim().toUpperCase();
    if (g !== 'M' && g !== 'F') g = 'U';
    people.set(id, { id, name: String(p.name || '').trim().slice(0, 60), gender: g });
  }
  people.nameIndex = new Map([...people.values()].filter(p => p.name).map(p => [normName(p.name), p]));
  const lines = new Map();
  for (const s of (Array.isArray(parsed.lines) ? parsed.lines : [])) {
    const m = String(s).match(/^\s*(\d+)\s*[:=]\s*(.+?)\s*$/);
    if (m) lines.set(Number(m[1]), m[2]);
  }
  return { people, lines };
}
function lookupRegistry(name, index) {
  if (!index || !index.size) return null;
  const k = normName(name);
  if (!k) return null;
  let ent = index.map.get(k);
  if (ent) return ent;
  const noTitle = k.split(' ').filter(w => !HONORIFICS.has(w.replace(/\.$/, ''))).join(' ');
  ent = noTitle ? index.map.get(noTitle) : null;
  if (ent) return ent;
  const words = String(name).trim().split(/\s+/);
  if (!words.every(w => /^\p{Lu}/u.test(w))) return null;
  for (const w of noTitle.split(' ')) {
    if (w.length >= 3 && !ALIAS_STOP.has(w) && !HONORIFICS.has(w)) {
      const e = index.map.get(w);
      if (e) return e;
    }
  }
  return null;
}
function fixRosterGenders(people, index, stats) {
  if (!index || !index.size) return;
  for (const p of people.values()) {
    const ent = lookupRegistry(p.name, index);
    if (!ent) continue;
    if (ent.tier === 'cast') {
      if (p.gender !== ent.gender) {
        if (p.gender === 'U') stats.filled++; else stats.changed++;
        p.gender = ent.gender;
      }
    } else if (p.gender === 'U') {
      p.gender = ent.gender;
      stats.filled++;
    }
  }
}
function applyRoleGendersToRoster(people, stats) {
  for (const p of people.values()) {
    if (p.gender !== 'U') continue;
    const g = roleGenderOfName(p.name);
    if (g) {
      p.gender = g;
      stats.filled++;
    }
  }
}
function propagateEvidenceToRoster(parsed, evidence, stats) {
  if (!evidence || !evidence.size || !parsed || !parsed.people.size) return;
  const votes = new Map();
  const addVote = (pid, g, tier) => {
    if (!pid || !parsed.people.has(pid) || (g !== 'M' && g !== 'F')) return;
    if (!votes.has(pid)) votes.set(pid, { castM: 0, castF: 0, fileM: 0, fileF: 0 });
    const v = votes.get(pid);
    if (tier === 'cast') { if (g === 'M') v.castM++; else v.castF++; }
    else { if (g === 'M') v.fileM++; else v.fileF++; }
  };
  for (const [id, spec] of parsed.lines) {
    const ev = evidence.get(id);
    if (!ev) continue;
    const segs = String(spec).split('/');
    if (segs.length !== ev.length) continue;
    segs.forEach((seg, i) => {
      const parts = seg.split('>');
      if (parts.length !== 2) return;
      const sId = parts[0].trim().toUpperCase();
      const aId = parts[1].trim().toUpperCase();
      const e = ev[i] || {};
      if (e.s) addVote(sId, e.s, e.sT);
      if (e.a) addVote(aId, e.a, e.aT);
    });
  }
  for (const [pid, v] of votes) {
    const p = parsed.people.get(pid);
    if (!p) continue;
    if (v.castM !== v.castF) {
      const best = v.castM > v.castF ? 'M' : 'F';
      if (p.gender !== best) {
        if (p.gender === 'U') stats.filled++; else stats.changed++;
        p.gender = best;
      }
    } else if (p.gender === 'U' && v.fileM !== v.fileF) {
      p.gender = v.fileM > v.fileF ? 'M' : 'F';
      stats.filled++;
    }
  }
}
function rosterLetter(token, people) {
  const t = String(token || '').trim().toUpperCase();
  if (t === 'G') return 'G';
  if (t === 'N') return 'N';
  const p = people.get(t) || (people.nameIndex && people.nameIndex.get(normName(token)));
  return p ? p.gender : 'U';
}
function deriveRosterCode(spec, turns, people) {
  const segs = String(spec).split('/');
  if (segs.length !== (turns || 1)) return null;
  const out = [];
  for (const seg of segs) {
    const parts = seg.split('>');
    if (parts.length !== 2) return null;
    const s = parts[0].trim().toUpperCase();
    const a = parts[1].trim().toUpperCase();
    const sl = rosterLetter(s, people);
    let al = rosterLetter(a, people);
    if (s === a && people.has(s)) al = 'N';
    out.push(sl + al);
  }
  return out.join('/');
}
function normalizePersonToken(tok, people) {
  const t = String(tok || '').trim().toUpperCase();
  if (people.has(t)) return t;
  const byName = people.nameIndex && people.nameIndex.get(normName(tok));
  return byName ? byName.id : t;
}
function parseLinkSegs(spec, people) {
  return String(spec).split('/').map(seg => {
    const parts = seg.split('>');
    return { s: normalizePersonToken(parts[0], people), a: normalizePersonToken(parts[1], people) };
  });
}
async function annotateRosterWindow({ windowItems, keysArray, modelName, deadline, label, castPromptBlock, regIndex, evidence, turnsById, rosterStats, deps }) {
  const prompt = buildRosterPrompt(windowItems, castPromptBlock);
  const t0 = Date.now();
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline, deps });
  if (res.status !== 'ok') {
    console.log(`[تحليل الضمائر] ${label}: فشل (${res.status}) بعد ${deps.secs(Date.now() - t0)}.`);
    return null;
  }
  const parsed = parseRosterResponse(res.text);
  if (!parsed || parsed.lines.size === 0) {
    const head = String(res.text || '').replace(/\s+/g, ' ').slice(0, 100);
    const fin = res.finishReason || '-';
    const blk = res.blockReason || '-';
    console.log(`[تحليل الضمائر] ${label}: ما رجع جدول صالح (finish=${fin} block=${blk}) الرد: "${head}"`);
    return null;
  }
  fixRosterGenders(parsed.people, regIndex, rosterStats);
  applyRoleGendersToRoster(parsed.people, rosterStats);
  propagateEvidenceToRoster(parsed, evidence, rosterStats);
  const map = new Map();
  const links = new Map();
  for (const [id, spec] of parsed.lines) {
    const turns = turnsById.get(id);
    if (!turns) continue;
    const code = deriveRosterCode(spec, turns, parsed.people);
    if (code) {
      map.set(id, code);
      links.set(id, parseLinkSegs(spec, parsed.people));
    }
  }
  rosterStats.slices++;
  rosterStats.people += parsed.people.size;
  console.log(`[تحليل الضمائر] ${label}: ${parsed.people.size} شخص | ${map.size} كود من ${windowItems.length} سطر في ${deps.secs(Date.now() - t0)} (${model}).`);
  if (process.env.GENDER_DEBUG === '1') {
    console.log(`[مشهد] ${label}: ` + [...parsed.people.values()].slice(0, 40).map(p => {
      const pName = p.name || '?';
      return `${p.id}=${pName}(${p.gender})`;
    }).join(', '));
  }
  return { map, links, people: parsed.people };
}
const isFFcode = c => !!c && c.split('/').every(seg => seg === 'FF');
function findFFRuns(items, codeOf, minLen) {
  const runs = [];
  let cur = [];
  let ff = 0;
  const flush = () => {
    while (cur.length && !isFFcode(codeOf(cur[cur.length - 1].id))) cur.pop();
    if (ff >= minLen && cur.length) runs.push({ items: cur.slice(), ff });
    cur = [];
    ff = 0;
  };
  for (const it of items) {
    const c = codeOf(it.id);
    if (it.b === 1 && cur.length) flush();
    if (isFFcode(c)) { cur.push(it); ff++; }
    else if (c && /[MG]/.test(c)) flush();
    else if (cur.length) cur.push(it);
  }
  flush();
  return runs;
}
function parseCastEntries(castPromptBlock) {
  const out = [];
  for (const l of String(castPromptBlock || '').split('\n')) {
    const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
    if (m) out.push({ name: m[1].trim(), gender: m[2].toUpperCase(), tier: 'cast', aliases: [] });
  }
  return out;
}
function parseRegistry(raw) {
  if (!raw) return [];
  const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(clean); }
  catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { parsed = JSON.parse(clean.slice(a, b + 1)); } catch (e2) {} }
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.characters) ? parsed.characters : []);
  const out = [];
  for (const c of arr) {
    if (!c || typeof c.name !== 'string') continue;
    const g = String(c.gender || '').toUpperCase();
    if (g !== 'M' && g !== 'F') continue;
    const name = c.name.trim();
    if (name.length < 2 || name.length > 40) continue;
    const aliases = (Array.isArray(c.aliases) ? c.aliases : [])
      .filter(a => typeof a === 'string').map(a => a.trim()).filter(a => a.length >= 2 && a.length <= 40).slice(0, 8);
    out.push({ name, gender: g, aliases });
    if (out.length >= REGISTRY_MAX_CHARACTERS) break;
  }
  return out;
}
async function getCharacterRegistry(cues, keysArray, modelName, cacheKey, castPromptBlock, deps) {
  if (registryCaches.has(cacheKey)) return registryCaches.get(cacheKey);
  const stored = deps.db ? await deps.db.loadDoc('registry', cacheKey) : null;
  if (Array.isArray(stored) && stored.length > 0) {
    registryCaches.set(cacheKey, stored);
    if (registryCaches.size > MAX_REGISTRY_CACHES) registryCaches.delete(registryCaches.keys().next().value);
    console.log(`[سجل الشخصيات] ${stored.length} شخصية من التخزين الدائم.`);
    return stored;
  }
  const lines = [];
  for (const c of cues) {
    if (!deps.needsTranslation(c.text)) continue;
    const t = splitTurns(c.text).join(' ⏎ ').trim();
    if (t) lines.push(t);
  }
  if (lines.length < 20) return [];
  let body = lines.join('\n');
  if (body.length > REGISTRY_MAX_CHARS) body = body.slice(0, REGISTRY_MAX_CHARS);
  const prompt = `You will receive ALL the subtitle lines of one film or episode, in order (any language). A line may hold several speaker turns separated by "⏎".
Build a list of the CHARACTERS whose gender is clear from the story.
For each character give: "name" (the main name exactly as written in the subtitles), "aliases" (other names, nicknames, surnames or titles used to call or mention the same person, exactly as written in the subtitles), and "gender" ("M" or "F").
Rules:
- Include a character only if the story makes the gender clear (pronouns, titles, descriptions, forms of address, grammatical gender). Do not guess from the name alone.
- Only people or personified characters: no places, groups, brands or generic words.
- At most ${REGISTRY_MAX_CHARACTERS} characters, the most important first.
${castPromptBlock ? '\nA database list of known characters follows. Use it to match nicknames to known characters, and reuse the same name for them:\n' + castPromptBlock + '\n' : ''}
Output ONLY valid JSON: {"characters":[{"name":"...","aliases":["..."],"gender":"M"}]}
Subtitles:
${body}`;
  const t0 = Date.now();
  const deadline = Date.now() + REGISTRY_BUDGET_MS;
  const { res, model } = await callAnnotationLLM({ prompt, keysArray, modelName, deadline, deps, timeout: REGISTRY_BUDGET_MS, attempts: 2 });
  if (res.status !== 'ok') {
    console.log(`[سجل الشخصيات] فشل (${res.status}) بعد ${deps.secs(Date.now() - t0)}.`);
    return [];
  }
  const registry = parseRegistry(res.text);
  console.log(`[سجل الشخصيات] ${registry.length} شخصية من الملف كامل في ${deps.secs(Date.now() - t0)} (${model}).`);
  if (registry.length > 0) {
    registryCaches.set(cacheKey, registry);
    if (registryCaches.size > MAX_REGISTRY_CACHES) registryCaches.delete(registryCaches.keys().next().value);
    if (deps.db) deps.db.saveDoc('registry', cacheKey, registry);
  }
  return registry;
}
function buildRegistryIndex(castPromptBlock, registry) {
  const entries = parseCastEntries(castPromptBlock);
  const castByKey = new Map(entries.map(e => [normName(e.name), e]));
  let fileCount = 0;
  for (const r of (registry || [])) {
    const hit = castByKey.get(normName(r.name)) || (r.aliases || []).map(a => castByKey.get(normName(a))).find(Boolean);
    if (hit) {
      if (hit.gender === r.gender) hit.aliases.push(r.name, ...(r.aliases || []));
      continue;
    }
    entries.push({ name: r.name, gender: r.gender, tier: 'file', aliases: r.aliases || [] });
    fileCount++;
  }
  const votes = new Map();
  const add = (key, gender, tier) => {
    if (!key || key.length < 3) return;
    const cur = votes.get(key);
    if (!cur) { votes.set(key, { gender, tier }); return; }
    if (cur.gender !== gender) cur.ambiguous = true;
    else if (tier === 'cast') cur.tier = 'cast';
  };
  for (const e of entries) {
    for (const n of [e.name, ...e.aliases]) {
      const k = normName(n);
      add(k, e.gender, e.tier);
      const noTitle = k.split(' ').filter(w => !HONORIFICS.has(w.replace(/\.$/, ''))).join(' ');
      if (noTitle && noTitle !== k) add(noTitle, e.gender, e.tier);
      for (const w of noTitle.split(' ')) {
        if (w.length >= 3 && !ALIAS_STOP.has(w) && !HONORIFICS.has(w)) add(w, e.gender, e.tier);
      }
    }
  }
  const map = new Map();
  for (const [k, v] of votes) if (!v.ambiguous) map.set(k, v);
  const index = { map, size: map.size, entries, castCount: entries.length - fileCount, fileCount, startRe: null, endRe: null, introRe: null, labelRe: null };
  if (!map.size) return index;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const altKeys = keys.map(k => esc(k).replace(/ /g, '\\s+')).join('|');
  const L = '[^\\p{L}\\p{N}]';
  index.startRe = new RegExp(`^${L}*(?:(?:${INTERJECTIONS})\\s*,?\\s+)?(${altKeys})\\s*[,!]`, 'iu');
  index.endRe = new RegExp(`,\\s*(${altKeys})\\s*[.!?…"]*\\s*$`, 'iu');
  index.introRe = new RegExp(`(?<![\\p{L}\\p{N}'])(?:${INTRO_PHRASES})\\s+(${altKeys})(?=\\s*(?:[.,!?…]|$))`, 'iu');
  index.labelRe = new RegExp(`^${L}*(${altKeys})[\\]\\)]?\\s*:\\s`, 'iu');
  return index;
}
function registryPromptBlock(index) {
  if (!index) return '';
  const lines = index.entries
    .filter(e => e.tier === 'file')
    .slice(0, REGISTRY_MAX_CHARACTERS)
    .map(e => `${e.name}${e.aliases.length ? ' (also called: ' + e.aliases.slice(0, 4).join(', ') + ')' : ''} = ${e.gender}`);
  if (!lines.length) return '';
  return 'CHARACTERS INFERRED FROM THE WHOLE SUBTITLE FILE (M = male, F = female; inferred by reading the whole story, may contain mistakes; the context of the line overrides them):\n' + lines.join('\n');
}
function registryEvidenceForCue(rawText, index, actorName = '') {
  if (!index || !index.size) return null;
  const turns = splitTurns(rawText).map(t => String(t).replace(/[’‘`]/g, "'"));
  let any = false;
  const ev = turns.map(t => {
    const e = {};
    let hit = null;
    let m = index.startRe ? index.startRe.exec(t) : null;
    if (m) hit = m[1];
    else if (index.endRe) {
      m = index.endRe.exec(t);
      if (m && !/\b(?:it'?s|it is|this is|that'?s|i'?m|i am)\s+me\s*$/i.test(t.slice(0, m.index))) hit = m[1];
    }
    if (hit && startsCapital(hit)) {
      const ent = index.map.get(normName(hit));
      if (ent) { e.a = ent.gender; e.aT = ent.tier; any = true; }
    }
    const mi = (index.introRe && index.introRe.exec(t)) || (index.labelRe && index.labelRe.exec(t));
    if (mi && startsCapital(mi[1])) {
      const ent = index.map.get(normName(mi[1]));
      if (ent) { e.s = ent.gender; e.sT = ent.tier; any = true; }
    }
    return e;
  });
  if (turns.length === 1 && actorName) {
    const cleanActor = normName(actorName);
    if (cleanActor && cleanActor.length >= 2 && !ASS_GENERIC_ACTORS.has(cleanActor)) {
      const ent = lookupRegistry(actorName, index);
      if (ent && (!ev[0].s || (ent.tier === 'cast' && ev[0].sT !== 'cast'))) {
        ev[0].s = ent.gender;
        ev[0].sT = ent.tier;
        any = true;
      }
    }
  }
  return any ? ev : null;
}
function mergeTurnEvidence(a = {}, b = {}) {
  const out = { ...a };
  if (b.s && (!out.s || (b.sT === 'cast' && out.sT !== 'cast'))) {
    out.s = b.s;
    out.sT = b.sT;
  }
  if (b.a && (!out.a || (b.aT === 'cast' && out.aT !== 'cast'))) {
    out.a = b.a;
    out.aT = b.aT;
  }
  return out;
}
function applyEvidence(code, ev, stats) {
  const segs = String(code).split('/');
  if (!ev || segs.length !== ev.length) return code;
  const pin = (cur, val, tier) => {
    if (!val) return cur;
    if (tier === 'cast') {
      if (cur === val) return cur;
      if (cur === 'U' || cur === 'N') stats.filled++; else stats.overridden++;
      return val;
    }
    if (cur === 'U') { stats.filled++; return val; }
    return cur;
  };
  return segs.map((seg, i) => {
    const e = ev[i] || {};
    return pin(seg[0], e.s, e.sT) + pin(seg[1], e.a, e.aT);
  }).join('/');
}
function effCodeOf(id, coded, cache, heur) {
  const base = coded.get(id) || cache.get(id);
  if (!base) return null;
  const h = heur.get(id);
  return h ? mergeCodes(base, h) : base;
}
function setHeurCode(id, newCode, coded, cache, heur) {
  const cur = effCodeOf(id, coded, cache, heur);
  if (!cur || !newCode || newCode === cur) return false;
  const c = cur.split('/');
  const n = String(newCode).split('/');
  if (c.length !== n.length) return false;
  const out = c.map((seg, i) => {
    const sp = (seg[0] === 'U' && n[i][0] && n[i][0] !== 'U') ? n[i][0] : seg[0];
    const ad = (seg[1] === 'U' && n[i][1] && n[i][1] !== 'U') ? n[i][1] : seg[1];
    return sp + ad;
  }).join('/');
  if (out === cur) return false;
  heur.set(id, out);
  return true;
}
function isSplitPair(cues, cur, nxt) {
  if (nxt.b || cur.turns > 1 || nxt.turns > 1) return false;
  const gap = (assTimeToSec(cues[nxt.id].start) || 0) - (assTimeToSec(cues[cur.id].end) || 0);
  if (gap > 1.5) return false;
  const tA = cleanForAnalysis(cues[cur.id].text);
  const tB = cleanForAnalysis(cues[nxt.id].text);
  if (!tA || !tB || /^[-–—]/.test(tB)) return false;
  const continues = /^(?:\.\.\.|…|\p{Ll})/u.test(tB);
  if (/,\s*$/.test(tA)) return true;
  if (/(?:\.\.\.|…|—|--)\s*$/.test(tA)) return continues;
  if (!/[.!?…"”'\])]\s*$/.test(tA) && continues) return true;
  return false;
}
function unifySplitPairs(cues, items, eff, setH, linkOf) {
  let fixed = 0;
  const rosterConflict = (idA, idB) => {
    if (!linkOf) return false;
    const ra = linkOf(idA);
    const rb = linkOf(idB);
    if (!ra || !rb || ra.people !== rb.people || ra.l.length !== 1 || rb.l.length !== 1) return false;
    const x = ra.l[0];
    const y = rb.l[0];
    const diff = (p, q) => ra.people.has(p) && ra.people.has(q) && p !== q;
    return diff(x.s, y.s) || diff(x.a, y.a);
  };
  const unify = (cur, nxt) => {
    const cA = eff(cur.id);
    const cB = eff(nxt.id);
    if (!cA || !cB || cA.length !== 2 || cB.length !== 2) return;
    if (rosterConflict(cur.id, nxt.id)) return;
    if (cA[0] !== 'U' && cB[0] !== 'U' && cA[0] !== cB[0]) return;
    if (cA[1] !== 'U' && cB[1] !== 'U' && cA[1] !== cB[1]) return;
    const merged = (cA[0] !== 'U' ? cA[0] : cB[0]) + (cA[1] !== 'U' ? cA[1] : cB[1]);
    if (merged !== cA && cA.includes('U') && setH(cur.id, merged)) fixed++;
    if (merged !== cB && cB.includes('U') && setH(nxt.id, merged)) fixed++;
  };
  for (let i = 0; i < items.length - 1; i++) {
    if (isSplitPair(cues, items[i], items[i + 1])) unify(items[i], items[i + 1]);
  }
  for (let i = items.length - 2; i >= 0; i--) {
    if (isSplitPair(cues, items[i], items[i + 1])) unify(items[i], items[i + 1]);
  }
  return fixed;
}
function resolveRosterPeople(slices, coded, cache, eff, setH, stats) {
  for (const sl of slices) {
    const votes = new Map();
    const bump = (pid, letter, id) => {
      if (letter !== 'M' && letter !== 'F') return;
      const p = sl.people.get(pid);
      if (!p || p.gender !== 'U') return;
      if (!votes.has(pid)) votes.set(pid, { M: new Set(), F: new Set() });
      votes.get(pid)[letter].add(id);
    };
    for (const [id, segsArr] of sl.links) {
      const base = coded.get(id) || cache.get(id);
      if (!base) continue;
      const cs = base.split('/');
      if (cs.length !== segsArr.length) continue;
      segsArr.forEach((l, i) => {
        bump(l.s, cs[i][0], id);
        if (l.s !== l.a) bump(l.a, cs[i][1], id);
      });
    }
    const resolved = new Map();
    for (const [pid, v] of votes) {
      if (v.M.size && v.F.size) { stats.conflicts++; continue; }
      if (v.M.size >= ROSTER_VOTE_MIN) resolved.set(pid, 'M');
      else if (v.F.size >= ROSTER_VOTE_MIN) resolved.set(pid, 'F');
    }
    if (!resolved.size) continue;
    stats.people += resolved.size;
    for (const [pid, g] of resolved) sl.people.get(pid).gender = g;
    for (const [id, segsArr] of sl.links) {
      const cur = eff(id);
      if (!cur) continue;
      const cs = cur.split('/');
      if (cs.length !== segsArr.length) continue;
      let changed = false;
      const out = cs.map((seg, i) => {
        let s = seg[0];
        let a = seg[1];
        const l = segsArr[i];
        if (s === 'U' && resolved.has(l.s)) { s = resolved.get(l.s); changed = true; }
        if (a === 'U' && l.s !== l.a && resolved.has(l.a)) { a = resolved.get(l.a); changed = true; }
        return s + a;
      });
      if (changed && setH(id, out.join('/'))) stats.lines++;
    }
  }
}
function rosterAlternation(slices, items, posById, cues, eff, setH, stats) {
  const gapBetween = (idA, idB) => {
    const endA = assTimeToSec(cues[idA].end);
    const startB = assTimeToSec(cues[idB].start);
    if (endA == null || startB == null) return null;
    return startB - endA;
  };
  for (const sl of slices) {
    const ids = [...sl.links.keys()].sort((x, y) => posById.get(x) - posById.get(y));
    const scenes = [];
    let cur = [];
    let prevPos = -2;
    for (const id of ids) {
      const pos = posById.get(id);
      const brk = items[pos].b === 1 || pos !== prevPos + 1;
      if (cur.length && brk) { scenes.push(cur); cur = []; }
      cur.push(id);
      prevPos = pos;
    }
    if (cur.length) scenes.push(cur);
    for (const scene of scenes) {
      const persons = new Set();
      for (const id of scene) {
        for (const l of sl.links.get(id)) {
          if (sl.people.has(l.s)) persons.add(l.s);
          if (sl.people.has(l.a)) persons.add(l.a);
        }
      }
      if (persons.size !== 2) continue;
      const pair = [...persons];
      const otherOf = p => (p === pair[0] ? pair[1] : pair[0]);
      const unknownTok = tok => !sl.people.has(tok) && tok !== 'G' && tok !== 'N';
      const replyEvidence = (k, speakerWanted) => {
        const id = scene[k];
        for (const nk of [k - 1, k + 1]) {
          const nid = scene[nk];
          if (nid == null) continue;
          const nl = sl.links.get(nid);
          if (!nl || nl.length !== 1 || nl[0].s !== speakerWanted) continue;
          const gap = nk < k ? gapBetween(nid, id) : gapBetween(id, nid);
          if (gap != null && gap <= ROSTER_ALT_MAX_GAP_SECONDS) return true;
        }
        return false;
      };
      scene.forEach((id, k) => {
        const links = sl.links.get(id);
        if (!links || links.length !== 1) return;
        const l = links[0];
        const curCode = eff(id);
        if (!curCode || curCode.length !== 2) return;
        if (sl.people.has(l.s) && unknownTok(l.a) && curCode[1] === 'U') {
          const other = otherOf(l.s);
          const g = sl.people.get(other).gender;
          if ((g === 'M' || g === 'F') && replyEvidence(k, other) && setH(id, curCode[0] + g)) stats.lines++;
        } else if (sl.people.has(l.a) && unknownTok(l.s) && curCode[0] === 'U') {
          const other = otherOf(l.a);
          const g = sl.people.get(other).gender;
          if ((g === 'M' || g === 'F') && replyEvidence(k, l.a) && setH(id, g + curCode[1])) stats.lines++;
        }
      });
    }
  }
}
async function getAnnotations(cues, keysArray, modelName, cacheKey, deadline, castPromptBlock, evidence, regIndex, deps) {
  const cache = await loadAnnotationCache(cacheKey, deps.db);
  const tStart = Date.now();
  const { items, turnsById } = buildAnnotationItems(cues, deps.needsTranslation);
  const posById = new Map(items.map((it, i) => [it.id, i]));
  const pending = items.filter(it => !cache.has(it.id));
  const coded = new Map();
  const heur = new Map();
  const rosterSlices = [];
  const eff = id => effCodeOf(id, coded, cache, heur);
  const setH = (id, code) => setHeurCode(id, code, coded, cache, heur);
  const linkOf = id => {
    for (const sl of rosterSlices) {
      const l = sl.links.get(id);
      if (l) return { l, people: sl.people };
    }
    return null;
  };
  const defaultCode = id => Array(turnsById.get(id) || 1).fill('UU').join('/');
  const conc = Math.max(1, Math.min(deps.aliveKeyCount(keysArray), ANNOTATION_MAX_CONCURRENCY));
  const evStats = { overridden: 0, filled: 0 };
  const rosterStats = { changed: 0, filled: 0, people: 0, slices: 0, fallbacks: 0 };
  const peopleStats = { people: 0, lines: 0, conflicts: 0 };
  const altStats = { lines: 0 };
  let splitFixed = 0;
  const optState = { aborted: false };
  const applyAllEvidence = () => {
    for (const it of pending) {
      const ev = evidence.get(it.id);
      if (!ev) continue;
      const base = coded.get(it.id) || defaultCode(it.id);
      const next = applyEvidence(base, ev, evStats);
      if (next !== base) coded.set(it.id, next);
    }
  };
  const windowFor = (fromPos, toPos, askSet) => items.slice(fromPos, toPos).map(it => {
    const o = { ...it };
    const p = eff(it.id);
    if (p) o.p = p;
    if (askSet.has(it.id)) o.ask = 1; else o.ctx = 1;
    return o;
  });
  if (pending.length > 0) {
    const ranges = makeCoreRanges(items.length, ANNOTATION_SLICE_SIZE);
    const tasks = [];
    ranges.forEach(([a, b], ri) => {
      const core = items.slice(a, b);
      if (core.every(it => cache.has(it.id))) return;
      const from = Math.max(0, a - ANNOTATION_OVERLAP);
      const to = Math.min(items.length, b + ANNOTATION_OVERLAP);
      const windowItems = items.slice(from, to).map((it, k) => ((from + k < a || from + k >= b) ? { ...it, ctx: 1 } : it));
      tasks.push(async () => {
        const need = core.filter(it => !cache.has(it.id));
        const needSet = new Set(need.map(it => it.id));
        let rr = null;
        if (ROSTER_ENABLED) {
          rr = await annotateRosterWindow({
            windowItems, keysArray, modelName, deadline, castPromptBlock, regIndex, evidence, turnsById, rosterStats, deps,
            label: `جولة 1 (مشهد) شريحة ${ri + 1}/${ranges.length}`
          });
        }
        let map = rr ? rr.map : null;
        const covered = map ? need.filter(it => map.has(it.id)).length : 0;
        if (rr) {
          const links = new Map();
          for (const [id, l] of rr.links) if (needSet.has(id)) links.set(id, l);
          if (links.size > 0) rosterSlices.push({ people: rr.people, links });
        }
        if (!map || covered < need.length * 0.5) {
          rosterStats.fallbacks++;
          const lm = await annotateWindow({
            windowItems, mode: 'main', keysArray, modelName, deadline, castPromptBlock, deps,
            label: `جولة 1 (حروف) شريحة ${ri + 1}/${ranges.length}`
          });
          map = new Map([...lm, ...(map || [])]);
        }
        for (const it of core) {
          if (cache.has(it.id)) continue;
          const c = normalizeCode(map.get(it.id), turnsById.get(it.id));
          if (c) coded.set(it.id, c);
        }
      });
    });
    console.log(`[تحليل الضمائر] ${items.length} سطر بالتسلسل (من ${cues.length}) | ${tasks.length} طلب (تزامن ${Math.min(conc, tasks.length)}، مفاتيح حية ${deps.aliveKeyCount(keysArray)}).`);
    await deps.runConcurrentPool(tasks, conc);
    if (ROSTER_ENABLED) {
      console.log(`[مشهد] ${rosterStats.slices} شريحة بنظام الأشخاص | ${rosterStats.people} شخص | الكاست والأدلة والأدوار غيّرت جنس ${rosterStats.changed} شخص وملأت ${rosterStats.filled} | رجعت للحروف ${rosterStats.fallbacks} شريحة.`);
    }
  }
  applyAllEvidence();
  splitFixed += unifySplitPairs(cues, items, eff, setH, linkOf);
  const askList = pending.filter(it => {
    const c = eff(it.id);
    return !c || c.includes('U');
  });
  console.log(`[تحليل الضمائر] الجولة 1 انتهت: ${coded.size}/${pending.length} سطر رجع كود، و${askList.length} فيه U أو ناقص.`);
  if (askList.length > 0 && deadline - Date.now() > 4000) {
    const groups = [];
    let cur = [];
    for (const it of askList) {
      const pos = posById.get(it.id);
      if (cur.length && (cur.length >= RESCUE_MAX_ASK || pos - posById.get(cur[0].id) > RESCUE_MAX_SPAN)) {
        groups.push(cur);
        cur = [];
      }
      cur.push(it);
    }
    if (cur.length) groups.push(cur);
    const tasks = groups.map((group, gi) => async () => {
      if (optState.aborted) return;
      const first = posById.get(group[0].id);
      const last = posById.get(group[group.length - 1].id);
      const windowItems = windowFor(Math.max(0, first - RESCUE_CONTEXT), Math.min(items.length, last + 1 + RESCUE_CONTEXT), new Set(group.map(it => it.id)));
      const map = await annotateWindow({
        windowItems, mode: 'rescue', keysArray, modelName, deadline, castPromptBlock, deps, state: optState,
        label: `جولة 2 (إعادة U) نافذة ${gi + 1}/${groups.length} [${group.length} سطر]`
      });
      for (const it of group) {
        const nc = normalizeCode(map.get(it.id), turnsById.get(it.id));
        if (nc) coded.set(it.id, mergeCodes(coded.get(it.id) || defaultCode(it.id), nc));
      }
    });
    console.log(`[تحليل الضمائر] جولة 2: ${askList.length} سطر → ${groups.length} طلب بسياق ±${RESCUE_CONTEXT}.`);
    await deps.runConcurrentPool(tasks, conc);
  }
  applyAllEvidence();
  if (!optState.aborted && deadline - Date.now() > 6000) {
    const codeOf = id => coded.get(id) || cache.get(id);
    const jobs = [];
    for (const run of findFFRuns(items, codeOf, VERIFY_RUN_MIN)) {
      if (!run.items.some(it => !cache.has(it.id))) continue;
      for (let i = 0; i < run.items.length; i += 80) jobs.push({ items: run.items.slice(i, i + 80), ff: run.ff });
    }
    jobs.sort((x, y) => y.ff - x.ff);
    const picked = jobs.slice(0, VERIFY_MAX_REQUESTS);
    if (picked.length > 0) {
      console.log(`[تحليل الضمائر] رأي ثاني: ${picked.length} طلب لمشاهد فيها FF متتالية (امرأة مع امرأة).`);
      let changedLines = 0;
      const vtasks = picked.map((job, vi) => async () => {
        if (optState.aborted) return;
        const first = posById.get(job.items[0].id);
        const last = posById.get(job.items[job.items.length - 1].id);
        const windowItems = windowFor(Math.max(0, first - VERIFY_CONTEXT), Math.min(items.length, last + 1 + VERIFY_CONTEXT), new Set(job.items.map(it => it.id)));
        const map = await annotateWindow({
          windowItems, mode: 'verify', keysArray, modelName, deadline, castPromptBlock, deps, state: optState,
          label: `رأي ثاني مشهد ${vi + 1}/${picked.length} [${job.items.length} سطر]`
        });
        for (const it of job.items) {
          if (cache.has(it.id)) continue;
          const nc = normalizeCode(map.get(it.id), turnsById.get(it.id));
          if (!nc) continue;
          const old = coded.get(it.id) || defaultCode(it.id);
          const merged = mergeCodes(nc, old);
          if (merged !== old) { coded.set(it.id, merged); changedLines++; }
        }
      });
      await deps.runConcurrentPool(vtasks, Math.min(conc, 4));
      console.log(`[تحليل الضمائر] الرأي الثاني غيّر ${changedLines} سطر.`);
      applyAllEvidence();
    }
  }
  if (optState.aborted) {
    console.log('[تحليل الضمائر] وصلت حصة الموديل (429) فأوقفت باقي الطلبات الاختيارية لأحمي مفاتيح الترجمة.');
  }
  resolveRosterPeople(rosterSlices, coded, cache, eff, setH, peopleStats);
  rosterAlternation(rosterSlices, items, posById, cues, eff, setH, altStats);
  splitFixed += unifySplitPairs(cues, items, eff, setH, linkOf);
  console.log(`[أدلة] غيّرت ${evStats.overridden} حرف من قرار الـ AI (دليل مؤكد)، وملأت ${evStats.filled} حرف ناقص.`);
  console.log(`[استمرارية] جمل مقسومة: ${splitFixed} سطر | خريطة الأشخاص: ${peopleStats.people} شخص حُسم جنسه وملأ ${peopleStats.lines} سطر (تعارض ${peopleStats.conflicts}) | تناوب الروستر: ${altStats.lines} سطر | (لا تُحفظ بالتخزين الدائم).`);
  const fresh = [];
  for (const it of pending) {
    const code = coded.get(it.id);
    if (code) {
      cache.set(it.id, code);
      fresh.push([it.id, code]);
    }
  }
  if (fresh.length > 0 && deps.db) deps.db.saveMap('annot', cacheKey, fresh);
  const view = new Map();
  for (const it of items) {
    const c = eff(it.id);
    if (c) view.set(it.id, c);
  }
  const dist = new Map();
  let useful = 0;
  for (const it of pending) {
    const c = view.get(it.id);
    if (!c) continue;
    dist.set(c, (dist.get(c) || 0) + 1);
    if (/[MFG]/.test(c)) useful++;
  }
  const distStr = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
  const distOut = distStr || 'لا شيء';
  console.log(`[تحليل الضمائر] النتيجة: ${useful}/${pending.length} سطر فيه معلومة جنس | ${deps.secs(Date.now() - tStart)} | التوزيع: ${distOut}`);
  return view;
}
async function analyzeSubtitlesGender({ cues, toDo, keysArray, modelName, cacheKey, castPromptBlock = '', enableGender = true, deps }) {
  let enhancedCastPrompt = castPromptBlock || '';
  const localHints = new Map();
  let regIndex = null;
  if (enableGender && toDo.length > 0) {
    try {
      const registry = await getCharacterRegistry(cues, keysArray, modelName, cacheKey, castPromptBlock, deps);
      regIndex = buildRegistryIndex(castPromptBlock, registry);
      const block = registryPromptBlock(regIndex);
      if (block) enhancedCastPrompt += (enhancedCastPrompt ? '\n\n' : '') + block;
      console.log(`[سجل الشخصيات] الفهرس: ${regIndex.size} اسم/لقب (كاست ${regIndex.castCount} شخصية + ملف ${regIndex.fileCount}).`);
    } catch (e) {
      console.log(`[سجل الشخصيات] فشل (${e.message})، أكمل بدونه.`);
    }
  }
  if (enableGender && toDo.length > 0 && nlp && genderDetect) {
    const known = new Map();
    const lines = enhancedCastPrompt.split('\n');
    for (const l of lines) {
      const m = l.match(/^(.+?)\s*=\s*(M|F)$/i);
      if (m) known.set(m[1].trim().toLowerCase(), m[2].toUpperCase());
    }
    const dynamicNames = new Map();
    for (const it of toDo) {
      if (!ENGLISH_PRONOUNS.test(it.text)) continue;
      const doc = nlp(it.text);
      const people = doc.people().out('array');
      for (const p of people) {
        const cleanP = p.replace(/[^\w\s]/g, '').trim().toLowerCase();
        if (cleanP && cleanP.length > 2 && !known.has(cleanP) && !dynamicNames.has(cleanP)) {
          const first = cleanP.split(' ')[0];
          const g = genderDetect.detect(first);
          if (g === 'male') dynamicNames.set(cleanP, 'M');
          else if (g === 'female') dynamicNames.set(cleanP, 'F');
        }
      }
      let addresseeG = 'U', speakerG = 'U';
      if (people.length === 1) {
        const pName = people[0].replace(/[^\w\s]/g, '').trim().toLowerCase();
        const pGen = known.get(pName) || dynamicNames.get(pName);
        if (pGen) {
          if (isVocativeName(it.text, pName)) addresseeG = pGen;
          if (doc.match('(i am|im|my name is) #Person').found) speakerG = pGen;
        }
      }
      if (speakerG !== 'U' || addresseeG !== 'U') {
        localHints.set(it.id, speakerG + addresseeG);
      }
    }
    if (dynamicNames.size > 0) {
      enhancedCastPrompt += '\n\nGUESSED SIDE CHARACTERS (weak guesses from first names, may be wrong; the story context overrides them):\n' + [...dynamicNames.entries()].map(([k, v]) => `${k} = ${v}`).join('\n');
      console.log(`[تخمين الأسماء] تم تخمين جنس ${dynamicNames.size} أسماء جانبية وإضافتها كترجيح ضعيف لسياق الـ AI.`);
    }
    if (localHints.size > 0) {
      console.log(`[التحليل النحوي] ${localHints.size} سطر فيه دليل محلي (يُستخدم فقط لملء الحروف اللي ما حسمها الـ AI).`);
    }
  }
  const evidence = new Map();
  if (enableGender && toDo.length > 0) {
    let fromRegistry = 0, fromRules = 0;
    cues.forEach((c, i) => {
      if (!deps.needsTranslation(c.text)) return;
      const regEv = registryEvidenceForCue(c.text, regIndex, c.actor || '');
      const ruleEv = extractRuleEvidenceForCue(c.text);
      if (regEv) fromRegistry++;
      if (ruleEv) fromRules++;
      if (regEv || ruleEv) {
        const len = Math.max(regEv ? regEv.length : 0, ruleEv ? ruleEv.length : 0);
        const merged = [];
        for (let k = 0; k < len; k++) {
          merged.push(mergeTurnEvidence(regEv?.[k], ruleEv?.[k]));
        }
        evidence.set(i, merged);
      }
    });
    for (const [id, code] of localHints) {
      if (splitTurns(cues[id].text).length !== 1) continue;
      const ev = evidence.get(id) || [{}];
      const e = ev[0];
      if (!e.s && code[0] !== 'U') { e.s = code[0]; e.sT = 'file'; }
      if (!e.a && code[1] !== 'U') { e.a = code[1]; e.aT = 'file'; }
      evidence.set(id, ev);
    }
    if (evidence.size > 0) {
      console.log(`[أدلة] ${fromRegistry} سطر من السجل/ASS، و${fromRules} سطر من قواعد الألقاب، المجموع المدمج=${evidence.size} سطر.`);
    }
  }
  let annotationSummary = 'لم يُستخدم';
  if (toDo.length > 0) {
    if (!enableGender) {
      console.log('[الجندر] تحليل الضمائر موقوف (ENABLE_GENDER_ANALYSIS=false).');
      annotationSummary = 'موقوف';
    } else {
      console.log('[الجندر] أشغّل تحليل الضمائر...');
      try {
        const tA = Date.now();
        const deadline = Date.now() + ANNOTATION_BUDGET_MS;
        const annotations = await getAnnotations(cues, keysArray, modelName, cacheKey, deadline, enhancedCastPrompt, evidence, regIndex, deps);
        let attached = 0;
        for (const it of toDo) {
          const g = annotations.get(it.id);
          if (g && /[MFG]/.test(g)) { it.g = g; attached++; }
        }
        annotationSummary = `أُرفق بـ ${attached} من ${toDo.length} سطر (${deps.secs(Date.now() - tA)})`;
        console.log(`[تحليل الضمائر] أرفقت معلومة الجنس بـ ${attached} من ${toDo.length} سطر.`);
      } catch (e) {
        annotationSummary = `فشل (${e.message})`;
        console.log(`[تحليل الضمائر] فشل (${e.message})، أكمل الترجمة بدونه.`);
      }
    }
  }
  if (toDo.length > 0) {
    let ruleFixes = 0;
    for (const it of toDo) {
      const adj = applyVocativeRules(cues[it.id].text, it.g);
      if (adj && adj !== it.g) { it.g = adj; ruleFixes++; }
    }
    if (ruleFixes > 0) console.log(`[قواعد الألقاب] عدّلت أو أضفت معلومة الجنس لـ ${ruleFixes} سطر إضافي.`);
  }
  let sdhRemovedIds = [];
  if (STRIP_SDH_ENABLED && toDo.length > 0) {
    const r = applySdhStrip(cues, toDo);
    sdhRemovedIds = r.removedIds;
    if (r.changed > 0) console.log(`[SDH] عدّلت ${r.changed} سطر وحذفت ${r.removedIds.length} سطر كامل (وصف أصوات أو أسماء متحدثين).`);
  }
  return { enhancedCastPrompt, annotationSummary, regIndex, sdhRemovedIds };
}
function logGenderDebug({ cues, toDo, results, regIndex }) {
  const FIND = String(process.env.GENDER_FIND || '').trim();
  const DEBUG = process.env.GENDER_DEBUG === '1';
  const GOLD = process.env.GOLD_DUMP === '1';
  if ((!FIND && !DEBUG && !GOLD) || !toDo || toDo.length === 0) return;
  const flat2 = x => String(x == null ? '' : x).replace(/\{[^}]*\}|<[^>]*>/g, '').replace(/\\N|\\n|\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim().slice(0, 90);
  const flatFull = x => String(x == null ? '' : x).replace(/\{[^}]*\}|<[^>]*>/g, '').replace(/\\N|\\n|\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  if (GOLD) {
    const windows = Math.max(1, parseInt(process.env.GOLD_WINDOWS || '6', 10) || 6);
    const size = Math.max(10, parseInt(process.env.GOLD_WINDOW_SIZE || '50', 10) || 50);
    const n = toDo.length;
    const picked = [];
    if (n <= windows * size) {
      for (let k = 0; k < n; k++) picked.push(k);
    } else {
      const seen = new Set();
      for (let w = 0; w < windows; w++) {
        const start = windows === 1 ? 0 : Math.floor(w * (n - size) / (windows - 1));
        for (let k = start; k < start + size && k < n; k++) {
          if (!seen.has(k)) { seen.add(k); picked.push(k); }
        }
      }
    }
    console.log(`[GOLD] عدد الأسطر المختارة: ${picked.length}`);
    for (const k of picked) {
      const it = toDo[k];
      const cue = cues[it.id];
      console.log('[GOLD] ' + JSON.stringify({ id: it.id, en: flatFull(cue ? cue.text : it.text), g: it.g || '', ar: flatFull(results[it.id]) }));
    }
  }
  if (DEBUG && regIndex) {
    console.log(`[سجل] ${regIndex.entries.length} شخصية (كاست ${regIndex.castCount} + ملف ${regIndex.fileCount}):`);
    regIndex.entries.slice(0, 80).forEach(e => console.log(`[سجل] ${e.name} = ${e.gender} (${e.tier})${e.aliases.length ? ' | ' + e.aliases.slice(0, 5).join(', ') : ''}`));
  }
  if (FIND) {
    let re = null;
    try { re = new RegExp(FIND, 'iu'); } catch (e) { console.log(`[بحث] تعبير غير صالح: ${e.message}`); }
    if (re) {
      const byId = new Map(toDo.map(it => [it.id, it]));
      const hits = [];
      cues.forEach((c, i) => { if (byId.has(i) && (re.test(flat2(c.text)) || re.test(flat2(results[i])))) hits.push(i); });
      const MAX_HITS = 25;
      console.log(`[بحث] "${FIND}": ${hits.length} سطر مطابق${hits.length > MAX_HITS ? ` (أطبع أول ${MAX_HITS})` : ''}`);
      for (const i of hits.slice(0, MAX_HITS)) {
        console.log(`[بحث] ----- #${i}`);
        for (let j = Math.max(0, i - 2); j <= Math.min(cues.length - 1, i + 2); j++) {
          const it = byId.get(j);
          if (!it) continue;
          const gLabel = it.g || '--';
          console.log(`[بحث] ${j === i ? '>>' : '  '}#${j} [${gLabel}] ${flat2(cues[j].text)} => ${flat2(results[j])}`);
        }
      }
    }
  }
}
module.exports = {
  applyVocativeRules,
  extractRuleEvidenceForCue,
  findVocativeGender,
  findSelfGender,
  stripSdhCue,
  applySdhStrip,
  analyzeSubtitlesGender,
  logGenderDebug
};
