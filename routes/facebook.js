/**
 * facebook.js — Facebook/Meta Business API routes
 * Mounted at: /api/v1/facebook
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/brandProject/facebookAdsController');
const requireAuth = require('../middelwares/auth');

// OAuth flow — auth-url is public, callback is public (has state token)
router.get('/auth-url',    requireAuth, ctrl.getAuthUrl);
// /auth — direct redirect to Facebook OAuth (for popup window)
router.get('/auth',        ctrl.redirectToAuth);
router.get('/callback',    ctrl.handleCallback);
router.get('/status',      requireAuth, ctrl.getStatus);
router.get('/ad-accounts', requireAuth, ctrl.getAdAccounts);

// Post & insights — require auth
router.post('/post',           requireAuth, ctrl.createPost);
router.get('/insights',        requireAuth, ctrl.getInsights);

// One-click launch: StudioAsset → PAUSED Meta campaign in UAE+KSA
router.post('/launch-campaign', requireAuth, ctrl.launchCampaign);

module.exports = router;
