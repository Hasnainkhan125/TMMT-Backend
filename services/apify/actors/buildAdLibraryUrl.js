'use strict';

const BASE = 'https://www.facebook.com/ads/library/';

/**
 * Build a Meta Ad Library URL for the Apify facebook-ads-library-scraper actor.
 *
 * mode='keyword' → search by q param (e.g. "business setup")
 * mode='page'    → search by view_all_page_id (e.g. "214396565557")
 *
 * All indexed array params (publisher_platforms, content_languages) are
 * appended as publisher_platforms[0]=x&publisher_platforms[1]=y to match
 * the exact format Meta uses in the Ad Library UI.
 */
function buildAdLibraryUrl({
  mode,
  query,
  pageId,
  country = 'AE',
  activeStatus = 'all',
  mediaType = 'all',
  platforms = [],
  languages = [],
} = {}) {
  if (mode !== 'keyword' && mode !== 'page') {
    throw new Error(`buildAdLibraryUrl: unknown mode "${mode}" — must be "keyword" or "page"`);
  }
  if (mode === 'keyword' && !query) {
    throw new Error('buildAdLibraryUrl: query is required for keyword mode');
  }
  if (mode === 'page' && !pageId) {
    throw new Error('buildAdLibraryUrl: pageId is required for page mode');
  }

  const p = new URLSearchParams();

  p.set('active_status', activeStatus);
  p.set('ad_type', 'all');

  // content_languages must come before country to match Meta's canonical order
  languages.forEach((lang, i) => p.set(`content_languages[${i}]`, lang));

  p.set('country', country);
  p.set('is_targeted_country', 'false');
  p.set('media_type', mediaType);

  platforms.forEach((pl, i) => p.set(`publisher_platforms[${i}]`, pl));

  if (mode === 'keyword') {
    p.set('q', query);
    p.set('search_type', 'keyword_unordered');
  } else {
    p.set('search_type', 'page');
  }

  p.set('sort_data[direction]', 'desc');
  p.set('sort_data[mode]', 'total_impressions');

  if (mode === 'page') {
    p.set('view_all_page_id', pageId);
  }

  return `${BASE}?${p.toString()}`;
}

/**
 * Wrap an Ad Library URL into the Apify actor input shape expected by
 * curious_coder/facebook-ads-library-scraper.
 */
function buildApifyInput({ url, count = 25, countryCode = 'AE', activeStatus = 'all' } = {}) {
  return {
    count,
    scrapeAdDetails: true,
    'scrapePageAds.activeStatus': activeStatus,
    'scrapePageAds.countryCode': countryCode,
    'scrapePageAds.sortBy': 'impressions_desc',
    'scrapePageAds.period': '',
    urls: [{ url }],
  };
}

/**
 * curious_coder/facebook-ads-library-scraper enforces ~1 Ad Library URL per 512MB RAM.
 * Example: 4GB with only 1 URL fails — use 512MB for a single URL, or add more urls[].
 */
function facebookAdsMemoryMbytesForInput(input, actorId = '') {
  let n = 1;
  if (actorId.startsWith('webdatalabs/')) {
    n = (input.searchUrls && input.searchUrls.length) || 1;
  } else {
    n = (input.urls && input.urls.length) || 1;
  }
  n = Math.max(1, n);
  return Math.min(4096, 512 * n);
}

module.exports = { buildAdLibraryUrl, buildApifyInput, facebookAdsMemoryMbytesForInput };
