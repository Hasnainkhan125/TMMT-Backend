'use strict';

/**
 * snapAdsController.js — Snap Marketing API (MENA-focused)
 *
 * OAuth: https://accounts.snapchat.com/login/oauth2/authorize
 * Marketing API: https://adsapi.snapchat.com/v1
 *
 * One-click flow:
 *   1. SME connects Snap (OAuth)
 *   2. Picks a finished StudioAsset
 *   3. POST /api/v1/snap/launch-campaign with budget + audience
 *   4. We create campaign + ad squad + creative + ad, all PAUSED
 *
 * Snap MENA is *the* SME channel for UAE/KSA — Snap reps actively want
 * tooling that lets small businesses launch in <60 seconds.
 *
 * Required env:
 *   SNAP_CLIENT_ID
 *   SNAP_CLIENT_SECRET
 *   SNAP_REDIRECT_URI            (defaults to ${API_BASE_URL}/api/v1/snap/callback)
 */

const SNAP_OAUTH_BASE = 'https://accounts.snapchat.com/login/oauth2';
const SNAP_API_BASE   = 'https://adsapi.snapchat.com/v1';

function getClientId()     { return process.env.SNAP_CLIENT_ID; }
function getClientSecret() { return process.env.SNAP_CLIENT_SECRET; }
function getRedirectUri()  {
  return process.env.SNAP_REDIRECT_URI
    || `${process.env.API_BASE_URL || 'http://localhost:5001'}/api/v1/snap/callback`;
}

// Same shim as facebookAdsController — proper KMS encryption is on the roadmap.
function encryptToken(t) { return Buffer.from(String(t || ''), 'utf8').toString('base64'); }
function decryptToken(t) { return Buffer.from(String(t || ''), 'base64').toString('utf8'); }

async function snapFetch(path, accessToken, opts = {}) {
  const res = await fetch(`${SNAP_API_BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.request_status === 'ERROR') {
    const msg = json.debug_message || json.error_description || JSON.stringify(json);
    throw new Error(`Snap API ${path}: ${msg}`);
  }
  return json;
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

exports.getAuthUrl = (req, res) => {
  if (!getClientId()) return res.status(503).json({ success: false, message: 'SNAP_CLIENT_ID not configured' });
  const scope = 'snapchat-marketing-api';
  const state = Buffer.from(JSON.stringify({ userId: req.user?._id })).toString('base64');
  const url = `${SNAP_OAUTH_BASE}/authorize?response_type=code`
    + `&client_id=${encodeURIComponent(getClientId())}`
    + `&redirect_uri=${encodeURIComponent(getRedirectUri())}`
    + `&scope=${encodeURIComponent(scope)}`
    + `&state=${state}`;
  res.json({ success: true, url });
};

exports.handleCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/brand-builder?snap_error=cancelled`);
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));

    const tokenRes = await fetch(`${SNAP_OAUTH_BASE}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(),
        client_id: getClientId(),
        client_secret: getClientSecret(),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'Token exchange failed');

    const User = require('../../model/schema/user');
    await User.findByIdAndUpdate(stateData.userId, {
      $set: {
        'socialConnections.snapchat': {
          accessToken:  encryptToken(tokenData.access_token),
          refreshToken: encryptToken(tokenData.refresh_token),
          connectedAt:  new Date(),
          tokenExpiry:  new Date(Date.now() + (tokenData.expires_in || 1800) * 1000),
        },
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/brand-builder?snap_connected=1`);
  } catch (err) {
    console.error('[SnapAds] callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/brand-builder?snap_error=failed`);
  }
};

exports.getStatus = async (req, res) => {
  try {
    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const sc = user?.socialConnections?.snapchat;
    if (!sc) return res.json({ success: true, connected: false });
    res.json({ success: true, connected: true, connectedAt: sc.connectedAt, tokenExpiry: sc.tokenExpiry });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAdAccounts = async (req, res) => {
  try {
    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const sc = user?.socialConnections?.snapchat;
    if (!sc) return res.status(401).json({ success: false, message: 'Snap not connected' });
    const at = decryptToken(sc.accessToken);
    const me = await snapFetch('/me', at);
    const orgId = me?.me?.organization_id;
    if (!orgId) throw new Error('No organization id on Snap account');
    const accounts = await snapFetch(`/organizations/${orgId}/adaccounts`, at);
    const list = (accounts.adaccounts || []).map(a => a.adaccount);
    res.json({ success: true, adAccounts: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── One-click launch ────────────────────────────────────────────────────────

/**
 * POST /api/v1/snap/launch-campaign
 *
 * Body: {
 *   assetId, adAccountId,
 *   campaignName, headline (≤34), brandName,
 *   linkUrl,
 *   dailyBudgetAed,
 *   countries?: ['ae','sa', ...]   // ISO-2 lowercase for Snap
 * }
 *
 * Snap minimum daily budget is USD 5 / ad squad. We require AED 20 to give
 * the algorithm room (consistent with Meta minimum).
 */
exports.launchCampaign = async (req, res) => {
  try {
    const {
      assetId, adAccountId,
      campaignName, headline, brandName,
      linkUrl, dailyBudgetAed,
      countries = ['ae', 'sa'],
    } = req.body || {};

    if (!assetId || !adAccountId || !campaignName || !linkUrl || !headline || !brandName || !dailyBudgetAed) {
      return res.status(400).json({
        success: false,
        message: 'assetId, adAccountId, campaignName, headline, brandName, linkUrl, dailyBudgetAed required',
      });
    }
    if (Number(dailyBudgetAed) < 20) {
      return res.status(400).json({ success: false, message: 'Daily budget must be ≥ AED 20.' });
    }

    const StudioAsset = require('../../model/schema/studioAsset');
    const asset = await StudioAsset.findById(assetId).lean();
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });
    const mediaUrl = asset.cleanUrl || asset.watermarkedUrl;
    if (!mediaUrl) return res.status(400).json({ success: false, message: 'Asset has no usable media URL' });
    const isVideo = (asset.type === 'video') || /\.mp4($|\?)/i.test(mediaUrl);

    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const sc = user?.socialConnections?.snapchat;
    if (!sc) return res.status(401).json({ success: false, message: 'Snap not connected' });
    const at = decryptToken(sc.accessToken);

    // Snap budgets are in micro-currency: USD 1 = 1,000,000. AED → USD ≈ /3.67.
    // For simplicity we assume the ad account currency = USD (Snap default in MENA).
    const dailyBudgetMicroUsd = Math.round((Number(dailyBudgetAed) / 3.67) * 1_000_000);

    // 1. Campaign (PAUSED)
    const campaignRes = await snapFetch(`/adaccounts/${adAccountId}/campaigns`, at, {
      method: 'POST',
      body: JSON.stringify({
        campaigns: [{
          name: campaignName,
          ad_account_id: adAccountId,
          status: 'PAUSED',
          objective: 'WEB_CONVERSION',
          start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }],
      }),
    });
    const campaign = campaignRes.campaigns?.[0]?.campaign;
    if (!campaign) throw new Error('Campaign creation returned no payload');

    // 2. Ad squad (Snap's "ad set"), PAUSED, MENA geo
    const adSquadRes = await snapFetch(`/campaigns/${campaign.id}/adsquads`, at, {
      method: 'POST',
      body: JSON.stringify({
        adsquads: [{
          name: `${campaignName} — squad`,
          status: 'PAUSED',
          campaign_id: campaign.id,
          type: 'SNAP_ADS',
          targeting: {
            geos: countries.map(c => ({ country_code: c })),
            demographics: [{ min_age: 18, max_age: 50, gender: 'ALL' }],
          },
          placement_v2: { config: 'AUTOMATIC' },
          billing_event: 'IMPRESSION',
          bid_strategy: 'AUTO_BID',
          daily_budget_micro: dailyBudgetMicroUsd,
          start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          optimization_goal: 'PIXEL_PURCHASE',
        }],
      }),
    });
    const adSquad = adSquadRes.adsquads?.[0]?.adsquad;
    if (!adSquad) throw new Error('AdSquad creation returned no payload');

    // 3. Media — register the asset URL as a media object, then a creative
    const mediaRes = await snapFetch(`/adaccounts/${adAccountId}/media`, at, {
      method: 'POST',
      body: JSON.stringify({
        media: [{
          name: `${campaignName} — media`,
          type: isVideo ? 'VIDEO' : 'IMAGE',
          ad_account_id: adAccountId,
          file_name: mediaUrl.split('/').pop(),
        }],
      }),
    });
    const media = mediaRes.media?.[0]?.media;
    if (!media) throw new Error('Media registration returned no payload');

    // (In production we'd POST the binary to /media/{id}/upload here. For the
    // MVP demo flow we rely on Snap's hosted-URL ingestion path; if that path
    // is disabled on the account, the creative step will surface an error.)

    // 4. Creative
    const creativeRes = await snapFetch(`/adaccounts/${adAccountId}/creatives`, at, {
      method: 'POST',
      body: JSON.stringify({
        creatives: [{
          ad_account_id: adAccountId,
          name: `${campaignName} — creative`,
          type: 'WEB_VIEW',
          brand_name: brandName.slice(0, 32),
          headline: headline.slice(0, 34),
          shareable: true,
          top_snap_media_id: media.id,
          web_view_properties: { url: linkUrl, allow_snap_javascript_sdk: false, use_immersive_mode: false },
        }],
      }),
    });
    const creative = creativeRes.creatives?.[0]?.creative;
    if (!creative) throw new Error('Creative creation returned no payload');

    // 5. Ad (PAUSED)
    const adRes = await snapFetch(`/adsquads/${adSquad.id}/ads`, at, {
      method: 'POST',
      body: JSON.stringify({
        ads: [{
          name: `${campaignName} — ad`,
          ad_squad_id: adSquad.id,
          creative_id: creative.id,
          status: 'PAUSED',
          type: 'SNAP_AD',
        }],
      }),
    });
    const ad = adRes.ads?.[0]?.ad;
    if (!ad) throw new Error('Ad creation returned no payload');

    await StudioAsset.findByIdAndUpdate(assetId, {
      $push: {
        campaigns: {
          platform: 'snap',
          campaignId: campaign.id,
          adSetId:    adSquad.id,
          creativeId: creative.id,
          adId:       ad.id,
          status:     'PAUSED',
          dailyBudgetAed: Number(dailyBudgetAed),
          countries,
          launchedAt: new Date(),
          launchedBy: req.user._id,
        },
      },
    });

    res.json({
      success: true,
      platform: 'snap',
      status: 'PAUSED',
      campaignId: campaign.id,
      adSquadId:  adSquad.id,
      creativeId: creative.id,
      adId:       ad.id,
      reviewUrl:  `https://ads.snapchat.com/${adAccountId}/campaigns/${campaign.id}`,
      message: 'Snap campaign created in PAUSED state. Activate it from the dashboard.',
    });
  } catch (err) {
    console.error('[SnapAds] launchCampaign error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
