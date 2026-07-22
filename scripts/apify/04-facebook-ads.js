'use strict';

/**
 * Step 04 — Pull Meta Ad Library ads for a brand or keyword.
 * Uses the Ad Library URL format (the only thing the actor accepts).
 *
 * Run:
 *   node scripts/apify/04-facebook-ads.js --keyword "business setup" --country US
 *   node scripts/apify/04-facebook-ads.js --pageId 214396565557 --country AE
 */

const { runActor, parseFlags } = require('./lib/runner');
const { buildFacebookAdsLibraryInput } = require('./lib/actorInputs');
const { facebookAdsMemoryMbytesForInput } = require('../../services/apify/actors/buildAdLibraryUrl');

(async () => {
  const flags = parseFlags(process.argv);
  if (!flags.keyword && !flags.pageId) {
    console.error('Usage: --keyword <text> | --pageId <fb_page_id> [--country US] [--count 40] [--mediaType video]');
    process.exit(1);
  }

  const input = buildFacebookAdsLibraryInput({
    keyword: flags.keyword,
    pageId: flags.pageId,
    country: flags.country || 'US',
    count: Math.min(Number(flags.count) || 40, 200),
    mediaType: flags.mediaType,        // 'all' | 'video' | 'image'
    activeStatus: flags.activeStatus,  // 'active' | 'all'
  });

  const actorId = 'curious_coder/facebook-ads-library-scraper';
  const memoryMbytes = facebookAdsMemoryMbytesForInput(input, actorId);

  const result = await runActor({
    step: '04-facebook-ads', actorId, input, memoryMbytes,
    timeoutSecs: 360, fresh: !!flags.fresh,
  });

  // Quick ad-quality summary so you know if the scrape "worked"
  const ads = result.items || [];
  const withVideo = ads.filter((a) => a.snapshot?.videos?.length).length;
  const withCarousel = ads.filter((a) => (a.snapshot?.cards?.length || 0) > 1).length;
  const longRunning = ads.filter((a) => {
    const days = ((a.end_date || 0) - (a.start_date || 0)) / 86400;
    return days >= 30;
  }).length;

  console.log('\n── Ad Library summary ──');
  console.log(` Total ads: ${ads.length}`);
  console.log(` With video: ${withVideo} | Carousel: ${withCarousel} | Running 30+ days: ${longRunning}`);

  if (ads.length) {
    console.log('\n── Top 5 by recency ──');
    ads.slice(0, 5).forEach((a, i) => {
      const body = (a.snapshot?.body?.text || '').slice(0, 80).replace(/\n/g, ' ');
      console.log(` ${i + 1}. [${a.snapshot?.cta_type || '—'}] ${a.page_name}: ${body}`);
    });
  } else {
    console.log('\n No ads returned. Try a different keyword or check if the brand actually advertises.');
  }
})().catch((e) => { console.error(e); process.exit(1); });