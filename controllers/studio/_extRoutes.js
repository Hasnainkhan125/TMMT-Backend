'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./extController');
const { optionalAuth } = require('../../middelwares/auth');
const { utmCapture } = require('../../middleware/utmCapture');
const { ensureStudioIdentity } = require('../../middelwares/studioIdentity');

// Apply UTM capture + soft auth to all studio ext routes. `optionalAuth`
// attaches `req.user` when a Bearer/cookie JWT is present but never blocks
// anonymous session-id callers — the controllers fall back to sessionId
// ownership when there's no logged-in user.
router.use(utmCapture);
router.use(optionalAuth);
router.use(ensureStudioIdentity);

// ── Public routes ────────────────────────────────────────────────────────
router.get('/share/:code',         ctrl.getSharePage);
router.post('/share/:code/click',  ctrl.recordShareClick);
router.post('/lead/capture',       ctrl.captureLead);

// ── Session-authenticated routes (ownership checked inside controller) ───
router.post('/asset/:id/copy',     ctrl.generateCopy);
router.post('/asset/:id/share',    ctrl.createShareLink);
router.patch('/asset/:id/rate',    ctrl.rateAsset);
router.post('/asset/:id/download', ctrl.trackDownload);
router.post('/job/:id/refine',     ctrl.refineGeneration);
router.get('/usage',               ctrl.getUsageStats);

module.exports = router;
