// araFetch.js
const axios = require('axios');
const crypto = require('crypto');
const { getSubDL } = require('./subdl');
const { getSubSource } = require('./subsource');

module.exports = { getArabicSubsForCorrection };

const cleanPath = p => String(p).split('?')[0];

const LEGACY_AGENTS = ['VLSub 0.10.3', 'TemporaryUserAgent'];

// ============================================================
// الأزمنة (كل التسريع هنا)
// ============================================================
// أقصى زمن كلي للطلب (جلب المصادر + التحقق). بعده نرجع اللي تحقق منه فقط.
// كان عمليًا بلا سقف (جلب مفتوح + 25 ثانية تحقق).
const TOTAL_BUDGET_MS = 12000;

// سقف جلب القوائم لكل مصدر (إذا تأخر مصدر نتجاهله ونكمل بالباقي)
const SOURCE_TIMEOUTS = { os_legacy: 4500, os_mirror: 4000, subdl: 5000, subsource: 5000 };

// أقصى زمن لتحقق ترجمة واحدة (كان 25000). بعد سقف الطلب يكمل بالخلفية فقط لتعبئة الكاش.
const VERIFY_TIMEOUT_MS = 12000;

// بعد هذا الزمن من بدء التحقق: أرجع فورًا بمجرد ما تنجح أول ترجمة (كان 6000)
const SOFT_DEADLINE_MS = 3500;

// كم ترجمة نتحقق منها لكل مصدر (كان 2 / 2 / 8 / 8). تقليلها يخفف الضغط على Render المجاني.
const VERIFY_PER_SOURCE = { os_legacy: 2, os_mirror: 2, subdl: 6, subsource: 6 };

const RESULT_TTL = 30 * 60 * 1000;
const resultCache = new Map();

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

async function fetchOsLegacyArabic(imdbId, season, episode) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const hasSE = season != null && episode != null;

    const primaryUrl = hasSE
        ? `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`
        : `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;

    async function fetchLegacyData(url) {
        let response;
        for (let i = 0; i < LEGACY_AGENTS.length; i++) {
            const ua = LEGACY_AGENTS[i];
            response = await fetch(url, {
                headers: { 'User-Agent': ua, 'X-User-Agent': ua, 'Accept': 'application/json' }
            });
            console.log(`[جلب عربي - OS Legacy] ${response.status}${i > 0 ? ` (محاولة ثانية: ${ua})` : ''} <- ${url}`);
            if (response.status !== 403) break;
        }
        if (!response || !response.ok) return [];
        const json = await response.json();
        return Array.isArray(json) ? json : [];
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
        const assOnly = data.filter(e => e.SubDownloadLink && isAssEntry(e)).map(e => ({
            url: e.SubDownloadLink,
            format: 'ass',
            fileName: e.SubFileName || e.MovieReleaseName || 'OS_Legacy_Ara',
            _source: 'os_legacy'
        }));
        console.log(`[جلب عربي - OS Legacy] رجع ${total} نتيجة، المعتمد ASS فقط: ${assOnly.length} (الـ SRT مستبعد).`);
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
                const isAss = subFormat === 'ssa' || subFormat === 'ass' || /\.(ass|ssa)/.test(rawUrl);
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
        const cues = extractCuesUniversal(text);
        const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
        if (cues.length < 10 || arabic < 200) {
            console.log(`[فحص عربي] ✗ ${s._source}: ليس عربياً أو فارغ (cues=${cues.length}, arabic=${arabic}) <- ${s.url}`);
            return null;
        }
        const sig = crypto.createHash('md5')
            .update(cues.map(c => c.text).join('').replace(/[^\p{L}\p{N}]+/gu, ''))
            .digest('hex');
        const realFormat = /^\s*Dialogue:/im.test(text) ? 'ass' : 'srt';
        return { ...s, format: realFormat, _sig: sig };
    } catch (e) {
        console.log(`[فحص عربي] ✗ ${s._source}: ${e.message} <- ${s.url}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// يبدأ فحص كل الترجمات بالتوازي.
// early: يكتمل (1) بمجرد نجاح أول ترجمة بعد SOFT_DEADLINE_MS، أو (2) عند انتهاء الكل، أو (3) عند hardMs مهما كان.
// all: يكتمل لما تنتهي كل الفحوصات (حتى بعد ما نكون رجعنا الرد) لنحدّث الكاش بالنتيجة الكاملة.
function startVerification(list, subsourceKey, epInfo, hardMs) {
    const results = [];
    let softPassed = false, done = false, soft, hard, resolveEarly;
    const early = new Promise(r => { resolveEarly = r; });

    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(soft);
        clearTimeout(hard);
        resolveEarly();
    };
    const check = () => { if (softPassed && results.length) finish(); };

    if (!list.length) {
        finish();
        return { results, early, all: Promise.resolve() };
    }

    soft = setTimeout(() => { softPassed = true; check(); }, SOFT_DEADLINE_MS);
    hard = setTimeout(finish, hardMs);

    const all = Promise.all(list.map(s =>
        verifyArabicSub(s, subsourceKey, epInfo)
            .catch(() => null)
            .then(r => { if (r) { results.push(r); check(); } })
    )).then(finish);

    return { results, early, all };
}

const ASS_ORDER = { subdl: 0, subsource: 1, os_legacy: 2, os_mirror: 3 };
const assRank = s => (s.format === 'ass' ? (ASS_ORDER[s._source] ?? 9) : 0);

function buildValue(verified) {
    const sorted = verified.slice().sort((a, b) => assRank(a) - assRank(b));
    const seenSig = new Set();
    const good = sorted.filter(s => !seenSig.has(s._sig) && seenSig.add(s._sig));
    return {
        good,
        value: {
            srt: good.filter(s => s.format === 'srt'),
            ass: good.filter(s => s.format === 'ass')
        }
    };
}

async function getArabicSubsForCorrection({ imdbId, season, episode, type, subdlKey, subsourceKey }) {
    const t0 = Date.now();
    console.log(`[جلب عربي] جاري البحث عن ترجمات عربية جاهزة للتصحيح للعمل: ${imdbId}...`);

    const keyHash = crypto.createHash('md5').update(`${subdlKey || ''}|${subsourceKey || ''}`).digest('hex').slice(0, 8);
    const cacheKey = `${imdbId}:${season}:${episode}:${keyHash}`;
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.time < RESULT_TTL) {
        console.log('[جلب عربي] النتيجة من الكاش.');
        return hit.value;
    }

    const sourceDefs = [
        { key: 'os_legacy', name: 'OS Legacy (ASS)', run: () => fetchOsLegacyArabic(imdbId, season, episode) },
        { key: 'os_mirror', name: 'OS Mirror', run: () => fetchOsMirrorArabic(imdbId, season, episode, type) },
        { key: 'subdl', name: 'SubDL', run: () => getSubDL({ imdbId, season, episode, apiKey: subdlKey, languages: ['AR'], includePacks: true }) },
        { key: 'subsource', name: 'Subsource', run: () => getSubSource({ imdbId, season, episode, apiKey: subsourceKey, language: 'arabic' }) }
    ];
    const names = sourceDefs.map(d => d.name);

    // كل مصدر له سقف زمني؛ أي مصدر يتأخر نتجاهله بدل ما ننتظره
    const settled = await Promise.allSettled(
        sourceDefs.map(d => withTimeout(Promise.resolve().then(d.run), SOURCE_TIMEOUTS[d.key], d.name))
    );

    settled.forEach((r, i) => {
        if (r.status === 'rejected') console.log(`[جلب عربي - ${names[i]}] خطأ غير متوقع: ${r.reason && r.reason.message}`);
    });
    console.log('[جلب عربي] ملخص المصادر: ' + settled.map((r, i) => `${names[i]}=${r.status === 'fulfilled' ? r.value.length : 'خطأ'}`).join(' | ') + ` (بعد ${((Date.now() - t0) / 1000).toFixed(1)} ثانية)`);

    const lists = settled.map(r => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []));
    const interleaved = [];
    const maxLen = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) for (const l of lists) if (l[i]) interleaved.push(l[i]);

    const seenUrls = new Set();
    const uniqueSubs = interleaved.filter(s => {
        if (!s || !s.url) return false;
        const clean = cleanPath(s.url);
        if (seenUrls.has(clean)) return false;
        seenUrls.add(clean);
        return true;
    });

    const bySource = src => uniqueSubs.filter(s => s._source === src);
    const toVerify = [
        ...bySource('os_legacy').slice(0, VERIFY_PER_SOURCE.os_legacy),
        ...bySource('os_mirror').slice(0, VERIFY_PER_SOURCE.os_mirror),
        ...bySource('subdl').slice(0, VERIFY_PER_SOURCE.subdl),
        ...bySource('subsource').slice(0, VERIFY_PER_SOURCE.subsource)
    ];

    const epInfo = (season != null && episode != null) ? { season, episode } : null;

    // الوقت المتبقي من الميزانية الكلية للتحقق (حد أدنى 1.5 ثانية)
    const hardMs = Math.max(1500, TOTAL_BUDGET_MS - (Date.now() - t0));
    const job = startVerification(toVerify, subsourceKey, epInfo, hardMs);
    await job.early;

    const snapshot = job.results.slice();
    const { good, value } = buildValue(snapshot);
    console.log('[جلب عربي] الشغالة حسب المصدر: ' + good.map(s => `${s._source}/${s.format}`).join(' | '));
    console.log(`[جلب عربي] بعد الفحص: ${snapshot.length}/${toVerify.length} شغالة، ${good.length} بعد حذف المكرر → ${value.srt.length} SRT و ${value.ass.length} ASS | الزمن الكلي ${((Date.now() - t0) / 1000).toFixed(1)} ثانية.`);

    if (good.length > 0) resultCache.set(cacheKey, { time: Date.now(), value });

    // الفحوصات المتأخرة تكمل بالخلفية، وإذا لقت ترجمات زيادة نحدّث الكاش للطلب الجاي
    job.all.then(() => {
        if (job.results.length > snapshot.length) {
            const full = buildValue(job.results);
            if (full.good.length > 0) {
                resultCache.set(cacheKey, { time: Date.now(), value: full.value });
                console.log(`[جلب عربي] تحديث الكاش بالخلفية: ${full.value.srt.length} SRT و ${full.value.ass.length} ASS (كانت ${value.srt.length + value.ass.length}).`);
            }
        }
    }).catch(() => {});

    return value;
}
