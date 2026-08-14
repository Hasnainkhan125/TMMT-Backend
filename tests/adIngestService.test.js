'use strict';
/* Offline unit tests for adIngestService — no DB, no LLM, no R2, no ffmpeg. */

const assert = require('assert');
const { derivePacing, uploadFrames, visionNotes } = require('../services/adSpec/adIngestService');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓', name); };
const okAsync = async (name, fn) => { await fn(); pass++; console.log('  ✓', name); };

console.log('1. derivePacing');
ok('fast pacing when >0.5 cuts/sec', () => {
  const m = { meta: { duration: 10 }, scenes: [1,2,3,4,5,6] };
  assert.strictEqual(derivePacing(m), 'fast');
});
ok('cinematic pacing when <0.2 cuts/sec', () => {
  const m = { meta: { duration: 20 }, scenes: [1,2] };
  assert.strictEqual(derivePacing(m), 'cinematic');
});
ok('medium pacing in between', () => {
  const m = { meta: { duration: 15 }, scenes: [1,2,3] };
  assert.strictEqual(derivePacing(m), 'medium');
});
ok('returns medium when duration=0', () => {
  assert.strictEqual(derivePacing({ meta: { duration: 0 }, scenes: [] }), 'medium');
});

console.log('2. uploadFrames (no R2 injected)');
(async () => {
  await okAsync('returns frames with url:null when uploadToR2 not wired', async () => {
    const fakeManifest = {
      frames: [
        { sceneIndex: 0, t: 1.7, path: '/tmp/frame0.jpg' },
        { sceneIndex: 1, t: 4.2, path: '/tmp/frame1.jpg' },
      ],
    };
    const result = await uploadFrames(fakeManifest, { scanId: 'test123' });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].url, null);
    assert.strictEqual(result[0].sceneIndex, 0);
  });

  console.log('3. visionNotes (no vision LLM injected)');
  await okAsync('returns empty string when no callVisionLLM', async () => {
    const frames = [{ url: 'https://cdn/frame0.jpg' }];
    const notes = await visionNotes(frames);
    assert.strictEqual(typeof notes, 'string');
    assert.strictEqual(notes, '');
  });

  console.log(`\nAll ${pass} assertions passed.`);
})();
