'use strict';

const { Queue } = require('bullmq');
const StudioJob = require('../../model/schema/studioJob');
const StudioAsset = require('../../model/schema/studioAsset');
const Lead = require('../../model/schema/lead');
const AdBrainFeedback = require('../../model/schema/adBrainFeedback');
const StudioUser = require('../../model/schema/studioUser');
const copyService = require('../../services/copyService');
const promptRefiner = require('../../services/promptRefiner');
const shareService = require('../../services/shareService');
const { getUtmData } = require('../../middleware/utmCapture');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');
const { listOwnershipFilter } = require('./studioOwnership');

// ─── Queue (reuse existing video-generation queue) ─────────────────────────

let _queue = null;
function getQueue() {
  if (!_queue) {
    _queue = new Queue('video-generation', {
      connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 }
      }
    });
  }
  return _queue;
}

// ─── Tier limits ───────────────────────────────────────────────────────────

const TIER_LIMITS = {
  free:    { imageHd: 2,   video: 2 },
  starter: { imageHd: 20,  video: 5 },
  pro:     { imageHd: 100, video: 20 },
  agency:  { imageHd: -1,  video: -1 }
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

function checkAssetOwnership(asset, req) {
  if (!asset) return false;
  // Admins can always touch any asset (QA / support).
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') return true;
  const sessionId = getSessionId(req);
  const ownedBySession = sessionId && asset.sessionId === sessionId;
  const ownedByUser = req.user?._id && asset.userId && asset.userId.toString() === req.user._id.toString();
  // If the asset isn't owned by anyone yet (legacy or anonymous orphan)
  // and we have *any* identity at all, allow access. Better than locking
  // a user out of their own creation because an old job had no userId.
  const orphan = !asset.userId && !asset.sessionId;
  const hasIdentity = !!(req.user?._id || sessionId);
  return ownedBySession || ownedByUser || (orphan && hasIdentity);
}

function getMonthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Best URL to use as img2img reference when refining a completed image job. */
function pickParentImageReferenceUrl(job) {
  const out = job.output || {};
  const wm = job.isWatermarked;
  if (wm) {
    return out.watermarkedUrl || out.storedImageUrl || out.rawImageUrl || out.cleanUrl || null;
  }
  return out.cleanUrl || out.storedImageUrl || out.rawImageUrl || out.watermarkedUrl || null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/studio/asset/:id/copy
 */
exports.generateCopy = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const { platform = 'instagram', adStructure, targetAudience } = req.body;

    const copy = await copyService.generateCopy({
      assetId: asset._id.toString(),
      jobId: asset.jobId?.toString(),
      category: asset.category,
      brandName: asset.brandName,
      platform,
      locale: req.body.locale || 'gulf',
      adStructure,
      targetAudience
    });

    // Increment asset copy gen count
    await StudioAsset.findByIdAndUpdate(asset._id, { $inc: { copyGenCount: 1 } });

    return res.json({ success: true, copy });
  } catch (err) {
    console.error('[extController] generateCopy error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to generate copy.' });
  }
};

/**
 * POST /api/v1/studio/job/:id/refine
 */
exports.refineGeneration = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });

    if (!checkAssetOwnership(job, req)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'not_completed', message: 'Can only refine completed jobs.' });
    }

    const { instruction } = req.body;
    if (!instruction || typeof instruction !== 'string' || instruction.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'instruction is required.' });
    }

    const originalPrompt = job.promptPipeline?.finalPrompt || '';
    const kind = job.kind === 'image' ? 'image' : 'video';

    const { refinedPrompt, changes } = await promptRefiner.refinePrompt({
      originalPrompt,
      instruction: instruction.trim(),
      category: job.category,
      locale: job.userInputs?.locale || 'gulf',
      mediaKind: kind
    });

    const baseUi = job.userInputs?.toObject ? job.userInputs.toObject() : { ...job.userInputs };
    // Force fresh routing in the worker from the new prompt — stale envelopes ignore finalPrompt.
    delete baseUi._providerInput;

    const parentRefImage = kind === 'image' ? pickParentImageReferenceUrl(job) : null;
    const mergedUserInputs = {
      ...baseUi,
      extras: {
        ...(baseUi.extras || {}),
        parentJobId: job._id.toString(),
        refinedFrom: instruction.trim()
      }
    };
    if (kind === 'image' && parentRefImage) {
      mergedUserInputs.referenceImageUrl = parentRefImage;
      
    }

    const newJob = await StudioJob.create({
      userId: job.userId,
      sessionId: job.sessionId,
      category: job.category,
      kind,
      modelId: job.modelId || null,
      falModelId: job.falModelId || null,
      variantsRequested: job.variantsRequested || 1,
      templateId: job.templateId || null,
      parentJobId: job._id,
      userInputs: mergedUserInputs,
      promptPipeline: {
        rawUserIntent: `Refined from job ${job._id}: ${instruction}`,
        finalPrompt: refinedPrompt,
        negativePrompt: job.promptPipeline?.negativePrompt || '',
        refinementNotes: changes,
        strategy: job.promptPipeline?.strategy || 'unknown',
        intentType: job.promptPipeline?.intentType ?? null,
        domain: job.promptPipeline?.domain ?? null
      },
      tier: job.tier,
      isWatermarked: job.isWatermarked,
      status: 'queued',
      statusMessage: 'Refined version queued.'
    });

    await getQueue().add('generate', { jobId: newJob._id.toString() }, { priority: 3 });

    return res.status(201).json({ success: true, newJobId: newJob._id.toString(), changes });
  } catch (err) {
    console.error('[extController] refineGeneration error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to refine generation.' });
  }
};

/**
 * POST /api/v1/studio/asset/:id/share
 */
exports.createShareLink = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const sessionId = getSessionId(req);
    const { code, publicUrl } = await shareService.createShareLink(
      asset._id.toString(), sessionId, req.user?._id || null
    );

    return res.json({ success: true, shareUrl: publicUrl, code });
  } catch (err) {
    console.error('[extController] createShareLink error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to create share link.' });
  }
};

/**
 * GET /api/v1/studio/share/:code  — PUBLIC
 */
exports.getSharePage = async (req, res) => {
  try {
    const data = await shareService.getShareData(req.params.code);
    if (!data) return res.status(404).json({ success: false, error: 'not_found', message: 'Share link not found or expired.' });
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[extController] getSharePage error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to load share page.' });
  }
};

/**
 * POST /api/v1/studio/share/:code/click  — PUBLIC
 */
exports.recordShareClick = async (req, res) => {
  try {
    await shareService.recordShareClick(req.params.code);
    return res.json({ success: true });
  } catch (err) {
    console.error('[extController] recordShareClick error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to record click.' });
  }
};

/**
 * POST /api/v1/studio/lead/capture  — PUBLIC
 */
exports.captureLead = async (req, res) => {
  try {
    const { email, source = 'post_generation', referralCode } = req.body;

    // Basic email validation
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Valid email is required.' });
    }

    const VALID_SOURCES = ['post_generation', 'exit_intent', 'share_page', 'waitlist'];
    const validatedSource = VALID_SOURCES.includes(source) ? source : 'post_generation';

    const normalizedEmail = email.toLowerCase().trim();
    const sessionId = getSessionId(req);

    // Deduplicate by email
    const existing = await Lead.findOne({ email: normalizedEmail });
    if (existing) return res.json({ success: true, exists: true, message: 'Already subscribed.' });

    // Get UTM data from Redis
    const utmData = await getUtmData(sessionId);

    // Find first asset for this session
    const firstAsset = sessionId
      ? await StudioAsset.findOne({ sessionId }).sort({ createdAt: 1 }).lean()
      : null;

    // Create lead
    await Lead.create({
      email: normalizedEmail,
      sessionId,
      userId: req.user?._id || null,
      source: validatedSource,
      category: firstAsset?.category || null,
      utmSource:   utmData?.utm_source   || null,
      utmMedium:   utmData?.utm_medium   || null,
      utmCampaign: utmData?.utm_campaign || null,
      referralCode: referralCode || utmData?.ref || null,
      firstAssetId: firstAsset?._id || null
    });

    // Referral bonus: find referring user, +5 credits
    if (referralCode || utmData?.ref) {
      const code = referralCode || utmData.ref;
      try {
        await StudioUser.findOneAndUpdate(
          { referralCode: code },
          { $inc: { creditsBonus: 5 } }
        );
      } catch (refErr) {
        console.warn('[extController] referral credit update failed (non-fatal):', refErr.message);
      }
    }

    // TODO: trigger SendGrid drip email sequence here
    console.log(`[extController] Lead captured: ${normalizedEmail} (source: ${source})`);

    return res.json({ success: true, message: 'Check your email for your saved creatives.' });
  } catch (err) {
    console.error('[extController] captureLead error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to capture lead.' });
  }
};

/**
 * PATCH /api/v1/studio/asset/:id/rate
 */
exports.rateAsset = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const { rating } = req.body;
    if (rating !== 1 && rating !== -1) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'rating must be 1 or -1.' });
    }

    const sessionId = getSessionId(req);

    // Upsert feedback
    const feedbackFilter = { assetId: asset._id };
    if (sessionId) feedbackFilter.sessionId = sessionId;
    else if (req.user?._id) feedbackFilter.userId = req.user._id;

    await AdBrainFeedback.findOneAndUpdate(
      feedbackFilter,
      {
        assetId: asset._id,
        sessionId,
        userId: req.user?._id || null,
        rating,
        category: asset.category,
        locale: '',
        vibe: ''
      },
      { upsert: true, new: true }
    );

    // Update asset rating
    asset.rating = rating;
    await asset.save();

    const suggestion = rating === -1
      ? { refineUrl: `/api/v1/studio/job/${asset.jobId}/refine`, message: 'Try refining with a different instruction.' }
      : null;

    return res.json({ success: true, suggestion });
  } catch (err) {
    console.error('[extController] rateAsset error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to rate asset.' });
  }
};

/**
 * POST /api/v1/studio/asset/:id/download
 *
 * Two flows:
 *   1) The owner (cookie session OR logged-in user) just gets the asset URL
 *      and we tick the download counter.
 *   2) An anonymous visitor (e.g. someone who landed via a /share/:code link)
 *      must hand us an email and/or phone in the body. We persist a Lead
 *      record, link it to the asset, and then return the watermarked URL.
 *
 * Either way the response shape stays { success, downloadUrl } so the
 * frontend doesn't need to branch on auth state.
 */
exports.trackDownload = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id);
    if (!asset) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    }

    const owns = checkAssetOwnership(asset, req);
    let leadCaptured = false;

    if (!owns) {
      const email = (req.body?.email || '').toString().trim().toLowerCase();
      const phone = (req.body?.phone || '').toString().trim();
      const hasEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const hasPhone = phone && phone.replace(/\D/g, '').length >= 7;

      if (!hasEmail && !hasPhone) {
        return res.status(401).json({
          success: false,
          error: 'lead_required',
          message: 'Drop your email or phone to download this creative — we’ll send a copy you can keep.',
          requiredFields: ['email', 'phone'],
        });
      }

      try {
        await Lead.findOneAndUpdate(
          hasEmail ? { email } : { phone },
          {
            $setOnInsert: {
              email: hasEmail ? email : undefined,
              phone: hasPhone ? phone : undefined,
              source: 'download_gate',
              category: asset.category || null,
              firstAssetId: asset._id,
              sessionId: getSessionId(req),
              userId: req.user?._id || null,
            },
            $set: { lastAssetId: asset._id, lastSeenAt: new Date() },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        leadCaptured = true;
      } catch (leadErr) {
        // Never block a download because lead capture failed — just log it.
        console.warn('[extController] lead-gate persistence failed:', leadErr.message);
      }
    }

    asset.downloadCount = (asset.downloadCount || 0) + 1;
    asset.downloadedAt = new Date();
    await asset.save();

    // Anonymous downloads always come watermarked. Owners get whatever the
    // job decided (clean for paid tiers, watermarked for free).
    const downloadUrl = !owns
      ? (asset.watermarkedUrl || asset.url)
      : (asset.isWatermarked ? (asset.watermarkedUrl || asset.url) : (asset.cleanUrl || asset.url));

    return res.json({
      success: true,
      downloadUrl,
      gated: !owns,
      leadCaptured,
    });
  } catch (err) {
    console.error('[extController] trackDownload error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to track download.' });
  }
};

/**
 * GET /api/v1/studio/usage
 */
exports.getUsageStats = async (req, res) => {
  try {
    const base = listOwnershipFilter(req);
    const tier = req.user?.plan || 'free';
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;
    const monthStart = getMonthStart();
    const timeRange = { createdAt: { $gte: monthStart } };

    function monthlyScoped(extra) {
      const parts = [timeRange, extra];
      if (base && Object.keys(base).length > 0) parts.unshift(base);
      return parts.length === 1 ? parts[0] : { $and: parts };
    }

    const [videoCount, imageHdCount] = await Promise.all([
      StudioJob.countDocuments(
        monthlyScoped({ status: { $in: ['completed', 'generating', 'queued'] } }),
      ),
      StudioAsset.countDocuments(
        monthlyScoped({ type: { $in: ['image_hd', 'image_lifestyle'] } }),
      ),
    ]);

    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);
    resetDate.setDate(1);
    resetDate.setHours(0, 0, 0, 0);

    return res.json({
      success: true,
      tier,
      usage: { imageHd: imageHdCount, video: videoCount },
      limits,
      remaining: {
        imageHd: limits.imageHd === -1 ? -1 : Math.max(0, limits.imageHd - imageHdCount),
        video:   limits.video   === -1 ? -1 : Math.max(0, limits.video - videoCount)
      },
      resetDate
    });
  } catch (err) {
    console.error('[extController] getUsageStats error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch usage.' });
  }
};
