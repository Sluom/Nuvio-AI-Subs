'use strict';

const { createHash } = require('crypto');

const parseKeys = raw => [...new Set(String(raw || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
const keyHash = key => createHash('sha256').update(String(key).trim(), 'utf8').digest('hex');
const authorized = (keys, hashes) => Array.isArray(keys) && keys.some(key => typeof key === 'string' && hashes.includes(keyHash(key)));
const estimateTokens = text => {
  let ascii = 0, other = 0;
  for (const c of String(text || '')) { if (c.codePointAt(0) < 128) ascii++; else other++; }
  return Math.ceil(ascii / 3 + other * 1.4) + 32;
};

function retryAfterMs(headers, now = Date.now()) {
  const raw = headers && (typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after']);
  if (raw == null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.ceil(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function createGroqProvider({ axios, model, keys, maxWorkers, maxOutputTokens, reasoningEffort, tpm, rpm, onDeadKey = () => {}, timeout = 60000, maxWait = 60000, httpAgent, httpsAgent }) {
  const pool = parseKeys(Array.isArray(keys) ? keys.join(',') : keys);
  const dead = new Set(), cooldown = new Map(), busy = new Set();
  const usage = [];
  let cursor = 0, active = 0, orgUntil = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = () => pool.filter(key => !dead.has(key)).length;
  const enabled = () => alive() > 0;
  function prune(now) { while (usage.length && usage[0].at <= now - 60000) usage.shift(); }
  async function acquire(tokens, cancelled) {
    const deadline = Date.now() + maxWait;
    while (Date.now() <= deadline) {
      if (cancelled && cancelled()) return { status: 'cancelled' };
      if (!enabled()) return { status: 'no_keys' };
      const now = Date.now();
      prune(now);
      const used = usage.reduce((sum, x) => sum + x.tokens, 0);
      if (active < maxWorkers && now >= orgUntil && (!tpm || used + tokens <= tpm) && (!rpm || usage.length < rpm)) {
        for (let i = 0; i < pool.length; i++) {
          const key = pool[cursor++ % pool.length];
          if (dead.has(key) || busy.has(key) || (cooldown.get(key) || 0) > now) continue;
          busy.add(key);
          active++;
          const entry = { at: now, tokens };
          usage.push(entry);
          return { key, entry };
        }
      }
      await sleep(Math.min(250, Math.max(1, deadline - now)));
    }
    return { status: 'api_exhausted' };
  }
  async function request(prompt, { expectedOutputTokens = 512, temperature = 0.1, cancelled, onAttempt } = {}) {
    if (cancelled && cancelled()) return { status: 'cancelled' };
    const inputTokens = estimateTokens(prompt) + 64;
    const outputTokens = Math.max(128, Math.ceil(expectedOutputTokens));
    if (outputTokens > maxOutputTokens || (tpm && inputTokens + outputTokens > tpm)) {
      console.log(`[Groq split] estimated input=${inputTokens} output=${outputTokens}`);
      return { status: 'too_large' };
    }
    const lease = await acquire(inputTokens + outputTokens, cancelled);
    if (!lease.key) {
      if (lease.status !== 'cancelled') console.log(`[Groq] ${lease.status}: no available key within request budget`);
      return { status: lease.status };
    }
    const { key, entry } = lease;
    try {
      if (cancelled && cancelled()) { entry.tokens = 0; return { status: 'cancelled' }; }
      if (typeof onAttempt === 'function') onAttempt();
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_completion_tokens: outputTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort, reasoning_format: 'hidden' } : {})
      }, {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        timeout, httpAgent, httpsAgent, maxContentLength: 20 * 1024 * 1024
      });
      const actual = response.data?.usage?.total_tokens;
      if (Number.isFinite(actual) && actual >= 0) entry.tokens = actual;
      const choice = response.data?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        console.log(`[Groq] Truncated response via ...${key.slice(-4)}`);
        return { status: 'too_large' };
      }
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim() || (choice.finish_reason && choice.finish_reason !== 'stop')) return { status: 'bad_format' };
      return { status: 'ok', text, keySuffix: key.slice(-4) };
    } catch (e) {
      const status = Number(e?.response?.status || 0);
      if (status === 401) {
        entry.tokens = 0;
        if (!dead.has(key)) {
          dead.add(key);
          const suffix = key.slice(-4);
          console.log(`[Groq dead key] ...${suffix} (HTTP 401)`);
          try { onDeadKey(suffix); } catch {}
        }
        return { status: enabled() ? 'retry' : 'no_keys' };
      }
      if (status === 429) {
        entry.tokens = 0;
        const cd = Math.max(1000, retryAfterMs(e.response?.headers) ?? 60000);
        orgUntil = Math.max(orgUntil, Date.now() + cd);
        console.log(`[Groq rate limit] ...${key.slice(-4)} retry after ${Math.ceil(cd / 1000)}s`);
        return { status: 'retry' };
      }
      if (status === 413 || (status === 400 && /context.length|too many tokens|token limit|request too large|maximum context|reduce.*tokens/i.test(String(e.response?.data?.error?.message || '')))) {
        entry.tokens = 0;
        return { status: 'too_large' };
      }
      if (status === 400 || status === 403 || status === 404 || status === 422) {
        entry.tokens = 0;
        console.log(`[Groq request error] ...${key.slice(-4)} HTTP ${status}`);
        return { status: 'config_error' };
      }
      cooldown.set(key, Date.now() + 3000);
      console.log(`[Groq transient error] ...${key.slice(-4)} HTTP ${status || 'network'}`);
      return { status: 'retry' };
    } finally {
      busy.delete(key);
      active--;
    }
  }
  return { request, enabled, alive, estimateTokens };
}

module.exports = { createGroqProvider, parseKeys, keyHash, authorized, estimateTokens, retryAfterMs };
