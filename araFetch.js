// araFetch.js
const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');

const cleanPath = p => String(p || '').split('?')[0];

const LEGACY_AGENTS = ['TemporaryUserAgent', 'VLSub 0.10.3', 'OSTestUserAgent'];

// ============================================================
// إعدادات الأزمنة والأداء
// ============================================================
// سقف جلب القوائم الأولية لكل مصدر
const SOURCE_TIMEOUTS = { os_legacy: 4500, os_mirror: 4000, subdl: 5000, subsource: 5000 };

// 5 ثوانٍ صافية لفحص واستخراج ملفات ZIP و ASS قبل إرسال الرد الأولي
const VERIFY_WINDOW_MS = 5000;

// أقصى زمن لتحميل وفك ضغط ملف واحد أثناء الفحص
const VERIFY_TIMEOUT_MS = 10000;

// عدد الفحوصات المتوازية في نفس اللحظة لحماية رام السيرفر وسرعة الشبكة
const VERIFY_CONCURRENCY = 10;

// سقف أمان أقصى لعدد الروابط المفحوصة في العمل الواحد لمنع امتلاء الذاكرة
const MAX_CANDIDATES = 150;

const RESULT_TTL = 30 * 60 * 1000;
const resultCache = new Map();

// كاش لحفظ النصوص العربية المستخرجة لتعمل الترجمات الجاهزة فوراً (بحد أقصى 100 ملف لحماية الرام)
const MAX_RAW_CACHE = 100;
const rawContentCache = new Map();

function makeRawCacheKey(url, epInfo) {
    const s = epInfo && epInfo.season != null ? epInfo.season : '';
    const e = epInfo && epInfo.episode != null ? epInfo.episode : '';
    return `${url}|${s}:${e}`;
}

function saveRawContent(url, epInfo, text) {
    if (!url || !text) return;
    const key = makeRawCacheKey(url, epInfo);
    if (rawContentCache.has(key)) rawContentCache.delete(key);
    rawContentCache.set(key, { time: Date.now(), text });
    if (rawContentCache.size > MAX_RAW_CACHE) {
        const oldestKey = rawContentCache.keys().next().value;
        if (oldestKey) rawContentCache.delete(oldestKey);
    }
}

function withTimeout(promise, ms, name) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            console.log(`[جلب عربي - ${name}] تجاوز ${(ms / 1000).toFixed(1)} ثانية، تجاهلته وكملت بالباقي.`);
            resolve([]);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// فحص سلامة الترميز واستبعاد ترجمات ويندوز المعطوبة (Mojibake / Replacement Chars)
function isCorruptedWindowsEncoding(text, arabicCount) {
    if (!text) return true;
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    if (replacementCount > 15) return true;

    // الحروف اللاتينية الممتدة التي تنتج عند قراءة ملف Windows-1256 بترميز خاطئ (مثل Ø Ù Ã Í Ê)
    const mojibakeCount = (text.match(/[\u00C0-\u00FF]/g) || []).length;
    if (mojibakeCount > 30 && mojibakeCount > arabicCount * 0.15) return true;

    return false;
}

async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;

    const primaryUrl = hasSE
        ? `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`
        : `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;

    async function fetchLegacyData(url) {
        for (let i = 0; i < LEGACY_AGENTS.length; i++) {
            const ua = LEGACY_AGENTS[i];
            try {
                const response = await axios.get(url, {
                    timeout: 3500,
                    headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' },
                    validateStatus: () => true
                });
                console.log(`[جلب عربي - OS Legacy] ${response.status}${i > 0 ? ` (محاولة ${i + 1}:${ua})` : ''} <- ${url}`);
                if (response.status === 200 && Array.isArray(response.data)) {
                    return response.data;
                }
                if (response.status !== 403 && response.status !== 429 && response.status < 500) break;
            } catch (err) {
                console.log(`[جلب عربي - OS Legacy] محاولة ${i + 1} (${ua}) فشلت: ${err.message}`);
            }
        }
        return [];
    }

    const isAssEntry = r => /^(ass|ssa)$/i.test(r.SubFormat || '') || /\.(ass|ssa)\b/i.test(r.SubFileName || '');

    try {
        let data = await fetchLegacyData(primaryUrl);

        if (hasSE && !data.some(isAssEntry)) {
            const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;
            const fallbackData = await fetchLegacyData(fallbackUrl);
            const epRe = new RegExp(`(?:e|ep|episode)[._ -]*0*${parseInt(episode, 10)}(?:[^0-9]|$)`, 'i');
            data = [...data, ...fallbackData.filter(r => isAssEntry(r) && epRe.test(r.SubFileName || ''))];
        }

        const total = data.length;
        const assOnly = data.filter(e => e && e.SubDownloadLink && isAssEntry(e)).map(e => ({
            url: e.SubDownloadLink,
            format: 'ass',
            fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
            _source: 'os_legacy'
        }));
        console.log(`[جلب عربي - OS Legacy] رجع ${total} نتيجة، المعتمد ASS فقط: ${assOnly.length}.`);
        return assOnly;
    } catch (e) {
        console.log(`[جلب عربي - OS Legacy] خطأ: ${e.message}`);
        return [];
    }
}

async function fetchOsMirrorArabic(imdbId, season, episode, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    try {
        const response = await axios.get(`https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`, {
            headers: { 'User-Agent': 'NuvioSubtitles v1.0.0' },
            timeout: 4000
        });

        const data = response.data || {};
        const out = (data.subtitles || [])
            .filter(s => (s.lang || '').toLowerCase().startsWith('ar') && s.url)
            .map(s => {
                const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();
                const rawUrl = (s.url || '').toLowerCase();
                const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
                const isAss = subFormat === 'ssa' || subFormat === 'ass' || /\.(ass|ssa)/.test(rawUrl) || /\.(ass|ssa)/.test(rawName);
                return {
                    url: s.url,
                    format: isAss ? 'ass' : 'srt',
                    fileName: s.SubFileName || s.title || s.name || 'OS_Mirror_Ara',
                    _source: 'os_mirror'
                };
            });
        console.log(`[جلب عربي - OS Mirror] ${out.length} ترجمة عربية.`);
        return out;
    } catch (e) {
        console.log(`[جلب عربي - OS Mirror] فشل: ${e.message}`);
        return [];
    }
}

async function verifyArabicSub(s, subsourceKey, epInfo = null) {
    let timer;
    try {
        const { fetchAndExtractSub, extractCuesUniversal } = require('./ai').shared;
        const text = await Promise.race([
            fetchAndExtractSub(s.url, subsourceKey, epInfo),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), VERIFY_TIMEOUT_MS); })
        ]);

        if (!text || typeof text !== 'string') return null;

        const cues = extractCuesUniversal(text);
        const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;

        if (cues.length < 10 || arabic < 200) {
            console.log(`[فحص عربي] ✗ ${s._source}: ليس عربياً أو فارغ (cues=${cues.length}, arabic=${arabic}) <- ${s.url}`);
            return null;
        }

        if (isCorruptedWindowsEncoding(text, arabic)) {
            console.log(`[فحص عربي] ✗ ${s._source}: تم استبعاد ترجمة ويندوز ذات ترميز معطوب <- ${s.url}`);
            return null;
        }

        const realFormat = /^\s*Dialogue:/im.test(text) ? 'ass' : 'srt';
        const sig = crypto.createHash('md5')
            .update(cues.map(c => c.text).join('').replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');

        saveRawContent(s.url, epInfo, text);

        return { ...s, format: realFormat, _sig: sig };
    } catch (e) {
        console.log(`[فحص عربي] ✗ ${s._source}: ${e.message} <- ${s.url}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// فحص متوازٍ محكوم بـ VERIFY_CONCURRENCY وينتظر حتى VERIFY_WINDOW_MS (5 ثوانٍ)
// ثم يعيد ما تم إنجازه فوراً ويكمل الباقي في الخلفية لتحديث الكاش.
function startVerification(list, subsourceKey, epInfo, windowMs) {
    const results = [];
    let doneWindow = false;
    let windowTimer;
    let resolveWindow;

    const windowPromise = new Promise(r => { resolveWindow = r; });

    const finishWindow = () => {
        if (doneWindow) return;
        doneWindow = true;
        clearTimeout(windowTimer);
        resolveWindow();
    };

    if (!list.length) {
        finishWindow();
        return { results, windowPromise, allPromise: Promise.resolve() };
    }

    windowTimer = setTimeout(finishWindow, windowMs);

    let index = 0;
    const workersCount = Math.min(VERIFY_CONCURRENCY, list.length);

    const runWorker = async () => {
        while (index < list.length) {
            const currentIdx = index++;
            const item = list[currentIdx];
            if (!item) continue;
            const res = await verifyArabicSub(item, subsourceKey, epInfo).catch(() => null);
            if (res) {
                res._order = currentIdx;
                results.push(res);
            }
        }
    };

    const allPromise = Promise.all(
        Array.from({ length: workersCount }, () => runWorker())
    ).then(() => {
        finishWindow();
    });

    return { results, windowPromise, allPromise };
}

const SOURCE_ORDER = { subdl: 0, subsource: 1, os_legacy: 2, os_mirror: 3 };
const sourceRank = s => (SOURCE_ORDER[s._source] ?? 9);

function buildValue(verified) {
    const sorted = verified.slice().sort((a, b) => {
        const rDiff = sourceRank(a) - sourceRank(b);
        if (rDiff !== 0) return rDiff;
        return (a._order || 0) - (b._order || 0);
    });

    // فصل بصمة التكرار بين SRT و ASS حتى لا يقوم ملف SRT بحذف ملف ASS يحمل نفس النص
    const seenSrtSig = new Set();
    const seenAssSig = new Set();

    const srt = [];
    const ass = [];

    for (const s of sorted) {
        if (s.format === 'ass') {
            if (!seenAssSig.has(s._sig)) {
                seenAssSig.add(s._sig);
                ass.push(s);
            }
        } else {
            if (!seenSrtSig.has(s._sig)) {
                seenSrtSig.add(s._sig);
                srt.push(s);
            }
        }
    }

    return {
        good: [...ass, ...srt],
        value: { srt, ass }
    };
}

async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const t0 = Date.now();
    console.log(`[جلب عربي] جاري البحث عن ترجمات عربية (جاهزة + مصحح) للعمل: ${imdbId}...`);

    const keyHash = crypto.createHash('md5').update(`${subdlKey || ''}|${subsourceKey || ''}`).digest('hex').slice(0, 8);
    const cacheKey = `${imdbId}:${season}:${episode}:${keyHash}`;
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.time < RESULT_TTL) {
        console.log(`[جلب عربي] النتيجة من الكاش (${hit.value.srt.length} SRT و ${hit.value.ass.length} ASS).`);
        return hit.value;
    }

    const sourceDefs = [
        { key: 'os_legacy', name: 'OS Legacy (ASS)', run: () => fetchOsLegacyArabic(imdbId, season, episode) },
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type) }
    ];
    const names = sourceDefs.map(d => d.name);

    const settled = await Promise.allSettled(
        sourceDefs.map(d => withTimeout(Promise.resolve().then(d.run), SOURCE_TIMEOUTS[d.key], d.name))
    );

    settled.forEach((r, i) => {
        if (r.status === 'rejected') console.log(`[جلب عربي - ${names[i]}] خطأ غير متوقع: ${r.reason && r.reason.message}`);
    });
    console.log('[جلب عربي] ملخص المصادر: ' + settled.map((r, i) => `${names[i]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | ') + ` (بعد ${((Date.now() - t0) / 1000).toFixed(1)} ثانية)`);

    // دمج بالتناوب بين المصادر لضمان فحص جميع المواقع بعدالة خلال الـ 5 ثوانٍ الأولى
    const lists = settled.map((r, idx) => {
        const arr = (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value : [];
        const srcKey = sourceDefs[idx].key;
        return arr.map(item => ({ ...item, _source: item._source || srcKey }));
    });

    const interleaved = [];
    const maxLen = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
        for (const l of lists) {
            if (l[i]) interleaved.push(l[i]);
        }
    }

    const seenUrls = new Set();
    const uniqueSubs = interleaved.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    const toVerify = uniqueSubs.slice(0, MAX_CANDIDATES);
    const epInfo = (season != null && episode != null) ? { season, episode } : null;

    // منح الفحص واستخراج الـ ZIP والـ ASS مدة 5 ثوانٍ كاملة
    const job = startVerification(toVerify, subsourceKey, epInfo, VERIFY_WINDOW_MS);
    await job.windowPromise;

    const snapshot = job.results.slice();
    const { good, value } = buildValue(snapshot);
    console.log('[جلب عربي] الشغالة حسب المصدر: ' + good.map(s => `${s._source}/${s.format}`).join(' | '));
    console.log(`[جلب عربي] بعد الفحص الأولي: ${snapshot.length}/${toVerify.length} شغالة، ${good.length} صافية بعد حذف المكرر → ${value.srt.length} SRT و ${value.ass.length} ASS | الزمن الكلي ${((Date.now() - t0) / 1000).toFixed(1)} ثانية.`);

    if (good.length > 0) resultCache.set(cacheKey, { time: Date.now(), value });

    // استكمال فحص باقي الروابط في الخلفية (إن وجدت) وتحديث الكاش
    job.allPromise.then(() => {
        if (job.results.length > snapshot.length) {
            const full = buildValue(job.results);
            if (full.good.length > 0) {
                resultCache.set(cacheKey, { time: Date.now(), value: full.value });
                console.log(`[جلب عربي] اكتمل الفحص الخلفي للكاش: ${full.value.srt.length} SRT و ${full.value.ass.length} ASS (من أصل ${toVerify.length} رابط).`);
            }
        }
    }).catch(() => {});

    return value;
}

// دالة جلب النص الجاهز فوراً عند ضغط المستخدم على الترجمة الجاهزة في المشغل
async function getRawArabicSubContent(targetUrl, subsourceKey, epInfo = null) {
    const key = makeRawCacheKey(targetUrl, epInfo);
    const cached = rawContentCache.get(key);
    if (cached && cached.text) {
        return cached.text;
    }

    const { fetchAndExtractSub } = require('./ai').shared;
    const text = await fetchAndExtractSub(targetUrl, subsourceKey, epInfo);
    if (text && typeof text === 'string') {
        saveRawContent(targetUrl, epInfo, text);
        return text;
    }
    throw new Error('تعذر استخراج ملف الترجمة الجاهزة');
}

module.exports = { getArabicSubsForCorrection, getRawArabicSubContent };
