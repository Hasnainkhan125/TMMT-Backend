#!/usr/bin/env node
'use strict';

/**
 * Run compass/crawler-google-places and print JSON (stdout).
 *
 * Usage:
 *   APIFY_API_TOKEN=... node scripts/apify/run-google-places.js --search "Acme Dubai" --location UAE --max 15 --reviews
 *   APIFY_SCRIPT_NO_CACHE=1 node scripts/apify/run-google-places.js --search "dentist JLT"
 *
 * Optional: --out path/to/out.json
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor } = require('../../services/apify/apifyClient');
const { normalizePlace } = require('../../services/apify/actors/googleMaps');
const {
  ACTORS,
  buildGooglePlacesInput,
  parseScriptArgv,
  summarizeDatasetItems,
} = require('./lib/actorInputs');

async function main() {
  const { flags } = parseScriptArgv(process.argv);
  const search = flags.search || flags.s;
  if (!search) {
    console.error('Missing --search "your query"');
    process.exit(1);
  }
  const input = buildGooglePlacesInput({
    searchStrings: search,
    locationQuery: flags.location || flags.l || 'UAE',
    maxCrawledPlacesPerSearch: Number(flags.max || flags.m || 15),
    scrapeReviews: !!(flags.reviews || flags.r),
    maxReviews: Number(flags.maxReviews || 20),
  });

  const skipCache = !!(flags['no-cache'] || flags.noCache || process.env.APIFY_SCRIPT_NO_CACHE);
  const timeoutSecs = Number(flags.timeout || 300);
  const memoryMbytes = Number(flags.memory || 2048);

  const { items, runId, fromCache, runTimeMs } = await runActor(ACTORS.GOOGLE_PLACES, input, {
    timeoutSecs,
    memoryMbytes,
    skipCache,
  });

  const normalized = (items || []).map(normalizePlace);
  const payload = {
    actorId: ACTORS.GOOGLE_PLACES,
    runId,
    fromCache,
    runTimeMs,
    input,
    itemCount: normalized.length,
    items: normalized,
    preview: summarizeDatasetItems(normalized, { maxItems: 3, maxChars: 8000 }),
  };

  const json = JSON.stringify(payload, null, 2);
  const outPath = flags.out || flags.o;
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), json, 'utf8');
    console.error(`Wrote ${outPath} (${normalized.length} places)`);
  }
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
