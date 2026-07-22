'use strict';

/**
 * Quote parity: audio surcharge and (optional) margin floor behaviour.
 */

const AiModel = require('../model/schema/aiModel');
const creditsService = require('../services/creditsService');

describe('creditsService.quote — audio surcharge', () => {
  const mockModel = {
    id: 'parity_test_model',
    isActive: true,
    creditsPerImage: 2,
    baseCreditsForVideo: 1,
    creditsPerSecondVideo: 1,
    providerCostUsdEstimate: null,
  };

  beforeEach(() => {
    jest.spyOn(AiModel, 'findOne').mockImplementation(() => ({
      lean: () => Promise.resolve({ ...mockModel }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STUDIO_AUDIO_SURCHARGE_CREDITS;
  });

  test('video + enabled audio adds STUDIO_AUDIO_SURCHARGE_CREDITS', async () => {
    process.env.STUDIO_AUDIO_SURCHARGE_CREDITS = '3';
    const base = await creditsService.quote({
      modelId: 'parity_test_model',
      kind: 'video',
      durationSec: 5,
      variants: 1,
    });
    const withAudio = await creditsService.quote({
      modelId: 'parity_test_model',
      kind: 'video',
      durationSec: 5,
      variants: 1,
      audio: { enabled: true, mode: 'native' },
    });
    expect(withAudio).toBe(base + 3);
  });
});
