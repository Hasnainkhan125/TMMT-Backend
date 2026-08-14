'use strict';

/**
 * MetaAdLibraryCollector — pulls running ad creatives for a brand from the
 * Meta Ad Library.
 *
 * Two execution paths, picked at runtime:
 *
 *   A. Official Graph API (when META_AD_LIBRARY_TOKEN is configured)
 *      → /ads_archive endpoint. Structured JSON, reliable, subject to
 *        verification + approved-app restrictions. This is the blessed
 *        path — we always prefer it when available.
 *
 *   B. Public session-based HTML scrape (fallback)
 *      → https://www.facebook.com/ads/library/?q=<brand>&country=AE
 *        Meta renders search results as a mix of server-side JSON blobs
 *        embedded in <script> (the `"adArchiveID"` keys) and a client-side
 *        app. We extract the JSON blobs via regex; when the page is fully
 *        client-side we return a soft-fail with `reason: "requires_js"`.
 *
 * The circuit breaker in the orchestrator is tuned low-reliability for
 * this collector — so repeat blocks auto-pause the source for the cooldown
 * window and other collectors keep the pipeline alive.
 *
 * NOTE: An existing `urlScraper.fetchCompetitorAds` function already hits
 * the Graph API for this. We reuse that when the token exists so we don't
 * have two Graph integrations drifting out of sync; we only add the scrape
 * fallback.
 */

const { BaseCollector } = require('../sourceContract');
const { fetchHtml, fetchJson } = require('../httpFetch');

class MetaAdLibraryCollector extends BaseCollector {
  constructor(opts = {}) {
    super('meta_ad_library', { reliability: 0.5,  
      resetTimeoutMs: 30_000,        
      errorThresholdPercentage: 80,  
      volumeThreshold: 6,            
      ...opts });
  }

  async collect(brandIdentity) {
    const brand = brandIdentity?.brandName;
    if (!brand) return this.softFail('no_brand_name');

    // Path A: Graph API — token path delegates to the existing implementation
    // so we share quota, rate limiting, and error handling with the rest of
    // the app. Only fall through to scraping when the token is absent.
    if (process.env.META_AD_LIBRARY_TOKEN) {
      try {
        const { fetchCompetitorAds } = require('../../urlScraper');
        if (typeof fetchCompetitorAds === 'function') {
          const ads = await fetchCompetitorAds({
            brandName: brand,
            category: brandIdentity?.category || null,
            countries: brandIdentity?.markets?.length
              ? brandIdentity.markets
              : ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'],
          });
          if (ads && (ads.length || ads?.ads?.length)) {
            const list = Array.isArray(ads) ? ads : ads.ads || [];
            return this.ok({
              ads: normaliseAds(list),
              source: 'graph_api',
              queryBrand: brand,
            });
          }
        }
      } catch (err) {
        // Graph API failures are recoverable — we can still try the scrape.
        // Don't mark retryable: the next run will retry the Graph call.
      }
    }

    // Path B: session-scrape fallback. Country pinning matters for relevance.
    const country = brandIdentity?.markets?.[0] || 'US';
    // Prefer numeric FB page ID when we already have it — view_all_page_id
    // gives much higher recall than keyword search and bypasses brand-name
    // ambiguity (e.g. "Cartier" matches dozens of unrelated pages).
    const pageId =
      brandIdentity?.handles?.facebookPageId ||
      brandIdentity?.facebookPageId ||
      null;
    return this.cached(
      () => `ads:${brand}:${country}:${pageId || 'kw'}:${dayStamp()}`,
      6 * 3600,
      () => this._scrape(brand, country, pageId),
    );
  }

  async _scrape(brand, country, pageId = null) {
    const url = buildAdLibraryUrl({ brand, country, pageId });
    let html;
    try {
      const r = await fetchHtml(url, {
        maxAttempts: 2,
        timeoutMs: 15000,
        extraHeaders: {
          'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="125"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
        },
      });
      html = r.html;
    } catch (err) {
      if (err.code === 'blocked' || err.code === 'fetch_timeout') {
        return this.retryableFail(err.code);
      }
      return this.softFail(err.code || 'fetch_failed');
    }

    if (!html || html.length < 500) return this.softFail('empty_body');
    if (/checkpoint|login required|log in to continue/i.test(html)) {
      return this.retryableFail('gated');
    }

    const ads = extractAdsFromScrape(html);
    if (!ads.length) {
      // Page rendered but client-side — common state. Record and move on.
      return this.softFail('requires_js');
    }

    return this.ok({ ads, source: 'scrape', queryBrand: brand, country });
  }
}

function dayStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// Modern Ad Library URL: includes media_type=all (otherwise the page renders
// 0 results for video-only brands) and uses view_all_page_id when we have
// a resolved numeric FB page id — that path is much higher recall than the
// keyword search.
function buildAdLibraryUrl({ brand, country, pageId }) {
  const p = new URLSearchParams();
  p.set('active_status', 'all');
  p.set('ad_type', 'all');
  p.set('media_type', 'all');
  p.set('country', country || 'US');
  if (pageId) {
    p.set('search_type', 'page');
    p.set('view_all_page_id', String(pageId));
  } else {
    p.set('search_type', 'keyword_unordered');
    p.set('q', brand || '');
  }
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

// Meta embeds ad data as JSON fragments in <script type="application/json">
// and inside large JSON blobs attached to `RelayPrefetchedStreamCache` keys.
// We pattern-match archive IDs and pull associated creative fields from a
// window around each match. This is deliberately lossy — when the format
// changes we still get some data, and the extractor will self-correct as
// more ids are found.
function extractAdsFromScrape(html) {
  const ads = [];
  const seen = new Set();

  const idRe = /"adArchiveID"\s*:\s*"(\d{8,20})"/g;
  let m;
  while ((m = idRe.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Look ahead for the local record: body text, snapshot url, start date.
    const window = html.slice(m.index, Math.min(m.index + 8000, html.length));
    const body = takeJsonField(window, 'body') || takeJsonField(window, 'link_description') || '';
    const headline = takeJsonField(window, 'title') || takeJsonField(window, 'link_url') || '';
    const startDate =
      takeJsonField(window, 'startDate') || takeJsonField(window, 'start_date');
    const snapshotUrl = takeJsonField(window, 'snapshot_url') || null;
    const pageName = takeJsonField(window, 'page_name') || null;
    if (body || headline || pageName) {
      ads.push({
        adArchiveId: id,
        headline: cleanText(headline),
        body: cleanText(body),
        pageName: cleanText(pageName),
        snapshotUrl,
        startDate: startDate ? new Date(Number(startDate) * 1000 || startDate) : null,
        source: 'scrape',
      });
    }
    if (ads.length >= 30) break;
  }
  return ads;
}

function takeJsonField(window, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|(\\d+(?:\\.\\d+)?))`);
  const m = window.match(re);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2];
}

function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseAds(list) {
  return list
    .map((a) => ({
      adArchiveId: a.id || a.adArchiveId || a.ad_id || null,
      headline: cleanText(a.headline || a.ad_creative_link_title || a.title || ''),
      body: cleanText(a.body || a.ad_creative_body || a.ad_creative_link_description || ''),
      pageName: cleanText(a.pageName || a.page_name || a.advertiser || ''),
      snapshotUrl: a.snapshotUrl || a.ad_snapshot_url || null,
      startDate: a.startDate || a.ad_delivery_start_time || null,
      source: 'graph_api',
    }))
    .filter((a) => a.headline || a.body);
}

// Unused helper kept for future /ads_archive fallback if we ever need to
// query Graph directly without the urlScraper helper.
async function _graphFallback(brand, country) {
  const token = process.env.META_AD_LIBRARY_TOKEN;
  if (!token) return null;
  const url =
    `https://graph.facebook.com/v19.0/ads_archive?` +
    `search_terms=${encodeURIComponent(brand)}&ad_reached_countries=["${country}"]&ad_type=ALL&ad_active_status=active&media_type=all&limit=25&access_token=${token}`;
  const { json } = await fetchJson(url, { maxAttempts: 1, timeoutMs: 10000 });
  return json?.data ? normaliseAds(json.data) : null;
}

module.exports = { MetaAdLibraryCollector };
