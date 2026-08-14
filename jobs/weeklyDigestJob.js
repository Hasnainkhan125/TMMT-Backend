'use strict';

const UrlToAdsScan = require('../model/schema/urlToAdsScan');
const BrandWeeklySnapshot = require('../model/schema/brandWeeklySnapshot');
const { generateDigestEmail } = require('../services/digest/digestGenerator');

async function sendMail(_to, _payload) {
  try {
    const sg = require('@sendgrid/mail');
    if (process.env.SENDGRID_API_KEY) {
      sg.setApiKey(process.env.SENDGRID_API_KEY);
      // Uncomment when from-address is verified:
      // await sg.send({ to, from: process.env.DIGEST_FROM_EMAIL, ...payload });
    }
  } catch (_e) { /* optional */ }
}

/**
 * Monday 9am Asia/Dubai — iterate scans with digestEnrolled.
 */
async function runWeeklyDigest() {
  const scans = await UrlToAdsScan.find({
    digestEnrolled: true,
    status: { $in: ['ready', 'partial'] },
  })
    .limit(500)
    .lean();

  const weekOf = new Date();
  weekOf.setUTCHours(0, 0, 0, 0);

  for (const scan of scans) {
    const brandId = scan.intelligence?.brandId;
    if (!brandId) continue;

    const prev = await BrandWeeklySnapshot.findOne({ brandId }).sort({ weekOf: -1 }).lean();
    const currentSnapshot = {
      competitorAds: scan.apifyData?.competitorAds || [],
      instagram: scan.apifyData?.instagramProfiles || [],
    };

    await BrandWeeklySnapshot.findOneAndUpdate(
      { brandId, weekOf },
      {
        competitorAdsSnapshot: currentSnapshot.competitorAds,
        instagramMetricsSnapshot: currentSnapshot.instagram,
      },
      { upsert: true },
    );

    const email = generateDigestEmail({
      brandName: scan.brand?.name,
      currentSnapshot,
      previousSnapshot: prev || null,
    });
    void sendMail;
    void email;
    // await sendMail(user.email, { subject: email.subject, html: email.html, text: email.text });

    await UrlToAdsScan.updateOne(
      { _id: scan._id },
      { $set: { digestLastSentAt: new Date() } },
    ).catch(() => {});
  }
}

module.exports = { runWeeklyDigest };
