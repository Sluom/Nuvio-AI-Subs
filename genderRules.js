'use strict';

// ملاحظة: Mr / Mrs / Ms ما تنحط بقوائم المناداة العادية لأن النقطة بعدها (Mr.)
// تنفهم كنهاية جملة. تنلتقط فقط مع اسم (Mr. Smith,) بقاعدة الألقاب.
// ==================================================================
// قواعد جنس مؤكدة (بدون أي طلب لجيمناي):
//  1) مناداة بلقب: "Mom," / "Yes, sir." / "Hello, Mr. Smith." -> جنس المخاطَب
//  2) تعريف الشخص لنفسه: "I'm your father" / "As your mother, I..." -> جنس المتكلم
// الرمز من حرفين: الأول جنس المتكلم، والثاني جنس المخاطَب (M/F/G/U/N)
// ==================================================================

const MALE_VOCATIVES = [
  'sir', 'mister', 'dad', 'daddy', 'father', 'papa', 'son', 'brother',
  'my lord', 'lord', 'king', 'prince', 'gentleman', 'young man', 'uncle',
  'grandpa', 'grandfather'
];
const FEMALE_VOCATIVES = [
  "ma'am", 'madam', 'miss', 'mom', 'mommy', 'mama', 'mum', 'mother',
  'daughter', 'sister', 'sis', 'my lady', 'lady', 'queen', 'princess', 'aunt',
  'auntie', 'grandma', 'grandmother', 'young lady'
];
const GROUP_VOCATIVES = [
  'ladies and gentlemen', 'boys and girls', 'gentlemen', 'ladies', 'guys',
  'everyone', 'everybody', 'folks', 'boys', 'girls', 'kids'
];

// ألقاب تجي قبل اسم: "Mr. Smith" / "Lady Macbeth" / "Father Brown"
const MALE_TITLES = ['mr', 'mister', 'sir', 'lord', 'father', 'brother', 'king', 'prince'];
const FEMALE_TITLES = ['mrs', 'ms', 'miss', 'madam', 'lady', 'dame', 'mother', 'sister', 'queen', 'princess'];

// أدوار تدل على جنس المتكلم عند قوله "I'm ..."
const MALE_ROLES = [
  'father', 'dad', 'daddy', 'papa', 'husband', 'brother', 'son', 'uncle', 'grandfather',
  'grandpa', 'boyfriend', 'king', 'prince', 'gentleman', 'man', 'boy', 'guy'
];
const FEMALE_ROLES = [
  'mother', 'mom', 'mommy', 'mama', 'wife', 'sister', 'daughter', 'aunt', 'grandmother',
  'grandma', 'girlfriend', 'queen', 'princess', 'lady', 'woman', 'girl', 'widow'
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = terms => [...terms].sort((a, b) => b.length - a.length)
  .map(t => esc(t).replace(/ /g, '\\s+')).join('|');

// قبل اللقب: بداية السطر، أو علامة ترقيم، أو كلمة تحية/رد (Yes sir)
const BEFORE = '(?:^|[,.!?;:…"“(\\[—–]\\s*|\\b(?:hey|hi|hello|yes|no|yeah|yep|nope|thanks|thank you|please|sorry|excuse me|pardon me|okay|ok|well|oh|look|listen|good morning|good evening|good night|goodbye|bye|welcome|come on|sure)\\s*,?\\s+)';
// بعد اللقب: علامة ترقيم أو نهاية السطر (حتى ما نلتقط "my mom is here")
const AFTER = '(?=\\s*(?:[,.!?…:;")\\]]|$))';

const RE_MALE_VOC = new RegExp(`${BEFORE}(${alt(MALE_VOCATIVES)})${AFTER}`, 'gi');
const RE_FEMALE_VOC = new RegExp(`${BEFORE}(${alt(FEMALE_VOCATIVES)})${AFTER}`, 'gi');
const RE_GROUP_VOC = new RegExp(`${BEFORE}(${alt(GROUP_VOCATIVES)})${AFTER}`, 'gi');

const NAME = "([a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*)?)";
const RE_MALE_TITLE = new RegExp(`${BEFORE}(${alt(MALE_TITLES)})\\.?\\s+${NAME}\\s*${AFTER}`, 'gi');
const RE_FEMALE_TITLE = new RegExp(`${BEFORE}(${alt(FEMALE_TITLES)})\\.?\\s+${NAME}\\s*${AFTER}`, 'gi');

const DET = '(?:(?:a|an|the|your|his|her|their|our)\\s+)?';
const RE_SELF_NEG = /\bi(?:'m| am| was)\s+(?:not|no)\b/i;
const RE_SELF_MALE = new RegExp(`\\bi(?:'m| am| was)\\s+${DET}(?:(?:very|really|proud|loving|real|new|old|poor|good|bad|single|young)\\s+)?(?:${alt(MALE_ROLES)})\\b`, 'i');
const RE_SELF_FEMALE = new RegExp(`\\bi(?:'m| am| was)\\s+${DET}(?:(?:very|really|proud|loving|real|new|old|poor|good|bad|single|young)\\s+)?(?:${alt(FEMALE_ROLES)})\\b`, 'i');
const RE_AS_MALE = new RegExp(`\\bas\\s+${DET}(?:${alt(MALE_ROLES)})\\s*,\\s*i\\b`, 'i');
const RE_AS_FEMALE = new RegExp(`\\bas\\s+${DET}(?:${alt(FEMALE_ROLES)})\\s*,\\s*i\\b`, 'i');

function normalizeForRules(raw) {
  return String(raw || '')
    .replace(/\{[^}]*\}|<[^>]*>/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—]+/, '')
    .trim();
}

// سطر فيه متكلمين اثنين (سطر ثاني يبدأ بشرطة): ما نلمسه لأن الجنس يختلف بين الجزئين
function isMultiSpeaker(raw) {
  const s = String(raw || '');
  return /\\[Nn]\s*[-–—]/.test(s) || /\n\s*[-–—]/.test(s);
}

function collect(re, clean, genderOfMatch, out, requireCapitalName) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (requireCapitalName) {
      const name = m[2] || '';
      if (!/^[A-Z]/.test(name)) { if (m.index === re.lastIndex) re.lastIndex++; continue; }
    }
    out.add(genderOfMatch);
    if (m.index === re.lastIndex) re.lastIndex++;
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
  return 'G'; // مثل "Mom, Dad, look!"
}

function findSelfGender(clean) {
  if (RE_SELF_NEG.test(clean)) return null;
  const male = RE_SELF_MALE.test(clean) || RE_AS_MALE.test(clean);
  const female = RE_SELF_FEMALE.test(clean) || RE_AS_FEMALE.test(clean);
  if (male && !female) return 'M';
  if (female && !male) return 'F';
  return null;
}

// يرجع الرمز الجديد (مثل "UM") إذا تغيّر شي، وإلا null
function applyVocativeRules(rawText, existingG) {
  if (isMultiSpeaker(rawText)) return null;
  const clean = normalizeForRules(rawText);
  if (!clean) return null;

  const addressee = findVocativeGender(clean);
  const speaker = findSelfGender(clean);
  if (!addressee && !speaker) return null;

  const base = existingG && /^[MFGUN]{2}$/.test(existingG) ? existingG : 'UU';
  const result = (speaker || base[0]) + (addressee || base[1]);
  return result === base && existingG === base ? null : (result === existingG ? null : result);
}

module.exports = { applyVocativeRules, findVocativeGender, findSelfGender };
