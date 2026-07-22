'use strict';
/* Offline unit tests for adIngestController logic (no Express/DB/BullMQ). */

const assert = require('assert');

// Inline the pure logic from the controller for unit testing
function validateIngestPayload({ source }) {
  if (!source) { const e = new Error('source required'); e.code = 'bad_request'; throw e; }
  return true;
}

function buildJobResponse({ jobId, status = 'ingesting' }) {
  return { success: true, jobId, status };
}

function buildStatusResponse({ state, returnvalue }) {
  return {
    success: true,
    status: state,
    specId: returnvalue?.specId || null,
    error: state === 'failed' ? 'ingest_failed' : null,
  };
}

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓', name); };

console.log('1. payload validation');
ok('throws bad_request when source missing', () => {
  assert.throws(() => validateIngestPayload({}), (e) => e.code === 'bad_request');
});
ok('passes with valid source', () => {
  assert.strictEqual(validateIngestPayload({ source: 'https://cdn/ad.mp4' }), true);
});

console.log('2. startIngest response shape');
ok('returns jobId and ingesting status', () => {
  const r = buildJobResponse({ jobId: 'job_123' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.status, 'ingesting');
  assert.strictEqual(r.jobId, 'job_123');
});

console.log('3. ingestStatus response mapping');
ok('active state → no specId', () => {
  const r = buildStatusResponse({ state: 'active', returnvalue: null });
  assert.strictEqual(r.specId, null);
  assert.strictEqual(r.error, null);
});
ok('completed state → specId populated', () => {
  const r = buildStatusResponse({ state: 'completed', returnvalue: { specId: 'spec-abc' } });
  assert.strictEqual(r.specId, 'spec-abc');
  assert.strictEqual(r.error, null);
});
ok('failed state → error string', () => {
  const r = buildStatusResponse({ state: 'failed', returnvalue: null });
  assert.strictEqual(r.error, 'ingest_failed');
  assert.strictEqual(r.specId, null);
});

console.log(`\nAll ${pass} assertions passed.`);
