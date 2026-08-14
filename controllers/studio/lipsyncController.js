'use strict';

/**
 * lipsyncController — HTTP surface for Lipsync Studio.
 *
 *   GET  /studio/lipsync/catalog          → { models, voices }
 *   POST /studio/lipsync/tts              → { audioUrl } (server-side TTS preview)
 *   POST /studio/lipsync/generate         → { jobId, creditsCharged, status }
 *
 * Generate persists a StudioJob, charges credits, and hands off to
 * lipsyncService.runLipsyncJob in the background. Progress flows
 * through the existing /studio/job/:id + Socket.IO 'job-update' channel.
 */

const StudioJob        = require('../../model/schema/studioJob');
const lipsyncService   = require('../../services/lipsyncService');
const creditsService   = require('../../services/creditsService');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return {
    userId:    req.user?._id || null,
    sessionId: sessionId || null,
  };
}

function isAdminUser(req) {
  return !!req.user && ['admin', 'superadmin'].includes(req.user.role);
}

// ─── GET /studio/lipsync/catalog ───────────────────────────────────────────
async function catalog(_req, res) {
  return res.json({
    success: true,
    models: lipsyncService.LIPSYNC_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      description: m.description,
      inputKind: m.inputKind,
      supportsImage: m.supportsImage,
      credits: m.credits,
      estSeconds: m.estSeconds,
    })),
    voices: lipsyncService.LIPSYNC_VOICES,
  });
}

// ─── POST /studio/lipsync/tts ──────────────────────────────────────────────
// Lightweight TTS preview — lets the user listen to the voice before
// spending lipsync credits. Non-charging because the upstream TTS cost
// is trivially low; abuse is blocked by the express rate limiter applied
// at the router level.
async function tts(req, res) {
  const { text, voiceId = 'rachel', language = 'en' } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: 'text_required' });
  }
  try {
    const audioUrl = await lipsyncService.generateTtsAudio({
      text, voiceId, language,
    });
    if (!audioUrl) {
      return res.status(502).json({ success: false, error: 'tts_failed' });
    }
    return res.json({ success: true, audioUrl, voiceId });
  } catch (err) {
    console.error('[lipsyncController] tts error:', err);
    return res.status(502).json({
      success: false,
      error: 'tts_failed',
      message: err.message || 'Voice generation failed.',
    });
  }
}

// ─── POST /studio/lipsync/generate ─────────────────────────────────────────
async function generate(req, res) {
  const sessionId = getSessionId(req);
  const owner = ownerFromReq(req, sessionId);
  const isAdmin = isAdminUser(req);

  const {
    modelId      = 'sync_lipsync_v2',
    portraitUrl,
    audioUrl     = null,
    audioScript  = '',
    voiceId      = 'rachel',
    language     = 'en',
    aspectRatio  = '9:16',
    resolution   = '720p',
    prompt       = '',
    brandName    = 'general',
    motionTemplateVideoUrl = null,
  } = req.body || {};

  if (!owner.userId && !owner.sessionId) {
    return res.status(400).json({ success: false, error: 'session_required' });
  }
  const model = lipsyncService.getLipsyncModel(modelId);
  if (!model) {
    return res.status(400).json({ success: false, error: 'unknown_model' });
  }
  if (!portraitUrl) {
    return res.status(400).json({ success: false, error: 'portrait_required' });
  }
  if (!audioUrl && !audioScript) {
    return res.status(400).json({ success: false, error: 'audio_required', message: 'Provide either an audio file or a script to speak.' });
  }

  // Charge credits upfront.
  const cost = model.credits;
  if (!isAdmin) {
    const afford = await creditsService.canAfford(owner, cost);
    if (!afford.ok) {
      return res.status(402).json({
        success: false,
        error: 'insufficient_credits',
        message: `You need ${cost} credits for ${model.name}. Current balance: ${afford.balance}.`,
        required: cost,
        balance:  afford.balance,
      });
    }
  }

  // Persist the job BEFORE charging so we have a row to refund against.
  const job = await StudioJob.create({
    userId:    owner.userId,
    sessionId: owner.sessionId || `lipsync-${Date.now()}`,
    category:  'general',
    kind:      'video',
    status:    'queued',
    progress:  5,
    statusMessage: `Queued for ${model.name}…`,
    isWatermarked: !isAdmin,
    modelId:       model.id,
    falModelId:    model.falModelId,
    userInputs: {
      brandName,
      description:  prompt || '',
      aspectRatio,
      duration:     null,
      resolution,
      referenceImageUrl: portraitUrl,
      extras: {
        feature:        'lipsync',
        lipsyncModelId: model.id,
        portraitUrl,
        audioUrl,
        audioScript,
        voiceId,
        language,
        motionTemplateVideoUrl: motionTemplateVideoUrl || null,
      },
    },
    promptPipeline: {
      rawUserIntent: prompt || audioScript || '',
      finalPrompt:   prompt || audioScript || '',
      strategy:      'template',
      intentType:    'lipsync',
      domain:        'video',
      gulfRelevant:  language !== 'en',
      confidence:    1,
      sceneFromUser: true,
    },
    tier: isAdmin ? 'agency' : 'free',
  });

  if (!isAdmin && cost > 0) {
    try {
      await creditsService.chargeForJob({
        owner,
        job,
        cost,
        modelId: model.id,
      });
    } catch (err) {
      job.status = 'failed';
      job.statusMessage = 'Credit charge failed. No lipsync was started.';
      job.error = { message: err.message, code: 'CREDIT_CHARGE_FAILED' };
      await job.save().catch(() => {});
      return res.status(402).json({
        success: false,
        error: 'credit_charge_failed',
        message: err.message || 'Credit charge failed.',
      });
    }
  }

  // Fire-and-forget: the HTTP response returns immediately, the work
  // runs in the background, the UI polls /studio/job/:id.
  setImmediate(() => {
    lipsyncService.runLipsyncJob(job._id).catch((err) => {
      console.error('[lipsyncController] runLipsyncJob fatal:', err);
    });
  });

  return res.json({
    success: true,
    jobId: String(job._id),
    status: 'queued',
    creditsCharged: isAdmin ? 0 : cost,
    modelId: model.id,
    model: {
      id:       model.id,
      name:     model.name,
      credits:  model.credits,
      estSeconds: model.estSeconds,
    },
  });
}

module.exports = { catalog, tts, generate };
