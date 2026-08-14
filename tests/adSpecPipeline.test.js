'use strict';

/**
 * adSpecPipeline.test.js — verifies the adSpec → recipe → adSet chain.
 * Tests that per-beat data (prompts, referenceImageUrls, userCopy, durationSec)
 * survive all transformation steps and reach the child job.
 */

const { adSpecToRecipeOpts, createDraftSpec } = require('../services/adSpec/adSpec');
const { buildBeatDirectorPrompt, buildShotRecipe, normKey } = require('../services/shotRecipeEngine');

// ── adSpecToRecipeOpts ──────────────────────────────────────────────────────

describe('adSpecToRecipeOpts', () => {
  function makeSpec(overrides = {}) {
    return {
      specId: 'test-spec',
      scanId: 'test-scan',
      status: 'draft',
      structure: 'hook_problem_solution',
      templateKey: 'user_demo',
      aspectRatio: '9:16',
      brand: { name: 'Glam Secret', category: 'beauty', palette: ['#FF6B9D'], logoUrl: null },
      product: { url: 'https://cdn.example.com/product.jpg', title: 'Glam Secret Serum' },
      avatar: null,
      music: null,
      headline: 'Transform your skin in 7 days',
      cta: 'Shop now',
      triggers: ['FOMO', 'aspiration'],
      beats: [
        { id: 'b1', role: 'hook', hookType: 'curiosity_gap', durationSec: 3, userCopy: 'The biggest skin secret nobody talks about.', intent: 'Stop scroll', overlay: 'headline', beatPrompt: null, assetRef: null, assetRefs: [{ kind: 'upload', url: 'https://cdn.example.com/ref1.jpg', label: 'ref1' }] },
        { id: 'b2', role: 'problem', hookType: null, durationSec: 4, userCopy: 'Tried everything and still no results?', intent: 'Name the pain', overlay: null, beatPrompt: null, assetRef: null, assetRefs: [] },
        { id: 'b3', role: 'solution', hookType: null, durationSec: 4, userCopy: 'Glam Secret serum changes everything.', intent: 'Introduce product', overlay: null, beatPrompt: null, assetRef: null, assetRefs: [{ kind: 'upload', url: 'https://cdn.example.com/ref2.jpg', label: 'ref2' }] },
        { id: 'b4', role: 'cta', hookType: null, durationSec: 3, userCopy: 'Shop now and get 30% off.', intent: 'Drive action', overlay: 'cta', beatPrompt: null, assetRef: null, assetRefs: [] },
      ],
      edits: {},
      sourceFingerprint: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test('brandName from spec.brand.name', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.brandName).toBe('Glam Secret');
  });

  test('__specBeats carries userCopy per beat', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.__specBeats).toHaveLength(4);
    expect(opts.__specBeats[0].userCopy).toBe('The biggest skin secret nobody talks about.');
    expect(opts.__specBeats[1].userCopy).toBe('Tried everything and still no results?');
  });

  test('__specBeats carries durationSec per beat', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.__specBeats[0].durationSec).toBe(3);
    expect(opts.__specBeats[1].durationSec).toBe(4);
    expect(opts.__specBeats[3].durationSec).toBe(3);
  });

  test('__specBeats carries beatAssetUrls from assetRefs', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    // beat 0 has one assetRef
    expect(opts.__specBeats[0].beatAssetUrls).toContain('https://cdn.example.com/ref1.jpg');
    // beat 1 has no assetRefs
    expect(opts.__specBeats[1].beatAssetUrls).toHaveLength(0);
    // beat 2 has one assetRef
    expect(opts.__specBeats[2].beatAssetUrls).toContain('https://cdn.example.com/ref2.jpg');
  });

  test('productImageUrl from spec.product.url', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.productImageUrl).toBe('https://cdn.example.com/product.jpg');
  });

  test('durationSec is sum of beat durations', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.durationSec).toBe(14); // 3+4+4+3
  });

  test('shotCount equals beat count', () => {
    const opts = adSpecToRecipeOpts(makeSpec());
    expect(opts.shotCount).toBe(4);
  });
});

// ── buildBeatDirectorPrompt ─────────────────────────────────────────────────

describe('buildBeatDirectorPrompt', () => {
  const brand = { brandName: 'Glam Secret', palette: ['#FF6B9D'], category: 'beauty' };
  const tpl = { presenter: false };

  test('uses beatPrompt directly when provided', () => {
    const beat = { role: 'hook', hookType: 'curiosity_gap', userCopy: 'unused copy', beatPrompt: 'Custom director prompt with lots of detail' };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result).toContain('Custom director prompt with lots of detail');
    expect(result).not.toContain('unused copy');
  });

  test('userCopy appears in prompt when no beatPrompt', () => {
    const beat = { role: 'hook', hookType: 'curiosity_gap', userCopy: 'The skin secret nobody talks about', beatPrompt: null };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result).toContain('The skin secret nobody talks about');
  });

  test('role-based visual description included', () => {
    const beat = { role: 'cta', hookType: null, userCopy: 'Shop now', beatPrompt: null };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result.toLowerCase()).toMatch(/authoritative|steady|text overlay|inviting/);
  });

  test('hookType question generates question visual', () => {
    const beat = { role: 'hook', hookType: 'question', userCopy: 'Ready to transform?', beatPrompt: null };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result.toLowerCase()).toContain('question');
  });

  test('pain hookType generates pain visual', () => {
    const beat = { role: 'hook', hookType: 'pain', userCopy: 'Skin problems ruining your confidence?', beatPrompt: null };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result.toLowerCase()).toMatch(/frustrat|relatable|authentic/);
  });

  test('brand palette included in prompt', () => {
    const beat = { role: 'product', hookType: null, userCopy: '', beatPrompt: null };
    const result = buildBeatDirectorPrompt({ beat, brand, headline: '', tpl, isPresenter: false });
    expect(result).toContain('#FF6B9D');
  });
});

// ── buildShotRecipe with __specBeats ────────────────────────────────────────

describe('buildShotRecipe with __specBeats', () => {
  const brand = { brandName: 'Glam Secret', scanId: 'scan1', palette: ['#FF6B9D'], category: 'beauty', angle: 'Transform skin', productImageUrl: 'https://cdn.example.com/product.jpg', logoUrl: null };

  const specBeats = [
    { role: 'hook', hookType: 'curiosity_gap', durationSec: 3, userCopy: 'Secret nobody knows', beatPrompt: null, beatAssetUrls: ['https://cdn.example.com/ref1.jpg'], overlay: { kind: 'headline', text: 'Transform your skin' } },
    { role: 'problem', hookType: null, durationSec: 4, userCopy: 'Tried everything already?', beatPrompt: null, beatAssetUrls: [], overlay: null },
    { role: 'cta', hookType: null, durationSec: 3, userCopy: 'Shop now at glamSecret.ae', beatPrompt: null, beatAssetUrls: ['https://cdn.example.com/ref2.jpg'], overlay: { kind: 'cta', text: 'Shop now' } },
  ];

  test('skips scaleShots when __specBeats provided', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: 'Transform your skin', cta: 'Shop now', __specBeats: specBeats });
    expect(recipe.shots).toHaveLength(3);
  });

  test('per-beat durationSec on each shot', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    expect(recipe.shots[0].durationSec).toBe(3);
    expect(recipe.shots[1].durationSec).toBe(4);
    expect(recipe.shots[2].durationSec).toBe(3);
  });

  test('userCopy flows to each shot', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    expect(recipe.shots[0].userCopy).toBe('Secret nobody knows');
    expect(recipe.shots[1].userCopy).toBe('Tried everything already?');
  });

  test('prompt is unique per beat (not the same generic text)', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    const p0 = recipe.shots[0].prompt;
    const p1 = recipe.shots[1].prompt;
    const p2 = recipe.shots[2].prompt;
    expect(p0).not.toBe(p1);
    expect(p1).not.toBe(p2);
  });

  test('beatAssetUrls flow to shot', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    expect(recipe.shots[0].beatAssetUrls).toContain('https://cdn.example.com/ref1.jpg');
    expect(recipe.shots[1].beatAssetUrls).toHaveLength(0);
    expect(recipe.shots[2].beatAssetUrls).toContain('https://cdn.example.com/ref2.jpg');
  });

  test('hook prompt contains userCopy text', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    expect(recipe.shots[0].prompt).toContain('Secret nobody knows');
  });

  test('totalDurationSec is sum of beat durations', async () => {
    const recipe = await buildShotRecipe(brand, { templateKey: 'user_demo', headline: '', cta: '', __specBeats: specBeats });
    expect(recipe.totalDurationSec).toBe(10); // 3+4+3
  });
});

// ── adSetService variantBriefs preservation ─────────────────────────────────

jest.mock('../model/schema/studioJob', () => ({ create: jest.fn(async (d) => ({ ...d, _id: 'job-id-1', save: jest.fn() })), find: jest.fn(), findById: jest.fn(), findByIdAndUpdate: jest.fn(async () => ({})) }));
jest.mock('../services/queues', () => ({ enqueueStudioJob: jest.fn(async () => ({})) }));
jest.mock('../services/creditsService', () => ({ getBalance: jest.fn(async () => 9999), quote: jest.fn(async () => 5), chargeForJob: jest.fn(async () => ({})) }));
jest.mock('../services/modelRouter', () => ({
  resolveModel: jest.fn(async () => ({ id: 'seedance-2.0', label: 'Seedance 2.0' })),
  route: jest.fn(async ({ referenceImageUrls, prompts, durationSec }) => ({ modelId: 'seedance-2.0', falModelId: 'bytedance/seedance-2.0/reference-to-video', input: { prompt: prompts.finalPrompt, image_urls: referenceImageUrls, duration: String(durationSec) } })),
  validateRequiredFields: jest.fn(),
}));
jest.mock('../services/intentEngine', () => ({
  classifyIntent: jest.fn(async () => ({ intent_type: 'ad_video', domain: 'beauty', is_commercial: true, gulf_relevant: true, confidence: 0.9 })),
  assembleContext: jest.fn(async () => ({ dna: {}, seasonal: null, gulfMod: null, brandKit: null, urlData: null })),
  buildVariants: jest.fn(({ n }) => Array.from({ length: n }, (_, i) => ({ variantIndex: i, finalPrompt: `Variant ${i} prompt`, negativePrompt: '', constraints: { lighting: 'soft_natural' }, promptMetadata: {} }))),
}));
jest.mock('../utils/assertPublicUrl', () => ({ assertPublicUrl: jest.fn() }));
jest.mock('../middelwares/studioIdentity', () => ({ getStudioSessionId: jest.fn(() => 'test-session') }));

describe('adSetService blueprint referenceImageUrls passthrough', () => {
  const { planAdSet } = require('../services/adSetService');

  test('planAdSet preserves referenceImageUrls in variantBriefs', async () => {
    const result = await planAdSet({
      prompt: 'Hook shot for Glam Secret',
      kind: 'video',
      numVariants: 2,
      variantBlueprints: [
        { prompt: 'Hook: skin secret nobody knows', referenceImageUrls: ['https://cdn.example.com/ref1.jpg', 'https://cdn.example.com/product.jpg'], userCopy: 'Secret nobody knows', durationSec: 3 },
        { prompt: 'CTA: shop now at glamSecret.ae', referenceImageUrls: ['https://cdn.example.com/ref2.jpg'], userCopy: 'Shop now 30% off', durationSec: 3 },
      ],
    });

    const brief0 = result.variantBriefs[0];
    const brief1 = result.variantBriefs[1];

    expect(brief0.referenceImageUrls).toEqual(['https://cdn.example.com/ref1.jpg', 'https://cdn.example.com/product.jpg']);
    expect(brief1.referenceImageUrls).toEqual(['https://cdn.example.com/ref2.jpg']);
  });

  test('planAdSet preserves userCopy in variantBriefs', async () => {
    const result = await planAdSet({
      prompt: 'Ad brief',
      kind: 'video',
      numVariants: 2,
      variantBlueprints: [
        { prompt: 'Hook shot', userCopy: 'Secret nobody knows', referenceImageUrls: [] },
        { prompt: 'CTA shot', userCopy: 'Shop now', referenceImageUrls: [] },
      ],
    });

    expect(result.variantBriefs[0].userCopy).toBe('Secret nobody knows');
    expect(result.variantBriefs[1].userCopy).toBe('Shop now');
  });

  test('planAdSet preserves per-beat durationSec in variantBriefs', async () => {
    const result = await planAdSet({
      prompt: 'Ad brief',
      kind: 'video',
      numVariants: 2,
      variantBlueprints: [
        { prompt: 'Hook shot', durationSec: 3, referenceImageUrls: [] },
        { prompt: 'Problem shot', durationSec: 5, referenceImageUrls: [] },
      ],
    });

    expect(result.variantBriefs[0].durationSec).toBe(3);
    expect(result.variantBriefs[1].durationSec).toBe(5);
  });
});
