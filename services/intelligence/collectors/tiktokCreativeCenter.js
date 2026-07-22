'use strict';

/**
 * TikTokCreativeCenterCollector — surfaces TikTok trends relevant to a
 * competitor brand, via:
 *
 *   1. The brand's public TikTok profile HTML (bio, most-recent video
 *      captions, hashtags they use).
 *   2. TikTok Creative Center "keyword insights" scrape — top hashtags,
 *      trending sounds, and creator signals filtered by region.
 *
 * Creative Center (ads.tiktok.com/business/creativecenter) is publicly
 * accessible without auth, but the interesting data is loaded via
 * `/api/v1/*` fetches after hydration. We pattern-match those AJAX URLs
 * in the initial HTML and call them with a plain-fetch session.
 *
 * Graceful degradation: if any path fails we return the paths that did
 * succeed. The orchestrator's circuit breaker takes care of auto-pause.
 */

const { BaseCollector } = require('../sourceContract');
const { fetchHtml, fetchJson, sleep } = require('../httpFetch');

// Map our Gulf markets to TikTok Creative Center region codes.
const MARKET_TO_TIKTOK = {
  AE: 'AE',
  SA: 'SA',
  KW: 'KW',
  QA: 'QA',
  BH: 'BH',
  OM: 'OM',
  US: 'US',
  UK: 'GB',
  GB: 'GB',
};

class TikTokCreativeCenterCollector extends BaseCollector {
  constructor(opts = {}) {
    super('tiktok_creative_center', { reliability: 0.6, ...opts });
  }

  async collect(brandIdentity) {
    const handle = brandIdentity?.handles?.tiktokHandle;
    const brand = brandIdentity?.brandName;
    const market = brandIdentity?.markets?.[0] || 'AE';
    const region = MARKET_TO_TIKTOK[market.toUpperCase()] || 'AE';

    const out = {};
    let successes = 0;

    // Path 1: public profile page
    if (handle) {
      const profile = await this._fetchProfile(handle).catch(() => null);
      if (profile) {
        out.profile = profile;
        successes += 1;
      }
    }

    // Path 2: Creative Center trending hashtags
    if (brand) {
      const trends = await this._fetchTrendingHashtags(brand, region).catch(() => null);
      if (trends) {
        out.trendingHashtags = trends;
        successes += 1;
      }
    }

    // Path 3: Creative Center trending sounds
    if (brand) {
      const sounds = await this._fetchTrendingSounds(region).catch(() => null);
      if (sounds) {
        out.trendingSounds = sounds;
        successes += 1;
      }
    }

    if (!successes) return this.softFail('no_signal');
    return this.ok(out);
  }

  async _fetchProfile(handle) {
    try {
      const { html } = await fetchHtml(`https://www.tiktok.com/@${handle}`, {
        maxAttempts: 2,
        timeoutMs: 10000,
      });
      if (!html || html.length < 500) return null;
      const sig = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      const rehy = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      const blob = sig || rehy;
      if (blob) {
        try {
          const json = JSON.parse(blob);
          return extractTikTokProfileFromBlob(json, handle);
        } catch (_e) {
          // fall through to regex path
        }
      }
      return regexTikTokProfile(html, handle);
    } catch (err) {
      if (err?.code === 'blocked' || err?.code === 'fetch_timeout') throw err;
      return null;
    }
  }

  async _fetchTrendingHashtags(brand, region) {
    // The Creative Center keyword insights endpoint returns unauthenticated
    // JSON for trending hashtags in a region. Selector may change — we
    // include multiple candidate paths and accept the first that parses.
    const endpoints = [
      `https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=${region}&period=7`,
      `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list?period=7&page=1&limit=20&country_code=${region}`,
    ];

    for (const url of endpoints) {
      try {
        if (url.includes('/api/')) {
          const { json } = await fetchJson(url, { maxAttempts: 1, timeoutMs: 8000 });
          const list = json?.data?.list || json?.list || [];
          if (list.length) {
            return list.slice(0, 15).map((row) => ({
              hashtag: row.hashtag_name || row.name || null,
              postCount: row.publish_cnt || row.post_cnt || null,
              rank: row.rank || null,
              trend: row.trend || null,
            }));
          }
        } else {
          const { html } = await fetchHtml(url, { maxAttempts: 1, timeoutMs: 8000 });
          const parsed = extractTrendingFromHtml(html);
          if (parsed.length) return parsed;
        }
      } catch (_e) {
        await sleep(200);
      }
    }
    return null;
  }

  async _fetchTrendingSounds(region) {
    const endpoints = [
      `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/song/list?period=7&page=1&limit=15&country_code=${region}`,
    ];
    for (const url of endpoints) {
      try {
        const { json } = await fetchJson(url, { maxAttempts: 1, timeoutMs: 8000 });
        const list = json?.data?.list || json?.list || [];
        if (list.length) {
          return list.slice(0, 10).map((s) => ({
            title: s.title || s.song_name || null,
            author: s.author || null,
            duration: s.duration || null,
            rank: s.rank || null,
          }));
        }
      } catch (_e) {
        // try next
      }
    }
    return null;
  }
}

function extractTikTokProfileFromBlob(blob, handle) {
  // SIGI_STATE format used to expose `UserModule.users[handle]`. The newer
  // UNIVERSAL_DATA_FOR_REHYDRATION__ has a deeper shape under __DEFAULT_SCOPE__.
  const user =
    blob?.UserModule?.users?.[handle] ||
    blob?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user ||
    null;
  const stats =
    blob?.UserModule?.stats?.[handle] ||
    blob?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.stats ||
    null;

  const recentVideos = [];
  const itemList =
    blob?.ItemModule ||
    blob?.__DEFAULT_SCOPE__?.['webapp.video-list']?.itemList ||
    null;
  if (itemList) {
    const rows = Array.isArray(itemList) ? itemList : Object.values(itemList);
    for (const v of rows.slice(0, 15)) {
      if (!v || typeof v !== 'object') continue;
      recentVideos.push({
        caption: v.desc || v.title || null,
        playCount: v.stats?.playCount || v.play_count || null,
        diggCount: v.stats?.diggCount || v.digg_count || null,
        createTime: v.createTime || v.create_time || null,
      });
    }
  }

  return {
    handle,
    bio: user?.signature || null,
    followers: stats?.followerCount ?? null,
    following: stats?.followingCount ?? null,
    hearts: stats?.heartCount ?? null,
    verified: !!user?.verified,
    recentVideos,
  };
}

function regexTikTokProfile(html, handle) {
  const bio = html.match(/<meta name="description"[^>]+content="([^"]+)"/i)?.[1] || null;
  const followers = html.match(/"followerCount"\s*:\s*(\d+)/)?.[1];
  const hearts = html.match(/"heartCount"\s*:\s*(\d+)/)?.[1];
  const videoCaptions = [...html.matchAll(/"desc"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .slice(0, 8)
    .map((m) => m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'));
  return {
    handle,
    bio,
    followers: followers ? Number(followers) : null,
    hearts: hearts ? Number(hearts) : null,
    recentVideos: videoCaptions.map((caption) => ({ caption })),
  };
}

function extractTrendingFromHtml(html) {
  // Creative Center sometimes ships an initial JSON payload in a <script> tag.
  const m = html.match(/window\.__INIT_PROPS__\s*=\s*({[\s\S]*?});/);
  if (!m) return [];
  try {
    const blob = JSON.parse(m[1]);
    const list = blob?.props?.trendings || blob?.trendings || [];
    return list.slice(0, 15).map((row) => ({
      hashtag: row.hashtag_name || row.name,
      postCount: row.publish_cnt || null,
      rank: row.rank || null,
    }));
  } catch {
    return [];
  }
}

module.exports = { TikTokCreativeCenterCollector };
