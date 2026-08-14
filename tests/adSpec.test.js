'use strict';
/* Battle-test the ad-spec contract end to end, offline (no LLM, no DB). */

const assert = require('assert');
const {
  createDraftSpec, validateSpec, isConfirmable, adSpecToRecipeOpts,
  specFromScan, AD_STRUCTURES, makeBeat,
} = require('../services/adSpec/adSpec');
const {
  teardownToSpec, regenerateCopy, heuristicClassify, coerceClassification,
} = require('../services/adSpec/adSpecTeardown');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓', name); };

// Fake scan matching your UrlToAdsScan shape
const fakeScan = {
  _id: 'scan123',
  brand: { name: 'GlamSecret', category: 'skincare', images: ['https://cdn/x/product.png'], logoUrl: 'https://cdn/x/logo.png' },
  brandPalette: { swatches: [{ hex: '#C9A227' }, { hex: '#0B1F3B' }, { hex: '#e040a0' }] },
  confirmedBrand: { name: 'GlamSecret', category: 'Skincare', palette: ['#C9A227', '#0B1F3B'] },
  apifyData: { competitorAds: [{ ads: [{ intelligence: { primaryAngle: 'Glow in 7 days' } }] }] },
};

console.log('1. Draft creation + defaults');
ok('createDraftSpec yields a confirmable-shaped draft', () => {
  const s = createDraftSpec({ scanId: 's1', product: { url: 'https://cdn/p.png' } });
  assert.strictEqual(s.status, 'draft');
  assert.ok(s.beats.length >= 2);
  assert.ok(s.beats.every((b) => b.id && b.role && b.durationSec >= 3 && b.durationSec <= 5));
  assert.ok(AD_STRUCTURES.includes(s.structure));
});

ok('every structure produces valid default beats', () => {
  AD_STRUCTURES.forEach((st) => {
    const s = createDraftSpec({ structure: st, product: { url: 'u' } });
    assert.strictEqual(validateSpec(s).length, 0, `structure ${st} should validate, got ${validateSpec(s)}`);
  });
});

console.log('2. Validation gates');
ok('missing product AND logo fails the anchor check', () => {
  const s = createDraftSpec({ brand: { name: 'X' } });
  s.brand.logoUrl = null;
  assert.ok(validateSpec(s).includes('missing_product_anchor'));
});
ok('logo alone satisfies anchor (image ads)', () => {
  const s = createDraftSpec({ brand: { name: 'X', logoUrl: 'https://cdn/logo.png' } });
  assert.ok(!validateSpec(s).includes('missing_product_anchor'));
});
ok('over 7 beats rejected', () => {
  const s = createDraftSpec({ product: { url: 'u' } });
  s.beats = Array.from({ length: 8 }, () => makeBeat({ role: 'demo' }));
  assert.ok(validateSpec(s).includes('max_7_beats'));
});

console.log('3. specFromScan seeds brand correctly');
ok('pulls confirmedBrand over raw brand, palette, product image', () => {
  const s = specFromScan(fakeScan);
  assert.strictEqual(s.brand.name, 'GlamSecret');
  assert.strictEqual(s.brand.category, 'Skincare');           // confirmedBrand wins
  assert.deepStrictEqual(s.brand.palette, ['#C9A227', '#0B1F3B']);
  assert.strictEqual(s.product.url, 'https://cdn/x/product.png');
  assert.strictEqual(validateSpec(s).length, 0);
});

console.log('4. Lowering matches buildShotRecipe opts contract');
ok('adSpecToRecipeOpts emits exactly the keys buildShotRecipe reads', () => {
  const s = specFromScan(fakeScan);
  s.headline = 'Radiant skin in 7 days';
  s.cta = 'Shop now';
  const opts = adSpecToRecipeOpts(s);
  // keys buildShotRecipe(brand, opts) destructures:
  for (const k of ['templateKey', 'headline', 'cta', 'shotCount', 'durationSec', 'aspectRatio', 'productImageUrl']) {
    assert.ok(k in opts, `opts missing ${k}`);
  }
  assert.strictEqual(opts.shotCount, s.beats.length);
  assert.strictEqual(opts.productImageUrl, s.product.url);
  assert.strictEqual(opts.competitorPosterUrl, undefined);    // legal guard: never competitor asset
  assert.strictEqual(opts.durationSec, s.beats.reduce((a, b) => a + b.durationSec, 0));
});
ok('avatar lowers into avatarBrief.preset.previewCoverUrl shape', () => {
  const s = specFromScan(fakeScan);
  s.avatar = { id: 'av1', source: 'library', previewCoverUrl: 'https://cdn/av1.png' };
  const opts = adSpecToRecipeOpts(s);
  assert.strictEqual(opts.avatarBrief.preset.previewCoverUrl, 'https://cdn/av1.png');  // matches resolveShotClips
});

console.log('5. Teardown (offline heuristic, no LLM dep)');
ok('teardownToSpec produces a brand-seeded draft from competitor', async () => {
  const s = await teardownToSpec({
    scan: fakeScan,
    transcript: 'Still struggling with dull skin after 30? Stop wasting money. Try this. Get yours today.',
    competitorName: 'RivalGlow',
    intelligence: fakeScan.apifyData.competitorAds[0].ads[0].intelligence,
  }, {});  // no callLLM → heuristic path
  assert.strictEqual(s.brand.name, 'GlamSecret');             // user's brand, not competitor's
  assert.ok(s.sourceFingerprint.transcriptHash);              // hash stored
  assert.ok(!JSON.stringify(s).includes('struggling'));       // competitor words NOT persisted in beats
  assert.strictEqual(s.sourceFingerprint.competitor, 'RivalGlow');
  assert.ok(validateSpec(s).length === 0);
});

ok('heuristic detects pain/PAS structure', () => {
  const c = heuristicClassify({ transcript: 'Tired of wasting money on skincare that fails?' });
  assert.strictEqual(c.structure, 'problem_agitate_solve');
  assert.strictEqual(c.hookType, 'pain');
});

ok('coerceClassification rejects junk, accepts valid JSON', () => {
  assert.strictEqual(coerceClassification('not json'), null);
  assert.strictEqual(coerceClassification('{"structure":"nope","beats":[]}'), null);
  const good = coerceClassification('```json\n{"structure":"testimonial","beats":[{"role":"hook"},{"role":"cta"}]}\n```');
  assert.ok(good && good.structure === 'testimonial');
});

console.log('6. regenerateCopy fallback never leaves empty editor');
(async () => {
  await ok('placeholders from intent when no LLM', async () => {
    let s = await teardownToSpec({ scan: fakeScan, transcript: 'x' }, {});
    s = await regenerateCopy(s, {});                          // no callLLM
    assert.ok(s.beats.every((b) => b.userCopy && b.userCopy.length > 0));
    assert.ok(s.cta);
  });

  await ok('uses LLM JSON when provider returns it', async () => {
    let s = await teardownToSpec({ scan: fakeScan, transcript: 'x' }, {});
    const fakeLLM = async () => JSON.stringify({
      lines: s.beats.map((b) => ({ id: b.id, copy: `LINE for ${b.role}` })),
      headline: 'My Headline', cta: 'Buy Now',
    });
    s = await regenerateCopy(s, { callLLM: fakeLLM });
    assert.strictEqual(s.headline, 'My Headline');
    assert.strictEqual(s.cta, 'Buy Now');
    assert.ok(s.beats.every((b) => b.userCopy.startsWith('LINE for')));
  });

  console.log(`\nAll ${pass} assertions passed.`);
})();