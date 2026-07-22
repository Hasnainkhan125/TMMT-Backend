/**
 * followUpService.js — Drip email cron for brand follow-ups
 * Runs every 15 minutes, sends 3-email sequence: 1hr, 24hr, 72hr
 */
const cron = require('node-cron');
const crypto = require('crypto');

function generateUnsubToken(submissionId) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'qumak_secret')
    .update(submissionId.toString())
    .digest('hex')
    .slice(0, 32);
}

function startFollowUpCron() {
  cron.schedule('*/15 * * * *', async () => {
    const BrandSubmission = require('../model/schema/brandSubmission');
    const { queueEmail } = require('./emailService');
    const now = new Date();

    try {
      // EMAIL 1: 1 hour after generation
      const email1Due = await BrandSubmission.find({
        email: { $exists: true, $ne: null },
        'followUp.unsubscribed': false,
        'followUp.email1Sent': false,
        savedToAccount: { $ne: true },
        createdAt: {
          $lte: new Date(now - 60 * 60 * 1000),
          $gte: new Date(now - 3 * 60 * 60 * 1000),
        },
      }).limit(50);

      for (const sub of email1Due) {
        await queueEmail(sub._id, sub.userId, sub.email, 'brand_ready', {
          brandName: sub.brand?.brandName || 'Your Brand',
          tagline: sub.brand?.tagline || '',
          margin: sub.brand?.estimatedMargin,
          retail: sub.brand?.suggestedRetailPrice,
          projectId: sub._id.toString(),
          unsubToken: generateUnsubToken(sub._id),
        });
        await BrandSubmission.findByIdAndUpdate(sub._id, {
          'followUp.email1Sent': true, 'followUp.email1SentAt': new Date(),
        });
      }

      // EMAIL 2: 24 hours after generation
      const email2Due = await BrandSubmission.find({
        email: { $exists: true, $ne: null },
        'followUp.unsubscribed': false,
        'followUp.email1Sent': true,
        'followUp.email2Sent': false,
        savedToAccount: { $ne: true },
        createdAt: {
          $lte: new Date(now - 24 * 60 * 60 * 1000),
          $gte: new Date(now - 27 * 60 * 60 * 1000),
        },
      }).limit(50);

      for (const sub of email2Due) {
        await queueEmail(sub._id, sub.userId, sub.email, 'follow_up_1', {
          brandName: sub.brand?.brandName || 'Your Brand',
          projectId: sub._id.toString(),
          unsubToken: generateUnsubToken(sub._id),
        });
        await BrandSubmission.findByIdAndUpdate(sub._id, {
          'followUp.email2Sent': true, 'followUp.email2SentAt': new Date(),
        });
      }

      // EMAIL 3: 72 hours - last chance
      const email3Due = await BrandSubmission.find({
        email: { $exists: true, $ne: null },
        'followUp.unsubscribed': false,
        'followUp.email2Sent': true,
        'followUp.email3Sent': false,
        tradeLicensePaid: { $ne: true },
        createdAt: {
          $lte: new Date(now - 72 * 60 * 60 * 1000),
          $gte: new Date(now - 75 * 60 * 60 * 1000),
        },
      }).limit(50);

      for (const sub of email3Due) {
        await queueEmail(sub._id, sub.userId, sub.email, 'follow_up_2', {
          brandName: sub.brand?.brandName || 'Your Brand',
          projectId: sub._id.toString(),
          unsubToken: generateUnsubToken(sub._id),
        });
        await BrandSubmission.findByIdAndUpdate(sub._id, {
          'followUp.email3Sent': true, 'followUp.email3SentAt': new Date(),
        });
      }

      // Mark high-intent
      await BrandSubmission.updateMany(
        { isHighIntent: false, $or: [{ launchScore: { $gt: 60 } }, { mockupsGenerated: { $gt: 3 } }] },
        { $set: { isHighIntent: true } }
      );
    } catch (err) {
      console.error('[FollowUpCron] Error:', err.message);
    }
  });

  console.log('[FollowUpCron] Started — checking every 15 minutes');
}

module.exports = { startFollowUpCron, generateUnsubToken };
