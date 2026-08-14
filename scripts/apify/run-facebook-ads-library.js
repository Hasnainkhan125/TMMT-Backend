#!/usr/bin/env node
'use strict';

/**
 * Run Meta Ad Library scraper (keyword or page id).
 *
 * Usage:
 *   node scripts/apify/run-facebook-ads-library.js --keyword "Noon UAE"
 *   node scripts/apify/run-facebook-ads-library.js --pageId "123456789" --country AE --count 30
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor } = require('../../services/apify/apifyClient');
const { ACTORS, buildFacebookAdsLibraryInput, parseScriptArgv, summarizeDatasetItems } = require('./lib/actorInputs');
const { facebookAdsMemoryMbytesForInput } = require('../../services/apify/actors/buildAdLibraryUrl');

async function main() {
  const { flags } = parseScriptArgv(process.argv);
  const keyword = flags.keyword || flags.k;
  const pageId = flags.pageId || flags.page;

  const input = buildFacebookAdsLibraryInput({
    keyword: keyword || undefined,
    pageId: pageId || undefined,
    country: flags.country || 'AE',
    count: Number(flags.count || 25),
  });

  const defaultMem = facebookAdsMemoryMbytesForInput(input, ACTORS.FACEBOOK_ADS);
  const memoryMbytes = flags.memory != null && flags.memory !== ''
    ? Number(flags.memory)
    : defaultMem;

  const skipCache = !!(flags['no-cache'] || process.env.APIFY_SCRIPT_NO_CACHE);
  const { items, runId, fromCache, runTimeMs } = await runActor(ACTORS.FACEBOOK_ADS, input, {
    timeoutSecs: Number(flags.timeout || 600),
    memoryMbytes,
    skipCache,
  });

  const payload = {
    actorId: ACTORS.FACEBOOK_ADS,
    runId,
    fromCache,
    runTimeMs,
    input,
    itemCount: (items || []).length,
    items: items || [],
    preview: summarizeDatasetItems(items || [], { maxItems: 4, maxChars: 12000 }),
  };

  const json = JSON.stringify(payload, null, 2);
  if (flags.out || flags.o) fs.writeFileSync(path.resolve(flags.out || flags.o), json, 'utf8');
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
