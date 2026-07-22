/**
 * promptIntelligence.test.js
 *
 * Locks in the contract between the studio controller, adBrain (industry
 * DNA), promptBuilder_v2 (template blueprints + cinematic constraints),
 * and promptRefiner (Claude-powered prompt mutation).
 *
 * These tests exist because of three regressions that bit production:
 *   1. `category: 'general'` crashed adBrain (no DNA entry).
 *   2. The video worker rebuilt prompts on every job, throwing away
 *      template blueprints and "normal-mode" user prompts.
 *   3. Refinement was creating new jobs without inheriting the
 *      promptPipeline metadata, so the Library page lost lineage.
 *
 * No network calls — Anthropic is mocked.
 */

process.env.ANTHROPIC_API_KEY = 'test_anthropic_key_mock';

// ── Mock Anthropic SDK ─────────────────────────────────────────────────────
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }));
});

const adBrain = require('../services/adBrain');
const promptBuilder = require('../services/promptBuilder_v2');
const promptRefiner = require('../services/promptRefiner');

describe('adBrain.buildAdPrompt', () => {
  it('uses NEUTRAL_DNA when the category is unknown / "general"', () => {
    const built = adBrain.buildAdPrompt({
      category: 'general',
      description: 'a calm rooftop sunset over Dubai marina',
      locale: 'gulf',
    });

    expect(built.finalPrompt).toBeDefined();
    expect(built.finalPrompt.length).toBeGreaterThan(50);
    expect(built.finalPrompt).toMatch(/cinematic/i);
    expect(built.promptMetadata).toMatchObject({
      category: 'general',
      neutral: true,
    });
    expect(built.negativePrompt).toMatch(/lowres|cartoon|watermark/);
  });

  it('omits brand framing when no brandName is provided', () => {
    const built = adBrain.buildAdPrompt({
      category: 'general',
      description: 'a person reading a book on a bench',
      locale: 'gulf',
    });
    // No brand name → no "Brand "" or "BRAND:" cargo-culted into the prompt.
    expect(built.finalPrompt).not.toMatch(/Brand\s+""/);
    expect(built.finalPrompt).not.toMatch(/BRAND:/);
  });

  it('uses the registered DNA when a known category is supplied', () => {
    const built = adBrain.buildAdPrompt({
      category: 'gym',
      brandName: 'IronHouse',
      description: '6am barbell session',
      locale: 'gulf',
      vibe: 'bold',
    });
    expect(built.finalPrompt).toMatch(/IronHouse/);
    expect(built.promptMetadata.category).toBe('gym');
    expect(built.promptMetadata.neutral).toBe(false);
  });
});

describe('promptBuilder_v2.renderConstraintsClause', () => {
  it('renders an empty string for no/empty constraints', () => {
    expect(promptBuilder.renderConstraintsClause()).toBe('');
    expect(promptBuilder.renderConstraintsClause({})).toBe('');
    expect(promptBuilder.renderConstraintsClause({ cameraAngle: 'unknown_value' })).toBe('');
  });

  it('renders a Direction clause for known constraint values', () => {
    const clause = promptBuilder.renderConstraintsClause({
      cameraAngle: 'low_angle',
      lighting: 'golden_hour',
      motion: 'slow_push',
    });
    expect(clause).toMatch(/Direction:/);
    expect(clause).toMatch(/low-angle/);
    expect(clause).toMatch(/golden-hour/);
    expect(clause).toMatch(/push-in/);
  });
});

describe('promptBuilder_v2.buildFromTemplate', () => {
  const baseTemplate = {
    _id: 'tpl_test',
    promptBlueprint:
      '{product_image} A cinematic 5-second hero shot for {brand_name}. {hook_line}. {cta_line}.',
    bestCategories: ['gym'],
    outputType: 'video',
    aspectRatio: '9:16',
  };

  it('substitutes injection tokens and appends gulf + quality clauses', () => {
    const out = promptBuilder.buildFromTemplate(baseTemplate, {
      brandName: 'NovaGym',
      productImageUrl: 'https://cdn.qumak.com/p.png',
      hookLine: 'Push past zero.',
      ctaLine: 'Join the 5am Club',
      locale: 'gulf',
    });
    expect(out.finalPrompt).toMatch(/NovaGym/);
    expect(out.finalPrompt).toMatch(/Push past zero/);
    expect(out.finalPrompt).toMatch(/Join the 5am Club/);
    expect(out.finalPrompt).not.toMatch(/\{[a-z_]+\}/);
    expect(out.finalPrompt).toMatch(/Visual style/);
    expect(out.finalPrompt).toMatch(/Professional advertising quality/);
  });

  it('supports stacked cinematic constraints from the user', () => {
    const out = promptBuilder.buildFromTemplate(baseTemplate, {
      brandName: 'NovaGym',
      constraints: { lighting: 'low_key_moody', motion: 'orbit' },
    });
    expect(out.finalPrompt).toMatch(/low-key moody/);
    expect(out.finalPrompt).toMatch(/orbit/);
  });
});

describe('promptRefiner.refinePrompt', () => {
  beforeEach(() => mockAnthropicCreate.mockReset());

  it('returns the refined prompt + change summary from Claude', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          text:
            'A neon-lit nighttime rooftop scene over Dubai Marina, anamorphic lens, soft cyan rim light.\n' +
            'CHANGES: shifted from golden hour to neon night palette',
        },
      ],
    });

    const out = await promptRefiner.refinePrompt({
      originalPrompt: 'A calm rooftop sunset over Dubai Marina.',
      instruction: 'make it look like a Blade Runner night scene',
      category: 'general',
      locale: 'gulf',
    });

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(out.refinedPrompt).toMatch(/neon/i);
    expect(typeof out.changes).toBe('string');
    expect(out.changes).toMatch(/night|neon/i);
  });

  it('throws when the model returns a useless / too-short reply', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: 'no.' }],
    });
    await expect(
      promptRefiner.refinePrompt({
        originalPrompt: 'A scene.',
        instruction: 'change it',
      })
    ).rejects.toThrow(/too short|model error/);
  });
});
