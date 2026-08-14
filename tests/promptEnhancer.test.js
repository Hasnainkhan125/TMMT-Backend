'use strict';

/**
 * Tests for promptEnhancer + adBrain "user prompt as foreground" behavior.
 *
 * The big regression we're guarding against: before this work, generating
 * an image with a free-form prompt like "a girl on a beach holding a
 * coconut" would route through adBrain.buildAdPrompt and the user's
 * prompt got buried into a tiny SCENE: clause underneath VISUAL WORLD,
 * CAMERA, and LIGHTING blocks. The model anchored on the boilerplate
 * and the girl + coconut would barely show up.
 *
 * These tests pin down the new contract:
 *   1. The user's concrete nouns survive enhancement.
 *   2. adBrain places the SCENE FIRST in token order.
 *   3. The deterministic fallback still produces a usable, vocabulary-rich
 *      prompt when Claude is unreachable.
 */

const adBrain = require('../services/adBrain');
const promptEnhancer = require('../services/promptEnhancer');

describe('adBrain.buildAdPrompt — user prompt anchors the scene', () => {
  test('places the user prompt FIRST in token order', () => {
    const { finalPrompt } = adBrain.buildAdPrompt({
      category: 'gym',
      brandName: 'Qumak',
      userPrompt: 'a woman lifting a barbell with chalk dust in the air',
      locale: 'gulf',
    });

    const sceneIdx = finalPrompt.indexOf('SCENE:');
    const worldIdx = finalPrompt.indexOf('WORLD:');
    const cameraIdx = finalPrompt.indexOf('CAMERA:');

    expect(sceneIdx).toBeGreaterThanOrEqual(0);
    expect(worldIdx).toBeGreaterThan(sceneIdx);
    expect(cameraIdx).toBeGreaterThan(sceneIdx);
  });

  test('the user prompt nouns are preserved in the final string', () => {
    const { finalPrompt } = adBrain.buildAdPrompt({
      category: 'general',
      userPrompt: 'a girl on a beach holding a coconut at sunset',
    });

    expect(finalPrompt).toMatch(/girl/);
    expect(finalPrompt).toMatch(/beach/);
    expect(finalPrompt).toMatch(/coconut/);
  });

  test('does NOT inject brand framing when no brandName is provided', () => {
    const { finalPrompt } = adBrain.buildAdPrompt({
      category: 'general',
      userPrompt: 'a quiet kitchen at dawn',
    });
    expect(finalPrompt).not.toMatch(/Brand "/);
  });

  test('does NOT add the old hardcoded "no text overlays" directive', () => {
    // Earlier this conflicted with prompts like "the word OPEN written
    // on the door". The negative prompt handles it now when appropriate.
    const { finalPrompt } = adBrain.buildAdPrompt({
      category: 'gym',
      brandName: 'Qumak',
      userPrompt: 'a sign that says "OPEN" on the gym door',
    });
    expect(finalPrompt).not.toMatch(/no text overlays/i);
    expect(finalPrompt).not.toMatch(/no logos in frame/i);
  });

  test('falls back to neutral DNA gracefully for unknown categories', () => {
    const { finalPrompt, promptMetadata } = adBrain.buildAdPrompt({
      category: 'totally-made-up',
      userPrompt: 'a sleeping cat in a sunbeam',
    });
    expect(finalPrompt).toMatch(/cat/);
    expect(promptMetadata.category).toBe('general');
    expect(promptMetadata.neutral).toBe(true);
  });
});

describe('promptEnhancer.deterministicEnrich (Claude-less path)', () => {
  test('keeps the user prompt as the first clause of the enriched output', () => {
    const out = promptEnhancer.deterministicEnrich({
      rawPrompt: 'a vintage red bicycle leaning on a Paris cafe',
      mode: 'normal',
      category: 'general',
    });
    expect(out.finalPrompt.startsWith('a vintage red bicycle')).toBe(true);
    expect(out.source).toBe('fallback');
  });

  test('emits a non-empty negative prompt suited to the mode', () => {
    const normal = promptEnhancer.deterministicEnrich({
      rawPrompt: 'an oud bottle on marble',
      mode: 'normal',
    });
    const business = promptEnhancer.deterministicEnrich({
      rawPrompt: 'an oud bottle on marble',
      mode: 'business',
    });

    expect(normal.negativePrompt.length).toBeGreaterThan(10);
    expect(business.negativePrompt).toMatch(/text overlays/);
    // Normal mode shouldn't add the "no text overlays" anti-pattern,
    // because creative users may legitimately want text on the image.
    expect(normal.negativePrompt).not.toMatch(/text overlays/);
  });

  test('chooses warm light vocabulary for luxury / perfume / realestate', () => {
    const out = promptEnhancer.deterministicEnrich({
      rawPrompt: 'a perfume bottle on a velvet pedestal',
      mode: 'normal',
      category: 'perfume',
    });
    expect(out.finalPrompt).toMatch(/golden-hour|honeyed|warm/);
  });
});

describe('promptEnhancer.enhancePrompt (no API key path)', () => {
  const KEY = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    // Force the no-key branch so this test is deterministic in CI.
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(() => {
    if (KEY) process.env.ANTHROPIC_API_KEY = KEY;
  });

  test('returns the deterministic fallback when no API key is set', async () => {
    const out = await promptEnhancer.enhancePrompt({
      rawPrompt: 'a dog wearing sunglasses on a skateboard',
      mode: 'normal',
    });
    expect(out.source).toBe('fallback');
    expect(out.finalPrompt).toMatch(/dog/);
    expect(out.finalPrompt).toMatch(/skateboard/);
    expect(out.negativePrompt.length).toBeGreaterThan(0);
  });

  test('returns empty strings for empty input (controller decides default)', async () => {
    const out = await promptEnhancer.enhancePrompt({ rawPrompt: '   ' });
    expect(out.finalPrompt).toBe('');
    expect(out.negativePrompt).toBe('');
  });
});
