'use strict';

const { z } = require('zod');
const StudioJob = require('../../model/schema/studioJob');
const adBrain = require('../../services/adBrain');
const StudioAsset = require('../../model/schema/studioAsset');
const creditsService = require('../../services/creditsService');
const promptEnhancer = require('../../services/promptEnhancer');
const { enqueueGeneration } = require('./studioController_enqueue');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');
const { listOwnershipFilter } = require('./studioOwnership');
const Models = require('../../model/schema/aiModel');
const providerRouter = require('../../services/providerRouter');

// ─── Helpers ──────────────────────────────────────────────────────────────


exports.createImageGeneration = (req, res) => enqueueGeneration(req, res, 'image');
exports.createGeneration      = (req, res) => enqueueGeneration(req, res, 'video');
exports.createVideoGeneration = exports.createGeneration;


const TIER_PRIORITY = { agency: 1, pro: 2, starter: 5, free: 5 };
const CONTENT_BLOCKLIST = ['nude', 'naked', 'explicit', 'nsfw', 'weapon', 'violence', 'blood', 'drug'];

function checkContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONTENT_BLOCKLIST.some(word => lower.includes(word));
}

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return {
    userId: req.user?._id || null,
    sessionId: sessionId || null,
  };
}

function sanitizeJob(job) {
  const isImage = job.kind === 'image';
  const watermarked = job.output?.watermarkedUrl;
  const clean = job.output?.cleanUrl;
  const fallback = isImage ? job.output?.storedImageUrl : job.output?.storedVideoUrl;
  const mediaUrl = job.isWatermarked ? (watermarked || fallback) : (clean || fallback);

  return {
    id: job._id,
    category: job.category,
    kind: job.kind || 'video',
    assetId: job.assetId ? job.assetId.toString() : null,
    brandName: job.userInputs?.brandName,
    status: job.status,
    progress: job.progress,
    statusMessage: job.statusMessage,
    tier: job.tier,
    isWatermarked: job.isWatermarked,
    templateId: job.templateId || null,
    modelId: job.modelId || null,
    creditsCharged: job.creditsCharged || 0,
    creditsRefunded: job.creditsRefunded || 0,
    output: {
      videoUrl: isImage ? null : (mediaUrl || null),
      imageUrl: isImage ? (mediaUrl || null) : null,
      thumbnailUrl: job.output?.thumbnailUrl || null,
      duration: job.output?.duration || job.userInputs?.duration || null,
    },
    createdAt: job.createdAt,
    generationTimeMs: job.generationTimeMs,
  };
}

// ─── Input schema ─────────────────────────────────────────────────────────

const constraintsSchema = z.object({
  cameraAngle: z.string().optional(),
  lighting:    z.string().optional(),
  shotType:    z.string().optional(),
  motion:      z.string().optional(),
  pace:        z.string().optional(),
}).partial().optional();






/**
 * GET /api/v1/studio/job/:id
 */
exports.getJobStatus = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });
    }

    const sessionId = getSessionId(req);
    const ownedBySession = sessionId && job.sessionId === sessionId;
    const ownedByUser = req.user && req.user._id && job.userId && job.userId.toString() === req.user._id.toString();

    if (!ownedBySession && !ownedByUser) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });
    }

    return res.json({ success: true, job: sanitizeJob(job) });
  } catch (err) {
    console.error('[studioController] getJobStatus error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch job.' });
  }
};

/**
 * GET /api/v1/studio/jobs
 */
exports.getUserJobs = async (req, res) => {
  try {
    const filter = listOwnershipFilter(req);
    if (filter._id === null) {
      return res.json({ success: true, jobs: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      StudioJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StudioJob.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      jobs: jobs.map(j => sanitizeJob(j)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[studioController] getUserJobs error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch jobs.' });
  }
};

/**
 * GET /api/v1/studio/assets
 */
exports.getUserAssets = async (req, res) => {
  try {
    let baseFilter;

    if (req.query.userId) {
      baseFilter = { userId: req.query.userId };
    } else {
      baseFilter = listOwnershipFilter(req);
    }
    
    if (baseFilter._id === null) {
      return res.json({
        success: true,
        assets: [],
        pagination: { page: 1, limit: 20, total: 0, pages: 0 }
      });
    }
    
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    
    const queryFilter = {};
    
    if (req.query.type) queryFilter.type = req.query.type;
    if (req.query.status) queryFilter.status = req.query.status;
    
    let finalFilter;
    
    if (baseFilter.$or) {
      finalFilter = { $and: [baseFilter, queryFilter] };
    } else {
      finalFilter = { ...baseFilter, ...queryFilter };
    }
    
    // const [assets, total] = await Promise.all([
    //   StudioAsset.find(finalFilter)
    //     .sort({ createdAt: -1 })
    //     .skip(skip)
    //     .limit(limit)
    //     .lean(),
    //   StudioAsset.countDocuments(finalFilter),
    // ]);

    const assets = await StudioAsset.find(req.query.userId ? { userId: req.query.userId } : finalFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
    const total = await StudioAsset.countDocuments(finalFilter);

    res.json({
      success: true,
      assets,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[studioController] getUserAssets error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
};

/**
 * POST /api/v1/studio/track — analytics ingest
 */
exports.trackEvent = async (req, res) => {
  try {
    const { event, properties } = req.body || {};
    if (!event || typeof event !== 'string') {
      return res.status(400).json({ success: false, error: 'event_required' });
    }
    const sessionId = getSessionId(req);
    console.log('[studio.track]', JSON.stringify({
      event,
      userId: req.user?._id?.toString() || null,
      sessionId,
      ts: new Date().toISOString(),
      props: properties || {},
    }));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'server_error' });
  }
};

exports.getCategories = async (req, res) => {
  try {
    return res.json({ success: true, categories: adBrain.getAllCategories() });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch categories.' });
  }
};

exports.previewPrompt = async (req, res) => {
  try {
    const { category, brandName, description, vibe, locale, targetAudience } = req.body;
    if (!category || !brandName) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'category and brandName are required.' });
    }
    const { finalPrompt, negativePrompt, promptMetadata } = adBrain.buildAdPrompt({
      category, brandName, description, vibe, locale, targetAudience,
    });
    return res.json({
      success: true,
      preview: finalPrompt.substring(0, 600) + (finalPrompt.length > 600 ? '...' : ''),
      metadata: promptMetadata,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to preview prompt.' });
  }
};



exports.enhanceImage = async (req, res) => {
  try {
    const { images, modelId, prompt, aspectRatio, quality, mode } = req.body;

    // Validate
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'images must be a non-empty array.' });
    }
    if (images.length > 10) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Max 10 reference images.' });
    }
    if (!modelId) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'modelId is required.' });
    }

    const model = await Models.findOne({ id: modelId });
    if (!model) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Model not found.' });
    }

    const enhancedImage = await providerRouter.enhanceImage({
      images,
      model,
      prompt,         // optional — function has a sensible default
      aspectRatio,
      quality,
      mode: mode || 'standard',
      userId: req.user?.id || 'anon',  // ← wire your auth middleware
    });

    return res.json({ success: true, enhancedImage });
  } catch (err) {
    // ProviderError has structured fields — surface them properly
    if (err?.name === 'ProviderError') {
      const status = err.code === 'REF_URL_BLOCKED' || err.code?.endsWith('_SCHEMA') ? 400
                   : err.code?.endsWith('_RATE_LIMITED') ? 429
                   : err.code?.endsWith('_AUTH_MISSING') || err.code?.endsWith('_AUTH_REJECTED') ? 502
                   : 500;
      return res.status(status).json({
        success: false,
        error: err.code,
        provider: err.provider,
        message: err.message,
        retryable: err.isRetryable,
      });
    }
    console.error('[studioController] enhanceImage error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to enhance image.' });
  }
};
/**
 * POST /api/v1/studio/enhance-prompt
 *
 * Free, non-charging endpoint that lets the frontend show users what the
 * intelligence layer is going to do BEFORE they spend credits on a render.
 * Same enhancer that runs at generation time, so the preview matches the
 * actual output.
 */
exports.enhancePromptPreview = async (req, res) => {
  try {
    const {
      prompt,
      mode = 'normal',
      category,
      brandName,
      targetAudience,
      vibe,
      locale,
      kind = 'image',
    } = req.body || {};

    const raw = (prompt || '').trim();
    if (!raw) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'prompt is required.',
      });
    }

    const enhanced = await promptEnhancer.enhancePrompt({
      rawPrompt: raw,
      mode,
      category,
      brandName,
      targetAudience,
      vibe,
      locale,
      kind,
    });

    return res.json({
      success: true,
      original: raw,
      enhanced: enhanced.finalPrompt,
      negativePrompt: enhanced.negativePrompt,
      source: enhanced.source,
    });
  } catch (err) {
    console.error('[studioController] enhancePromptPreview error:', err);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Could not enhance prompt right now.',
    });
  }
};


exports.cancelJob = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });
    }
    const sessionId = getSessionId(req);
    const ownedBySession = sessionId && job.sessionId === sessionId;
    const ownedByUser = req.user && req.user._id && job.userId && job.userId.toString() === req.user._id.toString();
    if (!ownedBySession && !ownedByUser) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });
    }
    if (!['queued', 'prompt_building'].includes(job.status)) {
      return res.status(400).json({
        success: false,
        error: 'not_cancellable',
        message: `Cannot cancel a job with status "${job.status}".`,
      });
    }
    job.status = 'cancelled';
    await job.save();
    // Refund any credits we already deducted at enqueue time.
    await creditsService.refundForJob(job).catch(() => {});
    return res.json({ success: true, message: 'Job cancelled.' });
  } catch (err) {
    console.error('[studioController] cancelJob error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to cancel job.' });
  }
};





'use strict';

/**
 * routes/studio/cancelJob.js
 *
 * POST  /api/v1/studio/jobs/:id/cancel
 *
 * Cancels a queued or in-flight studio job:
 *   1. Permission check — owner or admin only
 *   2. Try to remove from BullMQ (only works pre-pickup)
 *   3. Refund credits atomically (idempotent — never refunds twice)
 *   4. Mark job status='cancelled' + notify via websocket
 *
 * Note on mid-generation cancels: once fal.ai has accepted the request, we
 * can't truly stop the provider. We mark the job cancelled, refund, and
 * the worker will discard the result when it lands (status check before save).
 */


// Lazy-load the queue so this module doesn't crash on Redis-down boot
let _queue;
function getQueue() {
  if (_queue !== undefined) return _queue;
  try {
    const queues = require('../../services/queues');
    _queue = queues.getStudioQueue ? queues.getStudioQueue() : queues.studioQueue || null;
  } catch (e) {
    console.warn('[cancelJob] queues module not available:', e.message);
    _queue = null;
  }
  return _queue;
}

exports.cancelJobAndRefund = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, error: 'invalid_job_id' });
    }

    const job = await StudioJob.findById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'job_not_found' });
    }

    // ── Permission check ──────────────────────────────────────────────
    const sessionId = getStudioSessionId(req);
    const isAdmin = (req.user?.role || '').toLowerCase() === 'admin';
    const isOwner = (
      isAdmin ||
      (job.userId && req.user?._id && job.userId.toString() === req.user._id.toString()) ||
      (!job.userId && job.sessionId === sessionId)
    );
    if (!isOwner) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    // ── Already terminal ──────────────────────────────────────────────
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({
        success: false,
        error: 'cannot_cancel',
        message: `Job already ${job.status}.`,
        status: job.status,
      });
    }

    // ── Step 1: Try to remove from BullMQ ────────────────────────────
    // Only works if the worker hasn't picked up the job yet. If the worker
    // is mid-generation, queue.getJob() will succeed but remove() will fail
    // with "Job ... is locked". We catch that — the worker handles cleanup.
    const wasPreFlight = ['queued', 'prompt_building'].includes(job.status);
    let removedFromQueue = false;
    try {
      const queue = getQueue();
      if (queue) {
        const bullJob = await queue.getJob(job._id.toString());
        if (bullJob) {
          await bullJob.remove();
          removedFromQueue = true;
        }
      }
    } catch (e) {
      // Locked job is normal mid-generation — not an error
      if (!String(e.message).includes('locked')) {
        console.warn('[cancelJob] queue remove non-fatal:', e.message);
      }
    }

    // ── Step 2: Refund credits (idempotent) ──────────────────────────
    let refunded = 0;
    if (job.creditsCharged > 0 && (!job.creditsRefunded || job.creditsRefunded === 0)) {
      try {
        const owner = { userId: job.userId, sessionId: job.sessionId };
        if (creditsService.refundForJob) {
          await creditsService.refundForJob({
            owner, job,
            amount: job.creditsCharged,
            reason: 'user_cancelled',
          });
        } else if (creditsService.refund) {
          await creditsService.refund(owner, job.creditsCharged, {
            jobId: job._id,
            reason: 'user_cancelled',
          });
        }
        refunded = job.creditsCharged;
        job.creditsRefunded = refunded;
      } catch (e) {
        console.warn('[cancelJob] refund failed:', e.message);
        // Continue — better to mark cancelled than crash. Admin can refund manually.
      }
    }

    // ── Step 3: Mark cancelled and persist ───────────────────────────
    job.status = 'cancelled';
    job.statusMessage = wasPreFlight
      ? 'Cancelled before generation started.'
      : 'Cancelled mid-generation. Provider may still complete, but no result will be saved.';
    job.completedAt = new Date();
    await job.save();

    // ── Step 4: Notify via websocket ─────────────────────────────────
    try {
      const io = req.app?.get?.('io');
      if (io && job.sessionId) {
        io.to(`studio:${job.sessionId}`).emit('studio:job:update', {
          jobId: job._id.toString(),
          status: 'cancelled',
          statusMessage: job.statusMessage,
          progress: 100,
          creditsRefunded: refunded,
        });
      }
    } catch (e) {
      console.warn('[cancelJob] socket notify skipped:', e.message);
    }

    return res.json({
      success: true,
      jobId: job._id.toString(),
      status: 'cancelled',
      creditsRefunded: refunded,
      removedFromQueue,
      wasPreFlight,
    });
  } catch (err) {
    console.error('[cancelJob] error:', err);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: err.message,
    });
  }
};

