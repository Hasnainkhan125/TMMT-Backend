'use strict';

/**
 * Background enrichment for UrlToAdsScan: multi-page crawl, social handles,
 * brand palette, Apify actors, money math, Layer 1–5 intelligence.
 * Invoked by BullMQ worker (or inline fallback).
 */

const UrlToAdsScan = require('../model/schema/urlToAdsScan');
const { crawl: multiPageCrawl } = require('./scraper/multiPageCrawler');
const { extractSocialHandles } = require('./scraper/extractSocialHandles');
const { extractBrandPalette: extractCssPalette } = require('./scraper/extractBrandPalette');
const { extractTeamAndServices } = require('./scraper/extractTeamAndServices');
const { runApifyEnrichment, ingestSubjectBrandInstagram } = require('./apify/urlToAdsEnrichment');
const { normalizeCompetitorSocialUrls } = require('./apify/competitorResolution');
const { enrichScanStrategicAnglesWithMedia } = require('./urlToAds/mergeStrategicAnglesWithMedia');
const { computeMoneyMath } = require('./moneyMath');
const { runIntelligenceRun } = require('./intelligence/pipeline');
const { generateRoast } = require('./roastEngine');

const MAPS_SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'linkedin'];

// function isOwnGoogleListing(place, scan) {
//   if (!place?.name) return false;
//   const ownDomain = (scan.host || '').toLowerCase().replace(/^www\./, '');
//   const ownSlug = (scan.brand?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
//   const leadSlug = String(place.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
//   let leadDomain = '';
//   if (place.website) {
//     try {
//       leadDomain = new URL(place.website).hostname.toLowerCase().replace(/^www\./, '');
//     } catch (_e) {
//       leadDomain = '';
//     }
//   }
//   const nameMatch = ownSlug.length >= 3 && leadSlug.includes(ownSlug);
//   const domMatch =
//     ownDomain.length >= 3 &&
//     Boolean(leadDomain) &&
//     (leadDomain === ownDomain ||
//       leadDomain.endsWith(`.${ownDomain}`) ||
//       ownDomain.endsWith(`.${leadDomain}`));
//   return nameMatch || domMatch;
// }
function isOwnGoogleListing(place, scan) {
  if (!place?.website) return false;
  try {
    const placeHost = new URL(place.website).hostname.replace(/^www\./, '');
    const scanHost = (scan.host || '').replace(/^www\./, '');
    return placeHost === scanHost || placeHost.endsWith('.' + scanHost);
  } catch { return false; }
}

function ingestOneSocialUrl(handles, platform, url) {
  if (!url || typeof url !== 'string') return;
  const clean = url.split('?')[0].replace(/\/$/, '');
  const hKey = `${platform}Handle`;
  const uKey = `${platform}Url`;
  if (handles[uKey] || handles[hKey]) return;

  const patterns = {
    instagram: /instagram\.com\/([A-Za-z0-9._]+)/i,
    facebook: /facebook\.com\/([A-Za-z0-9._-]+)/i,
    tiktok: /tiktok\.com\/@?([A-Za-z0-9._-]+)/i,
    youtube: /youtube\.com\/(?:channel\/|c\/|user\/|@)?([A-Za-z0-9._@-]+)/i,
    twitter: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i,
    linkedin: /linkedin\.com\/(?:company\/|in\/)?([A-Za-z0-9._-]+)/i,
  };
  const re = patterns[platform];
  if (!re) return;
  const m = clean.match(re);
  if (!m) return;
  handles[hKey] = m[1].replace(/^@/, '');
  handles[uKey] = clean;
  handles[`${platform}Source`] = 'google_maps';
}

function mergeSocialUrlsIntoHandlesRecord(handles, socialUrls) {
  if (!socialUrls || typeof socialUrls !== 'object') return;
  for (const p of MAPS_SOCIAL_PLATFORMS) {
    const url = socialUrls[p];
    if (typeof url === 'string') ingestOneSocialUrl(handles, p, url);
  }
}

/** Flatten Maps `socialUrls` into `{ instagramUrl, facebookUrl, … }` for API clients. */
function socialUrlsRecordFromMaps(socialUrls) {
  const out = {};
  if (!socialUrls || typeof socialUrls !== 'object') return out;
  for (const p of MAPS_SOCIAL_PLATFORMS) {
    const u = socialUrls[p];
    if (typeof u === 'string' && u.trim()) {
      out[`${p}Url`] = u.split('?')[0].replace(/\/$/, '');
    }
  }
  return out;
}

/**
 * When Google Maps returns the user's own listing, merge website-adjacent
 * social URLs + phone into brand handles (without overwriting scrape data).
 */
function mergeOwnGooglePlaceIntoScan(scan) {
  const places = scan.apifyData?.googleMapsPlaces;
  if (!Array.isArray(places) || !places.length) return;

  const own = places.find((p) => isOwnGoogleListing(p, scan));
  if (!own) return;

  const prior = { ...(scan.brand?.socialHandles || {}) };
  mergeSocialUrlsIntoHandlesRecord(prior, own.socialUrls);
  if (own.phone && !prior.phoneNumber) {
    prior.phoneNumber = String(own.phone);
    prior.phoneSource = 'google_maps';
  }

  scan.brand = { ...(scan.brand || {}), socialHandles: prior };
  if (!scan.intelligence) scan.intelligence = {};
  if (!scan.intelligence.brandIdentity) scan.intelligence.brandIdentity = {};
  scan.intelligence.brandIdentity.handles = {
    ...(scan.intelligence.brandIdentity.handles || {}),
    ...prior,
  };
  scan.markModified('brand');
  scan.markModified('intelligence');
}

function bumpScan(status) {
  try {
    const m = require('../utils/metrics');
    if (m.incScan) m.incScan(status);
  } catch (_e) { /* optional */ }
}

/**
 * @param {{ scanId: string, userId?: string|null }} data
 */
async function runScanEnrichmentJob(data) {
  const scanId = data.scanId;
  if (!scanId) throw new Error('runScanEnrichmentJob: scanId required');

  let scan;
  try {
    scan = await UrlToAdsScan.findById(scanId).maxTimeMS(30000); // 30s timeout for MongoDB
  } catch (dbErr) {
    console.error('[urlToAdsEnrichJob] MongoDB timeout fetching scan:', dbErr.message);
    // Try again once
    try {
      scan = await UrlToAdsScan.findById(scanId).maxTimeMS(30000);
    } catch (dbErr2) {
      console.error('[urlToAdsEnrichJob] MongoDB still failing after retry:', dbErr2.message);
      return { ok: false, scanId, error: 'mongodb_timeout' };
    }
  }
  if (!scan || scan.status === 'archived') return { skipped: true };

  try {
    // Phase 1: Multi-page crawl → refresh social handles, CSS palette, team/services
    // with the full site context (10+ pages). This runs in background so the initial
    // scan response is fast (<15s); this enrichment resolves in 30-90s.
    try {
      const redis = require('./redis').getRedis?.();
      const crawlResult = await multiPageCrawl({
        url: scan.url, redis, bypassCache: false,
      });
      if (crawlResult?.rawHtml) {
        const richHtml = crawlResult.rawHtml;
        const baseUrl = crawlResult.homepage || scan.url;

        const socialResult = await extractSocialHandles({ html: richHtml, url: scan.url });
        const mergedHandles = {
          ...(scan.intelligence?.brandIdentity?.handles || {}),
          ...socialResult.handles,
        };

        const cssP = extractCssPalette({ html: richHtml });
        const teamAndServices = extractTeamAndServices({ html: richHtml, baseUrl });

        // Merge into intelligence.brandIdentity
        if (!scan.intelligence) scan.intelligence = {};
        if (!scan.intelligence.brandIdentity) scan.intelligence.brandIdentity = {};
        scan.intelligence.brandIdentity.handles = mergedHandles;
        if (cssP?.palette?.length >= 2) {
          scan.intelligence.brandIdentity.palette = cssP.palette;
          scan.intelligence.brandIdentity.primaryColor = cssP.primary || scan.intelligence.brandIdentity.primaryColor;
          scan.intelligence.brandIdentity.secondaryColor = cssP.secondary || scan.intelligence.brandIdentity.secondaryColor;
          scan.intelligence.brandIdentity.accentColor = cssP.accent || scan.intelligence.brandIdentity.accentColor;
          // Also update brandPalette on scan root for the BrandKitCard
          if (!scan.brandPalette || scan.brandPalette._source === 'image') {
            scan.brandPalette = { ...cssP, _source: 'css' };
          }
        }
        if (teamAndServices.team.length > (scan.intelligence.brandIdentity.team?.length || 0)) {
          scan.intelligence.brandIdentity.team = teamAndServices.team.slice(0, 20);
          scan.brand = { ...scan.brand, team: teamAndServices.team.slice(0, 20) };
        }
        if (teamAndServices.services.length > (scan.intelligence.brandIdentity.services?.length || 0)) {
          scan.intelligence.brandIdentity.services = teamAndServices.services.slice(0, 20);
          scan.brand = { ...scan.brand, services: teamAndServices.services.slice(0, 20) };
        }
        scan.markModified('intelligence');
        scan.markModified('brand');
        scan.markModified('brandPalette');
      }
    } catch (crawlErr) {
      console.warn('[urlToAdsEnrichJob] multiPageCrawl failed (non-fatal):', crawlErr.message);
    }

    const { apifyData } = await runApifyEnrichment(scan, { budgetMs: 60_000 });
    scan.set('apifyData', apifyData);
    mergeOwnGooglePlaceIntoScan(scan);

    try {
      await ingestSubjectBrandInstagram(scan, scan.apifyData);
    } catch (igErr) {
      console.warn('[urlToAdsEnrichJob] subject-brand Instagram (non-fatal):', igErr.message);
    }

    if (scan.apifyData?.googleMapsPlaces?.length) {
      const localCompetitors = scan.apifyData.googleMapsPlaces
        .filter(p => p.website && p.website !== scan.url)  // exclude self
        .filter(p => p.reviewsCount >= 20)                  // legitimate businesses
        .slice(0, 5)
        .map(p => ({
          name: p.name,
          url: p.website,
          tagline: `${p.rating}★ · ${p.reviewsCount} reviews · ${p.address.split(' - ').slice(-2)[0]}`,
          why: `Local ${p.categories[0]} competing in your geography. Direct head-to-head.`,
          differentiator: 'Pulled from Google Maps — real local competitor, not a generic brand.',
          source: 'google_maps',
          phone: p.phone,
          reviewsCount: p.reviewsCount,
          rating: p.rating,
          socialUrls: socialUrlsRecordFromMaps(p.socialUrls),
        }));
      
      // Prepend local competitors before LLM-generated ones; dedupe by domain
      const seen = new Set(localCompetitors.map(c => new URL(c.url).hostname));
      const llmCompetitors = (scan.competitors || []).filter(c => {
        try { return !seen.has(new URL(c.url).hostname); } catch { return true; }
      });
      
      scan.competitors = [...localCompetitors, ...llmCompetitors].slice(0, 8);
    }
    scan.competitors = (scan.competitors || []).map(normalizeCompetitorSocialUrls);
    scan.markModified('competitors');
    scan.markModified('apifyData');
    enrichScanStrategicAnglesWithMedia(scan);

    try {
      const { buildCompetitiveGap } = require('./urlToAds/competitiveGapAnalysis');
      const gap = buildCompetitiveGap(scan);
      if (gap) {
        scan.set('competitiveGap', gap);
        scan.markModified('competitiveGap');
      }
    } catch (gapErr) {
      console.warn('[urlToAdsEnrichJob] competitive gap (non-fatal):', gapErr.message);
    }

    // computeMoneyMath is now AI-driven (async). Failure inside the service
    // already falls back to deterministic Gulf benchmarks, so a try/catch
    // here is just a belt-and-braces guard against the await rejecting.
    try {
      const money = await computeMoneyMath(scan);
      scan.set('moneyMath', money);
      scan.markModified('moneyMath');
    } catch (mmErr) {
      console.warn('[urlToAdsEnrichJob] money math failed (non-fatal):', mmErr.message);
    }

    // ✅ FIX: Only run intelligence if we DON'T already have competitor ads
    // This prevents a SECOND call to Meta Ad Library which opens the circuit breaker

        const hasCompetitorAds = apifyData?.competitorAds?.length > 0;

        if (!hasCompetitorAds) {
          console.log('[urlToAdsEnrichJob] 🔍 Running intelligence (no ads yet)');
          try {
            const intelligence = await runIntelligenceRun({
              url: scan.url,
              userId: data.userId || scan.userId || null,
              triggeredBy: 'scan',
              useLlm: true,
              persist: true,
            });
            scan.intelligence = {
              brandId: intelligence.persisted?.brandId || null,
              brandIdentity: intelligence.brandIdentity,
              battlefieldReport: intelligence.battlefieldReport,
              collection: {
                sourcesHealthy: intelligence.collectionReport?.sourcesHealthy || 0,
                sourcesTotal: intelligence.collectionReport?.sourcesTotal || 0,
                coverageScore: intelligence.collectionReport?.coverageScore || 0,
                sources: intelligence.collectionReport?.sources || [],
              },
              generatedAt: new Date(),
            };
          } catch (intelErr) {
            console.warn('[urlToAdsEnrichJob] intelligence failed (non-fatal):', intelErr.message);
          }
        } else {
          console.log('[urlToAdsEnrichJob] ✅ SKIP intelligence (apifyData has', apifyData.competitorAds.length, 'ads)');
          // Still populate intelligence.collection so the UI doesn't blank
         const priorBrandIdentity = scan.intelligence?.brandIdentity || null;
  scan.intelligence = {
    brandId: null,
    brandIdentity: priorBrandIdentity,   // ← keep what the crawl found
    battlefieldReport: null,
    collection: { sourcesHealthy: 0, sourcesTotal: 0, coverageScore: 0, sources: [] },
    generatedAt: new Date(),
  };
  scan.markModified('intelligence');
        }



    // ROAST — runs LAST so it can read every other signal (apifyData,
    // moneyMath, intelligence). Failure is silent: the panel just hides.
    try {
      const roast = await generateRoast(scan);
      scan.set('roast', roast);
      scan.markModified('roast');
    } catch (roastErr) {
      console.warn('[urlToAdsEnrichJob] roast failed (non-fatal):', roastErr.message);
    }

    scan.status = 'ready';
    try {
      await scan.save({ maxTimeMS: 30000 }); // 30s timeout for save
    } catch (saveErr) {
      console.error('[urlToAdsEnrichJob] MongoDB save timeout:', saveErr.message);
      // Attempt one retry
      try {
        await scan.save({ maxTimeMS: 30000 });
      } catch (saveErr2) {
        console.error('[urlToAdsEnrichJob] Save failed twice, marking ready anyway:', saveErr2.message);
      }
    }
    bumpScan('ready');

    const autoRaw = process.env.URL_TO_ADS_AUTO_GENERATE;
    const autoOff =
      autoRaw != null
      && ['0', 'false', 'no', 'off'].includes(String(autoRaw).toLowerCase());
    if (!autoOff && !scan.adSetId) {
      const urlToAdsService = require('./urlToAdsService');
      const reqShim = {
        user: scan.userId
          ? { _id: scan.userId, id: scan.userId, role: 'user', plan: 'free' }
          : null,
        studioSessionId: scan.sessionId,
        cookies: {},
        headers: {},
      };
      setImmediate(() => {
        urlToAdsService
          .generateAds({ scanId: String(scan._id), req: reqShim, numVariants: 3, kind: 'image', generateCopy: false })
          .catch(async (e) => {
            console.error('[urlToAdsEnrichJob] auto-generate FAILED:', e?.code, e?.message);
            // Make the failure visible instead of leaving ads stuck at 'pending'
            await UrlToAdsScan.updateOne(
              { _id: scan._id, 'ads.status': 'pending' },
              { $set: { 'ads.$[].status': 'failed', 'ads.$[].errorMessage': e?.message || 'Auto-generate failed' } }
            ).catch(() => {});
          });
      });
    }

    return { ok: true, scanId: String(scan._id) };
  } catch (err) {
    console.error('[urlToAdsEnrichJob] fatal:', err.message);
    scan.status = 'ready';
    await scan.save().catch(() => {});
    bumpScan('ready');
    return { ok: false, scanId: String(scan._id), error: err.message };
  }
}

module.exports = { runScanEnrichmentJob };
