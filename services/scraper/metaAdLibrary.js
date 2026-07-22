'use strict';

/**
 * metaAdLibrary — fetch a brand's (or competitor's) currently running
 * Meta (Facebook/Instagram) ads.
 *
 * Public, legal data source: https://www.facebook.com/ads/library
 *
 * Two execution paths, picked at runtime per call:
 *
 *   A. Graph API — when META_AD_LIBRARY_TOKEN is configured.
 *      Hits /ads_archive directly. Structured JSON, reliable, subject to
 *      Meta's verification + approved-app rate limits. Preferred.
 *
 *   B. Apify fallback — when APIFY_API_TOKEN is configured.
 *      Calls curious_coder/facebook-ads-library-scraper through the shared
 *      services/apify/apifyClient runActor wrapper. Lossier than Graph but
 *      doesn't require an approved app. Good enough for the URL→Ads
 *      "competitor reference" rail.
 *
 * fetchMetaAds       — single-brand, Graph API only.
 * fetchCompetitorAds — brand + a list of competitor brands; tries Graph for
 *                      each, falls back to Apify per-brand on miss.
 *
 * Failure policy: NEVER throws upward. Every failure path returns either
 * `null` (fetchMetaAds) or an empty `ads: []` (fetchCompetitorAds). The
 * URL→Ads scan flow swallows these gracefully — bad creds, rate limits,
 * or actor errors must never crash a scan.
 *
 * Env vars consumed:
 *   META_AD_LIBRARY_TOKEN   — Graph API access token (preferred)
 *   APIFY_API_TOKEN         — Apify token (fallback)
 *   APIFY_FB_ADS_ACTOR      — override actor id (default curious_coder/...)
 */

const FETCH_TIMEOUT_MS = 8000;
const APIFY_ACTOR_ID =
  process.env.APIFY_FB_ADS_ACTOR || 'curious_coder/facebook-ads-library-scraper';

// ──────────────────────────────────────────────────────────────────────────
// Path A — Graph API (single brand)
// ──────────────────────────────────────────────────────────────────────────

async function fetchMetaAds({
  brandName,
  category = null,
  countries = ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'],
  limit = 10,
}) {
  if (!process.env.META_AD_LIBRARY_TOKEN) {
    return null; // Gracefully disabled if no token configured
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({
      search_terms: brandName,
      ad_reached_countries: JSON.stringify(countries),
      ad_active_status: 'ALL',
      ad_type: 'ALL',
      limit: String(Math.min(limit, 25)),
      fields: [
        'id',
        'ad_creative_bodies',
        'ad_creative_link_titles',
        'ad_creative_link_captions',
        'ad_creative_link_descriptions',
        'ad_delivery_start_time',
        'ad_delivery_stop_time',
        'ad_snapshot_url',
        'page_name',
        'publisher_platforms',
        'languages',
        'estimated_audience_size',
        'impressions',
        'spend',
      ].join(','),
      access_token: process.env.META_AD_LIBRARY_TOKEN,
    });

    const url = `https://graph.facebook.com/v19.0/ads_archive?${params.toString()}`;
    const resp = await fetch(url, { signal: controller.signal });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn('[metaAdLibrary] non-OK response:', resp.status, text.slice(0, 200));
      return null;
    }

    const data = await resp.json();
    const ads = data?.data || [];

    return {
      searchTerm: brandName,
      countries,
      totalFound: ads.length,
      fetchedAt: new Date().toISOString(),
      ads: ads
        .map((ad) => ({
          id: ad.id,
          pageName: ad.page_name,
          body: ad.ad_creative_bodies?.[0] || '',
          headline: ad.ad_creative_link_titles?.[0] || '',
          cta: ad.ad_creative_link_captions?.[0] || '',
          description: ad.ad_creative_link_descriptions?.[0] || '',
          snapshotUrl: ad.ad_snapshot_url,
          platforms: ad.publisher_platforms || [],
          languages: ad.languages || [],
          firstSeen: ad.ad_delivery_start_time,
          lastSeen: ad.ad_delivery_stop_time,
          estimatedImpressions: normalizeImpressionsRange(ad.impressions),
          estimatedSpendRange: ad.spend,
        }))
        .sort(
          (a, b) => (b.estimatedImpressions || 0) - (a.estimatedImpressions || 0),
        ),
    };
  } catch (err) {
    console.warn('[metaAdLibrary] fetch failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeImpressionsRange(imp) {
  if (!imp) return null;
  const lower = parseInt(imp.lower_bound, 10) || 0;
  const upper = parseInt(imp.upper_bound, 10) || lower * 2;
  return Math.floor((lower + upper) / 2);
}

// ──────────────────────────────────────────────────────────────────────────
// URL builder — modern Ad Library params (active_status, ad_type, media_type,
// country, q OR view_all_page_id, search_type)
// ──────────────────────────────────────────────────────────────────────────

function buildAdLibraryUrl({ brandName, country = 'AE', pageId = null }) {
  const p = new URLSearchParams();
  p.set('active_status', 'all');
  p.set('ad_type', 'all');
  p.set('media_type', 'all');
  p.set('country', country || 'AE');
  if (pageId) {
    p.set('search_type', 'page');
    p.set('view_all_page_id', String(pageId));
  } else {
    p.set('search_type', 'keyword_unordered');
    p.set('q', brandName || '');
  }
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Path B — Apify fallback. Returns raw items[] or [] on any failure.
// ──────────────────────────────────────────────────────────────────────────

async function fetchViaApify({ brandName, country, pageId, limit = 100 }) {
  if (!process.env.APIFY_API_TOKEN) return [];
  // Lazy require so this module loads cleanly when the apify client is
  // unavailable (e.g. test runs without redis/apify deps wired).
  let runActor;
  try {
    ({ runActor } = require('../apify/apifyClient'));
  } catch (e) {
    console.warn('[metaAdLibrary] apifyClient not available:', e.message);
    return [];
  }

  const url = buildAdLibraryUrl({ brandName, country, pageId });
  const input = {
    count: Math.min(limit, 100),
    scrapeAdDetails: true,
    'scrapePageAds.activeStatus': 'all',
    'scrapePageAds.countryCode': country,
    'scrapePageAds.sortBy': 'impressions_desc',
    'scrapePageAds.period': '',
    urls: [{ url }],
  };

  try {
    const result = await runActor(APIFY_ACTOR_ID, input, {
      timeoutSecs: 180,
      memoryMbytes: 512,
      cacheTTL: 21600,
    });
    return Array.isArray(result?.items) ? result.items : [];
  } catch (err) {
    console.warn(
      '[metaAdLibrary] Apify fetch failed for',
      brandName,
      ':',
      err.message,
    );
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Normalize a single ad to the shape the URL→Ads frontend / merge layer
// expects. We accept either Graph-API rows or Apify rows and emit a stable
// shape with: id, pageName, firstSeen, lastSeen, body, cta, mediaType,
// imageUrl, videoUrl, landingUrl, daysActive, isLongRunning.
// ──────────────────────────────────────────────────────────────────────────

function diffDays(start, end) {
  if (!start) return 0;
  const s = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(s.getTime())) return 0;
  const e = end ? (end instanceof Date ? end : new Date(end)) : new Date();
  if (Number.isNaN(e.getTime())) return 0;
  return Math.max(0, Math.floor((e - s) / 86400000));
}

function normalizeGraphAd(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = raw.firstSeen || raw.ad_delivery_start_time || null;
  const end = raw.lastSeen || raw.ad_delivery_stop_time || null;
  const daysActive = diffDays(start, end);
  return {
    id: raw.id || null,
    pageName: raw.pageName || raw.page_name || null,
    body: raw.body || raw.ad_creative_bodies?.[0] || '',
    headline: raw.headline || raw.ad_creative_link_titles?.[0] || '',
    cta: raw.cta || raw.ad_creative_link_captions?.[0] || null,
    mediaType: 'unknown',
    imageUrl: null,
    videoUrl: null,
    landingUrl: raw.snapshotUrl || raw.ad_snapshot_url || null,
    firstSeen: start || null,
    lastSeen: end || null,
    daysActive,
    isLongRunning: daysActive > 30,
    source: 'graph_api',
  };
}

function normalizeApifyAd(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = raw.start_date ? new Date(raw.start_date * 1000) : null;
  const endedAt = raw.end_date ? new Date(raw.end_date * 1000) : null;
  const daysActive = startedAt ? diffDays(startedAt, endedAt) : 0;

  const videoArr = Array.isArray(raw.snapshot?.videos) ? raw.snapshot.videos : [];
  const singleVideo =
    raw.snapshot?.video && typeof raw.snapshot.video === 'object'
      ? [raw.snapshot.video]
      : [];
  const videos = [...videoArr, ...singleVideo];

  const imageArr = Array.isArray(raw.snapshot?.images) ? raw.snapshot.images : [];
  const singleImage =
    raw.snapshot?.image && typeof raw.snapshot.image === 'object'
      ? [raw.snapshot.image]
      : [];
  const images = [...imageArr, ...singleImage];

  const cards = Array.isArray(raw.snapshot?.cards) ? raw.snapshot.cards : [];

  const mediaType =
    cards.length > 0
      ? 'carousel'
      : videos.length > 0
        ? 'video'
        : images.length > 0
          ? 'image'
          : 'unknown';

  const firstVideo = videos[0] || null;
  const firstImage = images[0] || null;

  const ad = {
    id: raw.ad_archive_id || raw.id || null,
    pageName: raw.page_name || raw.snapshot?.page_name || null,
    page_id: raw.page_id || raw.snapshot?.page_id || null,
    page_url: raw.page_url || raw.snapshot?.page_url || null,
    page_profile_picture_url: raw.page_profile_picture_url || raw.snapshot?.page_profile_picture_url || null,
    page_category: raw.page_category || raw.snapshot?.page_category || null,
    page_verification: raw.page_verification || raw.snapshot?.page_verification || null,
    body: raw.snapshot?.body?.text || '',
    headline: raw.snapshot?.title || '',
    cta: raw.snapshot?.cta_text || raw.snapshot?.cta_type || null,
    mediaType,
    imageUrl:
      firstImage?.original_image_url ||
      firstImage?.resized_image_url ||
      firstImage?.url ||
      null,
    videoUrl: firstVideo?.video_hd_url || firstVideo?.video_sd_url || null,
    landingUrl: raw.snapshot?.link_url || null,
    firstSeen: startedAt ? startedAt.toISOString() : null,
    lastSeen: endedAt ? endedAt.toISOString() : null,
    daysActive,
    isLongRunning: daysActive > 30,
    source: 'apify',
  };

  // Drop empty ghost rows that occasionally come back from the actor.
  if (
    !ad.id &&
    !ad.body &&
    !ad.headline &&
    !ad.imageUrl &&
    !ad.videoUrl &&
    !cards.length
  ) {
    return null;
  }
  return ad;
}

// ──────────────────────────────────────────────────────────────────────────
// fetchCompetitorAds — brand + competitors, with both paths
//
// Signature preserved (URL scraper + intelligence collector both call this):
//   { brandName, category, competitorBrands?, countries }
//
// Returns:
//   {
//     competitor: brandName,           // legacy field name from old shape
//     ads: [...flat list of brand+competitor ads],   // primary consumer payload
//     own: { ads: [...] } | null,
//     competitors: [{ competitor: name, ads: [...] }, ...],
//     totalAdsAnalyzed: number,
//     reason?: string                  // populated when no creds configured
//   }
//
// Each ad row in `ads`/`competitors[].ads` carries the documented shape:
//   id, pageName, firstSeen, lastSeen, body, headline, cta, mediaType,
//   imageUrl, videoUrl, landingUrl, daysActive, isLongRunning, source.
// ──────────────────────────────────────────────────────────────────────────


async function fetchAdsByKeyword({
  keywords,
  countries = ['AE'],
  limit = 50,
}) {
  const hasApify = !!process.env.APIFY_API_TOKEN;

  const empty = {
    keywords: [],
    ads: [],
    totalAdsFound: 0,
  };

  const keywordList = Array.isArray(keywords)
    ? keywords.filter(Boolean)
    : [keywords].filter(Boolean);

  if (!keywordList.length) {
    return { ...empty, reason: 'no_keywords' };
  }

  if (!hasApify) {
    return { ...empty, reason: 'no_credentials' };
  }

  const country =
    Array.isArray(countries) && countries.length ? countries[0] : 'AE';

  async function fetchOneKeyword(keyword) {



    if (hasApify) {
      try {
        const ads = await fetchViaApify({
          brandName: keyword, 
          country,
          limit,
        });

        return ads
        // .map(normalizeApifyAd)
        // .filter(Boolean)
        // .map((ad) => ({ ...ad, keyword }));
      } catch (e) {
        console.warn(
          '[metaAdLibrary] apify keyword search failed:',
          keyword,
          e.message,
        );
      }
    }

    return [];
  }

  const results = await Promise.all(
    keywordList.map(async (keyword) => {
      try {
        const ads = await fetchOneKeyword(keyword);

        console.log(
          '[metaAdLibrary] keyword:',
          keyword,
          '-',
          ads.length,
          'ads',
        );

        return {
          keyword,
          ads,
        };
      } catch (e) {
        return {
          keyword,
          ads: [],
        };
      }
    }),
  );

  const ads = results.flatMap((r) => r.ads);

  return {
    keywords: keywordList,
    ads,
    results,
    totalAdsFound: ads.length,
  };
}


async function fetchCompetitorAds({
  brandName,
  category = null,
  competitorBrands = [],
  countries = ['AE'],
  pageId = null,
}) {
  const hasGraph = !!process.env.META_AD_LIBRARY_TOKEN;
  const hasApify = !!process.env.APIFY_API_TOKEN;

  const empty = {
    competitor: brandName,
    ads: [],
    own: null,
    competitors: [],
    totalAdsAnalyzed: 0,
  };

  if (!brandName && (!Array.isArray(competitorBrands) || !competitorBrands.length)) {
    return { ...empty, reason: 'no_brand_input' };
  }

  if (!hasGraph && !hasApify) {
    return { ...empty, reason: 'no_credentials' };
  }

  const country =
    Array.isArray(countries) && countries.length ? countries[0] : 'AE';
  const PER_BRAND_LIMIT = 10;

  async function fetchOneBrand(name, pageId = null) {
    if (!name && !pageId) return [];

    // Graph API first
    if (hasGraph && name) {
      try {
        const r = await fetchMetaAds({
          brandName: name,
          countries,
          limit: PER_BRAND_LIMIT,
        });
        const list = (r && r.ads) || [];
        const norm = list.map(normalizeGraphAd).filter(Boolean);
        if (norm.length) return norm;
      } catch (e) {
        console.warn('[metaAdLibrary] graph failed for', name, ':', e.message);
      }
    }

    // Apify fallback
    if (hasApify) {
      const items = await fetchViaApify({
        brandName: name,
        country,
        pageId,
        limit: PER_BRAND_LIMIT,
      });
      return items;
      // .map(normalizeApifyAd).filter(Boolean);
    }

    return [];
  }

  

  // Up to 5 competitor brands. Accept either string names or objects with
  // { name, pageId, url }. Each fetch is independent — failures do not
  // poison sibling fetches.
  const compInputs = (Array.isArray(competitorBrands) ? competitorBrands : [])
    .slice(0, 5)
    .map((c) => {
      if (!c) return null;
      if (typeof c === 'string') return { name: c, pageId: null };
      return {
        name: c.name || c.brand || c.title || '',
        pageId: c.pageId || c.facebookPageId || null,
      };
    })
    .filter((c) => c && c.name);

  // const competitorResults = [];
  // for (const c of compInputs) {
  //   try {
  //     const ads = await fetchOneBrand(c.name, c.pageId);
  //     competitorResults.push({ competitor: c.name, ads });
  //   } catch (e) {
  //     console.warn(
  //       '[metaAdLibrary] competitor fetch failed:',
  //       c.name,
  //       e.message,
  //     );
  //     competitorResults.push({ competitor: c.name, ads: [] });
  //   }
  // }

  const competitorResults = await Promise.all(
    compInputs.map(async (c) => {
      try {
        const ads = await fetchOneBrand(c.name, c.pageId);
        console.log('[metaAdLibrary] ✅', c.name, ':', ads.length, 'ads');
        return { competitor: c.name, ads };
      } catch (e) {
        console.warn('[metaAdLibrary] ❌', c.name, ':', e.message);
        return { competitor: c.name, ads: [] };
      }
    })
  );

  // Brand's own ads — silently empty on failure
  let ownAds = [];
  try {
    ownAds = await fetchOneBrand(brandName, pageId);
  } catch (e) {
    console.warn(
      '[metaAdLibrary] own brand fetch crashed:',
      brandName,
      e.message,
    );
    ownAds = [];
  }

  // Flat list combines brand + competitors so legacy consumers (urlScraper,
  // intelligence collector) keep getting a single `ads` array. Cap the flat
  // list at ~30 so payloads stay reasonable even with many competitors.
  const flatAds = [
    ...competitorResults.flatMap((r) => r.ads || []),
  ].slice(0, 50);

  return {
    competitor: brandName,
    ads: flatAds,
    own: ownAds.length
      ? {
          searchTerm: brandName,
          countries,
          ads: ownAds,
          totalFound: ownAds.length,
        }
      : null,
    competitors: competitorResults,
    totalAdsAnalyzed:
      ownAds.length +
      competitorResults.reduce((sum, r) => sum + (r.ads?.length || 0), 0),
  };
}

module.exports = {
  fetchMetaAds,
  fetchCompetitorAds,
  fetchAdsByKeyword,
  // exported for test harnesses
  fetchViaApify,
  normalizeApifyAd,
  _internal: {
    buildAdLibraryUrl,
    normalizeGraphAd,
    normalizeApifyAd,
    fetchViaApify,
  },
};
