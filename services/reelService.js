'use strict';

/**
 * reelService — Phase 4 Scene Builder (Storyboard).
 *
 * A "reel" is a director-assembled sequence of short video clips (scenes).
 * Each scene is rendered as its own StudioJob, then (optionally) stitched
 * into a single MP4 by a downstream worker. We model the reel as a single
 * `parent` StudioJob that carries reel-wide metadata plus N `child` jobs
 * (one per scene). The parent never hits the fal/OpenAI queue — it's a
 * lightweight container the UI uses to:
 *
 *   1. aggregate progress across children (`GET /studio/reel/:id`),
 *   2. hold the stitch plan (for the concat/crossfade worker step),
 *   3. give the user a single sharable asset once stitching completes.
 *
 * Why parent+children (and not a single mega-job):
 *   - Recovery: if scene 3 fails we can retry JUST that scene without
 *     re-rendering scenes 1/2/4/5.
 *   - Parallelism: fal runs 5 short clips in parallel much faster than
 *     one 25-second clip.
 *   - Cost transparency: each scene has its own ledger entry so the user
 *     sees exactly what burned their credits when a scene is refined.
 *
 * The shape of the reel lives in `parent.userInputs.extras.reelMeta`:
 *
 *   {
 *     totalScenes: 4,
 *     totalDurationSec: 14,
 *     continuity: true,          // auto-wire end-frame N → start-frame N+1
 *     sharedAspectRatio: '9:16',
 *     sharedModelId: 'seedance_2.0',
 *     stitchPlan: { strategy: 'concat' | 'crossfade', gap: 0 },
 *     scenes: [{ id, sceneIndex, durationSec, ... }],
 *   }
 *
 * This file exposes three entry points:
 *   - `planReel(inputs, owner)` — pricing + validation, no side-effects
 *   - `enqueueReel({ req, inputs })` — creates parent + children, charges, queues
 *   - `getReel(reelId, owner)` — returns parent + aggregated child statuses
 */

const { z }       = require('zod');
const { v4: uuidv4 } = require('uuid');

const StudioJob   = require('../model/schema/studioJob');
const intentEngine = require('./intentEngine');
const creditsService = require('./creditsService');
const modelRouter = require('./modelRouter');
const { enqueueStudioJob } = require('./queues');
const { assertSceneAssetsPublic } = require('../utils/assertPublicUrl');
const { getStudioSessionId } = require('../middelwares/studioIdentity');

// ─── Schemas ─────────────────────────────────────────────────────────────────

const constraintsSchema = z.object({
  cameraAngle: z.string().optional(),
  shotType:    z.string().optional(),
  lighting:    z.string().optional(),
  timeOfDay:   z.string().optional(),
  environment: z.string().optional(),
  motion:      z.string().optional(),
  pace:        z.string().optional(),
  mood:        z.string().optional(),
  tone:        z.string().optional(),
  styleTags:   z.array(z.string()).optional(),
}).partial();

const sceneSchema = z.object({
  id:             z.string().max(64).optional(),
  prompt:         z.string().trim().min(1, 'Each scene needs a prompt.').max(6000),
  durationSec:    z.coerce.number().int().min(1).max(10).default(3),
  modelId:        z.string().optional(),               // overrides reel-level model
  aspectRatio:    z.enum(['16:9','9:16','1:1','4:5','3:4','4:3']).optional(),
  firstFrameUrl:  z.string().url().optional(),
  lastFrameUrl:   z.string().url().optional(),
  constraints:    constraintsSchema.optional(),
  resolution:     z.enum(['480p','720p','1080p','4k']).optional(),
  negativePrompt: z.string().max(1500).optional(),
});

const audioSchema = z.object({
  enabled:    z.boolean().optional(),
  mode:       z.enum(['native', 'tts', 'upload']).optional(),
  script:     z.string().max(8000).optional(),
  voiceId:    z.string().max(120).optional(),
  language:   z.string().max(32).optional(),
  audioUrl:   z.string().url().optional(),
}).partial().optional();

const reelInputSchema = z.object({
  scenes:          z.array(sceneSchema).min(1, 'A reel needs at least one scene.').max(12, 'Reels cap at 12 scenes.'),
  modelId:         z.string().optional().default('seedance_2.0'),
  aspectRatio:     z.enum(['16:9','9:16','1:1','4:5','3:4','4:3']).optional().default('9:16'),
  category:        z.string().optional().default(''),
  brandName:       z.string().max(100).optional().default(''),
  targetAudience:  z.string().max(400).optional().default(''),
  locale:          z.enum(['gulf','global']).optional().default('gulf'),
  vibe:            z.string().max(80).optional().default(''),
  continuity:      z.boolean().optional().default(true),
  stitchStrategy:  z.enum(['concat','crossfade','none']).optional().default('concat'),
  constraints:     constraintsSchema.optional(),        // reel-wide director brief
  audio:           audioSchema,                         // reel-wide audio applied to every scene
  extras:          z.record(z.string(), z.unknown()).optional().default({}),
});

const TIER_PRIORITY = { agency: 1, pro: 2, starter: 5, free: 5 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return { userId: req.user?._id || null, sessionId: sessionId || null };
}

/**
 * Apply the reel-level defaults to each scene so every rendered clip has a
 * complete config. The caller passes validated inputs; this function never
 * throws on missing fields — it fills them in.
 *
 * Continuity rule (Seedance pattern):
 *   If `continuity=true` and scene N has NO firstFrameUrl, adopt scene N-1's
 *   lastFrameUrl. This creates visual handoffs without forcing the user to
 *   re-upload the same frame twice.
 */
function mergeSceneDefaults(reel) {
  const merged = [];
  for (let i = 0; i < reel.scenes.length; i++) {
    const s = reel.scenes[i];
    const scene = {
      id: s.id || `scn-${Date.now()}-${i}`,
      sceneIndex: i,
      sceneCount: reel.scenes.length,
      prompt: s.prompt,
      durationSec: s.durationSec || 3,
      modelId: s.modelId || reel.modelId,
      aspectRatio: s.aspectRatio || reel.aspectRatio,
      firstFrameUrl: s.firstFrameUrl || null,
      lastFrameUrl: s.lastFrameUrl || null,
      constraints: { ...(reel.constraints || {}), ...(s.constraints || {}) },
      resolution: s.resolution || null,
      negativePrompt: s.negativePrompt || null,
    };

    // Continuity pass — previous scene's end-frame becomes this scene's
    // start-frame unless the user already pinned one.
    if (reel.continuity && i > 0 && !scene.firstFrameUrl) {
      const prev = merged[i - 1];
      if (prev?.lastFrameUrl) {
        scene.firstFrameUrl = prev.lastFrameUrl;
        scene._inheritedStartFrame = true;
      }
    }
    merged.push(scene);
  }
  return merged;
}

/**
 * For a single merged scene, resolve the target model and estimate credits.
 * We DO NOT hit the network — we rely on modelRouter's model lookup + the
 * deterministic quote() math. If the scene is malformed (e.g. Kling i2v
 * without a reference) we surface a precise error keyed on `missing_required_field`.
 */
/**
 * promoteToImageToVideoIfFramesPresent — if the user selected a text-to-video
 * model but attached a first/last frame, silently swap to the matching
 * image-to-video sibling declared in seedAiModels.js (`i2vSibling`). Without
 * this, fal would either ignore the frames (silent miscommunication) or
 * reject a request shaped for i2v (422). Mutates the scene.modelId in place
 * and stamps the original choice onto scene._originalModelId so the UI can
 * show a "promoted X → Y" toast if it wants to.
 */
async function promoteToImageToVideoIfFramesPresent(scene) {
  const hasFrame = Boolean(scene.firstFrameUrl || scene.lastFrameUrl);
  if (!hasFrame) return null;

  const resolved = await modelRouter.resolveModel({
    requestedModelId: scene.modelId,
    template: null,
    kind: 'video',
  });

  // Already i2v? Nothing to promote.
  const alreadyI2V =
    resolved.videoVariant === 'i2v' ||
    /image-to-video|i2v/.test(String(resolved.falModelId || resolved.falVideoModelId || ''));
  if (alreadyI2V) return null;

  const siblingId = resolved.i2vSibling;
  if (!siblingId) return null;   // no declared i2v sibling — let validator raise.

  // Overwrite for downstream resolve + estimate.
  scene._originalModelId = scene.modelId || resolved.id;
  scene.modelId = siblingId;
  return { from: resolved.id, to: siblingId };
}

async function estimateScene(scene, reelAudio = null) {
  // Fail-fast BEFORE the provider call. If a frame URL is localhost /
  // private-network, fal.ai can't fetch it and we get an unhelpful 422
  // from the worker 30 s later. Throw a structured error the controller
  // translates to a 400 with a clear remediation message.
  assertSceneAssetsPublic(scene);

  // If the user picked a text-to-video model but gave us frames, auto-swap
  // to the declared i2v sibling so the frames are actually honored instead
  // of silently dropped by the provider.
  await promoteToImageToVideoIfFramesPresent(scene);

  const model = await modelRouter.resolveModel({
    requestedModelId: scene.modelId,
    template: null,
    kind: 'video',
  });

  // Cheap required-field guard. We re-use the router's declarative validator
  // so the reel estimate matches what the per-scene enqueue would do.
  modelRouter.validateRequiredFields(model, {
    referenceImageUrl: scene.firstFrameUrl,
    endFrameUrl:       scene.lastFrameUrl,
    prompt:            scene.prompt,
  });

  const cost = await creditsService.quote({
    modelId: model.id,
    kind: 'video',
    durationSec: scene.durationSec,
    variants: 1,
    audio: reelAudio,
  });

  return {
    sceneIndex: scene.sceneIndex,
    modelId: model.id,
    modelLabel: model.label,
    durationSec: scene.durationSec,
    creditsCost: cost,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * planReel — validates the reel, applies continuity, resolves models and
 * computes total cost without creating any jobs or charging anything.
 *
 * Returns:
 *   {
 *     valid: true,
 *     totalCreditsCost,
 *     totalDurationSec,
 *     scenes: [{ sceneIndex, modelId, durationSec, creditsCost }],
 *     resolvedScenes,   // merged scenes (including continuity frames)
 *   }
 *
 * Throws a Zod error for bad input and a tagged Error (.code) for each
 * model-level failure (`missing_required_field`, `requested_model_unavailable`).
 */
async function planReel(rawInputs) {
  const parsed = reelInputSchema.parse(rawInputs);
  const resolvedScenes = mergeSceneDefaults(parsed);
  const reelAudio =
    parsed.audio && parsed.audio.enabled ? parsed.audio : null;

  const perSceneEstimates = [];
  for (const scene of resolvedScenes) {
    // Don't wrap — let the caller see the exact scene that failed.
    try {
      const est = await estimateScene(scene, reelAudio);
      perSceneEstimates.push(est);
    } catch (err) {
      err.sceneIndex = scene.sceneIndex;
      err.sceneId = scene.id;
      throw err;
    }
  }

  const totalCreditsCost = perSceneEstimates.reduce((a, b) => a + b.creditsCost, 0);
  const totalDurationSec = resolvedScenes.reduce((a, s) => a + s.durationSec, 0);

  return {
    valid: true,
    totalCreditsCost,
    totalDurationSec,
    sceneCount: resolvedScenes.length,
    scenes: perSceneEstimates,
    resolvedScenes,
    reelMeta: {
      totalScenes: resolvedScenes.length,
      totalDurationSec,
      continuity: parsed.continuity,
      sharedAspectRatio: parsed.aspectRatio,
      sharedModelId: parsed.modelId,
      stitchPlan: {
        strategy: parsed.stitchStrategy,
        gap: parsed.stitchStrategy === 'crossfade' ? 0.4 : 0,
      },
    },
  };
}

/**
 * enqueueReel — atomic: plan, check balance, create parent, then create +
 * enqueue children. If any step fails we rollback in best-effort fashion
 * (delete parent, refund charged children).
 */
async function enqueueReel({ req, inputs }) {
  const plan = await planReel(inputs);

  const sessionId = getSessionId(req) || uuidv4();
  const isNewSession = !getSessionId(req);
  const owner   = ownerFromReq(req, sessionId);
  const isAdmin = (req.user?.role || '').toLowerCase() === 'admin';
  const tier    = isAdmin ? 'agency' : (req.user?.plan || 'free');

  // Balance check up front. We'd rather reject the whole reel than charge
  // 3 scenes and fail on the 4th.
  if (!isAdmin) {
    const balance = await creditsService.getBalance(owner);
    if (balance < plan.totalCreditsCost) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      err.required = plan.totalCreditsCost;
      err.balance  = balance;
      throw err;
    }
  }

  const parsed = reelInputSchema.parse(inputs);

  // Lightweight intent classification on the reel's overall brief. We
  // synthesize a brief from brand + first scene prompt so analytics can
  // cluster reels the same way they cluster individual clips.
  const firstScene = plan.resolvedScenes[0];
  let intentMeta = null;
  try {
    intentMeta = await intentEngine.classifyIntent({
      rawInput: [parsed.brandName, firstScene.prompt].filter(Boolean).join(' — '),
      locale:   parsed.locale,
      extras:   { brandName: parsed.brandName, isReel: true },
    });
  } catch (_e) { /* classification is non-fatal */ }

  // ── PARENT ────────────────────────────────────────────────────────────────
  const parent = await StudioJob.create({
    userId:    owner.userId,
    sessionId,
    category:  intentMeta?.domain || parsed.category || 'reel',
    kind:      'video',
    userInputs: {
      brandName:      parsed.brandName,
      description:    firstScene.prompt,
      prompt:         firstScene.prompt,
      targetAudience: parsed.targetAudience,
      vibe:           parsed.vibe,
      locale:         parsed.locale,
      aspectRatio:    parsed.aspectRatio,
      duration:       plan.totalDurationSec,
      sceneCount:     plan.sceneCount,
      constraints:    parsed.constraints || {},
      extras: {
        ...(parsed.extras || {}),
        reelMeta: plan.reelMeta,
        isReelParent: true,
      },
    },
    promptPipeline: {
      rawUserIntent: firstScene.prompt,
      finalPrompt:   firstScene.prompt,
      strategy:      'reel_parent',
      intentType:    intentMeta?.intent_type || 'reel',
      domain:        intentMeta?.domain || null,
      gulfRelevant:  intentMeta?.gulf_relevant ?? (parsed.locale === 'gulf'),
      confidence:    intentMeta?.confidence || 0.5,
    },
    tier,
    isWatermarked: !isAdmin && tier === 'free',
    status:       'queued',
    statusMessage: `Reel queued — ${plan.sceneCount} scenes · ${plan.totalDurationSec}s total.`,
    modelId:      parsed.modelId,
    variantsRequested: 1,
    creditsCharged: 0,   // charged via children; aggregated in getReel
  });

  // ── CHILDREN ──────────────────────────────────────────────────────────────
  // Create one StudioJob per scene. We DO NOT share a DB transaction across
  // the children because creditsService.chargeForJob already runs its own
  // atomic User.findOneAndUpdate. If a later child fails we refund the
  // already-charged ones.
  const children = [];
  try {
    for (const scene of plan.resolvedScenes) {
      const est = plan.scenes.find((x) => x.sceneIndex === scene.sceneIndex);

      // Route per-scene so we store the exact provider payload the worker
      // will call. This prevents model drift between "what the user saw
      // priced in the plan" and "what the worker ends up running".
      const routed = await modelRouter.route({
        template: null,
        requestedModelId: scene.modelId,
        kind: 'video',
        prompts: { finalPrompt: scene.prompt, negativePrompt: scene.negativePrompt },
        aspectRatio: scene.aspectRatio,
        durationSec: scene.durationSec,
        variants: 1,
        referenceImageUrl: scene.firstFrameUrl,
        endFrameUrl:       scene.lastFrameUrl,
        resolution:        scene.resolution,
        motion:            scene.constraints?.motion,
        audio:             parsed.audio,
      });

      const child = await StudioJob.create({
        userId:    owner.userId,
        sessionId,
        category:  parent.category,
        kind:      'video',
        userInputs: {
          brandName:    parsed.brandName,
          description:  scene.prompt,
          prompt:       scene.prompt,
          targetAudience: parsed.targetAudience,
          vibe:         parsed.vibe,
          locale:       parsed.locale,
          aspectRatio:  scene.aspectRatio,
          duration:     scene.durationSec,
          referenceImageUrl: scene.firstFrameUrl || null,
          endFrameUrl:       scene.lastFrameUrl  || null,
          resolution:   scene.resolution || null,
          motion:       scene.constraints?.motion || null,
          sceneIndex:   scene.sceneIndex,
          sceneCount:   plan.sceneCount,
          constraints:  scene.constraints || {},
          audio:        parsed.audio || null,
          extras: {
            parentJobId: parent._id.toString(),
            inheritedStartFrame: !!scene._inheritedStartFrame,
          },
          _providerInput: routed.input,
        },
        promptPipeline: {
          rawUserIntent: scene.prompt,
          finalPrompt:   scene.prompt,
          negativePrompt: scene.negativePrompt || '',
          strategy:      'reel_child',
          intentType:    parent.promptPipeline.intentType,
          domain:        parent.promptPipeline.domain,
          gulfRelevant:  parent.promptPipeline.gulfRelevant,
          confidence:    parent.promptPipeline.confidence,
        },
        tier,
        isWatermarked: parent.isWatermarked,
        status:       'queued',
        statusMessage: `Scene ${scene.sceneIndex + 1}/${plan.sceneCount} queued.`,
        modelId:      routed.modelId,
        falModelId:   routed.falModelId,
        variantsRequested: 1,
        parentJobId:  parent._id,
      });

      // Charge this child atomically. If it throws we break out and refund.
      if (!isAdmin && est?.creditsCost > 0) {
        await creditsService.chargeForJob({
          owner,
          job: child,
          cost: est.creditsCost,
          modelId: routed.modelId,
        });
      }

      await enqueueStudioJob({
        jobId: child._id.toString(),
        kind: 'video',
        priority: TIER_PRIORITY[tier] || 5,
      });

      children.push(child);
    }
  } catch (err) {
    // Rollback — try to refund any already-charged children and mark the
    // whole reel as failed. We don't block the response on refund failures.
    try {
      for (const c of children) {
        c.status = 'cancelled';
        c.statusMessage = 'Reel aborted before render.';
        await c.save().catch(() => {});
        if (c.creditsCharged > 0) {
          // Previously called the non-existent `refundJob`; the correct
          // export is `refundForJob` and it takes the job directly.
          await creditsService.refundForJob(c).catch(() => {});
        }
      }
      parent.status = 'failed';
      parent.statusMessage = err.message || 'Reel enqueue failed.';
      parent.error = { message: err.message, code: err.code || 'reel_enqueue_failed' };
      await parent.save().catch(() => {});
    } catch (_e) { /* best-effort */ }
    throw err;
  }

  // Flip parent to 'generating' — the UI treats children_in_flight as
  // progress. We don't enqueue the parent itself; it's a container.
  parent.status = 'generating';
  parent.statusMessage = 'Rendering scenes…';
  parent.startedAt = new Date();
  await parent.save();

  return {
    reelId: parent._id.toString(),
    sessionId,
    isNewSession,
    sceneCount: plan.sceneCount,
    totalCreditsCost: plan.totalCreditsCost,
    totalDurationSec: plan.totalDurationSec,
    childJobIds: children.map((c) => c._id.toString()),
    reelMeta: plan.reelMeta,
  };
}

/**
 * getReel — aggregate parent + child progress. The "parent status" returned
 * here is computed on the fly so the caller always sees an accurate rollup
 * even if the parent record hasn't been flipped yet.
 */
async function getReel(reelId, owner) {
  const parent = await StudioJob.findById(reelId).lean();
  if (!parent) return null;

  // Soft ownership check — sessionId OR userId must match. Controller still
  // does the hard auth; this is belt-and-suspenders for shared URLs.
  const ownsByUser    = owner?.userId && parent.userId?.toString() === owner.userId.toString();
  const ownsBySession = owner?.sessionId && parent.sessionId === owner.sessionId;
  if (!ownsByUser && !ownsBySession) {
    const err = new Error('reel_forbidden');
    err.code = 'forbidden';
    throw err;
  }

  const children = await StudioJob.find({ parentJobId: parent._id })
    .sort({ 'userInputs.sceneIndex': 1, createdAt: 1 })
    .lean();

  const statuses = children.map((c) => c.status);
  const completed = statuses.filter((s) => s === 'completed').length;
  const failed    = statuses.filter((s) => s === 'failed').length;
  const pending   = children.length - completed - failed;

  let rollupStatus = 'generating';
  if (children.length === 0)            rollupStatus = parent.status || 'queued';
  else if (failed === children.length)  rollupStatus = 'failed';
  else if (completed === children.length) rollupStatus = 'completed';
  else if (completed + failed === children.length && failed > 0) rollupStatus = 'partial';

  const totalProgress = children.length
    ? Math.round(
        children.reduce((sum, c) => sum + (c.progress || 0), 0) / children.length,
      )
    : (parent.progress || 0);

  return {
    reelId: parent._id.toString(),
    status: rollupStatus,
    progress: totalProgress,
    statusMessage: parent.statusMessage,
    reelMeta: parent.userInputs?.extras?.reelMeta || null,
    sceneCount: children.length,
    totals: { completed, failed, pending },
    scenes: children.map((c) => ({
      jobId:        c._id.toString(),
      sceneIndex:   c.userInputs?.sceneIndex ?? null,
      status:       c.status,
      progress:     c.progress || 0,
      statusMessage: c.statusMessage,
      prompt:       c.userInputs?.prompt || '',
      durationSec:  c.userInputs?.duration || 0,
      modelId:      c.modelId,
      firstFrameUrl: c.userInputs?.referenceImageUrl || null,
      lastFrameUrl:  c.userInputs?.endFrameUrl       || null,
      inheritedStartFrame: !!c.userInputs?.extras?.inheritedStartFrame,
      videoUrl:     c.output?.storedVideoUrl || c.output?.watermarkedUrl || c.output?.rawVideoUrl || null,
      thumbnailUrl: c.output?.thumbnailUrl || null,
      error:        c.error?.message || null,
    })),
    createdAt: parent.createdAt,
    startedAt: parent.startedAt,
    updatedAt: parent.updatedAt,
  };
}

module.exports = {
  planReel,
  enqueueReel,
  getReel,
  mergeSceneDefaults,
  // Exported for tests:
  _schemas: { reelInputSchema, sceneSchema, constraintsSchema },
};
