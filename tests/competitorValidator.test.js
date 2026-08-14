'use strict';

/**
 * competitorValidator — unit tests.
 *
 * Pins the gates that prevent fake competitors from burning Apify spend:
 *   - Descriptive placeholder names get dropped.
 *   - Malformed URLs get dropped.
 *   - User's own brand gets dropped (belt & suspenders for urlToAdsService).
 *   - HTTP HEAD probes are skipped under COMPETITOR_PROBE=0 (hermetic tests).
 *
 * We do NOT exercise the live HEAD path here — that's an integration concern.
 */

const {
  validateCompetitor,
  validateCompetitorList,
  nameLooksDescriptive,
  urlLooksReal,
  pickDomain,
} = require('../services/intelligence/competitorValidator');

describe('nameLooksDescriptive', () => {
  it('flags Edmunds-equivalent placeholder', () => {
    expect(nameLooksDescriptive('Edmunds equivalent regional sites')).toBe(true);
  });
  it('flags multi-word descriptions', () => {
    expect(nameLooksDescriptive('Various local dealerships')).toBe(true);
    expect(nameLooksDescriptive('Multiple aggregators')).toBe(true);
    expect(nameLooksDescriptive('Local restaurant outlets')).toBe(true);
  });
  it('flags single plural noun (Restaurants)', () => {
    expect(nameLooksDescriptive('Restaurants')).toBe(true);
  });
  it('passes real brand names', () => {
    expect(nameLooksDescriptive('Sharaf DG')).toBe(false);
    expect(nameLooksDescriptive('Hot Shay')).toBe(false);
    expect(nameLooksDescriptive('Afghan Palace Restaurant')).toBe(false);
  });
  it('flags empty / too-short / too-long', () => {
    expect(nameLooksDescriptive('')).toBe(true);
    expect(nameLooksDescriptive(null)).toBe(true);
    expect(nameLooksDescriptive('A')).toBe(true);
    expect(nameLooksDescriptive('x'.repeat(130))).toBe(true);
  });
});

describe('urlLooksReal', () => {
  it('accepts well-formed urls', () => {
    expect(urlLooksReal({ url: 'https://sharafdg.com' })).toBe(true);
    expect(urlLooksReal({ url: 'noon.com' })).toBe(true);
  });
  it('rejects garbage', () => {
    expect(urlLooksReal({ url: 'not a url' })).toBe(false);
    expect(urlLooksReal({ url: '' })).toBe(false);
    expect(urlLooksReal({})).toBe(false);
  });
});

describe('pickDomain', () => {
  it('extracts root from various shapes', () => {
    expect(pickDomain({ url: 'https://www.sharafdg.com/store' })).toBe('sharafdg.com');
    expect(pickDomain({ website: 'shop.tesla.com' })).toBe('tesla.com');
  });
});

describe('validateCompetitor (probe disabled)', () => {
  const opts = { probe: false };

  it('rejects descriptive name', async () => {
    const r = await validateCompetitor({ name: 'Various local outlets', url: 'https://example.com' }, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('name_descriptive');
  });

  it('rejects bad url', async () => {
    const r = await validateCompetitor({ name: 'Real Brand', url: 'not-a-url' }, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('url_invalid');
  });

  it('rejects own brand', async () => {
    const r = await validateCompetitor(
      { name: 'My Brand', url: 'https://www.mybrand.ae' },
      { ...opts, ownDomain: 'mybrand.ae' },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('is_own_brand');
  });

  it('passes a healthy competitor', async () => {
    const r = await validateCompetitor(
      { name: 'Sharaf DG', url: 'https://sharafdg.com' },
      opts,
    );
    expect(r.ok).toBe(true);
    expect(r.competitor.domain).toBe('sharafdg.com');
  });
});

describe('validateCompetitorList (probe disabled)', () => {
  it('partitions valid vs dropped with reasons', async () => {
    const list = [
      { name: 'Sharaf DG',                     url: 'https://sharafdg.com' },
      { name: 'Various local outlets',         url: 'https://anywhere.com' },
      { name: 'Edmunds equivalent regional sites', url: 'https://nope.com' },
      { name: 'My Brand',                      url: 'https://www.mybrand.ae' },
      { name: 'Bad URL Brand',                 url: 'just words' },
    ];
    const { valid, dropped } = await validateCompetitorList(list, {
      ownDomain: 'mybrand.ae',
      probe: false,
    });
    expect(valid).toHaveLength(1);
    expect(valid[0].name).toBe('Sharaf DG');
    expect(dropped.map((d) => d.reason).sort()).toEqual(
      ['is_own_brand', 'name_descriptive', 'name_descriptive', 'url_invalid'].sort()
    );
  });

  it('returns empty for empty / non-array input', async () => {
    expect(await validateCompetitorList([])).toEqual({ valid: [], dropped: [] });
    expect(await validateCompetitorList(null)).toEqual({ valid: [], dropped: [] });
  });
});
