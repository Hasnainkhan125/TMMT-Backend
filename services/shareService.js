'use strict';

const StudioAsset = require('../model/schema/studioAsset');
const ShareableLink = require('../model/schema/shareableLink');

/**
 * generateCode — 8-char alphanumeric shortcode.
 */
function generateCode() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * createShareLink — creates a share link for an asset (idempotent: returns existing if already shared).
 * @param {string} assetId
 * @param {string} sessionId
 * @param {string|null} userId
 * @returns {{ code: string, publicUrl: string }}
 */
async function createShareLink(assetId, sessionId, userId = null) {
  // Idempotent: return existing share link if present
  const existing = await ShareableLink.findOne({ assetId, isActive: true });
  if (existing) {
    const publicUrl = `${process.env.CLIENT_URL || 'https://qumak.ae'}/share/${existing.code}`;
    return { code: existing.code, publicUrl };
  }

  // Load asset for category
  const asset = await StudioAsset.findById(assetId).lean();
  if (!asset) throw new Error('Asset not found');

  // Generate unique code
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    const collision = await ShareableLink.findOne({ code });
    if (!collision) break;
    attempts++;
  } while (attempts < 5);

  if (attempts >= 5) {
    throw new Error('shareService: could not generate unique share code after 5 attempts');
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await ShareableLink.create({
    code,
    assetId,
    jobId: asset.jobId,
    sessionId,
    userId,
    category: asset.category,
    expiresAt
  });

  // Store shortcode on asset for fast lookup
  await StudioAsset.findByIdAndUpdate(assetId, { shareCode: code });

  const publicUrl = `${process.env.CLIENT_URL || 'https://qumak.ae'}/share/${code}`;
  return { code, publicUrl };
}

/**
 * getShareData — returns public-safe share page data for a given code.
 * @param {string} code
 * @returns {object} Public share data
 */
async function getShareData(code) {
  const link = await ShareableLink.findOne({
    code,
    isActive: true,
    expiresAt: { $gt: new Date() }
  });

  if (!link) return null;

  // Increment view count
  await ShareableLink.findByIdAndUpdate(link._id, { $inc: { viewCount: 1 } });
  await StudioAsset.findByIdAndUpdate(link.assetId, { $inc: { shareViewCount: 1 } });

  const asset = await StudioAsset.findById(link.assetId).lean();
  if (!asset) return null;

  const clientUrl = process.env.CLIENT_URL || 'https://qumak.ae';

  return {
    imageUrl: asset.watermarkedUrl || asset.url || null,
    thumbnailUrl: asset.thumbnailUrl || null,
    category: link.category,
    brandName: asset.brandName || '',
    createdAt: link.createdAt,
    clickCTA: `${clientUrl}/studio?ref=share&code=${code}`
  };
}

/**
 * recordShareClick — fires when visitor clicks "Create my own ad" on the share page.
 * @param {string} code
 */
async function recordShareClick(code) {
  await ShareableLink.findOneAndUpdate(
    { code, isActive: true },
    { $inc: { clickCount: 1 } }
  );
}

module.exports = { createShareLink, getShareData, recordShareClick };
