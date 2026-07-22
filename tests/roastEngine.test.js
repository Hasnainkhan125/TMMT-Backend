'use strict';

/**
 * roastEngine — unit tests.
 *
 * Pins down the two non-AI surfaces of the engine:
 *   1. extractRoastSignals  — own-outlets vs. competitors split, worst
 *      outlet computation, handle-gap detection. This is the deterministic
 *      core that both the AI prompt AND the fallback rely on; if it lies,
 *      everything downstream lies.
 *   2. fallbackInsights     — what the user sees when the AI path is
 *      unavailable (ANTHROPIC_API_KEY missing, Claude rate-limited, etc).
 *      Must surface a critical "Reputation" insight when an own outlet
 *      is below 3★ — that's the Hot Shay scenario.
 */

process.env.ANTHROPIC_API_KEY = '';

jest.mock('../services/redis', () => ({
  getRedis: () => ({
    get:   async () => null,
    setex: async () => null,
    set:   async () => null,
  }),
}));

const { extractRoastSignals, fallbackInsights, extractFirstJsonObject } = require('../services/roastEngine');

describe('roastEngine.extractRoastSignals', () => {
  it('separates own outlets from place competitors and finds the worst-rated own outlet', () => {
    const scan = {
      host: 'hotshay.ae',
      brand: { name: 'Hot Shay', category: 'restaurant' },
      businessProfile: { type: 'restaurant' },
      audience: { primary: 'Gulf families' },
      apifyData: {
        googleMapsPlaces: [
          // Own outlets — should be detected via brand-slug match
          { name: 'Hot Shay Al Barsha', rating: 4.0, reviewsCount: 333 },
          { name: 'Hot Shay DIFC',       rating: 1.6, reviewsCount: 113 },
          { name: 'Hot Shay Deira',      rating: 2.7, reviewsCount: 136 },
          // Competitors — should be detected as NOT this brand
          { name: 'Koukh Al Shay',       rating: 4.3, reviewsCount: 935 },
          { name: 'Karak House',         rating: 4.1, reviewsCount: 412 },
          { name: 'Tea Junction',        rating: 4.0, reviewsCount: 25  }, // < 20 review filter? above threshold
        ],
        competitorAds: [
          { competitor: 'Koukh Al Shay', ads: [{ intelligence: { isWinner: true } }, { intelligence: {} }], successfulStrategy: 'pages_search' },
          { competitor: 'Karak House',   ads: [], error: 'no_pages_found' },
        ],
      },
      intelligence: {
        brandIdentity: { handles: { facebookHandle: 'hotshayuae' } },
      },
      moneyMath: {
        vertical: 'restaurant',
        benchmarks: { avgCPL: 18, avgLTV: 280 },
        confidenceLevel: 'low',
        warnings: ['static fallback'],
      },
    };

    const sig = extractRoastSignals(scan);

    // Own outlet split
    expect(sig.ownOutletStats).not.toBeNull();
    expect(sig.ownOutletStats.count).toBe(3);
    expect(sig.ownOutletStats.outletsBelow3Stars).toBe(2); // 1.6, 2.7
    expect(sig.ownOutletStats.worstOutlet.name).toBe('Hot Shay DIFC');
    expect(sig.ownOutletStats.worstOutlet.rating).toBe(1.6);
    expect(sig.ownOutletStats.bestOutlet.name).toBe('Hot Shay Al Barsha');
    expect(sig.ownOutletStats.totalReviews).toBe(333 + 113 + 136);
    // avg = (4.0 + 1.6 + 2.7) / 3 = 2.766... → rounded to 1 decimal = 2.8
    expect(sig.ownOutletStats.avgRating).toBeCloseTo(2.8, 1);

    // Competitor split (rating-Finite + ≥20 reviews + sorted by reviewCount desc)
    expect(sig.topPlaceCompetitors[0].name).toBe('Koukh Al Shay');
    expect(sig.topPlaceCompetitors[0].rating).toBe(4.3);
    expect(sig.topPlaceCompetitors[0].reviews).toBe(935);

    // Competitor ad activity (one with ads + winners, one with error)
    expect(sig.competitorAdActivity).toHaveLength(2);
    expect(sig.competitorAdActivity[0]).toMatchObject({
      competitor: 'Koukh Al Shay',
      adCount: 2,
      winners: 1,
      successfulStrategy: 'pages_search',
      error: null,
    });
    expect(sig.competitorAdActivity[1].error).toBe('no_pages_found');

    // Handle gaps — only facebook is present, so 4 channels are missing
    expect(sig.handleGaps).toEqual(expect.arrayContaining(['instagram', 'tiktok', 'youtube', 'twitter']));
    expect(sig.handleGaps).not.toContain('facebook');

    // Money math signal pulled through
    expect(sig.moneyMath).toMatchObject({
      vertical: 'restaurant',
      cpl: 18,
      ltv: 280,
      confidence: 'low',
    });

    // Top-level brand fields
    expect(sig.brandName).toBe('Hot Shay');
    expect(sig.domain).toBe('hotshay.ae');
    expect(sig.vertical).toBe('restaurant');
    expect(sig.audience).toBe('Gulf families');
  });

  it('uses brandIdentity *Handle / *Url field names so real scans are not falsely “missing” every channel', () => {
    const sig = extractRoastSignals({
      host: 'malabardentalclinics.com',
      brand: { name: 'Malabar Dental Clinics', category: 'dental' },
      intelligence: {
        brandIdentity: {
          handles: {
            instagramHandle: 'malabardentalclinics',
            youtubeChannel: 'malabardentalclinic',
            facebookPageUrl:
              'https://www.facebook.com/MalabarDentalClinics/https://www.facebook.com/MalabarDentalClinics/',
          },
        },
      },
    });
    expect(sig.handleGaps).not.toContain('instagram');
    expect(sig.handleGaps).not.toContain('youtube');
    expect(sig.handleGaps).not.toContain('facebook');
    expect(sig.handleGaps).toEqual(expect.arrayContaining(['tiktok', 'twitter']));
    expect(sig.handleGaps).toHaveLength(2);
  });

  it('handles a clean scan (no own outlets, no maps data) without crashing', () => {
    const sig = extractRoastSignals({
      host: 'cleanstart.ae',
      brand: { name: 'CleanStart', category: 'saas' },
      businessProfile: { type: 'saas_b2b' },
    });
    expect(sig.ownOutletStats).toBeNull();
    expect(sig.topPlaceCompetitors).toEqual([]);
    expect(sig.competitorAdActivity).toEqual([]);
    expect(sig.handleGaps.length).toBeGreaterThan(0);
  });
});

describe('roastEngine.fallbackInsights', () => {
  it('surfaces a critical Reputation insight when own outlet rating < 3★', () => {
    const signals = {
      brandName: 'Hot Shay',
      domain: 'hotshay.ae',
      vertical: 'restaurant',
      audience: 'Gulf families',
      ownOutletStats: {
        count: 3,
        avgRating: 2.8,
        worstOutlet: { name: 'Hot Shay DIFC', rating: 1.6, reviewsCount: 113 },
        bestOutlet:  { name: 'Hot Shay Al Barsha', rating: 4.0, reviewsCount: 333 },
        totalReviews: 582,
        outletsBelow3Stars: 2,
      },
      topPlaceCompetitors: [
        { name: 'Koukh Al Shay', rating: 4.3, reviews: 935 },
      ],
      competitorAdActivity: [],
      handleGaps: ['instagram', 'tiktok', 'youtube', 'twitter'],
      moneyMath: null,
      battlefield: null,
      competitors: [],
    };

    const out = fallbackInsights(signals);

    expect(out.source || out._source).toBe('fallback');
    expect(out.insights.length).toBeGreaterThanOrEqual(2);
    expect(out.insights.length).toBeLessThanOrEqual(4);

    const rep = out.insights.find((i) => i.category === 'Reputation');
    expect(rep).toBeDefined();
    expect(rep.severity).toBe('critical');
    expect(rep.headline).toMatch(/Hot Shay DIFC/);
    expect(rep.headline).toMatch(/1\.6/);
    expect(rep.metrics.length).toBeGreaterThan(0);
    expect(rep.fixPrompt).toMatch(/recovery/i);
    expect(rep.fixLabel).toMatch(/Generate/i);

    // Competitive moat insight should fire (4.3★ vs 2.8★ avg)
    const moat = out.insights.find((i) => i.category === 'Competitive moat');
    expect(moat).toBeDefined();
    expect(moat.headline).toMatch(/Koukh Al Shay/);

    // Channel gap insight should fire (4 missing channels >= 2)
    const channel = out.insights.find((i) => i.category === 'Channel gap');
    expect(channel).toBeDefined();
    expect(channel.severity).toBe('opportunity');
  });

  it('returns zero insights when no evidence exists (avoids padding with fake data)', () => {
    const signals = {
      brandName: 'CleanStart',
      domain: 'cleanstart.ae',
      vertical: 'saas_b2b',
      audience: 'CTOs at MENA SaaS startups',
      ownOutletStats: null,
      topPlaceCompetitors: [],
      competitorAdActivity: [],
      handleGaps: ['tiktok'], // single channel gap — below the 2-channel threshold
      moneyMath: null,
      battlefield: null,
      competitors: [],
    };

    const out = fallbackInsights(signals);
    // Fallback only generates evidence-backed insights — no fabricated padding
    expect(out.insights.length).toBe(0);
    expect(out._source).toBe('fallback');
  });
});

// ─── extractFirstJsonObject — the parse-failure fix ───────────────────────

describe('extractFirstJsonObject', () => {
  it('parses clean JSON with no trailing text', () => {
    const input = '{"insights":[{"severity":"high","headline":"Test"}]}';
    const result = JSON.parse(extractFirstJsonObject(input));
    expect(result.insights[0].headline).toBe('Test');
  });

  it('extracts JSON when Claude appends prose after the closing brace (the real bug)', () => {
    const input = `{"insights":[{"severity":"critical","headline":"Noon spends 5x more on ads than you do.","body":"Based on ad count signals.","metrics":[],"fixPrompt":"Do X","fixLabel":"Fix it"}]}

I hope this analysis helps! Let me know if you need any clarification or have additional questions about the insights provided.`;
    const result = JSON.parse(extractFirstJsonObject(input));
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].severity).toBe('critical');
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"insights":[{"severity":"opportunity","headline":"You have 0 ads running vs Life Pharmacy\'s 47.","body":"Gap is real.","metrics":[],"fixPrompt":"Run ads","fixLabel":"Launch"}]}\n```';
    const result = JSON.parse(extractFirstJsonObject(input));
    expect(result.insights[0].severity).toBe('opportunity');
  });

  it('handles json fence followed by trailing explanation', () => {
    const input = '```json\n{"insights":[{"severity":"high","headline":"X"}]}\n```\n\nNote: The above analysis is based on available data.';
    const result = JSON.parse(extractFirstJsonObject(input));
    expect(result.insights[0].headline).toBe('X');
  });

  it('returns partial string (not empty) on unclosed JSON — fails JSON.parse, not silently wrong', () => {
    const input = '{"insights":[{"severity":"critical","headline":"Truncated';
    const raw = extractFirstJsonObject(input);
    expect(raw.startsWith('{')).toBe(true);
    expect(() => JSON.parse(raw)).toThrow(); // caller catches it
  });

  it('returns empty string when there is no JSON object at all', () => {
    expect(extractFirstJsonObject('')).toBe('');
    expect(extractFirstJsonObject('Sorry, I cannot help with that.')).toBe('');
    expect(extractFirstJsonObject(null)).toBe('');
  });

  it('handles deeply nested JSON with 4849+ character bodies without early termination', () => {
    const longBody = 'A'.repeat(1200);
    const obj = {
      insights: [
        { severity: 'critical', headline: 'Noon dominates with 200+ active ads.', body: longBody, metrics: [], fixPrompt: 'P', fixLabel: 'L' },
        { severity: 'high', headline: 'Competitor social reach is 10x yours.', body: longBody, metrics: [], fixPrompt: 'P', fixLabel: 'L' },
        { severity: 'opportunity', headline: 'TikTok presence gap vs Namshi.', body: longBody, metrics: [], fixPrompt: 'P', fixLabel: 'L' },
      ],
    };
    const fullText = JSON.stringify(obj) + '\n\nAdditional analysis: Noon.com is a major e-commerce platform.';
    expect(fullText.length).toBeGreaterThan(4000);
    const result = JSON.parse(extractFirstJsonObject(fullText));
    expect(result.insights).toHaveLength(3);
  });
});

// ─── noon.com signal extraction ───────────────────────────────────────────

describe('extractRoastSignals — noon.com e-commerce scenario', () => {
  const noonScan = {
    host: 'noon.com',
    brand: { name: 'Noon', category: 'e-commerce marketplace' },
    businessProfile: { type: 'ecommerce_general' },
    audience: { primary: 'UAE online shoppers aged 18-45 seeking deals on electronics, fashion, and home goods' },
    apifyData: {
      googleMapsPlaces: [],
      competitorAds: [
        {
          competitor: 'Amazon.ae',
          ads: [
            { intelligence: { isWinner: true } },
            { intelligence: { isWinner: true } },
            { intelligence: { isWinner: false } },
          ],
          successfulStrategy: 'page_id',
          error: null,
        },
        {
          competitor: 'Namshi',
          ads: [
            { intelligence: { isWinner: true } },
          ],
          successfulStrategy: 'keyword_search',
          error: null,
        },
        {
          competitor: 'Carrefour UAE',
          ads: [],
          error: 'no_ads_found',
        },
      ],
      competitorAdsSummary: { totalAds: 4, winners: 3 },
    },
    intelligence: {
      brandIdentity: {
        handles: {
          instagramHandle: 'noon',
          facebookHandle: 'noon',
          tiktokHandle: 'noon',
          youtubeChannel: 'noon',
          twitterHandle: 'noon',
        },
      },
    },
    moneyMath: {
      vertical: 'ecommerce_general',
      benchmarks: { avgCPL: 22, avgLTV: 380 },
      confidenceLevel: 'medium',
      warnings: ['LTV assumes 3 orders/year at AED 127 avg basket'],
    },
    competitors: [
      { name: 'Amazon.ae', url: 'https://amazon.ae', differentiator: 'Global trust, Prime delivery' },
      { name: 'Namshi', url: 'https://namshi.com', differentiator: 'Fashion-first, strong IG presence' },
    ],
  };

  it('correctly maps competitor ad activity from the new per-competitor shape', () => {
    const signals = extractRoastSignals(noonScan);
    expect(signals.competitorAdActivity).toHaveLength(3);

    const amazon = signals.competitorAdActivity.find((c) => c.competitor === 'Amazon.ae');
    expect(amazon.adCount).toBe(3);
    expect(amazon.winners).toBe(2);
    expect(amazon.error).toBeNull();

    const carrefour = signals.competitorAdActivity.find((c) => c.competitor === 'Carrefour UAE');
    expect(carrefour.adCount).toBe(0);
    expect(carrefour.error).toBe('no_ads_found');
  });

  it('detects zero handle gaps when all channels are covered', () => {
    const signals = extractRoastSignals(noonScan);
    expect(signals.handleGaps).toHaveLength(0);
  });

  it('surfaces money math signals for the AI prompt', () => {
    const signals = extractRoastSignals(noonScan);
    expect(signals.moneyMath.cpl).toBe(22);
    expect(signals.moneyMath.ltv).toBe(380);
    expect(signals.moneyMath.warnings).toHaveLength(1);
  });

  it('does not fabricate outlet stats when no Google Maps data exists', () => {
    const signals = extractRoastSignals(noonScan);
    expect(signals.ownOutletStats).toBeNull();
    expect(signals.topPlaceCompetitors).toHaveLength(0);
  });

  it('fallback generates no insights when handle gaps < 2 and no outlet data (noon has all channels)', () => {
    const signals = extractRoastSignals(noonScan);
    const out = fallbackInsights(signals);
    // No outlets to roast, all handles present — silence is correct
    expect(out.insights.length).toBe(0);
    expect(out._source).toBe('fallback');
  });

  it('includes competitor names and differentiators for AI prompt context', () => {
    const signals = extractRoastSignals(noonScan);
    expect(signals.competitors).toHaveLength(2);
    expect(signals.competitors[0].name).toBe('Amazon.ae');
    expect(signals.competitors[0].differentiator).toMatch(/Prime/);
  });
});
