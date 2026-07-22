'use strict';

/**
 * studioController.js — enqueueGeneration rewrite
 *
 * WHAT CHANGED:
 *   1. category enum → z.string().optional() — accepts anything, resolves via intentEngine
 *   2. mode enum ['normal','business'] → dropped entirely — intentEngine classifies intent
 *   3. adBrain + promptEnhancer serial chain → single intentEngine.run() call
 *   4. Pipe-separated prompt fragments → natural-language prompt from synthesizer
 *   5. URL scrape data flows into intentEngine context
 *
 * DROP-IN: replace only enqueueGeneration. All other exports unchanged.
 */

const { z } = require('zod');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getRedis } = require('../../services/redis');
const StudioJob     = require('../../model/schema/studioJob');
const intentEngine  = require('../../services/intentEngine');        // ← replaces adBrain + promptEnhancer
const { enqueueStudioJob } = require('../../services/queues');
const creditsService = require('../../services/creditsService');
const modelRouter    = require('../../services/modelRouter');
const promptBuilder  = require('../../services/promptBuilder_v2');   // kept for template path
const { GenerationTemplate } = require('../../model/schema/GenerationTemplate');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');
const {CreditLedger} = require('../../model/schema/creditLedger');
const TIER_PRIORITY  = { agency: 1, pro: 2, starter: 5, free: 5 };
const CONTENT_BLOCKLIST = ['nude','naked','explicit','nsfw','weapon','violence','blood','drug'];
const User = require('../../model/schema/user');
function checkContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONTENT_BLOCKLIST.some(w => lower.includes(w));
}

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return { userId: req.user?._id || null, sessionId: sessionId || null };
}

// ─── INPUT SCHEMA ─────────────────────────────────────────────────────────
//
// category: open string — intentEngine classifies it.
// mode:     removed. Intent type comes from intentEngine.
// All other fields unchanged for backwards compatibility.

const constraintsSchema = z.object({
  cameraAngle: z.string().optional(),
  lighting:    z.string().optional(),
  shotType:    z.string().optional(),
  motion:      z.string().optional(),
  pace:        z.string().optional(),
  mood:        z.string().optional(),
  tone:        z.string().optional(),
  timeOfDay:   z.string().optional(),
  environment: z.string().optional(),
  styleTags:   z.array(z.string()).optional(),
}).partial().optional();

const audioSchema = z.object({
  enabled:     z.boolean().optional(),
  mode:        z.enum(['native', 'tts', 'upload']).optional(),
  script:      z.string().max(8000).optional(),
  voiceId:     z.string().max(120).optional(),
  language:    z.string().max(32).optional(),
  musicStyle:  z.string().max(400).optional(),
  audioUrl:    z.string().url().optional(),
}).partial().optional();

const generateSchema = z.object({
  // Open string — no enum. intentEngine resolves this to a domain.
  category:       z.string().optional().default(''),
  brandName:      z.string().max(100).optional().default(''),
  description:    z.string().max(6000).optional().default(''),
  prompt:         z.string().max(6000).optional(),
  targetAudience: z.string().max(1000).optional().default(''),
  vibe:           z.string().max(80).optional().default(''),
  locale:         z.enum(['gulf', 'global']).optional().default('gulf'),
  aspectRatio:    z.enum(['16:9', '9:16', '1:1', '4:5', '3:4', '4:3']).optional().default('16:9'),
  duration:       z.coerce.number().int().min(1).max(60).optional().default(5),
  templateId:     z.string().optional(),
  modelId:        z.string().optional(),
  variants:       z.number().int().min(1).max(6).optional().default(1),
  constraints:    constraintsSchema,
  audio:          audioSchema.optional(),
  referenceImageUrl: z.string().url().optional(),
  endFrameUrl:    z.string().url().optional(),
  resolution:     z.enum(['480p','720p','1080p','4k']).optional(),
  motion:         z.string().max(40).optional(),
  sceneIndex:     z.number().int().optional(),
  sceneCount:     z.number().int().optional(),
  extras:         z.record(z.string(), z.unknown()).optional().default({}),
  // Manifest-driven path: frontend builds the provider-key payload from the
  // manifest's inputSlots and sends it here. modelRouter passes it straight
  // to falPayloadSanitizer without the legacy buildProviderInput translation.
  // Must be optional so legacy callers (without a manifest) still work.
  providerInput:  z.record(z.string(), z.unknown()).optional(),
  // URL-to-ad scraped payload (populated by the scraper middleware before reaching here)
  _urlScrapeData: z.record(z.string(), z.unknown()).optional(),
  // Legacy mode field — ignored, kept to avoid breaking existing callers
  mode:           z.string().optional(),
});


// creditsService.js
async function atomicChargeForJob({ owner, cost, jobId }) {
  const filter = owner.userId 
    ? { userId: owner.userId, credits: { $gte: cost } }
    : { sessionId: owner.sessionId, credits: { $gte: cost } };
  
  const result = await CreditLedger.findOneAndUpdate(
    filter,
    { 
      $inc: { credits: -cost },
      $push: { transactions: { jobId, cost, at: new Date(), type: 'charge' } }
    },
    { new: true }
  );
  
  if (!result) {
    const err = new Error('Insufficient credits');
    err.code = 'insufficient_credits';
    throw err;
  }
  
  return result;
}
// ─── CORE ENQUEUE ─────────────────────────────────────────────────────────

async function enqueueGeneration(req, res, kind) {
  if (req.body?.prompt?.trim() && !req.body.description?.trim()) {
    req.body.description = req.body.prompt.trim();
  }
  if(!req.body?.prompt && req.body?.providerInput?.prompt) {
    req.body.prompt = req.body.providerInput.prompt;
  }

  const parseResult = generateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error:   'validation_error',
      message: parseResult.error.issues.map(i => i.message).join(', '),
    });
  }
  const inputs = parseResult.data;

  const idemHeader = req.get('Idempotency-Key') || req.get('idempotency-key');
  let idemRedisKey = null;
  if (idemHeader && process.env.STUDIO_IDEMPOTENCY_REDIS !== '0') {
    const idemOwner =
      (req.user?._id && String(req.user._id)) ||
      req.cookies?.qumak_session ||
      req.headers['x-session-id'] ||
      req.ip ||
      'unknown';
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
    idemRedisKey = `idem:studio:generate:${kind}:${idemOwner}:${idemHeader}:${bodyHash}`;
    try {
      const cached = await getRedis().get(idemRedisKey);
      if (cached) {
        return res.status(200).json(JSON.parse(cached));
      }
    } catch (e) {
      console.warn('[enqueue] idempotency read skipped', e.message);
    }
  }

  let sessionId = getSessionId(req);
  const isNewSession = !sessionId;
  if (!sessionId) sessionId = uuidv4();

  const isAdmin = (req.user?.role || '').toLowerCase() === 'admin';
  const tier    = isAdmin ? 'agency' : (req.user?.plan || 'free');

  if (tier === 'free') {
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const count = await StudioJob.countDocuments({
      sessionId,
      status: { $in: ['completed', 'generating', 'queued'] },
      createdAt: { $gte: monthStart },
    });
    if (count >= 10) {
      return res.status(429).json({
        success: false, error: 'free_limit_reached',
        message: 'Free plan allows 10 generations per month. Upgrade to continue.',
        upgradeUrl: '/pricing',
      });
    }
  }

  const textToCheck = [inputs.brandName, inputs.description, inputs.targetAudience].join(' ');
  if (checkContent(textToCheck)) {
    return res.status(400).json({
      success: false, error: 'content_policy_violation',
      message: 'Your submission contains content that violates our usage policy.',
    });
  }
  

  
  // Resolve template (optional)
  let template = null;
  if (inputs.templateId) {
    try { template = await GenerationTemplate.findById(inputs.templateId).lean(); }
    catch (_) {}
  }
  
  let finalPrompt, negativePrompt, promptStrategy, intentResult;
  
  const urlScrapeData = inputs._urlScrapeData || null;

  if (template?.promptBlueprint) {
    // Template path: blueprint substitution, then intentEngine wraps context
    const mergedConstraints = { ...(template.constraints || {}), ...(inputs.constraints || {}) };
    const built = promptBuilder.buildFromTemplate(template, {
      brandName:   inputs.brandName,
      productName: inputs.extras?.productName,
      productDesc: (inputs.prompt || inputs.description || '').trim(),
      hookLine:    inputs.extras?.hookLine,
      ctaLine:     inputs.extras?.ctaLine,
      locale:      inputs.locale,
      vibe:        inputs.vibe,
      constraints: mergedConstraints,
    });
    finalPrompt    = intentEngine.appendNativeAudioTail(built.finalPrompt, inputs.audio);
    negativePrompt = built.negativePrompt;
    promptStrategy = 'template';

    // Classify for metadata only — don't overwrite the template prompt
    intentResult = await intentEngine.classifyIntent({
      rawInput: (inputs.prompt || inputs.description || '').trim(),
      locale:   inputs.locale,
      extras:   { brandName: inputs.brandName, urlScrape: urlScrapeData },
    });
  } else {
    // Universal path — all modes, all categories, all locales
    const engineResult = await intentEngine.run({
      knownDomain: inputs.category,
      inputs: {
        ...inputs,
        prompt:      (inputs.prompt || inputs.description || '').trim(),
        description: (inputs.description || inputs.prompt || '').trim(),
      },
      urlScrapeData,
      template: null,
    });


    intentResult   = engineResult.intent;
    finalPrompt    = engineResult.finalPrompt;
    negativePrompt = engineResult.negativePrompt;
    promptStrategy = engineResult.intent?.intent_type || 'universal';



  }

  // ── MODEL ROUTING ─────────────────────────────────────────────────────
  let routed = {};

  const modelData = {
    template,
    requestedModelId: inputs.modelId,
    providerInput: inputs?.providerInput || {},                                // ← single clean source
    kind,
    prompts:           { finalPrompt, negativePrompt },
    aspectRatio:       inputs.aspectRatio,
    durationSec:       inputs.duration,
    variants:          inputs.variants,
    referenceImageUrl: inputs.referenceImageUrl,
    endFrameUrl:       inputs.endFrameUrl,
    resolution:        inputs.resolution,
    motion:            inputs.motion || inputs.constraints?.motion,
    audio:             inputs.audio,
    slots:             inputs.extras || {},
    extras: inputs.extras || {},
    // _providerInput: inputs?.providerInput || {},
  }
  try {
    routed = await modelRouter.route(modelData);
  } catch (err) {
    console.error('[studioController] modelRouter error:', err.code, err.message);
 
    let status = 503;
    if (err.code === 'requested_model_unavailable') status = 400;
    if (err.code === 'missing_required_field')      status = 400;
    if (err.code === 'invalid_aspect_ratio')        status = 400;
    if (err.code === 'invalid_audio_for_model')     status = 400;
    if (err.code === 'invalid_duration')            status = 400;
    if (err.code === 'invalid_model_input')         status = 400;
    if (err.code === 'unsupported_provider')        status = 503;
    if (err.code === 'model_missing_fal_endpoint')  status = 503;
    if (err.code === 'no_model_available')          status = 503;
    if (err.code === 'config_error')                status = 503;
 
    return res.status(status).json({
      success: false,
      error:   err.code || 'model_unavailable',
      message: err.message,
      requestedModelId:      err.requestedModelId,
      availableModels:       err.availableModels,
      missing:               err.missing,
      modelId:               err.modelId,
      details:               err.details,
      suggestedAspectRatios: err.suggestedAspectRatios,
      aspectRatio:           err.aspectRatio,
    });
  }

  // ── CREDITS ───────────────────────────────────────────────────────────

  const owner   = ownerFromReq(req, sessionId);
  const user = await User.findById(req.user?._id).select('role').lean();
  
  const balance = await creditsService.getBalance(owner);
  if ( user?.role !== 'admin' && balance < routed.creditsCost) {
    return res.status(402).json({
      success: false, error: 'insufficient_credits',
      required: routed.creditsCost, balance,
      message: 'Not enough credits. Top up to continue.',
      topupUrl: '/pricing',
    });
  }


  // ── PERSIST JOB ──────────────────────────────────────────────────────
  
  const duration = kind === 'video' ? routed?.durationSec ?? inputs.duration : inputs.duration;  
  const isWatermarked = !isAdmin && tier === 'free';
  const userInputsWithEnvelope = {
      ...modelData,
      duration,

      _providerInput: routed?.input,
    };

  const job = await StudioJob.create({
    userId:    req.user?._id || null,
    sessionId,
    category:  intentResult?.domain || inputs.category || 'unknown',
    kind,
    userInputs: userInputsWithEnvelope,
    promptPipeline: {
      rawUserIntent: (inputs.prompt || inputs.description || '').trim(),
      finalPrompt,
      negativePrompt,
      strategy:   promptStrategy,
      intentType: intentResult?.intent_type,
      domain:     intentResult?.domain,
      gulfRelevant: intentResult?.gulf_relevant,
      confidence: intentResult?.confidence,
    },
    tier,
    isWatermarked,
    status:       'queued',
    statusMessage: `Your ${kind} is queued for generation.`,
    templateId:   template?._id || null,
    modelId:      routed.modelId,
    falModelId:   routed.falModelId,
    variantsRequested: inputs.variants,
  });

  try {
    if (!isAdmin) {
      await creditsService.chargeForJob({ owner, job, cost: routed.creditsCost, modelId: routed.modelId, templateId: template?._id || null });
    } 
    else {
      job.creditsCharged = 0;
      await job.save();
    }
  } catch (err) {
    job.status = 'failed';
    job.statusMessage = 'Could not charge credits.';
    job.error = { message: err.message, code: err.code || 'billing_failed' };
    await job.save();
    return res.status(402).json({ success: false, error: err.code || 'billing_failed', message: 'Could not charge credits.' });
  }

  await enqueueStudioJob({ jobId: job._id.toString(), kind, priority: TIER_PRIORITY[tier] || 5 });

  if (isNewSession) {
    res.cookie('qumak_session', sessionId, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'strict' });
  }

  const estimatedTime = tier === 'free' ? '3-5 minutes' : tier === 'pro' ? '2-4 minutes' : '1-3 minutes';

  const responseBody = {
    success: true,
    jobId:        job._id.toString(),
    sessionId,
    status:       'queued',
    estimatedTime,
    creditsCharged: routed.creditsCost,
    modelId:      routed.modelId,
    modelLabel:   routed.label,
    ...(routed.durationSecAdjusted
      ? {
          durationSecAdjusted: true,
          effectiveDurationSec: routed.durationSec,
          requestedDurationSec: routed.requestedDurationSec,
        }
      : {}),
    intent: {
      type:   intentResult?.intent_type,
      domain: intentResult?.domain,
    },
    message: `Your ${kind} is queued. Connect via WebSocket room studio:${sessionId} for live updates.`,
  };

  if (idemRedisKey && process.env.STUDIO_IDEMPOTENCY_REDIS !== '0') {
    try {
      await getRedis().set(idemRedisKey, JSON.stringify(responseBody), 'EX', 600);
    } catch (e) {
      console.warn('[enqueue] idempotency write skipped', e.message);
    }
  }

  return res.status(201).json(responseBody);
}

exports.createImageGeneration = (req, res) => enqueueGeneration(req, res, 'image');
exports.createGeneration      = (req, res) => enqueueGeneration(req, res, 'video');
exports.createVideoGeneration = exports.createGeneration;

module.exports.enqueueGeneration = enqueueGeneration;
