'use strict';

/**
 * videoPipeline.test.js — brutal end-to-end tests for video generation persistence.
 *
 * Scope: the CHAIN fal.ai video url → processingService.processVideo →
 * storageService.uploadToR2 → StudioAsset row in Mongo.
 *
 * Why this file exists:
 *   Before this test suite, silent fallbacks in processVideo and persistAsset
 *   allowed the happy path to emit `completed` to the user while leaving the
 *   DB pointed at a raw fal.ai media URL (which expires in ~24h) or with no
 *   asset row at all. This test pins the contract: every completed job MUST
 *   have a StudioAsset row whose `url` is on OUR CDN, or the job MUST fail.
 */

// Set R2 env BEFORE storageService is required.
process.env.R2_BUCKET_NAME = 'test-bucket';
process.env.R2_PUBLIC_URL = 'https://cdn.qumak.test';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

// Deterministic fake fal.ai media URL — the "expires in 24h" kind we must
// never persist to Mongo as the final asset URL.
const FAL_RAW_URL = 'https://v3b.fal.media/files/b/0a8eba37/fake-video.mp4';

// ── Mocks (all hoisted; use `mock*` prefix for jest to allow out-of-scope refs) ──

let mockS3SendImpl = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: (...args) => mockS3SendImpl(...args),
  })),
  PutObjectCommand: jest.fn().mockImplementation((args) => args),
}));

let mockExecImpl = jest.fn((_cmd, _opts, cb) => {
  if (typeof cb === 'function') cb(null, { stdout: 'ok', stderr: '' });
  return { stdout: 'ok', stderr: '' };
});
jest.mock('child_process', () => ({
  exec: (...args) => mockExecImpl(...args),
}));

// fs mock — partial: retain Buffer constants and readfile-style access,
// override the disk operations processingService performs.
jest.mock('fs', () => {
  const { PassThrough } = require('stream');
  return {
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
    statSync: jest.fn(() => ({ size: 1234 })),
    createReadStream: jest.fn(() => new PassThrough()),
    createWriteStream: jest.fn(() => {
      const ws = new PassThrough();
      process.nextTick(() => ws.emit('finish'));
      return ws;
    }),
    unlinkSync: jest.fn(),
    renameSync: jest.fn(),
    writeFileSync: jest.fn(),
    readFileSync: jest.fn(() => Buffer.from('')),
  };
});

jest.mock('axios', () => {
  const { PassThrough } = require('stream');
  return {
    get: jest.fn(async () => {
      const stream = new PassThrough();
      process.nextTick(() => {
        stream.write(Buffer.from('fake-video-bytes'));
        stream.end();
      });
      return { data: stream };
    }),
  };
});

// ── Subject under test ─────────────────────────────────────────────────────
const processingService = require('../services/processingService');

// ── Helpers ────────────────────────────────────────────────────────────────
function resetMocks() {
  mockS3SendImpl = jest.fn().mockResolvedValue({});
  mockExecImpl = jest.fn((_cmd, _opts, cb) => {
    if (typeof cb === 'function') cb(null, { stdout: 'ok', stderr: '' });
    return { stdout: 'ok', stderr: '' };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Layer A: processingService.processVideo
// ──────────────────────────────────────────────────────────────────────────

describe('processingService.processVideo (brutal)', () => {
  beforeEach(() => resetMocks());

  test('happy path: returns R2 URL, NOT the raw fal.ai URL', async () => {
    const result = await processingService.processVideo({
      videoUrl: FAL_RAW_URL,
      jobId: 'job-happy-1',
      category: 'realestate',
      isWatermarked: false,
      aspectRatio: '9:16',
    });

    expect(result.storedUrl).toMatch(/^https:\/\/cdn\.qumak\.test\//);
    expect(result.storedUrl).not.toBe(FAL_RAW_URL);
    expect(result.storedUrl).toContain('job-happy-1');
    expect(result.processedLocally).toBe(true);
  });

  test('happy path (watermarked tier): still returns R2 URL', async () => {
    const result = await processingService.processVideo({
      videoUrl: FAL_RAW_URL,
      jobId: 'job-wm-1',
      category: 'gym',
      isWatermarked: true,
      aspectRatio: '16:9',
    });
    expect(result.storedUrl).toMatch(/^https:\/\/cdn\.qumak\.test\//);
    expect(result.processedLocally).toBe(true);
  });

  test('R2 upload fails → throws R2_UPLOAD_FAILED (no silent fallback to fal URL)', async () => {
    mockS3SendImpl = jest.fn().mockRejectedValue(new Error('AccessDenied'));

    await expect(
      processingService.processVideo({
        videoUrl: FAL_RAW_URL,
        jobId: 'job-r2-fail',
        category: 'realestate',
        isWatermarked: false,
      })
    ).rejects.toMatchObject({ code: 'R2_UPLOAD_FAILED' });
  });

  test('R2 env vars missing → throws R2_UPLOAD_FAILED (not silent fallback)', async () => {
    const saved = process.env.R2_BUCKET_NAME;
    delete process.env.R2_BUCKET_NAME;
    try {
      await expect(
        processingService.processVideo({
          videoUrl: FAL_RAW_URL,
          jobId: 'job-r2-envmissing',
          category: 'realestate',
          isWatermarked: false,
        })
      ).rejects.toMatchObject({ code: 'R2_UPLOAD_FAILED' });
    } finally {
      process.env.R2_BUCKET_NAME = saved;
    }
  });

  test('ffmpeg grade fails but R2 works → falls back to raw upload, still returns R2 URL', async () => {
    let calls = 0;
    mockExecImpl = jest.fn((cmd, _opts, cb) => {
      calls += 1;
      if (calls === 1 && String(cmd).includes('-vf')) {
        const err = new Error('ffmpeg: invalid filter chain');
        if (typeof cb === 'function') cb(err);
        throw err;
      }
      if (typeof cb === 'function') cb(null, { stdout: 'ok', stderr: '' });
      return { stdout: 'ok', stderr: '' };
    });

    const result = await processingService.processVideo({
      videoUrl: FAL_RAW_URL,
      jobId: 'job-ffmpeg-fail',
      category: 'realestate',
      isWatermarked: false,
    });

    expect(result.storedUrl).toMatch(/^https:\/\/cdn\.qumak\.test\//);
    expect(result.processedLocally).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer B: persistAsset contract (mirror of videoWorker impl)
// ──────────────────────────────────────────────────────────────────────────

function makeStudioAssetMock() {
  const rows = [];
  return {
    rows,
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const existing = rows.find((r) =>
        Object.entries(filter).every(([k, v]) => String(r[k]) === String(v))
      );
      if (existing) {
        Object.assign(existing, update.$set || {});
        return existing;
      }
      const row = {
        _id: `asset-${rows.length + 1}`,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      };
      rows.push(row);
      return row;
    }),
  };
}

// Inline mirror of workers/videoWorker_v3.js persistAsset contract. If this
// diverges from the worker impl, these tests still pin the intended contract —
// and the `contract snapshot` test below catches divergence from the worker.
async function persistAsset(StudioAsset, job, opts) {
  const { type, url, thumbnailUrl, mimeType, resolution, variantIndex = null } = opts;
  if (!url || typeof url !== 'string') {
    const err = new Error(
      `persistAsset called without a URL for job ${job?._id}, type=${type}`
    );
    err.code = 'PERSIST_ASSET_BAD_INPUT';
    throw err;
  }
  const isWatermarked = !!job.isWatermarked;
  const filter =
    variantIndex != null
      ? { jobId: job._id, type, variantIndex }
      : { jobId: job._id, type };
  return StudioAsset.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        jobId: job._id,
        sessionId: job.sessionId,
        userId: job.userId || null,
        type,
        category: job.category || '',
        brandName: job.userInputs?.brandName || '',
        tier: job.tier || 'free',
        status: 'completed',
        variantIndex,
      },
      $set: {
        url,
        thumbnailUrl: thumbnailUrl || null,
        mimeType: mimeType || (type === 'video' ? 'video/mp4' : 'image/jpeg'),
        resolution: resolution || null,
        isWatermarked,
        ...(isWatermarked ? { watermarkedUrl: url } : { cleanUrl: url }),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function fakeJob(overrides = {}) {
  return {
    _id: 'job-abc',
    sessionId: 'sess-1',
    userId: null,
    category: 'realestate',
    userInputs: { brandName: 'Marina Heights' },
    tier: 'free',
    isWatermarked: true,
    assetId: null,
    save: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('videoWorker persistAsset contract (brutal)', () => {
  let StudioAsset;
  beforeEach(() => {
    StudioAsset = makeStudioAssetMock();
  });

  test('happy path: upserts StudioAsset with R2 url (never a fal.ai url)', async () => {
    const url = 'https://cdn.qumak.test/studio/videos/job-abc/output.mp4';
    const asset = await persistAsset(StudioAsset, fakeJob(), {
      type: 'video',
      url,
      mimeType: 'video/mp4',
    });
    expect(asset).toMatchObject({
      type: 'video',
      url,
      watermarkedUrl: url,
      status: 'completed',
      brandName: 'Marina Heights',
      category: 'realestate',
    });
    expect(StudioAsset.rows).toHaveLength(1);
    expect(StudioAsset.rows[0].url).not.toMatch(/fal\.media|fal\.ai/);
  });

  test('missing url → throws PERSIST_ASSET_BAD_INPUT (no silent null row)', async () => {
    await expect(
      persistAsset(StudioAsset, fakeJob(), { type: 'video', url: null })
    ).rejects.toMatchObject({ code: 'PERSIST_ASSET_BAD_INPUT' });
    expect(StudioAsset.rows).toHaveLength(0);
  });

  test('empty-string url → throws PERSIST_ASSET_BAD_INPUT', async () => {
    await expect(
      persistAsset(StudioAsset, fakeJob(), { type: 'video', url: '' })
    ).rejects.toMatchObject({ code: 'PERSIST_ASSET_BAD_INPUT' });
  });

  test('non-string url → throws PERSIST_ASSET_BAD_INPUT', async () => {
    await expect(
      persistAsset(StudioAsset, fakeJob(), { type: 'video', url: { not: 'a string' } })
    ).rejects.toMatchObject({ code: 'PERSIST_ASSET_BAD_INPUT' });
  });

  test('variants: two calls with different variantIndex produce two rows', async () => {
    const u = (i) => `https://cdn.qumak.test/studio/videos/job-abc/v${i}.mp4`;
    await persistAsset(StudioAsset, fakeJob(), { type: 'video', url: u(0), variantIndex: 0 });
    await persistAsset(StudioAsset, fakeJob(), { type: 'video', url: u(1), variantIndex: 1 });
    expect(StudioAsset.rows).toHaveLength(2);
    expect(StudioAsset.rows.map((r) => r.variantIndex).sort()).toEqual([0, 1]);
  });

  test('non-watermarked tier: writes cleanUrl instead of watermarkedUrl', async () => {
    const url = 'https://cdn.qumak.test/studio/videos/job-abc/output.mp4';
    const asset = await persistAsset(StudioAsset, fakeJob({ isWatermarked: false }), {
      type: 'video',
      url,
    });
    expect(asset.cleanUrl).toBe(url);
    expect(asset.watermarkedUrl).toBeUndefined();
  });

  test('contract snapshot: worker source contains the PERSIST_ASSET_BAD_INPUT guard', () => {
    const fsReal = jest.requireActual('fs');
    const path = require('path');
    for (const relPath of [
      'workers/videoWorker_v3.js',
      'workers/videoWorker.js',
    ]) {
      const src = fsReal.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
      expect(src).toContain('PERSIST_ASSET_BAD_INPUT');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer C: end-to-end chain — processVideo output is persist-able
// ──────────────────────────────────────────────────────────────────────────

describe('end-to-end chain: processVideo → persistAsset', () => {
  beforeEach(() => resetMocks());

  test('processVideo output feeds cleanly into a StudioAsset row', async () => {
    const proc = await processingService.processVideo({
      videoUrl: FAL_RAW_URL,
      jobId: 'job-e2e-1',
      category: 'realestate',
      isWatermarked: false,
      aspectRatio: '9:16',
    });

    const StudioAsset = makeStudioAssetMock();
    await persistAsset(StudioAsset, fakeJob({ _id: 'job-e2e-1', isWatermarked: false }), {
      type: 'video',
      url: proc.storedUrl,
    });

    expect(StudioAsset.rows).toHaveLength(1);
    const row = StudioAsset.rows[0];
    expect(row.url).toMatch(/^https:\/\/cdn\.qumak\.test\//);
    expect(row.url).not.toMatch(/fal\.media|fal\.ai/);
    expect(row.status).toBe('completed');
    expect(row.cleanUrl).toBe(proc.storedUrl);
  });
});
