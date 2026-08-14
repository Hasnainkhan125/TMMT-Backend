'use strict';

/**
 * Step 08 — Full pipeline: URL → website → AI research → social profiles
 *           → competitor ads → roast. Mirrors urlToAdsService end-to-end
 *           but writes every step to disk so you can inspect failures.
 *
 * Run: node scripts/apify/08-full-pipeline.js --url https://www.lifepharmacy.com
 *      node scripts/apify/08-full-pipeline.js --url https://adnoc.ae --skip ads,maps
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { parseFlags, readCache, hashKey, writeOutput } = require('./lib/runner');
const { researchBrand } = require('../../services/aiResearch');

function runStep(script, args) {
  const r = spawnSync('node', [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} failed`);
}

(async () => {
  const flags = parseFlags(process.argv);
  const url = flags.url;
  if (!url) { console.error('Usage: --url <url> [--skip ads,maps,tiktok] [--fresh]'); process.exit(1); }
  const skip = (flags.skip || '').split(',').filter(Boolean);
  const fresh = flags.fresh ? ['--fresh'] : [];

  // Step 1: scrape website
  runStep('01-website.js', ['--url', url, ...fresh]);
  const website = readCache('01-website', hashKey({ url, step: '01-website' }));
  if (!website) throw new Error('website cache missing after step 01');

  // Step 7 (run early — feeds competitor list): aiResearch
  console.log('\n[07-ai-research] calling Anthropic…');
  const research = await researchBrand({
    url,
    html: '',  // Anthropic uses scrape, not raw html, when html is empty
    scrape: {
      ...website,
      socialHandles: website.socialHandles,
      team: website.team,
      services: website.services,
    },
  });
  writeOutput('07-ai-research', hashKey({ url, step: 'ai' }), research);

  console.log(`\n[07-ai-research] category: ${research?.brand?.category}`);
  console.log(`[07-ai-research] competitors: ${(research?.competitors || []).map((c) => c.name).join(', ')}`);

  // Step 2: own IG profile (skip if no handle)
  const ownIg = website.socialHandles?.instagramHandle;
  if (ownIg && !skip.includes('ig')) {
    runStep('02-instagram-profile.js', ['--handle', ownIg, '--limit', '30', ...fresh]);
  }

  // Step 4: own brand FB ads
  if (website.brandName && !skip.includes('ads')) {
    runStep('04-facebook-ads.js', ['--keyword', website.brandName, '--country', flags.country || 'US', ...fresh]);
  }

  // Step 4: top 3 competitors FB ads
  const competitors = (research?.competitors || []).slice(0, 3);
  if (!skip.includes('ads')) {
    for (const c of competitors) {
      try {
        runStep('04-facebook-ads.js', ['--keyword', c.name, '--country', flags.country || 'US', '--count', '20', ...fresh]);
      } catch (e) { console.warn(`competitor ad scrape failed for ${c.name}: ${e.message}`); }
    }
  }

  // Step 2: competitor IG profiles (only if AI gave us a verified-looking handle)
  if (!skip.includes('ig')) {
    for (const c of competitors) {
      const handle = c.instagramHandle;
      if (!handle || handle.length < 3) continue;
      try {
        runStep('02-instagram-profile.js', ['--handle', handle, '--limit', '15', ...fresh]);
      } catch (e) { console.warn(`competitor ig scrape failed for ${handle}: ${e.message}`); }
    }
  }

  // Step 5: Google Maps local competitors (only for local-relevant business types)
  if (!skip.includes('maps')) {
    const cat = research?.brand?.category || '';
    if (/restaurant|salon|clinic|gym|cafe|pharmacy|store/i.test(cat)) {
      runStep('05-google-maps.js', ['--search', `${cat} ${flags.city || 'Dubai'}`, ...fresh]);
    } else {
      console.log(`[05-google-maps] skipped (category "${cat}" is not local-business)`);
    }
  }

  console.log('\n── Pipeline complete ──');
  console.log(` Output dir: scripts/apify/output/`);
  console.log(` Inspect: ls -lh scripts/apify/output/ | head -20`);
})().catch((e) => { console.error(e); process.exit(1); });