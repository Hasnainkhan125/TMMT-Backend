'use strict';

const AutonomousBrand = require('../model/schema/autonomousBrand');

function _quotaForTier(tier) {
  const map = { starter: 30, growth: 60, brand: 120, agency: 400 };
  return map[tier] || 60;
}

function _nextMonthStart() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function createBrand({ userId, brandName, description, category, locale, timezone, persona, catalog, postingSchedule, tier }) {
  const brand = new AutonomousBrand({
    userId,
    brandName,
    description:        description || '',
    category:           category || 'general',
    locale:             locale || 'gulf',
    timezone:           timezone || 'Asia/Dubai',
    persona,
    catalog:            catalog || [],
    postingSchedule:    postingSchedule || { postsPerDay: 2, platforms: ['instagram'] },
    tier:               tier || 'growth',
    postsQuotaPerMonth: _quotaForTier(tier),
    quotaResetDate:     _nextMonthStart(),
  });
  await brand.save();
  return brand;
}

async function getBrand(brandId) {
  return AutonomousBrand.findById(brandId);
}

async function listBrandsForUser(userId) {
  return AutonomousBrand.find({ userId, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });
}

async function updateBrand(brandId, updates) {
  return AutonomousBrand.findByIdAndUpdate(brandId, { $set: updates }, { new: true, runValidators: true });
}

async function upsertPlatformToken(brandId, { platform, accessToken, refreshToken, expiresAt, accountId, accountName }) {
  const brand = await AutonomousBrand.findById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);

  const token = { platform, accessToken, refreshToken: refreshToken || null, expiresAt: expiresAt || null, accountId: accountId || null, accountName: accountName || null };
  const idx = brand.platformTokens.findIndex(t => t.platform === platform);
  if (idx >= 0) brand.platformTokens[idx] = token;
  else brand.platformTokens.push(token);

  await brand.save();
  return brand;
}

async function pauseBrand(brandId) {
  return AutonomousBrand.findByIdAndUpdate(brandId, { $set: { status: 'paused' } }, { new: true });
}

async function resumeBrand(brandId) {
  return AutonomousBrand.findByIdAndUpdate(brandId, { $set: { status: 'active' } }, { new: true });
}

async function incrementPostsUsed(brandId, count = 1) {
  return AutonomousBrand.findByIdAndUpdate(
    brandId,
    { $inc: { postsUsedThisMonth: count }, $set: { lastPostAt: new Date() } },
    { new: true }
  );
}

async function getActiveBrandsForPlanning() {
  return AutonomousBrand.find({ status: 'active' });
}

module.exports = {
  createBrand,
  getBrand,
  listBrandsForUser,
  updateBrand,
  upsertPlatformToken,
  pauseBrand,
  resumeBrand,
  incrementPostsUsed,
  getActiveBrandsForPlanning,
};
