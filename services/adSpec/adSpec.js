'use strict';

/**
 * adSpec.js — THE bridge contract between competitor intelligence and your
 * existing renderVideoAd → buildShotRecipe pipeline.
 *
 * Why this exists
 * ---------------
 * Today generateVideoAdController jumps straight from `templateKey` to shots.
 * That skips the one thing that makes the product sellable: a human-editable,
 * brand-filled "blueprint" the user can review BEFORE spending credits on Wan.
 *
 * The ad-spec is that blueprint. It is produced from a competitor ad's
 * *structure* (never their assets), seeded with the user's brand + avatar +
 * product, shown for editing, and then deterministically lowered into the
 * exact opts shape buildShotRecipe already accepts. No render-engine changes.
 *
 * Flow:
 *   competitor ad  ──teardown──▶  adSpec (draft)
 *   adSpec (draft) ──user edits─▶  adSpec (confirmed)
 *   adSpec (confirmed) ──adSpecToRecipeOpts()──▶ buildShotRecipe(brand, opts)
 *
 * The whole point: everything BEFORE the spec is cheap analysis; everything
 * AFTER it is paid generation the user already approved. The edit gate is
 * where trust (and the subscription) is earned.
 *
 * Legal guardrail baked into the type system: a beat carries STRUCTURE
 * (role, intent, duration, hookType) and the USER'S regenerated copy — never
 * the competitor's transcript text, assets, or voice. `sourceFingerprint`
 * stores only a non-reproducible hash + classification so we can prove
 * "structure, not content".
 */

const crypto = require('crypto');

// ── Controlled vocabularies (the taxonomy = the IP) ─────────────────────────

const AD_STRUCTURES = [
  'hook_problem_solution',     // classic DR
  'problem_agitate_solve',     // PAS
  'hook_demo_cta',             // product-forward
  'testimonial',               // social proof led
  'founder_story',             // narrative
  'before_after',              // transformation
  'ugc_review',                // creator review
  'listicle',                  // "3 reasons…"
  'announcement',              // launch / offer
];

const BEAT_ROLES = [
  'hook', 'problem', 'agitation', 'solution',
  'demo', 'proof', 'benefit', 'reveal', 'result', 'cta',
];

const HOOK_TYPES = [
  'question', 'pain', 'curiosity_gap', 'shock',
  'statistic', 'story', 'contrast', 'pattern_interrupt',
];

const TRIGGERS = [
  'FOMO', 'status', 'fear', 'convenience',
  'aspiration', 'urgency', 'social_proof', 'curiosity', 'value',
];

// Map an ad-structure → the template recipe key your engine already ships.
// This is the ONLY place the spec touches your TEMPLATE_RECIPES keys, so when
// you add a template you add one line here, nothing else changes.
const STRUCTURE_TO_TEMPLATE = {
  hook_problem_solution: 'user_demo',
  problem_agitate_solve:  'user_demo',
  hook_demo_cta:          'white_studio',
  testimonial:            'testimonial',
  founder_story:          'street_interview',
  before_after:           'creator_review',
  ugc_review:             'creator_review',
  listicle:               'viral_story',
  announcement:           'cinematic_trailer',
};

// Per-role default duration (seconds). Engine clamps to 3–5 anyway; this just
// makes the *draft* sane before the user touches it.
const ROLE_DEFAULT_SEC = {
  hook: 3, problem: 4, agitation: 3, solution: 4,
  demo: 5, proof: 4, benefit: 3, reveal: 4, result: 4, cta: 3,
};

// ── Fingerprint: prove "structure not content", store nothing reproducible ──

function fingerprintSource({ competitor, transcript, structure }) {
  // We hash the transcript so we can dedupe / audit WITHOUT storing the
  // competitor's actual words. The hash is one-way; the stored classification
  // is our own derived structure.
  const h = crypto
    .createHash('sha256')
    .update(String(transcript || ''))
    .digest('hex')
    .slice(0, 16);
  return {
    competitor: competitor || null,     // public brand name is fine
    transcriptHash: h,                  // NOT the transcript itself
    detectedStructure: structure || null,
    derivedAt: new Date().toISOString(),
  };
}

// ── Factory: build a clean draft spec ───────────────────────────────────────

/**
 * makeBeat — one editable unit. `userCopy` is the ONLY text rendered; it's the
 * user's brand voice, generated for them, never the competitor's line.
 */
function makeBeat({ role, hookType = null, intent = '', userCopy = '', durationSec, overlay = null }) {
  const r = BEAT_ROLES.includes(role) ? role : 'demo';
  return {
    id: crypto.randomUUID(),
    role: r,
    hookType: r === 'hook' ? (HOOK_TYPES.includes(hookType) ? hookType : 'curiosity_gap') : null,
    intent: String(intent || ''),          // director note: WHY this beat exists
    userCopy: String(userCopy || ''),       // editable on-screen / VO line (user brand)
    durationSec: clampSec(durationSec ?? ROLE_DEFAULT_SEC[r] ?? 4),
    overlay: overlay,                        // 'headline' | 'cta' | null
    // Per-beat asset override. Null → inherit spec-level avatar/product.
    assetRef: null,                          // { kind:'product'|'avatar'|'upload', url }
  };
}

function clampSec(n) {
  const v = Math.round(Number(n) || 4);
  return Math.max(3, Math.min(5, v));
}

/**
 * createDraftSpec — produced by the teardown step (adSpecFromTeardown) OR
 * from scratch. Pure function, no I/O. Everything has a safe default so the
 * editor never sees `undefined`.
 */
function createDraftSpec({
  scanId,
  structure = 'hook_problem_solution',
  aspectRatio = '9:16',
  beats = [],
  triggers = [],
  brand = {},
  avatar = null,
  product = null,
  music = null,
  sourceFingerprint = null,
} = {}) {
  const safeStructure = AD_STRUCTURES.includes(structure) ? structure : 'hook_problem_solution';
  const safeBeats = (beats.length ? beats : defaultBeatsFor(safeStructure)).map(makeBeat);

  return {
    version: 1,
    specId: crypto.randomUUID(),
    scanId: scanId || null,
    status: 'draft',                  // draft → confirmed → rendering → ready
    structure: safeStructure,
    templateKey: STRUCTURE_TO_TEMPLATE[safeStructure] || 'user_demo',
    aspectRatio,
    triggers: triggers.filter((t) => TRIGGERS.includes(t)),

    // Brand block — seeded from scan.brand / brandPalette / confirmedBrand.
    brand: {
      name: brand.name || 'Your brand',
      category: brand.category || '',
      palette: Array.isArray(brand.palette) ? brand.palette.slice(0, 6) : [],
      logoUrl: brand.logoUrl || null,
    },

    // The two anchors that lock consistency across Wan shots.
    avatar,   // { id, source:'library'|'upload', previewCoverUrl } | null
    product,  // { url, title?, price? } | null  ← anchors every i2v shot

    music,    // { url, mood } | null

    // Global copy the editor surfaces at the top of the page.
    headline: '',
    cta: 'Learn more',

    beats: safeBeats,

    // Audit / legal: structure-not-content proof.
    sourceFingerprint: sourceFingerprint || null,

    // Analytics: which fields the user edited (tells you which extractor to
    // trust least — same idea as confirmedBrand.edits).
    edits: {},

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Reasonable beat skeletons per structure (draft only; user reshapes freely).
function defaultBeatsFor(structure) {
  const B = (role, intent, overlay = null, hookType = null) =>
    ({ role, intent, overlay, hookType });
  switch (structure) {
    case 'problem_agitate_solve':
      return [
        B('hook', 'Stop the scroll with the core frustration', 'headline', 'pain'),
        B('agitation', 'Twist the knife — what it costs them'),
        B('solution', 'Introduce the product as the relief'),
        B('cta', 'Tell them exactly what to do next', 'cta'),
      ];
    case 'hook_demo_cta':
      return [
        B('hook', 'Bold product-forward open', 'headline', 'curiosity_gap'),
        B('demo', 'Show the product doing its job'),
        B('cta', 'Clear next step', 'cta'),
      ];
    case 'testimonial':
      return [
        B('hook', 'Real customer opens with their result', 'headline', 'story'),
        B('proof', 'Specific believable benefit'),
        B('cta', 'Invite the viewer to get the same', 'cta'),
      ];
    case 'before_after':
      return [
        B('problem', 'The "before" state', 'headline', 'contrast'),
        B('reveal', 'The transformation moment'),
        B('result', 'The "after" payoff', 'cta'),
      ];
    case 'hook_problem_solution':
    default:
      return [
        B('hook', 'Grab attention in the first 2 seconds', 'headline', 'question'),
        B('problem', 'Name the pain they feel'),
        B('solution', 'Position product as the fix'),
        B('cta', 'Drive the action', 'cta'),
      ];
  }
}

// ── Validation (no external deps; mirrors your handleErr error codes) ────────

function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['spec_missing'];
  if (!AD_STRUCTURES.includes(spec.structure)) errors.push('bad_structure');
  if (!Array.isArray(spec.beats) || spec.beats.length < 2) errors.push('need_min_2_beats');
  if (spec.beats?.length > 7) errors.push('max_7_beats');
  (spec.beats || []).forEach((b, i) => {
    if (!BEAT_ROLES.includes(b.role)) errors.push(`beat_${i}_bad_role`);
    if (b.durationSec < 3 || b.durationSec > 5) errors.push(`beat_${i}_bad_duration`);
  });
  // Product anchor is mandatory for video — your renderVideoAd already throws
  // without it; fail earlier here so the editor can prompt for it.
  if (!spec.product?.url && !spec.brand?.logoUrl) {
    errors.push('missing_product_anchor');
  }
  return errors;
}

function isConfirmable(spec) {
  return validateSpec(spec).length === 0;
}

// ── THE LOWERING: adSpec → opts your buildShotRecipe already accepts ─────────

/**
 * adSpecToRecipeOpts — deterministic, no I/O. Produces exactly the `opts`
 * object that buildShotRecipe(brand, opts, deps) consumes, plus the avatarBrief
 * shape renderVideoAd/resolveShotClips expect.
 *
 * Critically: it preserves PER-BEAT copy, duration, and overlay so the user's
 * edits actually survive into the render. The engine's scaleShots() is bypassed
 * because the spec already defines the exact beat list the user approved — we
 * pass shotCount = beats.length and let durations flow through.
 */
function adSpecToRecipeOpts(spec) {
  const headline = spec.headline || firstOverlayText(spec, 'headline') || spec.brand?.name || '';
  const cta = spec.cta || firstOverlayText(spec, 'cta') || 'Learn more';

  return {
    // maps straight onto buildShotRecipe opts
    templateKey: spec.templateKey,
    headline,
    cta,
    shotCount: spec.beats.length,
    durationSec: spec.beats.reduce((s, b) => s + b.durationSec, 0),
    aspectRatio: spec.aspectRatio,
    productImageUrl: spec.product?.url || null,
    competitorPosterUrl: undefined,          // NEVER feed competitor assets to i2v
    avatarBrief: avatarBriefFromSpec(spec),
    audio: spec.music?.url || false,
    startImageUrl: spec.assetRefs?.[0]?.url || spec.product?.url || undefined,
    brandName: spec.brand?.name || '',       // ← spec brand, not scan brand

    // Per-beat director data — consumed by buildShotRecipe when present.
    __specBeats: spec.beats.map((b) => {
      // All image URLs attached to this beat: edited frames + product refs (up to 4 for Wan)
      const beatAssetUrls = [
        ...(Array.isArray(b.assetRefs) ? b.assetRefs.map((r) => r.url).filter(Boolean) : []),
        ...(b.assetRef?.url ? [b.assetRef.url] : []),
      ].filter(Boolean).slice(0, 4);
      return {
        role: b.role,
        hookType: b.hookType || null,
        durationSec: b.durationSec,
        overlay: b.overlay
          ? { kind: b.overlay, text: b.overlay === 'cta' ? cta : (b.userCopy || headline) }
          : null,
        userCopy: b.userCopy || '',
        beatPrompt: b.beatPrompt || null,
        beatAssetUrls,
      };
    }),
  };
}

// resolveShotClips expects avatarBrief?.preset?.previewCoverUrl
function avatarBriefFromSpec(spec) {
  if (!spec.avatar) return {};
  return {
    preset: { previewCoverUrl: spec.avatar.previewCoverUrl || null },
    avatarThumbUrl: spec.avatar.previewCoverUrl || null,
    avatarId: spec.avatar.id || null,
    source: spec.avatar.source || 'library',
  };
}

function firstOverlayText(spec, kind) {
  const b = (spec.beats || []).find((x) => x.overlay === kind);
  return b ? b.userCopy : null;
}

// ── Seed a draft straight from an existing scan (no teardown yet) ────────────

/**
 * specFromScan — convenience for the "generate from my own brand" path that
 * doesn't start from a competitor. Pulls brand/palette/product from the scan
 * document shape you already persist (UrlToAdsScan).
 */
function specFromScan(scan, { structure, aspectRatio } = {}) {
  const palette = (scan?.brandPalette?.swatches || [])
    .map((s) => s?.hex).filter(Boolean).slice(0, 6);
  const productUrl =
    scan?.brand?.images?.[0] ||
    (Array.isArray(scan?.sourceImageUrls) ? scan.sourceImageUrls[0] : null) ||
    null;

  return createDraftSpec({
    scanId: String(scan?._id || ''),
    structure: structure || 'hook_problem_solution',
    aspectRatio: aspectRatio || '9:16',
    brand: {
      name: scan?.confirmedBrand?.name || scan?.brand?.name,
      category: scan?.confirmedBrand?.category || scan?.brand?.category,
      palette: (scan?.confirmedBrand?.palette?.length ? scan.confirmedBrand.palette : palette),
      logoUrl: scan?.brand?.logoUrl || null,
    },
    product: productUrl ? { url: productUrl } : null,
  });
}

module.exports = {
  // vocab
  AD_STRUCTURES, BEAT_ROLES, HOOK_TYPES, TRIGGERS, STRUCTURE_TO_TEMPLATE,
  // factory
  createDraftSpec, makeBeat, defaultBeatsFor, specFromScan,
  // validation
  validateSpec, isConfirmable,
  // lowering
  adSpecToRecipeOpts, avatarBriefFromSpec,
  // audit
  fingerprintSource,
};