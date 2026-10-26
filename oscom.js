const axios = require('axios');
module.exports = { getOsCom, isOsComUrl, isOsComConfigured, downloadOsComText, setOsComCreds };
const DEFAULT_HOST = 'api.opensubtitles.com';
const APP_UA = 'NuvioAISubs v1.0';
const SEARCH_TIMEOUT = 3000;
const LOGIN_TTL = 20 * 60 * 60 * 1000;
const TEXT_TTL = 2 * 60 * 60 * 1000;
const MAX_TEXT_CACHE = 60;
const badExtRe = /\.(rar|7z|zip|sub|idx|vtt|smi|txt)$/i;
const assFileRe = /\.(ass|ssa)$/i;
const fileUrlRe = /\/oscom\/file\/(\d+)/i;
let session = null;
let loginPromise = null;
let blockedUntil = 0;
const textCache = new Map();
let cfgCreds = null;
function setOsComCreds(c) {
    const next = {
        apiKey: String((c && c.apiKey) || '').trim(),
        username: String((c && c.username) || '').trim(),
        password: String((c && c.password) || '')
    };
    if (!next.apiKey || !next.username || !next.password) return;
    const changed = !cfgCreds || cfgCreds.apiKey !== next.apiKey || cfgCreds.username !== next.username || cfgCreds.password !== next.password;
    cfgCreds = next;
    if (changed) { session = null; blockedUntil = 0; }
}
function getCreds() {
    if (cfgCreds) return cfgCreds;
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
    try {
        const res = await axios.post('https://' + DEFAULT_HOST + '/api/v1/login', { username, password }, {
            headers: buildHeaders(),
            timeout: 5000,
            validateStatus: () => true
        });
        if (res.status !== 200 || !res.data || !res.data.token) {
            const msg = res.data && (res.data.message || res.data.error);
            console.log('[جلب عربي - opensubtitles.com] فشل تسجيل الدخول HTTP ' + res.status + (msg ? ' - ' + msg : ''));
            return null;
        }
        const host = String(res.data.base_url || DEFAULT_HOST).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        session = { token: res.data.token, host, exp: Date.now() + LOGIN_TTL };
        console.log('[جلب عربي - opensubtitles.com] تم تسجيل الدخول');
        return session;
    } catch (e) {
        console.log('[جلب عربي - opensubtitles.com] خطأ تسجيل الدخول: ' + e.message);
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
        console.log('[جلب عربي - opensubtitles.com] غير مفعّل: ناقص مفتاح OS.com أو اسم المستخدم أو كلمة المرور في صفحة الإعداد.');
        return [];
    }
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const numericId = imdbId.replace(/^tt0*/, '');
    const isSeries = season != null && episode != null;
    const params = isSeries
        ? { episode_number: episode, languages: 'ar', order_by: 'download_count', order_direction: 'desc', parent_imdb_id: numericId, season_number: season }
        : { imdb_id: numericId, languages: 'ar', order_by: 'download_count', order_direction: 'desc' };
    const host = (session && Date.now() < session.exp) ? session.host : DEFAULT_HOST;
    try {
        const res = await axios.get('https://' + host + '/api/v1/subtitles?' + buildQuery(params), {
            headers: buildHeaders(),
            timeout: SEARCH_TIMEOUT,
            validateStatus: () => true
        });
        if (res.status !== 200) {
            const msg = res.data && (res.data.message || res.data.error);
            console.log('[جلب عربي - opensubtitles.com] بحث HTTP ' + res.status + (msg ? ' - ' + msg : ''));
            return [];
        }
        const rows = Array.isArray(res.data && res.data.data) ? res.data.data : [];
        const good = rows
            .map(r => r && r.attributes)
            .filter(a => a && !a.foreign_parts_only && !a.machine_translated && (!a.language || /^ar/i.test(String(a.language))))
            .sort(compareRank);
        const out = [];
        for (const a of good) {
            const files = Array.isArray(a.files) ? a.files : [];
            for (const f of files) {
                if (!f || !f.file_id) continue;
                const name = String(f.file_name || a.release || '');
                if (badExtRe.test(name)) continue;
                const isAss = assFileRe.test(name);
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
        const nAss = out.filter(x => x.format === 'ass').length;
        console.log('[جلب عربي - opensubtitles.com] رجع ' + rows.length + ' | بعد الفلترة: SRT=' + (out.length - nAss) + ' ASS=' + nAss);
        return out;
    } catch (e) {
        console.log('[جلب عربي - opensubtitles.com] خطأ: ' + e.message);
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
    const cached = textCache.get(id);
    if (cached && Date.now() - cached.time < TEXT_TTL) return cached.text;
    if (Date.now() < blockedUntil) throw new Error('حصة تحميل OS.com خلصت مؤقتاً');
    let s = await login(false);
    if (!s) throw new Error('OS.com: تسجيل الدخول ما نجح');
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
        res = await axios.post('https://' + s.host + '/api/v1/download', { file_id: Number(id) }, {
            headers: buildHeaders({ Authorization: 'Bearer ' + s.token }),
            timeout: 4000,
            validateStatus: () => true
        });
        if (res.status === 401 && attempt === 0) {
            session = null;
            s = await login(true);
            if (!s) throw new Error('OS.com: إعادة تسجيل الدخول فشلت');
            continue;
        }
        break;
    }
    const d = res.data || {};
    if (!d.link) {
        if (res.status === 406 || d.remaining === 0) {
            const until = Date.parse(d.reset_time_utc || '');
            blockedUntil = (!isNaN(until) && until > Date.now()) ? until : Date.now() + 30 * 60 * 1000;
            console.log('[جلب عربي - opensubtitles.com] حصة التحميل خلصت: ' + (d.message || ''));
        }
        throw new Error('OS.com download HTTP ' + res.status + (d.message ? ' - ' + d.message : ''));
    }
    const file = await axios.get(d.link, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: { 'User-Agent': APP_UA },
        validateStatus: () => true
    });
    if (file.status !== 200) throw new Error('OS.com file HTTP ' + file.status);
    const text = decodeSubBuffer(file.data);
    if (!text.trim()) throw new Error('OS.com: الملف فارغ');
    setTextCache(id, text);
    return text;
}
