'use strict';

/**
 * Read brand-intel snapshot JSON → emit DB/frontend-shaped payload + mock Anthropic conclusion.
 *
 * Run:
 *   node scripts/apify/10-brand-intel-conclude-mock.js --snapshot ./tmp/brand-intel.json
 *   node scripts/apify/10-brand-intel-conclude-mock.js --snapshot ./tmp/brand-intel.json --out ./tmp/brand-intel.api-mock.json
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { parseFlags, writeOutput, hashKey } = require('./lib/runner');
const { snapshotToMockApiResponse } = require('../../services/brandIntel/creativeDirectorMock');

(async () => {
  const flags = parseFlags(process.argv);
  const snapPath = flags.snapshot || flags.s;
  if (!snapPath) {
    console.error('Usage: --snapshot ./tmp/brand-intel.json [--out path]');
    process.exit(1);
  }
  const abs = path.resolve(snapPath);
  const snapshot = JSON.parse(fs.readFileSync(abs, 'utf8'));

  const apiMock = snapshotToMockApiResponse(snapshot, { scanId: flags.scanId || 'mock-scan' });

  const key = hashKey({ snapshot: snapshot.generatedAt, url: snapshot.input?.url });
  const defaultOut = writeOutput('10-brand-intel-api-mock', key, apiMock);

  if (flags.out) {
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(apiMock, null, 2), 'utf8');
    console.log('Also wrote', path.resolve(flags.out));
  } else {
    console.log('Wrote', defaultOut);
  }

  console.log('\n── Mock API summary ──');
  console.log(` Brand: ${apiMock.scan?.brand?.name}`);
  console.log(` Ads normalized rows: ${(apiMock.scan?.apifyData?.competitorAds || []).length}`);
  console.log(` Total creatives: ${apiMock.scan?.apifyData?.competitorAdsSummary?.totalAds ?? '—'}`);
  console.log(` Director templates (mock Pinterest): ${apiMock.conclusion?.directorBoard?.templates?.length ?? 0}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
