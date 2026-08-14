'use strict';

const { runActor } = require('../apifyClient');
const { getRedis } = require('../../redis');
const { buildAdLibraryUrl, buildApifyInput } = require('./buildAdLibraryUrl');

const FB_ADS_ACTOR = process.env.APIFY_FB_ADS_ACTOR || 'apify/facebook-ads-scraper';
const FETCH_TIMEOUT_MS = 8000;

// ── Strategy 1: fb:pages meta tag in already-scraped HTML ─────────────────

function extractFromMetaTag(html) {
  if (!html) return null;
  const match =
    html.match(/<meta[^>]+property=["']fb:pages["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']fb:pages["']/i) ||
    html.match(/<meta[^>]+property=["']fb:page_id["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']fb:page_id["']/i);
  if (!match) return null;
  const first = match[1].split(',')[0].trim();
  return /^\d+$/.test(first) ? first : null;
}

// ── Strategy 2: fetch facebook.com/{handle}/about and regex for pageID ───

// Patterns that Meta embeds in /about page HTML (observed in production)
const PAGE_ID_PATTERNS = [
  /"pageID":"(\d+)"/,
  /"page_id":"(\d+)"/,
  /\bentity_id":"(\d+)"/,
  /\bdata-pageid="(\d+)"/,
  /"pageId":"(\d+)"/,
];

async function extractFromAboutPage(handle) {
  if (!handle) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = `https://www.facebook.com/${handle}/about`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QumakBot/1.0)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    for (const pattern of PAGE_ID_PATTERNS) {
      const m = html.match(pattern);
      if (m) return m[1];
    }
    return null;
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Strategy 3: Apify Ad Library keyword search, grab page_id from result ─

async function extractFromAdLibrary(brandName, country) {
  if (!brandName) return null;

  try {
    const adLibUrl = buildAdLibraryUrl({ mode: 'keyword', query: brandName, country, activeStatus: 'active' });
    const input = buildApifyInput({ url: adLibUrl, count: 5 });
    const result = await runActor(FB_ADS_ACTOR, input, { timeoutSecs: 60, memoryMbytes: 512 });
    const items = result?.items || [];
    for (const item of items) {
      const id = item.page_id || item.snapshot?.page_id;
      if (id && /^\d+$/.test(String(id))) return String(id);
    }
    return null;
  } catch (_err) {
    return null;
  }
}

// ── Cache key ─────────────────────────────────────────────────────────────

function cacheKey(handle, brandName) {
  const part = (handle || brandName || 'unknown').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `fb-page-id:${part}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve a numeric Facebook page ID from a handle and/or brand name.
 *
 * Tries three strategies in order, short-circuiting on the first hit.
 * Results are cached 30 days on success, 24h on miss.
 *
 * @param {object} opts
 * @param {string} [opts.handle]     - Facebook handle (e.g. 'rakez.ae')
 * @param {string} [opts.siteHtml]   - Already-scraped homepage HTML (checked first, free)
 * @param {string} [opts.brandName]  - Brand name for Ad Library keyword fallback
 * @param {string} [opts.country]    - ISO 2-letter code, default 'AE'
 * @returns {Promise<{ pageId: string|null, resolvedBy: string|null }>}
 */
async function resolvePageId({ handle, siteHtml, brandName, country = 'AE' } = {}) {
  const key = cacheKey(handle, brandName);
  const redis = getRedis();

  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch (_e) { /* fall through */ }
  }

  // Strategy 1: meta tag (no network)
  const fromMeta = extractFromMetaTag(siteHtml);
  if (fromMeta) {
    const hit = { pageId: fromMeta, resolvedBy: 'meta_tag' };
    await redis.setex(key, 2592000, JSON.stringify(hit)).catch(() => {});
    return hit;
  }

  // Strategy 2: about page fetch
  const fromAbout = await extractFromAboutPage(handle);
  if (fromAbout) {
    const hit = { pageId: fromAbout, resolvedBy: 'about_html' };
    await redis.setex(key, 2592000, JSON.stringify(hit)).catch(() => {});
    return hit;
  }

  // Strategy 3: Ad Library keyword search
  const fromAds = await extractFromAdLibrary(brandName, country);
  if (fromAds) {
    const hit = { pageId: fromAds, resolvedBy: 'ad_library' };
    await redis.setex(key, 2592000, JSON.stringify(hit)).catch(() => {});
    return hit;
  }

  // All strategies failed — cache the miss briefly so we don't hammer on repeated scans
  const miss = { pageId: null, resolvedBy: null };
  await redis.setex(key, 86400, JSON.stringify(miss)).catch(() => {});
  return miss;
}

module.exports = { resolvePageId };
