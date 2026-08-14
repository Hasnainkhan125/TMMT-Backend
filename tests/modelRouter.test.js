'use strict';

/**
 * modelRouter — unit tests for the capability-driven payload builder and
 * the strict resolveModel behaviour added in Phase 1.
 *
 * We avoid DB/mongoose here by testing the pure functions directly.
 */

const {
  buildProviderInput,
  validateRequiredFields,
  snapDurationToSupported,
  validateAspectRatio,
  validateAudioForModel,
} = require('../services/modelRouter');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FLUX_SCHNELL = {
  id: 'flux_schnell',
  label: 'Flux Schnell',
  provider: 'fal',
  falModelId: 'fal-ai/flux/schnell',
  kind: 'image',
  capabilities: {
    supportsEndFrame: false,
    supportsMotionControl: false,
    providerParamMap: {
      referenceImageUrl: 'image_url',
      endFrameUrl: 'end_image_url',
      duration: 'duration',
      motion: 'motion_bucket_id',
      negativePrompt: 'negative_prompt',
    },
    requiredFields: [],
  },
};

const NANO_PRO_EDIT = {
  id: 'nano_banana_pro_edit',
  label: 'Nano Banana Pro · Edit',
  provider: 'fal',
  falModelId: 'fal-ai/nano-banana-pro/edit',
  kind: 'image',
  capabilities: {
    providerParamMap: {
      // Array-style reference key — key ends in "s" so buildProviderInput
      // must wrap the single URL in a 1-element array.
      referenceImageUrl: 'image_urls',
      endFrameUrl: 'end_image_url',
      duration: 'duration',
      motion: 'motion_bucket_id',
      negativePrompt: 'negative_prompt',
    },
    requiredFields: ['referenceImageUrl'],
  },
};

const KLING_I2V = {
  id: 'kling_v3_pro',
  label: 'Kling 3.0 Pro',
  provider: 'fal',
  falModelId: 'fal-ai/kling-video/v3/pro/image-to-video',
  falVideoModelId: 'fal-ai/kling-video/v3/pro/image-to-video',
  kind: 'video',
  capabilities: {
    supportsEndFrame: false,
    supportsMotionControl: true,
    supportsNegativePrompt: true,
    providerParamMap: {
      referenceImageUrl: 'image_url',
      endFrameUrl: 'end_image_url',
      duration: 'duration',
      motion: 'motion_bucket_id',
      negativePrompt: 'negative_prompt',
    },
    requiredFields: ['referenceImageUrl'],
  },
};

const SEEDANCE_I2V = {
  id: 'seedance_2_0_i2v',
  label: 'Seedance 2.0 · i2v',
  provider: 'fal',
  falModelId: 'fal-ai/bytedance/seedance-2.0/image-to-video',
  falVideoModelId: 'fal-ai/bytedance/seedance-2.0/image-to-video',
  kind: 'video',
  capabilities: {
    supportsEndFrame: true,
    supportsMotionControl: true,
    supportsNegativePrompt: true,
    providerParamMap: {
      referenceImageUrl: 'image_url',
      endFrameUrl: 'end_image_url',
      duration: 'duration',
      motion: 'motion_bucket_id',
      negativePrompt: 'negative_prompt',
    },
    requiredFields: ['referenceImageUrl'],
  },
};

// ─── buildProviderInput ─────────────────────────────────────────────────────

describe('buildProviderInput — video native audio', () => {
  test('sets generate_audio when model supports native audio', () => {
    const m = {
      ...SEEDANCE_I2V,
      supportsAudio: true,
      capabilities: {
        ...SEEDANCE_I2V.capabilities,
        audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
      },
    };
    const out = buildProviderInput({
      model: m,
      kind: 'video',
      prompt: 'test',
      negativePrompt: '',
      aspectRatio: '16:9',
      durationSec: 5,
      audio: { enabled: true, mode: 'native' },
    });
    expect(out.generate_audio).toBe(true);
  });
});

describe('buildProviderInput — image models', () => {
  test('flux schnell: no reference → plain text-to-image payload', () => {
    const out = buildProviderInput({
      model: FLUX_SCHNELL,
      kind: 'image',
      prompt: 'a blue cat',
      aspectRatio: '1:1',
    });
    expect(out).toMatchObject({
      prompt: 'a blue cat',
      num_images: 1,
      image_size: 'square_hd',
    });
    expect(out.image_url).toBeUndefined();
    expect(out.image_urls).toBeUndefined();
  });

  test('flux schnell: with reference → writes `image_url` (singular string)', () => {
    const out = buildProviderInput({
      model: FLUX_SCHNELL,
      kind: 'image',
      prompt: 'a blue cat',
      aspectRatio: '16:9',
      referenceImageUrl: 'https://cdn.qumak.io/a.jpg',
    });
    expect(out.image_url).toBe('https://cdn.qumak.io/a.jpg');
    expect(out.image_urls).toBeUndefined();
    expect(out.image_size).toBe('landscape_16_9');
  });

  test('nano pro edit: writes `image_urls` as a 1-element array', () => {
    const out = buildProviderInput({
      model: NANO_PRO_EDIT,
      kind: 'image',
      prompt: 'replace background with beach',
      aspectRatio: '3:4',
      referenceImageUrl: 'https://cdn.qumak.io/product.jpg',
    });
    expect(Array.isArray(out.image_urls)).toBe(true);
    expect(out.image_urls).toEqual(['https://cdn.qumak.io/product.jpg']);
    expect(out.image_url).toBeUndefined();
  });
});

describe('buildProviderInput — video models', () => {
  test('kling i2v: honours reference, drops end-frame (not supported)', () => {
    const out = buildProviderInput({
      model: KLING_I2V,
      kind: 'video',
      prompt: 'pan across the skyline',
      negativePrompt: 'blurry',
      aspectRatio: '9:16',
      durationSec: 5,
      referenceImageUrl: 'https://cdn.qumak.io/s.jpg',
      endFrameUrl: 'https://cdn.qumak.io/e.jpg',   // should be silently dropped
      motion: 'dynamic',
    });
    expect(out.image_url).toBe('https://cdn.qumak.io/s.jpg');
    expect(out.end_image_url).toBeUndefined();     // capability gate
    expect(out.negative_prompt).toBe('blurry');
    expect(out.duration).toBe('5');
    expect(out.aspect_ratio).toBe('9:16');
    expect(out.motion_bucket_id).toBe(160);        // motionToBucket('dynamic')
  });

  test('seedance i2v: honours both start AND end frames', () => {
    const out = buildProviderInput({
      model: SEEDANCE_I2V,
      kind: 'video',
      prompt: 'product rotation',
      aspectRatio: '1:1',
      durationSec: 10,
      referenceImageUrl: 'https://cdn.qumak.io/start.jpg',
      endFrameUrl: 'https://cdn.qumak.io/end.jpg',
      motion: 'gentle',
    });
    expect(out.image_url).toBe('https://cdn.qumak.io/start.jpg');
    expect(out.end_image_url).toBe('https://cdn.qumak.io/end.jpg');
    expect(out.duration).toBe('10');
    expect(out.motion_bucket_id).toBe(90);         // motionToBucket('gentle')
  });

  test('motion field ignored when model doesn\'t support motion control', () => {
    const noMotion = {
      ...KLING_I2V,
      capabilities: { ...KLING_I2V.capabilities, supportsMotionControl: false },
    };
    const out = buildProviderInput({
      model: noMotion,
      kind: 'video',
      prompt: 'x',
      aspectRatio: '16:9',
      durationSec: 5,
      referenceImageUrl: 'https://cdn.qumak.io/s.jpg',
      motion: 'dynamic',
    });
    expect(out.motion_bucket_id).toBeUndefined();
  });
});

// ─── validateRequiredFields ─────────────────────────────────────────────────

describe('validateRequiredFields', () => {
  test('passes when required fields are present', () => {
    expect(() =>
      validateRequiredFields(KLING_I2V, {
        referenceImageUrl: 'https://cdn.qumak.io/s.jpg',
      }),
    ).not.toThrow();
  });

  test('throws a specific, human error when required field missing', () => {
    let thrown;
    try {
      validateRequiredFields(KLING_I2V, {
        referenceImageUrl: '',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('missing_required_field');
    expect(thrown.missing).toEqual(['referenceImageUrl']);
    expect(thrown.modelId).toBe('kling_v3_pro');
    expect(thrown.message).toMatch(/reference image/i);
    expect(thrown.message).toMatch(/Kling 3\.0 Pro/);
  });

  test('no requiredFields → nothing to validate', () => {
    expect(() =>
      validateRequiredFields(FLUX_SCHNELL, {}),
    ).not.toThrow();
  });

  test('treats empty array as missing', () => {
    const modelWithArrayReq = {
      ...NANO_PRO_EDIT,
      capabilities: {
        ...NANO_PRO_EDIT.capabilities,
        requiredFields: ['referenceImageUrl'],
      },
    };
    expect(() =>
      validateRequiredFields(modelWithArrayReq, { referenceImageUrl: [] }),
    ).toThrow(/missing_required_field|requires/);
  });
});

describe('snapDurationToSupported', () => {
  test('no supported list → pass through rounded', () => {
    expect(snapDurationToSupported(7, null)).toEqual({ durationSec: 7, adjusted: false });
  });
  test('exact match', () => {
    expect(snapDurationToSupported(5, [5, 10])).toEqual({ durationSec: 5, adjusted: false });
  });
  test('snap to nearest (7 → 5 vs [5,10])', () => {
    expect(snapDurationToSupported(7, [5, 10])).toMatchObject({
      durationSec: 5,
      adjusted: true,
      requestedDurationSec: 7,
    });
  });
});

describe('validateAspectRatio', () => {
  test('wildcard * allows any ratio', () => {
    expect(() =>
      validateAspectRatio(
        { id: 'm', label: 'M', supportedAspectRatios: ['*'] },
        '21:9',
      ),
    ).not.toThrow();
  });
  test('empty list → no validation', () => {
    expect(() => validateAspectRatio({ id: 'm', supportedAspectRatios: [] }, '16:9')).not.toThrow();
  });
  test('throws invalid_aspect_ratio when not listed', () => {
    let thrown;
    try {
      validateAspectRatio(
        { id: 'm', label: 'Model M', supportedAspectRatios: ['1:1'] },
        '16:9',
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown.code).toBe('invalid_aspect_ratio');
    expect(thrown.suggestedAspectRatios).toEqual(['1:1']);
  });
});

describe('validateAudioForModel', () => {
  test('native audio rejected when model does not support', () => {
    expect(() =>
      validateAudioForModel(
        { id: 'x', label: 'X', supportsAudio: false, capabilities: {} },
        { enabled: true, mode: 'native' },
      ),
    ).toThrow(/native audio/i);
  });
  test('native allowed when supportsAudio true', () => {
    expect(() =>
      validateAudioForModel(
        { id: 'x', label: 'X', supportsAudio: true },
        { enabled: true, mode: 'native' },
      ),
    ).not.toThrow();
  });
  test('disabled audio → no-op', () => {
    expect(() =>
      validateAudioForModel({ id: 'x', supportsAudio: false }, { enabled: false }),
    ).not.toThrow();
  });
});
