'use strict';

/**
 * /api/v1/me/credits — credits read API for the Studio.
 *
 * GET  /                → { balance, freeAnonGrant, signupBonus }
 * GET  /ledger?limit=50 → recent ledger rows
 * POST /quote           → { cost } for a planned generation (modelId + kind + duration + variants)
 *
 * Anonymous users are identified by the same session cookie / x-session-id
 * header that the studio controllers already use.
 */

const express = require('express');
const router = express.Router();
const credits = require('../services/creditsService');
const { optionalAuth } = require('../middelwares/auth');
const { ensureStudioIdentity, getStudioSessionId } = require('../middelwares/studioIdentity');

// Soft-auth on every route in this router: anonymous callers are still valid
// (they get the per-session free grant), but a signed-in caller with a Bearer
// token should be identified so we return THEIR balance, not a fresh
// "anonymous" 0. Without this, every logged-in user sees balance=0 because
// `req.user` is never populated.
router.use(optionalAuth);
router.use(ensureStudioIdentity);

function ownerFromReq(req) {
  return {
    userId: req.user?._id || req.user?.userId || req.user?.id || null,
    sessionId: getStudioSessionId(req),
  };
}

router.get('/', async (req, res) => {
  try {
    const owner = ownerFromReq(req);
    if (!owner.userId && !owner.sessionId) {
      return res.json({
        success: true,
        balance: 0,
        anonymous: true,
        needsSession: true,
      });
    }
    const balance = await credits.getBalance(owner);
    return res.json({
      success: true,
      balance,
      anonymous: !owner.userId,
      grant: {
        freeAnon: credits.ANON_FREE_CREDITS,
        signupBonus: credits.SIGNUP_BONUS,
      },
    });
  } catch (err) {
    console.error('[routes/credits] balance error:', err.message);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

router.get('/ledger', async (req, res) => {
  try {
    const owner = ownerFromReq(req);
    if (!owner.userId && !owner.sessionId) {
      return res.json({ success: true, items: [] });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const items = await credits.listLedger({ ...owner, limit });
    return res.json({ success: true, items });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

router.post('/quote', async (req, res) => {
  try {
    const { modelId, kind = 'image', durationSec = 5, variants = 1 } = req.body || {};
    if (!modelId) return res.status(400).json({ success: false, error: 'modelId_required' });
    const cost = await credits.quote({ modelId, kind, durationSec, variants });
    const owner = ownerFromReq(req);
    const balance = await credits.getBalance(owner);
    return res.json({
      success: true,
      cost,
      balance,
      canAfford: balance >= cost,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
