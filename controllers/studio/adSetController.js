'use strict';

/**
 * adSetController — Phase 5 Ads Pipeline HTTP surface.
 *
 * Three endpoints mirror reelController for UX symmetry:
 *   POST /studio/ads/estimate  — cost + variant preview, zero DB writes.
 *   POST /studio/ads/enqueue   — atomic: parent + N children, charge, queue.
 *   GET  /studio/ads/:id       — parent + child progress + generated copy.
 *
 * All three run behind `optionalAuth`. Anonymous callers can still generate
 * ad sets using their session cookie; ownership checks on `GET /:id` require
 * either the same session or a matching user.
 */

const adSetService = require('../../services/adSetService');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req) {
  return {
    userId: req.user?._id || null,
    sessionId: getSessionId(req),
  };
}

// ─── POST /studio/ads/estimate ───────────────────────────────────────────────

exports.estimate = async function estimate(req, res) {
  try {
    const plan = await adSetService.planAdSet(req.body || {});
    return res.status(200).json({
      success: true,
      numVariants:      plan.numVariants,
      kind:             plan.kind,
      aspectRatio:      plan.aspectRatio,
      modelId:          plan.modelId,
      baseCost:         plan.baseCost,
      copyCost:         plan.copyCost,
      totalCreditsCost: plan.totalCreditsCost,
      variants:         plan.variants,
      variantBriefs:    plan.variantBriefs,
      intent:           plan.intent,
      adSetMeta:        plan.adSetMeta,
    });
  } catch (err) {
    return handleAdSetError(res, err);
  }
};

// ─── POST /studio/ads/enqueue ────────────────────────────────────────────────

exports.enqueue = async function enqueue(req, res) {
  try {
    const result = await adSetService.enqueueAdSet({ req, inputs: req.body || {} });

    if (result.isNewSession && result.sessionId) {
      res.cookie('qumak_session', result.sessionId, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'strict',
      });
    }

    return res.status(201).json({
      success: true,
      adSetId:          result.adSetId,
      sessionId:        result.sessionId,
      numVariants:      result.numVariants,
      totalCreditsCost: result.totalCreditsCost,
      baseCost:         result.baseCost,
      copyCost:         result.copyCost,
      childJobIds:      result.childJobIds,
      adSetMeta:        result.adSetMeta,
      message: `Ad set queued — ${result.numVariants} variants · ${result.totalCreditsCost} credits.`,
    });
  } catch (err) {
    return handleAdSetError(res, err);
  }
};

// ─── GET /studio/ads/:id ─────────────────────────────────────────────────────

exports.get = async function get(req, res) {
  try {
    const owner = ownerFromReq(req);
    const adSet = await adSetService.getAdSet(req.params.id, owner);
    if (!adSet) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Ad set not found.' });
    }
    return res.status(200).json({ success: true, adSet });
  } catch (err) {
    return handleAdSetError(res, err);
  }
};

// ─── Error shaping ───────────────────────────────────────────────────────────

function handleAdSetError(res, err) {
  if (err?.issues && Array.isArray(err.issues)) {
    const msg = err.issues.map((i) => {
      const path = Array.isArray(i.path) && i.path.length ? i.path.join('.') : 'input';
      return `${path}: ${i.message}`;
    }).join('; ');
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      message: msg,
      issues: err.issues,
    });
  }

  if (err?.code === 'requested_model_unavailable') {
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      variantIndex: err.variantIndex ?? null,
      requestedModelId: err.requestedModelId,
      availableModels:  err.availableModels,
    });
  }
  if (err?.code === 'missing_required_field') {
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      variantIndex: err.variantIndex ?? null,
      missing: err.missing,
      modelId: err.modelId,
    });
  }
  if (err?.code === 'unreachable_asset_url') {
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      fieldName: err.fieldName || null,
      url:       err.url || null,
    });
  }
  if (err?.code === 'no_model_available') {
    return res.status(503).json({
      success: false,
      error: err.code,
      message: err.message,
    });
  }
  if (err?.code === 'insufficient_credits') {
    return res.status(402).json({
      success: false,
      error: err.code,
      message: `Need ${err.required} credits — you have ${err.balance}.`,
      required: err.required,
      balance:  err.balance,
      topupUrl: '/pricing',
    });
  }
  if (err?.code === 'forbidden') {
    return res.status(403).json({
      success: false,
      error: 'forbidden',
      message: 'You do not have access to this ad set.',
    });
  }

  console.error('[adSetController] unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: 'ad_set_internal_error',
    message: err?.message || 'Ad set processing failed.',
  });
}
