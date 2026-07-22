#!/usr/bin/env node
'use strict';

/**
 * One-shot brand + competitor intelligence snapshot → JSON.
 *
 * Uses the same Apify path as 04-facebook-ads.js (disk cache in scripts/apify/output/).
 *
 * Usage:
 *   node scripts/apify/run-brand-intel-snapshot.js --url https://example.com --out ./tmp/brand-intel.json
 *   node scripts/apify/run-brand-intel-snapshot.js --url shilajitenergydrinks.com --country US --location "United States"
 *   node scripts/apify/run-brand-intel-conclude-mock.js --snapshot ./tmp/brand-intel.json
 *
 * Defaults: Meta Ad Library country US (global). Maps locationQuery US unless overridden.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { runActor: runApifyDisk, parseFlags } = require('./lib/runner');
const { scrapeUrl } = require('../../services/urlScraper');
const { fetchGoogleMapsPlaces } = require('../../services/apify/actors/googleMaps');
const { facebookAdsMemoryMbytesForInput } = require('../../services/apify/actors/buildAdLibraryUrl');
const {
  ACTORS,
  buildGooglePlacesInput,
  buildInstagramScraperInput,
  buildTikTokProfileInput,
  buildFacebookAdsLibraryInput,
} = require('./lib/actorInputs');

const FB_ACTOR_ID = process.env.APIFY_FB_ADS_ACTOR || 'curious_coder/facebook-ads-library-scraper';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hostnameNorm(u) {
  try {
    const h = new URL(u.startsWith('http') ? u : `https://${u}`).hostname.toLowerCase();
    return h.replace(/^www\./, '');
  } catch (_e) {
    return '';
  }
}

function placeWebsiteHost(place) {
  const w = place && place.website;
  if (!w || typeof w !== 'string') return '';
  return hostnameNorm(w);
}

function instagramProfileUrl(handles) {
  const u = handles && handles.instagramUrl;
  if (u && /^https?:\/\//i.test(u)) return u.split('?')[0].replace(/\/$/, '') + '/';
  const h = handles && handles.instagramHandle;
  if (h && String(h).replace('@', '').length > 1) {
    return `https://www.instagram.com/${String(h).replace(/^@/, '')}/`;
  }
  return null;
}

function tiktokHandle(handles) {
  const u = handles && handles.tiktokUrl;
  if (u && /tiktok\.com\/@([^/?]+)/i.test(u)) {
    return RegExp.$1;
  }
  const h = handles && handles.tiktokHandle;
  if (h) return String(h).replace(/^@/, '');
  return null;
}

function sanitizeScrapeForExport(scrape) {
  if (!scrape || typeof scrape !== 'object') return scrape;
  const {
    url,
    host,
    origin,
    status,
    truncated,
    scrapedAt,
    brandName,
    siteName,
    title,
    description,
    category,
    favicon,
    headlines,
    paragraphs,
    ctas,
    images,
    fonts,
    brandPalette,
    socialHandles,
    productCatalog,
    competitorAds,
    _enrichmentErrors,
    _cacheLayer,
  } = scrape;
  return {
    url,
    host,
    origin,
    status,
    truncated,
    scrapedAt,
    brandName,
    siteName,
    title,
    description,
    category,
    favicon,
    headlines,
    paragraphs,
    ctas,
    images,
    fonts,
    brandPalette,
    socialHandles,
    productCatalog,
    metaCompetitorAdsFromToken: competitorAds,
    _enrichmentErrors,
    _cacheLayer,
  };
}

function mapDiskActorResult(res, extra = {}) {
  if (!res || typeof res !== 'object') return { error: 'no_result', ...extra };
  return {
    ...extra,
    runId: res.runId,
    durationMs: res.durationMs,
    itemCount: res.itemCount,
    items: res.items || [],
    input: res.input,
  };
}

async function runFacebookAdsKeyword({ keyword, country, count, mediaType, activeStatus, fresh }) {
  const input = buildFacebookAdsLibraryInput({
    keyword: String(keyword).trim(),
    country,
    count,
    mediaType,
    activeStatus,
  });
  const memoryMbytes = facebookAdsMemoryMbytesForInput(input, FB_ACTOR_ID);
  const res = await runApifyDisk({
    step: 'brand-intel-fb-ads',
    actorId: FB_ACTOR_ID,
    input,
    memoryMbytes,
    timeoutSecs: 600,
    fresh,
  });
  return mapDiskActorResult(res, { keyword, memoryMbytes });
}

async function runInstagramIfPossible(handles, { resultsLimit, fresh }) {
  const profileUrl = instagramProfileUrl(handles);
  if (!profileUrl) return { skipped: true, reason: 'no_instagram_handle' };
  const input = buildInstagramScraperInput({
    directUrls: [profileUrl],
    resultsLimit,
    resultsType: 'posts',
  });
  const res = await runApifyDisk({
    step: 'brand-intel-ig',
    actorId: ACTORS.INSTAGRAM_SCRAPER,
    input,
    memoryMbytes: 2048,
    timeoutSecs: 600,
    fresh,
  });
  return mapDiskActorResult(res, { profileUrl });
}

async function runTikTokIfPossible(handles, { resultsPerPage, fresh }) {
  const h = tiktokHandle(handles);
  if (!h) return { skipped: true, reason: 'no_tiktok_handle' };
  const input = buildTikTokProfileInput({ profiles: [h], resultsPerPage });
  const res = await runApifyDisk({
    step: 'brand-intel-tiktok',
    actorId: ACTORS.TIKTOK,
    input,
    memoryMbytes: 2048,
    timeoutSecs: 420,
    fresh,
  });
  return mapDiskActorResult(res, { handle: h });
}

async function main() {
  const flags = parseFlags(process.argv);
  const rawUrl = flags.url;
  if (!rawUrl) {
    console.error('Usage: node scripts/apify/run-brand-intel-snapshot.js --url https://brand.com [--out path] [--fresh]');
    process.exit(1);
  }

  const country = String(flags.country || 'US');
  const locationQuery = String(flags.location || 'United States');
  const mapsLimit = Math.min(Math.max(Number(flags['maps-limit'] || 20), 1), 50);
  const fbCount = Math.min(Math.max(Number(flags['fb-count'] || 40), 1), 200);
  const maxCompetitors = Math.min(Math.max(Number(flags.competitors ?? 5), 0), 15);
  const igLimit = Math.min(Math.max(Number(flags['ig-limit'] || 30), 1), 200);
  const tiktokRpp = Math.min(Math.max(Number(flags['tiktok-results'] || 20), 5), 40);
  const fresh = !!flags.fresh;
  const mediaType = flags.mediaType || 'all';
  const activeStatus = flags.activeStatus || 'all';
  const mapsQuery = (flags['maps-query'] && String(flags['maps-query']).trim()) || null;

  const ownHost = hostnameNorm(rawUrl);
  const generatedAt = new Date().toISOString();

  const scrape = await scrapeUrl(rawUrl, {
    skipCache: fresh,
    only: ['palette', 'products'],
    includeHtml: false,
  });

  const mapsSearch = mapsQuery || scrape.brandName || scrape.title || ownHost;
  let googleMapsPlaces = [];
  try {
    const placesInput = buildGooglePlacesInput({
      searchStrings: mapsSearch,
      locationQuery,
      maxCrawledPlacesPerSearch: mapsLimit,
      scrapeReviews: !!flags['maps-reviews'],
      maxReviews: Number(flags['maps-max-reviews'] || 12),
    });
    googleMapsPlaces = await fetchGoogleMapsPlaces(placesInput, {
      timeoutSecs: 360,
      memoryMbytes: 2048,
    });
  } catch (err) {
    googleMapsPlaces = { error: err.message || String(err) };
  }

  const placesArr = Array.isArray(googleMapsPlaces) ? googleMapsPlaces : [];
  const ownPlaceCandidates = placesArr.filter((p) => placeWebsiteHost(p) === ownHost);
  const competitorPlaces = placesArr
    .filter((p) => {
      const ph = placeWebsiteHost(p);
      return ph && ph !== ownHost;
    })
    .slice(0, maxCompetitors);

  let ownBrandAds = { error: 'skipped' };
  try {
    ownBrandAds = await runFacebookAdsKeyword({
      keyword: scrape.brandName || mapsSearch,
      country,
      count: fbCount,
      mediaType,
      activeStatus,
      fresh,
    });
    await sleep(1200);
  } catch (err) {
    ownBrandAds = { error: err.message || String(err) };
  }

  const competitorAds = [];
  for (let i = 0; i < competitorPlaces.length; i++) {
    const p = competitorPlaces[i];
    const label = p.name || placeWebsiteHost(p) || `competitor_${i + 1}`;
    try {
      const block = await runFacebookAdsKeyword({
        keyword: label,
        country,
        count: fbCount,
        mediaType,
        activeStatus,
        fresh,
      });
      competitorAds.push({
        source: 'google_maps_place',
        place: {
          name: p.name,
          address: p.address,
          website: p.website,
          rating: p.rating,
          categories: p.categories,
          socialUrls: p.socialUrls,
        },
        metaAdLibrary: block,
      });
      await sleep(1200);
    } catch (err) {
      competitorAds.push({
        source: 'google_maps_place',
        place: { name: p.name, website: p.website },
        metaAdLibrary: { error: err.message || String(err) },
      });
    }
  }

  const handles = scrape.socialHandles || {};
  let instagram = { skipped: true };
  let tiktok = { skipped: true };
  try {
    instagram = await runInstagramIfPossible(handles, { resultsLimit: igLimit, fresh });
    await sleep(800);
  } catch (err) {
    instagram = { error: err.message || String(err) };
  }
  try {
    tiktok = await runTikTokIfPossible(handles, { resultsPerPage: tiktokRpp, fresh });
  } catch (err) {
    tiktok = { error: err.message || String(err) };
  }

  const snapshot = {
    generatedAt,
    input: {
      url: rawUrl,
      normalizedUrl: scrape.url,
      country,
      locationQuery,
      mapsSearch,
      maxCompetitors,
      mediaType,
      activeStatus,
    },
    website: sanitizeScrapeForExport(scrape),
    googleMaps: {
      places: placesArr,
      ownPlaceCandidates,
      competitorPlacesUsedForAds: competitorPlaces,
    },
    socialApify: {
      instagram,
      tiktok,
    },
    metaAdLibraryApify: {
      ownBrand: ownBrandAds,
      competitors: maxCompetitors > 0 ? competitorAds : [],
    },
  };

  const json = JSON.stringify(snapshot, null, 2);
  const outPath = flags.out;
  if (outPath) fs.writeFileSync(path.resolve(outPath), json, 'utf8');
  console.log(json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
