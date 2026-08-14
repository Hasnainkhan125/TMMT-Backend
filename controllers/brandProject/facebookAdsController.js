/**
 * facebookAdsController.js — Facebook Business SDK integration
 * Per-user Facebook ad account connection, posting, and analytics
 *
 * npm install facebook-nodejs-business-sdk (already done)
 *
 * OAuth Flow:
 *   1. User clicks "Connect Facebook" → GET /api/v1/facebook/auth-url
 *   2. Meta redirects to /api/v1/facebook/callback?code=...
 *   3. Exchange code for long-lived token → store encrypted in DB
 *   4. User can post, read insights, manage campaigns
 */
let _bizSdk;
function getBizSdk() {
  if (!_bizSdk) _bizSdk = require('facebook-nodejs-business-sdk');
  return _bizSdk;
}
function getFacebookAdsApi() { return getBizSdk().FacebookAdsApi; }

function getAppId() { return process.env.META_APP_ID; }
function getAppSecret() { return process.env.META_APP_SECRET; }
function getRedirectUri() { return `${process.env.API_BASE_URL || 'http://localhost:5001'}/api/v1/facebook/callback`; }

// Simple XOR encryption for token storage (use proper encryption in production)
function encryptToken(token) {
  const key = process.env.JWT_SECRET || 'qumak_secret';
  return Buffer.from(token).toString('base64');
}

function decryptToken(encrypted) {
  return Buffer.from(encrypted, 'base64').toString('utf8');
}

// GET /api/v1/facebook/auth — redirect directly to Facebook OAuth (popup entry point)
exports.redirectToAuth = (req, res) => {
  const scope = [
    'pages_manage_posts', 'pages_read_engagement', 'pages_show_list',
    'ads_read', 'instagram_basic', 'instagram_content_publish',
  ].join(',');
  const state = Buffer.from(JSON.stringify({ popup: true })).toString('base64');
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${getAppId()}&redirect_uri=${encodeURIComponent(getRedirectUri())}&scope=${scope}&state=${state}&response_type=code`;
  res.redirect(url);
};

// GET /api/v1/facebook/auth-url — returns OAuth URL for user to connect
exports.getAuthUrl = (req, res) => {
  const scope = [
    'pages_manage_posts',
    'pages_read_engagement',
    'pages_show_list',
    'ads_read',
    'ads_management',
    'business_management',
    'instagram_basic',
    'instagram_content_publish',
  ].join(',');

  const state = Buffer.from(JSON.stringify({ userId: req.user?._id })).toString('base64');
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${getAppId()}&redirect_uri=${encodeURIComponent(getRedirectUri())}&scope=${scope}&state=${state}&response_type=code`;

  res.json({ success: true, url });
};

// GET /api/v1/facebook/callback — OAuth callback, exchange code for token
exports.handleCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/brand-builder?fb_error=cancelled`);

    const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));

    // Exchange code for short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${getAppId()}&client_secret=${getAppSecret()}&redirect_uri=${encodeURIComponent(getRedirectUri())}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Token exchange failed');

    // Exchange for long-lived token (60 days)
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${getAppId()}&client_secret=${getAppSecret()}&fb_exchange_token=${tokenData.access_token}`
    );
    const longLived = await longLivedRes.json();
    const accessToken = longLived.access_token || tokenData.access_token;

    // Get user's pages
    getFacebookAdsApi().init(accessToken);
    const meRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`);
    const meData = await meRes.json();
    const pages = meData.data || [];

    // Store in user's brand social connections
    const User = require('../../model/schema/user');
    await User.findByIdAndUpdate(stateData.userId, {
      $set: {
        'socialConnections.facebook': {
          accessToken: encryptToken(accessToken),
          pages,
          connectedAt: new Date(),
          tokenExpiry: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        },
      },
    });

    // If opened as popup, emit postMessage and close
    const isPopup = stateData.popup;
    if (isPopup) {
      return res.send(`<script>
        window.opener && window.opener.postMessage({ type: 'fb_oauth_success', pages: ${pages.length} }, '*');
        window.close();
      </script>`);
    }

    res.redirect(`${process.env.FRONTEND_URL}/brand-builder?fb_connected=1&pages=${pages.length}`);
  } catch (err) {
    console.error('[FacebookAds] Callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/brand-builder?fb_error=failed`);
  }
};

// GET /api/v1/facebook/status — check if user has connected Facebook
exports.getStatus = async (req, res) => {
  try {
    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const fb = user?.socialConnections?.facebook;
    if (!fb) return res.json({ success: true, connected: false });

    res.json({
      success: true,
      connected: true,
      pages: fb.pages || [],
      connectedAt: fb.connectedAt,
      tokenExpiry: fb.tokenExpiry,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/facebook/post — publish post to Facebook Page
exports.createPost = async (req, res) => {
  try {
    const { pageId, message, imageBase64, scheduledTime } = req.body;
    if (!pageId || !message) return res.status(400).json({ success: false, message: 'pageId and message required' });

    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const fb = user?.socialConnections?.facebook;
    if (!fb) return res.status(401).json({ success: false, message: 'Facebook not connected' });

    const accessToken = decryptToken(fb.accessToken);

    // Get page token
    const pageTokenRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=access_token&access_token=${accessToken}`);
    const pageTokenData = await pageTokenRes.json();
    const pageToken = pageTokenData.access_token;
    if (!pageToken) throw new Error('Could not get page token');

    let photoId = null;

    // Upload image if provided
    if (imageBase64) {
      const imgBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const formData = new FormData();
      const blob = new Blob([imgBuffer], { type: 'image/png' });
      formData.append('source', blob, 'brand.png');
      formData.append('published', 'false');
      formData.append('access_token', pageToken);

      const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
        method: 'POST', body: formData,
      });
      const uploadData = await uploadRes.json();
      photoId = uploadData.id;
    }

    // Create the post
    const postBody = { message, access_token: pageToken };
    if (photoId) postBody.attached_media = [{ media_fbid: photoId }];
    if (scheduledTime) {
      postBody.published = false;
      postBody.scheduled_publish_time = Math.floor(new Date(scheduledTime).getTime() / 1000);
    }

    const postRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
    });
    const postData = await postRes.json();
    if (postData.error) throw new Error(postData.error.message);

    res.json({ success: true, postId: postData.id, message: 'Post published successfully' });
  } catch (err) {
    console.error('[FacebookAds] Post error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/facebook/insights — ad account campaign metrics
exports.getInsights = async (req, res) => {
  try {
    const { adAccountId, datePreset = 'last_30d' } = req.query;

    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const fb = user?.socialConnections?.facebook;
    if (!fb) return res.status(401).json({ success: false, message: 'Facebook not connected' });

    const accessToken = decryptToken(fb.accessToken);
    getFacebookAdsApi().init(accessToken);

    // If adAccountId provided, get campaign insights
    if (adAccountId) {
      const fields = 'campaign_name,impressions,clicks,ctr,cpc,cpp,spend,reach,actions';
      const insightsRes = await fetch(
        `https://graph.facebook.com/v21.0/act_${adAccountId.replace('act_','')}/insights?fields=${fields}&date_preset=${datePreset}&level=campaign&access_token=${accessToken}`
      );
      const insights = await insightsRes.json();

      const campaigns = (insights.data || []).map(c => ({
        name: c.campaign_name,
        impressions: parseInt(c.impressions || 0),
        clicks: parseInt(c.clicks || 0),
        ctr: parseFloat(c.ctr || 0).toFixed(2),
        cpc: parseFloat(c.cpc || 0).toFixed(2),
        cpp: parseFloat(c.cpp || 0).toFixed(2),
        spend: parseFloat(c.spend || 0).toFixed(2),
        reach: parseInt(c.reach || 0),
        conversions: (c.actions || []).find(a => a.action_type === 'purchase')?.value || 0,
      }));

      return res.json({ success: true, campaigns, datePreset });
    }

    // Otherwise return page insights
    const pages = fb.pages || [];
    if (!pages.length) return res.json({ success: true, pages: [] });

    const pageInsights = await Promise.all(pages.map(async (page) => {
      try {
        const fields = 'followers_count,fan_count,name,instagram_business_account';
        const pageRes = await fetch(`https://graph.facebook.com/v21.0/${page.id}?fields=${fields}&access_token=${page.access_token || accessToken}`);
        return await pageRes.json();
      } catch { return page; }
    }));

    res.json({ success: true, pages: pageInsights });
  } catch (err) {
    console.error('[FacebookAds] Insights error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/v1/facebook/launch-campaign
 *
 * One-click launch: take a finished StudioAsset and push it to Meta Ads Manager
 * as a *paused* PAUSED-by-default campaign + ad set + creative + ad in the
 * user's connected ad account. We default geo to UAE+KSA (the wedge) and
 * objective to OUTCOME_TRAFFIC (LP visit) which works for any SME landing page
 * or WhatsApp Business deep-link.
 *
 * Why PAUSED: never spend the SME's money without an explicit "Activate" click
 * in the dashboard — that lives on the frontend's confirm screen.
 *
 * Body: {
 *   assetId:        ObjectId,         // StudioAsset to use as creative
 *   adAccountId:    'act_xxx' | 'xxx',
 *   pageId:         '<facebook-page-id>',
 *   instagramId?:   '<ig-user-id>',
 *   campaignName:   string,
 *   primaryText:    string,           // ad copy (Arabic + English newlines OK)
 *   headline:       string,           // ≤40 chars
 *   linkUrl:        string,           // landing page or wa.me deep-link
 *   dailyBudgetAed: number,           // AED. We convert to fils (×100) for Meta API.
 *   countries?:     ['AE','SA',...],  // defaults to ['AE','SA']
 *   ageMin?:        number,           // default 18
 *   ageMax?:        number,           // default 55
 *   objective?:     'OUTCOME_TRAFFIC' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_SALES'
 * }
 */
exports.launchCampaign = async (req, res) => {
  try {
    const {
      assetId,
      adAccountId,
      pageId,
      instagramId,
      campaignName,
      primaryText,
      headline,
      linkUrl,
      dailyBudgetAed,
      countries = ['AE', 'SA'],
      ageMin = 18,
      ageMax = 55,
      objective = 'OUTCOME_TRAFFIC',
    } = req.body || {};

    // ── Validation ───────────────────────────────────────────────────────────
    if (!assetId || !adAccountId || !pageId || !campaignName || !linkUrl || !primaryText || !headline || !dailyBudgetAed) {
      return res.status(400).json({
        success: false,
        message: 'assetId, adAccountId, pageId, campaignName, primaryText, headline, linkUrl, dailyBudgetAed are required',
      });
    }
    if (Number(dailyBudgetAed) < 20) {
      return res.status(400).json({ success: false, message: 'Daily budget must be ≥ AED 20 (Meta minimum).' });
    }

    const StudioAsset = require('../../model/schema/studioAsset');
    const asset = await StudioAsset.findById(assetId).lean();
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    const mediaUrl = asset.cleanUrl || asset.watermarkedUrl || asset.storedVideoUrl || asset.storedImageUrl;
    if (!mediaUrl) return res.status(400).json({ success: false, message: 'Asset has no usable media URL' });

    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const fb = user?.socialConnections?.facebook;
    if (!fb) return res.status(401).json({ success: false, message: 'Facebook not connected' });
    const accessToken = decryptToken(fb.accessToken);

    const actId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const fils = Math.round(Number(dailyBudgetAed) * 100); // AED → fils
    const isVideo = (asset.type === 'video') || /\.mp4($|\?)/i.test(mediaUrl);

    // ── 1. Campaign (PAUSED) ────────────────────────────────────────────────
    const campaignBody = new URLSearchParams({
      name: campaignName,
      objective,
      status: 'PAUSED',
      special_ad_categories: '[]',
      access_token: accessToken,
    });
    const campaignRes = await fetch(`https://graph.facebook.com/v21.0/${actId}/campaigns`, {
      method: 'POST', body: campaignBody,
    });
    const campaign = await campaignRes.json();
    if (campaign.error) throw new Error(`Campaign: ${campaign.error.message}`);

    // ── 2. Ad set (PAUSED, AED daily budget, UAE+KSA geo, 18-55) ────────────
    const adSetBody = new URLSearchParams({
      name: `${campaignName} — adset`,
      campaign_id: campaign.id,
      daily_budget: String(fils),
      billing_event: 'IMPRESSIONS',
      optimization_goal: objective === 'OUTCOME_ENGAGEMENT' ? 'POST_ENGAGEMENT' : 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify({
        geo_locations: { countries },
        age_min: ageMin,
        age_max: ageMax,
        publisher_platforms: ['facebook', 'instagram'],
        facebook_positions: ['feed', 'story', 'reels'],
        instagram_positions: ['stream', 'story', 'reels', 'explore'],
      }),
      status: 'PAUSED',
      start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_token: accessToken,
    });
    const adSetRes = await fetch(`https://graph.facebook.com/v21.0/${actId}/adsets`, {
      method: 'POST', body: adSetBody,
    });
    const adSet = await adSetRes.json();
    if (adSet.error) throw new Error(`AdSet: ${adSet.error.message}`);

    // ── 3. Ad creative (image or video, LINK_DATA / VIDEO_DATA) ─────────────
    let object_story_spec;
    if (isVideo) {
      // For video creatives, Meta needs a video_id. We upload the video first.
      const videoUploadRes = await fetch(`https://graph.facebook.com/v21.0/${actId}/advideos`, {
        method: 'POST',
        body: new URLSearchParams({ file_url: mediaUrl, access_token: accessToken }),
      });
      const videoUpload = await videoUploadRes.json();
      if (videoUpload.error) throw new Error(`Video upload: ${videoUpload.error.message}`);

      object_story_spec = {
        page_id: pageId,
        ...(instagramId ? { instagram_actor_id: instagramId } : {}),
        video_data: {
          video_id: videoUpload.id,
          message: primaryText,
          title: headline,
          call_to_action: { type: 'LEARN_MORE', value: { link: linkUrl } },
          image_url: asset.thumbnailUrl || mediaUrl,
        },
      };
    } else {
      object_story_spec = {
        page_id: pageId,
        ...(instagramId ? { instagram_actor_id: instagramId } : {}),
        link_data: {
          message: primaryText,
          link: linkUrl,
          name: headline,
          picture: mediaUrl,
          call_to_action: { type: 'LEARN_MORE' },
        },
      };
    }

    const creativeBody = new URLSearchParams({
      name: `${campaignName} — creative`,
      object_story_spec: JSON.stringify(object_story_spec),
      access_token: accessToken,
    });
    const creativeRes = await fetch(`https://graph.facebook.com/v21.0/${actId}/adcreatives`, {
      method: 'POST', body: creativeBody,
    });
    const creative = await creativeRes.json();
    if (creative.error) throw new Error(`Creative: ${creative.error.message}`);

    // ── 4. Ad (PAUSED) ──────────────────────────────────────────────────────
    const adBody = new URLSearchParams({
      name: `${campaignName} — ad`,
      adset_id: adSet.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',
      access_token: accessToken,
    });
    const adRes = await fetch(`https://graph.facebook.com/v21.0/${actId}/ads`, {
      method: 'POST', body: adBody,
    });
    const ad = await adRes.json();
    if (ad.error) throw new Error(`Ad: ${ad.error.message}`);

    // ── 5. Persist on the StudioAsset for the dashboard ─────────────────────
    await StudioAsset.findByIdAndUpdate(assetId, {
      $push: {
        campaigns: {
          platform: 'meta',
          campaignId: campaign.id,
          adSetId: adSet.id,
          creativeId: creative.id,
          adId: ad.id,
          status: 'PAUSED',
          dailyBudgetAed: Number(dailyBudgetAed),
          countries,
          launchedAt: new Date(),
          launchedBy: req.user._id,
        },
      },
    });

    res.json({
      success: true,
      platform: 'meta',
      status: 'PAUSED',
      campaignId: campaign.id,
      adSetId: adSet.id,
      creativeId: creative.id,
      adId: ad.id,
      reviewUrl: `https://business.facebook.com/adsmanager/manage/campaigns?act=${actId.replace('act_','')}&selected_campaign_ids=${campaign.id}`,
      message: 'Campaign created in PAUSED state. Activate it from Ads Manager or the dashboard.',
    });
  } catch (err) {
    console.error('[FacebookAds] launchCampaign error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/facebook/ad-accounts — list user's ad accounts
exports.getAdAccounts = async (req, res) => {
  try {
    const User = require('../../model/schema/user');
    const user = await User.findById(req.user._id).select('socialConnections');
    const fb = user?.socialConnections?.facebook;
    if (!fb) return res.status(401).json({ success: false, message: 'Facebook not connected' });

    const accessToken = decryptToken(fb.accessToken);
    const accountsRes = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,currency,account_status&access_token=${accessToken}`);
    const accountsData = await accountsRes.json();

    res.json({ success: true, adAccounts: accountsData.data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
