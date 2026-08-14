'use strict';

/**
 * reelService — Phase 4 unit tests.
 *
 * We only exercise the pure pieces (schema validation + continuity merging)
 * plus a mocked planReel. Anything that touches Mongo/queues is out of scope
 * for this suite and is covered by the integration test harness instead.
 */

// Mock the Mongo + queue layer before requiring the service. This is the
// standard Jest pattern for hoisting mocks above the module import.
jest.mock('../model/schema/studioJob', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../services/queues', () => ({
  enqueueStudioJob: jest.fn(async () => ({})),
}));
jest.mock('../services/intentEngine', () => ({
  classifyIntent: jest.fn(async () => ({
    intent_type: 'reel',
    domain: 'creative_image',
    gulf_relevant: true,
    confidence: 0.8,
  })),
}));
jest.mock('../services/creditsService', () => ({
  getBalance: jest.fn(async () => 9999),
  quote: jest.fn(async ({ durationSec = 3 }) => durationSec * 4),
  chargeForJob: jest.fn(async () => ({})),
  canAfford: jest.fn(async () => true),
  refundJob: jest.fn(async () => ({})),
}));
// Mock catalog — a map from slug → AiModel-shaped row so the router mock
// can return the right row for each requested id. Models whose id ends in
// `_i2v` or `_fast_i2v` are treated as image-to-video variants.
const MOCK_CATALOG = {
  seedance_2_0_fast: {
    id: 'seedance_2_0_fast',
    label: 'Seedance 2.0 · Fast',
    videoVariant: 't2v',
    i2vSibling: 'seedance_2_0_fast_i2v',
    falModelId: 'bytedance/seedance-2.0/fast/text-to-video',
    capabilities: { requiredFields: [] },
  },
  seedance_2_0_fast_i2v: {
    id: 'seedance_2_0_fast_i2v',
    label: 'Seedance 2.0 · Fast i2v',
    videoVariant: 'i2v',
    falModelId: 'bytedance/seedance-2.0/fast/image-to-video',
    capabilities: { requiredFields: ['referenceImageUrl'] },
  },
  kling_v3_pro: {
    id: 'kling_v3_pro',
    label: 'Kling 3.0 Pro',
    videoVariant: 'i2v',
    falModelId: 'fal-ai/kling-video/v3/pro/image-to-video',
    capabilities: { requiredFields: ['referenceImageUrl'] },
  },
  'seedance_2.0': {
    id: 'seedance_2.0',
    label: 'Seedance 2.0',
    videoVariant: 't2v',
    falModelId: 'bytedance/seedance-2.0/fast/text-to-video',
    capabilities: { requiredFields: [] },
  },
};

jest.mock('../services/modelRouter', () => ({
  resolveModel: jest.fn(async ({ requestedModelId }) => {
    const id = requestedModelId || 'seedance_2.0';
    return MOCK_CATALOG[id] || {
      id,
      label: id,
      videoVariant: 't2v',
      falModelId: 'fal-ai/mock/video',
      capabilities: { requiredFields: [] },
    };
  }),
  validateRequiredFields: jest.fn((model, inputs) => {
    const required = model.capabilities?.requiredFields || [];
    const missing = required.filter((f) => !inputs[f]);
    if (missing.length) {
      const err = new Error(`${model.label} requires ${missing.join(', ')}`);
      err.code = 'missing_required_field';
      err.missing = missing;
      err.modelId = model.id;
      throw err;
    }
  }),
  route: jest.fn(async (args) => ({
    modelId: args.requestedModelId || 'seedance_2.0',
    provider: 'fal',
    falModelId: 'fal-ai/mock/video',
    input: { prompt: args.prompts.finalPrompt },
    creditsCost: (args.durationSec || 3) * 4,
    kind: 'video',
    label: 'Seedance 2.0',
  })),
}));

const reelService = require('../services/reelService');
const { mergeSceneDefaults, planReel, _schemas } = reelService;

// ─── Schemas ────────────────────────────────────────────────────────────────

describe('reelInputSchema', () => {
  const base = {
    scenes: [{ prompt: 'hero walks in', durationSec: 3 }],
  };

  it('rejects empty scenes array', () => {
    const r = _schemas.reelInputSchema.safeParse({ scenes: [] });
    expect(r.success).toBe(false);
  });

  it('caps scenes at 12', () => {
    const twelve = Array.from({ length: 13 }, () => ({ prompt: 'x', durationSec: 2 }));
    const r = _schemas.reelInputSchema.safeParse({ scenes: twelve });
    expect(r.success).toBe(false);
  });

  it('rejects empty prompt per scene', () => {
    const r = _schemas.reelInputSchema.safeParse({ scenes: [{ prompt: '   ', durationSec: 3 }] });
    expect(r.success).toBe(false);
  });

  it('coerces string durations into ints', () => {
    const r = _schemas.reelInputSchema.safeParse({
      scenes: [{ prompt: 'ok', durationSec: '4' }],
    });
    expect(r.success).toBe(true);
    expect(r.data.scenes[0].durationSec).toBe(4);
  });

  it('defaults continuity, aspectRatio, stitchStrategy', () => {
    const r = _schemas.reelInputSchema.parse(base);
    expect(r.continuity).toBe(true);
    expect(r.aspectRatio).toBe('9:16');
    expect(r.stitchStrategy).toBe('concat');
  });

  it('accepts per-scene modelId + constraints + styleTags', () => {
    const r = _schemas.reelInputSchema.parse({
      scenes: [{
        prompt: 'coffee pour',
        durationSec: 3,
        modelId: 'kling_v3_pro',
        constraints: { cameraAngle: 'top_down', styleTags: ['cinematic', 'editorial'] },
      }],
    });
    expect(r.scenes[0].modelId).toBe('kling_v3_pro');
    expect(r.scenes[0].constraints.styleTags).toEqual(['cinematic', 'editorial']);
  });
});

// ─── mergeSceneDefaults (pure) ───────────────────────────────────────────────

describe('mergeSceneDefaults', () => {
  it('fills in reel-level aspectRatio / modelId per scene', () => {
    const merged = mergeSceneDefaults({
      aspectRatio: '9:16',
      modelId: 'seedance_2.0',
      continuity: false,
      constraints: {},
      scenes: [
        { prompt: 'A', durationSec: 3 },
        { prompt: 'B', durationSec: 4, aspectRatio: '1:1' },
      ],
    });
    expect(merged[0].aspectRatio).toBe('9:16');
    expect(merged[0].modelId).toBe('seedance_2.0');
    expect(merged[1].aspectRatio).toBe('1:1'); // per-scene override wins
  });

  it('threads end-frame of previous scene into start-frame of next when continuity is on', () => {
    const merged = mergeSceneDefaults({
      aspectRatio: '9:16',
      modelId: 'seedance_2.0',
      continuity: true,
      constraints: {},
      scenes: [
        { prompt: 'A', durationSec: 3, lastFrameUrl: 'https://cdn.test/a-last.png' },
        { prompt: 'B', durationSec: 3 }, // no firstFrame — should inherit
        { prompt: 'C', durationSec: 3, firstFrameUrl: 'https://cdn.test/c-first.png' }, // pinned — keep
      ],
    });
    expect(merged[1].firstFrameUrl).toBe('https://cdn.test/a-last.png');
    expect(merged[1]._inheritedStartFrame).toBe(true);
    expect(merged[2].firstFrameUrl).toBe('https://cdn.test/c-first.png');
    expect(merged[2]._inheritedStartFrame).toBeFalsy();
  });

  it('is a no-op for continuity=false', () => {
    const merged = mergeSceneDefaults({
      aspectRatio: '9:16',
      modelId: 'seedance_2.0',
      continuity: false,
      constraints: {},
      scenes: [
        { prompt: 'A', durationSec: 3, lastFrameUrl: 'https://cdn.test/a-last.png' },
        { prompt: 'B', durationSec: 3 },
      ],
    });
    expect(merged[1].firstFrameUrl).toBeNull();
  });

  it('merges reel-level constraints into each scene (scene overrides win)', () => {
    const merged = mergeSceneDefaults({
      aspectRatio: '9:16',
      modelId: 'seedance_2.0',
      continuity: false,
      constraints: { lighting: 'golden_hour', mood: 'hopeful' },
      scenes: [
        { prompt: 'A', durationSec: 3, constraints: { lighting: 'hard_noon' } },
      ],
    });
    expect(merged[0].constraints.lighting).toBe('hard_noon'); // scene wins
    expect(merged[0].constraints.mood).toBe('hopeful');       // reel defaults through
  });

  it('indexes each scene and stamps sceneCount', () => {
    const merged = mergeSceneDefaults({
      aspectRatio: '9:16',
      modelId: 'seedance_2.0',
      continuity: false,
      constraints: {},
      scenes: [
        { prompt: 'A', durationSec: 3 },
        { prompt: 'B', durationSec: 3 },
        { prompt: 'C', durationSec: 3 },
      ],
    });
    expect(merged.map((s) => s.sceneIndex)).toEqual([0, 1, 2]);
    expect(merged.every((s) => s.sceneCount === 3)).toBe(true);
  });
});

// ─── planReel (mocked router + credits) ─────────────────────────────────────

describe('planReel', () => {
  it('aggregates credits across scenes and reports total duration', async () => {
    const plan = await planReel({
      scenes: [
        { prompt: 'A', durationSec: 3 },
        { prompt: 'B', durationSec: 5 },
        { prompt: 'C', durationSec: 2 },
      ],
    });
    expect(plan.sceneCount).toBe(3);
    expect(plan.totalDurationSec).toBe(10);
    // Mock quote = 4 * durationSec → 12 + 20 + 8 = 40
    expect(plan.totalCreditsCost).toBe(40);
    expect(plan.scenes).toHaveLength(3);
    expect(plan.scenes.map((s) => s.sceneIndex)).toEqual([0, 1, 2]);
  });

  it('passes enabled reel audio into creditsService.quote for every scene', async () => {
    const creditsService = require('../services/creditsService');
    creditsService.quote.mockClear();
    await planReel({
      scenes: [
        { prompt: 'A', durationSec: 3 },
        { prompt: 'B', durationSec: 4 },
      ],
      audio: { enabled: true, mode: 'native', script: 'voiceover hint' },
    });
    const calls = creditsService.quote.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c[0]?.audio?.enabled === true)).toBe(true);
    expect(calls.every((c) => c[0]?.audio?.mode === 'native')).toBe(true);
  });

  it('tags the error with sceneIndex when a specific clip is broken', async () => {
    // Kling requires referenceImageUrl — scene 1 doesn't have one
    await expect(
      planReel({
        modelId: 'seedance_2.0',
        scenes: [
          { prompt: 'A', durationSec: 3 },
          { prompt: 'B', durationSec: 3, modelId: 'kling_v3_pro' },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'missing_required_field',
      sceneIndex: 1,
    });
  });

  it('includes stitchPlan metadata in reelMeta', async () => {
    const plan = await planReel({
      scenes: [{ prompt: 'A', durationSec: 3 }],
      stitchStrategy: 'crossfade',
    });
    expect(plan.reelMeta.stitchPlan.strategy).toBe('crossfade');
    expect(plan.reelMeta.stitchPlan.gap).toBeGreaterThan(0);
  });

  it('threads continuity frames in the resolvedScenes output', async () => {
    const plan = await planReel({
      continuity: true,
      scenes: [
        { prompt: 'A', durationSec: 3, lastFrameUrl: 'https://cdn.test/a.png' },
        { prompt: 'B', durationSec: 3 },
      ],
    });
    expect(plan.resolvedScenes[1].firstFrameUrl).toBe('https://cdn.test/a.png');
    expect(plan.resolvedScenes[1]._inheritedStartFrame).toBe(true);
  });

  // Regression for Apr 2026 production bug: user picked `seedance_2_0_fast`
  // (t2v) but attached first/last frame URLs. Before the fix, the frames
  // were silently dropped at the provider boundary and the reel rendered
  // without them. The promoter now auto-swaps to the declared i2v sibling.
  it('auto-promotes a t2v model to its i2v sibling when frames are present', async () => {
    const plan = await planReel({
      modelId: 'seedance_2_0_fast',
      continuity: false,
      scenes: [
        { prompt: 'A', durationSec: 4,
          firstFrameUrl: 'https://cdn.test/start.jpg',
          lastFrameUrl:  'https://cdn.test/end.png' },
        { prompt: 'B', durationSec: 3 },   // no frames → stay t2v
      ],
    });
    expect(plan.scenes[0].modelId).toBe('seedance_2_0_fast_i2v');
    expect(plan.resolvedScenes[0]._originalModelId).toBe('seedance_2_0_fast');
    expect(plan.scenes[1].modelId).toBe('seedance_2_0_fast');
    expect(plan.resolvedScenes[1]._originalModelId).toBeUndefined();
  });

  it('does not promote when a scene already targets an i2v model', async () => {
    const plan = await planReel({
      modelId: 'kling_v3_pro',   // already i2v
      scenes: [{
        prompt: 'A', durationSec: 4,
        firstFrameUrl: 'https://cdn.test/start.jpg',
      }],
    });
    expect(plan.scenes[0].modelId).toBe('kling_v3_pro');
    expect(plan.resolvedScenes[0]._originalModelId).toBeUndefined();
  });
});
