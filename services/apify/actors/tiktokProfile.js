'use strict';

const { runActor } = require('../apifyClient');

const ACTOR_ID = 'clockworks/tiktok-scraper';

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function normalize(input, items) {
  const wantUser = String(input.profiles?.[0] || '').replace(/^@/, '');
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return {
      username: wantUser,
      followerCount: 0,
      totalLikes: 0,
      avgViews: 0,
      topVideos: [],
    };
  }

  const first = list[0];
  const author =
    first.authorMeta || first.author || first.authorStats || first.userInfo || first;
  const username = String(
    author.name || author.uniqueId || author.nickname || wantUser || '',
  ).replace(/^@/, '');

  const topVideos = list.slice(0, 10).map((v) => ({
    videoId: String(v.id || v.videoId || ''),
    description: String(v.text || v.desc || v.description || '').slice(0, 500),
    viewCount: num(v.playCount ?? v.views ?? v.stats?.playCount),
    likeCount: num(v.diggCount ?? v.likes ?? v.stats?.diggCount),
    musicName: String(v.musicMeta?.musicName || v.music?.title || ''),
    hashtags: []
      .concat(v.hashtags || [], (v.text || '').match(/#[\w]+/g) || [])
      .map((h) => String(h).replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 20),
  }));

  const followerCount = num(
    author.followerCount ?? author.fans ?? author.followers ?? first.followerCount,
  );
  const totalLikes = num(author.heart ?? author.heartCount ?? author.digg);
  const views = topVideos.map((t) => t.viewCount).filter((v) => v > 0);
  const avgViews = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return {
    username,
    followerCount,
    totalLikes,
    avgViews,
    topVideos,
  };
}

/**
 * @param {{ profiles: string[], resultsPerPage?: number }} input
 */
async function fetchTiktokProfile(input) {
  const profiles = (input.profiles || []).map((p) => String(p).replace(/^@/, '')).filter(Boolean);
  if (!profiles.length) return null;

  const apifyInput = {
    profiles,
    resultsPerPage: Math.min(Math.max(Number(input.resultsPerPage) || 20, 5), 40),
  };

  const { items } = await runActor(ACTOR_ID, apifyInput, { timeoutSecs: 180, memoryMbytes: 2048 });
  return normalize({ profiles }, items);
}

module.exports = { fetchTiktokProfile, ACTOR_ID };
