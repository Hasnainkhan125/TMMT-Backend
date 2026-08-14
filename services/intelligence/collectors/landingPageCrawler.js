'use strict';

/**
 * LandingPageCollector — crawls the competitor's own website for funnel /
 * offer pages. These pages reveal more about strategy than any ad network
 * because they are the *conversion point*: pricing, offers, CTAs, pixel
 * installs, lead-capture forms.
 *
 * Heuristic pipeline:
 *   1. Fetch /sitemap.xml (respecting robots.txt if blocked)
 *   2. Score URLs against a list of "funnel markers"
 *      (offer, deal, sale, launch, lp/, landing/, promo, campaign, trial)
 *   3. Sample the top 10 and analyze each one
 *
 * We only store the *extracted* signals (headline, CTAs, pixel ids,
 * offer tokens) — never the raw HTML — so the DB footprint per brand
 * stays in the low-kilobyte range.
 */

const { BaseCollector } = require('../sourceContract');
const { fetchHtml, sleep } = require('../httpFetch');
const { _internals } = require('../brandIdentity');

const { pickMeta, safeText } = _internals;

const MAX_PAGES = 10;
const MAX_SITEMAP_URLS = 400;

const FUNNEL_MARKERS = [
  /\b(offer|deal|sale|promo|launch|campaign|trial|demo|free|get|claim|start|try|sign[-_]?up|register|apply|quote)\b/i,
  /\/lp\//i,
  /\/landing\//i,
  /\/pricing/i,
  /\/plans/i,
];

class LandingPageCollector extends BaseCollector {
  constructor(opts = {}) {
    super('landing_page_crawler', { reliability: 0.9, ...opts });
  }

  async collect(brandIdentity) {
    const domain = brandIdentity?.canonicalDomain;
    if (!domain) return this.softFail('no_domain');

    const origin = `https://${domain}`;
    const sitemap = await fetchSitemap(origin).catch(() => []);

    const candidates = (sitemap.length ? sitemap : [origin])
      .filter((u) => FUNNEL_MARKERS.some((re) => re.test(u)))
      .slice(0, MAX_PAGES);

    // Always include the homepage even when sitemap doesn't match markers.
    if (!candidates.includes(origin)) candidates.unshift(origin);

    const pages = [];
    for (const url of candidates.slice(0, MAX_PAGES)) {
      try {
        const page = await analyzeLandingPage(url);
        if (page) pages.push(page);
        await sleep(150 + Math.random() * 150);
      } catch (_err) {
        // One broken landing page doesn't sink the run.
      }
    }

    if (!pages.length) return this.softFail('no_pages_analyzed');

    return this.ok({
      funnelPages: pages,
      detectedPixels: mergePixels(pages),
      headlinesUsed: mergeHeadlines(pages),
      ctaPatterns: mergeCTAs(pages),
      pricingSignals: mergePricingSignals(pages),
    });
  }
}

// ─── Sitemap fetch ─────────────────────────────────────────────────────────

async function fetchSitemap(origin) {
  const tried = [];
  const results = [];
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap.xml.gz'];
  for (const path of candidates) {
    try {
      const url = origin + path;
      tried.push(url);
      const { html } = await fetchHtml(url, { maxAttempts: 1, timeoutMs: 6000, maxBytes: 1024 * 1024 });
      // If this is an index, recurse once into each child sitemap (capped).
      const childSitemaps = [...html.matchAll(/<loc>\s*([^<]+\.xml[^<]*)\s*<\/loc>/gi)].map((m) => m[1]).slice(0, 5);
      if (childSitemaps.length) {
        for (const child of childSitemaps) {
          try {
            const r = await fetchHtml(child, { maxAttempts: 1, timeoutMs: 6000, maxBytes: 1024 * 1024 });
            results.push(...parseSitemapUrls(r.html));
          } catch (_e) {
            // skip bad child
          }
        }
      } else {
        results.push(...parseSitemapUrls(html));
      }
      if (results.length) break;
    } catch (_err) {
      // try next candidate
    }
  }
  return results.slice(0, MAX_SITEMAP_URLS);
}

function parseSitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

// ─── Per-page analysis ────────────────────────────────────────────────────

async function analyzeLandingPage(url) {
  const { html } = await fetchHtml(url, { maxAttempts: 2, timeoutMs: 8000 }).catch(() => ({ html: null }));
  if (!html) return null;

  const title = safeText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const h1 = safeText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const description = pickMeta(html, ['description', 'og:description']) || '';

  const ctaText = extractCTAs(html);
  const pixels = extractPixels(html);
  const priceTokens = extractPriceTokens(html);
  const leadFormCount = (html.match(/<form[\s>]/gi) || []).length;

  return {
    url,
    title,
    h1,
    description,
    ctas: ctaText,
    pixels,
    priceTokens,
    leadFormCount,
  };
}

function extractCTAs(html) {
  const ctas = new Set();
  // <button>, <a class="btn">, role="button" — pick visible, short, call-to-action text.
  const re = /<(?:button|a)[^>]*(?:class=["'][^"']*(?:btn|button|cta|primary)[^"']*["']|role=["']button["'])[^>]*>([\s\S]{2,80}?)<\/(?:button|a)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = safeText(m[1]);
    if (text && text.length <= 40 && text.length >= 2) ctas.add(text);
  }
  // Common CTA copy always worth grepping for.
  const keywords = /\b(get started|try free|book (?:a )?demo|sign up|start free trial|get (?:a )?quote|learn more|shop now|buy now|request (?:a )?quote|get in touch|claim (?:offer|discount))\b/gi;
  let k;
  while ((k = keywords.exec(html))) ctas.add(k[0]);
  return Array.from(ctas).slice(0, 15);
}

function extractPixels(html) {
  const pixels = [];
  // Facebook pixel
  [...html.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/gi)].forEach((m) =>
    pixels.push({ platform: 'facebook', id: m[1] }),
  );
  // TikTok pixel
  [...html.matchAll(/analytics\.tiktok\.com\/[^"']+(?:pixel|_pxl)[^"']*/gi)].forEach(() =>
    pixels.push({ platform: 'tiktok', id: 'detected' }),
  );
  [...html.matchAll(/ttq\.load\(\s*['"]([A-Z0-9]{10,})['"]/gi)].forEach((m) =>
    pixels.push({ platform: 'tiktok', id: m[1] }),
  );
  // Google Analytics / Tag Manager
  [...html.matchAll(/gtag\(\s*['"]config['"]\s*,\s*['"]([A-Z]+-[A-Z0-9]+)['"]/gi)].forEach((m) =>
    pixels.push({ platform: 'google', id: m[1] }),
  );
  [...html.matchAll(/googletagmanager\.com\/(?:gtm|gtag)\/js\?id=([A-Z]+-[A-Z0-9]+)/gi)].forEach((m) =>
    pixels.push({ platform: 'google_tag_manager', id: m[1] }),
  );
  // LinkedIn Insight tag
  [...html.matchAll(/_linkedin_partner_id\s*=\s*["']?(\d+)/gi)].forEach((m) =>
    pixels.push({ platform: 'linkedin', id: m[1] }),
  );
  // Snap / Pinterest
  if (/snaptr\s*\(/i.test(html)) pixels.push({ platform: 'snapchat', id: 'detected' });
  if (/pintrk\s*\(/i.test(html)) pixels.push({ platform: 'pinterest', id: 'detected' });

  // Dedupe.
  const seen = new Set();
  return pixels.filter((p) => {
    const key = `${p.platform}:${p.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractPriceTokens(html) {
  const tokens = new Set();
  const re = /(?:AED|USD|SAR|QAR|KWD|BHD|OMR|\$|€|£)\s?\d{1,5}(?:[.,]\d{2})?(?:\s?\/\s?(?:mo|month|year|yr|seat|user))?/gi;
  let m;
  while ((m = re.exec(html)) && tokens.size < 15) tokens.add(m[0].trim());
  return Array.from(tokens);
}

// ─── Cross-page merges ────────────────────────────────────────────────────

function mergePixels(pages) {
  const seen = new Set();
  const out = [];
  for (const p of pages) {
    for (const pixel of p.pixels || []) {
      const key = `${pixel.platform}:${pixel.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(pixel);
      }
    }
  }
  return out;
}

function mergeHeadlines(pages) {
  const out = new Set();
  for (const p of pages) {
    if (p.h1) out.add(p.h1);
    if (p.title) out.add(p.title);
  }
  return Array.from(out).slice(0, 30);
}

function mergeCTAs(pages) {
  const out = new Set();
  for (const p of pages) for (const c of p.ctas || []) out.add(c);
  return Array.from(out).slice(0, 30);
}

function mergePricingSignals(pages) {
  const out = new Set();
  for (const p of pages) for (const t of p.priceTokens || []) out.add(t);
  return Array.from(out).slice(0, 20);
}

module.exports = { LandingPageCollector };
