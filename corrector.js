// ==================================================================================
// corrector.js : مسار المصحح العربي المستقل (يجلب ترجمات عربية جاهزة ويصحح الترقيم فقط)
// يعتمد على مشتركات ai.js ولا يغيّر شيئاً في مسار الترجمة.
// ==================================================================================
const {
  axios, delay, acquireKey, deadKeys, keyCooldowns, cooldownForStatus, isGeminiAuthFailure,
  normalizeGeminiModelId, SAFETY_SETTINGS_OFF, DEFAULT_GEMINI_API_URL, GEMINI_CLIENT_HEADER,
  MAX_AI_RESPONSE_BYTES, httpAgent, httpsAgent, parseIdTranslations, buildChunkContext,
  needsTranslation, getLineCache, aliveKeyCount, MAX_MISSING_RETRIES, fetchAndExtractSub,
  extractCuesUniversal, normalizeLineBreakArtifacts, ASS_DEFAULT_HEADER
} = require('./ai').shared;

// ==================================================================================
// ================== مسار المصحح العربي (Arabic Correction Path) ==================
// ==================================================================================

// تنظيف مخرجات المصحح: بدون أقواس مربعة وبدون رموز اتجاه مخفية
const CORRECTOR_STRIP_BRACKETS = true;
const CORRECTOR_WRAP_AT = 42;   // أي سطر مفرد أطول من هذا ينكسر لسطرين متوازنين (0 = إيقاف)

// ترتيب الأسطر وعلامات الترقيم بالكود (لا يعتمد على الموديل)
const TERM_CHARS = '.…!؟?،,؛';
const HAS_ARABIC = /[\u0600-\u06FF]/;
const DASH_RE = /^[-–—]/;

function visibleLen(s) { return String(s).replace(/<[^>]*>|\{[^}]*\}/g, '').length; }

// سحب الشارحة لتكون دائماً بالبداية، وتصحيح الترقيم المعكوس للنهاية
function moveLeadingPunct(line) {
  let t = line.trim();
  let hasDash = false;

  // 1. استخراج الشارحة وحفظها (سواء كانت بالبداية أو مشمورة بالنهاية)
  if (/^[-–—]\s*/.test(t)) { hasDash = true; t = t.replace(/^[-–—]\s*/, ''); }
  if (/\s*[-–—]$/.test(t)) { hasDash = true; t = t.replace(/\s*[-–—]$/, ''); }

  // 2. تصحيح الترقيم المعكوس (الاستفهام والنقاط)
  const m = t.match(/^([.…!؟?،,؛]+)\s*(.+)$/);
  if (m) {
    const lead = m[1], rest = m[2];
    if (HAS_ARABIC.test(rest) && !(lead === '…' || /^\.{3,}$/.test(lead))) {
      const core = rest.replace(/["'”“)\]»\s]+$/, '');
      if (core && !TERM_CHARS.includes(core[core.length - 1])) {
        t = rest + lead;
      } else {
        t = rest;
      }
    }
  }
  
  // 3. إعادة تركيب الجملة: الشارحة أولاً، ثم مسافة، ثم النص المصحح
  return (hasDash ? '- ' : '') + t.trim();
}

function splitSpeakers(line) {
  if (!DASH_RE.test(line)) return [line];
  const parts = line.split(/\s+(?=[-–—]\s)/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [line];
}

function balancedBreak(line) {
  const words = line.split(' ');
  if (words.length < 3) return [line];
  let best = -1, bestDiff = Infinity;
  let acc = 0;
  const total = visibleLen(line);
  for (let i = 0; i < words.length - 1; i++) {
    acc += visibleLen(words[i]) + (i ? 1 : 0);
    const diff = Math.abs(acc - (total - acc - 1));
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  if (best < 0) return [line];
  const a = words.slice(0, best + 1).join(' '), b = words.slice(best + 1).join(' ');
  return (visibleLen(a) >= 8 && visibleLen(b) >= 8) ? [a, b] : [line];
}
function polishArabicText(txt) {
  let t = String(txt == null ? '' : txt)
    .replace(/\\+[nN]/g, '\n');
  let lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) out.push(...splitSpeakers(moveLeadingPunct(l)));
  let res = out.map(l => moveLeadingPunct(l));
  if (CORRECTOR_WRAP_AT > 0 && res.length === 1 && !DASH_RE.test(res[0]) && visibleLen(res[0]) > CORRECTOR_WRAP_AT) {
    res = balancedBreak(res[0]);
  }
  return res.join('\n');
}


function cleanCorrectorOutput(txt) {
  let t = String(txt == null ? '' : txt)
    .replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '');
  if (CORRECTOR_STRIP_BRACKETS) t = t.replace(/[\[\]]/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  return polishArabicText(fixArabicTypos(t));
}

const TYPO_FIX_RAW = {"لى": "لي", "فى": "في", "الذى": "الذي", "التى": "التي", "لكى": "لكي", "معى": "معي", "بى": "بي", "نفسى": "نفسي", "رأيى": "رأيي", "رأسى": "رأسي", "انتى": "أنتِ", "حتي": "حتى", "باقى": "باقي", "ثوانى": "ثواني", "ماضى": "ماضي", "أصدقائى": "أصدقائي", "أبنائى": "أبنائي", "اخى": "أخي", "رئيسى": "رئيسي", "سيدى": "سيدي", "عزيزى": "عزيزي", "زوجتى": "زوجتي", "عائلتى": "عائلتي", "صديقى": "صديقي", "محامى": "محامي", "عالى": "عالي", "غالى": "غالي", "كرسى": "كرسي", "مبانى": "مباني", "اغانى": "أغاني", "ليالى": "ليالي", "حرامى": "حرامي", "عادى": "عادي", "قاضى": "قاضي", "فاضى": "فاضي", "اعطنى": "أعطني", "دعنى": "دعني", "ارنى": "أرني", "اخبرنى": "أخبرني", "صدقنى": "صدقني", "اسمعنى": "اسمعني", "سامحنى": "سامحني", "توقفى": "توقفي", "اذهبى": "اذهبي", "انظرى": "انظري", "ابتعدى": "ابتعدي", "اهربى": "اهربي", "مستشفي": "مستشفى", "فوضي": "فوضى", "اعمي": "أعمى", "سيدتى": "سيدتي", "امى": "أمي", "ابنتى": "ابنتي", "مقهي": "مقهى", "حوالى": "حوالي", "شخصى": "شخصي", "طبيعى": "طبيعي", "حقيقى": "حقيقي", "نهائى": "نهائي", "مبدئى": "مبدئي", "كافى": "كافي", "شكوي": "شكوى", "فتوي": "فتوى", "حلوي": "حلوى", "متي": "متى", "عسي": "عسى", "جدوي": "جدوى", "فحوي": "فحوى", "قصوي": "قصوى", "رؤي": "رؤى", "منتدي": "منتدى", "مسعي": "مسعى", "مغزي": "مغزى", "افعي": "أفعى", "مأوي": "مأوى", "مثوي": "مثوى", "مصطفي": "مصطفى", "مجتبي": "مجتبى", "مستلقي": "مستلقى", "مرتضي": "مرتضى", "اللة": "الله", "واللة": "والله", "لة": "له", "عنة": "عنه", "منة": "منه", "علية": "عليه", "إلية": "إليه", "فية": "فيه", "معة": "معه", "نفسة": "نفسه", "هذة": "هذه", "مفاجأه": "مفاجأة", "دقيقه": "دقيقة", "حقيقه": "حقيقة", "طريقه": "طريقة", "فجأه": "فجأة", "عائله": "عائلة", "غرفه": "غرفة", "مشكله": "مشكلة", "فكره": "فكرة", "سياره": "سيارة", "قوه": "قوة", "لحظه": "لحظة", "مهمه": "مهمة", "فرصه": "فرصة", "رساله": "رسالة", "نهايه": "نهاية", "بدايه": "بداية", "جريمه": "جريمة", "امرأه": "امرأة", "طاقه": "طاقة", "علاقه": "علاقة", "معركه": "معركة", "رحله": "رحلة", "شجره": "شجرة", "لعبه": "لعبة", "فتره": "فترة", "ورقه": "ورقة", "شرطه": "شرطة", "خطوه": "خطوة", "حفله": "حفلة", "مكالمه": "مكالمة", "مدرسه": "مدرسة", "رؤيه": "رؤية", "رصاصه": "رصاصة", "قنبله": "قنبلة", "اسلحه": "أسلحة", "فرقه": "فرقة", "حقيبه": "حقيبة", "بصمه": "بصمة", "قهوه": "قهوة", "طاوله": "طاولة", "مسأله": "مسألة", "اسئله": "أسئلة", "رائعه": "رائعة", "سرعه": "سرعة", "نافذه": "نافذة", "شاشه": "شاشة", "فائده": "فائدة", "عاصفه": "عاصفة", "سفينه": "سفينة", "طائره": "طائرة", "سياده": "سيادة", "جلاله": "جلالة", "عمده": "عمدة", "محطه": "محطة", "شركه": "شركة", "ابوة": "أبوه", "اسمة": "اسمه", "مياة": "مياه", "وجة": "وجه", "اتجاة": "اتجاه", "انتباة": "انتباه", "شبة": "شبه", "سهوله": "سهولة", "صعوبه": "صعوبة", "مجموعه": "مجموعة", "مساحه": "مساحة", "عاهره": "عاهرة", "عصابه": "عصابة", "خزنه": "خزنة", "بوابه": "بوابة", "قمامه": "قمامة", "ادله": "أدلة", "مباشره": "مباشرة", "كامله": "كاملة", "جديده": "جديدة", "كبيره": "كبيرة", "صغيره": "صغيرة", "محكمه": "محكمة", "حكومه": "حكومة", "عقوبه": "عقوبة", "معجزه": "معجزة", "خريطه": "خريطة", "ثلاجه": "ثلاجة", "قائمه": "قائمة", "قضيه": "قضية", "ضحيه": "ضحية", "رهينه": "رهينة", "عشيقه": "عشيقة", "خطيئه": "خطيئه", "مستحيله": "مستحيلة", "غريبه": "غريبة", "مجنونه": "مجنونة", "مؤخره": "مؤخرة", "مقدمه": "مقدمة", "نتيجه": "نتيجة", "اجهزه": "أجهزة", "اسطوره": "أسطورة", "ثقه": "ثقة", "صدفه": "صدفة", "معامله": "معاملة", "مواجهه": "مواجهة", "سيطره": "سيطرة", "بيئه": "بيئة", "هيئه": "هيئة", "مائده": "مائدة", "بطاقه": "بطاقة", "طبيعه": "طبيعة", "فضيحه": "فضيحة", "مصلحه": "مصلحة", "اسطوانه": "أسطوانة", "استماره": "استمارة", "شريحه": "شريحة", "مكافأه": "مكافأة", "جرأه": "جرأة", "بأكملة": "بأكمله", "تجاة": "تجاه", "افواة": "أفواه", "اشباة": "أشباه", "دوله": "دولة", "مدينه": "مدينة", "اشاره": "إشارة", "قياده": "قيادة", "شهاده": "شهادة", "عقيده": "عقيدة", "جائزه": "جائزة", "سياسه": "سياسة", "شئ": "شيء", "شئيا": "شيئا", "سئ": "سيء", "مسئول": "مسؤول", "دايما": "دائما", "بطئ": "بطيء", "قرائة": "قراءة", "برائة": "براءة", "الأن": "الآن", "شئون": "شؤون", "كئوس": "كؤوس", "يقراء": "يقرأ", "مليئ": "مليء", "سيئه": "سيئة", "ذالك": "ذلك", "هاذا": "هذا", "لاكن": "لكن", "مالذي": "ما الذي", "مابك": "ما بك", "كفائة": "كفاءة", "مايحدث": "ما يحدث", "مابه": "ما به", "مابها": "ما بها", "ياأمي": "يا أمي", "ياأبي": "يا أبي", "ياأخي": "يا أخي", "ارجوك": "أرجوك", "يارجل": "يا رجل", "ياإلهي": "يا إلهي", "يارفاق": "يا رفاق", "ياشباب": "يا شباب", "لاشئ": "لا شيء", "ياسيدي": "يا سيدي", "ياصديقي": "يا صديقي", "هاكذا": "هكذا", "لااحد": "لا أحد", "يافتاة": "يا فتاة", "بالتاكيد": "بالتأكيد", "لابأس": "لا بأس", "لايمكن": "لا يمكن", "لااعرف": "لا أعرف", "لااعلم": "لا أعلم", "ماالامر": "ما الأمر", "ماالخطب": "ما الخطب", "ايها": "أيها", "ايتها": "أيتها", "كلشئ": "كل شيء", "ايشئ": "أي شيء", "ياولدي": "يا ولدي", "يابني": "يا بني", "طاريء": "طارئ", "هاديء": "هادئ", "مفاجيء": "مفاجئ", "دافيء": "دافئ", "مباديء": "مبادئ", "لاداعي": "لا داعي", "لامشكلة": "لا مشكلة", "مالعمل": "ما العمل", "ماالمشكلة": "ما المشكلة", "خاطيء": "خاطئ", "مخطيء": "مخطئ", "قاريء": "قارئ", "رجائا": "رجاء", "مسائا": "مساء", "هاؤلاء": "هؤلاء", "اولائك": "أولئك", "بالظبط": "بالضبط", "انشاءالله": "إن شاء الله", "بماان": "بما أن", "كيفحالك": "كيف حالك", "بخيرشكرا": "بخير شكرا"};
const TYPO_ALL = new Map(Object.entries(TYPO_FIX_RAW));
const TYPO_SAFE = new Map([...TYPO_ALL].filter(([k]) => k.length >= 5 || k.startsWith('ال')));
const TYPO_PREFIX = new Set(['و', 'ف', 'ب', 'ل', 'ك']);

function fixTypoToken(tok) {
  if (TYPO_ALL.has(tok)) return TYPO_ALL.get(tok);
  let pre = '';
  let rest = tok;
  for (let n = 0; n < 3 && rest.length > 2; n++) {
    if (rest.startsWith('لل') && rest.length > 4) {
      const r = rest.slice(2);
      if (TYPO_SAFE.has(r)) return pre + 'لل' + TYPO_SAFE.get(r);
    }
    if (rest.startsWith('ال') && rest.length > 4) {
      const r = rest.slice(2);
      if (TYPO_SAFE.has(r)) return pre + 'ال' + TYPO_SAFE.get(r);
    }
    if (!TYPO_PREFIX.has(rest[0])) break;
    pre += rest[0];
    rest = rest.slice(1);
    if (TYPO_SAFE.has(rest)) return pre + TYPO_SAFE.get(rest);
  }
  return tok;
}

function fixArabicTypos(txt) {
  return String(txt == null ? '' : txt).replace(/[\p{L}\p{M}]+/gu, tok => (/[\u0600-\u06FF]/.test(tok) ? fixTypoToken(tok) : tok));
}

async function correctChunkStrict(items, keysArray, modelName, ctx = null) {
  const cleanModel = normalizeGeminiModelId(modelName || 'gemini-3.1-flash-lite');
  const generationConfig = { temperature: 0.1, responseMimeType: "application/json" };

  const ctxBlock = ctx && (ctx.before.length || ctx.after.length)
    ? `\nCONTEXT (READ-ONLY): Use these lines ONLY to understand if a sentence continues across entries.\ncontext_before: ${JSON.stringify(ctx.before)}\ncontext_after: ${JSON.stringify(ctx.after)}\n`
    : '';

  // البرومبت المحدث: تم إزالة كلمة الأقواس والتنسيق، واعتماد فكرتك للأوامر الميكانيكية المباشرة
  const prompt = `You will receive a JSON array of Arabic subtitle entries: {"id": <number>, "text": "<Arabic text>"}.
Your ONLY job is to change the position of specific punctuation marks. DO NOT change words, meaning, or any other symbols.

Rules:
1. Return a JSON array: [{"id": <same number>, "text": "<corrected text>"}]. Keep the exact same number of lines inside each entry.
2. If you see a period (.), question mark (؟), or exclamation mark (!) at the START of an Arabic sentence, move it to the END of the sentence.
3. If you see a dash (-) at the END of a sentence, move it to the START of the sentence.
4. Add a period (.) at the end of a complete sentence if it lacks punctuation completely. DO NOT add a period if the sentence clearly continues into the next entry.
5. The sequence \\N or \\n inside a text is a LINE BREAK marker. Keep it exactly where it is. NEVER merge two lines into one.
6. DO NOT touch, add, remove, or fix ANY other characters, symbols, or formatting. Just do the specific moves mentioned above.
7. ONLY output the JSON array. No explanations.
${ctxBlock}
Content to correct:
${JSON.stringify(items)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const activeKey = await acquireKey(keysArray);
    if (!activeKey) return { status: 'no_keys', map: new Map() };

    const cleanKey = String(activeKey).trim();
    const url = `${DEFAULT_GEMINI_API_URL}/models/${cleanModel}:generateContent`;

    try {
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: SAFETY_SETTINGS_OFF
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey, 'x-goog-api-client': GEMINI_CLIENT_HEADER },
        timeout: 60000,
        httpAgent, httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const responseText = parts.map(p => p?.text || '').join('');
      const map = parseIdTranslations(responseText);

      if (map) {
        const allowedIds = new Set(items.map(i => i.id));
        let extraIds = 0;
        for (const id of map.keys()) if (!allowedIds.has(id)) extraIds++;
        if (extraIds > Math.max(3, Math.floor(items.length * 0.02))) {
          console.log(`[حارس الأرقام - مصحح] الرد فيه ${extraIds} رقم ما طلبته. أرفضه.`);
          return { status: 'bad_ids', map: new Map() };
        }
        if (items.length >= 40) console.log(`[مصحح عربي - نجاح] طلب ${items.length} سطر، رجع ${map.size} عبر ...${cleanKey.slice(-4)}`);
        return { status: 'ok', map };
      }

      return { status: 'bad_format', map: new Map() };
    } catch (e) {
      const status = e.response?.status || 0;
      if (isGeminiAuthFailure(e)) {
        deadKeys.add(activeKey);
        console.log(`[مفتاح ميت] ...${cleanKey.slice(-4)} (status:${status})`);
        continue;
      }
      const cd = cooldownForStatus(status);
      keyCooldowns.set(activeKey, Date.now() + cd);
      console.log(`[تبريد طارئ - مصحح] ...${cleanKey.slice(-4)} -> ${Math.ceil(cd / 1000)}s`);
      if (attempt < 3) await delay(2000 + (Math.random() * 2000));
    }
  }
  return { status: 'api_exhausted', map: new Map() };
}

async function correctItemsWithRecovery(items, keysArray, modelName, ctx = null) {
  const done = new Map();
  if (!items || items.length === 0) return done;

  let pending = items;

  for (let round = 0; round <= MAX_MISSING_RETRIES && pending.length > 0; round++) {
    const result = await correctChunkStrict(pending, keysArray, modelName, ctx);

    if (result.status === 'api_exhausted' || result.status === 'no_keys') {
      console.log(`[تجاوز طارئ - مصحح] السيرفرات مختنقة. تم تجاوز (${pending.length}) سطر للحفاظ على التزامن.`);
      break;
    }

    if ((result.status === 'bad_ids' || result.status === 'bad_format') && pending.length > 60) {
      const mid = Math.ceil(pending.length / 2);
      console.log(`[حارس الأرقام - مصحح] أقسم الدفعة (${pending.length}) لنصفين وأعيد.`);
      const left = await correctItemsWithRecovery(pending.slice(0, mid), keysArray, modelName, ctx);
      const right = await correctItemsWithRecovery(pending.slice(mid), keysArray, modelName, ctx);
      for (const [id, text] of left) done.set(id, text);
      for (const [id, text] of right) done.set(id, text);
      pending = pending.filter(it => !done.has(it.id));
      break;
    }

    if (result.status === 'ok') {
      const wanted = new Set(pending.map(it => it.id));
      for (const [id, text] of result.map) {
        if (wanted.has(id) && text) done.set(id, text);
      }
    }

    const before = pending.length;
    pending = pending.filter(it => !done.has(it.id));

    if (pending.length > 0 && round < MAX_MISSING_RETRIES) {
      console.log(`[إعادة الناقص - مصحح 🔁] ناقص ${pending.length} من ${before}. أعيد طلبهم...`);
    }
  }

  return done;
}

async function correctAllCues(cues, keysArray, modelName, cacheKey) {
  const tStart = Date.now();
  const CHUNK = 600;
  const RETRY_PIECE = 50;
  const MAX_TRIES = 5;
  const cache = getLineCache('ARA_' + cacheKey);

  const results = new Array(cues.length).fill(null);
  const toDo = [];
  let fromCache = 0;

  cues.forEach((c, i) => {
    if (!needsTranslation(c.text)) { results[i] = c.text; return; }
    if (cache.has(i)) { results[i] = cache.get(i); fromCache++; return; }
    toDo.push({ id: i, text: c.text });
  });

  if (fromCache > 0) console.log(`[كاش الأسطر - مصحح] ${fromCache} سطر جاهز من قبل، أصحح الباقي (${toDo.length}) فقط.`);

  const queue = [];
  for (let i = 0; i < toDo.length; i += CHUNK) queue.push({ items: toDo.slice(i, i + CHUNK), tries: 0 });

  let inFlight = 0;
  let requeued = 0;
  const workerCount = Math.max(1, Math.min(aliveKeyCount(keysArray), 35));

  const applyLine = (id, text) => {
    const clean = cleanCorrectorOutput(text) || cleanCorrectorOutput(cues[id].text);
    results[id] = clean;
    cache.set(id, clean);
  };

  const requeueLeft = (job, leftover, why) => {
    if (!leftover.length) return;
    if (job.tries + 1 >= MAX_TRIES) {
      console.log(`[مصحح - تجاوز] ${leftover.length} سطر بعد ${MAX_TRIES} محاولات، يبقون بنصهم الأصلي.`);
      return;
    }
    let pieces = 0;
    for (let p = 0; p < leftover.length; p += RETRY_PIECE) {
      queue.unshift({ items: leftover.slice(p, p + RETRY_PIECE), tries: job.tries + 1 });
      pieces++;
    }
    requeued += leftover.length;
    console.log(`[مصحح - إعادة لحظية ⚡] ${why}: ${leftover.length} سطر → ${pieces} قطعة (≤${RETRY_PIECE}) تلتقطها المفاتيح الفاضية فوراً.`);
  };

  async function worker() {
    while (true) {
      if (keysArray.every(k => deadKeys.has(k))) return;
      const job = queue.shift();
      if (!job) {
        if (inFlight === 0) return;
        await delay(100);
        continue;
      }
      inFlight++;
      try {
        const ctx = buildChunkContext(cues, job.items);
        const r = await correctChunkStrict(job.items, keysArray, modelName, ctx);
        if (r.status === 'ok') {
          const wanted = new Set(job.items.map(it => it.id));
          for (const [id, text] of r.map) if (wanted.has(id) && text) applyLine(id, text);
          const leftover = job.items.filter(it => results[it.id] == null);
          requeueLeft(job, leftover, `ناقص ${leftover.length} من ${job.items.length}`);
        } else if (r.status === 'api_exhausted' || r.status === 'no_keys') {
          requeueLeft(job, job.items.filter(it => results[it.id] == null), `السيرفر مختنق (${r.status})`);
          await delay(2000 + Math.random() * 2000);
        } else {
          requeueLeft(job, job.items.filter(it => results[it.id] == null), `رد غير صالح (${r.status})`);
        }
      } catch (e) {
        console.log(`[مصحح] خطأ بمهمة: ${e && e.message}`);
        requeueLeft(job, job.items.filter(it => results[it.id] == null), 'خطأ');
      } finally {
        inFlight--;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const missing = results.filter(r => r == null).length;
  console.log(`[ملخص المصحح] أسطر=${cues.length} | للتصحيح=${toDo.length} | أُعيد لحظياً=${requeued} | ناقص=${missing} | عمّال=${workerCount} | الزمن=${Date.now() - tStart}ms`);

  const finalTexts = cues.map((c, i) => cleanCorrectorOutput(normalizeLineBreakArtifacts(results[i] || c.text)));

  if (process.env.CORRECTOR_DEBUG === '1' && toDo.length > 0) {
    const cp = str => [...String(str)].map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
    const step = Math.max(1, Math.floor(toDo.length / 12));
    for (let k = 0; k < toDo.length && k < step * 12; k += step) {
      const id = toDo[k].id;
      const f = finalTexts[id];
      const chars = [...f];
      console.log(`[فحص مصحح] #${id} أصل=${JSON.stringify(cues[id].text)} | ناتج=${JSON.stringify(f)} | أول=${cp(chars.slice(0, 2).join(''))} | آخر=${cp(chars.slice(-2).join(''))}`);
    }
  }

  return {
    texts: finalTexts,
    missing
  };
}

async function handleCorrectionSrt(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) {
    console.log(`[مصحح Nuvio] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل تحميل ملف الترجمة العربية الأصلي.\n\n", missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return { content: "1\n00:00:01,000 --> 00:00:08,000\n[نظام Nuvio AI] فشل استخراج النصوص.\n\n", missing: 0, total: 0, failed: true };

  console.log(`[مصحح Nuvio SRT] ${cues.length} أسطر عربية -> CHUNK=600 | مفاتيح=${keysArray.length}`);
  const { texts: finalCorrections, missing } = await correctAllCues(cues, keysArray, modelName, subUrl);

  let srtOutput = '';
  let counter = 1;
  cues.forEach((c, idx) => {
    let text = finalCorrections[idx];
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    let sTime = c.start.replace('.', ','), eTime = c.end.replace('.', ',');
    if (sTime.length === 10) sTime = '0' + sTime;
    if (eTime.length === 10) eTime = '0' + eTime;
    if (sTime.split(',')[1].length === 2) sTime += '0';
    if (eTime.split(',')[1].length === 2) eTime += '0';
    srtOutput += `${counter}\n${sTime} --> ${eTime}\n${text.trim()}\n\n`;
    counter++;
  });
  return { content: srtOutput, missing, total: cues.length, failed: false };
}

async function handleCorrectionAss(subUrl, keysArray, modelName, userTmdbKey, targetId, kitsuId) {
  let originalText = "";
  try { originalText = await fetchAndExtractSub(subUrl); }
  catch (e) {
    console.log(`[مصحح Nuvio ASS] فشل تحميل ملف الترجمة الأصلي: ${e.message}`);
    return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل تحميل الملف العربي.`, missing: 0, total: 0, failed: true };
  }

  const cues = extractCuesUniversal(originalText);
  if (!cues.length) return { content: ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[نظام Nuvio AI] فشل الاستخراج.`, missing: 0, total: 0, failed: true };

  console.log(`[مصحح Nuvio ASS] ${cues.length} أسطر عربية -> CHUNK=600 | مفاتيح=${keysArray.length}`);
  const { texts: finalCorrections, missing } = await correctAllCues(cues, keysArray, modelName, subUrl);

  const assLines = [];
  cues.forEach((c, idx) => {
    let text = finalCorrections[idx];
    if (!text || text.replace(/<[^>]+>|\{[^}]+\}|-|"|”|“|'|\s/g, '').length === 0) return;
    assLines.push(`Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${text.trim().replace(/\n/g, '\\N')}`);
  });
  return { content: ASS_DEFAULT_HEADER + assLines.join('\n') + '\n', missing, total: cues.length, failed: false };
}

module.exports = {
  handleCorrectionSrt,
  handleCorrectionAss
};
