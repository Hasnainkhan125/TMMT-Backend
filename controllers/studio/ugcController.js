'use strict';

/**
 * ugcController — HTTP surface for the UGC Factory.
 *
 *   POST /studio/ugc/generate → { jobId, creditsCharged, status }
 *
 * Accepts a creator template (from scripts/creatify_templates.json via
 * templatesCatalog.getTemplateById), an optional user-uploaded
 * portrait, an action script, an audio script (TTS input), and
 * optional background prompt. Persists a StudioJob, charges credits,
 * and hands off to ugcService.runUgcJob in the background. Progress
 * flows through the standard /studio/job/:id polling + Socket.IO.
 */

const StudioJob     = require('../../model/schema/studioJob');
const ugcService    = require('../../services/ugcService');
const creditsService = require('../../services/creditsService');
const catalog       = require('../../services/templatesCatalog');
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
    templateId        = null,
    portraitUrl       = null,
    actionPrompt      = '',
    audioScript       = '',
    backgroundPrompt  = '',
    voiceId           = 'rachel',
    language          = 'en',
    aspectRatio       = '9:16',
    resolution        = '720p',
    duration          = 8,
    brandName         = 'general',
    motionTemplateVideoUrl = null,
  } = req.body || {};

  if (!owner.userId && !owner.sessionId) {
    return res.status(400).json({ success: false, error: 'session_required' });
  }
  if (!templateId && !portraitUrl) {
    return res.status(400).json({
      success: false,
      error: 'template_or_portrait_required',
      message: 'Pick a UGC template or upload a portrait to get started.',
    });
  }
  if (!actionPrompt && !audioScript) {
    return res.status(400).json({
      success: false,
      error: 'prompt_required',
      message: 'Describe the action or add an audio script so we know what to generate.',
    });
  }

  const template = templateId ? catalog.getTemplateById(templateId) : null;
  if (templateId && !template) {
    return res.status(404).json({ success: false, error: 'template_not_found' });
  }

  const cost = ugcService.DEFAULT_UGC_CREDITS;
  if (!isAdmin) {
    const afford = await creditsService.canAfford(owner, cost);
    if (!afford.ok) {
      return res.status(402).json({
        success: false,
        error: 'insufficient_credits',
        message: `UGC Factory needs ${cost} credits. Current balance: ${afford.balance}.`,
        required: cost,
        balance:  afford.balance,
      });
    }
  }

  const falModelId = ugcService.resolveFalModelId(template);

  const job = await StudioJob.create({
    userId:    owner.userId,
    sessionId: owner.sessionId || `ugc-${Date.now()}`,
    category:  'general',
    kind:      'video',
    status:    'queued',
    progress:  5,
    statusMessage: 'Queued for UGC rendering…',
    isWatermarked: !isAdmin,
    modelId:       'ugc_factory',
    falModelId,
    userInputs: {
      brandName,
      description: actionPrompt || '',
      aspectRatio,
      duration,
      resolution,
      referenceImageUrl: portraitUrl || template?.previewUrl || null,
      extras: {
        feature:     'ugc',
        templateId:  templateId || null,
        falModelId,
        portraitUrl: portraitUrl || template?.previewUrl || null,
        actionPrompt,
        backgroundPrompt,
        audioScript,
        voiceId,
        language,
        motionTemplateVideoUrl: motionTemplateVideoUrl || null,
      },
    },
    promptPipeline: {
      rawUserIntent: actionPrompt || audioScript || '',
      finalPrompt:   '',
      strategy:      'template',
      intentType:    'ugc',
      domain:        'video',
      gulfRelevant:  language !== 'en',
      confidence:    1,
      sceneFromUser: true,
    },
    tier: isAdmin ? 'agency' : 'free',
  });

  if (!isAdmin && cost > 0) {
    try {
      await creditsService.chargeForJob({ owner, job, cost, modelId: 'ugc_factory' });
    } catch (err) {
      job.status = 'failed';
      job.statusMessage = 'Credit charge failed. No UGC render was started.';
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
    ugcService.runUgcJob(job._id).catch((err) => {
      console.error('[ugcController] runUgcJob fatal:', err);
    });
  });

  return res.json({
    success:        true,
    jobId:          String(job._id),
    status:         'queued',
    creditsCharged: isAdmin ? 0 : cost,
    template:       template ? { id: template.id, name: template.name } : null,
    falModelId,
  });
}

module.exports = { generate };
