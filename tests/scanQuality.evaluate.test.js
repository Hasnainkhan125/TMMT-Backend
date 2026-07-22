'use strict';

const { evaluateScan, handleValuePresent } = require('../scripts/scanQuality');

describe('scanQuality.evaluateScan (handle key shapes)', () => {
  it('passes when intelligence.brandIdentity.handles uses Layer-1 field names', () => {
    const { checks } = evaluateScan(
      {
        intelligence: {
          brandIdentity: {
            handles: {
              facebookHandle: 'Acme',
              facebookPageUrl: 'https://www.facebook.com/Acme',
            },
          },
        },
        businessProfile: { type: 'restaurant', confidence: 0.8 },
        moneyMath: { benchmarks: { avgCPL: 20 }, projections: [{ expectedROAS: { high: 3 } }] },
        apifyData: { competitorAds: [] },
      },
      false,
    );
    expect(checks.handles.pass).toBe(true);
  });

  it('passes for instagramHandle / youtubeChannel (not instagram / youtube keys)', () => {
    const { checks } = evaluateScan(
      {
        intelligence: {
          brandIdentity: { handles: { instagramHandle: 'acme', youtubeChannel: '@acme' } },
        },
        businessProfile: { type: 'ecommerce', confidence: 0.9 },
        moneyMath: { benchmarks: { avgCPL: 15 }, projections: [{ expectedROAS: { high: 2 } }] },
        apifyData: { competitorAds: [] },
      },
      false,
    );
    expect(checks.handles.pass).toBe(true);
  });

  it('reads brand.socialHandles as fallback (initial scan before enrich)', () => {
    const { checks } = evaluateScan(
      {
        brand: {
          socialHandles: { facebookHandle: 'X', facebookPageUrl: 'https://facebook.com/X' },
        },
        businessProfile: { type: 'default', confidence: 0.3 },
        moneyMath: { benchmarks: { avgCPL: 1 }, projections: [{ expectedROAS: { high: 1 } }] },
        apifyData: { competitorAds: [] },
      },
      false,
    );
    expect(checks.handles.pass).toBe(true);
  });
});

describe('handleValuePresent', () => {
  it('treats non-empty strings as present', () => {
    expect(handleValuePresent('a')).toBe(true);
    expect(handleValuePresent('')).toBe(false);
  });
  it('supports rich { handles: string[] } shape', () => {
    expect(handleValuePresent({ handles: ['a'] })).toBe(true);
    expect(handleValuePresent({ handles: [] })).toBe(false);
  });
});
