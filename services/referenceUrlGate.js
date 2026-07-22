'use strict';

/**
 * referenceUrlGate.js
 *
 * Validates ANY user-supplied image URL before it's sent to a paid provider
 * (fal/OpenAI/Gemini) or re-fetched by our backend.
 *
 * WHY THIS EXISTS:
 *   Your current flow lets uploads go through uploadController → R2 and
 *   returns a URL. Good. BUT urlToAdController.js scrapes competitor sites
 *   and shoves those image URLs into generation payloads as
 *   referenceImageUrl. And StudioPage.tsx also accepts arbitrary URLs via
 *   `onReferenceImageChange`. That means:
 *
 *     1. A malicious prompt could set referenceImageUrl to
 *        http://169.254.169.254/latest/meta-data/ → SSRF to AWS metadata
 *     2. A data: URI could be passed → providers 422
 *     3. A third-party image host could rate-limit your fal.ai account
 *     4. An expired/moved URL causes silent Kling failure (no image loaded)
 *
 * WHAT THIS DOES:
 *   1. Parses the URL and rejects non-http(s), data:, file:, ftp:
 *   2. Resolves the hostname and blocks private/loopback/metadata IPs
 *   3. Does a HEAD request to confirm the resource exists + is an image
 *   4. Optionally re-hosts non-Qumak URLs to R2 so our providers get a
 *      stable, trusted URL (prevents "the ref image 404'd halfway through")
 */

const dns = require('dns').promises;
const net = require('net');
const { uploadBufferToR2 } = require('./storageService');

// ─── Config ────────────────────────────────────────────────────────────────

// URLs on these hosts are trusted — passed through without re-hosting.
// Add your R2 CDN domain here.
const TRUSTED_HOSTS = new Set([
  'qumak.io',
  'cdn.qumak.io',
  'r2.qumak.io',
  // fal.ai hosts its own generated media — trust it for chaining
  'fal.media',
  'v3.fal.media',
  'v3b.fal.media',
  // R2 domain placeholders — replace with yours
  'cdn.cloudflare.com',
]);

// Block these private/reserved ranges in addition to DNS resolution check.
// This catches raw IPs in URLs (http://10.0.0.1/...) that skip DNS.
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 127) return true;                                   // 127.0.0.0/8 loopback
    if (parts[0] === 169 && parts[1] === 254) return true;              // 169.254.0.0/16 link-local + AWS metadata
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;              // 192.168.0.0/16
    if (parts[0] === 0) return true;                                     // 0.0.0.0/8
    if (parts[0] >= 224) return true;                                    // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;                   // loopback
    if (lower.startsWith('fe80:')) return true;         // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower === '::') return true;
    return false;
  }
  return true; // unknown format = block
}

const MAX_HEAD_TIMEOUT_MS = 4000;
const ALLOWED_MIME_PREFIXES = ['image/', 'video/']; // video refs allowed for video models
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024; // 25MB — matches fal's upper limit

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Validates a reference URL. Returns { ok, url, reason }.
 *
 * If URL is trusted and reachable: ok:true, url unchanged.
 * If URL is untrusted but reachable: ok:true, url unchanged (for now — future
 *   improvement is to re-host to R2 here and return the new URL).
 * If URL fails any check: ok:false with a specific reason string.
 */
async function validateReferenceUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'URL is required' };
  }

  // 1. Parse & check scheme
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_e) {
    return { ok: false, reason: 'malformed URL' };
  }

  if (parsed.protocol === 'data:') {
    return { ok: false, reason: 'data: URIs not allowed — upload the file first via POST /studio/upload/reference' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: `${parsed.protocol} URLs not allowed` };
  }

  // 2. Block private IPs directly embedded in the URL
  const hostname = parsed.hostname;
  if (net.isIP(hostname) && isPrivateIP(hostname)) {
    return { ok: false, reason: 'private IP address not allowed' };
  }

  // 3. If not a trusted host, resolve DNS and check for private IPs. This
  //    stops the "DNS rebind" SSRF where a hostname resolves to 169.254.
  const isTrusted = TRUSTED_HOSTS.has(hostname)
    || [...TRUSTED_HOSTS].some(h => hostname.endsWith('.' + h));

  if (!isTrusted && !net.isIP(hostname)) {
    try {
      const addrs = await Promise.race([
        dns.lookup(hostname, { all: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dns_timeout')), 2000)),
      ]);
      if (addrs.some(a => isPrivateIP(a.address))) {
        return { ok: false, reason: 'hostname resolves to a private IP' };
      }
    } catch (err) {
      return { ok: false, reason: `DNS lookup failed: ${err.message}` };
    }
  }

  // 4. HEAD request — confirm the resource exists, is an image, and isn't
  //    larger than our provider limits.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MAX_HEAD_TIMEOUT_MS);
    const head = await fetch(rawUrl, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'QumakStudio/1.0 (ref-check)' },
    });
    clearTimeout(t);

    if (!head.ok) {
      // Some CDNs 405 HEAD. Retry with Range GET to 1 byte.
      if (head.status === 405 || head.status === 501) {
        return await rangeGetValidate(rawUrl);
      }
      return { ok: false, reason: `reference returned ${head.status}` };
    }

    const contentType = (head.headers.get('content-type') || '').toLowerCase();
    const contentLength = parseInt(head.headers.get('content-length') || '0', 10);

    if (!ALLOWED_MIME_PREFIXES.some(p => contentType.startsWith(p))) {
      return { ok: false, reason: `content-type '${contentType}' is not an image/video` };
    }
    if (contentLength > MAX_REFERENCE_BYTES) {
      return { ok: false, reason: `file too large (${contentLength} bytes)` };
    }

    // Re-host untrusted URLs to R2 so downstream providers always get a
    // stable Qumak CDN URL — no third-party rate limiting or CDN expiry.
    if (!isTrusted) {
      try {
        const dlCtrl = new AbortController();
        const dlTimer = setTimeout(() => dlCtrl.abort(), 15000);
        const dlResp = await fetch(rawUrl, {
          signal: dlCtrl.signal, redirect: 'follow',
          headers: { 'User-Agent': 'QumakStudio/1.0 (ref-rehost)' },
        });
        clearTimeout(dlTimer);
        if (dlResp.ok) {
          const buf = Buffer.from(await dlResp.arrayBuffer());
          const ext = (contentType.split('/')[1] || 'jpg').split(';')[0].replace(/[^a-z0-9]/gi, '');
          const key = `studio-references/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext || 'jpg'}`;
          const r2Url = await uploadBufferToR2({ buffer: buf, key, contentType });
          if (r2Url) {
            return { ok: true, url: r2Url, contentType, isTrusted: true, rehosted: true };
          }
        }
      } catch (_dlErr) {
        // Re-hosting failed — fall through and return original URL.
        // Provider might still succeed if the URL is accessible from their network.
      }
    }

    return { ok: true, url: rawUrl, contentType, contentLength, isTrusted };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'reference HEAD timed out (4s)' };
    }
    return { ok: false, reason: `HEAD failed: ${err.message}` };
  }
}

// Some CDNs (including Google Storage signed URLs) don't support HEAD.
// Fall back to a ranged GET of the first byte to confirm existence + type.
async function rangeGetValidate(rawUrl) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MAX_HEAD_TIMEOUT_MS);
    const resp = await fetch(rawUrl, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-0', 'User-Agent': 'QumakStudio/1.0' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    // Accept 206 Partial Content or 200 OK
    if (resp.status !== 206 && resp.status !== 200) {
      return { ok: false, reason: `reference returned ${resp.status}` };
    }
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ALLOWED_MIME_PREFIXES.some(p => contentType.startsWith(p))) {
      return { ok: false, reason: `content-type '${contentType}' is not an image/video` };
    }
    // Don't consume the rest of the stream
    await resp.body?.cancel?.();
    return { ok: true, url: rawUrl, contentType, isTrusted: false };
  } catch (err) {
    return { ok: false, reason: `range-GET failed: ${err.message}` };
  }
}

module.exports = {
  validateReferenceUrl,
  // Exported for tests
  isPrivateIP, TRUSTED_HOSTS,
};
