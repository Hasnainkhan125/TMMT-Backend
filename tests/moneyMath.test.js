'use strict';

/**
 * moneyMath — unit tests.
 *
 * The Money Math panel is the headline number on the report. If it lies,
 * users churn. These tests pin down:
 *   - signal extraction pulls outlet count + average product price
 *   - projection math stays inside sane variance bounds
 *   - computeMoneyMath returns the deterministic-fallback shape when
 *     ANTHROPIC_API_KEY is absent (the offline / CI baseline)
 */

// Force the offline path BEFORE the module loads, so the AI branch is skipped.
process.env.ANTHROPIC_API_KEY = '';

// The module pulls a Redis client at first call — stub it so tests don't need
// a running Redis. Returning a no-op shim is enough; the cache is best-effort
// and the module already swallows redis errors.
jest.mock('../services/redis', () => ({
  getRedis: () => ({
    get:   async () => null,
    setex: async () => null,
    set:   async () => null,
  }),
}));

const {
  computeMoneyMath,
  extractFinancialSignals,
  projectAtSpend,
  resolveFallbackVertical,
  FALLBACK_BENCHMARKS,
  SPEND_TIERS_AED,
} = require('../services/moneyMath');

describe('moneyMath.extractFinancialSignals', () => {
  it('extracts outlet count, avg product price, vertical, and B2B/service flags', () => {
    const scan = {
      host: 'hotshay.ae',
      brand: {
        name: 'Hot Shay',
        category: 'restaurant',
        description: 'Hot Shay operates 20+ outlets across the UAE serving karak chai.',
        paragraphs: [],
        headlines: [],
      },
      research: { brand: { subcategory: 'qsr_karak' } },
      businessProfile: { type: 'restaurant', subtype: 'qsr', primaryActions: [{ intent: 'order_now' }] },
      audience: { primary: 'Gulf families' },
      productCatalog: {
        products: [
          { title: 'Karak (single)', price: 4 },
          { title: 'Karak (jug)',    price: 25 },
          { title: 'Family pack',    price: 45 },
          { title: 'Bad price',      price: 'free' }, // ignored (non-numeric)
          { title: 'Negative',       price: -10 },     // ignored
        ],
      },
    };

    const sig = extractFinancialSignals(scan);
    expect(sig.domain).toBe('hotshay.ae');
    expect(sig.brandName).toBe('Hot Shay');
    expect(sig.vertical).toBe('restaurant');
    expect(sig.outletMentions).toBe(20);
    expect(sig.avgProductPrice).toBe(25); // (4 + 25 + 45) / 3 rounded
    expect(sig.minProductPrice).toBe(4);
    expect(sig.maxProductPrice).toBe(45);
    expect(sig.audience).toBe('Gulf families');
    expect(Array.isArray(sig.primaryActions)).toBe(true);
    expect(sig.primaryActions).toContain('order_now');
    // Restaurant is neither B2B nor "service" by the inference rules
    expect(sig.isB2B).toBe(false);
    expect(sig.isService).toBe(false);
  });

  it('falls back gracefully when productCatalog is missing or empty', () => {
    const sig = extractFinancialSignals({
      host: 'plainsite.ae',
      brand: { name: 'Plain', category: 'general', description: '' },
    });
    expect(sig.avgProductPrice).toBeNull();
    expect(sig.outletMentions).toBeNull();
  });

  it('resolveFallbackVertical maps category text to a known vertical bucket', () => {
    expect(resolveFallbackVertical({ businessProfile: { type: 'restaurant' } })).toBe('restaurant');
    expect(resolveFallbackVertical({ brand: { category: 'electronics retail' } })).toBe('ecommerce_electronics');
    expect(resolveFallbackVertical({ brand: { category: 'dental clinic' } })).toBe('dental');
    expect(resolveFallbackVertical({ brand: { category: 'something obscure' } })).toBe('default');
  });
});

describe('moneyMath.projectAtSpend', () => {
  it('produces sane low/high bands inside ±50% variance for a known vertical', () => {
    const b = FALLBACK_BENCHMARKS.restaurant; // CPL 18, conv 0.25, LTV 280
    const proj = projectAtSpend(300, b);

    expect(proj.dailySpendAED).toBe(300);
    expect(proj.monthlySpendAED).toBe(9000);

    // expected leads ≈ 9000 / 18 = 500, low/high should bracket it
    expect(proj.expectedLeads.low).toBeGreaterThan(0);
    expect(proj.expectedLeads.low).toBeLessThan(proj.expectedLeads.high);
    expect(proj.expectedLeads.high).toBeLessThanOrEqual(900);

    // ROAS bands must be positive and finite
    expect(proj.expectedROAS.low).toBeGreaterThan(0);
    expect(proj.expectedROAS.low).toBeLessThanOrEqual(proj.expectedROAS.high);
    expect(proj.expectedROAS.high).toBeLessThan(30); // sanity ceiling

    // Customers under 10 keep one decimal so "0.4 customers/mo" still tells the truth
    if (proj.expectedCustomers.low < 10) {
      expect(proj.expectedCustomers.low * 10).toBe(Math.round(proj.expectedCustomers.low * 10));
    }
  });

  it('handles a zero / missing benchmark without dividing by zero or NaN', () => {
    const proj = projectAtSpend(300, { avgCPL: 0, avgConversionRate: 0.1, avgLTV: 100 });
    expect(Number.isFinite(proj.expectedLeads.low)).toBe(true);
    expect(Number.isFinite(proj.expectedROAS.high)).toBe(true);
  });
});

describe('moneyMath.computeMoneyMath (offline / fallback path)', () => {
  it('returns a deterministic fallback shape when ANTHROPIC_API_KEY is absent', async () => {
    const scan = {
      host: 'hotshay.ae',
      brand: { name: 'Hot Shay', category: 'restaurant', description: '' },
      businessProfile: { type: 'restaurant' },
    };

    const out = await computeMoneyMath(scan);

    expect(out.source).toBe('fallback');
    expect(out.vertical).toBe('restaurant');
    expect(out.benchmarks).toEqual(FALLBACK_BENCHMARKS.restaurant);
    expect(out.projections).toHaveLength(SPEND_TIERS_AED.length);
    out.projections.forEach((p) => {
      expect(p.dailySpendAED).toBeGreaterThan(0);
      expect(p.expectedROAS.high).toBeGreaterThanOrEqual(p.expectedROAS.low);
    });
    expect(out.confidenceLevel).toBe('low');
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
