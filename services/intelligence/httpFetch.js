'use strict';

/**
 * httpFetch — shared HTTP helper for the Intelligence subsystem.
 *
 * Every Layer-2 collector makes outbound requests. Rather than let each of
 * them reinvent retry / UA rotation / byte-capping / SSRF guarding, they all
 * call through here. This also gives us one chokepoint to plug in a proxy
 * pool or a rotating IP service later without touching individual collectors.
 *
 * Three public functions:
 *
 *   fetchHtml(url, opts)      — GET a page, return `{ html, status }`
 *   fetchJson(url, opts)      — GET a JSON endpoint, return parsed body
 *   followRedirects(url, opts) — resolve a short-url to its final URL
 *
 * All failures throw an Error with a `code` field so callers can decide
 * whether to treat the source as "temporarily down" vs "permanently broken".
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB — intelligence sources are larger than homepages
const DEFAULT_MAX_ATTEMPTS = 3;

// Real browser strings. Rotated per-request so repeated hits don't pattern-match.
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Refuse to fetch anything that could be used to reach an internal service.
// Collectors are called with external brand URLs — never localhost, RFC1918
// ranges, or link-local. Without this, the pipeline would be an SSRF primitive.
const PRIVATE_IP_RE =
  /^(10\.|127\.|192\.168\.|169\.254\.|::1|fd|fe80|0\.0\.0\.0)/i;

function guardAgainstSsrf(urlObj) {
  const host = urlObj.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') {
    throw Object.assign(new Error(`Refusing to fetch private host: ${host}`), {
      code: 'ssrf_blocked',
    });
  }
  // Defer DNS-based checks to the network layer; pattern check catches most
  // obvious attempts (raw IPs in URLs).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_IP_RE.test(host)) {
    throw Object.assign(new Error(`Refusing to fetch private IP: ${host}`), {
      code: 'ssrf_blocked',
    });
  }
}

function hashKey(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * GET an HTML page with retries, UA rotation, and a byte cap.
 * Returns `{ html, status, finalUrl }` on success.
 *
 * opts:
 *   maxAttempts     — default 3
 *   timeoutMs       — per-attempt timeout, default 12s
 *   acceptLanguage  — `en-US,en;q=0.9,ar;q=0.8` by default (bilingual for GCC)
 *   extraHeaders    — object merged onto the request
 *   maxBytes        — byte cap, default 2MB
 */
async function fetchHtml(url, opts = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    acceptLanguage = 'en-US,en;q=0.9,ar;q=0.8',
    extraHeaders = {},
    maxBytes = MAX_BYTES,
  } = opts;

  const urlObj = new URL(url);
  guardAgainstSsrf(urlObj);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': pickUA(),
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': acceptLanguage,
          'accept-encoding': 'gzip, deflate, br',
          'cache-control': 'no-cache',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'upgrade-insecure-requests': '1',
          ...extraHeaders,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      // 403/429 is usually Cloudflare or Meta asking for JS — back off, rotate UA, retry.
      if ((resp.status === 403 || resp.status === 429) && attempt < maxAttempts) {
        await sleep(400 * attempt + Math.random() * 300);
        continue;
      }
      if (!resp.ok && resp.status >= 500 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      if (!resp.ok) {
        throw Object.assign(new Error(`HTTP ${resp.status} from ${url}`), {
          code:
            resp.status === 403 || resp.status === 429
              ? 'blocked'
              : resp.status === 404
                ? 'not_found'
                : 'fetch_failed',
          status: resp.status,
        });
      }

      const reader = resp.body?.getReader?.();
      if (!reader) {
        return { html: await resp.text(), status: resp.status, finalUrl: resp.url || url };
      }

      const chunks = [];
      let total = 0;
      let truncated = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          truncated = true;
          break;
        }
        chunks.push(value);
      }

      const html = Buffer.concat(chunks).toString('utf8');
      return { html, status: resp.status, finalUrl: resp.url || url, truncated };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = Object.assign(new Error(`Timed out fetching ${url}`), {
          code: 'fetch_timeout',
        });
      }
      if (attempt < maxAttempts) {
        await sleep(400 * attempt + Math.random() * 250);
      }
    }
  }

  if (lastErr?.code) throw lastErr;
  throw Object.assign(new Error(lastErr?.message || 'Fetch failed'), {
    code: 'fetch_failed',
  });
}

/**
 * GET a JSON endpoint. Wraps `fetchHtml` with a different Accept header and
 * JSON.parse. Throws `{ code: 'bad_json' }` if the body isn't parseable.
 */
async function fetchJson(url, opts = {}) {
  const { html, status, finalUrl } = await fetchHtml(url, {
    ...opts,
    extraHeaders: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      ...(opts.extraHeaders || {}),
    },
  });
  try {
    return { json: JSON.parse(html), status, finalUrl };
  } catch (_e) {
    throw Object.assign(new Error(`Invalid JSON from ${url}`), { code: 'bad_json' });
  }
}

/**
 * Follow redirects and return the final URL. Useful for resolving short-urls
 * that competitors use in social posts (bit.ly / lnk.bio etc) back to the
 * real landing page, which we then match against canonicalDomain.
 */
async function followRedirects(url, { timeoutMs = 6000 } = {}) {
  const urlObj = new URL(url);
  guardAgainstSsrf(urlObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': pickUA() },
      redirect: 'follow',
      signal: controller.signal,
    });
    return resp.url || url;
  } catch {
    // HEAD can fail where GET succeeds; the caller can retry with fetchHtml.
    return url;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchHtml,
  fetchJson,
  followRedirects,
  pickUA,
  hashKey,
  sleep,
};
