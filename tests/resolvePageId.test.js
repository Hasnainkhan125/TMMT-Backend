'use strict';

/**
 * resolvePageId — unit tests (TDD Red → Green)
 *
 * Three-strategy fallback chain for converting a Facebook handle or brand
 * name into a numeric page ID, required by the view_all_page_id param.
 *
 * Strategy order:
 *   1. meta_tag  — parse <meta property="fb:pages"> from already-scraped HTML (free)
 *   2. about_html — fetch facebook.com/{handle}/about and regex for pageID (free)
 *   3. ad_library — Apify keyword scan, extract page_id from first result (~$0.005)
 *
 * All network calls are mocked. No real tokens spent.
 */

process.env.APIFY_API_TOKEN   = 'test-apify-token';
process.env.APIFY_FB_ADS_ACTOR = 'apify/facebook-ads-scraper';

// ── Mocks (before any require) ─────────────────────────────────────────────

const mockRedisSingleton = {
  get:   jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
};
jest.mock('../services/redis', () => ({
  getRedis: () => mockRedisSingleton,
}));

const mockRunActor = jest.fn();
jest.mock('../services/apify/apifyClient', () => ({
  runActor: (...args) => mockRunActor(...args),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Require after mocks ────────────────────────────────────────────────────

const { resolvePageId } = require('../services/apify/actors/resolvePageId');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAboutHtml(pageId) {
  return `<html><head><title>About</title></head><body>
    <script>window._sharedData = {"pageID":"${pageId}","name":"Test"}</script>
  </body></html>`;
}

function makeApifyResult(pageId) {
  return {
    items: [{
      page_id: pageId,
      page_name: 'Test Brand',
      snapshot: { body: { text: 'Test ad' } },
    }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('resolvePageId — Strategy 1: fb:pages meta tag', () => {
  beforeEach(() => {
    mockRedisSingleton.get.mockResolvedValue(null);
    mockFetch.mockReset();
    mockRunActor.mockReset();
  });

  it('extracts page ID from <meta property="fb:pages"> in scraped HTML', async () => {
    const siteHtml = `
      <html><head>
        <meta property="fb:pages" content="214396565557" />
      </head><body></body></html>
    `;
    const result = await resolvePageId({ handle: 'rakez.ae', siteHtml, brandName: 'RAKEZ' });

    expect(result.pageId).toBe('214396565557');
    expect(result.resolvedBy).toBe('meta_tag');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRunActor).not.toHaveBeenCalled();
  });

  it('extracts page ID from fb:page_id meta tag variant', async () => {
    const siteHtml = `<meta property="fb:page_id" content="169789673075263" />`;
    const result = await resolvePageId({ handle: 'damac', siteHtml, brandName: 'DAMAC' });

    expect(result.pageId).toBe('169789673075263');
    expect(result.resolvedBy).toBe('meta_tag');
  });

  it('handles comma-separated page IDs and returns the first', async () => {
    const siteHtml = `<meta property="fb:pages" content="111111111,222222222" />`;
    const result = await resolvePageId({ siteHtml, brandName: 'Brand' });

    expect(result.pageId).toBe('111111111');
    expect(result.resolvedBy).toBe('meta_tag');
  });
});

describe('resolvePageId — Strategy 2: about page HTML regex', () => {
  beforeEach(() => {
    mockRedisSingleton.get.mockResolvedValue(null);
    mockFetch.mockReset();
    mockRunActor.mockReset();
  });

  it('fetches /about page and extracts numeric pageID from JSON blob', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => makeAboutHtml('214396565557'),
    });

    const result = await resolvePageId({ handle: 'rakez.ae', brandName: 'RAKEZ' });

    expect(result.pageId).toBe('214396565557');
    expect(result.resolvedBy).toBe('about_html');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('facebook.com/rakez.ae'),
      expect.any(Object),
    );
    expect(mockRunActor).not.toHaveBeenCalled();
  });

  it('handles entity_id pattern in page HTML', async () => {
    const html = '<script>"entity_id":"169789673075263","name":"DAMAC"</script>';
    mockFetch.mockResolvedValue({ ok: true, text: async () => html });

    const result = await resolvePageId({ handle: 'damacproperties', brandName: 'DAMAC' });
    expect(result.pageId).toBe('169789673075263');
    expect(result.resolvedBy).toBe('about_html');
  });

  it('skips about fetch when no handle is given', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '<html></html>' });
    mockRunActor.mockResolvedValue(makeApifyResult('999888777'));

    const result = await resolvePageId({ brandName: 'Some Brand' });

    // No handle → skip strategy 2, go straight to ad_library
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.resolvedBy).toBe('ad_library');
  });

  it('moves to strategy 3 when fetch returns non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    mockRunActor.mockResolvedValue(makeApifyResult('555444333'));

    const result = await resolvePageId({ handle: 'unknownbrand', brandName: 'Unknown Brand' });
    expect(result.pageId).toBe('555444333');
    expect(result.resolvedBy).toBe('ad_library');
  });

  it('moves to strategy 3 when fetch throws (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    mockRunActor.mockResolvedValue(makeApifyResult('777666555'));

    const result = await resolvePageId({ handle: 'brand', brandName: 'Brand' });
    expect(result.resolvedBy).toBe('ad_library');
  });
});

describe('resolvePageId — Strategy 3: Ad Library keyword search', () => {
  beforeEach(() => {
    mockRedisSingleton.get.mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    mockRunActor.mockReset();
  });

  it('runs Apify keyword search and returns page_id from first result', async () => {
    mockRunActor.mockResolvedValue(makeApifyResult('214396565557'));

    const result = await resolvePageId({ handle: 'rakez', brandName: 'RAKEZ', country: 'AE' });

    expect(result.pageId).toBe('214396565557');
    expect(result.resolvedBy).toBe('ad_library');
    expect(mockRunActor).toHaveBeenCalledTimes(1);
    // The Apify URL in the input must be a keyword search for the brand name
    const [, input] = mockRunActor.mock.calls[0];
    expect(input.urls[0].url).toContain('q=RAKEZ');
    expect(input.urls[0].url).toContain('search_type=keyword_unordered');
  });

  it('returns null when Apify returns 0 items', async () => {
    mockRunActor.mockResolvedValue({ items: [] });

    const result = await resolvePageId({ handle: 'ghost', brandName: 'Ghost Brand' });
    expect(result.pageId).toBeNull();
    expect(result.resolvedBy).toBeNull();
  });

  it('returns null when Apify throws', async () => {
    mockRunActor.mockRejectedValue(new Error('Apify timeout'));

    const result = await resolvePageId({ handle: 'brand', brandName: 'Brand' });
    expect(result.pageId).toBeNull();
    expect(result.resolvedBy).toBeNull();
  });

  it('skips Apify when no brandName is provided', async () => {
    const result = await resolvePageId({ handle: 'mypage' });
    expect(mockRunActor).not.toHaveBeenCalled();
    expect(result.pageId).toBeNull();
  });
});

describe('resolvePageId — caching', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRunActor.mockReset();
  });

  it('returns cached result without hitting any external service', async () => {
    mockRedisSingleton.get.mockResolvedValue(JSON.stringify({ pageId: '999000111', resolvedBy: 'meta_tag' }));

    const result = await resolvePageId({ handle: 'cached', brandName: 'Cached Brand' });

    expect(result.pageId).toBe('999000111');
    expect(result.resolvedBy).toBe('meta_tag');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRunActor).not.toHaveBeenCalled();
  });

  it('writes result to cache with 30-day TTL on success', async () => {
    mockRedisSingleton.get.mockResolvedValue(null);
    const siteHtml = `<meta property="fb:pages" content="888777666" />`;

    await resolvePageId({ siteHtml, brandName: 'Brand' });

    expect(mockRedisSingleton.setex).toHaveBeenCalledWith(
      expect.any(String),
      2592000, // 30 days
      expect.stringContaining('888777666'),
    );
  });

  it('still writes a null result to cache to avoid hammering on miss', async () => {
    mockRedisSingleton.get.mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    mockRunActor.mockResolvedValue({ items: [] });

    await resolvePageId({ handle: 'nobody', brandName: 'Nobody Brand' });

    expect(mockRedisSingleton.setex).toHaveBeenCalledWith(
      expect.any(String),
      86400, // 24h for misses
      expect.stringContaining('"pageId":null'),
    );
  });
});
