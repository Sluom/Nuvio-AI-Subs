const axios = require('axios');

// ============================================================
//  OpenSubtitles.com (الموقع الجديد) - احتياطي
//  المفاتيح تُقرأ من Render فقط (Environment) بهذه الأسماء:
//    OSCOM_API_KEY  = مفتاح API
//    OSCOM_USER     = اسم المستخدم
//    OSCOM_PASS     = الباسورد
//  لازم الثلاثة معاً، وإلا يبقى الموقع متوقف بدون أي خطأ.
//
//  وضع الاختبار (اختياري):
//    OSCOM_TEST = 1   -> يلغي كل الأسقف الزمنية لـ OS.com (بحث/دخول/تحميل)
//                        ويتجاوز كاش النصوص حتى تظهر الأزمنة الحقيقية.
//  احذف المتغير لرجوع السلوك الأصلي.
// ============================================================

module.exports = { getOsCom, isOsComUrl, isOsComConfigured, downloadOsComText };

const TEST = process.env.OSCOM_TEST === '1';
const TEST_TIMEOUT = 120000;

const DEFAULT_HOST = 'api.opensubtitles.com';
const APP_UA = 'NuvioAISubs v1.0';
const SEARCH_TIMEOUT = TEST ? TEST_TIMEOUT : 3000;
const LOGIN_TIMEOUT = TEST ? TEST_TIMEOUT : 5000;
const DOWNLOAD_API_TIMEOUT = TEST ? TEST_TIMEOUT : 4000;
const DOWNLOAD_FILE_TIMEOUT = TEST ? TEST_TIMEOUT : 5000;
const LOGIN_TTL = 20 * 60 * 60 * 1000;
const TEXT_TTL = 2 * 60 * 60 * 1000;
const MAX_TEXT_CACHE = 60;
const badExtRe = /\.(rar|7z|zip|sub|idx|vtt|smi|txt)$/i;
const assFileRe = /\.(ass|ssa)$/i;
const fileUrlRe = /\/oscom\/file\/(\d+)/i;

let session = null;
let loginPromise = null;
let blockedUntil = 0;
let loggedKeysOnce = false;
const textCache = new Map();

// ---------- محدد التحميل (يمنع 429): 3 تحميلات متزامنة كحد أقصى وفاصل بين بداياتها ----------
const DL_CONCURRENCY = 3;
const DL_GAP_MS = 250;
const RATE_RETRY_MAX = 2;
let dlActive = 0;
let dlNextStart = 0;
const dlWaiters = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireDlSlot() {
    await new Promise(resolve => {
        const go = () => { dlActive++; resolve(); };
        if (dlActive < DL_CONCURRENCY) go(); else dlWaiters.push(go);
    });
    const now = Date.now();
    const startAt = Math.max(now, dlNextStart);
    dlNextStart = startAt + DL_GAP_MS;
    if (startAt > now) await sleep(startAt - now);
}

function releaseDlSlot() {
    dlActive--;
    const next = dlWaiters.shift();
    if (next) next();
}

function retryWaitMs(res) {
    const ra = Number(res && res.headers && res.headers['retry-after']);
    return (ra > 0 && ra <= 3) ? Math.round(ra * 1000) : 1000;
}

// ---------- أدوات اللوغ ----------
const pad = (n, w) => String(n).padStart(w, '0');
function clk() {
    const d = new Date();
    return pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + '.' + pad(d.getUTCMilliseconds(), 3);
}
const sec = ms => (ms / 1000).toFixed(1) + 'ث';
function extOf(name) {
    const m = String(name || '').match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : 'بدون';
}
function sniffType(buf) {
    if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) return 'zip';
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) return 'gz';
    if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) return 'utf16';
    return 'نص';
}

function getCreds() {
    return {
        apiKey: String(process.env.OSCOM_API_KEY || '').trim(),
        username: String(process.env.OSCOM_USER || '').trim(),
        password: String(process.env.OSCOM_PASS || '')
    };
}

function isOsComConfigured() {
    const { apiKey, username, password } = getCreds();
    return !!(apiKey && username && password);
}

function buildHeaders(extra) {
    return Object.assign({
        'Api-Key': getCreds().apiKey,
        'User-Agent': APP_UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }, extra || {});
}

function buildQuery(params) {
    return Object.keys(params).sort()
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');
}

function isOsComUrl(url) {
    const m = String(url || '').match(fileUrlRe);
    return m ? m[1] : null;
}

async function doLogin() {
    const { apiKey, username, password } = getCreds();
    const t0 = Date.now();
    try {
        const res = await axios.post('https://' + DEFAULT_HOST + '/api/v1/login', { username, password }, {
            headers: buildHeaders(),
            timeout: LOGIN_TIMEOUT,
            validateStatus: () => true
        });
        if (res.status !== 200 || !res.data || !res.data.token) {
            const msg = res.data && (res.data.message || res.data.error);
            console.log('[جلب عربي - OS.com] فشل تسجيل الدخول HTTP ' + res.status + (msg ? ' - ' + msg : '') + ' (' + sec(Date.now() - t0) + ')');
            return null;
        }
        const host = String(res.data.base_url || DEFAULT_HOST).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        session = { token: res.data.token, host, exp: Date.now() + LOGIN_TTL };
        console.log('[جلب عربي - OS.com] تم تسجيل الدخول (' + sec(Date.now() - t0) + ')');
        return session;
    } catch (e) {
        console.log('[جلب عربي - OS.com] خطأ تسجيل الدخول: ' + e.message + ' (' + sec(Date.now() - t0) + ')');
        return null;
    }
}

async function login(force) {
    if (!force && session && Date.now() < session.exp) return session;
    if (loginPromise) return loginPromise;
    loginPromise = doLogin().finally(() => { loginPromise = null; });
    return loginPromise;
}

function rankTuple(a) {
    return [
        a.ai_translated ? 0 : 1,
        a.from_trusted ? 1 : 0,
        a.hearing_impaired ? 0 : 1,
        Number(a.download_count) || 0
    ];
}

function compareRank(x, y) {
    const A = rankTuple(x), B = rankTuple(y);
    for (let i = 0; i < A.length; i++) {
        if (A[i] !== B[i]) return B[i] - A[i];
    }
    return 0;
}

async function getOsCom({ imdbId, season, episode }) {
    const { apiKey, username, password } = getCreds();
    if (!apiKey || !username || !password) {
        console.log('[جلب عربي - OS.com] غير مفعّل: ناقص OSCOM_API_KEY أو OSCOM_USER أو OSCOM_PASS في Render.');
        return [];
    }
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const isSeries = season != null && episode != null;
    const params = isSeries
        ? { episode_number: episode, languages: 'ar', order_by: 'download_count', order_direction: 'desc', parent_imdb_id: numericId, season_number: season }
        : { imdb_id: numericId, languages: 'ar', order_by: 'download_count', order_direction: 'desc' };
    const host = (session && Date.now() < session.exp) ? session.host : DEFAULT_HOST;
    const tSearch0 = Date.now();
    try {
        const res = await axios.get('https://' + host + '/api/v1/subtitles?' + buildQuery(params), {
            headers: buildHeaders(),
            timeout: SEARCH_TIMEOUT,
            validateStatus: () => true
        });
        const took = Date.now() - tSearch0;
        if (res.status !== 200) {
            const msg = res.data && (res.data.message || res.data.error);
            console.log('[جلب عربي - OS.com] بحث HTTP ' + res.status + (msg ? ' - ' + msg : '') + ' (' + sec(took) + ')');
            return [];
        }
        const body = res.data || {};
        const rows = Array.isArray(body.data) ? body.data : [];
        const total = body.total_count, pages = body.total_pages, page = body.page, perPage = body.per_page;
        console.log('[جلب عربي - OS.com] بحث ' + sec(took) + ' | عند الموقع ' + (total != null ? total : '?') + ' نتيجة في ' + (pages != null ? pages : '?') + ' صفحة | جلبت الصفحة ' + (page != null ? page : '?') + ' (' + rows.length + ' نتيجة، ' + (perPage != null ? perPage : '?') + ' لكل صفحة)' + (Number(total) > rows.length ? ' ⚠️ فيه ' + (Number(total) - rows.length) + ' نتيجة ما جلبتها' : ''));

        if (!loggedKeysOnce && rows[0] && rows[0].attributes) {
            loggedKeysOnce = true;
            const a0 = rows[0].attributes;
            const f0 = Array.isArray(a0.files) && a0.files[0] ? Object.keys(a0.files[0]) : [];
            console.log('[جلب عربي - OS.com] حقول أول نتيجة (مرة وحدة): ' + Object.keys(a0).join(',') + ' | حقول الملف: ' + f0.join(','));
        }

        const drops = { noAttr: 0, foreignOnly: 0, machine: 0, otherLang: 0, noFileId: 0, badExt: {} };
        const good = [];
        for (const r of rows) {
            const a = r && r.attributes;
            if (!a) { drops.noAttr++; continue; }
            if (a.foreign_parts_only) { drops.foreignOnly++; continue; }
            if (a.machine_translated) { drops.machine++; continue; }
            if (a.language && !/^ar/i.test(String(a.language))) { drops.otherLang++; continue; }
            good.push(a);
        }
        good.sort(compareRank);

        const out = [];
        const extCounts = {};
        const assSamples = [];
        const oddSamples = [];
        for (const a of good) {
            const files = Array.isArray(a.files) ? a.files : [];
            for (const f of files) {
                if (!f || !f.file_id) { drops.noFileId++; continue; }
                const name = String(f.file_name || a.release || '');
                const ext = extOf(name);
                extCounts[ext] = (extCounts[ext] || 0) + 1;
                if (badExtRe.test(name)) {
                    drops.badExt[ext] = (drops.badExt[ext] || 0) + 1;
                    if (oddSamples.length < 3) oddSamples.push(name + ' (' + ext + ')');
                    continue;
                }
                const isAss = assFileRe.test(name);
                if (isAss && assSamples.length < 3) assSamples.push(name);
                if (!isAss && ext !== 'srt' && oddSamples.length < 3) oddSamples.push(name + ' (' + ext + ')');
                const fileId = String(f.file_id);
                out.push({
                    url: 'https://' + DEFAULT_HOST + '/oscom/file/' + fileId,
                    format: isAss ? 'ass' : 'srt',
                    fileName: name || ('OS_Com_Ara_' + fileId),
                    _source: 'opensubtitles.com',
                    _site: 'oscom',
                    _osFileId: fileId,
                    _sig: fileId
                });
            }
        }

        const extTxt = Object.keys(extCounts).map(k => k + '=' + extCounts[k]).join(' ') || '-';
        const dropParts = [];
        if (drops.noAttr) dropParts.push('بلا سمات=' + drops.noAttr);
        if (drops.foreignOnly) dropParts.push('أجزاء أجنبية فقط=' + drops.foreignOnly);
        if (drops.machine) dropParts.push('ترجمة آلية=' + drops.machine);
        if (drops.otherLang) dropParts.push('لغة أخرى=' + drops.otherLang);
        if (drops.noFileId) dropParts.push('ملف بلا file_id=' + drops.noFileId);
        for (const k of Object.keys(drops.badExt)) dropParts.push('امتداد مرفوض ' + k + '=' + drops.badExt[k]);
        console.log('[جلب عربي - OS.com] الملفات حسب الامتداد: ' + extTxt + ' | المحذوف: ' + (dropParts.join(' ، ') || 'لا شيء'));
        if (assSamples.length || oddSamples.length) {
            console.log('[جلب عربي - OS.com] عينة ASS: ' + (assSamples.join(' ، ') || '-') + ' | عينة امتدادات غريبة: ' + (oddSamples.join(' ، ') || '-'));
        }

        const nAss = out.filter(x => x.format === 'ass').length;
        console.log('[جلب عربي - OS.com] رجع ' + rows.length + ' | بعد الفلترة: SRT=' + (out.length - nAss) + ' ASS=' + nAss + ' | الزمن ' + sec(Date.now() - tSearch0));
        return out;
    } catch (e) {
        console.log('[جلب عربي - OS.com] خطأ: ' + e.message + ' (' + sec(Date.now() - tSearch0) + ')');
        return [];
    }
}

function decodeSubBuffer(data) {
    const buf = Buffer.from(data);
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    let text = new TextDecoder('utf-8').decode(buf);
    if ((text.match(/\uFFFD/g) || []).length > 5) {
        try { text = new TextDecoder('windows-1256').decode(buf); } catch { }
    }
    return text;
}

function setTextCache(id, text) {
    if (textCache.size >= MAX_TEXT_CACHE && !textCache.has(id)) {
        const oldest = textCache.keys().next().value;
        if (oldest) textCache.delete(oldest);
    }
    textCache.set(id, { time: Date.now(), text });
}

async function downloadOsComText(fileId) {
    const id = String(fileId);
    const tag = '[جلب عربي - OS.com] ملف ' + id;
    const cached = textCache.get(id);
    // في وضع الاختبار نتجاوز الكاش حتى نقيس الزمن الحقيقي
    if (!TEST && cached && Date.now() - cached.time < TEXT_TTL) return cached.text;

    const tQueue0 = Date.now();
    await acquireDlSlot();
    const queueMs = Date.now() - tQueue0;
    const T0 = Date.now();
    const startClk = clk();
    let stage = 'تسجيل الدخول';
    const t = { login: 0, link: 0, file: 0 };
    const retries = { link: 0, file: 0 };
    let remaining = null;
    const extraInfo = () =>
        (queueMs >= 50 ? ' | انتظار الدور ' + sec(queueMs) : '')
        + (retries.link || retries.file ? ' | إعادات 429: رابط=' + retries.link + ' ملف=' + retries.file : '');
    try {
        if (Date.now() < blockedUntil) {
            throw new Error('حصة تحميل OS.com خلصت مؤقتاً (باقي ' + Math.ceil((blockedUntil - Date.now()) / 60000) + ' دقيقة)');
        }
        const tl = Date.now();
        let s = await login(false);
        t.login = Date.now() - tl;
        if (!s) throw new Error('OS.com: تسجيل الدخول ما نجح');

        stage = 'طلب رابط التحميل';
        const tk = Date.now();
        let res;
        let loginRetried = false;
        for (let attempt = 0; attempt < 4; attempt++) {
            res = await axios.post('https://' + s.host + '/api/v1/download', { file_id: Number(id) }, {
                headers: buildHeaders({ Authorization: 'Bearer ' + s.token }),
                timeout: DOWNLOAD_API_TIMEOUT,
                validateStatus: () => true
            });
            if (res.status === 401 && !loginRetried) {
                loginRetried = true;
                session = null;
                s = await login(true);
                if (!s) throw new Error('OS.com: إعادة تسجيل الدخول فشلت');
                continue;
            }
            if (res.status === 429 && retries.link < RATE_RETRY_MAX) {
                retries.link++;
                const w = retryWaitMs(res);
                console.log(tag + ' | 429 عند طلب الرابط، أعيد بعد ' + w + 'ms (إعادة ' + retries.link + ')');
                await sleep(w);
                continue;
            }
            break;
        }
        t.link = Date.now() - tk;
        const d = res.data || {};
        if (d.remaining != null) remaining = d.remaining;
        if (!d.link) {
            if (res.status === 406 || d.remaining === 0) {
                const until = Date.parse(d.reset_time_utc || '');
                blockedUntil = (!isNaN(until) && until > Date.now()) ? until : Date.now() + 30 * 60 * 1000;
                console.log('[جلب عربي - OS.com] حصة التحميل خلصت: ' + (d.message || ''));
            }
            throw new Error('OS.com download HTTP ' + res.status + (d.message ? ' - ' + d.message : ''));
        }
        if (d.remaining != null) console.log('[جلب عربي - OS.com] المتبقي من حصة التحميل: ' + d.remaining);

        stage = 'تحميل الملف';
        const tf = Date.now();
        let file;
        for (let fa = 0; fa <= RATE_RETRY_MAX; fa++) {
            file = await axios.get(d.link, {
                responseType: 'arraybuffer',
                timeout: DOWNLOAD_FILE_TIMEOUT,
                headers: { 'User-Agent': APP_UA },
                validateStatus: () => true
            });
            if (file.status === 429 && fa < RATE_RETRY_MAX) {
                retries.file++;
                const w = retryWaitMs(file);
                console.log(tag + ' | 429 عند تحميل الملف، أعيد على نفس الرابط بعد ' + w + 'ms (إعادة ' + retries.file + ')');
                await sleep(w);
                continue;
            }
            break;
        }
        t.file = Date.now() - tf;
        if (file.status !== 200) throw new Error('OS.com file HTTP ' + file.status);

        stage = 'قراءة المحتوى';
        const buf = Buffer.from(file.data);
        const kind = sniffType(buf);
        const text = decodeSubBuffer(file.data);
        if (!text.trim()) throw new Error('OS.com: الملف فارغ');
        setTextCache(id, text);

        console.log(tag
            + ' | بدأ ' + startClk + ' UTC | انتهى ' + clk() + ' UTC | المدة ' + sec(Date.now() - T0)
            + ' | دخول ' + (t.login < 5 ? 'جلسة جاهزة' : sec(t.login))
            + ' | رابط ' + sec(t.link)
            + ' | ملف ' + sec(t.file) + ' (' + (buf.length / 1024).toFixed(1) + 'KB)'
            + ' | النوع: ' + kind + (kind === 'zip' || kind === 'gz' ? ' ⚠️ ملف مضغوط والكود الحالي ما يفكه' : '')
            + ' | ' + text.length + ' حرف'
            + (remaining != null ? ' | المتبقي من الحصة ' + remaining : '')
            + extraInfo());
        return text;
    } catch (e) {
        console.log(tag
            + ' | بدأ ' + startClk + ' UTC | انتهى ' + clk() + ' UTC | المدة ' + sec(Date.now() - T0)
            + ' | فشل عند: ' + stage + ' | ' + e.message + extraInfo());
        throw e;
    } finally {
        releaseDlSlot();
    }
}
