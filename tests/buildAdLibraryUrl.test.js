'use strict';

/**
 * buildAdLibraryUrl — unit tests (TDD Red → Green)
 *
 * Validates URL construction against the exact patterns Hamza confirmed
 * work with the Apify curious_coder/facebook-ads-library-scraper actor.
 *
 * Reference URLs (verified working 2026-04-27):
 *   Keyword: ?active_status=active&ad_type=all&country=AE&is_targeted_country=false
 *            &media_type=all&q=business+setup&search_type=keyword_unordered
 *            &sort_data[direction]=desc&sort_data[mode]=total_impressions
 *   Page:    same but search_type=page&view_all_page_id=214396565557
 */

const { buildAdLibraryUrl, buildApifyInput } = require('../services/apify/actors/buildAdLibraryUrl');

// ── Shared param assertions ───────────────────────────────────────────────

function parseUrl(rawUrl) {
  const url = new URL(rawUrl);
  // Return both the URLSearchParams and raw search string for indexed-param checks
  return { params: url.searchParams, search: url.search, origin: url.origin + url.pathname };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('buildAdLibraryUrl — keyword mode', () => {
  it('builds a basic UAE keyword search URL with correct fixed params', () => {
    const url = buildAdLibraryUrl({ mode: 'keyword', query: 'business setup' });
    const { params, origin } = parseUrl(url);

    expect(origin).toBe('https://www.facebook.com/ads/library/');
    expect(params.get('active_status')).toBe('active');
    expect(params.get('ad_type')).toBe('all');
    expect(params.get('country')).toBe('AE');
    expect(params.get('is_targeted_country')).toBe('false');
    expect(params.get('media_type')).toBe('all');
    expect(params.get('q')).toBe('business setup');
    expect(params.get('search_type')).toBe('keyword_unordered');
    expect(params.get('sort_data[direction]')).toBe('desc');
    expect(params.get('sort_data[mode]')).toBe('total_impressions');
  });

  it('sets active_status=all when activeStatus is "all"', () => {
    const url = buildAdLibraryUrl({ mode: 'keyword', query: 'beauty salon', activeStatus: 'all' });
    const { params } = parseUrl(url);
    expect(params.get('active_status')).toBe('all');
  });

  it('sets media_type=video for video-only filter', () => {
    const url = buildAdLibraryUrl({ mode: 'keyword', query: 'business setup', mediaType: 'video' });
    const { params } = parseUrl(url);
    expect(params.get('media_type')).toBe('video');
  });

  it('appends single platform filter as publisher_platforms[0]', () => {
    const url = buildAdLibraryUrl({
      mode: 'keyword',
      query: 'business setup',
      platforms: ['facebook'],
    });
    // URLSearchParams encodes brackets; check raw search string
    expect(url).toContain('publisher_platforms%5B0%5D=facebook');
  });

  it('appends all four platforms in indexed order', () => {
    const url = buildAdLibraryUrl({
      mode: 'keyword',
      query: 'business setup',
      platforms: ['facebook', 'instagram', 'audience_network', 'messenger'],
    });
    expect(url).toContain('publisher_platforms%5B0%5D=facebook');
    expect(url).toContain('publisher_platforms%5B1%5D=instagram');
    expect(url).toContain('publisher_platforms%5B2%5D=audience_network');
    expect(url).toContain('publisher_platforms%5B3%5D=messenger');
  });

  it('appends content_languages filter as indexed params', () => {
    const url = buildAdLibraryUrl({
      mode: 'keyword',
      query: 'business setup',
      languages: ['en'],
    });
    expect(url).toContain('content_languages%5B0%5D=en');
  });

  it('uses country=SA for Saudi searches', () => {
    const url = buildAdLibraryUrl({ mode: 'keyword', query: 'وظائف', country: 'SA' });
    const { params } = parseUrl(url);
    expect(params.get('country')).toBe('SA');
  });
});

describe('buildAdLibraryUrl — page mode', () => {
  it('builds RAKEZ page URL with correct page ID and search_type=page', () => {
    const url = buildAdLibraryUrl({ mode: 'page', pageId: '214396565557' });
    const { params, origin } = parseUrl(url);

    expect(origin).toBe('https://www.facebook.com/ads/library/');
    expect(params.get('search_type')).toBe('page');
    expect(params.get('view_all_page_id')).toBe('214396565557');
    expect(params.get('active_status')).toBe('active');
    expect(params.get('country')).toBe('AE');
    expect(params.get('sort_data[mode]')).toBe('total_impressions');
    // No q param in page mode
    expect(params.get('q')).toBeNull();
  });

  it('builds DAMAC Properties page URL', () => {
    const url = buildAdLibraryUrl({ mode: 'page', pageId: '169789673075263' });
    const { params } = parseUrl(url);
    expect(params.get('view_all_page_id')).toBe('169789673075263');
    expect(params.get('search_type')).toBe('page');
  });

  it('throws when mode=page and no pageId provided', () => {
    expect(() => buildAdLibraryUrl({ mode: 'page' })).toThrow(/pageId/);
  });
});

describe('buildAdLibraryUrl — validation', () => {
  it('throws when mode=keyword and no query provided', () => {
    expect(() => buildAdLibraryUrl({ mode: 'keyword' })).toThrow(/query/);
  });

  it('throws for unknown mode', () => {
    expect(() => buildAdLibraryUrl({ mode: 'hashtag', query: 'x' })).toThrow(/mode/);
  });
});

describe('buildApifyInput — wraps URL into actor input shape', () => {
  it('produces correct Apify actor input for a keyword search', () => {
    const adLibUrl = buildAdLibraryUrl({ mode: 'keyword', query: 'business setup' });
    const input = buildApifyInput({ url: adLibUrl, count: 40 });

    expect(input.urls).toHaveLength(1);
    expect(input.urls[0].url).toBe(adLibUrl);
    expect(input.count).toBe(40);
    expect(input.scrapeAdDetails).toBe(true);
    expect(input['scrapePageAds.sortBy']).toBe('impressions_desc');
  });

  it('uses count=25 when not specified', () => {
    const adLibUrl = buildAdLibraryUrl({ mode: 'keyword', query: 'spa' });
    const input = buildApifyInput({ url: adLibUrl });
    expect(input.count).toBe(25);
  });

  it('allows countryCode override for ALL', () => {
    const adLibUrl = buildAdLibraryUrl({ mode: 'keyword', query: 'spa' });
    const input = buildApifyInput({ url: adLibUrl, countryCode: 'ALL' });
    expect(input['scrapePageAds.countryCode']).toBe('ALL');
  });
});
