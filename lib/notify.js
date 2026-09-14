'use strict';
// Push notifications via Pushover (https://pushover.net/api).
//
// Contract this file is written against, verified from the API docs:
//   POST https://api.pushover.net/1/messages.json, form-encoded
//   required: token, user, message   optional: title, priority, sound, device, timestamp
//   200 + {"status":1}        -> delivered
//   4xx + {"status":0,errors} -> the INPUT was wrong; repeating it will never work
//   5xx                       -> retry, but no sooner than 5 seconds
//   at most 2 concurrent connections; message <= 1024 chars, title <= 250
//
// Everything here is fire-and-forget. A pool that stops mining because a
// notification service had a bad afternoon would be a much worse pool, so every
// path swallows its own errors and send() never rejects.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const ENDPOINT = 'https://api.pushover.net/1/messages.json';
const MAX_MESSAGE = 1024;
const MAX_TITLE = 250;
const MIN_RETRY_MS = 5000;   // the docs' floor, not a guess
const MAX_ATTEMPTS = 3;      // initial + 2 retries
const REQUEST_TIMEOUT_MS = 10000;

// Pushover counts characters, not bytes, and rejects the whole message if it
// runs over — losing a block notification to a long reject string would be a
// silly way to fail.
function clip(s, max) {
  const text = String(s === undefined || s === null ? '' : s);
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

// opts: { enabled, userKey, apiToken, device, sound, priority, endpoint? }
// `endpoint` is for tests only — it lets them point at a plain http server
// instead of needing TLS fixtures. Transport follows the URL scheme.
function createNotifier(opts, log) {
  const cfg = opts || {};
  const enabled = !!cfg.enabled;
  const url = new URL(cfg.endpoint || ENDPOINT);
  const transport = url.protocol === 'http:' ? http : https;
  const sleep = cfg.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = cfg.now || (() => Date.now());

  // One in flight at a time. Pushover allows two; a solo pool never needs even
  // one, and serialising keeps ordering intact so "offline" cannot arrive after
  // the "back online" that followed it.
  let chain = Promise.resolve();
  const stats = { sent: 0, failed: 0, dropped: 0, lastError: null };
  let lastAttemptAt = 0;

  function post(fields) {
    return new Promise((resolve, reject) => {
      const body = formEncode(fields);
      const req = transport.request({
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not all errors are JSON */ }
          resolve({ status: res.statusCode, body: text, parsed });
        });
      });
      req.on('error', err => reject(err));
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`pushover timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.write(body);
      req.end();
    });
  }

  async function deliver(fields) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // The 5-second floor is per connection, not per retry, so it is enforced
      // against the last attempt of any message rather than just this one's.
      const since = now() - lastAttemptAt;
      if (attempt > 1 && since < MIN_RETRY_MS) await sleep(MIN_RETRY_MS - since);
      lastAttemptAt = now();

      let res;
      try {
        res = await post(fields);
      } catch (err) {
        // Network-level: retryable.
        if (attempt === MAX_ATTEMPTS) {
          stats.failed++;
          stats.lastError = err.message;
          log.warn(`pushover: giving up after ${attempt} attempts — ${err.message}`);
          return false;
        }
        continue;
      }

      if (res.status === 200 && res.parsed && res.parsed.status === 1) {
        stats.sent++;
        return true;
      }

      // 4xx: our input was wrong. Retrying a bad token forever would just burn
      // the monthly quota, so say exactly what Pushover objected to and stop.
      if (res.status >= 400 && res.status < 500) {
        stats.dropped++;
        const why = res.parsed && Array.isArray(res.parsed.errors)
          ? res.parsed.errors.join('; ') : res.body.slice(0, 200);
        stats.lastError = why;
        log.error(`pushover rejected the message (HTTP ${res.status}): ${why} — ` +
          (res.status === 429
            ? 'monthly message limit reached'
            : 'check notify.apiToken and notify.userKey in config.json'));
        return false;
      }

      // 5xx or anything else: retryable.
      if (attempt === MAX_ATTEMPTS) {
        stats.failed++;
        stats.lastError = `HTTP ${res.status}`;
        log.warn(`pushover: giving up after ${attempt} attempts (HTTP ${res.status})`);
        return false;
      }
    }
    return false;
  }

  return {
    enabled,
    stats,

    // title/message are clipped here rather than at each call site so no caller
    // can accidentally produce a 4xx.
    send({ title, message, priority, sound, url: link, urlTitle }) {
      if (!enabled) return Promise.resolve(false);
      const fields = {
        token: cfg.apiToken,
        user: cfg.userKey,
        message: clip(message, MAX_MESSAGE),
        title: clip(title, MAX_TITLE),
        device: cfg.device,
        sound: sound || cfg.sound,
        priority: priority === undefined ? cfg.priority : priority,
        url: link,
        url_title: urlTitle,
        timestamp: Math.floor(now() / 1000),
      };
      // Never let a notification take the pool down with it.
      const p = chain.then(() => deliver(fields)).catch(err => {
        stats.failed++;
        stats.lastError = err.message;
        log.warn('pushover: unexpected failure —', err.message);
        return false;
      });
      chain = p.then(() => {}, () => {});
      return p;
    },
  };
}

module.exports = { createNotifier, formEncode, clip, ENDPOINT, MIN_RETRY_MS, MAX_ATTEMPTS };
