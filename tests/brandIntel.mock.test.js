'use strict';

const {
  buildApifyDataFromSnapshot,
  buildMockScanPayload,
  competitorAdsRowFromApifyItems,
} = require('../services/brandIntel/snapshotToFrontendScan');
const {
  concludeBrandIntelMock,
  buildCloneAdPrompt,
  mockDirectorTemplatesFromPinterest,
  snapshotToMockApiResponse,
} = require('../services/brandIntel/creativeDirectorMock');

describe('brandIntel snapshotToFrontendScan', () => {
  it('normalizes raw Apify items into competitor row', () => {
    const raw = {
      ad_archive_id: '123',
      page_name: 'Test Page',
      snapshot: {
        body: { text: 'Buy now' },
        images: [{ original_image_url: 'https://example.com/img.jpg' }],
      },
    };
    const row = competitorAdsRowFromApifyItems({
      competitor: 'Test Co',
      competitorUrl: 'https://test.co',
      rawItems: [raw],
    });
    expect(row.competitor).toBe('Test Co');
    expect(row.ads.length).toBe(1);
    expect(row.ads[0].adId).toBe('123');
    expect(row.ads[0].images[0]).toContain('img.jpg');
    expect(row.successfulStrategy).toBe('keyword_meta_ad_library');
  });

  it('buildApifyDataFromSnapshot aggregates own + competitor blocks', () => {
    const snapshot = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      input: { url: 'https://brand.com', normalizedUrl: 'https://brand.com/', country: 'US', mapsSearch: 'Brand' },
      website: { brandName: 'Brand Co', host: 'brand.com' },
      googleMaps: { places: [] },
      socialApify: { instagram: { skipped: true }, tiktok: { skipped: true } },
      metaAdLibraryApify: {
        ownBrand: {
          keyword: 'Brand Co',
          items: [
            {
              ad_archive_id: '1',
              page_name: 'Brand Co',
              snapshot: { body: { text: 'Our ad' }, images: [{ original_image_url: 'https://x/a.jpg' }] },
            },
          ],
        },
        competitors: [
          {
            place: { name: 'Rival Inc', website: 'https://rival.com' },
            metaAdLibrary: {
              keyword: 'Rival Inc',
              items: [
                {
                  ad_archive_id: '2',
                  page_name: 'Rival',
                  snapshot: { body: { text: 'Their ad' }, images: [{ original_image_url: 'https://x/b.jpg' }] },
                },
              ],
            },
          },
        ],
      },
    };
    const { apifyData, competitorAds } = buildApifyDataFromSnapshot(snapshot);
    expect(competitorAds.length).toBe(2);
    expect(apifyData.competitorAdsSummary.totalAds).toBe(2);
    expect(apifyData.competitorAds[0].competitor).toBe('Brand Co');
    expect(apifyData.competitorAds[1].competitor).toBe('Rival Inc');
  });
});

describe('brandIntel creativeDirectorMock', () => {
  it('mockDirectorTemplatesFromPinterest returns tiles with imageUrl', () => {
    const t = mockDirectorTemplatesFromPinterest();
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t[0].imageUrl).toMatch(/^https:\/\//);
    expect(t[0].id).toMatch(/^pin-mock-/);
  });

  it('buildCloneAdPrompt includes reference URLs and 4K-class dimensions', () => {
    const p = buildCloneAdPrompt({
      brandName: 'Acme',
      referenceImageUrl: 'https://cdn.test/ref.png',
      directorTemplateIds: ['pin-mock-1'],
      aspectRatio: '9:16',
    });
    expect(p.user).toContain('Acme');
    expect(p.user).toContain('https://cdn.test/ref.png');
    expect(p.user).toContain('Bold product hero');
    expect(p.targetPixels.height).toBe(3840);
    expect(p.negativePrompt).toContain('watermark');
  });

  it('concludeBrandIntelMock returns executiveSummary and directorBoard', () => {
    const scan = buildMockScanPayload(
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        input: { url: 'https://x.com', normalizedUrl: 'https://x.com/', country: 'US', mapsSearch: 'X' },
        website: { brandName: 'X', host: 'x.com' },
        googleMaps: { places: [] },
        socialApify: { instagram: { skipped: true }, tiktok: { skipped: true } },
        metaAdLibraryApify: { ownBrand: { items: [] }, competitors: [] },
      },
      { scanId: 't1' },
    );
    const c = concludeBrandIntelMock(scan);
    expect(c.executiveSummary).toContain('X');
    expect(c.directorBoard.templates.length).toBeGreaterThan(0);
    expect(c.cloneWorkflow.imageGenerationSpec.aspectRatios).toContain('4:5');
    expect(c._mock).toBe(true);
  });

  it('snapshotToMockApiResponse merges scan + conclusion + clone example', () => {
    const snap = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      input: { url: 'https://y.com', normalizedUrl: 'https://y.com/', country: 'US', mapsSearch: 'Y' },
      website: { brandName: 'Y', host: 'y.com' },
      googleMaps: { places: [] },
      socialApify: { instagram: { skipped: true }, tiktok: { skipped: true } },
      metaAdLibraryApify: { ownBrand: { items: [] }, competitors: [] },
    };
    const api = snapshotToMockApiResponse(snap);
    expect(api.scan.intelligence).toBe(api.conclusion);
    expect(api.clonePromptExample.system).toContain('creative director');
  });
});
