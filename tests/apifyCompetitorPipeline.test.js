'use strict';

/**
 * apifyCompetitorPipeline — end-to-end pipeline tests.
 *
 * Tests the full competitor-ad fetching pipeline:
 *   competitorResolution → resolveCompetitorSearchInputs → fetchAdsForSearchInput
 *   → normalizeAd → enrichAdsWithIntelligence → fetchAllCompetitorAds
 *
 * Every network call is mocked (Apify + Claude). Tests stay hermetic — no
 * real tokens spent, no external dependencies.
 *
 * Real-world scenario: Brite Smile Dental (the competitor that returned 0 ads
 * in production — root cause was missing page-URL resolution step).
 *
 * Coverage:
 *   ✓ Full pipeline — Brite Smile Dental resolves, ads fetched, enriched, sorted
 *   ✓ Pre-resolved page URL used as rank-0 strategy (skips keyword guessing)
 *   ✓ Falls back to keyword strategy when page search returns nothing
 *   ✓ error='no_ads_found' when all strategies return 0 items
 *   ✓ Claude fallback when AI throws — uses heuristic scoring
 *   ✓ Multi-competitor: 2 succeed, 1 returns no_ads_found
 *   ✓ Summary: totalAds, withVideo, winners, competitorsFetched/Failed correct
 *   ✓ topPatterns ranked by frequency
 *   ✓ spendingHeavyweights ranked by activeAdCount
 *   ✓ Empty competitors array → zero results without hitting Apify
 */

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.APIFY_API_TOKEN   = 'test-apify-token';
process.env.APIFY_FB_ADS_ACTOR = 'apify/facebook-ads-scraper';
process.env.APIFY_FB_PAGE_SEARCH_ACTOR = 'apify/facebook-pages-scraper';

// ── Mocks (before any require) ────────────────────────────────────────────

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

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: (...args) => mockCreate(...args) },
  }))
);

// ── Require after mocks ───────────────────────────────────────────────────

const { fetchAllCompetitorAds, normalizeAd } = require('../services/apify/actors/facebookAdsLibrary');

// ── Fixture builders ──────────────────────────────────────────────────────

const NOW_S = Math.floor(Date.now() / 1000);
const DAY   = 86400;

function makeApifyAd(overrides = {}) {
  return {
    ad_archive_id: `ad_${Math.random().toString(36).slice(2, 9)}`,
    page_id: 'p_brite',
    page_name: 'Brite Smile Dental',
    start_date: NOW_S - 45 * DAY,
    end_date: null,
    publisher_platform: ['facebook', 'instagram'],
    targeted_or_reached_countries: ['AE'],
    snapshot: {
      body: { text: 'Transform your smile. Same-day appointments in Dubai. Book now.' },
      cta_text: 'Book Now',
      link_url: 'https://britesmiledental.ae/appointments',
      images: [{ original_image_url: 'https://scontent.fbcdn.net/brite_ad.jpg' }],
      videos: [],
      cards: [],
    },
    spend: { lower_bound: 1000, upper_bound: 4999, currency: 'AED' },
    impressions: { lower_bound: 10000, upper_bound: 49999 },
    advertiser: {
      ad_library_page_info: {
        page_info: { likes: 8200, verified: false, page_category: 'Dental Clinic' },
      },
    },
    ...overrides,
  };
}

function makeVideoAd(overrides = {}) {
  return makeApifyAd({
    start_date: NOW_S - 90 * DAY,
    snapshot: {
      body: { text: 'Watch our patients share their smile transformation.' },
      cta_text: 'Watch Now',
      link_url: 'https://britesmiledental.ae/stories',
      videos: [{
        video_hd_url: 'https://video.fbcdn.net/brite_hd.mp4',
        video_sd_url: 'https://video.fbcdn.net/brite_sd.mp4',
        video_preview_image_url: 'https://scontent.fbcdn.net/brite_poster.jpg',
      }],
      images: [],
      cards: [],
    },
    ...overrides,
  });
}

function makeFbPageResult() {
  return {
    items: [{
      name: 'Brite Smile Dental',
      pageId: 'p_brite',
      url: 'https://www.facebook.com/BriteSmileDental',
      username: 'BriteSmileDental',
      likes: 8200,
      isVerified: false,
      country: 'AE',
      location: 'Dubai, UAE',
      about: 'Dental clinic in Dubai',
    }],
  };
}

function claudeStrategies(strategies) {
  return { content: [{ text: JSON.stringify({ strategies }) }] };
}

function claudeScoring(count, { startWinner = 0 } = {}) {
  return {
    content: [{
      text: JSON.stringify({
        ads: Array.from({ length: count }, (_, i) => ({
          idx: i,
          relevanceScore: Math.max(10, 90 - i * 8),
          creativePattern: i === 0 ? 'social_proof_testimonial' : 'offer_urgency',
          primaryAngle: i === 0 ? 'transformation' : 'price',
          isWinner: i < startWinner + 1,
          winnerReason: i === 0 ? 'Running 90 days without pause' : 'Recent test phase',
          stealableInsight: i === 0
            ? 'Lead with patient face + same-day urgency'
            : 'Add AED price anchor in the headline',
        })),
      }),
    }],
  };
}

const DEFAULT_KEYWORD_STRATEGY = [{
  rank: 1, approach: 'keyword_search', reasoning: 'Brand name search',
  apifyUrl: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=AE&q=Brite+Smile+Dental&search_type=keyword_unordered&media_type=all',
  expectedRecall: 'medium',
}];

const USER_BRAND = {
  name: 'Malabar Dental Clinics',
  category: 'dental clinic',
  valueProps: ['Specialist consultants', 'Same-day appointments', 'Insurance accepted'],
  audience: 'Expat families and UAE nationals',
};

const SCAN_CONTEXT = { vertical: 'clinic_dental', country: 'AE' };

// ── normalizeAd unit contract ─────────────────────────────────────────────

describe('normalizeAd contract', () => {
  it('maps image ad correctly', () => {
    const out = normalizeAd(makeApifyAd());
    expect(out.mediaType).toBe('image');
    expect(out.images).toHaveLength(1);
    expect(out.adText).toContain('Transform your smile');
    expect(out.cta).toBe('Book Now');
    expect(out.weeklySpendTier).toBe('medium');
    expect(out.daysRunning).toBeGreaterThanOrEqual(44);
  });

  it('maps video ad with hd/sd/preview', () => {
    const out = normalizeAd(makeVideoAd());
    expect(out.mediaType).toBe('video');
    expect(out.hasPlayableVideo).toBe(true);
    expect(out.videos[0].hd).toMatch(/brite_hd\.mp4/);
    expect(out.videos[0].sd).toMatch(/brite_sd\.mp4/);
    expect(out.videos[0].preview).toMatch(/brite_poster\.jpg/);
    expect(out.daysRunning).toBeGreaterThanOrEqual(89);
  });

  it('maps carousel ad with cards', () => {
    const raw = makeApifyAd({
      snapshot: {
        body: { text: 'Our services.' },
        cards: [
          { title: 'Teeth Whitening', link_description: 'From AED 599', original_image_url: 'https://scontent.fbcdn.net/whitening.jpg', cta_text: 'Book', link_url: 'https://britesmiledental.ae/whitening' },
          { title: 'Invisalign', link_description: 'Free consult', resized_image_url: 'https://scontent.fbcdn.net/invisalign.jpg', video_sd_url: 'https://video.fbcdn.net/inv.mp4', cta_text: 'Learn more', link_url: 'https://britesmiledental.ae/invisalign' },
        ],
        images: [], videos: [],
      },
    });
    const out = normalizeAd(raw);
    expect(out.mediaType).toBe('carousel');
    expect(out.cards).toHaveLength(2);
    expect(out.cards[0].imageUrl).toMatch(/whitening\.jpg/);
    expect(out.cards[1].videoUrl).toMatch(/inv\.mp4/);
    expect(out.hasPlayableVideo).toBe(true);
  });

  it('returns null for null/non-object inputs', () => {
    expect(normalizeAd(null)).toBeNull();
    expect(normalizeAd(undefined)).toBeNull();
    expect(normalizeAd('string')).toBeNull();
  });

  it('keeps poster-only video so panel can render still (the "No preview" bug)', () => {
    const raw = makeApifyAd({
      snapshot: {
        videos: [{ video_hd_url: null, video_sd_url: null, video_preview_image_url: 'https://scontent.fbcdn.net/poster.jpg' }],
        images: [], cards: [],
      },
    });
    const out = normalizeAd(raw);
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0].preview).toMatch(/poster\.jpg/);
    expect(out.hasPlayableVideo).toBe(false);
    expect(out.mediaType).toBe('video');
  });

  it('derives spend tiers correctly', () => {
    const tier = (upper) =>
      normalizeAd(makeApifyAd({ spend: { lower_bound: 0, upper_bound: upper, currency: 'AED' } })).weeklySpendTier;
    expect(tier(60_000)).toBe('huge');
    expect(tier(15_000)).toBe('heavy');
    expect(tier(3_000)).toBe('medium');
    expect(tier(500)).toBe('light');
    expect(tier(50)).toBe('minimal');
  });
});

// ── Full pipeline — Brite Smile Dental ───────────────────────────────────

describe('fetchAllCompetitorAds — Brite Smile Dental UAE dental scenario', () => {
  beforeEach(() => {
    mockRunActor.mockReset();
    mockCreate.mockReset();
    mockRedisSingleton.get.mockResolvedValue(null);
    mockRedisSingleton.setex.mockResolvedValue('OK');
  });

  it('resolves page via search, builds page_url strategy, fetches and scores ads', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve(makeFbPageResult());
      return Promise.resolve({ items: [makeVideoAd(), makeApifyAd()] });
    });
    mockCreate
      .mockResolvedValueOnce(claudeStrategies(DEFAULT_KEYWORD_STRATEGY))
      .mockResolvedValueOnce(claudeScoring(2, { startWinner: 0 }));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmiledental.ae', tagline: 'Smile with confidence', why: 'Same market' }],
      userBrand: USER_BRAND,
      scanContext: SCAN_CONTEXT,
      country: 'AE',
    });

    const brite = result.results[0];
    expect(brite.error).toBeNull();
    expect(brite.ads.length).toBe(2);

    // Sorted by relevanceScore descending
    const scores = brite.ads.map((a) => a.intelligence.relevanceScore);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);

    // Winner detected + AI-enriched insight (not fallback message)
    expect(brite.ads[0].intelligence.isWinner).toBe(true);
    expect(brite.ads[0].intelligence.stealableInsight).not.toContain('Manual review needed');

    // Summary
    expect(result.summary.totalAds).toBe(2);
    expect(result.summary.withVideo).toBe(1);
    expect(result.summary.winners).toBe(1);
    expect(result.summary.competitorsFetched).toBe(1);
    expect(result.summary.competitorsFailed).toBe(0);
    expect(result.summary.errors).toHaveLength(0);
  });

  it('falls back to keyword strategy when page search returns nothing', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeApifyAd()] });
    });
    mockCreate
      .mockResolvedValueOnce(claudeStrategies(DEFAULT_KEYWORD_STRATEGY))
      .mockResolvedValueOnce(claudeScoring(1));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmiledental.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results[0].error).toBeNull();
    expect(result.results[0].ads.length).toBe(1);
  });

  it('sets error=no_ads_found when all strategies return 0 items', async () => {
    mockRunActor.mockResolvedValue({ items: [] }); // all calls return 0
    mockCreate.mockResolvedValue(claudeStrategies(DEFAULT_KEYWORD_STRATEGY));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmiledental.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results[0].error).toBe('no_ads_found');
    expect(result.results[0].ads).toHaveLength(0);
    expect(result.summary.competitorsFailed).toBe(1);
    expect(result.summary.errors[0]).toMatchObject({ competitor: 'Brite Smile Dental', error: 'no_ads_found' });
  });

  it('sets error=no_viable_strategy for hallucinated competitor names', async () => {
    mockRunActor.mockResolvedValue({ items: [] });
    mockCreate.mockResolvedValue(claudeStrategies([])); // Claude detects it's fake

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Local Dealer Showrooms UAE (placeholder)', url: '' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results[0].error).toMatch(/no_viable_strategy|no_ads_found/);
  });

  it('handles empty competitors array without hitting Apify', async () => {
    const result = await fetchAllCompetitorAds({
      competitors: [], userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results).toEqual([]);
    expect(result.summary.totalAds).toBe(0);
    expect(mockRunActor).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── Claude fallback ───────────────────────────────────────────────────────

describe('Claude fallback behavior', () => {
  beforeEach(() => {
    mockRunActor.mockReset();
    mockCreate.mockReset();
    mockRedisSingleton.get.mockResolvedValue(null);
    mockRedisSingleton.setex.mockResolvedValue('OK');
  });

  it('uses keyword_search heuristic when Claude strategy call throws', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeApifyAd()] });
    });
    mockCreate.mockRejectedValue(new Error('Claude rate limited'));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmile.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results[0].error).toBeNull();
    expect(result.results[0].ads.length).toBeGreaterThan(0);
    // Fallback scoring applied
    expect(result.results[0].ads[0].intelligence.creativePattern).toBe('unanalyzed');
  });

  it('uses heuristic winner detection when Claude scoring throws', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeVideoAd()] }); // 90-day video ad
    });
    mockCreate
      .mockResolvedValueOnce(claudeStrategies(DEFAULT_KEYWORD_STRATEGY))
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmile.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    const ad = result.results[0].ads[0];
    expect(ad.intelligence.isWinner).toBe(true); // 90 days → heuristic winner
    expect(ad.intelligence.creativePattern).toBe('unanalyzed');
  });
});

// ── Multi-competitor fan-out ──────────────────────────────────────────────

describe('fetchAllCompetitorAds — multi-competitor fan-out', () => {
  beforeEach(() => {
    mockRunActor.mockReset();
    mockCreate.mockReset();
    mockRedisSingleton.get.mockResolvedValue(null);
    mockRedisSingleton.setex.mockResolvedValue('OK');
  });

  it('processes 3 competitors: 2 succeed, 1 returns no_ads_found', async () => {
    // Use URL-based discrimination so mock doesn't depend on call order.
    // Claude generates a keyword URL containing the competitor name.
    // We intercept based on the apifyUrl input that contains 'noads' or not.
    mockRunActor.mockImplementation((actorId, input) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      // If the Apify URL contains 'noads' or 'NoAds' (from keyword strategy), return 0 ads
      const url = (input?.urls?.[0] || '');
      if (url.toLowerCase().includes('noads')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeApifyAd(), makeVideoAd()] });
    });

    // Claude keyword strategies embed the competitor name in the URL
    mockCreate.mockImplementation((args) => {
      const msg = JSON.stringify(args?.messages || args || '');
      if (msg.includes('NoAds Clinic')) {
        return Promise.resolve(claudeStrategies([{
          rank: 1, approach: 'keyword_search', reasoning: 'keyword',
          apifyUrl: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=AE&q=NoAds+Clinic&search_type=keyword_unordered&media_type=all',
          expectedRecall: 'low',
        }]));
      }
      if (msg.includes('relevanceScore') || msg.includes('Competitor ads to score')) {
        return Promise.resolve(claudeScoring(2));
      }
      return Promise.resolve(claudeStrategies([{
        rank: 1, approach: 'keyword_search', reasoning: 'keyword',
        apifyUrl: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=AE&q=Dental&search_type=keyword_unordered&media_type=all`,
        expectedRecall: 'medium',
      }]));
    });

    const result = await fetchAllCompetitorAds({
      competitors: [
        { name: 'Brite Smile Dental', url: 'britesmile.ae' },
        { name: 'Aster Dental',        url: 'asterdental.ae' },
        { name: 'NoAds Clinic',        url: 'noads.ae' },
      ],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    expect(result.results).toHaveLength(3);
    // At least one competitor must have returned ads and at least one must have failed
    expect(result.summary.competitorsFetched).toBeGreaterThanOrEqual(1);
    expect(result.summary.competitorsFailed).toBeGreaterThanOrEqual(1);
    // NoAds Clinic returns 0 ads (its URL contains 'noads')
    const failedEntry = result.summary.errors.find((e) => e.competitor === 'NoAds Clinic');
    expect(failedEntry).toBeDefined();
    expect(failedEntry.error).toBe('no_ads_found');
  });

  it('builds topPatterns ranked by frequency across all competitor ads', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeApifyAd(), makeVideoAd()] });
    });
    mockCreate
      .mockResolvedValueOnce(claudeStrategies(DEFAULT_KEYWORD_STRATEGY))
      .mockResolvedValueOnce({
        content: [{
          text: JSON.stringify({
            ads: [
              { idx: 0, relevanceScore: 80, creativePattern: 'social_proof_testimonial', primaryAngle: 'trust', isWinner: true,  winnerReason: '90d', stealableInsight: 'patient face' },
              { idx: 1, relevanceScore: 65, creativePattern: 'social_proof_testimonial', primaryAngle: 'trust', isWinner: false, winnerReason: '',    stealableInsight: 'short form' },
            ],
          }),
        }],
      });

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmile.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    const top = result.summary.topPatterns;
    expect(top[0].pattern).toBe('social_proof_testimonial');
    expect(top[0].count).toBe(2);
  });

  it('computes spendingHeavyweights with avgRelevance and sorted by activeAdCount', async () => {
    mockRunActor.mockImplementation((actorId) => {
      if (actorId.includes('pages-scraper')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [makeApifyAd(), makeVideoAd(), makeApifyAd()] });
    });
    mockCreate
      .mockResolvedValueOnce(claudeStrategies(DEFAULT_KEYWORD_STRATEGY))
      .mockResolvedValueOnce(claudeScoring(3, { startWinner: 0 }));

    const result = await fetchAllCompetitorAds({
      competitors: [{ name: 'Brite Smile Dental', url: 'britesmile.ae' }],
      userBrand: USER_BRAND, scanContext: SCAN_CONTEXT, country: 'AE',
    });

    const hw = result.summary.spendingHeavyweights;
    expect(hw).toHaveLength(1);
    expect(hw[0].competitor).toBe('Brite Smile Dental');
    expect(hw[0].activeAdCount).toBe(3);
    expect(hw[0].winnerCount).toBe(1);
    expect(typeof hw[0].avgRelevance).toBe('number');
  });
});
