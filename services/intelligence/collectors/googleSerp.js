'use strict';

/**
 * GoogleSerpCollector — searches Google for the competitor's brand +
 * commercial modifiers ("offer", "deal", "discount", market-tail) to
 * surface:
 *   1. Competitor PPC ad copy (the `<div aria-label="Ads">` block)
 *   2. Sitelink extensions they're bidding on
 *   3. Organic offer language from their own properties
 *
 * Google's SERP HTML changes selectors every few weeks. Our posture:
 *   - Use `noscript` output and semantic attributes where possible
 *   - Never throw on parse misses — return empty arrays and let the
 *     orchestrator mark the run "ok with zero records"
 *   - Rate limit to 4 queries per run to stay under Google's casual
 *     threshold (the circuit breaker opens well before we get banned)
 */

const { BaseCollector } = require('../sourceContract');
const { fetchHtml, sleep } = require('../httpFetch');

class GoogleSerpCollector extends BaseCollector {
  constructor(opts = {}) {
    super('google_serp', { reliability: 0.75, ...opts });
  }

  async collect(brandIdentity) {
    const brand = brandIdentity?.brandName;
    if (!brand) return this.softFail('no_brand_name');

    const markets = brandIdentity?.markets || [];
    const queries = buildQueries(brand, markets);

    const results = [];
    for (const q of queries) {
      try {
        const r = await this._fetchSerp(q);
        results.push({ query: q, ...r });
        // Stagger queries — back-to-back bursts trigger Google's recaptcha.
        await sleep(350 + Math.random() * 250);
      } catch (err) {
        // Retryable → let orchestrator see it via breaker. Soft fail → continue.
        if (err?.code === 'blocked' || err?.code === 'fetch_timeout') {
          return this.retryableFail(err.code);
        }
        results.push({ query: q, error: err?.code || err?.message || 'parse_error' });
      }
    }

    const ppcAds = results.flatMap((r) => r.ads || []).filter(Boolean);
    const organicTitles = results.flatMap((r) => r.organicTitles || []).filter(Boolean);
    const peopleAlsoAsk = results.flatMap((r) => r.peopleAlsoAsk || []).filter(Boolean);

    if (!ppcAds.length && !organicTitles.length && !peopleAlsoAsk.length) {
      return this.softFail('no_results');
    }

    return this.ok({
      queries,
      ppcAds,
      organicTitles,
      peopleAlsoAsk,
      sitelinks: extractSitelinks(ppcAds),
      offerLanguage: extractOffers(ppcAds, organicTitles),
    });
  }

  async _fetchSerp(query) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const { html } = await fetchHtml(url, {
      maxAttempts: 2,
      timeoutMs: 10_000,
      acceptLanguage: 'en-US,en;q=0.9',
    });
    return parseSerp(html);
  }
}

function buildQueries(brandName, markets) {
  const market = markets?.[0] || '';
  const base = [
    `${brandName} offer`,
    `${brandName} deal`,
    `${brandName} discount`,
  ];
  if (market) base.push(`${brandName} ${market}`);
  return base.slice(0, 4);
}

// Google SERP now uses lots of CSS class obfuscation. We lean on stable data
// attributes and text markers instead. Accept noisy output rather than zero.
function parseSerp(html) {
  const ads = [];
  const organicTitles = [];
  const peopleAlsoAsk = [];

  // Sponsored/ad blocks are often wrapped with text like "Sponsored" or "Ad".
  // We find each headline anchor and pull its visible text + target URL.
  const adBlockRe = /<div[^>]*data-text-ad[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = adBlockRe.exec(html)) && ads.length < 12) {
    const body = m[1];
    const title = stripTags(
      (body.match(/<span[^>]*role=["']heading["'][^>]*>([\s\S]*?)<\/span>/i) ||
        body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
        body.match(/<a[^>]+>([\s\S]{4,100}?)<\/a>/i))?.[1] || '',
    ).trim();
    const display = stripTags((body.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i) || [])[1] || '').trim();
    const descMatch = body.match(/<div[^>]*class=["'][^"']*MUxGbd[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const description = stripTags(descMatch?.[1] || '').trim();
    if (title) ads.push({ headline: title, displayUrl: display, description });
  }

  // Organic titles (h3 anchors inside search results).
  const orgRe = /<h3[^>]*>([\s\S]{4,150}?)<\/h3>/gi;
  while ((m = orgRe.exec(html)) && organicTitles.length < 15) {
    const txt = stripTags(m[1]).trim();
    if (txt && !organicTitles.includes(txt)) organicTitles.push(txt);
  }

  // People Also Ask — these reveal the questions Google is associating with
  // the brand. Gold for FAQ / hook extraction.
  const paaRe = /<div[^>]*data-q=["']([^"']+)["']/gi;
  while ((m = paaRe.exec(html)) && peopleAlsoAsk.length < 10) {
    peopleAlsoAsk.push(m[1]);
  }

  return { ads, organicTitles, peopleAlsoAsk };
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function extractSitelinks(ppcAds) {
  // Ads sometimes include sitelink extensions as comma-separated tails in
  // description or display URL. Extract them cheaply.
  const all = new Set();
  for (const a of ppcAds) {
    const text = `${a.description || ''} ${a.displayUrl || ''}`;
    (text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}/g) || [])
      .slice(0, 3)
      .forEach((s) => all.add(s.trim()));
  }
  return Array.from(all);
}

const OFFER_PATTERNS = [
  /\b\d{1,3}%\s*off\b/i,
  /\bfree shipping\b/i,
  /\bbuy\s+\d+\s+get\s+\d+\b/i,
  /\bsave\s+(?:up\s+to\s+)?\$?\d+/i,
  /\bends (?:tonight|soon|today)\b/i,
  /\blimited time\b/i,
  /\bstarting at\b/i,
  /\bfrom\s+\$?\d+/i,
];

function extractOffers(ppcAds, organicTitles) {
  const texts = [
    ...ppcAds.map((a) => `${a.headline || ''} ${a.description || ''}`),
    ...organicTitles,
  ];
  const hits = [];
  for (const t of texts) {
    for (const pat of OFFER_PATTERNS) {
      const m = t.match(pat);
      if (m) hits.push({ pattern: pat.source, matched: m[0], context: t.slice(0, 120) });
    }
  }
  return hits.slice(0, 30);
}

module.exports = { GoogleSerpCollector };
