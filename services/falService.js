'use strict';

/**
 * falService.js — v2
 *
 * CHANGED: every call to fal.subscribe() now runs through falPayloadSanitizer
 * FIRST. That kills the Unprocessable Entity (422) errors you're seeing.
 *
 * WHAT WAS BROKEN:
 *   - generateVideo sent `resolution: '1080p'` and `motion_bucket_id: 127` to
 *     Kling, which doesn't accept those fields → 422.
 *   - generateImage sent `image_url` + `image_urls` + `image_size` to
 *     flux/dev/image-to-image, which doesn't accept `image_size` → 422.
 *   - Nothing validated that `duration` was "5" or "10" (Kling refuses "7",
 *     "8", etc.) → 422.
 *
 * WHAT CHANGES FOR CALLERS: nothing. The public API is identical.
 */

const { fal } = require('@fal-ai/client');
const { sanitize, listDroppedFields } = require('./falPayloadSanitizer');

const DEBUG = process.env.STUDIO_DEBUG === 'true';



const THIRD_PARTY_NAMESPACES = [
  'bytedance/', 'alibaba/', 'tencent/', 'kuaishou/', 'minimax/',
  'openai/', 'google/', 'stability-ai/', 'meta/', 'kwaivgi/',
  'runwayml/', 'black-forest-labs/',
];


let _falConfigured = false;
function assertFalConfigured() {
  const key = process.env.FAL_API_KEY || process.env.FAL_KEY;
  if (!key) {
    throw new FalGenerationError(
      'fal.ai is not configured on this server. Set FAL_API_KEY in qumak-backend/.env (https://fal.ai/dashboard/keys) and restart the API.',
      'FAL_AUTH_MISSING', false,
    );
  }
  if (!_falConfigured) {
    fal.config({ credentials: key });
    _falConfigured = true;
  }
}

function translateFalError(err, falModelId) {
  const raw = err?.message || String(err) || '';
  const detail = err?.body?.detail || '';
  const lower = `${raw} ${detail}`.toLowerCase();

  // 422 Unprocessable Entity — almost always a schema mismatch. Give the
  // operator enough context to fix it (which model, what we sent).
  if (lower.includes('unprocessable') || lower.includes('422')) {
    const hint = falModelId
      ? ` Model '${falModelId}' rejected the payload. Check services/falPayloadSanitizer.js for the expected schema.`
      : '';
    return new FalGenerationError(
      `fal.ai rejected the input (422 Unprocessable Entity).${hint}`,
      'FAL_SCHEMA_MISMATCH', false,
    );
  }
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('forbidden') || lower.includes('403')) {
    // Distinguish "API key is rejected" from "API key is fine but this model
    // is paywalled for your account" — they're very different fixes.
    // Fal's 401 body for paywalled models reads:
    //   'Cannot access application "fal-ai/<slug>". Authentication is required…'
    const isPaywalled = /cannot access application/i.test(detail);
    if (isPaywalled) {
      return new FalGenerationError(
        `fal.ai denied access to '${falModelId}' for this account. ` +
        `The model is likely paid-only or private. Pick a different model ` +
        `or top up credits at https://fal.ai/dashboard/billing.`,
        'FAL_MODEL_FORBIDDEN', false,
      );
    }
    return new FalGenerationError(
      'fal.ai rejected the API key. Double-check FAL_API_KEY in qumak-backend/.env and restart the API.',
      'FAL_AUTH_REJECTED', false,
    );
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return new FalGenerationError('fal.ai rate-limited this request — please retry in a few seconds.', 'FAL_RATE_LIMITED', true);
  }
  if (lower.includes('timeout') || lower.includes('econnreset')) {
    return new FalGenerationError('fal.ai timed out — please retry.', 'FAL_TIMEOUT', true);
  }
  if (lower.includes('not found') || lower.includes('404')) {
    return new FalGenerationError(
      `fal.ai could not find model '${falModelId}'. It may be retired — re-run 'npm run seed:models' after pulling the latest backend.`,
      'FAL_MODEL_NOT_FOUND', false,
    );
  }
  return null;
}

// NOTE: Fal retired `v2.5-turbo/standard` and `v2/*` — the live "cheap free
// tier" video slugs as of Apr 2026 (verified against scripts/data/fal-catalog.md)
// are v1.6/standard and v2.5-turbo/pro. We keep the pro variant for paid tiers
// and use v1.6/standard everywhere else so the pipeline keeps working on free
// accounts.
const MODELS = {
  VIDEO_STANDARD:  'fal-ai/kling-video/v1.6/standard/text-to-video',
  VIDEO_PRO:       'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
  VIDEO_I2V:       'fal-ai/kling-video/v1.6/standard/image-to-video',
  VIDEO_I2V_PRO:   'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
  VIDEO_UPSCALER:  'fal-ai/video-upscaler',
  IMAGE_FAST:      'fal-ai/flux/schnell',
  IMAGE_LIFESTYLE: 'fal-ai/flux-pro',
  IMAGE_I2I:       'fal-ai/flux/dev/image-to-image',
  IMAGE_EDIT:      'fal-ai/flux-pro/kontext',
};


/**
 * falService.js — PATCH for normalizeFalSlug + FALLBACK_ON_FORBIDDEN
 *
 * Replace the existing normalizeFalSlug function and FALLBACK_ON_FORBIDDEN
 * map in services/falService.js with these versions.
 *
 * WHAT WAS BROKEN:
 *   `bytedance/seedance-2.0/reference-to-video` is fal's actual route
 *   (third-party hosted, NOT under fal-ai/ namespace). The old normalizer
 *   blindly prepended `fal-ai/` → 404 "model not found".
 *
 *   `alibaba/happy-horse/reference-to-video` has the same problem.
 *
 * WHAT'S FIXED:
 *   We now leave bare third-party namespaces alone. fal-ai/ slugs stay as-is.
 *   Anything else (legacy DB rows like `kling-video/v1.6/...`) gets the
 *   prefix prepended for backward compat.
 *
 * To ship: open services/falService.js, find these two top-level constants
 * + function, and replace them with these versions. Nothing else changes.
 */
 
// Third-party namespaces fal.ai exposes WITHOUT the fal-ai/ prefix.
// Verified May 2026 against the live OpenAPI catalog. Add to this list as
// new providers come online — fal.ai's convention is bare-namespace for
// external partners (Bytedance/ByteDance Seedance, Alibaba/Wan, etc.) and
// `fal-ai/` for in-house pipelines.

 
function normalizeFalSlug(slug) {
  if (!slug) return slug;
  const trimmed = String(slug).trim();
  if (trimmed.startsWith('fal-ai/')) return trimmed;
  if (THIRD_PARTY_NAMESPACES.some((ns) => trimmed.startsWith(ns))) return trimmed;
  // Legacy bare slug → assume it's a fal-ai/ in-house model
  return `fal-ai/${trimmed}`;
}
 
// Update the fallback table to use the CORRECT bare slugs as keys.
// (The values stay fal-prefixed because Kling/Flux ARE in-house fal models.)
const FALLBACK_ON_FORBIDDEN = {
  // Seedance 2.0 — bare namespace
  'bytedance/seedance-2.0/text-to-video':                 'fal-ai/kling-video/v1.6/standard/text-to-video',
  'bytedance/seedance-2.0/fast/text-to-video':            'fal-ai/kling-video/v1.6/standard/text-to-video',
  'bytedance/seedance-2.0/image-to-video':                'fal-ai/kling-video/v1.6/standard/image-to-video',
  'bytedance/seedance-2.0/fast/image-to-video':           'fal-ai/kling-video/v1.6/standard/image-to-video',
  'bytedance/seedance-2.0/reference-to-video':            'fal-ai/kling-video/v1.6/standard/text-to-video',
  // Happy Horse + Wan
  'alibaba/happy-horse/reference-to-video':               'fal-ai/kling-video/v1.6/standard/text-to-video',
  // Old retired Kling endpoints (still in some seeds)
  'fal-ai/kling-video/v2.5-turbo/standard/text-to-video':  'fal-ai/kling-video/v1.6/standard/text-to-video',
  'fal-ai/kling-video/v2.5-turbo/standard/image-to-video': 'fal-ai/kling-video/v1.6/standard/image-to-video',
  'fal-ai/kling-video/v2/standard/text-to-video':          'fal-ai/kling-video/v1.6/standard/text-to-video',
  'fal-ai/kling-video/v2/pro/text-to-video':               'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
};


const MODEL_COSTS = {
  // ── VIDEO (per-second, 720p) ──
  'bytedance/seedance-2.0/fast/image-to-video':      { perSec: 0.2419 },              // no ref
  'bytedance/seedance-2.0/fast/reference-to-video':  { perSec: 0.2419, perSecRef: 0.1452 }, // ref discount
  'bytedance/seedance-2.0/image-to-video':           { perSec: 0.3024 },              // standard (gated)
  'bytedance/seedance-2.0/reference-to-video':       { perSec: 0.3024, perSecRef: 0.1814 },
  'fal-ai/kling-video/v3/pro/image-to-video':        { perSec: 0.112, perSecAudio: 0.168 },
  'fal-ai/kling-video/o3/4k/image-to-video':         { perSec: 0.30 }, // DEACTIVATE — placeholder until confirmed
  'fal-ai/kling-video/o3/4k/reference-to-video':      { perSec: 0.30, perSecRef: 0.20 },
  // ── IMAGE (per image) ──
  'fal-ai/flux/schnell':                             { perImage: 0.003 },
  'fal-ai/flux-pro':                                 { perImage: 0.05 },
  'fal-ai/flux/dev/image-to-image':                  { perImage: 0.025 },
  'fal-ai/flux-pro/kontext':                         { perImage: 0.05 },
  'openai/gpt-image-2/edit':                         { perImageMedium: 0.061, perImageHigh: 0.219 },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image': { perImage: 0.035 },
  // nano banana, seedream — add real fal slugs + costs
};

const COST_DEFAULT = { perSec: 0.35, perImage: 0.06 }; // pessimistic, not optimistic

// const MODEL_COSTS = {
//   [MODELS.VIDEO_STANDARD]:  { per5s: 0.21, per10s: 0.42 },
//   [MODELS.VIDEO_PRO]:       { per5s: 0.35, per10s: 0.70 },
//   [MODELS.VIDEO_I2V]:       { per5s: 0.21, per10s: 0.42 },
//   [MODELS.VIDEO_I2V_PRO]:   { per5s: 0.35, per10s: 0.70 },
//   [MODELS.VIDEO_UPSCALER]:  { flat: 0.10 },
//   [MODELS.IMAGE_FAST]:      { perImage: 0.003 },
//   [MODELS.IMAGE_LIFESTYLE]: { perImage: 0.05 },
//   [MODELS.IMAGE_I2I]:       { perImage: 0.03 },
//   [MODELS.IMAGE_EDIT]:      { perImage: 0.04 },
// };

class FalGenerationError extends Error {
  constructor(message, code, isRetryable = false) {
    super(message);
    this.name = 'FalGenerationError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

// ─── Core wrapper — ALL fal.subscribe calls go through this ────────────────
async function callFal(
  falModelId,
  rawInput,
  { onQueueUpdate, logs = false, allowFallback = true } = {},
) {
  // 1. Make sure the SDK has credentials. Previously this was commented out
  //    in generateVideo, so if a video was the first fal call after a restart
  //    every single request came back 401.
  assertFalConfigured();

  // 2. Normalize the slug. DB seeds have a mix of `fal-ai/…` and bare forms;
  //    Fal only accepts the prefixed form.
  const resolvedSlug = normalizeFalSlug(falModelId);
  // 3. Sanitize BEFORE hitting the wire. Look up the schema on either form
  //    of the slug so we don't lose the whitelist when we prepended fal-ai/.
  let cleanInput;
  try {
    console.log(rawInput,'rawInput');
    cleanInput = sanitize(falModelId, rawInput);
  } catch (err) {
    // Sanitizer throws for missing required fields (e.g. img2img without
    // image_url). That's a hard programming error — surface it as such.
    throw new FalGenerationError(
      `Payload invalid for '${falModelId}': ${err.message}`,
      'FAL_INPUT_INVALID', false,
    );
  }
  
  if (DEBUG) {
    const dropped = listDroppedFields(falModelId, rawInput);
    if (dropped.length) {
      console.log(`[falService] Dropped unsupported fields for ${resolvedSlug}:`, dropped);
    }
    console.log(`[falService] Calling ${resolvedSlug} with:`, JSON.stringify(cleanInput, null, 2));
  }
  console.log('[SCHEMA IN]', JSON.stringify({
    duration: rawInput.duration,
    generate_audio: rawInput.generate_audio
  }));
  console.log('[FAL PAYLOAD]', resolvedSlug, (cleanInput));

  try {
    const result = await fal.subscribe(resolvedSlug, {
      input: cleanInput,
      logs,
      ...(onQueueUpdate ? { onQueueUpdate } : {}),
    });
    if (result && typeof result === 'object') result.__modelUsed = resolvedSlug;
    console.log('[FAL RESULT]', result);
    return result;
  } catch (err) {
    const translated = translateFalError(err, resolvedSlug);

    const isForbidden =
      translated?.code === 'FAL_MODEL_FORBIDDEN' ||
      translated?.code === 'FAL_MODEL_NOT_FOUND';

    if (allowFallback && isForbidden) {
      const fallback =
        FALLBACK_ON_FORBIDDEN[resolvedSlug] ||
        FALLBACK_ON_FORBIDDEN[falModelId];
      if (fallback && fallback !== resolvedSlug) {
        console.warn(
          `[falService] '${resolvedSlug}' forbidden for this account — ` +
          `falling back to '${fallback}'.`,
        );
        return callFal(fallback, rawInput, {
          onQueueUpdate,
          logs,
          allowFallback: false,
        });
      }
    }

    if (translated) throw translated;
    throw new FalGenerationError(
      `fal.ai call failed: ${err.message}`,
      'FAL_API_ERROR', false,
    );
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

async function generateVideo({
  prompt, negativePrompt, input, aspectRatio = '16:9', duration = 5, tier = 'free',
  onProgress, falModelId, referenceImageUrl, endFrameUrl, resolution, motion,modelId,
}) {


 
  let model = falModelId;
  if (!model) {
    const isPaid = tier === 'pro' || tier === 'agency';
    if (referenceImageUrl) model = isPaid ? MODELS.VIDEO_I2V_PRO : MODELS.VIDEO_I2V;
    else                   model = isPaid ? MODELS.VIDEO_PRO     : MODELS.VIDEO_STANDARD;
  }

  // providerInput = sanitizeVideoInput(falModelId, providerInput);
  const seed = Math.floor(Math.random() * 2147483647);

// ── ENVELOPE-FIRST ──────────────────────────────────────────────────────
  // If modelRouter already built a manifest-correct, provider-keyed payload,
  // USE IT. This is what makes Seedance / Kling / Wan all work without
  // per-model branches here. The legacy builder below is the fallback only.
  let rawInput;
  if (input && Object.keys(input).length) {
    rawInput = { ...input,seed:seed };
    // Belt-and-suspenders: ensure prompt is present (some manifests omit it
    // from providerInput because the controller injects it late).
    if (!rawInput.prompt && prompt) rawInput.prompt = prompt;
  } else {
    // LEGACY Kling-shaped builder (old jobs, retries, or callers that bypass
    // modelRouter). The sanitizer strips whatever the target model rejects.
    rawInput = {
      prompt,
      negative_prompt: negativePrompt || '',
      aspect_ratio: aspectRatio,
      duration: String(duration),
      cfg_scale: 0.5,
      seed,
      image_url: referenceImageUrl,
      end_image_url: endFrameUrl,
      tail_image_url: endFrameUrl,
      resolution,
      motion,
    };
  }
 

  const startTime = Date.now();
  let lastProgress = 0;

  console.log('rawInput', rawInput,"we go here now ",model,"before callFal");
  const result = await callFal(model, rawInput, {
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === 'IN_PROGRESS' && onProgress) {
        const progress = update.logs?.length
          ? Math.min(95, lastProgress + Math.floor(Math.random() * 10) + 5)
          : lastProgress;
        lastProgress = progress;
        onProgress(progress);
      }
    },
  });

  const generationTimeMs = Date.now() - startTime;

  const effectiveModel = result?.__modelUsed || normalizeFalSlug(model);
  const costs = MODEL_COSTS[effectiveModel] || MODEL_COSTS[model] || COST_DEFAULT;
  const dur = Number(rawInput.duration || duration || 5);
  
  let estimatedCost;
 
  if (costs.perSec != null) {
    const hasRef = !!(rawInput.image_url || rawInput.start_image_url ||
                      (Array.isArray(rawInput.image_urls) && rawInput.image_urls.length) ||
                      (Array.isArray(rawInput.elements) && rawInput.elements.length));
    const audioOn = rawInput.generate_audio === true;
    let rate = costs.perSec;
    if (hasRef && costs.perSecRef != null) rate = costs.perSecRef;
    if (audioOn && costs.perSecAudio != null) rate = Math.max(rate, costs.perSecAudio);
    estimatedCost = +(rate * dur).toFixed(4);
  } else {
    estimatedCost = costs.per5s ?? COST_DEFAULT.perSec * dur; // legacy fallback
  }

  if (!result?.data?.video?.url) {
    throw new FalGenerationError('fal.ai returned no video URL', 'NO_VIDEO_URL', false);
  }
  console.log('result', result,"we go here now ");
  return {
    videoUrl: result.data.video.url,
    thumbnailUrl: result.data.video.thumbnail_url || null,
    seed: result.data.seed ?? rawInput.seed ?? seed,
    requestId: result.requestId,
    generationTimeMs,
    estimatedCost,
    model: effectiveModel,
    requestedModel: model,
  };
}

async function upscaleVideo({ videoUrl, scaleFactor = 2, onProgress }) {
  try {
    assertFalConfigured();
    if (onProgress) onProgress(10);

    const result = await callFal(MODELS.VIDEO_UPSCALER, {
      video_url: videoUrl,
      scale_factor: scaleFactor,
    }, {
      onQueueUpdate: (update) => {
        if (update.status === 'IN_PROGRESS' && onProgress) onProgress(50);
      },
    });

    if (onProgress) onProgress(100);
    return {
      upscaledUrl: result?.data?.video?.url || videoUrl,
      skipped: false,
    };
  } catch (err) {
    console.warn('[falService] upscaleVideo failed (non-fatal):', err.message);
    return { upscaledUrl: videoUrl, skipped: true };
  }
}

async function generateImage({ falModelId, input, modelId }) {
  assertFalConfigured();
  const model = falModelId || MODELS.IMAGE_FAST;

  // `input` comes from modelRouter — we trust its shape but still sanitize
  // because modelRouter doesn't know per-model schemas.
  const result = await callFal(model, input || {});

  const imageUrl =
    result?.data?.images?.[0]?.url ||
    result?.data?.image?.url ||
    result?.images?.[0]?.url;

  if (!imageUrl) throw new FalGenerationError('No image URL returned', 'NO_IMAGE_URL', false);

  return {
    imageUrl,
    estimatedCost: MODEL_COSTS[model]?.perImage ?? 0.01,
    requestId: result?.requestId || null,
    modelId: modelId || null,
  };
}

// Preserved for the legacy /api/v1/images/* endpoints
async function generateProductImage({ prompt, style = 'fast', falModelId, input: providerInput }) {
  assertFalConfigured();
  const model = falModelId || (style === 'lifestyle' ? MODELS.IMAGE_LIFESTYLE : MODELS.IMAGE_FAST);
  const rawInput = providerInput || { prompt, num_images: 1, image_size: 'landscape_16_9' };

  const result = await callFal(model, rawInput);
  const imageUrl =
    result?.data?.images?.[0]?.url ||
    result?.data?.image?.url ||
    result?.images?.[0]?.url;
  if (!imageUrl) throw new FalGenerationError('No image URL returned', 'NO_IMAGE_URL', false);

  return {
    imageUrl,
    estimatedCost: MODEL_COSTS[model]?.perImage ?? 0.01,
    requestId: result?.requestId || null,
    raw: result?.data || null,
  };
}

module.exports = {
  generateVideo,
  upscaleVideo,
  generateProductImage,
  generateImage,
  assertFalConfigured,
  FalGenerationError,
  MODELS,
  MODEL_COSTS,
  // Export callFal for anyone wanting direct access
  _callFal: callFal,
};
