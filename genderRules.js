'use strict';

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

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function splitTurnsLocal(rawText) {
  const lines = String(rawText || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .split(/\\N|\\n|\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [lines.join(' ')];
  const isDash = l => /^[-–—]/.test(l);
  const dashCount = lines.filter(isDash).length;
  if (dashCount === 0 || (dashCount === 1 && isDash(lines[0]))) return [lines.join(' ')];
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

// استخراج الأدلة المحلية لكل متحدث (حتى في الأسطر متعددة المتحدثين) لتغذية مراحل الـ AI
function extractRuleEvidenceForCue(rawText) {
  const turns = splitTurnsLocal(rawText);
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
  const turns = splitTurnsLocal(rawText);
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

module.exports = { applyVocativeRules, extractRuleEvidenceForCue, findVocativeGender, findSelfGender };
