'use strict';

/**
 * Maps a brand-intel snapshot (Apify + scrape) into shapes the UrlToAds frontend
 * and Mongo UrlToAdsScan already understand: apifyData + competitor-style rows.
 *
 * Pure functions — safe in Jest without DB.
 */

const { normalizeAd } = require('../apify/actors/facebookAdsLibrary');

function _iso(d) {
  if (!d) return new Date().toISOString();
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

/**
 * One competitor row compatible with apifyData.competitorAds[] (pre-AI intelligence).
 *
 * @param {object} opts
 * @param {string} opts.competitor
 * @param {string|null} [opts.competitorUrl]
 * @param {object[]} [opts.rawItems] — Apify dataset items (pre-normalize)
 * @param {object|null} [opts.place] — normalized Google Place (optional)
 * @returns {object}
 */
function competitorAdsRowFromApifyItems({ competitor, competitorUrl = null, rawItems = [], place = null }) {
  const ads = (rawItems || []).map(normalizeAd).filter(Boolean);
  return {
    competitor: String(competitor || '').trim() || 'unknown',
    competitorUrl,
    ads,
    strategiesAttempted: [
      { rank: 1, approach: 'keyword_meta_ad_library', reasoning: 'Brand-intel snapshot keyword search' },
    ],
    successfulStrategy: ads.length ? 'keyword_meta_ad_library' : null,
    error: ads.length ? null : 'no_ads_found',
    errorReason: ads.length ? null : 'No items returned from Ad Library scrape for this keyword.',
    fetchedAt: _iso(),
    _source: 'brand_intel_snapshot',
    _place: place
      ? {
          name: place.name,
          website: place.website,
          rating: place.rating,
          categories: place.categories,
          socialUrls: place.socialUrls || {},
        }
      : null,
  };
}

/**
 * Strip intelligence block for a lighter API payload (optional).
 * @param {object} row
 * @returns {object}
 */
function stripIntelligenceFromAds(row) {
  if (!row || !Array.isArray(row.ads)) return row;
  return {
    ...row,
    ads: row.ads.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const { intelligence, ...rest } = a;
      return rest;
    }),
  };
}

/**
 * Build apifyData + flat competitorAds list from run-brand-intel-snapshot output.
 *
 * @param {object} snapshot — root object from run-brand-intel-snapshot.js
 * @returns {{ apifyData: object, competitorAds: object[], ownBrandAdsRow: object|null }}
 */
function buildApifyDataFromSnapshot(snapshot) {
  const rows = [];
  const ownBlock = snapshot?.metaAdLibraryApify?.ownBrand;
  const ownItems = ownBlock?.items || [];
  const brandName = snapshot?.website?.brandName || snapshot?.input?.mapsSearch || 'Brand';

  const ownRow = competitorAdsRowFromApifyItems({
    competitor: brandName,
    competitorUrl: snapshot?.input?.normalizedUrl || snapshot?.input?.url || null,
    rawItems: ownItems,
    place: null,
  });
  rows.push(ownRow);

  const compBlocks = snapshot?.metaAdLibraryApify?.competitors || [];
  for (const b of compBlocks) {
    const place = b.place || null;
    const label = place?.name || b.metaAdLibrary?.keyword || 'competitor';
    const items = b.metaAdLibrary?.items || [];
    rows.push(
      competitorAdsRowFromApifyItems({
        competitor: label,
        competitorUrl: place?.website || null,
        rawItems: items,
        place,
      }),
    );
  }

  const withVideo = rows.reduce((n, r) => n + (r.ads || []).filter((a) => a.mediaType === 'video' || a.hasPlayableVideo).length, 0);
  const summary = {
    totalAds: rows.reduce((n, r) => n + (r.ads || []).length, 0),
    withVideo,
    winners: 0,
    errors: rows.filter((r) => r.error).map((r) => ({ competitor: r.competitor, error: r.error })),
    adLibraryCountry: snapshot?.input?.country || 'US',
    generatedAt: snapshot?.generatedAt || _iso(),
  };

  const ig = snapshot?.socialApify?.instagram;
  const tt = snapshot?.socialApify?.tiktok;
  const places = snapshot?.googleMaps?.places;

  const apifyData = {
    competitorAds: rows,
    competitorAdsSummary: summary,
    instagramProfiles: ig && !ig.skipped && ig.items?.length ? [{ source: 'brand_intel', items: ig.items.slice(0, 3) }] : [],
    instagramTopPosts: ig && !ig.skipped && ig.items ? ig.items : [],
    tiktokProfiles: tt && !tt.skipped && tt.items?.length ? tt.items : [],
    googleMapsPlaces: Array.isArray(places) ? places : [],
    lastRefreshedAt: snapshot?.generatedAt || new Date(),
    _raw: {
      snapshotVersion: 1,
      meta: snapshot?.metaAdLibraryApify,
      social: snapshot?.socialApify,
    },
  };

  return {
    apifyData,
    competitorAds: rows,
    ownBrandAdsRow: ownRow,
  };
}

/**
 * Minimal scan-shaped document for mock API responses (matches urlToAdsController.serializeScan keys we care about).
 *
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {string} [opts.scanId]
 * @param {object|null} [opts.conclusion] — from creativeDirectorMock
 * @returns {object}
 */
function buildMockScanPayload(snapshot, opts = {}) {
  const scanId = opts.scanId || 'mock-scan';
  const { apifyData, competitorAds } = buildApifyDataFromSnapshot(snapshot);
  const w = snapshot?.website || {};

  return {
    id: scanId,
    url: snapshot?.input?.normalizedUrl || snapshot?.input?.url,
    host: w.host || null,
    status: 'ready',
    brand: {
      name: w.brandName,
      siteName: w.siteName,
      url: w.url,
      host: w.host,
      title: w.title,
      description: w.description,
      category: w.category,
      headlines: w.headlines,
      paragraphs: (w.paragraphs || []).slice(0, 6),
      images: w.images,
      favicon: w.favicon,
      socialHandles: w.socialHandles || {},
    },
    brandPalette: w.brandPalette || null,
    fonts: w.fonts || [],
    productCatalog: w.productCatalog || null,
    competitors: (snapshot?.googleMaps?.competitorPlacesUsedForAds || []).map((p) => ({
      name: p.name,
      url: p.website,
    })),
    competitorAds,
    apifyData,
    intelligence: opts.conclusion || null,
    research: null,
    ads: [],
    createdAt: snapshot?.generatedAt,
    updatedAt: snapshot?.generatedAt,
  };
}

module.exports = {
  normalizeAd,
  competitorAdsRowFromApifyItems,
  stripIntelligenceFromAds,
  buildApifyDataFromSnapshot,
  buildMockScanPayload,
};
