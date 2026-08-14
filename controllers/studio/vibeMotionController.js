'use strict';

/**
 * vibeMotionController — HTTP surface for "Create with Vibe Motion".
 *
 *   POST /studio/vibe-motion/generate → { jobId, creditsCharged, status }
 *
 * Accepts a preset (infographics | textAnimation | posters |
 * presentation | scratch), a user prompt, and an optional seed tile
 * URL picked from data/manifest.json (served by
 * /studio/templates/vibe-motion/:preset). Persists a StudioJob,
 * charges credits, and hands off to vibeMotionService.runVibeMotionJob.
 */

const StudioJob          = require('../../model/schema/studioJob');
const vibeMotionService  = require('../../services/vibeMotionService');
const { runVibeMotionJob } = require('../../services/pipelines/vibeMotionPipeline');
const creditsService     = require('../../services/creditsService');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

function getSessionId(req) {
  return getStudioSessionId(req);
}
function ownerFromReq(req, sessionId) {
  return { userId: req.user?._id || null, sessionId: sessionId || null };
}
function isAdminUser(req) {
  return !!req.user && ['admin', 'superadmin'].includes(req.user.role);
}

async function generate(req, res) {
  const sessionId = getSessionId(req);
  const owner = ownerFromReq(req, sessionId);
  const isAdmin = isAdminUser(req);

  const {
    preset        = 'scratch',
    prompt        = '',
    referenceImageUrl = null,
    seedTileUrl   = null,
    aspectRatio   = null,
    duration      = null,
    brandName     = 'general',
  } = req.body || {};

  if (!owner.userId && !owner.sessionId) {
    return res.status(400).json({ success: false, error: 'session_required' });
  }
  if (!prompt && !referenceImageUrl && !seedTileUrl) {
    return res.status(400).json({
      success: false,
      error: 'prompt_required',
      message: 'Describe what you want or pick a tile to start from.',
    });
  }

  const cfg = vibeMotionService.getPresetConfig(preset);
  if (!cfg) {
    return res.status(400).json({ success: false, error: 'unknown_preset' });
  }
  if (cfg.requiresImage && !referenceImageUrl && !seedTileUrl) {
    return res.status(400).json({
      success: false,
      error: 'image_required',
      message: `${cfg.name} needs a source image to animate. Upload one or pick a tile.`,
    });
  }

  const cost = vibeMotionService.DEFAULT_VIBE_CREDITS;
  if (!isAdmin) {
    const afford = await creditsService.canAfford(owner, cost);
    if (!afford.ok) {
      return res.status(402).json({
        success: false,
        error: 'insufficient_credits',
        message: `Vibe Motion needs ${cost} credits. Current balance: ${afford.balance}.`,
        required: cost,
        balance:  afford.balance,
      });
    }
  }

  const job = await StudioJob.create({
    userId:    owner.userId,
    sessionId: owner.sessionId || `vibe-${Date.now()}`,
    category:  'general',
    kind:      'video',
    status:    'queued',
    progress:  5,
    statusMessage: `Queued for ${cfg.name}…`,
    isWatermarked: !isAdmin,
    modelId:       'vibe_motion',
    falModelId:    cfg.falModelId,
    userInputs: {
      brandName,
      description:  prompt || '',
      aspectRatio:  aspectRatio || cfg.aspectRatio,
      duration:     duration || cfg.duration,
      referenceImageUrl: referenceImageUrl || seedTileUrl || null,
      extras: {
        feature: 'vibeMotion',
        preset,
        seedTileUrl,
      },
    },
    promptPipeline: {
      rawUserIntent: prompt,
      finalPrompt:   prompt,
      strategy:      'template',
      intentType:    'vibe_motion',
      domain:        'video',
      confidence:    1,
      sceneFromUser: true,
    },
    tier: isAdmin ? 'agency' : 'free',
  });

  if (!isAdmin && cost > 0) {
    try {
      await creditsService.chargeForJob({ owner, job, cost, modelId: 'vibe_motion' });
    } catch (err) {
      job.status = 'failed';
      job.statusMessage = 'Credit charge failed. Nothing was started.';
      job.error = { message: err.message, code: 'CREDIT_CHARGE_FAILED' };
      await job.save().catch(() => {});
      return res.status(402).json({
        success: false,
        error: 'credit_charge_failed',
        message: err.message || 'Credit charge failed.',
      });
    }
  }

  setImmediate(() => {
    vibeMotionService.runVibeMotionJob(job._id).catch((err) => {
      console.error('[vibeMotionController] runVibeMotionJob fatal:', err);
    });
  });

  return res.json({
    success:        true,
    jobId:          String(job._id),
    status:         'queued',
    creditsCharged: isAdmin ? 0 : cost,
    preset,
    falModelId:     cfg.falModelId,
  });
}

module.exports = { generate };
