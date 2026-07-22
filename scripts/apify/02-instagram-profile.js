'use strict';

/**
 * Step 02 — Pull IG profile + recent posts for a handle.
 * Sorts posts by engagement client-side so you can eyeball "what works."
 *
 * Run: node scripts/apify/02-instagram-profile.js --handle lifepharmacyme --limit 30
 */

const { runActor, parseFlags } = require('./lib/runner');
const { buildInstagramScraperInput } = require('./lib/actorInputs');

(async () => {
  const flags = parseFlags(process.argv);
  const handle = flags.handle;
  if (!handle) { console.error('Usage: --handle <ig_handle>'); process.exit(1); }

  const limit = Math.min(Number(flags.limit) || 30, 100);
  const fresh = !!flags.fresh;

  const profileInput = buildInstagramScraperInput({
    directUrls: [`https://www.instagram.com/${handle}/`],
    resultsType: 'details',
    resultsLimit: 1,
  });
  const postsInput = buildInstagramScraperInput({
    directUrls: [`https://www.instagram.com/${handle}/`],
    resultsType: 'posts',
    resultsLimit: limit,
  });

  const profile = await runActor({
    step: '02-instagram-profile', actorId: 'apify/instagram-scraper',
    input: profileInput, memoryMbytes: 1024, fresh,
  });

  const posts = await runActor({
    step: '02-instagram-posts', actorId: 'apify/instagram-scraper',
    input: postsInput, memoryMbytes: 2048, fresh,
  });

  // Engagement rate sort. Better than raw likes for cross-account compare.
  const followerCount = profile.items?.[0]?.followersCount || 1;
  const ranked = (posts.items || [])
    .map((p) => ({
      url: p.url,
      caption: (p.caption || '').slice(0, 140),
      likes: p.likesCount || 0,
      comments: p.commentsCount || 0,
      videoViews: p.videoViewCount || null,
      type: p.type,
      engagementRate: ((p.likesCount || 0) + 3 * (p.commentsCount || 0)) / followerCount,
      takenAt: p.timestamp,
    }))
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 10);

  console.log('\n── Top 10 posts by engagement ──');
  ranked.forEach((p, i) => {
    console.log(` ${i + 1}. ${(p.engagementRate * 100).toFixed(2)}%  ${p.likes}♥ ${p.comments}💬  ${p.caption}`);
  });
})().catch((e) => { console.error(e); process.exit(1); });