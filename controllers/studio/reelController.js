'use strict';

/**
 * reelController — Phase 4 Scene Builder HTTP surface.
 *
 * Three endpoints:
 *   POST /studio/reel/estimate  — cost + validation preview, zero DB writes.
 *   POST /studio/reel/enqueue   — atomic: create parent + children, charge, queue.
 *   GET  /studio/reel/:id       — parent + aggregated child progress.
 *
 * All three run behind `optionalAuth`. Anonymous callers can still render
 * reels using the session cookie, but ownership checks on `GET /reel/:id`
 * require the same session or a matching user.
 */

const reelService = require('../../services/reelService');
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

// ─── POST /studio/reel/estimate ──────────────────────────────────────────────

exports.estimate = async function estimate(req, res) {
  try {
    const plan = await reelService.planReel(req.body || {});
    return res.status(200).json({
      success: true,
      sceneCount:       plan.sceneCount,
      totalCreditsCost: plan.totalCreditsCost,
      totalDurationSec: plan.totalDurationSec,
      scenes:           plan.scenes,
      reelMeta:         plan.reelMeta,
      // Echo back the resolved scenes so the UI can show which start-frames
      // were inherited from previous scenes' end-frames (continuity feature).
      resolvedScenes: plan.resolvedScenes.map((s) => ({
        id: s.id,
        sceneIndex: s.sceneIndex,
        durationSec: s.durationSec,
        modelId: s.modelId,
        aspectRatio: s.aspectRatio,
        firstFrameUrl: s.firstFrameUrl,
        lastFrameUrl: s.lastFrameUrl,
        inheritedStartFrame: !!s._inheritedStartFrame,
      })),
    });
  } catch (err) {
    return handleReelError(res, err);
  }
};

// ─── POST /studio/reel/enqueue ───────────────────────────────────────────────

exports.enqueue = async function enqueue(req, res) {
  try {
    const result = await reelService.enqueueReel({ req, inputs: req.body || {} });

    if (result.isNewSession && result.sessionId) {
      res.cookie('qumak_session', result.sessionId, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'strict',
      });
    }

    return res.status(201).json({
      success: true,
      reelId:           result.reelId,
      sessionId:        result.sessionId,
      sceneCount:       result.sceneCount,
      totalCreditsCost: result.totalCreditsCost,
      totalDurationSec: result.totalDurationSec,
      childJobIds:      result.childJobIds,
      reelMeta:         result.reelMeta,
      message: `Reel queued — ${result.sceneCount} scenes · ~${result.totalDurationSec}s.`,
    });
  } catch (err) {
    return handleReelError(res, err);
  }
};

// ─── GET /studio/reel/:id ────────────────────────────────────────────────────

exports.get = async function get(req, res) {
  try {
    const owner = ownerFromReq(req);
    const reel = await reelService.getReel(req.params.id, owner);
    if (!reel) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Reel not found.' });
    }
    return res.status(200).json({ success: true, reel });
  } catch (err) {
    return handleReelError(res, err);
  }
};

// ─── Error shaping ───────────────────────────────────────────────────────────

function handleReelError(res, err) {
  // Zod validation — pull the first human message.
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

  // modelRouter emits these — we preserve the precise error code so the UI
  // can render "pick a different model" / "upload a reference" / etc.
  if (err?.code === 'requested_model_unavailable') {
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      sceneIndex: err.sceneIndex ?? null,
      requestedModelId: err.requestedModelId,
      availableModels:  err.availableModels,
    });
  }
  if (err?.code === 'missing_required_field') {
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      sceneIndex: err.sceneIndex ?? null,
      missing: err.missing,
      modelId: err.modelId,
    });
  }
  if (err?.code === 'unreachable_asset_url') {
    // A scene's firstFrame/lastFrame/reference URL is localhost or a
    // private-network host that FAL can't fetch. Explicit 400 with the
    // exact offending field + URL so the UI can point the user at it.
    return res.status(400).json({
      success: false,
      error: err.code,
      message: err.message,
      sceneIndex: err.sceneIndex ?? null,
      fieldName:  err.fieldName || null,
      url:        err.url || null,
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
      message: 'You do not have access to this reel.',
    });
  }

  console.error('[reelController] unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: 'reel_internal_error',
    message: err?.message || 'Reel processing failed.',
  });
}
