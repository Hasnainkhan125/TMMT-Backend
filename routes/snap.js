/**
 * snap.js — Snap Marketing API routes (MENA SME launcher)
 * Mounted at /api/v1/snap
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/snap/snapAdsController');
const requireAuth = require('../middelwares/auth');

router.get('/auth-url',         requireAuth, ctrl.getAuthUrl);
router.get('/callback',         ctrl.handleCallback);
router.get('/status',           requireAuth, ctrl.getStatus);
router.get('/ad-accounts',      requireAuth, ctrl.getAdAccounts);
router.post('/launch-campaign', requireAuth, ctrl.launchCampaign);

module.exports = router;
