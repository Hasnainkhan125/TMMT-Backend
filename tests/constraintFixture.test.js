/**
 * CI/dev: one representative ID per scalar axis from the frontend vocabulary
 * (qumak-frontend/src/data/constraintVocab.ts) must render a non-empty clause.
 */

const { renderConstraintsClause, CONSTRAINT_VOCAB, STYLE_TAG_VOCAB } = require('../services/constraintRender');

/** Mirrors CONSTRAINT_OPTIONS — first option id per axis (smoke that FE picks resolve). */
const FE_REPRESENTATIVE_FIXTURE = {
  cameraAngle: 'eye_level',
  lighting: 'natural',
  shotType: 'extreme_closeup',
  motion: 'static',
  pace: 'slow',
  mood: 'warm',
  tone: 'luxury',
  timeOfDay: 'dawn',
  environment: 'studio',
  styleTags: ['cinematic'],
};

describe('constraintRender — FE vocabulary fixture', () => {
  test('every scalar axis id in fixture maps in CONSTRAINT_VOCAB', () => {
    const scalarAxes = [
      'cameraAngle',
      'lighting',
      'shotType',
      'motion',
      'pace',
      'mood',
      'tone',
      'timeOfDay',
      'environment',
    ];
    for (const axis of scalarAxes) {
      const id = FE_REPRESENTATIVE_FIXTURE[axis];
      expect(CONSTRAINT_VOCAB[axis]?.[id]).toBeTruthy();
    }
    for (const tag of FE_REPRESENTATIVE_FIXTURE.styleTags) {
      expect(STYLE_TAG_VOCAB[tag]).toBeTruthy();
    }
  });

  test('renderConstraintsClause(fixture) is non-empty Direction + Style', () => {
    const clause = renderConstraintsClause(FE_REPRESENTATIVE_FIXTURE);
    expect(clause).toContain('Direction:');
    expect(clause).toContain('Style:');
    expect(clause.length).toBeGreaterThan(50);
  });
});
