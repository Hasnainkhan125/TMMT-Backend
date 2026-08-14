'use strict';

const { scanUrl } = require('../services/urlToAdsService');
const { test } = require('node:test');
const { expect } = require('chai');
const { jest } = require('jest');

/**
 * urlToAdsService — Phase 7 unit tests.
 *
 * Mocking strategy mirrors adSetService.test.js:
 *   - UrlToAdsScan persistence is a plain in-memory map
 *   - urlScraper.scrapeUrl is mocked per describe-block with the HTML shape
 *     we want to exercise
 *   - adSetService.enqueueAdSet is stubbed so we can assert the brief we
 *     pass through AND return a predictable ad-set id
 *   - adBrain.buildAdPrompt is stubbed to keep the output short + stable
 *   - copyService is NOT loaded (no ANTHROPIC key) so enrichment is skipped
 *     by design — that's the hermetic baseline we want in CI
 *
 * Coverage:
 *   ✓ buildCopyPack — always returns non-empty arrays, graceful empty input
 *   ✓ buildAdBlueprint — aspect ratios rotate 1:1 / 9:16 / 4:5
 *   ✓ scanUrl — persists, happy path, scrape failure path, degraded doc
 *   ✓ generateAds — owner check, status gate, adSet linking, children wiring
 *   ✓ getScan / listScans / archiveScan — ownership + scoping
 */

process.env.ANTHROPIC_API_KEY = '';

// ── Mocks (ORDER MATTERS — register before requires) ────────────────────────

jest.mock('../services/urlScraper', () => ({
  scrapeUrl: jest.fn(),
}));

jest.mock('../services/aiResearch', () => ({
  researchBrand: jest.fn(async ({ scrape }) => ({
    brand: {
      name: scrape?.brandName || 'Acme Activewear',
      category: scrape?.category || 'gym',
      summary: scrape?.description || '',
      keywords: scrape?.headlines || [],
      valueProps: scrape?.paragraphs || [],
      oneLiner: '',
      tone: '',
      palette: [],
    },
    targetAudience: { primary: 'Gulf athletes' },
    competitors: [
      { name: 'GymNation', url: 'https://gymnation.com', tagline: 't1', why: 'w1', differentiator: 'd1' },
      { name: 'FitnessFirst', url: 'https://fitnessfirst.ae', tagline: 't2', why: 'w2', differentiator: 'd2' },
      { name: 'TrainDXB', url: 'https://train.ae', tagline: 't3', why: 'w3', differentiator: 'd3' },
      { name: 'GoldGym', url: 'https://goldsgym.ae', tagline: 't4', why: 'w4', differentiator: 'd4' },
      { name: 'FitRep', url: 'https://fitness.ae', tagline: 't5', why: 'w5', differentiator: 'd5' },
    ],
    competitorAds: [],
    hooks: [
      { label: 'Hero', headline: 'Meet Acme', body: 'Built for heat', cta: 'Shop', vibe: 'cinematic', aspectRatio: '1:1', modelHint: 'flux_pro' },
      { label: 'Social', headline: 'Train smarter', body: 'Compression', cta: 'Try', vibe: 'editorial', aspectRatio: '9:16', modelHint: 'flux_pro' },
      { label: 'Urgent', headline: 'Drop now', body: 'Limited', cta: 'Buy', vibe: 'urgent', aspectRatio: '4:5', modelHint: 'flux_pro' },
      { label: 'Proof', headline: 'Trusted in Dubai', body: 'Athletes swear by it', cta: 'See why', vibe: 'confident-minimal', aspectRatio: '1:1', modelHint: 'flux_pro' },
    ],
    _source: 'test_mock',
  })),
}));

jest.mock('../services/adSetService', () => ({
  enqueueAdSet: jest.fn(),
}));

jest.mock('../services/adBrain', () => ({
  buildAdPrompt: jest.fn(({ brandName, description, aspectRatio }) => ({
    finalPrompt:    `CINEMATIC ${brandName || 'brand'} — ${description || ''} @ ${aspectRatio}`,
    negativePrompt: 'low quality, cartoon',
    promptMetadata: { domain: 'test' },
  })),
}));

jest.mock('../model/schema/urlToAdsScan', () => {
  // Tiny in-memory "mongoose-ish" collection sufficient for the service
  // under test. We don't go beyond: create, findById, find+sort+limit+lean,
  // instance .save(), instance .toObject(), .status/.ads/.brand/... setters.
  const store = new Map();
  let counter = 0;

  class FakeDoc {
    constructor(data) {
      Object.assign(this, data);
      this._id = data._id || `scan_${++counter}`;
      this.createdAt = this.createdAt || new Date();
      this.updatedAt = new Date();
      this.ads = Array.isArray(this.ads) ? this.ads : [];
    }
    markModified(_path) { /* no-op — Mongoose method, not needed in mem store */ }
    async save() {
      this.updatedAt = new Date();
      store.set(String(this._id), this);
      return this;
    }
    toObject() {
      const out = { ...this };
      delete out.save;
      delete out.toObject;
      return out;
    }
  }

  const model = {
    create: jest.fn(async (data) => {
      const doc = new FakeDoc(data);
      store.set(String(doc._id), doc);
      return doc;
    }),
    findById: jest.fn(async (id) => store.get(String(id)) || null),
    find: jest.fn((filter) => {
      const all = Array.from(store.values()).filter((d) => {
        if (filter?.userId    && String(d.userId)    !== String(filter.userId))    return false;
        if (filter?.sessionId && d.sessionId         !== filter.sessionId)         return false;
        return true;
      });
      let out = all;
      const api = {
        sort: (spec) => {
          const [k, dir] = Object.entries(spec)[0];
          out = out.slice().sort((a, b) => (a[k] > b[k] ? 1 : -1) * (dir > 0 ? 1 : -1));
          return api;
        },
        limit: (n) => { out = out.slice(0, n); return api; },
        lean: () => out.map((d) => d.toObject()),
      };
      return api;
    }),
    __reset: () => { store.clear(); counter = 0; },
    __dump:  () => Array.from(store.values()),
  };
  return model;
});

// ── Requires (after mocks) ──────────────────────────────────────────────────

const urlToAdsService = require('../services/urlToAdsService');
const urlScraper      = require('../services/urlScraper');
const adSetService    = require('../services/adSetService');
const UrlToAdsScan    = require('../model/schema/urlToAdsScan');

// ── Fixtures ────────────────────────────────────────────────────────────────

const GOOD_SCRAPE = {
  url:       'https://acme.ae/',
  host:      'acme.ae',
  brandName: 'Acme Activewear',
  siteName:  'Acme Activewear',
  title:     'Acme — premium gym gear for Dubai athletes',
  description:'Acme Activewear builds high-performance gym gear for Gulf athletes.',
  headlines: ['Built for the heat', 'Engineered in Dubai'],
  paragraphs:['Our compression tee handles 45C training sessions without losing fit.'],
  images:    ['https://cdn.acme.com/hero.jpg', 'https://cdn.acme.com/tee.jpg'],
  favicon:   'https://acme.ae/favicon.ico',
  category:  'gym',
  status:    200,
};

function makeReq({ userId = null, sessionId = 'sess_1', role = null } = {}) {
  return {
    cookies: { qumak_session: sessionId },
    user: userId ? { id: userId, role, plan: 'free' } : null,
    headers: {},
  };
}

// ── Reset between tests ─────────────────────────────────────────────────────

beforeEach(() => {
  UrlToAdsScan.__reset();
  jest.clearAllMocks();
  urlScraper.scrapeUrl.mockResolvedValue(GOOD_SCRAPE);
  adSetService.enqueueAdSet.mockResolvedValue({
    adSetId:  'adset_123',
    parent:   { _id: 'adset_123', status: 'queued' },
    children: [
      { _id: 'child_1', variantIndex: 0 },
      { _id: 'child_2', variantIndex: 1 },
      { _id: 'child_3', variantIndex: 2 },
    ],
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildCopyPack', () => {
  it('produces non-empty headlines/captions/ctas/hashtags even for a sparse scrape', () => {
    const copy = urlToAdsService.buildCopyPack({
      brandName: 'Acme', category: 'gym', description: '',
    });
    expect(copy.headlines.length).toBeGreaterThanOrEqual(4);
    expect(copy.captions.length).toBeGreaterThanOrEqual(3);
    expect(copy.ctas.length).toBeGreaterThanOrEqual(3);
    expect(copy.hashtags[0]).toBe('#Acme');
    expect(copy.openingLines.length).toBeGreaterThanOrEqual(3);
  });

  it('works when the brand name is missing (falls back to "your brand")', () => {
    const copy = urlToAdsService.buildCopyPack({});
    expect(copy.headlines[0]).toMatch(/your brand/i);
  });
});

describe('buildAdBlueprint', () => {
  it('rotates aspect ratios across the 3 hook slots', () => {
    const copy = urlToAdsService.buildCopyPack(GOOD_SCRAPE);
    const a = urlToAdsService.buildAdBlueprint({ scrape: GOOD_SCRAPE, hookIdx: 0, copy });
    const b = urlToAdsService.buildAdBlueprint({ scrape: GOOD_SCRAPE, hookIdx: 1, copy });
    const c = urlToAdsService.buildAdBlueprint({ scrape: GOOD_SCRAPE, hookIdx: 2, copy });
    expect([a.aspectRatio, b.aspectRatio, c.aspectRatio]).toEqual(['1:1','9:16','4:5']);
    // Each blueprint carries the call-through prompt from our adBrain mock.
    expect(a.prompt).toMatch(/CINEMATIC/);
    expect(a.status).toBe('pending');
    expect(a.referenceImageUrl).toBe(GOOD_SCRAPE.images[0]);
  });
});

describe('scanUrl — happy path', () => {
  it('persists a scanning scan with brand, competitors, copy, and 3 ads', async () => {
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req: makeReq() });
    // Scan returns 'scanning' immediately; background enrichment job sets it to 'ready'.
    expect(scan.status).toBe('scanning');
    expect(scan.brand.name).toBe('Acme Activewear');
    expect(scan.brand.category).toBe('gym');
    expect(scan.competitors.length).toBe(5);
    expect(scan.competitors[0].name).toBe('GymNation');
    expect(scan.copy.headlines.length).toBeGreaterThanOrEqual(4);
    expect(scan.ads).toHaveLength(3);
    expect(scan.ads.every((a) => a.prompt && a.prompt.length > 10)).toBe(true);
    expect(scan.businessProfile?.type).toBe('fitness_gym');
    expect(scan.businessProfile?.businessAssets?.kind).toBe('service_menu');
    // Verify the document lives in our in-memory store
    expect(UrlToAdsScan.__dump()).toHaveLength(1);
  });

  it('stores sessionId + userId so listScans can scope correctly', async () => {
    const req = makeReq({ userId: 'user_1', sessionId: 'sess_abc' });
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req });
    expect(scan.sessionId).toBe('sess_abc');
    expect(scan.userId).toBe('user_1');
  });
});

describe('scanUrl — error path', () => {
  it('scrapeUrl failure is non-fatal — scan succeeds with URL-derived fallback brand', async () => {
    urlScraper.scrapeUrl.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'fetch_failed' }),
    );
    // Non-fatal: scan resolves instead of rejecting; fallback brand derived from URL hostname.
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req: makeReq() });
    expect(scan.status).toBe('scanning');
    // Brand name falls back to hostname stem ('acme') or AI research result
    expect(scan.brand.name).toBeTruthy();

    // Doc is saved with scanning status (not failed) — background job will enrich it.
    const [doc] = UrlToAdsScan.__dump();
    expect(doc.status).toBe('scanning');
  });

  it('rejects invalid input via Zod before persisting anything', async () => {
    await expect(
      urlToAdsService.scanUrl({ url: '', req: makeReq() }),
    ).rejects.toThrow();
    expect(UrlToAdsScan.create).not.toHaveBeenCalled();
  });
});

describe('generateAds', () => {
  it('delegates to adSetService and back-fills scan with jobIds + adSetId', async () => {
    const req = makeReq({ sessionId: 'sess_owner' });
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req });
    // Background job normally sets status to 'ready'; simulate that here.
    const stored = await UrlToAdsScan.findById(scan._id);
    stored.status = 'ready';
    await stored.save();

    const out = await urlToAdsService.generateAds({
      scanId: scan._id,
      req,
      numVariants: 3,
      kind: 'image',
    });

    expect(adSetService.enqueueAdSet).toHaveBeenCalledTimes(1);
    const brief = adSetService.enqueueAdSet.mock.calls[0][0].inputs;
    expect(brief.prompt).toMatch(/CINEMATIC/);
    expect(brief.brandName).toBe('Acme Activewear');
    expect(brief.category).toBe('gym');
    expect(brief.numVariants).toBe(3);
    expect(brief.kind).toBe('image');
    expect(Array.isArray(brief.variantBlueprints)).toBe(true);
    expect(brief.variantBlueprints).toHaveLength(3);
    expect(brief.variantBlueprints[0].aspectRatio).toBe('1:1');
    expect(brief.variantBlueprints[1].aspectRatio).toBe('9:16');
    expect(brief.variantBlueprints[2].aspectRatio).toBe('4:5');

    expect(out.adSetId).toBe('adset_123');
    expect(out.scan.adSetId).toBe('adset_123');
    expect(out.scan.status).toBe('rendering');
    // jobIds hydrate correctly from the fake children
    expect(out.scan.ads[0].jobId).toBe('child_1');
    expect(out.scan.ads[1].jobId).toBe('child_2');
    expect(out.scan.ads[2].jobId).toBe('child_3');
    expect(out.scan.ads.every((a) => a.status === 'queued')).toBe(true);
  });

  it('applies model override, creative suffix, and reference URL to variant blueprints', async () => {
    const req = makeReq({ sessionId: 'sess_owner' });
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req });
    const stored = await UrlToAdsScan.findById(scan._id);
    stored.status = 'ready';
    await stored.save();

    await urlToAdsService.generateAds({
      scanId: scan._id,
      req,
      numVariants: 3,
      kind: 'image',
      modelId: 'flux_schnell',
      templateCategory: 'Food and beverage',
      templateName: 'Tabletop scene',
      creativeStyleHint: 'Warm rim light.',
      referenceImageUrl: 'https://example.com/preset-ref.webp',
    });

    expect(adSetService.enqueueAdSet).toHaveBeenCalledTimes(1);
    const brief = adSetService.enqueueAdSet.mock.calls[0][0].inputs;

    expect(brief.variantBlueprints).toHaveLength(3);
    expect(brief.variantBlueprints.every((v) => v.modelId === 'flux_schnell')).toBe(true);
    expect(brief.variantBlueprints[0].prompt).toMatch(/Warm rim light/);
    expect(brief.variantBlueprints[0].prompt).toMatch(/Food and beverage/);
    expect(brief.variantBlueprints[0].prompt).toMatch(/Tabletop scene/);
    expect(brief.prompt).toMatch(/Warm rim light/);
    expect(brief.referenceImageUrl).toBe('https://example.com/preset-ref.webp');
    expect(brief.variantBlueprints[0].referenceImageUrl).toBe('https://example.com/preset-ref.webp');
  });

  it('refuses if the scan belongs to a different owner', async () => {
    const createdBy = makeReq({ sessionId: 'owner_A' });
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req: createdBy });
    const stored = await UrlToAdsScan.findById(scan._id);
    stored.status = 'ready';
    await stored.save();

    const imposter = makeReq({ sessionId: 'owner_B' });
    await expect(
      urlToAdsService.generateAds({ scanId: scan._id, req: imposter }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets admin override ownership check', async () => {
    const created = makeReq({ sessionId: 'owner_A' });
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req: created });
    const stored = await UrlToAdsScan.findById(scan._id);
    stored.status = 'ready';
    await stored.save();

    const admin = makeReq({ userId: 'admin_1', sessionId: 'owner_B', role: 'ADMIN' });
    const out = await urlToAdsService.generateAds({ scanId: scan._id, req: admin });
    expect(out.adSetId).toBe('adset_123');
  });

  it('rejects when scan is still "scanning" (e.g. race with a pending scrape)', async () => {
    const req = makeReq();
    const scan = await UrlToAdsScan.create({
      url: 'https://acme.ae', sessionId: 'sess_1', status: 'scanning',
    });
    await expect(
      urlToAdsService.generateAds({ scanId: scan._id, req }),
    ).rejects.toMatchObject({ code: 'scan_not_ready' });
  });

  it('404s when the scan id is unknown', async () => {
    await expect(
      urlToAdsService.generateAds({ scanId: 'nope_999', req: makeReq() }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('getScan / listScans / archiveScan', () => {
  it('getScan returns null for unknown id', async () => {
    const out = await urlToAdsService.getScan('nope_999', makeReq());
    expect(out).toBeNull();
  });

  it('listScans scopes by session when there is no user', async () => {
    const A = makeReq({ sessionId: 'sess_A' });
    const B = makeReq({ sessionId: 'sess_B' });
    await urlToAdsService.scanUrl({ url: 'https://a.com', req: A });
    await urlToAdsService.scanUrl({ url: 'https://b.com', req: B });
    const listA = await urlToAdsService.listScans({ req: A });
    const listB = await urlToAdsService.listScans({ req: B });
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0].url).toBe('https://a.com');
    expect(listB[0].url).toBe('https://b.com');
  });

  it('archiveScan flips status to archived + preserves payload', async () => {
    const req = makeReq();
    const scan = await urlToAdsService.scanUrl({ url: 'https://acme.ae', req });
    const archived = await urlToAdsService.archiveScan(scan._id, req);
    expect(archived.status).toBe('archived');
    expect(archived.brand.name).toBe('Acme Activewear');
  });
});
