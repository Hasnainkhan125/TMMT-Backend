'use strict';

const ContentBrief = require('../model/schema/contentBrief');

const ANGLES = [
  'lifestyle moment',
  'product hero shot',
  'unboxing',
  'before and after',
  'testimonial style',
  'founder story',
  'behind the scenes',
];

function assignOutputKinds(postsPerDay, videoPercent) {
  const videoCount = Math.round((videoPercent / 100) * postsPerDay);
  return Array.from({ length: postsPerDay }, (_, i) => i < videoCount ? 'video' : 'image');
}

function pickProduct(catalog, usedCount) {
  const active = (catalog || []).filter(p => p.active !== false);
  if (!active.length) return null;
  return active[usedCount % active.length];
}

function pickAngle(usedAngles) {
  const unused = ANGLES.filter(a => !usedAngles.includes(a));
  const pool = unused.length ? unused : ANGLES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildScheduledDate(planDate, postTime) {
  const [hours, minutes] = postTime.split(':').map(Number);
  const d = new Date(planDate);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

function assignPlatform(platforms, postIndex) {
  return platforms[postIndex % platforms.length];
}

function aspectForPlatform(platform, outputKind) {
  if (outputKind === 'video') return '9:16';
  return platform === 'instagram' ? '4:5' : '9:16';
}

/**
 * planDay — creates ContentBrief documents for one brand for one day.
 * @param {object} brand  AutonomousBrand Mongoose document
 * @param {Date}   planDate
 */
async function planDay(brand, planDate) {
  const { postsPerDay, platforms, postTimes, mixRatio } = brand.postingSchedule;
  const videoPercent = mixRatio?.videoPercent ?? 30;
  const kinds = assignOutputKinds(postsPerDay, videoPercent);

  const usedAngles = [];
  const briefs = [];

  for (let i = 0; i < postsPerDay; i++) {
    const outputKind = kinds[i];
    const platform   = assignPlatform(platforms, i);
    const angle      = pickAngle(usedAngles);
    const product    = pickProduct(brand.catalog, i);
    const postTime   = (postTimes && postTimes[i]) || (i === 0 ? '09:00' : '18:00');

    usedAngles.push(angle);

    const brief = new ContentBrief({
      brandId:     brand._id,
      platform,
      outputKind,
      aspectRatio: aspectForPlatform(platform, outputKind),
      angle,
      product: product
        ? { name: product.name, price: product.price, currency: product.currency, imageUrl: product.imageUrl, productUrl: product.productUrl }
        : {},
      scheduledFor: buildScheduledDate(planDate, postTime),
      status: 'pending',
    });

    await brief.save();
    briefs.push(brief);
  }

  brand.lastPlannerRunAt = new Date();
  await brand.save().catch(() => {});

  return briefs;
}

module.exports = { planDay, ANGLES };
