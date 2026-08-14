'use strict';

/**
 * adSetService — Phase 5 unit tests.
 *
 * Same strategy as reelService.test.js — we stub Mongo, queue, intentEngine,
 * creditsService and modelRouter so the pure pieces (schema validation,
 * constraint composition, variant brief building, plan aggregation) run in
 * isolation. End-to-end enqueue+worker behavior is covered by the
 * integration harness.
 */

jest.mock('../model/schema/studioJob', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(async () => ({})),
}));
jest.mock('../services/queues', () => ({
  enqueueStudioJob: jest.fn(async () => ({})),
}));
jest.mock('../services/intentEngine', () => {
  // Minimal stand-in for the classifier + context assembler + variant
  // builder. Variant tracks differ on `lighting` so tests can verify the
  // label derivation and composition.
  const TRACKS = [
    { lighting: 'soft_natural',  cameraAngle: 'eye_level',  motion: 'slow_push' },
    { lighting: 'hard_studio',   cameraAngle: 'low_angle',  motion: 'orbit'     },
    { lighting: 'golden_hour',   cameraAngle: 'over_shoulder', motion: 'handheld' },
    { lighting: 'low_key_moody', cameraAngle: 'eye_level',  motion: 'static'    },
    { lighting: 'high_key',      cameraAngle: 'high_angle', motion: 'slow_pull' },
  ];
  return {
    classifyIntent: jest.fn(async () => ({
      intent_type: 'ad_image',
      domain: 'restaurant',
      is_commercial: true,
      gulf_relevant: true,
      confidence: 0.9,
    })),
    assembleContext: jest.fn(async () => ({
      dna: { scene: 'warm interior', lighting: 'amber', grade: 'warm', neg: 'cheap' },
      seasonal: null,
      gulfMod: 'UAE hospitality',
      brandKit: null,
      urlData: null,
    })),
    buildVariants: jest.fn(({ n }) => {
      return Array.from({ length: n }, (_, i) => ({
        variantIndex: i,
        finalPrompt: `synthesized prompt variant ${i}`,
        negativePrompt: 'cheap',
        constraints: TRACKS[i % TRACKS.length],
        promptMetadata: { domain: 'restaurant' },
      }));
    }),
  };
});
jest.mock('../services/creditsService', () => ({
  getBalance: jest.fn(async () => 9999),
  quote: jest.fn(async ({ kind, durationSec = 5 }) =>
    kind === 'video' ? durationSec * 4 : 3
  ),
  chargeForJob: jest.fn(async () => ({})),
  canAfford: jest.fn(async () => true),
  refundForJob: jest.fn(async () => ({})),
}));
jest.mock('../services/modelRouter', () => ({
  validateAspectRatio: jest.fn(),
  resolveModel: jest.fn(async ({ requestedModelId, kind }) => ({
    id: requestedModelId || (kind === 'video' ? 'seedance_2.0' : 'flux_schnell'),
    label: requestedModelId || (kind === 'video' ? 'Seedance 2.0' : 'Flux Schnell'),
    provider: 'fal',
    kind,
    falModelId: 'fal-ai/mock/x',
    capabilities: {
      requiredFields:
        requestedModelId === 'kling_v3_pro' ? ['referenceImageUrl'] : [],
    },
  })),
  validateRequiredFields: jest.fn((model, inputs) => {
    const req = model.capabilities?.requiredFields || [];
    const missing = req.filter((f) => !inputs[f]);
    if (missing.length) {
      const err = new Error(`${model.label} requires ${missing.join(', ')}`);
      err.code = 'missing_required_field';
      err.missing = missing;
      err.modelId = model.id;
      throw err;
    }
  }),
  route: jest.fn(async (args) => ({
    modelId:    args.requestedModelId || (args.kind === 'video' ? 'seedance_2.0' : 'flux_schnell'),
    provider:   'fal',
    falModelId: 'fal-ai/mock/x',
    input:      { prompt: args.prompts.finalPrompt },
    creditsCost: args.kind === 'video' ? (args.durationSec || 5) * 4 : 3,
    kind:        args.kind,
    label:       'Mock',
  })),
}));

const adSetService = require('../services/adSetService');
const { planAdSet, composeConstraints, variantLabel, _schemas, _constants } = adSetService;

// ─── Schemas ────────────────────────────────────────────────────────────────

describe('adSetInputSchema', () => {
  it('requires a non-empty prompt', () => {
    const r = _schemas.adSetInputSchema.safeParse({ prompt: '' });
    expect(r.success).toBe(false);
  });

  it('caps numVariants at MAX_VARIANTS', () => {
    const r = _schemas.adSetInputSchema.safeParse({
      prompt: 'ok',
      numVariants: _constants.MAX_VARIANTS + 1,
    });
    expect(r.success).toBe(false);
  });

  it('coerces numVariants from string', () => {
    const r = _schemas.adSetInputSchema.safeParse({
      prompt: 'ok',
      numVariants: '4',
    });
    expect(r.success).toBe(true);
    expect(r.data.numVariants).toBe(4);
  });

  it('defaults kind=image, numVariants=3, platform=instagram, locale=gulf', () => {
    const r = _schemas.adSetInputSchema.parse({ prompt: 'ok' });
    expect(r.kind).toBe('image');
    expect(r.numVariants).toBe(3);
    expect(r.platform).toBe('instagram');
    expect(r.locale).toBe('gulf');
  });

  it('accepts kind=video + durationSec + modelId', () => {
    const r = _schemas.adSetInputSchema.parse({
      prompt: 'launch reel',
      kind: 'video',
      durationSec: 6,
      modelId: 'seedance_2.0',
    });
    expect(r.kind).toBe('video');
    expect(r.durationSec).toBe(6);
    expect(r.modelId).toBe('seedance_2.0');
  });

  it('accepts constraints with styleTags array', () => {
    const r = _schemas.adSetInputSchema.parse({
      prompt: 'ok',
      constraints: { lighting: 'golden_hour', styleTags: ['luxury', 'editorial'] },
    });
    expect(r.constraints.lighting).toBe('golden_hour');
    expect(r.constraints.styleTags).toEqual(['luxury', 'editorial']);
  });
});

// ─── composeConstraints (pure) ──────────────────────────────────────────────

describe('composeConstraints', () => {
  it('user constraints override the variant track', () => {
    const out = composeConstraints(
      { lighting: 'golden_hour' },
      { lighting: 'hard_studio', motion: 'orbit' },
    );
    expect(out.lighting).toBe('golden_hour');
    expect(out.motion).toBe('orbit');
  });

  it('preserves track values for axes the user left empty', () => {
    const out = composeConstraints({}, { lighting: 'hard_studio' });
    expect(out.lighting).toBe('hard_studio');
  });

  it('concats + dedupes styleTags rather than replacing', () => {
    const out = composeConstraints(
      { styleTags: ['editorial', 'luxury'] },
      { styleTags: ['cinematic', 'editorial'] },
    );
    expect(out.styleTags.sort()).toEqual(['cinematic', 'editorial', 'luxury']);
  });

  it('treats empty strings as not-set', () => {
    const out = composeConstraints({ lighting: '' }, { lighting: 'hard_studio' });
    expect(out.lighting).toBe('hard_studio');
  });

  it('returns track when user is null/undefined', () => {
    const out = composeConstraints(null, { lighting: 'hard_studio' });
    expect(out.lighting).toBe('hard_studio');
  });
});

// ─── variantLabel (pure) ────────────────────────────────────────────────────

describe('variantLabel', () => {
  it('picks the most distinctive axis (lighting first)', () => {
    expect(variantLabel({ lighting: 'golden_hour', cameraAngle: 'eye_level' }))
      .toBe('Golden hour');
  });

  it('falls through to motion when no lighting', () => {
    expect(variantLabel({ motion: 'orbit' })).toBe('Orbit');
  });

  it('returns null for an empty track', () => {
    expect(variantLabel({})).toBeNull();
  });

  it('humanises unknown values via underscore strip', () => {
    expect(variantLabel({ lighting: 'mystery_glow' })).toBe('mystery glow');
  });
});

// ─── planAdSet (mocked engine + router + credits) ───────────────────────────

describe('planAdSet', () => {
  it('expands to N variant briefs and aggregates cost', async () => {
    const plan = await planAdSet({
      prompt: 'luxury hotel lobby at sunset',
      numVariants: 3,
      kind: 'image',
      brandName: 'Avenir',
      locale: 'gulf',
    });

    expect(plan.numVariants).toBe(3);
    expect(plan.variants).toHaveLength(3);
    expect(plan.variantBriefs).toHaveLength(3);
    // Mock quote = 3 credits per image → 9 creative + 5 copy default = 14
    expect(plan.baseCost).toBe(9);
    expect(plan.copyCost).toBe(_constants.DEFAULT_COPY_CREDITS);
    expect(plan.totalCreditsCost).toBe(plan.baseCost + plan.copyCost);
  });

  it('turns copy charge off for video kind by default', async () => {
    const plan = await planAdSet({
      prompt: 'viral reel',
      kind: 'video',
      durationSec: 5,
      numVariants: 3,
    });
    expect(plan.copyCost).toBe(0);
    // Mock quote = 4 * durationSec per video = 20 per variant × 3 = 60
    expect(plan.baseCost).toBe(60);
  });

  it('respects explicit generateCopy=false even for image', async () => {
    const plan = await planAdSet({
      prompt: 'still life',
      kind: 'image',
      numVariants: 2,
      generateCopy: false,
    });
    expect(plan.copyCost).toBe(0);
    expect(plan.totalCreditsCost).toBe(plan.baseCost);
  });

  it('fills default aspectRatio by kind when unspecified', async () => {
    const img = await planAdSet({ prompt: 'a', kind: 'image',  numVariants: 1 });
    const vid = await planAdSet({ prompt: 'a', kind: 'video',  numVariants: 1, durationSec: 3 });
    expect(img.aspectRatio).toBe('4:5');
    expect(vid.aspectRatio).toBe('9:16');
  });

  it('tags errors with variantIndex when a specific variant is broken', async () => {
    // Kling requires referenceImageUrl — no reference passed → missing field
    await expect(
      planAdSet({
        prompt: 'kling shot',
        kind: 'video',
        durationSec: 5,
        modelId: 'kling_v3_pro',
        numVariants: 2,
      }),
    ).rejects.toMatchObject({
      code: 'missing_required_field',
      variantIndex: 0,
    });
  });

  it('echoes the classified intent back to the caller', async () => {
    const plan = await planAdSet({
      prompt: 'warm restaurant scene',
      numVariants: 3,
    });
    expect(plan.intent.domain).toBe('restaurant');
    expect(plan.intent.is_commercial).toBe(true);
  });

  it('human-labels each variant from its dominant constraint axis', async () => {
    const plan = await planAdSet({
      prompt: 'brand hero',
      numVariants: 3,
    });
    // Track 0 = soft_natural, Track 1 = hard_studio, Track 2 = golden_hour
    const labels = plan.variantBriefs.map((v) => v.label);
    expect(labels).toContain('Soft daylight');
    expect(labels).toContain('Hard studio');
    expect(labels).toContain('Golden hour');
  });

  it('preserves user-pinned constraints across all variants (test one variable)', async () => {
    const plan = await planAdSet({
      prompt: 'brand hero',
      numVariants: 4,
      constraints: { lighting: 'golden_hour' },
    });
    // User pinned lighting=golden_hour → every variant should have it.
    for (const v of plan.variantBriefs) {
      expect(v.constraints.lighting).toBe('golden_hour');
    }
    // But motion should still vary track-over-track so the user IS testing
    // a variable. Mocked tracks use distinct motion values.
    const motions = new Set(plan.variantBriefs.map((v) => v.constraints.motion));
    expect(motions.size).toBeGreaterThan(1);
  });
});
