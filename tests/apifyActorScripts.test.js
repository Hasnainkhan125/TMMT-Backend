'use strict';

/**
 * Unit tests for Apify CLI input builders + Google Places normalization.
 * Run: NODE_ENV=test npx jest tests/apifyActorScripts.test.js
 *
 * Live Apify runs: use scripts under scripts/apify/*.js with APIFY_API_TOKEN.
 */

const {
  ACTORS,
  buildGooglePlacesInput,
  buildGoogleSearchScraperInput,
  buildInstagramScraperInput,
  buildFacebookAdsLibraryInput,
  buildTikTokProfileInput,
  parseScriptArgv,
  summarizeDatasetItems,
} = require('../scripts/apify/lib/actorInputs');

const {
  normalizeReviews,
  normalizePlace,
  collectSocialUrls,
} = require('../services/apify/actors/googleMaps');

const { facebookAdsMemoryMbytesForInput } = require('../services/apify/actors/buildAdLibraryUrl');

describe('actorInputs — Google Places', () => {
  it('buildGooglePlacesInput requires search strings', () => {
    expect(() => buildGooglePlacesInput({})).toThrow(/searchStrings required/);
  });

  it('buildGooglePlacesInput defaults location to United States', () => {
    const i = buildGooglePlacesInput({ searchStrings: 'cafe' });
    expect(i.locationQuery).toBe('United States');
    expect(i.searchStringsArray).toEqual(['cafe']);
  });

  it('buildGooglePlacesInput clamps maxCrawledPlacesPerSearch to 50', () => {
    const i = buildGooglePlacesInput({ searchStrings: 'x', maxCrawledPlacesPerSearch: 999 });
    expect(i.maxCrawledPlacesPerSearch).toBe(50);
  });

  it('buildGooglePlacesInput adds review fields when scrapeReviews is true', () => {
    const i = buildGooglePlacesInput({
      searchStrings: 'spa',
      scrapeReviews: true,
      maxReviews: 12,
    });
    expect(i.scrapeReviews).toBe(true);
    expect(i.maxReviews).toBe(12);
  });
});

describe('actorInputs — Google Search Scraper', () => {
  it('buildGoogleSearchScraperInput requires queries', () => {
    expect(() => buildGoogleSearchScraperInput({})).toThrow(/queries required/);
  });

  it('buildGoogleSearchScraperInput enables ai + perplexity by default', () => {
    const i = buildGoogleSearchScraperInput({ queries: 'top CRM tools' });
    expect(i.queries).toBe('top CRM tools');
    expect(i.aiModeSearch.enableAiMode).toBe(true);
    expect(i.perplexitySearch.enablePerplexity).toBe(true);
    expect(i.perplexitySearch.returnImages).toBe(true);
  });

  it('buildGoogleSearchScraperInput clamps resultsPerPage', () => {
    const low = buildGoogleSearchScraperInput({ queries: 'q', resultsPerPage: 3 });
    expect(low.resultsPerPage).toBe(10);
    const high = buildGoogleSearchScraperInput({ queries: 'q', resultsPerPage: 500 });
    expect(high.resultsPerPage).toBe(100);
  });
});

describe('actorInputs — Instagram apify/instagram-scraper', () => {
  it('buildInstagramScraperInput requires url or search', () => {
    expect(() => buildInstagramScraperInput({ directUrls: [] })).toThrow(/directUrls or search/);
  });

  it('buildInstagramScraperInput maps directUrls and limits', () => {
    const i = buildInstagramScraperInput({
      directUrls: ['https://www.instagram.com/humansofny/'],
      resultsLimit: 1000,
      resultsType: 'posts',
    });
    expect(i.directUrls[0]).toContain('instagram.com');
    expect(i.resultsLimit).toBe(200);
    expect(i.resultsType).toBe('posts');
  });

  it('buildInstagramScraperInput supports hashtag search mode', () => {
    const i = buildInstagramScraperInput({
      search: 'restaurants',
      searchType: 'hashtag',
      searchLimit: 10,
    });
    expect(i.search).toBe('restaurants');
    expect(i.searchType).toBe('hashtag');
  });
});

describe('actorInputs — Facebook + TikTok', () => {
  it('buildFacebookAdsLibraryInput requires keyword or pageId', () => {
    expect(() => buildFacebookAdsLibraryInput({})).toThrow(/keyword or pageId/);
  });

  it('buildFacebookAdsLibraryInput builds urls array for keyword', () => {
    const i = buildFacebookAdsLibraryInput({ keyword: 'test brand', country: 'AE', count: 10 });
    expect(i.urls).toBeDefined();
    expect(Array.isArray(i.urls)).toBe(true);
    expect(i.urls[0].url).toContain('facebook.com/ads/library');
    expect(i.count).toBe(10);
  });

  it('buildFacebookAdsLibraryInput defaults Ad Library country to US', () => {
    const i = buildFacebookAdsLibraryInput({ keyword: 'soda brand', count: 5 });
    expect(i['scrapePageAds.countryCode']).toBe('US');
    expect(i.urls[0].url).toContain('country=US');
  });

  it('facebookAdsMemoryMbytesForInput uses 512MB per curious_coder URL', () => {
    const one = buildFacebookAdsLibraryInput({ keyword: 'a', country: 'AE', count: 5 });
    expect(facebookAdsMemoryMbytesForInput(one, 'curious_coder/facebook-ads-library-scraper')).toBe(512);
    const multi = { ...one, urls: [one.urls[0], one.urls[0], one.urls[0]] };
    expect(facebookAdsMemoryMbytesForInput(multi, 'curious_coder/facebook-ads-library-scraper')).toBe(1536);
  });

  it('facebookAdsMemoryMbytesForInput uses searchUrls for webdatalabs actor', () => {
    const input = { searchUrls: ['https://example.com/1', 'https://example.com/2'] };
    expect(facebookAdsMemoryMbytesForInput(input, 'webdatalabs/foo')).toBe(1024);
  });

  it('buildTikTokProfileInput clamps resultsPerPage 5–40', () => {
    const lo = buildTikTokProfileInput({ profiles: ['a'], resultsPerPage: 1 });
    expect(lo.resultsPerPage).toBe(5);
    const hi = buildTikTokProfileInput({ profiles: ['a'], resultsPerPage: 99 });
    expect(hi.resultsPerPage).toBe(40);
  });
});

describe('actorInputs — CLI + summary helpers', () => {
  it('parseScriptArgv parses --key value and boolean flags', () => {
    const { flags } = parseScriptArgv(['node', 'x', '--search', 'foo', '--reviews']);
    expect(flags.search).toBe('foo');
    expect(flags.reviews).toBe(true);
  });

  it('summarizeDatasetItems truncates long JSON', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ n: i, t: 'x'.repeat(2000) }));
    const s = summarizeDatasetItems(big, { maxItems: 2, maxChars: 500 });
    expect(s.truncated).toBe(true);
    expect(s.itemCount).toBe(20);
  });

  it('ACTORS map includes expected ids', () => {
    expect(ACTORS.GOOGLE_PLACES).toContain('crawler-google-places');
    expect(ACTORS.GOOGLE_SEARCH).toBe('apify/google-search-scraper');
    expect(ACTORS.INSTAGRAM_SCRAPER).toBe('apify/instagram-scraper');
    expect(ACTORS.TIKTOK).toContain('tiktok');
  });
});

describe('googleMaps — reviews + place normalization', () => {
  it('normalizeReviews returns empty for bad input', () => {
    expect(normalizeReviews(null)).toEqual([]);
    expect(normalizeReviews({})).toEqual([]);
  });

  it('normalizeReviews merges review arrays and caps count', () => {
    const raw = {
      reviews: [{ text: 'Great', stars: 5, name: 'A' }],
      reviewsList: [{ reviewText: 'Great', rating: 5, reviewer: 'A' }],
    };
    const r = normalizeReviews(raw, 1);
    expect(r.length).toBe(1);
    expect(r[0].text).toBe('Great');
  });

  it('normalizePlace includes reviews and socialUrls', () => {
    const p = normalizePlace({
      title: 'Test Cafe',
      address: 'Dubai',
      reviews: [{ text: 'Nice', stars: 4, name: 'U' }],
      instagram: 'https://www.instagram.com/foo/',
    });
    expect(p.name).toBe('Test Cafe');
    expect(p.reviews.length).toBe(1);
    expect(p.socialUrls.instagram).toContain('instagram.com/foo');
  });

  it('collectSocialUrls reads nested socialMedia object', () => {
    const u = collectSocialUrls({
      socialMedia: { instagram: 'https://www.instagram.com/x/', facebookPage: 'https://facebook.com/y' },
    });
    expect(u.instagram).toBeTruthy();
    expect(u.facebook).toBeTruthy();
  });
});
