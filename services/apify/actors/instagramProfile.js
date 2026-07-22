'use strict';

const { runActor } = require('../apifyClient');

const ACTOR_ID = 'apify/instagram-scraper';

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItem(raw, username) {
  const posts = raw.latestPosts || raw.posts || raw.recentPosts || [];
  const last12 = posts.slice(0, 12);
  let likes = 0;
  let comments = 0;
  for (const p of last12) {
    likes += num(p.likesCount ?? p.likeCount ?? p.edge_liked_by?.count);
    comments += num(p.commentsCount ?? p.commentCount ?? p.edge_media_to_comment?.count);
  }
  const n = Math.max(1, last12.length);
  const postingFrequencyDays =
    last12.length >= 2 && last12[0]?.timestamp && last12[last12.length - 1]?.timestamp
      ? Math.max(
          1,
          Math.round(
            (new Date(last12[0].timestamp).getTime() -
              new Date(last12[last12.length - 1].timestamp).getTime()) /
              86400000 /
              Math.max(1, last12.length - 1),
          ),
        )
      : null;

  const profilePicUrl =
    raw.profilePicUrl
    || raw.profile_pic_url_hd
    || raw.profilePicUrlHd
    || raw.profile_pic_url
    || null;

  return {
    username: String(raw.username || raw.userName || username || '').replace(/^@/, ''),
    fullName: String(raw.fullName || raw.full_name || ''),
    profilePicUrl: profilePicUrl ? String(profilePicUrl) : null,
    followerCount: num(raw.followersCount ?? raw.followers ?? raw.edge_followed_by?.count),
    followingCount: num(raw.followsCount ?? raw.followingCount ?? raw.edge_follow?.count),
    postCount: num(raw.postsCount ?? raw.mediaCount ?? raw.edge_owner_to_timeline_media?.count),
    biography: String(raw.biography || raw.bio || ''),
    externalUrl: raw.externalUrl || raw.external_url || null,
    isVerified: !!(raw.isVerified || raw.is_verified),
    isBusinessAccount: !!(raw.isBusinessAccount || raw.is_business_account),
    businessCategoryName: raw.businessCategoryName || raw.business_category_name || null,
    avgLikes: Math.round(likes / n),
    avgComments: Math.round(comments / n),
    postingFrequencyDays,
  };
}

/**
 * @param {{ username: string }} input
 */
async function fetchInstagramProfile(input) {
  const username = String(input.username || '').replace(/^@/, '');
  if (!username) return null;
  const apifyInput = {
    usernames: [username],
  };
  const { items } = await runActor(ACTOR_ID, apifyInput, { timeoutSecs: 120, memoryMbytes: 512 });
  const row = (items || [])[0];
  if (!row) return null;
  return normalizeItem(row, username);
}

module.exports = { fetchInstagramProfile, ACTOR_ID };
