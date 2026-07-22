'use strict';

/**
 * generateCreativeFromStudio
 *
 * Single-creative authorship path for the Studio panel (Seedance 2.0
 * ref2vid, gpt-image-2, Kling O3, etc). This is the OTHER route alongside
 * generatePerProductAds — they share enqueueAdSet but differ in intent:
 *
 *   generatePerProductAds      → product-grid fan-out, N blueprints from catalog
 *   generateCreativeFromStudio → ONE hand-authored creative, full provider control
 *
 * Why separate: the Studio panel sends a fully-formed `providerInput` built
 * from the model's manifest. Feeding that through the per-product path
 * forces buildAdBlueprintForProduct to rewrite the prompt and drop refs,
 * which is exactly what we don't want.
 */

const { z } = require('zod');
const UrlToAdsScan = require('../model/schema/urlToAdsScan');
const adSetService = require('./adSetService');
const { getSessionId, getUserId, ownerFromReq } = require('../lib/owner');
const { validateReferenceUrl } = require('./referenceUrlGate');

// ─── Schema ───────────────────────────────────────────────────────────────
// Mirrors what the Studio panel sends. Everything optional except scanId,
// modelId, and prompt — providerInput carries the heavy stuff per-manifest.

const shotSchema = z.object({
  prompt: z.string().min(1).max(4000),
  duration: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

const endCardSchema = z.object({
  copy: z.string().max(200).optional(),
  logoUrl: z.string().url().optional(),
  brandName: z.string().max(120).optional(),
  handle: z.string().max(80).optional(),
  paletteHex: z.string().max(16).optional(),
  durationSec: z.number().int().min(1).max(5).optional().default(2),
}).strict();

const comboVideoSchema = z.object({
  enabled: z.boolean().default(false),
  targetDurationSec: z.number().int().min(10).max(60).optional(),
  segments: z.array(z.object({
    prompt: z.string().min(1).max(4000),
    durationSec: z.number().int().min(3).max(15),
    referenceImageUrl: z.string().url().optional(),
  })).min(2).max(4).optional(),
}).strict();

const studioCreativeSchema = z.object({
  scanId: z.string().min(1),

  // Provider routing
  modelId: z.string().min(1).max(120),
  kind: z.enum(['image', 'video']).default('video'),

  // The flat prompt (multi-shot mode collapses to a single annotated string
  // here; the structured shot array also rides on `multiShot` for the
  // worker to honor model-specific multi-prompt fields).
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(4000).optional(),

  // Provider-shaped payload built by the frontend from the model manifest.
  // We DO NOT re-validate slot-by-slot here — the manifest already did it
  // in the UI and falPayloadSanitizer will catch garbage downstream. We
  // only validate URLs (SSRF gate) and asset counts.
  providerInput: z.record(z.string(), z.unknown()).optional(),

  // Multi-shot wire format — ordered array of {prompt, duration} per shot.
  // Only meaningful when the manifest supports multi-shot (Kling V3, etc).
  multiShot: z.array(shotSchema).max(8).optional(),

  // Brand/context — used for ad copy generation and end card composite.
  brandName: z.string().max(240).optional(),
  targetAudience: z.string().max(400).optional(),
  category: z.string().max(120).optional(),
  locale: z.string().max(40).optional().default('global'),
  aspectRatio: z.string().max(10).optional().default('9:16'),
  durationSec: z.coerce.number().int().min(3).max(15).optional().default(10),
  resolution: z.enum(['480p', '720p', '1080p']).optional().default('720p'),

  // Post-processing pipeline — composite end card, stitch combo, etc.
  postProcess: z.object({
    addEndCard: z.boolean().optional(),
    endCard: endCardSchema.optional(),
    comboVideo: comboVideoSchema.optional(),
  }).strict().optional(),

  // Generate ad copy via Haiku alongside the render.
  generateCopy: z.boolean().optional().default(true),

  // Free-form passthrough — avatarBrief, sourceTool, etc.
  extras: z.record(z.string(), z.unknown()).optional(),
});

// ─── URL fields that need SSRF validation ─────────────────────────────────
// providerInput keys we know carry public URLs. Anything URL-shaped here
// gets gated. We don't reject on unknown keys — we just don't gate them.
const URL_FIELDS_SINGLE = ['image_url', 'end_image_url', 'reference_image_url'];
const URL_FIELDS_ARRAY  = ['image_urls', 'video_urls', 'audio_urls', 'reference_image_urls'];

async function validateAllReferenceUrls(providerInput) {
  if (!providerInput) return;

  for (const k of URL_FIELDS_SINGLE) {
    const v = providerInput[k];
    if (typeof v === 'string' && v) {
      const r = await validateReferenceUrl(v);
      if (!r.ok) {
        const err = new Error(`Reference URL rejected (${k}): ${r.reason}`);
        err.code = 'ref_url_blocked';
        throw err;
      }
      providerInput[k] = r.url;
    }
  }

  for (const k of URL_FIELDS_ARRAY) {
    const arr = providerInput[k];
    if (Array.isArray(arr)) {
      const out = [];
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i];
        if (typeof v !== 'string' || !v) continue;
        const r = await validateReferenceUrl(v);
        if (!r.ok) {
          const err = new Error(`Reference URL rejected (${k}[${i}]): ${r.reason}`);
          err.code = 'ref_url_blocked';
          throw err;
        }
        out.push(r.url);
      }
      providerInput[k] = out;
    }
  }
}

// ─── Reference total cap (mirrors frontend constraint sum_max=12) ─────────
function enforceReferenceCap(providerInput, cap = 12) {
  if (!providerInput) return;
  const counts = {
    images: Array.isArray(providerInput.image_urls) ? providerInput.image_urls.length : 0,
    videos: Array.isArray(providerInput.video_urls) ? providerInput.video_urls.length : 0,
    audios: Array.isArray(providerInput.audio_urls) ? providerInput.audio_urls.length : 0,
  };
  const total = counts.images + counts.videos + counts.audios;
  if (total > cap) {
    const err = new Error(`Total references ${total} exceeds cap ${cap} (images:${counts.images} videos:${counts.videos} audios:${counts.audios})`);
    err.code = 'reference_cap_exceeded';
    throw err;
  }
}

// ─── Brand context injection ──────────────────────────────────────────────
// We DON'T rewrite the user's prompt — they authored it deliberately. But
// we DO append a small brand context tail if missing, so ad copy generation
// and the end card composite have something to work with.
function attachBrandContext(prompt, scan) {
  const brand = scan.brand || {};
  // Only inject if the user didn't already mention the brand name
  if (brand.name && !prompt.toLowerCase().includes(String(brand.name).toLowerCase())) {
    return `${prompt}\n\nBrand context (do not render as on-screen text): ${brand.name}${brand.category ? `, ${brand.category}` : ''}.`;
  }
  return prompt;
}

// ─── Main service ─────────────────────────────────────────────────────────

async function generateCreativeFromStudio({ req, body }) {
  const parsed = studioCreativeSchema.parse(body);
    
    const id = req.params.id;
  // ── Ownership check ─────────────────────────────────────────────────
  const scan = await UrlToAdsScan.findById(id);
  if (!scan) {
    const err = new Error('Scan not found');
    err.code = 'not_found';
    throw err;
  }

  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isAdmin = (req?.user?.role || '').toLowerCase() === 'admin';
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || isAdmin;
  if (!isOwner) {
    const err = new Error('forbidden');
    err.code = 'forbidden';
    throw err;
  }

  // if (scan.status !== 'ready' && scan.status !== 'partial') {
  //   const err = new Error(`Scan is ${scan.status}; can't generate yet.`);
  //   err.code = 'scan_not_ready';
  //   throw err;
  // }

  // ── Validate every reference URL before it leaves our process ───────
  await validateAllReferenceUrls(parsed.providerInput);
  enforceReferenceCap(parsed.providerInput);

  // ── Compose final prompt — brand context tail only ──────────────────
  const finalPrompt = attachBrandContext(parsed.prompt, scan);

  // ── Build the inputs payload for enqueueAdSet ───────────────────────
  // The shape enqueueAdSet's adSetInputSchema expects, with `providerInput`
  // and `multiShot` riding through `inputs.providerInput` / extras so
  // modelRouter.route() can hand the manifest-built payload straight to
  // falPayloadSanitizer.
  const inputs = {
    prompt: finalPrompt,
    negativePrompt: parsed.negativePrompt,
    kind: parsed.kind,
    numVariants: 1, // Studio panel = single creative. Variants come from re-running.
    aspectRatio: parsed.aspectRatio,
    durationSec: parsed.kind === 'video' ? parsed.durationSec : 0,
    resolution: parsed.resolution,
    brandName: parsed.brandName || scan.brand?.name || '',
    targetAudience: parsed.targetAudience || scan.audience?.primary || '',
    category: parsed.category || scan.brand?.category || '',
    locale: parsed.locale,
    modelId: parsed.modelId,
    generateCopy: parsed.generateCopy,

    // Reference frame URLs — also surfaced at top level for legacy paths
    // that read them off `inputs` directly.
    referenceImageUrl: parsed.providerInput?.image_url
      || parsed.providerInput?.image_urls?.[0]
      || undefined,
    endFrameUrl: parsed.providerInput?.end_image_url || undefined,

    // The manifest-built provider payload. modelRouter reads this via
    // inputs?.providerInput and passes it to the worker untouched.
    providerInput: parsed.providerInput || {},

    extras: {
      ...(parsed.extras || {}),
      sourceTool: 'studio_panel',
      isStudioCreative: true,
      // Multi-shot rides on extras — adSetService doesn't know about it
      // structurally, but the worker pulls it from extras.multiShot and
      // formats per provider (Kling V3 multi_prompt[], Seedance shot list).
      ...(parsed.multiShot && parsed.multiShot.length > 0
        ? { multiShot: parsed.multiShot }
        : {}),
      // Post-process pipeline — end card + combo stitch. Same key the
      // post-render worker reads.
      ...(parsed.postProcess
        ? { postProcess: parsed.postProcess }
        : {}),
    },
  };

  // ── Enqueue via the shared service ──────────────────────────────────
  const { adSetId, childJobIds, totalCreditsCost } = await adSetService.enqueueAdSet({ req, inputs });

  // ── Stamp the scan with the new ad set so the UI can poll it ────────
  const studioCreative = {
    adSetId,
    modelId: parsed.modelId,
    kind: parsed.kind,
    durationSec: parsed.durationSec,
    aspectRatio: parsed.aspectRatio,
    isComboVideo: !!parsed.postProcess?.comboVideo?.enabled,
    createdAt: new Date(),
  };

  scan.studioCreatives = Array.isArray(scan.studioCreatives) ? scan.studioCreatives : [];
  scan.studioCreatives.push(studioCreative);
  scan.adSetId = adSetId; // most-recent for the existing UI poll path
  scan.status = 'rendering';
  await scan.save();

  return {
    scan,
    adSetId,
    childJobIds,
    totalCreditsCost,
  };
}

module.exports = {
  generateCreativeFromStudio,
  studioCreativeSchema, // exported for tests
};