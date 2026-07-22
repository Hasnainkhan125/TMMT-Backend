'use strict';

/**
 * Director board references — MOCK for now (matches creativeDirectorMock Pinterest tiles).
 *
 * When wiring Apify, replace the body with e.g. epctex/pinterest-scraper or your
 * pinned actor: pass search queries / board URLs, map pins → { imageUrl, pinUrl, title }.
 *
 * Run:
 *   node scripts/apify/11-pinterest-director-board.js --query "energy drink aesthetic"
 *   node scripts/apify/11-pinterest-director-board.js --query "minimal skincare ad" --out ./tmp/pinterest-mock.json
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { parseFlags, writeOutput, hashKey } = require('./lib/runner');
const { mockDirectorTemplatesFromPinterest } = require('../../services/brandIntel/creativeDirectorMock');

(async () => {
  const flags = parseFlags(process.argv);
  const query = flags.query || flags.q || 'brand advertising moodboard';
  const templates = mockDirectorTemplatesFromPinterest().map((t, i) => ({
    ...t,
    searchQuery: query,
    rank: i + 1,
  }));

  const payload = {
    source: 'mock',
    query,
    note: 'Replace with Apify Pinterest actor output in production.',
    templates,
    fetchedAt: new Date().toISOString(),
  };

  const key = hashKey({ query, step: '11-pinterest' });
  const file = writeOutput('11-pinterest-director-board', key, payload);
  if (flags.out) {
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(payload, null, 2), 'utf8');
    console.log('Also wrote', path.resolve(flags.out));
  } else {
    console.log('Wrote', file);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
