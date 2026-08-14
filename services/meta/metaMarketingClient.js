'use strict';

/**
 * Meta Marketing API — campaign deploy (Phase 1: stub / manual-review gate).
 *
 * Full automation requires a Meta Business app in Live mode + token review.
 * Callers should treat `deployCampaign` as best-effort until OAuth + ad account
 * mapping is complete.
 */

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');
const UserMetaConnection = require('../../model/schema/userMetaConnection');

async function deployCampaign(scanId, adIndex, dailyBudgetAED, _targetingOverrides) {
  if (!process.env.META_APP_ID) {
    const err = new Error('Meta Marketing API is not configured (META_APP_ID).');
    err.code = 'meta_not_configured';
    throw err;
  }

  const scan = await UrlToAdsScan.findById(scanId);
  if (!scan) {
    const err = new Error('Scan not found');
    err.code = 'not_found';
    throw err;
  }

  const uid = scan.userId;
  if (!uid) {
    const err = new Error('Scan has no user owner for Meta connection');
    err.code = 'meta_no_user';
    throw err;
  }

  const conn = await UserMetaConnection.findOne({ userId: uid });
  if (!conn?.accessToken) {
    const err = new Error('Connect Meta in Studio settings before deploying.');
    err.code = 'meta_not_connected';
    throw err;
  }

  const ad = scan.ads?.[adIndex];
  if (!ad?.assetUrl) {
    const err = new Error('Generate the ad image first so we have a creative URL.');
    err.code = 'meta_no_creative';
    throw err;
  }

  // Phase 2: facebook-nodejs-business-sdk — Campaign, AdSet, AdCreative, Ad.
  const err = new Error(
    'Campaign deploy is not fully automated yet. Use Meta Ads Manager with the exported creative.',
  );
  err.code = 'meta_deploy_stub';
  throw err;
}

module.exports = { deployCampaign };
