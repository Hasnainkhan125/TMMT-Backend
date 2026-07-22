/**
 * Phase 3 — Director-rail vocabulary tests.
 *
 * Exercises `renderConstraintsClause` directly so we can prove:
 *   1. Legacy axis IDs still resolve (backward compat).
 *   2. New axes (mood, tone, timeOfDay, environment) resolve.
 *   3. FE-aligned additions (birds_eye, gimbal, closeup, etc) resolve.
 *   4. styleTags[] renders as a separate `Style:` clause.
 *   5. Unknown IDs are silently dropped, not crashed on.
 *   6. Output ordering is stable regardless of input key order.
 */

const {
  renderConstraintsClause,
  CONSTRAINT_VOCAB,
  STYLE_TAG_VOCAB,
  CONSTRAINT_AXES,
} = require('../services/constraintRender');

describe('renderConstraintsClause — Director brief vocabulary', () => {
  test('empty / null input → empty string (no-op, safe for default call)', () => {
    expect(renderConstraintsClause()).toBe('');
    expect(renderConstraintsClause({})).toBe('');
    expect(renderConstraintsClause(null)).toBe('');
    expect(renderConstraintsClause(undefined)).toBe('');
  });

  test('legacy 5-axis set still renders (backward compat)', () => {
    const clause = renderConstraintsClause({
      cameraAngle: 'eye_level',
      lighting:    'golden_hour',
      shotType:    'medium',
      motion:      'slow_push',
      pace:        'snappy',
    });
    expect(clause).toMatch(/^\nDirection: /);
    expect(clause).toContain('eye-level camera angle');
    expect(clause).toContain('golden-hour');
    expect(clause).toContain('medium shot');
    expect(clause).toContain('slow cinematic push-in');
    expect(clause).toContain('snappy TikTok-native pacing');
  });

  test('FE-aligned IDs that previously silently dropped now render', () => {
    const clause = renderConstraintsClause({
      cameraAngle: 'birds_eye',
      shotType:    'closeup',
      lighting:    'neon',
      motion:      'gimbal',
      pace:        'fast',
    });
    expect(clause).toContain('bird');
    expect(clause).toContain('close-up');
    expect(clause).toContain('neon');
    expect(clause).toContain('gimbal');
    expect(clause).toContain('fast');
  });

  test('Phase-3 axes (mood, tone, timeOfDay, environment) resolve', () => {
    const clause = renderConstraintsClause({
      mood:        'triumphant',
      tone:        'editorial',
      timeOfDay:   'golden_hour',
      environment: 'marina',
    });
    expect(clause).toContain('triumphant');
    expect(clause).toContain('editorial');
    expect(clause).toContain('golden hour');
    expect(clause).toContain('Marina');
  });

  test('styleTags render as a separate Style clause', () => {
    const clause = renderConstraintsClause({
      cameraAngle: 'low_angle',
      styleTags:   ['cinematic', 'grainy_film'],
    });
    expect(clause).toMatch(/\nDirection: .+\n?Style: /);
    expect(clause).toContain('cinematic');
    expect(clause).toContain('grainy 35mm film texture');
  });

  test('styleTags-only input renders without a Direction clause', () => {
    const clause = renderConstraintsClause({
      styleTags: ['editorial', 'hyper_realistic'],
    });
    expect(clause).not.toMatch(/Direction:/);
    expect(clause).toMatch(/^\nStyle: /);
    expect(clause).toContain('editorial');
    expect(clause).toContain('hyper-realistic');
  });

  test('unknown IDs are silently dropped, not crashed on', () => {
    const clause = renderConstraintsClause({
      cameraAngle: 'totally_bogus_angle',
      lighting:    'cinematic',
      mood:        'completely_made_up',
      styleTags:   ['not_real_tag', 'cinematic'],
    });
    expect(clause).toContain('cinematic');
    expect(clause).not.toContain('totally_bogus_angle');
    expect(clause).not.toContain('completely_made_up');
    expect(clause).not.toContain('not_real_tag');
  });

  test('output ordering is stable regardless of input key order', () => {
    const input = {
      tone:        'luxury',
      cameraAngle: 'eye_level',
      environment: 'studio',
      styleTags:   ['cinematic'],
      lighting:    'cinematic',
      mood:        'confident',
      shotType:    'medium',
      timeOfDay:   'golden_hour',
    };
    const a = renderConstraintsClause(input);
    // Reorder keys — output should be identical because we iterate
    // CONSTRAINT_AXES in a fixed order, not Object.keys(input).
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const b = renderConstraintsClause(reordered);
    expect(a).toBe(b);
  });

  test('canonical axis list matches declared vocab (registry drift guard)', () => {
    for (const axis of CONSTRAINT_AXES) {
      expect(CONSTRAINT_VOCAB[axis]).toBeDefined();
      expect(typeof CONSTRAINT_VOCAB[axis]).toBe('object');
      expect(Object.keys(CONSTRAINT_VOCAB[axis]).length).toBeGreaterThan(0);
    }
    // styleTags are rendered through STYLE_TAG_VOCAB, not CONSTRAINT_VOCAB.
    expect(Object.keys(STYLE_TAG_VOCAB).length).toBeGreaterThan(0);
  });

  test('partial input — one axis only — renders just that clause', () => {
    const clause = renderConstraintsClause({ mood: 'serene' });
    expect(clause).toBe('\nDirection: serene, calm, meditative mood.');
  });

  test('styleTags-only with empty array produces no clause', () => {
    const clause = renderConstraintsClause({ styleTags: [] });
    expect(clause).toBe('');
  });
});
