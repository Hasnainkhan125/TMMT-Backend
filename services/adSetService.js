'use strict';

/**
 * adSetService — Phase 5 Ads Pipeline (3–5 variants).
 *
 * An "ad set" is a sibling-group of creative variations generated from a
 * single brief. Where a reel (Phase 4) stitches N clips into one sequential
 * story, an ad set fans N *independent* creatives out so the user can
 * A/B-pick the winner. Each variant inherits the same brand + scene text,
 * then gets a distinct cinematic track (angle, lighting, pace) courtesy of
 * `intentEngine.buildVariants`. Optionally, we kick a single Haiku call to
 * generate headlines/captions/hashtags so the user doesn't have to jump to
 * Copy Writing after renders finish.
 *
 * Same parent/child StudioJob shape as reelService so the existing jobStore,
 * assets pipeline, and credits ledger "just work" without a schema bump:
 *
 *   parent StudioJob (strategy='ad_set_parent', kind='image'|'video')
 *     └── child StudioJob ×N (strategy='ad_set_child', variantIndex=0..N-1)
 *
 * Why a parent AT ALL (vs. just N sibling jobs):
 *   • Copy is generated ONCE per brief and stored on the parent. A plain
 *     sibling fan-out would regenerate copy N times (waste of Haiku tokens)
 *     or force the UI to stitch copy onto an arbitrary "winner" child.
 *   • The History list renders one tile per brief, not five per brief.
 *   • Refunds roll up cleanly — if 3/5 renders fail, refund just those 3.
 *
 * Three entry points mirror reelService for symmetry:
 *   - `planAdSet(inputs)`            — dry-run pricing + variant preview
 *   - `enqueueAdSet({ req, inputs })` — atomic: parent + children + charge
 *   - `getAdSet(id, owner)`          — aggregated snapshot for the UI
 */

const { z }             = require('zod');
const { v4: uuidv4 }    = require('uuid');

const StudioJob         = require('../model/schema/studioJob');
const intentEngine      = require('./intentEngine');
const creditsService    = require('./creditsService');
const modelRouter       = require('./modelRouter');
const { assertPublicUrl } = require('../utils/assertPublicUrl');
const { enqueueStudioJob } = require('./queues');
const { getStudioSessionId } = require('../middelwares/studioIdentity');

// Copy generation is optional (the user can turn it off to save a couple
// credits). We load lazily so test mocks don't have to stub it.
function loadCopyService() {
  try { return require('./copyService'); } catch (_e) { return null; }
}

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

// Fixed bounds — we cap ad sets at 5 because:
//   • Meta creative testing research tops out at ~5 before fatigue.
//   • 5 renders × Seedance 5s video = 20 credits × 5 = 100 cr ceiling,
//     which is a sane free-tier guardrail.
const MIN_VARIANTS = 1;
const MAX_VARIANTS = 10;

const variantBlueprintRowSchema = z.object({
  prompt:            z.string().trim().min(1).max(6000),
  negativePrompt:    z.string().max(6000).optional(),
  aspectRatio:       z.enum(['16:9','9:16','1:1','4:5','3:4','4:3']).optional(),
  modelId:           z.string().max(120).optional(),
  durationSec:       z.coerce.number().int().min(1).max(10).optional(),
  referenceImageUrl: z.string().url().optional().nullable(),
  referenceImageUrls: z.array(z.string()).optional().nullable(),
  startImageUrl:     z.string().url().optional().nullable(),
  label:             z.string().max(120).optional(),
  userCopy:          z.string().max(600).optional().default(''),  // VO line for TTS
});

const adSetInputSchema = z.object({
  // Required — you can't generate an ad from nothing.
  prompt:          z.string().trim().min(1, 'Describe the ad you want.').max(6000),

  // When set, each row becomes one child variant (prompt / ratio / model / ref)
  // instead of intentEngine tracks fanning out from a single seed prompt.
  variantBlueprints: z.array(variantBlueprintRowSchema).optional(),

  // Output shape.
  kind:            z.enum(['image', 'video']).optional().default('image'),
  numVariants:     z.coerce.number().int().min(MIN_VARIANTS).max(MAX_VARIANTS).optional().default(3),
  aspectRatio:     z.enum(['16:9','9:16','1:1','4:5','3:4','4:3']).optional(),
  durationSec:     z.coerce.number().int().min(1).max(10).optional().default(5),
  modelId:         z.string().optional(),                // user-picked model
  resolution:      z.enum(['480p','720p','1080p','4k']).optional(),
  referenceImageUrl: z.string().url().optional(),
  referenceImageUrls: z.array(z.string()).optional(),
  endFrameUrl:       z.string().url().optional(),

  // Brand + targeting — only used when this really is a branded ad.
  brandName:       z.string().max(100).optional().default(''),
  targetAudience:  z.string().max(600).optional().default(''),
  category:        z.string().max(100).optional().default(''),
  locale:          z.enum(['global']).optional().default('global'),
  vibe:            z.string().max(80).optional().default(''),

  // Copy generation (headlines/captions/hashtags). Off by default for video
  // because viral reels usually have captions in-video; on by default for
  // image ads where the copy sits beside the creative on Meta.
  generateCopy:    z.boolean().optional(),
  platform:        z.enum(['instagram','facebook','tiktok','whatsapp','linkedin']).optional().default('instagram'),

  // User-level direction that merges into each variant's cinematic track.
  // Per-axis rule: if the user pinned `lighting='golden_hour'` we apply it
  // to every variant and let buildVariants vary the OTHER axes. That way
  // the user gets five angles of the same lighting brief, which is what
  // creative testing actually wants (isolate one variable at a time).
  constraints:     constraintsSchema.optional(),

  // Free-form escape hatch. The controller passes extras through to
  // `userInputs.extras` so future features (UTMs, Stripe metadata) land
  // without a schema bump.
  extras:          z.record(z.string(), z.unknown()).optional().default({}),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_PRIORITY = { agency: 1, pro: 2, starter: 5, free: 5 };

const DEFAULT_COPY_CREDITS = Number(process.env.AD_COPY_CREDITS || 5);

// Default aspect ratios per kind — matches the tool config on the frontend
// (image_ads → 4:5, viral_reels → 9:16) so presets "just work" when the
// caller doesn't pass aspectRatio explicitly.
function defaultAspectRatio(kind) {
  return kind === 'video' ? '9:16' : '4:3';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return { userId: req.user?._id || null, sessionId: sessionId || null };
}

/**
 * Compose per-variant constraints from (a) the user's direction and (b) the
 * variant's cinematic track.
 *
 * Resolution rule (important for creative testing fidelity):
 *   USER WINS. Any axis the user pinned is preserved across all variants so
 *   the user is testing one variable at a time. Axes the user left empty
 *   are filled from the variant's track. This is the opposite of a "mix
 *   everything together" merge — we want variants to differ *only* on the
 *   axes the user didn't care about.
 */
function composeConstraints(userConstraints, track) {
  const user = userConstraints || {};
  const out = { ...(track || {}) };
  for (const k of Object.keys(user)) {
    const v = user[k];
    if (v == null) continue;
    // styleTags is an array — concat+dedupe rather than replace, so the
    // user's "editorial, luxury" tags layer on top of the track's feel.
    if (k === 'styleTags' && Array.isArray(v)) {
      const merged = [...new Set([...(out.styleTags || []), ...v])];
      if (merged.length) out.styleTags = merged;
      continue;
    }
    if (v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build N variant briefs from a single input. Each returned entry is fully
 * self-contained: distinct constraints + prompt synthesized for that track.
 *
 * We reuse intentEngine.buildVariants rather than re-implementing cinematic
 * variety here — that keeps "how variants differ" in one place (the engine)
 * and makes adSet automatically inherit any future track additions.
 */
async function buildVariantBriefs({ parsed, intent, context }) {
  if (parsed.variantBlueprints?.length) {
    const briefs = [];
    for (let i = 0; i < parsed.numVariants; i++) {
      const vb = parsed.variantBlueprints[i];
      if (!vb?.prompt) break;
      const ar =
        vb.aspectRatio
        || parsed.aspectRatio
        || defaultAspectRatio(parsed.kind);
      briefs.push({
        variantIndex:      i,
        finalPrompt:       vb.prompt,
        negativePrompt:    vb.negativePrompt || '',
        constraints:       composeConstraints(parsed.constraints, {}),
        promptMetadata:    { preset: 'explicit_blueprint', variantIndex: i },
        label:             vb.label || `Variant ${i + 1}`,
        durationSec:       vb.durationSec || parsed.durationSec || null,
        startImageUrl:     vb.startImageUrl || parsed.startImageUrl || null,
        resolution:        vb.resolution || parsed.resolution || null,
        aspectRatio:       ar,
        modelId:           vb.modelId || null,
        referenceImageUrl: vb.referenceImageUrl || null,
        referenceImageUrls: vb.referenceImageUrls || [],
        userCopy:          vb.userCopy || '',
      });
    }
    return briefs;
  }

  // intentEngine.buildVariants caps at 6 by default; we enforce MAX_VARIANTS.
  const raw = intentEngine.buildVariants({
    intent,
    context,
    inputs: {
      prompt:         parsed.prompt,
      brandName:      parsed.brandName,
      targetAudience: parsed.targetAudience,
      vibe:           parsed.vibe,
      locale:         parsed.locale,
      // If the user pinned constraints, feed them to buildVariants so the
      // synthesized prompt already includes them. We still compose again
      // below when stamping the child job so the audit trail is complete.
      constraints:    parsed.constraints || {},
    },
    n: parsed.numVariants,
  });

  // Defensive: buildVariants returns a fixed order. If it ever returns
  // fewer than asked (e.g. engine bug), pad with copies of index 0 so the
  // rest of the pipeline doesn't silently lose variants.
  const briefs = [];
  for (let i = 0; i < parsed.numVariants; i++) {
    const r = raw[i] || raw[0];
    briefs.push({
      variantIndex:      i,
      finalPrompt:       r.finalPrompt,
      negativePrompt:    r.negativePrompt || '',
      constraints:       composeConstraints(parsed.constraints, r.constraints),
      promptMetadata:    r.promptMetadata,
      // Human label for the variant — shown in the grid tile header. We
      // derive it from the dominant constraint so "Hard studio" / "Golden
      // hour" / "Low-angle hero" etc. stick in the user's mind instead of
      // "Variant 2".
      label:             variantLabel(r.constraints),
      aspectRatio:       null,
      modelId:             null,
      referenceImageUrl:   null,
    });
  }
  return briefs;
}

/**
 * Human-readable variant label — picks the most distinctive axis out of
 * (lighting > motion > cameraAngle > shotType > pace) and humanises it.
 * Falls back to "Variant N" if the track is empty.
 */
function variantLabel(track = {}) {
  const pickOrder = ['lighting', 'motion', 'cameraAngle', 'shotType', 'pace'];
  for (const axis of pickOrder) {
    const v = track[axis];
    if (v) return humaniseAxisValue(axis, v);
  }
  return null;
}

function humaniseAxisValue(axis, value) {
  const LABELS = {
    lighting: {
      soft_natural:   'Soft daylight',
      hard_studio:    'Hard studio',
      golden_hour:    'Golden hour',
      high_key:       'High-key',
      low_key_moody:  'Low-key moody',
      neon_night:     'Neon night',
      ramadan_lantern:'Ramadan lantern',
    },
    motion: {
      static:     'Locked-off',
      slow_push:  'Slow push-in',
      slow_pull:  'Slow pull-back',
      orbit:      'Orbit',
      handheld:   'Handheld UGC',
      dolly_left: 'Dolly left',
      parallax:   'Parallax',
    },
    cameraAngle: {
      eye_level:     'Eye level',
      low_angle:     'Low-angle hero',
      high_angle:    'Overhead',
      dutch:         'Dutch tilt',
      overhead:      'Flat-lay',
      over_shoulder: 'Over-shoulder',
    },
    shotType: {
      extreme_close: 'Macro',
      close_up:      'Close-up',
      medium:        'Medium',
      wide:          'Wide',
      product_only:  'Product hero',
    },
    pace: {
      languid: 'Languid',
      normal:  'Standard pace',
      snappy:  'TikTok snappy',
    },
  };
  return LABELS[axis]?.[value] || String(value).replace(/_/g, ' ');
}

/**
 * Estimate the cost of a single variant. Mirrors estimateScene in reelService
 * — we resolve the model (explicit or default-for-kind) and quote credits
 * without touching the network. Required-field validation runs here so the
 * estimate agrees with what the enqueue path would do.
 */
async function estimateVariant({ variantBrief, parsed }) {
  const effectiveRef = variantBrief.referenceImageUrl || parsed.referenceImageUrl;
  const effectiveModelId = variantBrief.modelId || parsed.modelId;
  const effectiveAr =
    variantBrief.aspectRatio
    // || parsed.aspectRatio
    // || defaultAspectRatio(parsed.kind);

  // Same fail-fast as reelService: non-public reference/end URLs break FAL.
  assertPublicUrl(effectiveRef, { fieldName: 'referenceImageUrl' });
  assertPublicUrl(parsed.endFrameUrl, { fieldName: 'endFrameUrl' });

  const model = await modelRouter.resolveModel({
    requestedModelId: effectiveModelId,
    template: null,
    kind: parsed.kind,
  });

  // modelRouter.validateAspectRatio(model, effectiveAr);

  modelRouter.validateRequiredFields(model, {
    referenceImageUrl: effectiveRef,
    endFrameUrl:       parsed.endFrameUrl,
    prompt:            variantBrief.finalPrompt,
  });

  const cost = await creditsService.quote({
    modelId:     model.id,
    kind:        parsed.kind,
    durationSec: parsed.durationSec,
    variants:    1,
  });

  return {
    variantIndex:      variantBrief.variantIndex,
    modelId:           model.id,
    modelLabel:        model.label,
    label:             variantBrief.label,
    constraints:       variantBrief.constraints,
    creditsCost:       cost,
    aspectRatio:       effectiveAr,
    referenceImageUrl: effectiveRef || null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * planAdSet — validates, runs the intelligence layer, expands to N variant
 * briefs and aggregates cost. No DB writes, no charges.
 *
 * Returns:
 *   {
 *     valid: true,
 *     numVariants,
 *     kind, aspectRatio, modelId,
 *     baseCost,            // creative renders only
 *     copyCost,            // 0 if generateCopy=false
 *     totalCreditsCost,    // base + copy
 *     variants: [{ variantIndex, modelId, label, constraints, creditsCost, finalPrompt }],
 *     intent,              // classified intent (echoed for frontend display)
 *     adSetMeta,           // persisted onto the parent job
 *   }
 */
async function planAdSet(rawInputs) {
  const parsed = adSetInputSchema.parse(rawInputs);

  if (parsed.variantBlueprints?.length) {
    const n = Math.min(
      MAX_VARIANTS,
      Math.max(MIN_VARIANTS, parsed.variantBlueprints.length),
    );
    parsed.numVariants = n;
    parsed.variantBlueprints = parsed.variantBlueprints.slice(0, n);
  }

  // Fill defaults that depend on `kind`. Doing this after parse keeps the
  // zod schema "kind-agnostic" so we can unit-test defaulting separately.
  if (!parsed.aspectRatio) parsed.aspectRatio = defaultAspectRatio(parsed.kind);
  if (parsed.generateCopy == null) parsed.generateCopy = parsed.kind === 'image';

  // Run intent classification ONCE for the whole set — all variants share
  // the same domain/locale/brand semantics; only cinematic tracks vary.
  const intent = await intentEngine.classifyIntent({
    rawInput: parsed.prompt,
    locale:   parsed.locale,
    extras:   {
      brandName:      parsed.brandName,
      targetAudience: parsed.targetAudience,
      hasImage:       !!parsed.referenceImageUrl,
    },
  });

  const context = await intentEngine.assembleContext({
    intent,
    inputs: parsed,
    template: null,
    urlScrapeData: null,
  });

  const variantBriefs = await buildVariantBriefs({ parsed, intent, context });

  const perVariantEstimates = [];
  for (const brief of variantBriefs) {
    try {
      const est = await estimateVariant({ variantBrief: brief, parsed });
      perVariantEstimates.push({ ...est, finalPrompt: brief.finalPrompt });
    } catch (err) {
      err.variantIndex = brief.variantIndex;
      throw err;
    }
  }

  const baseCost = perVariantEstimates.reduce((a, b) => a + b.creditsCost, 0);
  const copyCost = parsed.generateCopy ? DEFAULT_COPY_CREDITS : 0;
  const totalCreditsCost = baseCost + copyCost;

  const adSetMeta = {
    kind:         parsed.kind,
    aspectRatio:  parsed.aspectRatio,
    durationSec:  parsed.kind === 'video' ? parsed.durationSec : null,
    numVariants:  parsed.numVariants,
    modelId:      perVariantEstimates[0]?.modelId || parsed.modelId || null,
    platform:     parsed.platform,
    locale:       parsed.locale,
    domain:       intent.domain,
    generateCopy: parsed.generateCopy,
  };

  return {
    valid: true,
    numVariants: parsed.numVariants,
    kind: parsed.kind,
    aspectRatio: parsed.aspectRatio,
    modelId: adSetMeta.modelId,
    baseCost,
    copyCost,
    totalCreditsCost,
    variants: perVariantEstimates,
    // Echo the variant briefs so the UI can show "Variant 1: Golden hour
    // hero" before the render even starts.
    variantBriefs: variantBriefs.map((b) => ({
      variantIndex:       b.variantIndex,
      label:              b.label,
      constraints:        b.constraints,
      finalPrompt:        b.finalPrompt,
      negativePrompt:     b.negativePrompt || '',
      aspectRatio:        b.aspectRatio || parsed.aspectRatio,
      modelId:            b.modelId || null,
      referenceImageUrl:  b.referenceImageUrl || null,
      referenceImageUrls: b.referenceImageUrls || [],      // per-beat images for AI model
      userCopy:           b.userCopy || '',                // VO line for TTS
      startImageUrl:      b.startImageUrl || null,         // anchor frame
      durationSec:        b.durationSec || null,           // per-beat duration
    })),
    intent: {
      intent_type:   intent.intent_type,
      domain:        intent.domain,
      is_commercial: intent.is_commercial,
      gulf_relevant: intent.gulf_relevant,
      confidence:    intent.confidence,
    },
    adSetMeta,
  };
}

/**
 * enqueueAdSet — atomic plan + parent + N children. Pattern mirrors
 * enqueueReel: upfront balance check, parent record, then per-child create +
 * charge + queue, with rollback on partial failure.
 *
 * Copy generation is kicked off in the background AFTER the creatives queue
 * so the user sees images start rendering immediately. Copy credits are
 * deducted at enqueue time (atomicity), but the Haiku call happens async.
 */
async function enqueueAdSet({ req, inputs }) {
  const plan = await planAdSet(inputs);
  const parsed = adSetInputSchema.parse(inputs);
  
  if (!parsed.aspectRatio) parsed.aspectRatio = defaultAspectRatio(parsed.kind);
  if (parsed.generateCopy == null) parsed.generateCopy = parsed.kind === 'image';

  const sessionId    = getSessionId(req) || uuidv4();
  const isNewSession = !getSessionId(req);
  const owner        = ownerFromReq(req, sessionId);
  const isAdmin      = (req.user?.role || '').toLowerCase() === 'admin';
  const tier         = isAdmin ? 'agency' : (req.user?.plan || 'free');

  const sourceScanId    = parsed.extras?.sourceScanId    || null;
  const sourceProductId = parsed.extras?.sourceProductId || null;
  const source          = parsed.extras?.source || (sourceProductId ? 'per_product' : 'studio_direct');
  // Balance gate — reject up front rather than charge 2/5 and fail on 3/5.
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

  // ── PARENT ────────────────────────────────────────────────────────────────
  // The parent is a bookkeeping record — it isn't pushed to the render
  // queue. It holds the ad set meta + generated copy once Haiku returns.
  const parent = await StudioJob.create({
    userId:    owner.userId,
    sessionId,
    category:  plan.intent.domain || parsed.category || 'ad_set',
    kind:      parsed.kind,
    userInputs: {
      brandName:      parsed.brandName,
      description:    parsed.prompt,
      prompt:         parsed.prompt,
      targetAudience: parsed.targetAudience,
      vibe:           parsed.vibe,
      locale:         parsed.locale,
      aspectRatio:    parsed.aspectRatio,
      duration:       parsed.kind === 'video' ? parsed.durationSec : 0,
      referenceImageUrl: parsed.referenceImageUrl || null,
      referenceImageUrls: parsed.referenceImageUrls || [],
      endFrameUrl:       parsed.endFrameUrl || null,
      resolution:     parsed.resolution || null,
      constraints:    parsed.constraints || {},
      extras: {
        ...(parsed.extras || {}),
        adSetMeta: plan.adSetMeta,
        isAdSetParent: true,
        platform: parsed.platform,
        adCopy: null, // populated async by copyService worker
      },
    },
    promptPipeline: {
      rawUserIntent:  parsed.prompt,
      finalPrompt:    parsed.prompt,
      strategy:       'ad_set_parent',
      intentType:     plan.intent.intent_type,
      domain:         plan.intent.domain,
      gulfRelevant:   plan.intent.gulf_relevant,
      confidence:     plan.intent.confidence,
    },
    sourceScanId: sourceScanId,
    sourceProductId: sourceProductId,
    source: source,
    tier,
    isWatermarked: !isAdmin && tier === 'free',
    status:        'queued',
    statusMessage: `Ad set queued — ${plan.numVariants} variants.`,
    modelId:       plan.modelId,
    variantsRequested: plan.numVariants,
    creditsCharged: 0,  // charged via children + copy
  });

  // ── CHILDREN ──────────────────────────────────────────────────────────────
  const children = [];
  try {
    for (const variantEst of plan.variants) {
      const brief = plan.variantBriefs.find((b) => b.variantIndex === variantEst.variantIndex);
      const childAspect =
        brief.aspectRatio
        || variantEst.aspectRatio
        || parsed.aspectRatio;
      const childRef =
        brief.referenceImageUrl
        || variantEst.referenceImageUrl
        || parsed.referenceImageUrl;
        const childRefUrls =
        brief.referenceImageUrls
        || variantEst.referenceImageUrls
        || parsed.referenceImageUrls;
      const childNeg =
        (brief.negativePrompt != null && brief.negativePrompt !== '')
          ? brief.negativePrompt
          : (brief.constraints?.negativePrompt || '');

      // Route for the exact provider payload the worker will run. We pin
      // the routed model per variant so a model swap mid-batch (admin
      // toggled a model off) fails loudly on the broken variant instead of
      // silently switching provider.
      const routed = await modelRouter.route({
        template: null,
        requestedModelId: variantEst.modelId,
        kind: parsed.kind,
        prompts: {
          finalPrompt:    brief.finalPrompt,
          negativePrompt: childNeg,
        },
        aspectRatio: childAspect,
        durationSec: parsed.kind === 'video' ? (brief.durationSec || parsed.durationSec) : undefined,
        variants:    1,
        referenceImageUrl: childRef,
        referenceImageUrls: childRefUrls,
        endFrameUrl:       parsed.endFrameUrl,
        endFrameUrl:       parsed.endFrameUrl,
        resolution:        parsed.resolution,
        motion:            brief.constraints?.motion,
        audio:             parsed.audio,
        extras: parsed.extras || {},
        _providerInput: inputs?.providerInput || {},
        generate_audio: parsed.generate_audio,
      });

      const child = await StudioJob.create({
        userId:    owner.userId,
        sessionId,
        category:  parent.category,
        kind:      parsed.kind,
        userInputs: {
          brandName:      parsed.brandName,
          description:    brief.finalPrompt,  // per-shot director prompt, not global
          prompt:         brief.finalPrompt,  // per-shot director prompt, not global
          userCopy:       brief.userCopy || '',  // VO line → spoken by TTS after render
          targetAudience: parsed.targetAudience,
          vibe:           parsed.vibe,
          locale:         parsed.locale,
          aspectRatio:    childAspect,
          duration:       parsed.kind === 'video' ? (brief.durationSec || parsed.durationSec) : 0,
          referenceImageUrl: childRef || null,
          referenceImageUrls: childRefUrls || parsed.referenceImageUrls || [],
          endFrameUrl:       parsed.endFrameUrl || null,
          resolution:     parsed.resolution || null,
          motion:         brief.constraints?.motion || null,
          constraints:    brief.constraints,
          extras: {
            parentJobId:    parent._id.toString(),
            isAdSetChild:   true,
            variantLabel:   brief.label,
            variantTrack:   brief.constraints,
          },
          _providerInput: routed.input,
        },
        promptPipeline: {
          rawUserIntent:  brief.finalPrompt,  // per-shot, not global
          finalPrompt:    brief.finalPrompt,
          negativePrompt: childNeg,
          strategy:       'ad_set_child',
          intentType:     parent.promptPipeline.intentType,
          domain:         parent.promptPipeline.domain,
          gulfRelevant:   parent.promptPipeline.gulfRelevant,
          confidence:     parent.promptPipeline.confidence,
          sceneFromUser:  true,
        },
        tier,
        isWatermarked:  parent.isWatermarked,
        status:         'queued',
        statusMessage:  `Variant ${brief.variantIndex + 1}/${plan.numVariants} queued — ${brief.label || 'cinematic track'}.`,
        modelId:        routed.modelId,
        falModelId:     routed.falModelId,
        variantsRequested: 1,
        variantIndex:   brief.variantIndex,
        parentJobId:    parent._id,
      });

      if (!isAdmin && variantEst.creditsCost > 0) {
        await creditsService.chargeForJob({
          owner,
          job: child,
          cost: variantEst.creditsCost,
          modelId: routed.modelId,
        });
      }

      await enqueueStudioJob({
        jobId: child._id.toString(),
        kind: parsed.kind,
        priority: TIER_PRIORITY[tier] || 5,
      });

      children.push(child);
    }

    // Copy charge — a single synthetic job-less ledger entry wouldn't fit
    // our chargeForJob signature (requires a job), so we piggy-back on the
    // parent. Admins skip charging entirely.
    if (parsed.generateCopy && !isAdmin && plan.copyCost > 0) {
      await creditsService.chargeForJob({
        owner,
        job: parent,
        cost: plan.copyCost,
        modelId: 'adcopy_haiku',
      });
    }
  } catch (err) {
    // Best-effort rollback — refund every already-charged child and mark
    // the parent as failed. We deliberately DO NOT re-throw from rollback
    // paths; the original error is the one the caller cares about.
    try {
      for (const c of children) {
        c.status = 'cancelled';
        c.statusMessage = 'Ad set aborted before render.';
        await c.save().catch(() => {});
        if (c.creditsCharged > 0) {
          await creditsService.refundForJob?.(c).catch(() => {});
        }
      }
      parent.status = 'failed';
      parent.statusMessage = err.message || 'Ad set enqueue failed.';
      parent.error = { message: err.message, code: err.code || 'ad_set_enqueue_failed' };
      await parent.save().catch(() => {});
    } catch (_e) { /* best-effort */ }
    throw err;
  }

  // Flip parent to 'generating' — children run in flight, parent serves as
  // the aggregator row for the UI.
  parent.status = 'generating';
  parent.statusMessage = `Rendering ${plan.numVariants} variants…`;
  parent.startedAt = new Date();
  await parent.save();

  // Kick copy generation asynchronously. We deliberately don't await so
  // the API response returns fast; the UI polls `getAdSet` which will
  // include the copy once it lands.
  if (parsed.generateCopy) {
    queueCopyGeneration({ parent, parsed }).catch((err) => {
      console.warn('[adSetService] async copy generation failed:', err?.message);
    });
  }

  return {
    adSetId:          parent._id.toString(),
    sessionId,
    isNewSession,
    numVariants:      plan.numVariants,
    totalCreditsCost: plan.totalCreditsCost,
    baseCost:         plan.baseCost,
    copyCost:         plan.copyCost,
    parent,                          
    children,
    childJobIds:      children.map((c) => c._id.toString()),
    adSetMeta:        plan.adSetMeta,
  };
}

/**
 * Fire-and-forget copy generation — writes the result back onto the parent
 * job's `userInputs.extras.adCopy`. Errors are logged but never raised; the
 * ad set still succeeds even if the Haiku call fails.
 */
async function queueCopyGeneration({ parent, parsed }) {
  const copyService = loadCopyService();
  if (!copyService) return;
  try {
    const copy = await copyService.generateCopy({
      assetId:        parent._id.toString(),   // parent acts as the asset anchor
      jobId:          parent._id.toString(),
      category:       parent.promptPipeline?.domain || parsed.category || 'service',
      brandName:      parsed.brandName || 'Brand',
      platform:       parsed.platform || 'instagram',
      locale:         parsed.locale || 'gulf',
      targetAudience: parsed.targetAudience,
    });

    // Atomic update so we don't race the worker saving the parent.
    await StudioJob.findByIdAndUpdate(parent._id, {
      $set: { 'userInputs.extras.adCopy': copy },
    });
  } catch (err) {
    await StudioJob.findByIdAndUpdate(parent._id, {
      $set: {
        'userInputs.extras.adCopyError': err?.message || 'copy_generation_failed',
      },
    }).catch(() => {});
  }
}

/**
 * getAdSet — aggregated parent + children snapshot. Returns rolled-up
 * status, per-variant URLs when ready, and the ad copy (if present).
 */
async function getAdSet(adSetId, owner) {
  const parent = await StudioJob.findById(adSetId).lean();
  if (!parent) return null;

  const ownsByUser    = owner?.userId && parent.userId?.toString() === owner.userId.toString();
  const ownsBySession = owner?.sessionId && parent.sessionId === owner.sessionId;
  if (!ownsByUser && !ownsBySession) {
    const err = new Error('ad_set_forbidden');
    err.code = 'forbidden';
    throw err;
  }

  const children = await StudioJob.find({ parentJobId: parent._id })
    .sort({ variantIndex: 1, createdAt: 1 })
    .lean();

  const statuses  = children.map((c) => c.status);
  const completed = statuses.filter((s) => s === 'completed').length;
  const failed    = statuses.filter((s) => s === 'failed').length;
  const pending   = children.length - completed - failed;

  let rollupStatus = 'generating';
  if (children.length === 0)                          rollupStatus = parent.status || 'queued';
  else if (failed === children.length)                rollupStatus = 'failed';
  else if (completed === children.length)             rollupStatus = 'completed';
  else if (completed + failed === children.length && failed > 0) rollupStatus = 'partial';

  const totalProgress = children.length
    ? Math.round(children.reduce((sum, c) => sum + (c.progress || 0), 0) / children.length)
    : (parent.progress || 0);

  return {
    adSetId: parent._id.toString(),
    status:  rollupStatus,
    progress: totalProgress,
    statusMessage: parent.statusMessage,
    adSetMeta: parent.userInputs?.extras?.adSetMeta || null,
    kind:      parent.kind,
    prompt:    parent.userInputs?.prompt || '',
    brandName: parent.userInputs?.brandName || '',
    platform:  parent.userInputs?.extras?.platform || 'instagram',
    numVariants: children.length,
    totals: { completed, failed, pending },
    adCopy: parent.userInputs?.extras?.adCopy || null,
    adCopyError: parent.userInputs?.extras?.adCopyError || null,
    variants: children.map((c) => ({
      jobId:         c._id.toString(),
      variantIndex:  c.variantIndex ?? 0,
      status:        c.status,
      progress:      c.progress || 0,
      statusMessage: c.statusMessage,
      label:         c.userInputs?.extras?.variantLabel || null,
      constraints:   c.userInputs?.extras?.variantTrack || c.userInputs?.constraints || {},
      prompt:        c.promptPipeline?.finalPrompt || c.userInputs?.prompt || '',
      modelId:       c.modelId,
      modelLabel:    null,
      // Pick the best URL the worker has saved so far. Order matters —
      // stored > watermarked > raw — because stored has the CDN-cached
      // version with the download badge, watermarked is the in-UI render,
      // and raw is the last-resort provider URL.
      imageUrl:  c.output?.storedImageUrl || c.output?.watermarkedUrl || c.output?.cleanUrl || c.output?.rawImageUrl || null,
      videoUrl:  c.output?.storedVideoUrl || c.output?.watermarkedUrl || c.output?.rawVideoUrl || null,
      thumbnailUrl: c.output?.thumbnailUrl || null,
      error:     c.error?.message || null,
      assetId:   c.assetId?.toString() || null,
    })),
    createdAt: parent.createdAt,
    startedAt: parent.startedAt,
    updatedAt: parent.updatedAt,
  };
}

module.exports = {
  planAdSet,
  enqueueAdSet,
  getAdSet,
  composeConstraints,
  buildVariantBriefs,
  variantLabel,
  // Exported for tests:
  _schemas: { adSetInputSchema, constraintsSchema },
  _constants: { MIN_VARIANTS, MAX_VARIANTS, DEFAULT_COPY_CREDITS, defaultAspectRatio },
};
