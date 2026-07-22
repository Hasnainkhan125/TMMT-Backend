#!/usr/bin/env node
'use strict';

/**
 * Run apify/google-search-scraper (AI / Perplexity options per your template).
 *
 * Usage:
 *   node scripts/apify/run-google-search-scraper.js --queries "What are the top 5 CRM tools"
 *   node scripts/apify/run-google-search-scraper.js --queries "Brand X reviews UAE" --resultsPerPage 50 --out serp.json
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor } = require('../../services/apify/apifyClient');
const { ACTORS, buildGoogleSearchScraperInput, parseScriptArgv, summarizeDatasetItems } = require('./lib/actorInputs');

async function main() {
  const { flags } = parseScriptArgv(process.argv);
  const queries = flags.queries || flags.q;
  if (!queries) {
    console.error('Missing --queries "your search"');
    process.exit(1);
  }

  const input = buildGoogleSearchScraperInput({
    queries: String(queries),
    resultsPerPage: Number(flags.resultsPerPage || 100),
    maxPagesPerQuery: Number(flags.maxPagesPerQuery || 1),
    enableAiMode: flags.noAi ? false : true,
    enablePerplexity: flags.noPerplexity ? false : true,
    perplexityReturnImages: flags.noPerplexityImages ? false : true,
    saveHtml: !!flags.saveHtml,
    saveHtmlToKeyValueStore: flags.noKvStore ? false : true,
  });

  const skipCache = !!(flags['no-cache'] || process.env.APIFY_SCRIPT_NO_CACHE);
  const { items, runId, fromCache, runTimeMs } = await runActor(ACTORS.GOOGLE_SEARCH, input, {
    timeoutSecs: Number(flags.timeout || 420),
    memoryMbytes: Number(flags.memory || 4096),
    skipCache,
  });

  const payload = {
    actorId: ACTORS.GOOGLE_SEARCH,
    runId,
    fromCache,
    runTimeMs,
    input,
    itemCount: (items || []).length,
    items: items || [],
    preview: summarizeDatasetItems(items || [], { maxItems: 5, maxChars: 12000 }),
  };

  const json = JSON.stringify(payload, null, 2);
  if (flags.out || flags.o) {
    fs.writeFileSync(path.resolve(flags.out || flags.o), json, 'utf8');
  }
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
