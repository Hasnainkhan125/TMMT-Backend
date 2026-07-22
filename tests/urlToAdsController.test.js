'use strict';

/**
 * urlToAdsController — Phase 7 HTTP-surface tests.
 *
 * We mock `urlToAdsService` entirely — this suite is about:
 *   • input wiring (body/params → service args)
 *   • output serialization (scan doc → frontend-friendly shape)
 *   • error shaping (service throws → correct HTTP status + code)
 *
 * Nothing below talks to Mongo or fetches.
 */

jest.mock('../services/urlToAdsService', () => ({
  scanUrl:      jest.fn(),
  generateAds:  jest.fn(),
  getScan:      jest.fn(),
  listScans:    jest.fn(),
  archiveScan:  jest.fn(),
}));

const svc = require('../services/urlToAdsService');
const ctrl = require('../controllers/studio/urlToAdsController');

function mockRes() {
  const res = {};
  res.status = jest.fn(function (n) { res._status = n; return res; });
  res.json   = jest.fn(function (body) { res._body = body; return res; });
  res.cookie = jest.fn();
  return res;
}

function mockReq({ body = {}, params = {}, query = {}, cookies = {}, user = null } = {}) {
  return { body, params, query, cookies, user, headers: {} };
}

const FAKE_DOC = {
  _id: 'scan_abc',
  url: 'https://acme.ae',
  host: 'acme.ae',
  status: 'ready',
  brand: { name: 'Acme', category: 'gym' },
  competitors: [{ name: 'GymNation', url: 'https://gymnation.com' }],
  copy: { headlines: ['Hello'] },
  ads: [
    { label: 'Hero', prompt: 'p1', aspectRatio: '1:1', status: 'pending' },
    { label: 'Social', prompt: 'p2', aspectRatio: '9:16', status: 'pending' },
    { label: 'CTA', prompt: 'p3', aspectRatio: '4:5', status: 'pending' },
  ],
  adSetId: null,
  createdAt: new Date('2026-04-01'),
  updatedAt: new Date('2026-04-01'),
  toObject() { return { ...this }; },
};

beforeEach(() => jest.clearAllMocks());

describe('POST /url-to-ads/scan', () => {
  it('returns { success, scan } when the service succeeds', async () => {
    svc.scanUrl.mockResolvedValueOnce(FAKE_DOC);
    const req = mockReq({ body: { url: 'https://acme.ae' } });
    const res = mockRes();
    await ctrl.scan(req, res);
    expect(svc.scanUrl).toHaveBeenCalledWith({ url: 'https://acme.ae', req });
    expect(res._body.success).toBe(true);
    expect(res._body.scan.id).toBe('scan_abc');
    expect(res._body.scan.ads).toHaveLength(3);
    expect(res._body.scan.ads[0].aspectRatio).toBe('1:1');
    expect(res._body.scan.competitors[0].name).toBe('GymNation');
  });

  it('sets the session cookie when one is not present', async () => {
    svc.scanUrl.mockResolvedValueOnce(FAKE_DOC);
    const req = mockReq({ body: { url: 'https://acme.ae' } });
    const res = mockRes();
    await ctrl.scan(req, res);
    expect(res.cookie).toHaveBeenCalledWith(
      'qumakSession',
      expect.any(String),
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('502s with fetch_failed when the scraper times out', async () => {
    svc.scanUrl.mockRejectedValueOnce(
      Object.assign(new Error('Timed out'), { code: 'fetch_failed' }),
    );
    const req = mockReq({ body: { url: 'https://acme.ae' } });
    const res = mockRes();
    await ctrl.scan(req, res);
    expect(res._status).toBe(502);
    expect(res._body).toEqual({
      success: false,
      error:   'fetch_failed',
      message: expect.stringMatching(/timed out/i),
    });
  });

  it('400s with invalid_input when Zod rejects the payload', async () => {
    svc.scanUrl.mockRejectedValueOnce(
      Object.assign(new Error('ZOD'), { name: 'ZodError', issues: [{ message: 'Paste a URL to scan.' }] }),
    );
    const req = mockReq({ body: {} });
    const res = mockRes();
    await ctrl.scan(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('invalid_input');
    expect(res._body.message).toMatch(/paste a url/i);
  });
});

describe('GET /url-to-ads/scan/:id', () => {
  it('returns the scan when the service resolves it', async () => {
    svc.getScan.mockResolvedValueOnce(FAKE_DOC);
    const req = mockReq({ params: { id: 'scan_abc' } });
    const res = mockRes();
    await ctrl.getById(req, res);
    expect(svc.getScan).toHaveBeenCalledWith('scan_abc', req);
    expect(res._body.success).toBe(true);
    expect(res._body.scan.id).toBe('scan_abc');
  });

  it('404s when the scan is missing', async () => {
    svc.getScan.mockResolvedValueOnce(null);
    const req = mockReq({ params: { id: 'nope' } });
    const res = mockRes();
    await ctrl.getById(req, res);
    expect(res._status).toBe(404);
    expect(res._body.error).toBe('not_found');
  });

  it('403s when the scan belongs to someone else', async () => {
    svc.getScan.mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'forbidden' }),
    );
    const req = mockReq({ params: { id: 'scan_abc' } });
    const res = mockRes();
    await ctrl.getById(req, res);
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('forbidden');
  });
});

describe('GET /url-to-ads/scans', () => {
  it('returns a list, serialized', async () => {
    svc.listScans.mockResolvedValueOnce([FAKE_DOC, FAKE_DOC]);
    const req = mockReq({ query: { limit: '5' } });
    const res = mockRes();
    await ctrl.list(req, res);
    expect(svc.listScans).toHaveBeenCalledWith({ req, limit: 5 });
    expect(res._body.scans).toHaveLength(2);
    expect(res._body.scans[0].id).toBe('scan_abc');
  });

  it('caps limit at 100 even if asked for more', async () => {
    svc.listScans.mockResolvedValueOnce([]);
    const req = mockReq({ query: { limit: '9999' } });
    const res = mockRes();
    await ctrl.list(req, res);
    expect(svc.listScans).toHaveBeenCalledWith({ req, limit: 100 });
  });
});

describe('POST /url-to-ads/scan/:id/generate', () => {
  it('fires the service with params + body and returns adSetId', async () => {
    svc.generateAds.mockResolvedValueOnce({
      scan:    { ...FAKE_DOC, adSetId: 'adset_xyz', status: 'rendering' },
      adSetId: 'adset_xyz',
    });
    const req = mockReq({
      params: { id: 'scan_abc' },
      body:   { numVariants: 3, kind: 'image' },
    });
    const res = mockRes();
    await ctrl.generate(req, res);
    expect(svc.generateAds).toHaveBeenCalledWith(expect.objectContaining({
      scanId: 'scan_abc',
      req,
      numVariants: 3,
      kind: 'image',
    }));
    expect(res._body.success).toBe(true);
    expect(res._body.adSetId).toBe('adset_xyz');
  });

  it('402s when credits are insufficient (propagates code)', async () => {
    svc.generateAds.mockRejectedValueOnce(
      Object.assign(new Error('broke'), { code: 'insufficient_credits' }),
    );
    const req = mockReq({ params: { id: 'scan_abc' } });
    const res = mockRes();
    await ctrl.generate(req, res);
    expect(res._status).toBe(402);
    expect(res._body.error).toBe('insufficient_credits');
  });

  it('409s when the scan isn\'t ready yet', async () => {
    svc.generateAds.mockRejectedValueOnce(
      Object.assign(new Error('still scanning'), { code: 'scan_not_ready' }),
    );
    const req = mockReq({ params: { id: 'scan_abc' } });
    const res = mockRes();
    await ctrl.generate(req, res);
    expect(res._status).toBe(409);
    expect(res._body.error).toBe('scan_not_ready');
  });
});

describe('DELETE /url-to-ads/scan/:id', () => {
  it('archives and returns the resulting doc', async () => {
    svc.archiveScan.mockResolvedValueOnce({ ...FAKE_DOC, status: 'archived', toObject() { return { ...this, status: 'archived' }; } });
    const req = mockReq({ params: { id: 'scan_abc' } });
    const res = mockRes();
    await ctrl.archive(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.scan.status).toBe('archived');
  });

  it('404s when the scan is not found', async () => {
    svc.archiveScan.mockResolvedValueOnce(null);
    const req = mockReq({ params: { id: 'nope' } });
    const res = mockRes();
    await ctrl.archive(req, res);
    expect(res._status).toBe(404);
  });
});
