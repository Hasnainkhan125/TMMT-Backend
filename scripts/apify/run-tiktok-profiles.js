#!/usr/bin/env node
'use strict';

/**
 * Run clockworks/tiktok-scraper for one or more @handles.
 *
 * Usage:
 *   node scripts/apify/run-tiktok-profiles.js --profiles "brandone,brandtwo"
 *   node scripts/apify/run-tiktok-profiles.js --profile "somebrand"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor } = require('../../services/apify/apifyClient');
const { ACTORS, buildTikTokProfileInput, parseScriptArgv, summarizeDatasetItems } = require('./lib/actorInputs');

async function main() {
  const { flags } = parseScriptArgv(process.argv);
  const raw = flags.profiles || flags.profile || flags.p;
  if (!raw) {
    console.error('Missing --profiles "a,b,c" or --profile a');
    process.exit(1);
  }
  const profiles = String(raw)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const input = buildTikTokProfileInput({
    profiles,
    resultsPerPage: Number(flags.resultsPerPage || 20),
  });

  const skipCache = !!(flags['no-cache'] || process.env.APIFY_SCRIPT_NO_CACHE);
  const { items, runId, fromCache, runTimeMs } = await runActor(ACTORS.TIKTOK, input, {
    timeoutSecs: Number(flags.timeout || 420),
    memoryMbytes: Number(flags.memory || 2048),
    skipCache,
  });

  const payload = {
    actorId: ACTORS.TIKTOK,
    runId,
    fromCache,
    runTimeMs,
    input,
    itemCount: (items || []).length,
    items: items || [],
    preview: summarizeDatasetItems(items || [], { maxItems: 5, maxChars: 12000 }),
  };

  const json = JSON.stringify(payload, null, 2);
  if (flags.out || flags.o) fs.writeFileSync(path.resolve(flags.out || flags.o), json, 'utf8');
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
