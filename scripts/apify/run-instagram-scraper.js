#!/usr/bin/env node
'use strict';

/**
 * Run apify/instagram-scraper (posts / hashtag / direct URL list).
 *
 * Usage:
 *   node scripts/apify/run-instagram-scraper.js --url "https://www.instagram.com/humansofny/"
 *   node scripts/apify/run-instagram-scraper.js --urls "https://instagram.com/a/,https://instagram.com/b/"
 *   node scripts/apify/run-instagram-scraper.js --search restaurants --searchType hashtag --searchLimit 5
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor } = require('../../services/apify/apifyClient');
const { ACTORS, buildInstagramScraperInput, parseScriptArgv, summarizeDatasetItems } = require('./lib/actorInputs');

async function main() {
  const { flags } = parseScriptArgv(process.argv);
  let directUrls = [];
  if (flags.urls) {
    directUrls = String(flags.urls)
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (flags.url || flags.u) {
    directUrls = [String(flags.url || flags.u)];
  }

  const input = buildInstagramScraperInput({
    directUrls,
    search: flags.search || '',
    searchType: flags.searchType || 'hashtag',
    searchLimit: Number(flags.searchLimit || 10),
    resultsLimit: Number(flags.resultsLimit || flags.limit || 100),
    resultsType: flags.resultsType || 'posts',
    addParentData: !!flags.addParentData,
  });

  const skipCache = !!(flags['no-cache'] || process.env.APIFY_SCRIPT_NO_CACHE);
  const { items, runId, fromCache, runTimeMs } = await runActor(ACTORS.INSTAGRAM_SCRAPER, input, {
    timeoutSecs: Number(flags.timeout || 600),
    memoryMbytes: Number(flags.memory || 4096),
    skipCache,
  });

  const payload = {
    actorId: ACTORS.INSTAGRAM_SCRAPER,
    runId,
    fromCache,
    runTimeMs,
    input,
    itemCount: (items || []).length,
    items: items || [],
    preview: summarizeDatasetItems(items || [], { maxItems: 6, maxChars: 12000 }),
  };

  const json = JSON.stringify(payload, null, 2);
  if (flags.out || flags.o) fs.writeFileSync(path.resolve(flags.out || flags.o), json, 'utf8');
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
