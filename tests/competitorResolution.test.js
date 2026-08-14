'use strict';

/**
 * competitorResolution — unit tests.
 *
 * Tests the scoring engine that picks the best Facebook page for a competitor.
 * No real network calls — runActor is mocked to return canned Apify responses.
 *
 * Coverage:
 *   ✓ Picks exact-name match over weaker candidates
 *   ✓ Boosts UAE-located pages over higher-follower non-UAE pages
 *   ✓ Boosts verified pages over unverified
 *   ✓ Returns resolved:false when Apify returns nothing
 *   ✓ Returns resolved:false when best score is below threshold
 *   ✓ Cache hit on second call — Apify not called twice
 *   ✓ Builds fallback URL from username when url field is absent
 *   ✓ Does not throw on Apify error — returns resolved:false
 *   ✓ enrichCompetitorsWithFbPages injects facebookPageUrl per resolved competitor
 *   ✓ enrichCompetitorsWithFbPages preserves existing pageUrl on resolution failure
 *   ✓ enrichCompetitorsWithFbPages is non-fatal when one competitor throws
 *   ✓ Does not pick a hugely popular but completely mismatched page
 */

process.env.APIFY_API_TOKEN = 'test-token';
process.env.APIFY_FB_PAGE_SEARCH_ACTOR = 'apify/facebook-pages-scraper';

// ── Mocks ─────────────────────────────────────────────────────────────────

// Singleton redis mock — all calls to getRedis() return the SAME object
// so spy assertions in tests match what the module actually called.
const mockRedisSingleton = {
  get:   jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
  set:   jest.fn().mockResolvedValue('OK'),
};

jest.mock('../services/redis', () => ({
  getRedis: () => mockRedisSingleton,
}));

const mockRunActor = jest.fn();
jest.mock('../services/apify/apifyClient', () => ({
  runActor: (...args) => mockRunActor(...args),
}));

// ── Require after mocks ───────────────────────────────────────────────────

const { resolveCompetitorFbPage, enrichCompetitorsWithFbPages } = require('../services/apify/competitorResolution');

// ── Fixtures ──────────────────────────────────────────────────────────────

function makePages(list = []) {
  const defaults = {
    name: 'Unknown Page', pageId: null, url: null, username: null,
    likes: 0, isVerified: false, country: null, location: '', about: '',
  };
  return { items: list.map((p) => ({ ...defaults, ...p })) };
}

// ── resolveCompetitorFbPage ───────────────────────────────────────────────

describe('resolveCompetitorFbPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisSingleton.get.mockResolvedValue(null);
    mockRedisSingleton.setex.mockResolvedValue('OK');
  });

  it('picks the page whose name matches the competitor exactly (highest Jaccard)', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Brite Smile Dental',  pageId: 'p_brite',  url: 'https://www.facebook.com/BriteSmileDental',  likes: 8200, country: 'AE' },
      { name: 'Bright Smiles Salon', pageId: 'p_salon',  url: 'https://www.facebook.com/BrightSmilesSalon', likes: 3100, country: 'AE' },
      { name: 'Smile Zone Dental',   pageId: 'p_zone',   url: 'https://www.facebook.com/SmileZoneDental',   likes: 5000, country: 'AE' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(true);
    expect(result.pageUrl).toBe('https://www.facebook.com/BriteSmileDental');
    expect(result.pageId).toBe('p_brite');
    expect(result.score).toBeGreaterThan(50);
  });

  it('boosts UAE-located page over a higher-follower non-UAE page', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Brite Smile Dental Dubai', pageId: 'p_uae', url: 'https://www.facebook.com/BriteSmileDubai', likes: 4000, country: 'AE', location: 'Dubai, UAE' },
      { name: 'Brite Smile Dental US',    pageId: 'p_us',  url: 'https://www.facebook.com/BriteSmileUS',   likes: 50000, country: 'US', location: 'Los Angeles, CA' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(true);
    expect(result.pageId).toBe('p_uae');
  });

  it('boosts verified page even with fewer followers than an unverified rival', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Hot Shay', pageId: 'p_verified',   url: 'https://www.facebook.com/hotshay',   likes: 12000, isVerified: true,  country: 'AE' },
      { name: 'Hot Shay', pageId: 'p_unverified', url: 'https://www.facebook.com/hotshayAE', likes: 25000, isVerified: false, country: 'AE' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Hot Shay', country: 'AE' });

    expect(result.pageId).toBe('p_verified');
  });

  it('returns resolved:false when Apify returns empty list', async () => {
    mockRunActor.mockResolvedValue(makePages([]));

    const result = await resolveCompetitorFbPage({ competitorName: 'NonExistent Brand', country: 'AE' });

    expect(result.resolved).toBe(false);
    expect(result.pageUrl).toBeNull();
    expect(result.candidates).toBe(0);
  });

  it('returns resolved:false when best score is below minimum threshold', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Completely Unrelated Page', pageId: 'p_rnd', url: 'https://www.facebook.com/random', likes: 5000, country: 'US' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Malabar Dental Clinics', country: 'AE' });

    expect(result.resolved).toBe(false);
  });

  it('stores result in redis (setex) so future calls can be served from cache', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Brite Smile Dental', pageId: 'p_brite', url: 'https://www.facebook.com/BriteSmileDental', likes: 8200, country: 'AE' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(true);
    expect(mockRedisSingleton.setex).toHaveBeenCalledWith(
      expect.stringContaining('fb-page-resolve'),
      172800,
      expect.any(String),
    );
    const stored = JSON.parse(mockRedisSingleton.setex.mock.calls[0][2]);
    expect(stored.pageId).toBe('p_brite');
    expect(stored.resolved).toBe(true);
  });

  it('returns cached result without calling Apify when redis get returns data', async () => {
    const cachedResult = JSON.stringify({
      pageUrl: 'https://www.facebook.com/BriteSmileDental',
      pageId: 'p_brite_cached',
      pageName: 'Brite Smile Dental',
      score: 75,
      resolved: true,
      candidates: 1,
    });
    mockRedisSingleton.get.mockResolvedValue(cachedResult);

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(mockRunActor).not.toHaveBeenCalled();
    expect(result.resolved).toBe(true);
    expect(result.pageId).toBe('p_brite_cached');
  });

  it('builds fallback URL from username when url field is absent', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Brite Smile Dental', pageId: null, url: null, username: 'BriteSmileDentalAE', likes: 5000, country: 'AE' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(true);
    expect(result.pageUrl).toBe('https://www.facebook.com/BriteSmileDentalAE');
  });

  it('does not throw when Apify throws — returns resolved:false', async () => {
    mockRunActor.mockRejectedValue(new Error('Apify quota exceeded'));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(false);
    expect(result.pageUrl).toBeNull();
  });

  it('handles Arabic competitor name without throwing', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'مالابار لعيادات الأسنان', pageId: 'p_ar', url: 'https://www.facebook.com/malabar', likes: 3000, country: 'AE' },
    ]));

    await expect(
      resolveCompetitorFbPage({ competitorName: 'مالابار', country: 'AE' })
    ).resolves.toBeDefined();
  });

  it('does not pick a wildly mismatched page just because it has 500k followers', async () => {
    mockRunActor.mockResolvedValue(makePages([
      { name: 'Dubai Government', pageId: 'p_gov', url: 'https://www.facebook.com/DubaiGov', likes: 500000, isVerified: true, country: 'AE' },
    ]));

    const result = await resolveCompetitorFbPage({ competitorName: 'Brite Smile Dental', country: 'AE' });

    expect(result.resolved).toBe(false);
  });
});

// ── enrichCompetitorsWithFbPages ──────────────────────────────────────────

describe('enrichCompetitorsWithFbPages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisSingleton.get.mockResolvedValue(null);
    mockRedisSingleton.setex.mockResolvedValue('OK');
  });

  it('injects facebookPageUrl for resolved competitors, null for unresolved', async () => {
    mockRunActor
      .mockResolvedValueOnce(makePages([
        { name: 'Brite Smile Dental', pageId: 'p1', url: 'https://www.facebook.com/BriteSmileDental', likes: 8000, country: 'AE' },
      ]))
      .mockResolvedValueOnce(makePages([])); // second one unknown

    const competitors = [
      { name: 'Brite Smile Dental', url: 'britesmile.ae', tagline: 'Smile with confidence' },
      { name: 'Unknown Clinic',      url: 'unknownclinic.ae' },
    ];

    const enriched = await enrichCompetitorsWithFbPages(competitors, 'AE', 'clinic_dental');

    expect(enriched[0].facebookPageUrl).toBe('https://www.facebook.com/BriteSmileDental');
    expect(enriched[0]._fbPageResolution.resolved).toBe(true);
    expect(enriched[1].facebookPageUrl).toBeNull();
    expect(enriched[1]._fbPageResolution.resolved).toBe(false);
  });

  it('preserves existing facebookPageUrl when Apify resolution fails', async () => {
    mockRunActor.mockResolvedValue(makePages([]));

    const competitors = [
      { name: 'Malabar Dental', url: 'malabar.ae', facebookPageUrl: 'https://www.facebook.com/MalabarDentalClinics' },
    ];

    const enriched = await enrichCompetitorsWithFbPages(competitors, 'AE');

    expect(enriched[0].facebookPageUrl).toBe('https://www.facebook.com/MalabarDentalClinics');
  });

  it('returns empty array for empty input without calling Apify', async () => {
    const enriched = await enrichCompetitorsWithFbPages([], 'AE');

    expect(enriched).toEqual([]);
    expect(mockRunActor).not.toHaveBeenCalled();
  });

  it('is non-fatal — returns partial results when one competitor Apify call throws', async () => {
    mockRunActor
      .mockRejectedValueOnce(new Error('Timeout for first'))
      .mockResolvedValueOnce(makePages([
        { name: 'Aster Dental', pageId: 'p2', url: 'https://www.facebook.com/AsterDental', likes: 20000, country: 'AE' },
      ]));

    const competitors = [
      { name: 'BrokenClinic', url: 'broken.ae' },
      { name: 'Aster Dental',  url: 'asterdental.ae' },
    ];

    const enriched = await enrichCompetitorsWithFbPages(competitors, 'AE');

    expect(enriched).toHaveLength(2);
    expect(enriched[0].name).toBe('BrokenClinic');
    expect(enriched[1].facebookPageUrl).toBe('https://www.facebook.com/AsterDental');
  });
});
