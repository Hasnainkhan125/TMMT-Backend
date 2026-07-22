'use strict';

/**
 * competitorValidator — kills hallucinated competitor entries before they
 * burn Apify spend.
 *
 * Bug being fixed:
 *   Claude sometimes returns "competitors" that are descriptors, not brands —
 *   "Edmunds equivalent regional sites", "Various local dealerships",
 *   "Multiple aggregators", or domains that don't exist (404 / DNS-fail).
 *   These hit the Apify FB Ads pipeline and waste spend (each call ~$0.40-0.80).
 *
 * Strategy (cheap → expensive):
 *   1. Reject obvious descriptive language in `name` (regex).
 *   2. Reject malformed `url` (must parse and have a public TLD).
 *   3. Reject competitors whose root domain matches the user's own domain.
 *   4. Optional HTTP HEAD probe — drops registrar-parked / 404 domains.
 *
 * Concurrency-bounded HEAD with hard 4s timeout. Failures are silent — we
 * never block a scan because of validation; we just drop the bad row.
 */

const axios = require('axios');
const { rootDomain } = require('../resolver/utils/normalizeDomain');

const DESCRIPTIVE_RE =
  /\b(equivalent|various|multiple|several|sites|websites|category|generic|other|miscellaneous|local\s+\w+\s+(?:shops?|sites?|stores?|dealers?|outlets?|companies))\b/i;

const URL_LIKE_RE = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)+/i;

function pickDomain(c) {
  if (!c) return null;
  const candidate = c.domain || c.url || c.website || '';
  return rootDomain(candidate);
}

function nameLooksDescriptive(name) {
  if (!name || typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 120) return true;
  if (DESCRIPTIVE_RE.test(trimmed)) return true;
  // Plural-only descriptive ("Restaurants", "Hotels") — single common noun
  if (/^(?:[A-Z][a-z]+s)$/.test(trimmed)) return true;
  return false;
}

function urlLooksReal(c) {
  const u = c?.url || c?.website || c?.domain;
  if (!u) return false;
  return URL_LIKE_RE.test(u.replace(/^https?:\/\//, ''));
}

async function headProbe(url, timeoutMs = 4000) {
  const target = /^https?:\/\//.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
  try {
    const res = await axios.head(target, {
      timeout: timeoutMs,
      maxRedirects: 4,
      validateStatus: () => true,
      headers: { 'User-Agent': 'QumakValidator/1.0 (+https://qumak.ai)' },
    });
    return { ok: res.status < 400, status: res.status };
  } catch (err) {
    // Many CDNs block HEAD with 4xx but allow GET; fall back to a tiny GET.
    try {
      const res = await axios.get(target, {
        timeout: timeoutMs,
        maxRedirects: 4,
        validateStatus: () => true,
        responseType: 'stream',
        headers: { 'User-Agent': 'QumakValidator/1.0 (+https://qumak.ai)' },
      });
      try { res.data?.destroy?.(); } catch (_e) { /* ignore */ }
      return { ok: res.status < 400, status: res.status };
    } catch (_e2) {
      return { ok: false, status: 0, error: err.code || err.message };
    }
  }
}

/**
 * validateCompetitor — single-row sync+async validator.
 * @param {object} c              — { name, url, ... }
 * @param {object} opts
 * @param {string} opts.ownDomain — drop competitors that match this root
 * @param {boolean} opts.probe    — whether to HTTP HEAD verify (default true)
 */
async function validateCompetitor(c, { ownDomain = null, probe = true } = {}) {
  if (!c) return { ok: false, reason: 'empty' };
  if (nameLooksDescriptive(c.name)) {
    return { ok: false, reason: 'name_descriptive', value: c.name };
  }
  if (!urlLooksReal(c)) {
    return { ok: false, reason: 'url_invalid', value: c.url || c.website || c.domain };
  }

  const compDomain = pickDomain(c);
  if (!compDomain) return { ok: false, reason: 'no_root_domain' };

  if (ownDomain && compDomain === ownDomain) {
    return { ok: false, reason: 'is_own_brand', value: compDomain };
  }

  if (probe) {
    const probeResult = await headProbe(c.url || c.website || compDomain);
    // Only drop on hard 404/410 (domain genuinely gone). Status 0 (timeout),
    // 403 (bot protection), 429 (rate limit) are noise — pass them through.
    if (probeResult.status === 404 || probeResult.status === 410) {
      return { ok: false, reason: 'http_probe_failed', status: probeResult.status, value: compDomain };
    }
  }

  return { ok: true, competitor: { ...c, domain: compDomain }, reason: 'valid' };
}

/**
 * validateCompetitorList — runs validation in bounded concurrency, drops
 * invalid rows, and returns { valid, dropped }.
 */
async function validateCompetitorList(list, { ownDomain = null, probe = true, concurrency = 4 } = {}) {
  if (!Array.isArray(list) || list.length === 0) return { valid: [], dropped: [] };
  const valid = [];
  const dropped = [];
  let i = 0;
  const queue = [...list];
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      const r = await validateCompetitor(c, { ownDomain, probe });
      if (r.ok) valid.push(r.competitor);
      else dropped.push({ name: c?.name || null, url: c?.url || null, reason: r.reason, value: r.value, status: r.status });
      i++;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return { valid, dropped };
}

module.exports = {
  validateCompetitor,
  validateCompetitorList,
  nameLooksDescriptive,
  urlLooksReal,
  pickDomain,
  // for tests
  _DESCRIPTIVE_RE: DESCRIPTIVE_RE,
};
