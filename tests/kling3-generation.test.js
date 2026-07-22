'use strict';

/**
 * kling3-generation.test.js
 *
 * Unit tests for all generation paths that touch the two Kling 3.0 models:
 *
 *   kling_v3_pro     — image-to-video  (fal-ai/kling-video/v3/pro/image-to-video)
 *   kling_o3_4k_ref2vid — ref-to-video (fal-ai/kling-video/o3/4k/reference-to-video)
 *
 * Tests are pure-function only (no DB / HTTP) matching the style established
 * in modelRouter.test.js.
 */

// modelRouter.js uses `export default {}` for the helper functions and a
// named `export function validateAgainstManifest`. Babel CJS transform puts
// default-exported members on `.default`, named exports at the top level.
const _mr = require('../services/modelRouter');
const {
  buildProviderInput,
  validateRequiredFields,
  snapDurationToSupported,
  validateAspectRatio,
  validateAudioForModel,
} = _mr.default;
const { validateAgainstManifest } = _mr;

// ─── Model fixtures (mirrors DB seed) ───────────────────────────────────────

const KLING_V3_PRO = {
  id: 'kling_v3_pro',
  label: 'Kling 3.0 Pro',
  provider: 'fal',
  falModelId: 'fal-ai/kling-video/v3/pro/image-to-video',
  falVideoModelId: 'fal-ai/kling-video/v3/pro/image-to-video',
  kind: 'video',
  supportsAudio: false,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  supportedDurations: [5, 10],
  capabilities: {
    supportsEndFrame: true,
    supportsMotionControl: false,
    requiredFields: ['referenceImageUrl'],
    providerParamMap: {
      referenceImageUrl: 'image_url',
      endFrameUrl: 'end_image_url',
      duration: 'duration',
      motion: 'motion_bucket_id',
      negativePrompt: 'negative_prompt',
    },
  },
};

// Kling O3 4K ref2vid — capabilities exactly as seeded in
// seedAiModels_capabilities_final.js. No required fields; either prompt
// OR multiPrompt; elements + refImages ≤ 7.
const KLING_O3_CAPABILITIES = {
  uiVariant: 'ref2v_elements',
  inputSlots: [
    { key: 'elements',    type: 'element_array', required: false },
    { key: 'refImages',   type: 'image_array',   required: false },
    { key: 'startFrame',  type: 'image',          required: false },
    { key: 'endFrame',    type: 'image',          required: false },
    { key: 'prompt',      type: 'string',         required: false },
    { key: 'multiPrompt', type: 'string_array_with_duration', required: false },
    { key: 'aspectRatio', type: 'enum',           required: false, default: '16:9' },
    { key: 'durationSec', type: 'enum',           required: false, default: '5' },
    { key: 'generateAudio', type: 'boolean',      required: false, default: false },
  ],
  constraints: [
    {
      type: 'sum_max',
      fields: ['elements', 'refImages'],
      value: 7,
      message: 'Elements + reference images cannot exceed 7 combined',
    },
    {
      type: 'requires_one_of',
      fields: ['prompt', 'multiPrompt'],
      message: 'Provide either a prompt or multi-shot prompts',
    },
    {
      type: 'mutual_exclusive',
      fields: ['prompt', 'multiPrompt'],
      message: 'Cannot use both prompt and multi-shot prompts — choose one',
    },
  ],
};

const KLING_O3_REF2VID = {
  id: 'kling_o3_4k_ref2vid',
  label: 'Kling O3 4K',
  provider: 'fal',
  falVideoModelId: 'fal-ai/kling-video/o3/4k/reference-to-video',
  kind: 'video',
  supportsAudio: false,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  supportedDurations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  capabilities: KLING_O3_CAPABILITIES,
};

// ─── buildProviderInput — Kling 3.0 Pro (i2v) ────────────────────────────────

describe('buildProviderInput — kling_v3_pro (image-to-video)', () => {
  const BASE = {
    model: KLING_V3_PRO,
    kind: 'video',
    prompt: 'product rotating on marble surface',
    negativePrompt: 'blur, shaky',
    aspectRatio: '16:9',
    durationSec: 5,
    referenceImageUrl: 'https://cdn.qumak.io/product.jpg',
  };

  test('writes image_url from referenceImageUrl (singular string key)', () => {
    const out = buildProviderInput(BASE);
    expect(out.image_url).toBe('https://cdn.qumak.io/product.jpg');
    expect(out.image_urls).toBeUndefined();
  });

  test('writes end_image_url when endFrameUrl provided (supportsEndFrame = true)', () => {
    const out = buildProviderInput({ ...BASE, endFrameUrl: 'https://cdn.qumak.io/end.jpg' });
    expect(out.end_image_url).toBe('https://cdn.qumak.io/end.jpg');
  });

  test('omits end_image_url when endFrameUrl is absent', () => {
    const out = buildProviderInput(BASE);
    expect(out.end_image_url).toBeUndefined();
  });

  test('duration is coerced to string', () => {
    const out = buildProviderInput({ ...BASE, durationSec: 10 });
    expect(out.duration).toBe('10');
  });

  test('negative_prompt written under correct provider key', () => {
    const out = buildProviderInput(BASE);
    expect(out.negative_prompt).toBe('blur, shaky');
  });

  test('aspect_ratio forwarded verbatim', () => {
    const out = buildProviderInput({ ...BASE, aspectRatio: '9:16' });
    expect(out.aspect_ratio).toBe('9:16');
  });

  test('motion_bucket_id OMITTED — model does not support motion control', () => {
    const out = buildProviderInput({ ...BASE, motion: 'dynamic' });
    expect(out.motion_bucket_id).toBeUndefined();
  });

  test('generate_audio NOT set when audio is disabled', () => {
    const out = buildProviderInput({ ...BASE, audio: { enabled: false } });
    expect(out.generate_audio).toBeUndefined();
  });

  test('generate_audio NOT set when model does not support native audio', () => {
    const out = buildProviderInput({ ...BASE, audio: { enabled: true, mode: 'native' } });
    // supportsAudio: false → audio block skipped entirely
    expect(out.generate_audio).toBeUndefined();
  });
});

// ─── validateRequiredFields — Kling 3.0 Pro ──────────────────────────────────

describe('validateRequiredFields — kling_v3_pro', () => {
  test('passes when referenceImageUrl is provided', () => {
    expect(() =>
      validateRequiredFields(KLING_V3_PRO, {
        referenceImageUrl: 'https://cdn.qumak.io/product.jpg',
      }),
    ).not.toThrow();
  });

  test('throws missing_required_field when referenceImageUrl is absent', () => {
    let thrown;
    try {
      validateRequiredFields(KLING_V3_PRO, { referenceImageUrl: '' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('missing_required_field');
    expect(thrown.missing).toContain('referenceImageUrl');
    expect(thrown.modelId).toBe('kling_v3_pro');
    expect(thrown.message).toMatch(/Kling 3\.0 Pro/);
    expect(thrown.message).toMatch(/reference image/i);
  });

  test('throws missing_required_field when referenceImageUrl is undefined', () => {
    expect(() =>
      validateRequiredFields(KLING_V3_PRO, {}),
    ).toThrow(/missing_required_field|requires/);
  });

  test('throws when referenceImageUrl is an empty array', () => {
    expect(() =>
      validateRequiredFields(KLING_V3_PRO, { referenceImageUrl: [] }),
    ).toThrow();
  });
});

// ─── validateAspectRatio — Kling 3.0 Pro ─────────────────────────────────────

describe('validateAspectRatio — kling_v3_pro', () => {
  test.each(['16:9', '9:16', '1:1'])('accepts %s', (ratio) => {
    expect(() => validateAspectRatio(KLING_V3_PRO, ratio)).not.toThrow();
  });

  test('rejects unsupported ratio (21:9)', () => {
    let thrown;
    try {
      validateAspectRatio(KLING_V3_PRO, '21:9');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('invalid_aspect_ratio');
    expect(thrown.suggestedAspectRatios).toEqual(['16:9', '9:16', '1:1']);
    expect(thrown.modelId).toBe('kling_v3_pro');
  });

  test('rejects 4:3 (not in Kling 3.0 matrix)', () => {
    expect(() => validateAspectRatio(KLING_V3_PRO, '4:3')).toThrow();
  });
});

// ─── snapDurationToSupported — Kling 3.0 Pro [5, 10] ─────────────────────────

describe('snapDurationToSupported — kling_v3_pro durations [5, 10]', () => {
  const supported = KLING_V3_PRO.supportedDurations;

  test('5s — exact match, no adjustment', () => {
    expect(snapDurationToSupported(5, supported)).toEqual({ durationSec: 5, adjusted: false });
  });

  test('10s — exact match, no adjustment', () => {
    expect(snapDurationToSupported(10, supported)).toEqual({ durationSec: 10, adjusted: false });
  });

  test('7s — ties between 5 and 10 → snaps to shorter (5)', () => {
    const result = snapDurationToSupported(7, supported);
    expect(result.durationSec).toBe(5);
    expect(result.adjusted).toBe(true);
    expect(result.requestedDurationSec).toBe(7);
  });

  test('8s — closer to 10, snaps to 10', () => {
    const result = snapDurationToSupported(8, supported);
    expect(result.durationSec).toBe(10);
    expect(result.adjusted).toBe(true);
  });

  test('3s — snaps to 5 (smallest supported)', () => {
    const result = snapDurationToSupported(3, supported);
    expect(result.durationSec).toBe(5);
    expect(result.adjusted).toBe(true);
  });

  test('15s — snaps to 10 (largest supported)', () => {
    const result = snapDurationToSupported(15, supported);
    expect(result.durationSec).toBe(10);
    expect(result.adjusted).toBe(true);
  });
});

// ─── validateAudioForModel — Kling 3.0 Pro (no native audio) ─────────────────

describe('validateAudioForModel — kling_v3_pro', () => {
  test('audio disabled → no-op', () => {
    expect(() =>
      validateAudioForModel(KLING_V3_PRO, { enabled: false }),
    ).not.toThrow();
  });

  test('native audio enabled → sets _skipped flag (no throw, but audio is silently dropped)', () => {
    const audio = { enabled: true, mode: 'native' };
    expect(() => validateAudioForModel(KLING_V3_PRO, audio)).not.toThrow();
    expect(audio._skipped).toBe(true);
  });

  test('no audio arg → no-op', () => {
    expect(() => validateAudioForModel(KLING_V3_PRO, null)).not.toThrow();
  });
});

// ─── validateAgainstManifest — Kling O3 4K ref2vid ───────────────────────────

describe('validateAgainstManifest — kling_o3_4k_ref2vid', () => {
  const caps = KLING_O3_CAPABILITIES;

  // Prompt-only valid submission
  test('prompt only → valid', () => {
    const result = validateAgainstManifest(caps, { prompt: 'A product shot' });
    expect(result.ok).toBe(true);
    expect(result.globalErrors).toHaveLength(0);
  });

  // Multi-shot only valid submission
  test('multiPrompt only → valid', () => {
    const result = validateAgainstManifest(caps, {
      multiPrompt: [
        { prompt: 'Intro shot', duration: '3' },
        { prompt: 'Product close-up', duration: '5' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  // Neither provided
  test('no prompt and no multiPrompt → invalid (requires_one_of)', () => {
    const result = validateAgainstManifest(caps, {
      elements: [],
      refImages: [],
    });
    expect(result.ok).toBe(false);
    expect(result.globalErrors.some(e => /prompt/i.test(e))).toBe(true);
  });

  // Both provided (mutual_exclusive violation)
  test('both prompt and multiPrompt → invalid (mutual_exclusive)', () => {
    const result = validateAgainstManifest(caps, {
      prompt: 'Some prompt',
      multiPrompt: [{ prompt: 'Shot 1', duration: '5' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.prompt || result.errors.multiPrompt).toBeTruthy();
  });

  // sum_max: elements + refImages within limit
  test('4 elements + 3 refImages = 7 → valid (at limit)', () => {
    const result = validateAgainstManifest(caps, {
      prompt: 'A scene',
      elements: new Array(4).fill({ frontal: 'url' }),
      refImages: new Array(3).fill('url'),
    });
    expect(result.ok).toBe(true);
  });

  // sum_max: exceeded
  test('5 elements + 3 refImages = 8 → invalid (sum_max exceeded)', () => {
    const result = validateAgainstManifest(caps, {
      prompt: 'A scene',
      elements: new Array(5).fill({ frontal: 'url' }),
      refImages: new Array(3).fill('url'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.elements || result.errors.refImages).toBeTruthy();
  });

  // Elements only (no refs) — valid as long as prompt present
  test('prompt + elements only (no refImages) → valid', () => {
    const result = validateAgainstManifest(caps, {
      prompt: 'Character scene',
      elements: [{ frontal: 'url' }],
    });
    expect(result.ok).toBe(true);
  });

  // Start/end frames with prompt — valid
  test('prompt + startFrame + endFrame → valid', () => {
    const result = validateAgainstManifest(caps, {
      prompt: 'Transition shot',
      startFrame: 'https://cdn.qumak.io/start.jpg',
      endFrame: 'https://cdn.qumak.io/end.jpg',
    });
    expect(result.ok).toBe(true);
  });
});

// ─── validateAspectRatio — Kling O3 4K ref2vid ───────────────────────────────

describe('validateAspectRatio — kling_o3_4k_ref2vid', () => {
  test.each(['16:9', '9:16', '1:1'])('accepts %s', (ratio) => {
    expect(() => validateAspectRatio(KLING_O3_REF2VID, ratio)).not.toThrow();
  });

  test('rejects unsupported ratio (3:4)', () => {
    let thrown;
    try { validateAspectRatio(KLING_O3_REF2VID, '3:4'); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('invalid_aspect_ratio');
  });
});

// ─── snapDurationToSupported — Kling O3 4K [3..15] ───────────────────────────

describe('snapDurationToSupported — kling_o3_4k_ref2vid durations [3..15]', () => {
  const supported = KLING_O3_REF2VID.supportedDurations;

  test('5s → exact match', () => {
    expect(snapDurationToSupported(5, supported)).toEqual({ durationSec: 5, adjusted: false });
  });

  test('15s → exact match', () => {
    expect(snapDurationToSupported(15, supported)).toEqual({ durationSec: 15, adjusted: false });
  });

  test('1s (below minimum) → snaps to 3', () => {
    const result = snapDurationToSupported(1, supported);
    expect(result.durationSec).toBe(3);
    expect(result.adjusted).toBe(true);
  });

  test('20s (above maximum) → snaps to 15', () => {
    const result = snapDurationToSupported(20, supported);
    expect(result.durationSec).toBe(15);
    expect(result.adjusted).toBe(true);
  });
});
