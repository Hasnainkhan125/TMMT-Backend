'use strict';

const { getStudioSessionId } = require('../middelwares/studioIdentity');

/**
 * influencerService — Phase 6 AI Influencer Builder.
 *
 * Turns the builder-rail vocabulary (Character Type, Gender, Ethnicity,
 * Skin, Eyes, Horns, …) into a persisted *Persona* and gives the rest of
 * Studio a first-class way to re-render that same identity into new scenes
 * without the face drifting.
 *
 * Three public entry points:
 *
 *   buildPromptFromAttrs(attrs, userPrompt)
 *     Pure helper. Composes builder attributes + cinematic baseline into
 *     one prompt. Used by both hero creation and scene composition.
 *
 *   createPersona({ req, inputs })
 *     Creates a Persona document + enqueues the "hero" render that becomes
 *     the canonical reference face. Hero is rendered with an identity-
 *     defining model (flux_pro / nano_banana_pro by default) — the one
 *     the user asked for if they picked one.
 *
 *   generateScene({ req, personaId, scenePrompt, kind, numVariants, … })
 *     Re-renders the persona in a new scene. Hero URL is fed as
 *     referenceImageUrl to an identity-preserving model
 *     (flux_kontext_pro / seedream_v45_edit / nano_banana_pro_edit) so
 *     "Layla at the Marina" actually looks like Layla.
 *     numVariants > 1 fans out via adSetService — same parent/child shape
 *     the variant grid UI already knows how to render.
 *
 * Why a separate service (not inline in the controller):
 *   • The pure prompt composer is unit-testable on its own.
 *   • Persona lifecycle (draft → generating → ready → failed) can grow
 *     (e.g. retry-hero, regenerate-hero, import-from-photo) without
 *     adding more Express-shaped branches.
 *   • Downstream features (brand kits, ad sets, reels) want to call
 *     `generateScene` without simulating an HTTP request.
 */

const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');

const Persona           = require('../model/schema/persona');
const StudioJob         = require('../model/schema/studioJob');
const StudioAsset       = require('../model/schema/studioAsset');
const creditsService    = require('./creditsService');
const modelRouter       = require('./modelRouter');
const { enqueueStudioJob } = require('./queues');
const { assertPublicUrl } = require('../utils/assertPublicUrl');

// Lazy-load adSetService so unit tests of the pure helpers don't have to
// stub the ad set fan-out plumbing.
function loadAdSetService() {
  try { return require('./adSetService'); } catch (_e) { return null; }
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const attributesSchema = z.object({
  characterType:   z.string().optional(),
  gender:          z.string().optional(),
  ethnicity:       z.string().optional(),
  skinColor:       z.string().optional(),
  eyeColor:        z.string().optional(),
  skinCondition:   z.string().optional(),
  age:             z.string().optional(),
  eyesType:        z.string().optional(),
  eyesDetail:      z.string().optional(),
  mouth:           z.string().optional(),
  ears:            z.string().optional(),
  horns:           z.string().optional(),
  skinMaterial:    z.string().optional(),
  surfacePattern:  z.string().optional(),
  bodyDescription: z.string().max(400).optional(),
  styleDescription:z.string().max(400).optional(),
  faceDescription: z.string().max(400).optional(),
}).partial().passthrough();  // accept forward-compatible fields (hair, outfit…)

const createPersonaSchema = z.object({
  name:        z.string().trim().min(1).max(60).optional(),
  kind:        z.enum(['avatar', 'character', 'influencer']).optional().default('influencer'),
  attributes:  attributesSchema.optional().default({}),
  userPrompt:  z.string().trim().max(600).optional().default(''),
  // Optional explicit model. Defaults resolved in `defaultHeroModel`.
  modelId:     z.string().optional(),
  aspectRatio: z.enum(['1:1', '9:16', '16:9', '4:5', '3:4', '4:3']).optional().default('4:5'),
  tags:        z.array(z.string().trim().min(1).max(30)).max(10).optional().default([]),
  // Skip render — use an existing photo URL as the hero. Useful when the
  // user wants "model their dog" or "use my team lead's headshot". We flip
  // the persona straight to 'ready' and never charge.
  importedReferenceUrl: z.string().url().optional(),
});

const generateSceneSchema = z.object({
  scenePrompt:  z.string().trim().min(1, 'Describe the scene.').max(1200),
  kind:         z.enum(['image', 'video']).optional().default('image'),
  numVariants:  z.coerce.number().int().min(1).max(5).optional().default(1),
  aspectRatio:  z.enum(['1:1', '9:16', '16:9', '4:5', '3:4', '4:3']).optional(),
  durationSec:  z.coerce.number().int().min(1).max(10).optional().default(5),
  modelId:      z.string().optional(),
  resolution:   z.enum(['480p', '720p', '1080p', '4k']).optional(),
  constraints:  z.record(z.string(), z.unknown()).optional().default({}),
  generateCopy: z.boolean().optional(),
  platform:     z.enum(['instagram', 'facebook', 'tiktok', 'whatsapp', 'linkedin']).optional(),
  locale:       z.enum(['gulf', 'global']).optional().default('gulf'),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_PRIORITY = { agency: 1, pro: 2, starter: 5, free: 5 };

// Default hero model by kind — optimised for "a clean identity portrait
// that future scenes can reference". Edit-class models (…_edit, kontext)
// are intentionally NOT used here — they need an input image, which the
// hero call by definition doesn't have yet.
const DEFAULT_HERO_MODELS = {
  influencer: 'flux_pro',
  avatar:     'flux_pro',
  character:  'seedream_v4',
};

// Default SCENE models — must support reference image for identity
// preservation. The worker's providerParamMap maps `referenceImageUrl`
// onto the provider-specific key for each of these.
const DEFAULT_SCENE_MODELS = {
  image: 'flux_kontext_pro',   // reference-aware edits
  video: 'kling_v3_pro',       // ref-image video (falls back to an active model if unavailable)
};

// ─── Prompt phrasing map ─────────────────────────────────────────────────────
//
// Kept verbose by design — the vocabulary is the product surface. Each
// bucket maps the UI chip value (lowercased) to a short cinematic phrase
// the model understands without further context. Unmapped values pass
// through verbatim so forward-compatible UI changes "just work".

const PHRASE_MAP = {
  characterType: {
    human: 'a confident human person',
    elf: 'a high-fantasy elf',
    alien: 'a graceful humanoid alien',
    reptile: 'a humanoid reptile being',
    amphibian: 'a humanoid amphibian',
    beetle: 'a sleek humanoid beetle',
    mantis: 'an elegant humanoid mantis',
    bee: 'a humanoid bee character',
    ant: 'a humanoid ant warrior',
    octopus: 'a humanoid octopus mage',
    crocodile: 'a humanoid crocodile',
    iguana: 'a humanoid iguana',
    lizard: 'a humanoid lizard',
  },
  gender: {
    female: 'female-presenting',
    male: 'male-presenting',
    'trans man': 'trans-masculine',
    'trans woman': 'trans-feminine',
    'non-binary': 'non-binary',
  },
  ethnicity: {
    african: 'African heritage',
    asian: 'East Asian heritage',
    european: 'European heritage',
    indian: 'South Asian / Indian heritage',
    'middle eastern': 'Middle Eastern / Khaleeji heritage',
    mixed: 'mixed heritage',
  },
  skinColor: {
    'mixed colors': 'multi-tone skin with subtle gradient transitions',
  },
  eyeColor: {
    black: 'deep black eyes',
    brown: 'warm brown eyes',
    'deep brown': 'deep brown almond eyes',
    blue: 'piercing blue eyes',
    green: 'striking green eyes',
    amber: 'amber-gold eyes',
    grey: 'silver-grey eyes',
    red: 'crimson eyes',
    purple: 'violet eyes',
    white: 'white iris-less eyes',
    'black (solid:void)': 'solid void-black eyes',
    'white (blind:empty)': 'blind milky-white eyes',
  },
  skinCondition: {
    vitiligo: 'expressive vitiligo patterning across skin',
    pigmentation: 'natural pigmentation variation',
    freckles: 'soft freckles across cheeks and nose bridge',
    birthmarks: 'subtle birthmarks',
    scars: 'storied healed scars',
    burns: 'healed burn scarring with character',
    albinism: 'albinism — pale skin and white hair',
    'cracked / dry skin': 'weathered cracked skin',
    'wrinkled skin': 'deeply wrinkled, lived-in skin',
  },
  age: {
    adult: 'in their late 20s',
    mature: 'in their 40s',
    senior: 'in their 60s',
  },
  eyesType: {
    human: 'human eye anatomy',
    reptile: 'slit reptilian pupils',
    mechanical: 'iridescent mechanical iris with apertures',
  },
  eyesDetail: {
    'different eye colors': 'heterochromia (two different eye colors)',
    'blind eye': 'one blind milky eye',
    'scarred eye': 'a scar across one eye',
    'glowing eye': 'eyes with an inner glow',
  },
  mouth: {
    'small mouth': 'small lips',
    'large mouth': 'wide expressive mouth',
    'no teeth': 'no visible teeth',
    'different teeth': 'asymmetric teeth',
    'sharp teeth': 'sharpened predator teeth',
    'forked tongue': 'forked tongue',
    'two tongues': 'two tongues',
  },
  ears: {
    human: 'human ears',
    elf: 'pointed elven ears',
    'no ears': 'no external ears',
    'wing ears': 'wing-shaped ears',
  },
  horns: {
    'small horns': 'small ridged horns',
    'big horns': 'large curving horns',
    antlers: 'branching antlers',
  },
  skinMaterial: {
    'human skin': 'natural human skin texture',
    scales: 'iridescent scaled skin',
    fur: 'short velvety fur',
    'amphibian skin': 'glossy amphibian skin',
    'fish skin': 'fish-like skin with subtle scales',
    metallic: 'polished metallic skin',
  },
  surfacePattern: {
    solid: 'solid uniform surface',
    stripes: 'striped pattern across the body',
    spots: 'spotted pattern',
    'chess pattern': 'checkerboard pattern',
    'veins visible': 'visible glowing veins beneath the skin',
    'giraffe pattern': 'giraffe-like reticulated pattern',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req, sessionId) {
  return { userId: req?.user?._id || null, sessionId: sessionId || null };
}

function pickPhrase(attr, value) {
  if (!value) return null;
  const bucket = PHRASE_MAP[attr];
  if (!bucket) return value;
  return bucket[String(value).toLowerCase()] || value;
}

/**
 * Compose builder attributes + optional free-form refinement into a single
 * cinematic prompt. Extracted so unit tests can pin the exact output without
 * booting the DB, and so `generateScene` can call it with the persona's
 * stored attributes when re-rendering a different scene.
 *
 * Output shape (one long sentence, parts joined by ". "):
 *   SUBJECT.  FACIAL.  SKIN.  BODY.  STYLE.  FACE.  CINEMATIC_BASELINE.
 * Parts with no content are skipped.
 */
function buildPromptFromAttrs(attrs = {}, userPrompt = '') {
  const parts = [];

  const subject = [
    pickPhrase('characterType', attrs.characterType) || 'a confident person',
    pickPhrase('gender', attrs.gender),
    pickPhrase('ethnicity', attrs.ethnicity),
    pickPhrase('age', attrs.age),
  ].filter(Boolean).join(', ');
  parts.push(subject);

  const facial = [
    pickPhrase('eyeColor', attrs.eyeColor),
    pickPhrase('eyesType', attrs.eyesType),
    pickPhrase('eyesDetail', attrs.eyesDetail),
    pickPhrase('mouth', attrs.mouth),
    pickPhrase('ears', attrs.ears),
    pickPhrase('horns', attrs.horns),
  ].filter(Boolean);
  if (facial.length) parts.push(facial.join(', '));

  const skin = [
    pickPhrase('skinMaterial', attrs.skinMaterial),
    pickPhrase('skinColor', attrs.skinColor),
    pickPhrase('skinCondition', attrs.skinCondition),
    pickPhrase('surfacePattern', attrs.surfacePattern),
  ].filter(Boolean);
  if (skin.length) parts.push(skin.join(', '));

  if (attrs.bodyDescription)  parts.push(`body: ${attrs.bodyDescription}`);
  if (attrs.styleDescription) parts.push(`style: ${attrs.styleDescription}`);
  if (attrs.faceDescription)  parts.push(`face: ${attrs.faceDescription}`);

  // Cinematic baseline — editorial portrait defaults so hero output looks
  // like a magazine shot instead of "a character reference sheet".
  parts.push(
    'editorial portrait, soft key light from camera-left, gentle rim light, ' +
    'shallow depth of field, 85mm lens, hyper-detailed skin texture, ' +
    'photorealistic, magazine-grade composition',
  );

  // User intent sits at the FRONT so it's weighted highest — free-form
  // descriptions routinely contain the mood ("confident", "moody",
  // "editorial for a streetwear campaign") that the attribute vocabulary
  // can't capture.
  const out = parts.join('. ');
  return userPrompt ? `USER INTENT: ${userPrompt}. ${out}` : out;
}

/**
 * Compose a SCENE prompt: persona's canonical description (abbreviated)
 * + the user's scene description. We keep the persona summary short —
 * identity-preserving models get the face from the reference image, so
 * pushing the full attribute dump into the prompt actually *hurts*
 * adherence by crowding the scene tokens.
 */
function buildScenePrompt({ persona, scenePrompt }) {
  const personaSummary = [
    pickPhrase('characterType', persona?.attributes?.characterType),
    pickPhrase('gender', persona?.attributes?.gender),
    pickPhrase('ethnicity', persona?.attributes?.ethnicity),
    pickPhrase('age', persona?.attributes?.age),
  ].filter(Boolean).join(', ') || 'the same person from the reference image';

  // "SAME PERSON FROM REFERENCE" is a cue many identity-preserving models
  // (kontext, seedream edit) respond to strongly — it biases them toward
  // identity lock instead of "a similar person".
  const header = `SAME PERSON FROM REFERENCE: ${personaSummary}.`;

  const cinematic =
    'natural lighting, cinematic composition, photoreal, sharp focus on subject, ' +
    'magazine-grade framing, preserve facial identity from reference';

  return `${header} SCENE: ${scenePrompt}. ${cinematic}`;
}

function defaultAspectRatio(kind) {
  return kind === 'video' ? '9:16' : '4:5';
}

function defaultHeroModel(kind) {
  return DEFAULT_HERO_MODELS[kind] || DEFAULT_HERO_MODELS.influencer;
}

function defaultSceneModel(kind) {
  return DEFAULT_SCENE_MODELS[kind] || DEFAULT_SCENE_MODELS.image;
}

// ─── Public API: Personas ────────────────────────────────────────────────────

/**
 * Create a new persona. Always creates the Persona document; the hero is
 * either enqueued (normal path) or skipped (imported reference path).
 *
 * Returns { persona, jobId? } — jobId is null when the user imported a photo.
 *
 * Failure modes:
 *   - validation_error         (zod)
 *   - insufficient_credits     (402-class; hero render charge)
 *   - requested_model_unavailable / missing_required_field (modelRouter)
 * The persona is NOT rolled back on render failure — it stays in 'failed'
 * status so the UI can offer a retry without re-gathering attributes.
 */
async function createPersona({ req, inputs }) {
  const parsed = createPersonaSchema.parse(inputs || {});

  const sessionId    = getSessionId(req) || uuidv4();
  const isNewSession = !getSessionId(req);
  const owner        = ownerFromReq(req, sessionId);
  const isAdmin      = (req?.user?.role || '').toLowerCase() === 'admin';
  const tier         = isAdmin ? 'agency' : (req?.user?.plan || 'free');

  // Default name — "Layla" style pretty, but here we just fall back to a
  // dated stub so the UI is never label-less. Users can rename in the
  // library later.
  const name = (parsed.name && parsed.name.trim()) ||
    `${parsed.kind === 'character' ? 'Character' : parsed.kind === 'avatar' ? 'Avatar' : 'Influencer'} ${new Date().toISOString().slice(0, 10)}`;

  // ── Imported-photo path ───────────────────────────────────────────────────
  // User already has a headshot they want to use as the identity anchor.
  // We don't charge, don't enqueue, and flip straight to 'ready'.
  if (parsed.importedReferenceUrl) {
    const persona = await Persona.create({
      userId:    owner.userId,
      sessionId,
      name,
      kind:      parsed.kind,
      attributes: parsed.attributes || {},
      userPrompt: parsed.userPrompt || '',
      status:     'ready',
      heroImageUrl:     parsed.importedReferenceUrl,
      heroThumbnailUrl: parsed.importedReferenceUrl,
      importedReferenceUrl: parsed.importedReferenceUrl,
      seedPrompt:  buildPromptFromAttrs(parsed.attributes || {}, parsed.userPrompt),
      seedModelId: null,
      tags:        parsed.tags || [],
    });
    return { persona, jobId: null, sessionId, isNewSession };
  }

  // ── Standard path: render the hero ────────────────────────────────────────
  const finalPrompt = buildPromptFromAttrs(parsed.attributes || {}, parsed.userPrompt);

  // Route (explicit model or kind-appropriate default). We intentionally
  // DON'T pass a referenceImageUrl here — the hero IS the reference, so
  // it's a text-to-image step.
  const routed = await modelRouter.route({
    template: null,
    requestedModelId: parsed.modelId || defaultHeroModel(parsed.kind),
    kind: 'image',
    prompts: { finalPrompt, negativePrompt: '' },
    aspectRatio: parsed.aspectRatio,
    variants: 1,
  });

  // Credits gate — upfront so we don't create an orphan persona when the
  // user can't afford the hero render.
  if (!isAdmin) {
    const balance = await creditsService.getBalance(owner);
    if (balance < routed.creditsCost) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      err.required = routed.creditsCost;
      err.balance  = balance;
      throw err;
    }
  }

  // Persona document first — we want a stable id to tag the job with so
  // "which persona does this job belong to?" is answerable from either
  // direction (Job → personaId via extras, Persona → heroJobId directly).
  const persona = await Persona.create({
    userId:    owner.userId,
    sessionId,
    name,
    kind:      parsed.kind,
    attributes: parsed.attributes || {},
    userPrompt: parsed.userPrompt || '',
    status:     'generating',
    seedPrompt:  finalPrompt,
    seedModelId: routed.modelId,
    tags:        parsed.tags || [],
  });

  // StudioJob for the hero render — same shape as any other image job so
  // the worker/history/assets pipeline treats it as a first-class record.
  const heroJob = await StudioJob.create({
    userId:    owner.userId,
    sessionId,
    category:  parsed.kind,
    kind:      'image',
    userInputs: {
      brandName:      '',
      description:    parsed.userPrompt || name,
      prompt:         parsed.userPrompt || '',
      targetAudience: '',
      vibe:           '',
      locale:         'gulf',
      aspectRatio:    parsed.aspectRatio,
      duration:       0,
      constraints:    {},
      extras: {
        tool:        parsed.kind === 'character' ? 'character' : parsed.kind === 'avatar' ? 'avatar' : 'ai_influencer',
        personaId:   persona._id.toString(),
        isPersonaHero: true,
        builderAttributes: parsed.attributes || {},
      },
      _providerInput: routed.input,
    },
    promptPipeline: {
      rawUserIntent:  parsed.userPrompt || finalPrompt.slice(0, 200),
      finalPrompt,
      negativePrompt: '',
      strategy:       'persona_hero',
      sceneFromUser:  false,
    },
    tier,
    isWatermarked: !isAdmin && tier === 'free',
    status:        'queued',
    statusMessage: `Hero render queued — ${name}.`,
    modelId:       routed.modelId,
    falModelId:    routed.falModelId,
    variantsRequested: 1,
  });

  // Back-link the persona to its hero job BEFORE we charge/enqueue — if
  // the render later fails, the library UI can find it and offer retry.
  persona.heroJobId = heroJob._id;
  await persona.save();

  if (!isAdmin && routed.creditsCost > 0) {
    await creditsService.chargeForJob({
      owner,
      job: heroJob,
      cost: routed.creditsCost,
      modelId: routed.modelId,
    });
  }

  await enqueueStudioJob({
    jobId: heroJob._id.toString(),
    kind: 'image',
    priority: TIER_PRIORITY[tier] || 5,
  });

  return {
    persona,
    jobId: heroJob._id.toString(),
    sessionId,
    isNewSession,
    creditsCost: routed.creditsCost,
  };
}

/**
 * Finalize the hero — called by the frontend after polling shows the hero
 * job completed. Stamps heroAssetId / heroImageUrl / heroThumbnailUrl onto
 * the persona and flips status. Idempotent; calling twice is a no-op.
 */
async function finalizeHero(personaId, owner) {
  const persona = await Persona.findById(personaId);
  if (!persona) return null;
  ensureOwner(persona, owner);

  if (persona.status === 'ready') return persona;  // already finalized

  if (!persona.heroJobId) {
    const err = new Error('Persona has no hero job to finalize.');
    err.code = 'no_hero_job';
    throw err;
  }

  const job = await StudioJob.findById(persona.heroJobId).lean();
  if (!job) {
    persona.status = 'failed';
    await persona.save();
    return persona;
  }

  if (job.status === 'failed') {
    persona.status = 'failed';
    await persona.save();
    return persona;
  }

  if (job.status !== 'completed') return persona; // still rendering

  // Pick the best URL the worker has saved — stored (CDN) > watermarked
  // > raw. For identity reference we prefer the CLEAN (un-watermarked)
  // render because a watermark in the reference poisons future scene
  // renders. Fall back only when clean isn't available (e.g. free tier).
  const out = job.output || {};
  const hero = out.cleanUrl || out.storedImageUrl || out.watermarkedUrl || out.rawImageUrl;
  if (!hero) {
    persona.status = 'failed';
    await persona.save();
    return persona;
  }

  persona.heroImageUrl     = hero;
  persona.heroThumbnailUrl = out.thumbnailUrl || hero;
  persona.heroAssetId      = job.assetId || null;
  persona.status           = 'ready';
  await persona.save();
  return persona;
}

/**
 * Get a single persona with ownership check. Returns null if not found —
 * caller decides whether to 404.
 */
async function getPersona(personaId, owner) {
  const persona = await Persona.findById(personaId).lean();
  if (!persona) return null;
  ensureOwner(persona, owner);
  return persona;
}

/**
 * List personas for the current owner. Not archived, sorted by recent use.
 * Scene counts are derived lazily — if you need perfect accuracy for the
 * library tile, call `refreshSceneCount(id)` on the way in.
 */
async function listPersonas(owner, { limit = 50, offset = 0 } = {}) {
  const query = { status: { $ne: 'archived' } };
  if (owner?.userId) query.userId = owner.userId;
  else if (owner?.sessionId) query.sessionId = owner.sessionId;
  else return [];

  return Persona.find(query)
    .sort({ lastUsedAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
}

async function archivePersona(personaId, owner) {
  const persona = await Persona.findById(personaId);
  if (!persona) return null;
  ensureOwner(persona, owner);
  persona.status = 'archived';
  await persona.save();
  return persona;
}

// ─── Public API: Scenes ──────────────────────────────────────────────────────

/**
 * Generate a new scene for a persona.
 *
 *   - numVariants === 1  → single StudioJob, same pipeline as normal gen.
 *   - numVariants  >  1  → delegates to adSetService so the user sees the
 *                          same variant-grid UI, but with
 *                          `referenceImageUrl=persona.heroImageUrl` glued
 *                          in so identity stays locked across variants.
 *
 * Kind can be image or video — video scenes use kling_v3_pro by default
 * (i2v with a reference frame locks the face for the first shot; for a
 * five-second clip that's typically enough).
 */
async function generateScene({ req, personaId, inputs }) {
  const parsed = generateSceneSchema.parse(inputs || {});

  const persona = await Persona.findById(personaId);
  if (!persona) {
    const err = new Error('persona_not_found');
    err.code = 'persona_not_found';
    throw err;
  }
  const sessionId = getSessionId(req) || persona.sessionId;
  const owner = ownerFromReq(req, sessionId);
  ensureOwner(persona, owner);

  if (persona.status !== 'ready' || !persona.heroImageUrl) {
    const err = new Error('Persona hero not ready — wait for the hero render to complete or retry.');
    err.code = 'persona_hero_not_ready';
    throw err;
  }

  const aspectRatio = parsed.aspectRatio || defaultAspectRatio(parsed.kind);
  const finalPrompt = buildScenePrompt({ persona, scenePrompt: parsed.scenePrompt });

  // ── Multi-variant path — reuse adSetService for the fan-out ──────────────
  if (parsed.numVariants > 1) {
    const adSetService = loadAdSetService();
    if (!adSetService) {
      const err = new Error('Ad set service unavailable for multi-variant scene.');
      err.code = 'internal_error';
      throw err;
    }
    const result = await adSetService.enqueueAdSet({
      req,
      inputs: {
        prompt: finalPrompt,
        kind: parsed.kind,
        numVariants: parsed.numVariants,
        aspectRatio,
        durationSec: parsed.kind === 'video' ? parsed.durationSec : undefined,
        modelId: parsed.modelId || defaultSceneModel(parsed.kind),
        resolution: parsed.resolution,
        // THE critical line — hero image as reference for every variant.
        referenceImageUrl: persona.heroImageUrl,
        brandName: persona.name,
        category: persona.kind,
        locale: parsed.locale || 'gulf',
        platform: parsed.platform,
        // Persona scenes typically don't need ad copy — the persona IS the
        // product. Opt-in via generateCopy=true.
        generateCopy: parsed.generateCopy ?? false,
        constraints: parsed.constraints,
        extras: {
          personaId: persona._id.toString(),
          isPersonaScene: true,
          tool: 'persona_scene',
        },
      },
    });

    persona.sceneCount += parsed.numVariants;
    persona.lastUsedAt = new Date();
    await persona.save();

    return {
      kind: 'ad_set',
      adSetId: result.adSetId,
      numVariants: result.numVariants,
      totalCreditsCost: result.totalCreditsCost,
      childJobIds: result.childJobIds,
      sessionId: result.sessionId,
    };
  }

  // ── Single-variant path — direct StudioJob ───────────────────────────────
  const isAdmin = (req?.user?.role || '').toLowerCase() === 'admin';
  const tier    = isAdmin ? 'agency' : (req?.user?.plan || 'free');

  // Persona.heroImageUrl should already be an R2/CDN URL (written by the
  // hero-render worker), but guard defensively — an imported persona or a
  // dev DB snapshot may carry a stale localhost URL.
  assertPublicUrl(persona.heroImageUrl, { fieldName: 'persona.heroImageUrl' });

  const routed = await modelRouter.route({
    template: null,
    requestedModelId: parsed.modelId || defaultSceneModel(parsed.kind),
    kind: parsed.kind,
    prompts: { finalPrompt, negativePrompt: '' },
    aspectRatio,
    durationSec: parsed.kind === 'video' ? parsed.durationSec : undefined,
    variants: 1,
    referenceImageUrl: persona.heroImageUrl,
    resolution: parsed.resolution,
  });

  if (!isAdmin) {
    const balance = await creditsService.getBalance(owner);
    if (balance < routed.creditsCost) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      err.required = routed.creditsCost;
      err.balance  = balance;
      throw err;
    }
  }

  const job = await StudioJob.create({
    userId:    owner.userId,
    sessionId,
    category:  persona.kind,
    kind:      parsed.kind,
    userInputs: {
      brandName:      persona.name,
      description:    parsed.scenePrompt,
      prompt:         parsed.scenePrompt,
      targetAudience: '',
      vibe:           '',
      locale:         parsed.locale || 'gulf',
      aspectRatio,
      duration:       parsed.kind === 'video' ? parsed.durationSec : 0,
      referenceImageUrl: persona.heroImageUrl,
      resolution:     parsed.resolution || null,
      constraints:    parsed.constraints || {},
      extras: {
        tool:        'persona_scene',
        personaId:   persona._id.toString(),
        isPersonaScene: true,
        heroImageUrl: persona.heroImageUrl,
      },
      _providerInput: routed.input,
    },
    promptPipeline: {
      rawUserIntent:  parsed.scenePrompt,
      finalPrompt,
      negativePrompt: '',
      strategy:       'persona_scene',
      sceneFromUser:  true,
    },
    tier,
    isWatermarked: !isAdmin && tier === 'free',
    status:        'queued',
    statusMessage: `Scene queued — ${persona.name}.`,
    modelId:       routed.modelId,
    falModelId:    routed.falModelId,
    variantsRequested: 1,
  });

  if (!isAdmin && routed.creditsCost > 0) {
    await creditsService.chargeForJob({
      owner,
      job,
      cost: routed.creditsCost,
      modelId: routed.modelId,
    });
  }

  await enqueueStudioJob({
    jobId: job._id.toString(),
    kind: parsed.kind,
    priority: TIER_PRIORITY[tier] || 5,
  });

  persona.sceneCount += 1;
  persona.lastUsedAt = new Date();
  await persona.save();

  return {
    kind: 'single',
    jobId: job._id.toString(),
    modelId: routed.modelId,
    modelLabel: routed.label,
    creditsCost: routed.creditsCost,
    sessionId,
  };
}

/**
 * Load the persona-tagged jobs that have rendered off a given persona.
 * Used by the persona detail view — "all scenes of Layla".
 */
async function listScenes(personaId, owner, { limit = 20 } = {}) {
  const persona = await Persona.findById(personaId).lean();
  if (!persona) return [];
  ensureOwner(persona, owner);

  // Scenes are StudioJobs with extras.personaId set. We exclude the hero
  // from the scene list — the library tile handles it separately.
  return StudioJob.find({
    'userInputs.extras.personaId': persona._id.toString(),
    'promptPipeline.strategy': { $ne: 'persona_hero' },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureOwner(doc, owner) {
  const byUser    = owner?.userId && doc?.userId?.toString() === owner.userId.toString();
  const bySession = owner?.sessionId && doc?.sessionId === owner.sessionId;
  if (!byUser && !bySession) {
    const err = new Error('persona_forbidden');
    err.code = 'forbidden';
    throw err;
  }
}

module.exports = {
  // Public
  createPersona,
  getPersona,
  listPersonas,
  archivePersona,
  finalizeHero,
  generateScene,
  listScenes,
  // Pure helpers (exported for tests + legacy controller reuse)
  buildPromptFromAttrs,
  buildScenePrompt,
  pickPhrase,
  // Schemas + constants for tests
  _schemas: { attributesSchema, createPersonaSchema, generateSceneSchema },
  _constants: { DEFAULT_HERO_MODELS, DEFAULT_SCENE_MODELS, defaultAspectRatio, defaultHeroModel, defaultSceneModel },
  // Dependency for the controller's StudioAsset linking (kept to make the
  // require graph obvious for testers looking for "where does this touch
  // assets?").
  _StudioAsset: StudioAsset,
};
