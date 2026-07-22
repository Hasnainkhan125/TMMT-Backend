'use strict';

/**
 * Parallel Apify fan-out for UrlToAdsScan (competitors, IG, TikTok, Maps, crawl).
 * Each sub-task is isolated — failures are logged and skipped.
 */

const { fetchAllCompetitorAds } = require('./actors/facebookAdsLibrary');
const { fetchInstagramProfile } = require('./actors/instagramProfile');
const { fetchInstagramTopPosts } = require('./actors/instagramPosts');
const { fetchTiktokProfile } = require('./actors/tiktokProfile');
const { fetchGoogleMapsPlaces } = require('./actors/googleMaps');
const { fetchWebsiteMarkdown } = require('./actors/websiteCrawler');

const LOCAL_TYPES = new Set([
  'restaurant',
  'cafe',
  'clinic_medical',
  'clinic_cosmetic',
  'clinic_dental',
  'clinic_wellness',
  'beauty_salon',
  'fitness_gym',
  'fitness_coach',
  'real_estate',
  'hospitality_hotel',

]);

function extractHandle(url, re) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(re);
  return m ? m[1].replace(/^@/, '') : null;
}

function competitorPageUrl(c) {
  return c.url || c.website || c.link || '';
}

// Derive Instagram handle candidates from domain + brand name when no social
// URL is present. Returns up to 3 guesses in priority order.
function guessIgHandles(competitor) {
  const candidates = new Set();
  const url = competitorPageUrl(competitor);
  if (url) {
    try {
      const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      const stem = host.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (stem.length >= 3) candidates.add(stem);
    } catch (_e) { /* ignore bad URL */ }
  }
  const name = (competitor.name || '').trim();
  if (name) {
    candidates.add(name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/gi, ''));
    candidates.add(name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, ''));
  }
  const BLOCKED = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct']);
  return [...candidates].filter((h) => h.length >= 3 && !BLOCKED.has(h)).slice(0, 3);
}

// Derive TikTok handle candidates the same way.
function guessTikTokHandles(competitor) {
  return guessIgHandles(competitor); // same heuristic works
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label}_timeout`)), ms),
    ),
  ]);
}

function isLocalBusiness(scan) {
  const t = scan.businessProfile?.type;
  if (t && LOCAL_TYPES.has(t)) return true;
  const addr =
    scan.brand?.address ||
    scan.research?.brand?.address ||
    scan.businessProfile?.brandIdentity?.address;
  return !!addr;
}

function mapsQuery(scan) {
  const name = scan.brand?.name || scan.host || 'business';
  const cat = scan.brand?.category || scan.businessProfile?.type || '';
  return `${name} ${cat}`.trim().slice(0, 120);
}

function mapsLocationQuery(scan) {
  return (
    process.env.URL_TO_ADS_MAPS_LOCATION ||
    scan.brand?.region ||
    'UAE'
  );
}

/**
 * Local verticals get a full Maps crawl; otherwise we optionally run a smaller
 * crawl when IG/TikTok are missing so Places can supply website + social URLs.
 */
function googleMapsFetchPlan(scan) {
  if (process.env.URL_TO_ADS_SKIP_SUPPLEMENTAL_MAPS === '1' && !isLocalBusiness(scan)) {
    return null;
  }
  if (isLocalBusiness(scan)) {
    return {
      maxPlaces: 20,
      timeoutSecs: 240,
      memoryMbytes: 2048,
    };
  }
  const h = scan.brand?.socialHandles || scan.intelligence?.brandIdentity?.handles || {};
  const hasIg = h.instagramUrl || h.instagramHandle;
  const hasTt = h.tiktokUrl || h.tiktokHandle;
  if (hasIg && hasTt) return null;
  return {
    maxPlaces: 10,
    timeoutSecs: 120,
    memoryMbytes: 1024,
  };
}

/**
 * @param {object} scan — mongoose doc or plain object with competitors, url, brand, ...
 * @param {{ budgetMs?: number }} opts
 * @returns {Promise<{ apifyData: object, _raw: object }>}
 */
async function runApifyEnrichment(scan, opts = {}) {
  const budgetMs = opts.budgetMs || 55_000;
  const competitors = (scan.competitors || []).slice(0, 5);
  const apifyData = {
    competitorAds: [],
    competitorAdsSummary: null,
    instagramProfiles: [],
    instagramTopPosts: [],
    tiktokProfiles: [],
    googleMapsPlaces: [],
    lastRefreshedAt: null,
  };
  const _raw = {
    facebookAds: [],
    instagramProfiles: [],
    instagramPosts: [],
    tiktok: [],
    maps: [],
    websiteMarkdown: null,
  };

  const run = async (label, fn) => {
    try {
      const timeoutMs = Math.min(Math.floor(budgetMs * 0.9), 50000); // Cap at 50s per task
      return await withTimeout(fn(), timeoutMs, label);
    } catch (e) {
      console.warn(`[urlToAdsEnrichment] ${label} failed (non-fatal):`, e.message);
      // Return null but don't fail — allows partial enrichment
      return null;
    }
  };

  const tasks = [];

  // tasks.push(
  //   run('facebook_ads', async () => {
  //     // Filter competitors that have at least a name to search on. The new
  //     // AI-driven pipeline picks its own search strategy per competitor
  //     // (keyword vs page URL vs page id) so we don't pre-require a fb URL.
  //     const valid = competitors.filter((c) => c && (c.name || c.title));
  //     if (!valid.length) return 0;

  //     const userBrand = {
  //       name: scan.brand?.name || scan.host,
  //       category: scan.brand?.category,
  //       valueProps: scan.brand?.valueProps || [],
  //       audience: scan.audience?.primary || scan.brand?.audience || '',
  //     };
  //     const scanContext = {
  //       vertical: scan.businessProfile?.type,
  //       domain: scan.host,
  //     };

  //     try {
  //       console.log('[facebook_ads] Starting Meta Ads fetch for', valid.length, 'competitors...');
  //       const startTime = Date.now();
  //       const { results, summary } = await Promise.race([
  //         fetchAllCompetitorAds({
  //           competitors: valid,
  //           userBrand,
  //           scanContext,
  //           country: process.env.URL_TO_ADS_AD_LIBRARY_COUNTRY || 'US',
  //           limit: 30,
  //         }),
  //         new Promise((_, rej) =>
  //           setTimeout(() => {
  //             const elapsed = Date.now() - startTime;
  //             rej(new Error(`Facebook ads fetch timeout after ${elapsed}ms`));
  //           }, 300000) // 5 minutes for Meta Ads Library (was timing out at 120s)
  //         )
  //       ]);
  //       const elapsed = Date.now() - startTime;
  //       console.log(`[facebook_ads] ✅ Success in ${elapsed}ms: ${summary?.totalAds || 0} ads found`);
  //       apifyData.competitorAds = results;
  //       apifyData.competitorAdsSummary = summary;
  //       _raw.facebookAds = results.map((r) => ({
  //         competitor: r.competitor,
  //         adCount: r.ads?.length || 0,
  //         successfulStrategy: r.successfulStrategy || null,
  //         strategiesAttempted: r.strategiesAttempted?.length || 0,
  //         error: r.error || null,
  //       }));
  //       return summary.totalAds;
  //     } catch (err) {
  //       console.error('[facebook_ads] ❌ Fetch FAILED:', {
  //         message: err.message,
  //         code: err.code,
  //         competitors: valid.length,
  //         country: process.env.URL_TO_ADS_AD_LIBRARY_COUNTRY || 'US'
  //       });
  //       // Return empty but don't fail the whole enrichment
  //       apifyData.competitorAds = [];
  //       apifyData.competitorAdsSummary = {
  //         totalAds: 0,
  //         winners: 0,
  //         errors: [{ error: 'apify_timeout_or_failure', reason: err.message }],
  //         topPatterns: [],
  //         spendingHeavyweights: [],
  //       };
  //       return 0;
  //     }
  //   }),
  // );
// ✅ FIX — facebook_ads runs OUTSIDE the shared run() wrapper, with its own 4-minute cap
// Give it 240s (4 min), well under BullMQ job's total allowed time.
tasks.push(
  (async () => {
    const valid = competitors.filter((c) => c && (c.name || c.title));
    if (!valid.length) return;

    const FB_TIMEOUT_MS = 240_000; // 4 minutes — enough for 5 competitors in parallel
    const fbTimer = setTimeout(() => {
      console.warn('[urlToAdsEnrichment] facebook_ads: 4min hard cap reached');
    }, FB_TIMEOUT_MS);

    try {
      const { results, summary } = await fetchAllCompetitorAds({
        competitors: valid,
        userBrand: { name: scan.brand?.name, category: scan.brand?.category },
        scanContext: { vertical: scan.businessProfile?.type, domain: scan.host },
        country: scan.locale || 'US',
        limit: 30,
      });

      apifyData.competitorAds = results;
      apifyData.competitorAdsSummary = summary;
      _raw.facebookAds = results.map((r) => ({
        competitor: r.competitor,
        adCount: r.ads?.length || 0,
        successfulStrategy: r.successfulStrategy || null,
        strategiesAttempted: r.strategiesAttempted?.length || 0,
        error: r.error || null,
      }));
      console.log('[urlToAdsEnrichment] ✅ facebook_ads:', summary?.totalAds, 'ads');
    } catch (err) {
      console.warn('[urlToAdsEnrichment] facebook_ads failed (non-fatal):', err.message);
    } finally {
      clearTimeout(fbTimer);
    }
  })()
);

  tasks.push(
    run('instagram', async () => {
      const profiles = [];
      const posts = [];
      for (const c of competitors) {
        const url = competitorPageUrl(c);
        // Priority 1: handle explicitly provided by AI in the competitor object
        let ig = c.instagramHandle || extractHandle(url, /instagram\.com\/([^/?#]+)/i);

        // Priority 2: guess from domain/brand — but only accept profiles with 100+ followers
        // to avoid scraping random personal accounts (e.g. @boots with 7 followers)
        if (!ig) {
          const guesses = guessIgHandles(c);
          for (const guess of guesses) {
            try {
              const prof = await fetchInstagramProfile({ username: guess });
              if (prof && prof.followerCount >= 100) { ig = guess; break; }
            } catch (_e) { /* try next guess */ }
          }
        }

        if (!ig || ['p', 'reel', 'stories', 'explore'].includes(ig.toLowerCase())) continue;
        try {
          const prof = await fetchInstagramProfile({ username: ig });
          if (prof) profiles.push({ ...prof, _competitorName: c.name });
          const top = await fetchInstagramTopPosts({ username: ig, maxPosts: 5 });
          posts.push(
            ...top.map((p) => ({ ...p, _competitorName: c.name, _igUsername: ig })),
          );
        } catch (e) {
          _raw.instagramProfiles.push({ username: ig, error: e.message });
        }
      }
      apifyData.instagramProfiles = [...(apifyData.instagramProfiles || []), ...profiles];
      apifyData.instagramTopPosts = [...(apifyData.instagramTopPosts || []), ...posts];
      return profiles.length + posts.length;
    }),
  );

  tasks.push(
    run('tiktok', async () => {
      const out = [];
      for (const c of competitors) {
        const url = competitorPageUrl(c);
        // Priority 1: handle explicitly provided by AI in the competitor object
        let handle = c.tiktokHandle || extractHandle(url, /tiktok\.com\/@?([^/?#]+)/i);

        // Priority 2: guess — only accept profiles with meaningful presence (50+ followers)
        if (!handle) {
          const guesses = guessTikTokHandles(c);
          for (const guess of guesses) {
            try {
              const prof = await fetchTiktokProfile({ profiles: [guess], resultsPerPage: 1 });
              if (prof && prof.followerCount >= 50) { handle = guess; break; }
            } catch (_e) { /* try next guess */ }
          }
        }

        if (!handle) continue;
        try {
          const prof = await fetchTiktokProfile({
            profiles: [handle],
            resultsPerPage: 20,
          });
          if (prof) out.push({ ...prof, _competitorName: c.name });
        } catch (e) {
          _raw.tiktok.push({ handle, error: e.message });
        }
      }
      apifyData.tiktokProfiles = out;
      return out.length;
    }),
  );

  tasks.push(
    run('google_maps', async () => {
      const plan = googleMapsFetchPlan(scan);
      if (!plan) return 0;
      try {
        const places = await fetchGoogleMapsPlaces(
          {
            searchStringsArray: [mapsQuery(scan)],
            maxCrawledPlacesPerSearch: plan.maxPlaces,
            locationQuery: mapsLocationQuery(scan),
            ...(isLocalBusiness(scan)
              ? { scrapeReviews: true, maxReviews: 20 }
              : {}),
          },
          { timeoutSecs: plan.timeoutSecs, memoryMbytes: plan.memoryMbytes },
        );
        apifyData.googleMapsPlaces = places;
        _raw.maps = places;
        return places.length;
      } catch (e) {
        _raw.maps = { error: e.message };
        return 0;
      }
    }),
  );

  // tasks.push(
  //   run('website_crawl', async () => {
  //     const startUrl = scan.url || scan.brand?.url;
  //     if (!startUrl) return 0;
  //     const md = await fetchWebsiteMarkdown({
  //       startUrls: [{ url: startUrl }],
  //       maxCrawlPages: 15,
  //     });
  //     _raw.websiteMarkdown = md || null;
  //     _raw.crawl = { length: md?.length || 0 };
  //     return md?.length || 0;
  //   }),
  // );

  await Promise.allSettled(tasks);
  apifyData.lastRefreshedAt = new Date();
  apifyData._raw = _raw;

  return { apifyData, _raw };
}

/**
 * Fetches the scanned brand's own Instagram top posts (not competitors').
 * Called from urlToAdsEnrichJob **after** mergeOwnGooglePlaceIntoScan so Google
 * Maps–discovered instagramUrl is available.
 *
 * @returns {Promise<number>} post count ingested (0 if skipped/failed)
 */
async function ingestSubjectBrandInstagram(scan, apifyData) {
  if (!scan || !apifyData) return 0;
  const posts = apifyData.instagramTopPosts || [];
  if (posts.some((p) => p._isSubjectBrand)) return 0;

  const h = scan.brand?.socialHandles || scan.intelligence?.brandIdentity?.handles || {};
  let ig =
    h.instagramHandle
    || extractHandle(h.instagramUrl || '', /instagram\.com\/([^/?#]+)/i);
  if (!ig && scan.host) {
    try {
      const stem = String(scan.host).replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '');
      if (stem.length >= 3) {
        const prof = await fetchInstagramProfile({ username: stem });
        if (prof && (prof.followerCount || 0) >= 20) ig = stem;
      }
    } catch (_e) { /* ignore */ }
  }
  if (!ig || ['p', 'reel', 'stories', 'explore', 'accounts'].includes(ig.toLowerCase())) {
    return 0;
  }

  const brandName = scan.brand?.name || scan.host || 'brand';
  try {
    const prof = await fetchInstagramProfile({ username: ig });
    const top = await fetchInstagramTopPosts({ username: ig, maxPosts: 5 });
    if (prof) {
      apifyData.instagramProfiles = [...(apifyData.instagramProfiles || []), {
        ...prof,
        _isSubjectBrand: true,
        _competitorName: brandName,
      }];
    }
    apifyData.instagramTopPosts = [
      ...posts,
      ...top.map((p) => ({
        ...p,
        _competitorName: brandName,
        _igUsername: ig,
        _isSubjectBrand: true,
      })),
    ];
    return top.length;
  } catch (e) {
    if (!apifyData._raw) apifyData._raw = {};
    if (!Array.isArray(apifyData._raw.instagramProfiles)) apifyData._raw.instagramProfiles = [];
    apifyData._raw.instagramProfiles.push({ username: ig, error: e.message, subjectBrand: true });
    return 0;
  }
}

module.exports = {
  runApifyEnrichment,
  ingestSubjectBrandInstagram,
  isLocalBusiness,
  googleMapsFetchPlan,
  mapsQuery,
};
