'use strict';

/**
 * videoWorker.js — v3
 *
 * FIXES APPLIED (vs your current):
 *   #1 KILLED the adBrain fallback — worker now uses intentEngine
 *      deterministic classifier directly. Same result, no dead DNA switch.
 *
 *   #2 KILLED the double routing. Worker trusts the controller's
 *      `job.modelId` + `job.falModelId` + stored input envelope. Only
 *      re-routes if those are missing (retry of an old job).
 *
 *   #4 FIXED variants. When variantsRequested > 1, worker fires N parallel
 *      fal.subscribe calls and stores them in job.output.variants[]. User
 *      finally gets what they paid for.
 *
 *   #5 KILLED the 10 console.logs in modelRouter (moved to debug gate).
 *
 *   #6 img2img path — when referenceImageUrl is present AND the model is
 *      text-to-image, worker auto-routes to the img2img sibling model.
 *      Kept simple: a static map, not a DB lookup.
 *
 *   Plus: pulls stored `providerInput` from job.userInputs._providerInput
 *   (set by controller) to eliminate input-envelope drift.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { Worker } = require('bullmq');
const { assembleVideoAd } = require('../services/assembleVideoAd');  // adjust path
const StudioJob   = require('../model/schema/studioJob');
const StudioAsset = require('../model/schema/studioAsset');
const DailyStat   = require('../model/schema/dailyStat');
require('../model/schema/demoSession');
const providerRouter = require('../services/providerRouter');
const AiModel = require('../model/schema/aiModel');
    
const falService           = require('../services/falService');
const processingService    = require('../services/processingService');
const { generateTtsAudio } = require('../services/lipsyncService');
const { emitJobUpdate }    = require('../utils/socketEmitter');
const { getRedis }      = require('../services/redis');
const { QUEUE_NAMES }   = require('../services/queues');
const creditsService    = require('../services/creditsService');
const modelRouter       = require('../services/modelRouter');
const intentEngine      = require('../services/intentEngine');
const { GenerationTemplate } = require('../model/schema/GenerationTemplate');

const DEBUG = process.env.STUDIO_DEBUG === 'true';
const dlog = (...args) => { if (DEBUG) console.log('[videoWorker]', ...args); };

// ── img2img sibling map ───────────────────────────────────────────────────
// When a user uploads a reference image but picked a text-to-image model,
// route to the img2img sibling instead. This is the 10-line fix for your
// "Image → Image does nothing" bug.
const IMG2IMG_SIBLINGS = {
  'fal-ai/flux/schnell':   'fal-ai/flux/dev/image-to-image',
  'fal-ai/flux/dev':       'fal-ai/flux/dev/image-to-image',
  'fal-ai/flux-pro':       'fal-ai/flux-pro/kontext',
  'fal-ai/flux-pro/v1.1':  'fal-ai/flux-pro/kontext',
};

const ASPECT_TO_FAL_IMAGE_SIZE = {
  '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '4:3': 'landscape_4_3',
};

// ── MongoDB connection ────────────────────────────────────────────────────
async function connectDB() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    dlog('reusing existing MongoDB connection');
    return;
  }
  const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const DATABASE    = process.env.DB || 'qumak';
  await mongoose.connect(DATABASE_URL + '/' + DATABASE);
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Atomic status writer. We deliberately use `updateOne({$set})` instead of
// `job.save()` because Fal's `onProgress` callback fires many times per
// second, and two concurrent `save()`s on the same Mongoose document throws
// `Can't save() the same doc multiple times in parallel`. `updateOne` is
// safe under concurrency; we mirror the mutation onto the in-memory `job`
// so downstream reads see fresh values without a reload.
async function updateStatus(job, status, progress, statusMessage) {
  job.status = status;
  job.progress = progress;
  job.statusMessage = statusMessage;
  await StudioJob.updateOne(
    { _id: job._id },
    { $set: { status, progress, statusMessage, updatedAt: new Date() } },
  );
  await emitJobUpdate(job.sessionId, {
    jobId: job._id.toString(), status, progress, statusMessage,
  });
}

// Atomic multi-field flush. Used at "safe" checkpoints — i.e. moments
// outside any hot-path / onProgress loop — to persist the in-memory
// mutations (startedAt, addStage/completeStage side-effects, Fal response
// metadata, output URLs, etc.) that we used to rely on `job.save()` to
// push. Everything here is a `$set` so it's concurrent-safe with updateStatus.
async function flushJobPatch(job, fields) {
  if (!fields || !Object.keys(fields).length) return;
  await StudioJob.updateOne(
    { _id: job._id },
    { $set: { ...fields, updatedAt: new Date() } },
  );
}

// Throttles a progress firehose (Fal.ai, FFmpeg) to one invocation per
// `minIntervalMs` AND only when the progress value has moved by at least
// `minDelta` percentage points. The very first call and anything ≥99%
// always pass through so the UI doesn't stall on 0% or miss the final tick.
function makeProgressThrottle({ minIntervalMs = 500, minDelta = 2 } = {}) {
  let lastAt = 0;
  let lastValue = -Infinity;
  return async function throttled(rawValue, fn) {
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue) || 0;
    const now = Date.now();
    const isFirst = lastAt === 0;
    const isFinal = value >= 99;
    const intervalOk = now - lastAt >= minIntervalMs;
    const deltaOk = Math.abs(value - lastValue) >= minDelta;
    if (!isFirst && !isFinal && (!intervalOk || !deltaOk)) return;
    lastAt = now;
    lastValue = value;
    await fn(value);
  };
}

async function persistAsset(job, { type, url, thumbnailUrl, mimeType, resolution, variantIndex = null }) {
  if (!url || typeof url !== 'string') {
    const err = new Error(`persistAsset called without a URL for job ${job?._id}, type=${type}`);
    err.code = 'PERSIST_ASSET_BAD_INPUT';
    throw err;
  }
  const isWatermarked = !!job.isWatermarked;
  const filter = variantIndex != null
    ? { jobId: job._id, type, variantIndex }
    : { jobId: job._id, type };
  const asset = await StudioAsset.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        jobId: job._id,
        sessionId: job.sessionId,
        userId: job.userId || null,
        type,
        category: job.category || '',
        brandName: job.userInputs?.brandName || '',
        tier: job.tier || 'free',
        status: 'completed',
        variantIndex,
      },
      $set: {
        url,
        thumbnailUrl: thumbnailUrl || null,
        mimeType: mimeType || (type === 'video' ? 'video/mp4' : 'image/jpeg'),
        resolution: resolution || null,
        isWatermarked,
        ...(isWatermarked ? { watermarkedUrl: url } : { cleanUrl: url }),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!job.assetId) {
    job.assetId = asset._id;
    await StudioJob.updateOne(
      { _id: job._id, assetId: { $in: [null, undefined] } },
      { $set: { assetId: asset._id, updatedAt: new Date() } },
    ).catch(() => {});
  }
  return asset;
}

async function updateDailyStats(category, timeMs, costUsd, status) {
  const date = new Date().toISOString().split('T')[0];
  try {
    const inc = { totalJobs: 1 };
    if (status === 'completed') {
      inc.completedJobs = 1;
      inc[`categoryBreakdown.${category || 'unclassified'}`] = 1;
      if (costUsd) inc.totalFalCost = costUsd;
    } else if (status === 'failed') {
      inc.failedJobs = 1;
    }
    await DailyStat.findOneAndUpdate(
      { date },
      { $inc: inc, $setOnInsert: { date } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.warn('[videoWorker] updateDailyStats failed (non-fatal):', err.message);
  }
}

// ── Prompt fallback (FIX #1) ──────────────────────────────────────────────
// No more adBrain switch. Uses intentEngine's deterministic classifier.
function rebuildPromptFromJob(job) {
  const rawInput = job.userInputs?.prompt
    || job.userInputs?.description
    || job.promptPipeline?.rawUserIntent
    || '';

  const intent = intentEngine.deterministicClassify(
    rawInput,
    job.userInputs?.locale || 'gulf',
    {
      brandName:      job.userInputs?.brandName,
      targetAudience: job.userInputs?.targetAudience,
    }
  );

  // Override domain if the job already stored one (from a prior classification)
  if (job.promptPipeline?.domain) {
    intent.domain = job.promptPipeline.domain;
  } else if (job.category && intentEngine.DOMAIN_DNA[job.category]) {
    intent.domain = job.category;
  }

  const dna = intentEngine.DOMAIN_DNA[intent.domain] || intentEngine.DOMAIN_DNA.default;
  const context = {
    dna,
    seasonal: null,
    gulfMod: intent.gulf_relevant ? dna.gulfMod : null,
    brandKit: null,
    urlData: null,
  };

  return intentEngine.synthesizePrompt({
    intent,
    context,
    inputs: {
      prompt:         rawInput,
      brandName:      job.userInputs?.brandName,
      description:    job.userInputs?.description,
      targetAudience: job.userInputs?.targetAudience,
      vibe:           job.userInputs?.vibe,
      locale:         job.userInputs?.locale,
      audio:          job.userInputs?.audio,
    },
    constraints: job.userInputs?.constraints,
  });
}


async function ensureRouting(job, finalPrompt, negativePrompt) {
  const hasRouting = job.falModelId && job.modelId;

  const hasProviderInput = !!job.userInputs?._providerInput;

  if (hasRouting && hasProviderInput) {
    return {
      falModelId: job.falModelId,
      providerInput: job.userInputs._providerInput,
      modelId: job.modelId,
    };
  }

  // Re-route (retry of an old job, or controller didn't persist the envelope)
  let template = null;
  if (job.templateId) {
    template = await GenerationTemplate.findById(job.templateId).lean().catch(() => null);
  }

  const refImage = job.userInputs?.referenceImageUrl
    || job.userInputs?.extras?.referenceImageUrl;

  const routed = await modelRouter.route({
    template,
    requestedModelId: job.modelId,
    kind: job.kind,
    prompts: { finalPrompt, negativePrompt },
    aspectRatio: job.userInputs?.aspectRatio,
    durationSec: job.userInputs?.duration||job.userInputs?.durationSec,
    variants: job.variantsRequested || 1,
    referenceImageUrl: refImage,
    endFrameUrl: job.userInputs?.endFrameUrl || job.userInputs?.extras?.endFrameUrl,
    resolution: job.userInputs?.resolution || job.userInputs?.extras?.resolution,
    motion: job.userInputs?.motion || job.userInputs?.extras?.motion,
    constraints: job.userInputs?.constraints || null,
    audio: job.userInputs?.audio,
    extras: job.userInputs?.extras || {},   // ← ADD THIS LINE
  });

  let falModelId = routed.falModelId;
  let providerInput = routed.input;

  // FIX #6 — img2img sibling swap
  if (job.kind === 'image' && refImage && IMG2IMG_SIBLINGS[falModelId]) {
    const sibling = IMG2IMG_SIBLINGS[falModelId];
    dlog('img2img swap:', falModelId, '→', sibling);
    falModelId = sibling;
    providerInput = {
      ...providerInput,
      image_url: refImage,
      image_size: providerInput.image_size || ASPECT_TO_FAL_IMAGE_SIZE[job.userInputs?.aspectRatio] || 'square_hd',
    };
  }

  // Persist so retries don't re-route
  job.falModelId = falModelId;
  job.modelId = routed.modelId;
  if (!job.userInputs._providerInput) {
    job.userInputs._providerInput = providerInput;
  }
  await StudioJob.updateOne(
    { _id: job._id },
    {
      $set: {
        falModelId,
        modelId: routed.modelId,
        'userInputs._providerInput': job.userInputs._providerInput,
        updatedAt: new Date(),
      },
    },
  ).catch(() => {});

  return { falModelId, providerInput, modelId: routed.modelId };
}



async function processImageJob(bullJob) {
  const { jobId } = bullJob.data;
  const start = Date.now();
 
  const job = await StudioJob.findById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  job.startedAt = new Date();
  job.addStage('pipeline_start', { bullJobId: bullJob.id, kind: 'image' });
  await flushJobPatch(job, { startedAt: job.startedAt, stages: job.stages });
  try {
    await updateStatus(job, 'prompt_building', 10, 'Preparing prompt…');
 
    // Prompt: trust controller, otherwise rebuild deterministically
    let finalPrompt   = job.promptPipeline?.finalPrompt;
    let negativePrompt = job.promptPipeline?.negativePrompt;
    if (!finalPrompt || finalPrompt.length < 5) {
      const rebuilt = rebuildPromptFromJob(job);
      finalPrompt    = rebuilt.finalPrompt;
      negativePrompt = rebuilt.negativePrompt;
      job.promptPipeline.finalPrompt    = finalPrompt;
      job.promptPipeline.negativePrompt = negativePrompt;
      job.promptPipeline.domain         = rebuilt.promptMetadata?.domain;
      await StudioJob.updateOne(
        { _id: job._id },
        {
          $set: {
            'promptPipeline.finalPrompt':    finalPrompt,
            'promptPipeline.negativePrompt': negativePrompt,
            'promptPipeline.domain':         rebuilt.promptMetadata?.domain,
            updatedAt: new Date(),
          },
        },
      );
    }
 
    job.completeStage('pipeline_start');
    await updateStatus(job, 'generating', 25, 'Generating with AI…');
    job.addStage('generating');
    // ensureRouting returns the stored _providerInput that the controller
    // built and persisted. It already has image_urls, quality, image_size,
    // output_format, etc. — exactly what fal expects.
    const { falModelId, providerInput } = await ensureRouting(job, finalPrompt, negativePrompt);
    dlog('image job falModelId:', falModelId, '| providerInput keys:', Object.keys(providerInput || {}));
 

    

    const variants = Math.max(1, Math.min(4, job.variantsRequested || 1));
 
    // ── THE FIX ────────────────────────────────────────────────────────────
    // Call falService.generateImage with the STORED providerInput directly.
    // Do NOT call providerRouter.generate — that rebuilds the payload from
    // bare args (prompt, aspectRatio, referenceImageUrl) and loses image_urls.
    // ──────────────────────────────────────────────────────────────────────
    const callFalImage = () => falService.generateImage({
      falModelId,
      input: providerInput,
      modelId: job.modelId,
    });
    const rawResults = variants === 1
      ? [await callFalImage()]
      : await Promise.all(Array.from({ length: variants }, callFalImage));
    // Normalize return shape:
    //   falService.generateImage → { imageUrl, estimatedCost, requestId, modelId }
    //   (old providerRouter.generate returned { imageUrl, estimatedCostUsd })
    const results = rawResults.map(r => ({
      imageUrl:         r.imageUrl,
      estimatedCostUsd: r.estimatedCost ?? r.estimatedCostUsd ?? 0.01,
      requestId:        r.requestId || null,
    }));
    job.output.rawImageUrl = results[0].imageUrl;
    job.falCostUsd = results.reduce((s, r) => s + r.estimatedCostUsd, 0);
    job.completeStage('generating');
    await StudioJob.updateOne(
      { _id: job._id },
      {
        $set: {
          'output.rawImageUrl': job.output.rawImageUrl,
          falCostUsd: job.falCostUsd,
          stages: job.stages,
          updatedAt: new Date(),
        },
      },
    );
    await updateStatus(job, 'postprocessing', 80, 'Storing your asset…');
    job.addStage('postprocessing');
    // Process + store each variant
    const processed = await Promise.all(results.map((r, i) =>
      processingService.processImage({
        imageUrl:      r.imageUrl,
        jobId:         `${job._id.toString()}_v${i}`,
        category:      job.category,
        brandName:     job.userInputs.brandName,
        isWatermarked: job.isWatermarked,
        aspectRatio:   job.userInputs.aspectRatio,
      })
    ));
    // Persist variants
    job.output.variants = [];
    for (let i = 0; i < processed.length; i++) {
      const p = processed[i];
      job.output.variants.push({
        index: i,
        rawUrl:    results[i].imageUrl,
        storedUrl: p.storedUrl,
        ...(job.isWatermarked ? { watermarkedUrl: p.storedUrl } : { cleanUrl: p.storedUrl }),
      });
    }
    // Primary (index 0) → top-level output fields for backward compat
    job.output.storedImageUrl = processed[0].storedUrl;
    if (job.isWatermarked) job.output.watermarkedUrl = processed[0].storedUrl;
    else job.output.cleanUrl = processed[0].storedUrl;
    job.completeStage('postprocessing');
    job.totalPipelineTimeMs = Date.now() - start;
    job.completedAt = new Date();
    await flushJobPatch(job, {
      'output.variants':       job.output.variants,
      'output.storedImageUrl': job.output.storedImageUrl,
      'output.watermarkedUrl': job.output.watermarkedUrl,
      'output.cleanUrl':       job.output.cleanUrl,
      stages:                  job.stages,
      totalPipelineTimeMs:     job.totalPipelineTimeMs,
      completedAt:             job.completedAt,
    });
    const finalUrl  = job.isWatermarked ? job.output.watermarkedUrl : job.output.cleanUrl;
    const tierType  = job.tier === 'pro' || job.tier === 'agency' ? 'image_lifestyle' : 'image_hd';
    const asset = await persistAsset(job, {
      type:         tierType,
      url:          finalUrl,
      thumbnailUrl: job.output.storedImageUrl,
      mimeType:     'image/jpeg',
      variantIndex: 0,
    });
    for (let i = 1; i < processed.length; i++) {
      await persistAsset(job, {
        type:         tierType,
        url:          processed[i].storedUrl,
        thumbnailUrl: processed[i].storedUrl,
        mimeType:     'image/jpeg',
        variantIndex: i,
      });
    }
 
    await updateStatus(job, 'completed', 100, 'Your image is ready!');
 
    await emitJobUpdate(job.sessionId, {
      jobId:          job._id.toString(),
      status:         'completed',
      progress:       100,
      statusMessage:  'Your image is ready!',
      assetId:        asset?._id?.toString() || null,
      isWatermarked:  !!job.isWatermarked,
      output: {
        imageUrl:     finalUrl,
        hdUrl:        finalUrl,
        thumbnailUrl: job.output.storedImageUrl,
        variantUrls:  job.output.variants.map(v => v.storedUrl),
      },
    });
 
    await updateDailyStats(job.category, job.totalPipelineTimeMs, job.falCostUsd, 'completed');
 
    try {
      const { syncStudioJobToUrlToAdsScan } = require('../services/urlToAdsService');
      const finished = await StudioJob.findById(jobId).lean();
      await syncStudioJobToUrlToAdsScan(finished);
    } catch (_e) { /* non-fatal */ }
 
  } catch (err) {
    console.error(`[videoWorker] IMAGE ${jobId} failed:`, err.message);
    job.error = { message: err.message, code: err.code || 'PIPELINE_ERROR', stack: err.stack };
 
    const fatalCodes    = new Set(['FAL_AUTH_MISSING', 'FAL_AUTH_REJECTED']);
    const isFatal       = fatalCodes.has(err.code);
    const isFinalAttempt = isFatal || bullJob.attemptsMade + 1 >= (bullJob.opts?.attempts || 1);
 
    await flushJobPatch(job, { error: job.error, stages: job.stages });
 
    if (isFinalAttempt) {
      const userMsg = fatalCodes.has(err.code)
        ? err.message
        : 'Image generation failed. Please try again.';
      await updateStatus(job, 'failed', 0, userMsg);
      await emitJobUpdate(job.sessionId, {
        jobId: job._id.toString(), status: 'failed', progress: 0,
        statusMessage: userMsg, error: { message: err.message, code: err.code },
      });
      await updateDailyStats(job.category, 0, 0, 'failed');
      await creditsService.refundForJob(job).catch(e => console.warn('refund failed:', e.message));
 
      try {
        const { syncStudioJobToUrlToAdsScan } = require('../services/urlToAdsService');
        const finished = await StudioJob.findById(jobId).lean();
        await syncStudioJobToUrlToAdsScan(finished);
      } catch (_e) { /* non-fatal */ }
    }
    throw err;
  }
}

// ── Video pipeline (condensed — same intent engine fallback) ──────────────
async function processVideoJob(bullJob) {
  const { jobId } = bullJob.data;
  const start = Date.now();
const job = await StudioJob.findById(jobId);
if (!job) throw new Error(`Job ${jobId} not found`);

job.startedAt = new Date();
job.addStage('pipeline_start', { bullJobId: bullJob.id, kind: 'video' });
await flushJobPatch(job, { startedAt: job.startedAt, stages: job.stages });

try {
  await updateStatus(job, 'prompt_building', 10, 'Preparing prompt…');
  
  let finalPrompt = job.promptPipeline?.finalPrompt;
  let negativePrompt = job.promptPipeline?.negativePrompt;
  if (!finalPrompt || finalPrompt.length < 5) {
    const rebuilt = rebuildPromptFromJob(job);
    finalPrompt = rebuilt.finalPrompt;
    negativePrompt = rebuilt.negativePrompt;
    job.promptPipeline.finalPrompt = finalPrompt;
    job.promptPipeline.negativePrompt = negativePrompt;
    await StudioJob.updateOne(
      { _id: job._id },
      {
        $set: {
          'promptPipeline.finalPrompt': finalPrompt,
          'promptPipeline.negativePrompt': negativePrompt,
          updatedAt: new Date(),
        },
      },
    );
  }
  job.completeStage('pipeline_start');
  
  await updateStatus(job, 'generating', 20, 'Generating video…');
  job.addStage('generating');
  
  const { falModelId,providerInput } = await ensureRouting(job, finalPrompt, negativePrompt);
  dlog('video falModelId:', falModelId, '| providerInput keys:', Object.keys(providerInput || {}));

  const refImage   = job.userInputs?.referenceImageUrl || job.userInputs?.extras?.referenceImageUrl||job.userInputs?.assetRefs?.[0]?.url;
  const endFrame   = job.userInputs?.endFrameUrl || job.userInputs?.extras?.endFrameUrl;
  
  // Elements can arrive in 3 places depending on frontend version — coalesce.
  const rawElements =
    (Array.isArray(providerInput?.elements) && providerInput.elements.some(e => e && Object.keys(e).length)) ? providerInput.elements
    : (Array.isArray(job.userInputs?.extras?.elements) && job.userInputs.extras.elements.some(e => e && Object.keys(e).length)) ? job.userInputs.extras.elements
    : (Array.isArray(job.userInputs?.elements) && job.userInputs.elements.some(e => e && Object.keys(e).length)) ? job.userInputs.elements
    : [];
  
  // Drop empty {} elements that produce null in the sanitizer
  const elements = rawElements.filter(e => e && (e.frontal_image_url || (Array.isArray(e.reference_image_urls) && e.reference_image_urls.length) || e.video_url));
  
  const refImages =
    (Array.isArray(providerInput?.image_urls) && providerInput.image_urls.length) ? providerInput.image_urls
    : (Array.isArray(job.userInputs?.extras?.image_urls) && job.userInputs.extras.image_urls.length) ? job.userInputs.extras.image_urls
    : [];
  
  const startFrame = providerInput?.start_image_url || refImage || job.userInputs?.startFrame;
  
  const isKlingO3Ref2V = /kling-video\/o3\/.*\/reference-to-video/.test(falModelId);
  
  const lockedRefs =
  (Array.isArray(job.userInputs?.referenceImageUrls) && job.userInputs.referenceImageUrls.length) ? job.userInputs.referenceImageUrls
  : (Array.isArray(job.userInputs?.extras?.referenceImageUrls) && job.userInputs.extras.referenceImageUrls.length) ? job.userInputs.extras.referenceImageUrls
  : (Array.isArray(providerInput?.reference_image_urls) && providerInput.reference_image_urls.length) ? providerInput.reference_image_urls
  : (Array.isArray(providerInput?.image_urls) && providerInput.image_urls.length) ? providerInput.image_urls
  : [];

const isWanRef2V = /wan\/v2\.7\/(reference|image)-to-video/.test(falModelId);
const isSeedance2Ref2V = /seedance-2\.0\/(fast\/)?reference-to-video/.test(falModelId);


  let videoRawInput;
  if (isKlingO3Ref2V) {
    videoRawInput = {
      prompt: finalPrompt,
      ...(startFrame ? { start_image_url: startFrame } : {}),
      ...(endFrame   ? { end_image_url: endFrame }     : {}),
      ...(elements.length ? { elements } : {}),
      ...(refImages.length ? { image_urls: refImages } : {}),
      aspect_ratio: job.userInputs.aspectRatio || '9:16',
      duration: String(job.userInputs.duration||job.userInputs.durationSec),
      generate_audio: !!job.userInputs?.audio?.enabled,
      ...(providerInput?.seed != null ? { seed: providerInput.seed } : {}),
    };
  } else if (isWanRef2V) {
    videoRawInput = {
      prompt: finalPrompt,
      ...(lockedRefs.length ? { reference_image_urls: lockedRefs } : {}),
      aspect_ratio: job.userInputs.aspectRatio || '9:16',
      duration: job.userInputs.duration || job.userInputs.durationSec,
      resolution: job.userInputs.resolution || '720p',
      ...(providerInput?.seed != null ? { seed: providerInput.seed } : {}),
    };
  
  } else if (isSeedance2Ref2V) {
    videoRawInput = {
      prompt: finalPrompt,
      ...(lockedRefs.length ? { image_urls: lockedRefs } : {}),  // Seedance reads image_urls
      aspect_ratio: job.userInputs.aspectRatio || '9:16',
      duration: String(job.userInputs.duration || job.userInputs.durationSec),
      resolution: job.userInputs.resolution || '720p',
      generate_audio: !!job.userInputs?.audio?.enabled,
      ...(providerInput?.seed != null ? { seed: providerInput.seed } : {}),
    };
  } else {
    videoRawInput = { ...providerInput, prompt: finalPrompt };
  }
  
  dlog('ref2v assembled payload:', JSON.stringify(videoRawInput));

  console.log(videoRawInput,"we go here now ",providerInput,"before generate video");
  const genThrottle = makeProgressThrottle({ minIntervalMs: 500, minDelta: 2 });
  const falResult = await falService.generateVideo({
    prompt: finalPrompt,
    negativePrompt,
    input: videoRawInput,
    aspectRatio: job.userInputs.aspectRatio,
    duration: job.userInputs.duration||job.userInputs.durationSec,
    tier: job.tier,
    falModelId,
    referenceImageUrl: refImage,
    endFrameUrl: endFrame,
    resolution: job.userInputs?.resolution,
    motion: job.userInputs?.motion,
    onProgress: (p) => genThrottle(p, (next) =>
      updateStatus(job, 'generating', 20 + Math.floor(next * 0.5), `Generating… ${next}%`)),
  });

  console.log('falResult', falResult,"we go here now ");
  
  job.falJobId = falResult.requestId;
    job.falResponse = falResult;
    job.output = job.output || {};
    job.output.rawVideoUrl = falResult.videoUrl;
    job.generationTimeMs = falResult.generationTimeMs;
    job.falCostUsd = falResult.estimatedCost;
    job.completeStage('generating');
    
    await flushJobPatch(job, {
      falJobId: job.falJobId,
      falResponse: job.falResponse,
      'output.rawVideoUrl': job.output.rawVideoUrl,
      generationTimeMs: job.generationTimeMs,
      falCostUsd: job.falCostUsd,
      stages: job.stages,
    });

    let videoForProcessing = falResult.videoUrl;




    await updateStatus(job, 'postprocessing', 82, 'Finalizing…');
    const procThrottle = makeProgressThrottle({ minIntervalMs: 500, minDelta: 2 });
    const proc = await processingService.processVideo({
      videoUrl: videoForProcessing,
      jobId: job._id.toString(),
      category: job.category,
      brandName: job.userInputs.brandName,
      isWatermarked: job.isWatermarked,
      aspectRatio: job.userInputs.aspectRatio,
      onProgress: (p) => procThrottle(p, (next) =>
        updateStatus(job, 'postprocessing', 82 + Math.floor(next * 0.1), `Processing… ${next}%`)),
    });

    job.output.storedVideoUrl = proc.storedUrl;
    if (job.isWatermarked) job.output.watermarkedUrl = proc.storedUrl;
    else job.output.cleanUrl = proc.storedUrl;

    // ── TTS voiceover: if this shot has a VO line, generate speech and mix ──
    const userCopy = job.userInputs?.userCopy?.trim();
    if (userCopy) {
      try {
        await updateStatus(job, 'postprocessing', 93, 'Adding voiceover…');
        const voiceId = job.userInputs?.audio?.voiceId || 'rachel';
        const ttsUrl = await generateTtsAudio({ text: userCopy });
        if (ttsUrl) {
          const mixedUrl = await processingService.mixVoiceoverWithVideo({
            videoUrl: proc.storedUrl,
            audioUrl: ttsUrl,
            jobId: job._id.toString(),
          });
          job.output.storedVideoUrl = mixedUrl;
          if (job.isWatermarked) job.output.watermarkedUrl = mixedUrl;
          else job.output.cleanUrl = mixedUrl;
          dlog(`TTS voiceover mixed for job ${job._id}`);
        }
      } catch (ttsErr) {
        console.warn(`[videoWorker] TTS voiceover failed for job ${job._id} (non-fatal):`, ttsErr.message);
      }
    }

    const ffmpegAvailable = await processingService.checkFFmpeg();
    if (ffmpegAvailable) {
      const thumbUrl = await processingService.extractThumbnail(proc.storedUrl, job._id.toString());
      if (thumbUrl) job.output.thumbnailUrl = thumbUrl;
    }

    job.totalPipelineTimeMs = Date.now() - start;
    job.completedAt = new Date();

    await flushJobPatch(job, {
      'output.storedVideoUrl': job.output.storedVideoUrl,
      'output.watermarkedUrl': job.output.watermarkedUrl,
      'output.cleanUrl': job.output.cleanUrl,
      'output.thumbnailUrl': job.output.thumbnailUrl,
      stages: job.stages,
      totalPipelineTimeMs: job.totalPipelineTimeMs,
      completedAt: job.completedAt,
    });

    const finalUrl = job.isWatermarked ? job.output.watermarkedUrl : job.output.cleanUrl;
    const asset = await persistAsset(job, {
      type: 'video', url: finalUrl, thumbnailUrl: job.output.thumbnailUrl, mimeType: 'video/mp4',
    });

    await updateStatus(job, 'completed', 100, 'Your video is ready!');

    await emitJobUpdate(job.sessionId, {
      jobId: job._id.toString(),
      status: 'completed', progress: 100, statusMessage: 'Your video is ready!',
      assetId: asset?._id?.toString() || null,
      isWatermarked: !!job.isWatermarked,
      output: { videoUrl: finalUrl, thumbnailUrl: job.output.thumbnailUrl, duration: job.userInputs.duration||job.userInputs.durationSec },
    });



    await updateDailyStats(job.category, job.totalPipelineTimeMs, job.falCostUsd, 'completed');
    console.log('job', job,"after update daily stats we sysncing ");
    try {
      const finished = await StudioJob.findById(jobId).lean();
      const { onStudioJobCompleted } = require('../services/urlToAdsService');
      await onStudioJobCompleted(finished);
      console.log('job', job,"after onStudioJobCompleted we sysncing ");
    } catch (_e) { 
      console.error(`[videoWorker] Process VIDEO ${jobId} failed:`, _e.message);
    }


  } catch (err) {
    console.error(`[videoWorker] VIDEO ${jobId} failed:`, err.message);
    job.error = { message: err.message, code: err.code || 'PIPELINE_ERROR', stack: err.stack };

    const fatalCodes = new Set(['FAL_AUTH_MISSING', 'FAL_AUTH_REJECTED']);
    const isFatal = fatalCodes.has(err.code);
    const isFinalAttempt = isFatal || bullJob.attemptsMade + 1 >= (bullJob.opts?.attempts || 1);

    await flushJobPatch(job, { error: job.error, stages: job.stages });

    if (isFinalAttempt) {
      const userMsg = fatalCodes.has(err.code) ? err.message : 'Video generation failed. Please try again.';
      await updateStatus(job, 'failed', 0, userMsg);
      await emitJobUpdate(job.sessionId, {
        jobId: job._id.toString(), status: 'failed', progress: 0,
        statusMessage: userMsg, error: { message: err.message, code: err.code },
      });
      await updateDailyStats(job.category, 0, 0, 'failed');
      await creditsService.refundForJob(job).catch(e => console.warn('refund failed:', e.message));
    }
    throw err;
  }
}

// ── Worker boot ───────────────────────────────────────────────────────────
async function startWorker() {
  await connectDB();

  const dispatch = async (bullJob) => {
    if (bullJob.name === 'generate-image') return processImageJob(bullJob);
    return processVideoJob(bullJob);
  };

  const worker = new Worker(QUEUE_NAMES.STUDIO, dispatch, {
    connection: getRedis(),
    concurrency: 3,
    limiter: { max: 10, duration: 30000 },
  });

  worker.on('completed', (bullJob) => dlog(`BullMQ job ${bullJob.id} completed`));
  worker.on('failed', (bullJob, err) => console.error(`[videoWorker] BullMQ job ${bullJob?.id} failed:`, err.message));
  worker.on('error', (err) => console.error('[videoWorker] Worker error:', err.message));



  // ── 2. Video-stitch worker (THE MISSING CONSUMER) ──
  // Runs assembleVideoAd when all shots are ready (enqueued by the sync hook).
  const stitchWorker = new Worker(
    QUEUE_NAMES.VIDEO_STITCH,                       // 'video-stitch'
    async (bullJob) => {
      const { scanId, adJobId } = bullJob.data;
      console.log('[stitch] running assembleVideoAd', { scanId, adJobId });
      const r = await assembleVideoAd(scanId, adJobId);
      console.log('[stitch] done →', r?.assetUrl);
      return r;
    },
    { connection: getRedis(), concurrency: 2 },     // ffmpeg is CPU-heavy
  );
 
  stitchWorker.on('completed', (bullJob) => console.log(`[stitch] job ${bullJob.id} completed`));
  stitchWorker.on('failed', (bullJob, err) => console.error(`[stitch] job ${bullJob?.id} FAILED:`, err.message));
  stitchWorker.on('error', (err) => console.error('[stitch] worker error:', err.message));
 
  console.log('[videoWorker] both workers started (studio + video-stitch)');
 


  process.on('SIGTERM', async () => {
    await worker.close();
    await stitchWorker.close(); 
    await mongoose.disconnect();
    process.exit(0);
  });
}

let _bootPromise = null;
function boot() {
  if (_bootPromise) return _bootPromise;
  _bootPromise = startWorker().catch((err) => {
    console.error('[videoWorker] Failed to start:', err.message);
    if (require.main === module) process.exit(1);
    throw err;
  });
  return _bootPromise;
}

boot();
module.exports = { boot };
