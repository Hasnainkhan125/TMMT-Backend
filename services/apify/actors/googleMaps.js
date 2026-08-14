'use strict';

const { runActor } = require('../apifyClient');

const ACTOR_ID = 'compass/crawler-google-places';

/**
 * Pull social profile URLs from crawler-google-places item shape (field names
 * vary by actor version — we accept several aliases).
 */
function collectSocialUrls(raw) {
  const urls = {};
  const add = (canonical, val) => {
    if (val == null) return;
    const s = typeof val === 'string' ? val : val?.url || val?.href;
    if (typeof s !== 'string' || !/^https?:\/\//i.test(s)) return;
    urls[canonical] = s.split('?')[0].replace(/\/$/, '');
  };

  add('instagram', raw.instagram || raw.instagramUrl || raw.instagram_url);
  add('facebook', raw.facebook || raw.facebookUrl || raw.facebook_url || raw.fb);
  add('tiktok', raw.tiktok || raw.tiktokUrl || raw.tik_tok || raw.tikTok);
  add('youtube', raw.youtube || raw.youtubeUrl || raw.youTube);
  add('twitter', raw.twitter || raw.twitterUrl || raw.x || raw.xUrl);
  add('linkedin', raw.linkedin || raw.linkedIn || raw.linkedinUrl);

  const sm = raw.socialMedia || raw.socials || raw.socialMediaUrls || raw.links;
  if (sm && typeof sm === 'object' && !Array.isArray(sm)) {
    for (const [k, v] of Object.entries(sm)) {
      const key = String(k).toLowerCase();
      if (key.includes('instagram')) add('instagram', v);
      else if (key.includes('facebook') || key === 'fb') add('facebook', v);
      else if (key.includes('tiktok')) add('tiktok', v);
      else if (key.includes('youtube') || key === 'yt') add('youtube', v);
      else if (key.includes('twitter') || key === 'x') add('twitter', v);
      else if (key.includes('linkedin')) add('linkedin', v);
    }
  }

  if (Array.isArray(raw.contacts)) {
    for (const c of raw.contacts) {
      if (!c || typeof c !== 'object') continue;
      add('instagram', c.instagram);
      add('facebook', c.facebook);
      add('tiktok', c.tiktok);
    }
  }

  return urls;
}

/**
 * Normalize Google Maps review payloads from compass/crawler-google-places (field names vary).
 */
function normalizeReviews(raw, maxReviews = 30) {
  if (!raw || typeof raw !== 'object') return [];
  const buckets = [
    raw.reviews,
    raw.reviewsList,
    raw.reviewRecords,
    raw.customerReviews,
    raw.placeReviews,
  ].filter(Array.isArray);
  const seen = new Set();
  const out = [];
  for (const arr of buckets) {
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      const text = String(r.text || r.reviewText || r.snippet || r.description || '').trim();
      const rating = Number(r.stars || r.rating || r.score || r.totalScore);
      const author = String(r.name || r.reviewer || r.author || r.reviewerName || '').trim();
      const publishedAt = r.publishedAtDate || r.date || r.time || r.relativeTime || null;
      const key = `${text.slice(0, 96)}|${author}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: text.slice(0, 4000),
        rating: Number.isFinite(rating) ? rating : null,
        author: author.slice(0, 200),
        publishedAt,
      });
      if (out.length >= maxReviews) return out;
    }
  }
  return out;
}

function normalizePlace(raw) {
  const socialUrls = collectSocialUrls(raw || {});
  return {
    placeId: String(raw.placeId || raw.place_id || raw.cid || raw.id || ''),
    name: String(raw.title || raw.name || ''),
    address: String(raw.address || raw.formattedAddress || ''),
    phone: raw.phone || raw.phoneNumber || null,
    website: raw.website || raw.url || null,
    rating: Number(raw.totalScore || raw.rating || raw.stars) || null,
    reviewsCount: Number(raw.reviewsCount || raw.reviews || 0) || 0,
    categories: []
      .concat(raw.categoryName || raw.categories || raw.types || [])
      .flat()
      .filter(Boolean)
      .map(String)
      .slice(0, 12),
    openingHours: raw.openingHours || raw.regularOpeningHours || null,
    socialUrls,
    reviews: normalizeReviews(raw || {}, 30),
  };
}

/**
 * @param {{
 *   searchStringsArray: string[],
 *   maxCrawledPlacesPerSearch?: number,
 *   locationQuery?: string
 * }} input
 * @param {{ timeoutSecs?: number, memoryMbytes?: number }} [runOpts] — tighter budgets for supplemental runs
 */
async function fetchGoogleMapsPlaces(input, runOpts = {}) {
  const searchStringsArray = (input.searchStringsArray || []).filter(Boolean);
  if (!searchStringsArray.length) return [];

  const apifyInput = {
    searchStringsArray,
    maxCrawledPlacesPerSearch: Math.min(
      Math.max(Number(input.maxCrawledPlacesPerSearch) || 20, 1),
      50,
    ),
    locationQuery: input.locationQuery || 'UAE',
    ...(input.scrapeReviews || input.maxReviews
      ? {
          maxReviews: Math.min(Math.max(Number(input.maxReviews) || 15, 1), 50),
          scrapeReviews: input.scrapeReviews !== false,
        }
      : {}),
  };

  const timeoutSecs = Number(runOpts.timeoutSecs) > 0 ? runOpts.timeoutSecs : 300;
  const memoryMbytes = Number(runOpts.memoryMbytes) > 0 ? runOpts.memoryMbytes : 2048;

  const { items } = await runActor(ACTOR_ID, apifyInput, { timeoutSecs, memoryMbytes });
  return (items || []).map(normalizePlace);
}

module.exports = {
  fetchGoogleMapsPlaces,
  ACTOR_ID,
  normalizePlace,
  normalizeReviews,
  collectSocialUrls,
};
