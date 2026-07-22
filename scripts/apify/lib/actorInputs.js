'use strict';

/**
 * Pure Apify actor input builders + helpers for CLI scripts and Jest.
 * No network — safe to import from tests.
 */

const ACTORS = {
  GOOGLE_PLACES: 'compass/crawler-google-places',
  GOOGLE_SEARCH: 'apify/google-search-scraper',
  INSTAGRAM_SCRAPER: 'apify/instagram-scraper',
  FACEBOOK_ADS: process.env.APIFY_FB_ADS_ACTOR || 'curious_coder/facebook-ads-library-scraper',
  TIKTOK: 'clockworks/tiktok-scraper',
};

/**
 * @param {{
 *   searchStrings: string|string[],
 *   locationQuery?: string,
 *   maxCrawledPlacesPerSearch?: number,
 *   scrapeReviews?: boolean,
 *   maxReviews?: number,
 * }} opts
 */
function buildGooglePlacesInput(opts = {}) {
  const arr = Array.isArray(opts.searchStrings)
    ? opts.searchStrings
    : [opts.searchStrings || ''].filter(Boolean);
  if (!arr.length) throw new Error('buildGooglePlacesInput: searchStrings required');
  const max = Math.min(Math.max(Number(opts.maxCrawledPlacesPerSearch) || 20, 1), 50);
  const base = {
    searchStringsArray: arr.map((s) => String(s).trim().slice(0, 200)).filter(Boolean),
    maxCrawledPlacesPerSearch: max,
    locationQuery: String(opts.locationQuery || 'United States').slice(0, 80),
  };
  if (opts.scrapeReviews || opts.maxReviews) {
    base.maxReviews = Math.min(Math.max(Number(opts.maxReviews) || 15, 1), 50);
    base.scrapeReviews = opts.scrapeReviews !== false;
  }
  return base;
}

/**
 * Template aligned with Studio “AI / Perplexity” search options you shared.
 * @param {{ queries: string, resultsPerPage?: number, maxPagesPerQuery?: number }} opts
 */
function buildGoogleSearchScraperInput(opts = {}) {
  const queries = String(opts.queries || '').trim();
  if (!queries) throw new Error('buildGoogleSearchScraperInput: queries required');
  return {
    aiModeSearch: { enableAiMode: opts.enableAiMode !== false },
    chatGptSearch: { enableChatGpt: !!opts.enableChatGpt },
    disableGoogleSearchResults: false,
    focusOnPaidAds: !!opts.focusOnPaidAds,
    forceExactMatch: !!opts.forceExactMatch,
    includeIcons: !!opts.includeIcons,
    includeUnfilteredResults: !!opts.includeUnfilteredResults,
    maxPagesPerQuery: Math.min(Math.max(Number(opts.maxPagesPerQuery) || 1, 1), 5),
    maximumLeadsEnrichmentRecords: Number(opts.maximumLeadsEnrichmentRecords) || 0,
    mobileResults: !!opts.mobileResults,
    perplexitySearch: {
      enablePerplexity: opts.enablePerplexity !== false,
      returnImages: opts.perplexityReturnImages !== false,
      returnRelatedQuestions: !!opts.returnRelatedQuestions,
    },
    queries,
    resultsPerPage: Math.min(Math.max(Number(opts.resultsPerPage) || 100, 10), 100),
    saveHtml: !!opts.saveHtml,
    saveHtmlToKeyValueStore: opts.saveHtmlToKeyValueStore !== false,
    verifyLeadsEnrichmentEmails: !!opts.verifyLeadsEnrichmentEmails,
  };
}

/**
 * @param {{
 *   directUrls?: string[],
 *   resultsLimit?: number,
 *   resultsType?: string,
 *   search?: string,
 *   searchLimit?: number,
 *   searchType?: string,
 *   addParentData?: boolean,
 * }} opts
 */
function buildInstagramScraperInput(opts = {}) {
  const directUrls = (opts.directUrls || []).map((u) => String(u).trim()).filter(Boolean);
  if (!directUrls.length && !opts.search) {
    throw new Error('buildInstagramScraperInput: directUrls or search required');
  }
  return {
    addParentData: !!opts.addParentData,
    directUrls,
    resultsLimit: Math.min(Math.max(Number(opts.resultsLimit) || 30, 1), 200),
    resultsType: opts.resultsType || 'posts',
    search: String(opts.search || ''),
    searchLimit: Math.min(Math.max(Number(opts.searchLimit) || 10, 1), 50),
    searchType: opts.searchType || 'hashtag',
  };
}

/**
 * Meta Ad Library scrape via curious_coder actor (URL wrapper).
 * @param {{ keyword?: string, pageId?: string, country?: string, count?: number, mediaType?: string, activeStatus?: string }} opts
 */
function buildFacebookAdsLibraryInput({
  keyword,
  pageId,
  country = 'US',
  count = 25,
  mediaType = 'all',
  activeStatus = 'all',
} = {}) {
  const { buildAdLibraryUrl, buildApifyInput } = require('../../../services/apify/actors/buildAdLibraryUrl');
  let url;
  if (pageId) {
    url = buildAdLibraryUrl({
      mode: 'page',
      pageId: String(pageId),
      country,
      mediaType,
      activeStatus,
    });
  } else if (keyword) {
    url = buildAdLibraryUrl({
      mode: 'keyword',
      query: String(keyword),
      country,
      mediaType,
      activeStatus,
    });
  } else {
    throw new Error('buildFacebookAdsLibraryInput: keyword or pageId required');
  }
  return buildApifyInput({ url, count, countryCode: country, activeStatus });
}

/**
 * clockworks/tiktok-scraper — profile scrape
 */
function buildTikTokProfileInput({ profiles, resultsPerPage = 20 } = {}) {
  const list = (Array.isArray(profiles) ? profiles : [profiles])
    .map((p) => String(p || '').replace(/^@/, '').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('buildTikTokProfileInput: profiles required');
  const rpp = Math.min(Math.max(Number(resultsPerPage) || 20, 5), 40);
  return {
    profiles: list,
    resultsPerPage: rpp,
  };
}

/** CLI: --key value / --flag */
function parseScriptArgv(argv) {
  const out = { _: [], flags: {} };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (!t.startsWith('--')) {
      out._.push(t);
      continue;
    }
    const key = t.slice(2);
    const next = a[i + 1];
    if (!next || next.startsWith('--')) {
      out.flags[key] = true;
    } else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function summarizeDatasetItems(items, { maxItems = 8, maxChars = 12000 } = {}) {
  const slice = (items || []).slice(0, maxItems);
  const json = JSON.stringify(slice, null, 2);
  if (json.length <= maxChars) return { truncated: false, text: json, itemCount: (items || []).length };
  return {
    truncated: true,
    text: `${json.slice(0, maxChars)}\n… truncated (showing ${slice.length} of ${(items || []).length})`,
    itemCount: (items || []).length,
  };
}

module.exports = {
  ACTORS,
  buildGooglePlacesInput,
  buildGoogleSearchScraperInput,
  buildInstagramScraperInput,
  buildFacebookAdsLibraryInput,
  buildTikTokProfileInput,
  parseScriptArgv,
  summarizeDatasetItems,
};
