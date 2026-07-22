'use strict';

const { runActor } = require('../apifyClient');

const ACTOR_ID = 'apidojo/instagram-scraper';

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function normalizePost(raw) {
  const postId = raw.id || raw.shortCode || raw.shortcode || '';
  const postUrl =
    raw.url ||
    (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null) ||
    (raw.shortcode ? `https://www.instagram.com/p/${raw.shortcode}/` : null);
  const caption = String(raw.caption || raw.text || '');
  const mediaUrls = []
    .concat(raw.displayUrl, raw.thumbnailUrl, raw.imageUrl)
    .concat(raw.images || [], raw.carouselMedia?.map((m) => m.displayUrl) || [])
    .filter(Boolean);
  const hashtags = (caption.match(/#[\w\u0600-\u06FF]+/g) || []).map((h) => h.slice(1));
  const likes = num(raw.likesCount ?? raw.likeCount ?? raw.edge_liked_by?.count);
  const comments = num(raw.commentsCount ?? raw.commentCount);
  const postedAt = raw.timestamp || raw.takenAt || raw.date || null;
  const engagement = likes + comments;

  return {
    postId: String(postId),
    postUrl: postUrl || '',
    caption: caption.slice(0, 4000),
    mediaUrls: [...new Set(mediaUrls)].slice(0, 8),
    mediaType: raw.type || raw.mediaType || 'image',
    hashtags: [...new Set(hashtags)].slice(0, 30),
    likeCount: likes,
    commentCount: comments,
    postedAt,
    _engagement: engagement,
  };
}

/**
 * @param {{ username: string, maxPosts?: number }} input
 * @returns {Promise<object[]>} top 10 by engagement rate proxy
 */
async function fetchInstagramTopPosts(input) {
  const username = String(input.username || '').replace(/^@/, '');
  const maxPosts = Math.min(Math.max(Number(input.maxPosts) || 24, 1), 60);
  if (!username) return [];

  const apifyInput = {
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: 'posts',
    resultsLimit: maxPosts,
  };

  const { items } = await runActor(ACTOR_ID, apifyInput, { timeoutSecs: 180, memoryMbytes: 2048 });
  const normalized = (items || []).map(normalizePost);
  normalized.sort((a, b) => b._engagement - a._engagement);
  return normalized.slice(0, maxPosts).map((p) => {
    const { _engagement, ...rest } = p;
    void _engagement;
    return rest;
  });
}

module.exports = { fetchInstagramTopPosts, ACTOR_ID };
