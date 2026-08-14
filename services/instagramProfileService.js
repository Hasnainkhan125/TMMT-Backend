'use strict';

/**
 * instagramProfileService.js
 *
 * Best-effort fetch of a public Instagram profile to seed the 60-second demo.
 *
 * Strategy:
 *   1. Try Instagram's web `?__a=1&__d=dis` JSON endpoint (still works for
 *      many public profiles when called with a Mobile UA + sec-fetch headers).
 *   2. If blocked / 404 / rate-limited, fall back to a minimal profile derived
 *      from the handle alone (so the demo still produces output).
 *
 * This is NOT a scraper for production-scale work — for that we'd swap in a
 * provider like Apify, RapidAPI's Instagram Scraper, or Meta's official
 * Business Discovery API. Those require keys; this works with zero config.
 */

const axios = require('axios');

const PROFILE_URL = (handle) =>
  `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;

const HEADERS = {
  'User-Agent': 'Instagram 219.0.0.12.117 Android',
  'X-IG-App-ID': '936619743392459',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
};

function cleanHandle(input = '') {
  return String(input)
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function fallbackProfile(handle) {
  const guessName = handle
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  return {
    handle,
    fullName: guessName || handle,
    biography: '',
    followers: null,
    isVerified: false,
    isBusiness: false,
    category: null,
    profilePicUrl: null,
    externalUrl: null,
    recentMediaUrls: [],
    fallback: true,
  };
}

/**
 * Public API.
 * @param {string} input  - handle, @handle, or profile URL
 * @returns {Promise<object>} normalised profile
 */
async function fetchProfile(input) {
  const handle = cleanHandle(input);
  if (!handle) throw new Error('Empty Instagram handle');

  try {
    const res = await axios.get(PROFILE_URL(handle), { headers: HEADERS, timeout: 8000 });
    const u = res.data?.data?.user;
    if (!u) return fallbackProfile(handle);

    const recent = (u.edge_owner_to_timeline_media?.edges || [])
      .slice(0, 6)
      .map((e) => e.node?.display_url)
      .filter(Boolean);

    return {
      handle,
      fullName:        u.full_name || handle,
      biography:       u.biography || '',
      followers:       u.edge_followed_by?.count ?? null,
      isVerified:      !!u.is_verified,
      isBusiness:      !!u.is_business_account,
      category:        u.category_name || u.business_category_name || null,
      profilePicUrl:   u.profile_pic_url_hd || u.profile_pic_url || null,
      externalUrl:     u.external_url || null,
      recentMediaUrls: recent,
      fallback:        false,
    };
  } catch (err) {
    console.warn(`[instagramProfileService] fetch failed for @${handle}: ${err.message}`);
    return fallbackProfile(handle);
  }
}

module.exports = { fetchProfile, cleanHandle };
