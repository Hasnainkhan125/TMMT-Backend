 // "use strict";

/**
 * modelRouter — given a (template, modelId, inputs), produces the exact
 * provider-call spec the worker needs:
 *
 *   {
 *     provider: 'fal',
 *     falModelId: 'fal-ai/flux/schnell',
 *     input: { ...provider-specific payload... },
 *     creditsCost: 2,
 *     kind: 'image' | 'video',
 *   }
 *
 * Why this lives separately from falService:
 *   - falService is "how do we call fal"
 *   - modelRouter is "which model + what params for THIS template"
 *
 * Keeping them split means we can later add a replicate/openai branch without
 * touching the worker.
 */



const ASPECT_TO_FAL_IMAGE_SIZE = {
  "1:1": "square_hd",
  "4:5": "portrait_4_3",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "4:3": "landscape_4_3",
};

const loadModel = async (modelId) => {
  if (!modelId) throw new Error("modelId_required");
  // Try active first. If an inactive row exists we still want to tell the
  // caller *why* we refused it — that's the difference between "typo" and
  // "your admin disabled this model".
  const active = await AiModel.findOne({ id: modelId, isActive: true }).lean();
  if (active) return active;

  const inactive = await AiModel.findOne({ id: modelId }).lean();
  if (inactive) throw new Error(`model_inactive:${modelId}`);

  throw new Error(`unknown_model:${modelId}`);
};

const buildProviderInput = ({
  model,
  kind,
  prompt,
  negativePrompt,
  aspectRatio,
  durationSec,
  referenceImageUrl,
  endFrameUrl,
  resolution,
  motion,
  seed,
  audio,
}) => {
  if (model.provider !== "fal") {
    return { prompt, negative_prompt: negativePrompt };
  }

  const caps = model.capabilities || {};
  const map = caps.providerParamMap || {};
  const refKey = map.referenceImageUrl || "image_url";
  const endKey = map.endFrameUrl || "end_image_url";
  const durKey = map.duration || "duration";
  const motKey = map.motion || "motion_bucket_id";
  const negKey = map.negativePrompt || "negative_prompt";

  // Helper: write a value under a key that might represent an array field
  // (e.g. `image_urls`). Providers that want array wrap a single URL in [].
  const writeRef = (payload, key, url) => {
    if (!url) return;
    if (key.endsWith("s")) payload[key] = [url];
    else payload[key] = url;
  };

  if (kind === "image") {
    const payload = {
      prompt,
      num_images: 1,
      image_size: ASPECT_TO_FAL_IMAGE_SIZE[aspectRatio] || "square_hd",
    };
    writeRef(payload, refKey, referenceImageUrl);
    if (seed != null) payload.seed = seed;
    return payload;
  }

  const payload = {
    prompt,
    [negKey]: negativePrompt || "",
    aspect_ratio: aspectRatio,
    [durKey]: String(durationSec),
  };
  writeRef(payload, refKey, referenceImageUrl);
  if (endFrameUrl && caps.supportsEndFrame !== false) {
    writeRef(payload, endKey, endFrameUrl);
  }

  const supportedRes = caps.supportedResolutions || [];
  const res = String(resolution || "").toLowerCase();
  if (res && (supportedRes.length === 0 || supportedRes.includes(res))) {
    payload.resolution = res;
  }
  // if (resolution) payload.resolution = resolution;
  if (motion && caps.supportsMotionControl !== false) {
    payload[motKey] = motionToBucket(motion);
  }
  if (seed != null) payload.seed = seed;

  if (audio?.enabled) {
    const mode = String(audio.mode || "native").toLowerCase();
    const aconf = caps.audio || {};
    if (mode === "native" && modelSupportsNativeAudio(model)) {
      const key = aconf.audioParamKey || "generate_audio";
      payload[key] = true;
    }
    if (mode === "upload" && audio.audioUrl && aconf.supportsAudioUrl) {
      const ukey = aconf.audioUrlParamKey || "audio_url";
      payload[ukey] = audio.audioUrl;
    }
  }
  return payload;
};

/**
 * Validate the incoming request against a model's `requiredFields`.
 * Throws a hard error if anything required is missing — caller surfaces it
 * as a 400 so the user knows WHY before we burn credits / provider budget.
 */
/**
 * When the model lists supported video durations, snap the request to the
 * nearest allowed value (tie → shorter). Empty / missing list → use requested as-is.
 */
const snapDurationToSupported = (requested, supported) => {
  const reqN = Number(requested);
  if (!Number.isFinite(reqN) || reqN <= 0) {
    const err = new Error("Invalid duration.");
    err.code = "invalid_duration";
    throw err;
  }
  if (!supported || !supported.length) {
    return { durationSec: Math.round(reqN), adjusted: false };
  }
  const allowed = [...new Set(supported.map((d) => Number(d)))].filter((d) => Number.isFinite(d) && d > 0);
  if (!allowed.length) return { durationSec: Math.round(reqN), adjusted: false };
  const rounded = Math.round(reqN);
  if (allowed.includes(rounded)) return { durationSec: rounded, adjusted: false };
  const nearest = allowed.reduce((best, d) => {
    const db = Math.abs(d - rounded);
    const bb = Math.abs(best - rounded);
    if (db < bb) return d;
    if (db > bb) return best;
    return Math.min(d, best);
  });
  return { durationSec: nearest, adjusted: true, requestedDurationSec: rounded };
};

const modelSupportsNativeAudio = (model) => {
  const a = model.capabilities?.audio;
  if (a && typeof a.supportsNativeAudio === "boolean") return a.supportsNativeAudio;
  return !!model.supportsAudio;
};

/**
 * Fail fast when aspect ratio is outside the model matrix. Wildcard `*` in
 * `supportedAspectRatios` disables this check for that model.
 */
// const validateAspectRatio = (model, aspectRatio) => {
//   const list = model.supportedAspectRatios;
//   if (!list || !list.length) return;
//   if (list.includes("*")) return;
//   if (list.includes(aspectRatio)) return;
//   const err = new Error(
//     `${model.label || model.id} does not support aspect ratio ${aspectRatio}.`,
//   );
//   err.code = "invalid_aspect_ratio";
//   err.aspectRatio = aspectRatio;
//   err.suggestedAspectRatios = list;
//   err.modelId = model.id;
//   throw err;
// };

const validateAudioForModel = (model, audio) => {
  if (!audio || !audio.enabled) return;
  const mode = String(audio.mode || "native").toLowerCase();
  if (mode === "native" && !modelSupportsNativeAudio(model)) {
    // Warn but don't throw — audio is silently skipped for models that
    // don't advertise supportsNativeAudio. This lets users keep the toggle
    // on without breaking generation on unsupported models.
    console.warn(
      `[modelRouter] ${model.id} does not advertise native audio support — audio skipped`,
    );
    // Signal to caller that audio will be dropped
    audio._skipped = true;
  }
};

// Translate a friendly motion preset (subtle, gentle, dynamic, intense) into
// the SVD-style motion bucket id that several fal video models accept. Anything
// unknown maps to a "balanced" mid value.
const motionToBucket = (motion) => {
  switch (String(motion || "").toLowerCase()) {
    case "subtle":
      return 60;
    case "gentle":
      return 90;
    case "balanced":
      return 127;
    case "dynamic":
      return 160;
    case "intense":
      return 200;
    default:
      return 127;
  }
};

const AiModel = require('../model/schema/aiModel');

const DEBUG = process.env.STUDIO_DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[modelRouter]', ...args);

// ─────────────────────────────────────────────────────────────────────────────
// Canonical caller field → list of candidate slot keys, in priority order.
// Adding a translation here propagates to every model automatically.
// ─────────────────────────────────────────────────────────────────────────────
const CANONICAL_TO_SLOT_KEY = Object.freeze({
  // text
  prompt:           ['prompt', 'text', 'inputText'],
  negativePrompt:   ['negativePrompt', 'negative_prompt'],
  multiPrompt:      ['multiPrompt', 'prompts'],
  imageUrls:        ['image_urls','imageUrls'],
  // dimensions / framing
  aspectRatio:      ['aspectRatio'],
  imageSize:        ['imageSize'],
  resolution:       ['resolution'],

  // images in
  referenceImageUrl: ['referenceImage', 'startImage', 'image', 'refImages',
                      'imageUrls', 'imageUrl', 'startFrame','image_urls'],
  endFrameUrl:       ['endFrame', 'endImage', 'tailImage'],
  maskUrl:           ['maskUrl', 'mask'],

  // video
  durationSec:      ['durationSec', 'duration'],
  motion:           ['motion', 'motionBucket'],
  fps:              ['fps', 'frameRate'],

  // audio
  audio:            ['generateAudio', 'audio', 'audioEnabled'],
  audioUrl:         ['audioUrl', 'audio_url'],
  voiceId:          ['voiceId', 'voice'],
  language:         ['language', 'lang', 'locale'],

  // shared
  numImages:        ['numImages', 'count', 'numOutputs', 'numVariants'],
  variants:         ['numImages', 'count', 'numOutputs', 'numVariants'],
  outputFormat:     ['outputFormat', 'format'],
  seed:             ['seed'],
  quality:          ['quality'],
  background:       ['background'],
  inputFidelity:    ['inputFidelity'],
  syncMode:         ['syncMode'],
  safetyTolerance:  ['safetyTolerance'],
});

// ─────────────────────────────────────────────────────────────────────────────
// Slot indexing
// ─────────────────────────────────────────────────────────────────────────────
function indexSlots(model) {
  const slots = model?.capabilities?.inputSlots || [];
  const byKey = new Map();
  const byProviderKey = new Map();
  for (const slot of slots) {
    if (slot.key)         byKey.set(slot.key, slot);
    if (slot.providerKey) byProviderKey.set(slot.providerKey, slot);
  }
  return { byKey, byProviderKey, list: slots };
}

function findSlotForCanonical(canonicalName, slotIndex) {
  const candidates = CANONICAL_TO_SLOT_KEY[canonicalName] || [canonicalName];
  for (const key of candidates) {
    const slot = slotIndex.byKey.get(key);
    if (slot) return slot;
  }
  return slotIndex.byProviderKey.get(canonicalName) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-slot type coercion
// ─────────────────────────────────────────────────────────────────────────────
function coerceValue(value, slot) {
  if (value === undefined || value === null) return undefined;

  switch (slot.type) {
    case 'string': {
      const s = String(value).trim();
      if (!s) return undefined;
      return slot.maxLength && s.length > slot.maxLength ? s.slice(0, slot.maxLength) : s;
    }

    case 'integer': {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) return undefined;
      if (slot.min !== undefined && n < slot.min) return slot.min;
      if (slot.max !== undefined && n > slot.max) return slot.max;
      return n;
    }

    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) return undefined;
      if (slot.min !== undefined && n < slot.min) return slot.min;
      if (slot.max !== undefined && n > slot.max) return slot.max;
      return n;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(v))  return true;
        if (['false', '0', 'no', 'off'].includes(v)) return false;
      }
      return Boolean(value);
    }

    case 'enum': {
      const v = slot.coerceToString ? String(value) : value;
      if (slot.options && slot.options.length && !slot.options.includes(v)) {
        log('enum mismatch — dropping', { slot: slot.key, got: v, allowed: slot.options });
        return undefined;
      }
      return v;
    }

    case 'image': {
      if (Array.isArray(value)) return value[0] ? String(value[0]).trim() || undefined : undefined;
      const s = String(value).trim();
      return s || undefined;
    }

    case 'image_array': {
      const arr = Array.isArray(value) ? value : [value];
      const cleaned = arr.map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
      if (slot.maxItems && cleaned.length > slot.maxItems) return cleaned.slice(0, slot.maxItems);
      return cleaned.length ? cleaned : undefined;
    }

    case 'array':
    case 'string_array': {
      const arr = Array.isArray(value) ? value : [value];
      const cleaned = arr.map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
      return cleaned.length ? cleaned : undefined;
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      // Strip undefined/null/empty sub-keys so providers don't choke on
      // half-filled objects (e.g. elements with frontal_image_url but no
      // reference_image_urls).
      const cleaned = {};
      for (const [k, v] of Object.entries(value)) {
        if (v == null || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        cleaned[k] = v;
      }
      return Object.keys(cleaned).length ? cleaned : undefined;
    }

    case 'element_array': {
      const arr = Array.isArray(value) ? value : [value];
      const shape = slot.elementShape || {};
      const groups = shape.oneOfGroups || [];
      const fieldByKey = {};
      for (const f of (shape.fields || [])) fieldByKey[f.key] = f;
    
      const out = [];
      for (const el of arr) {
        if (!el || typeof el !== 'object') continue;
        // Coerce each sub-field by its declared type, dropping empties
        const cleaned = {};
        for (const f of (shape.fields || [])) {
          const raw = el[f.key] ?? el[f.providerKey];
          const c = coerceValue(raw, f);   // reuse existing per-type coercion
          if (c !== undefined) cleaned[f.providerKey] = c;
        }
        // Validate oneOfGroups — element must satisfy at least one full group
        const satisfies = groups.length === 0 || groups.some((group) =>
          group.every((memberKey) => {
            const f = fieldByKey[memberKey];
            const pk = f ? f.providerKey : memberKey;
            const v = cleaned[pk];
            return v != null && !(Array.isArray(v) && v.length === 0);
          })
        );
        if (satisfies) out.push(cleaned);
        else log('dropping incomplete element — no oneOfGroup satisfied', { element: cleaned });
      }
      if (slot.maxItems && out.length > slot.maxItems) return out.slice(0, slot.maxItems);
      return out.length ? out : undefined;
    }

    default:
      log('unknown slot type, passing through', { slot: slot.key, type: slot.type });
      return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build payload from manifest
// Layering: providerInput > canonical args > manifest defaults
// ─────────────────────────────────────────────────────────────────────────────
function buildPayloadFromSlots({ model, canonicalArgs, providerInput }) {
  const slotIndex = indexSlots(model);
  const payload   = {};
  const dropped   = [];

  // 1. providerInput — keep only keys this model declares
  if (providerInput && typeof providerInput === 'object') {
    for (const [pk, value] of Object.entries(providerInput)) {
      if (value === undefined || value === null) continue;
      const slot = slotIndex.byProviderKey.get(pk);
      if (!slot) {
        dropped.push({ source: 'providerInput', key: pk });
        continue;
      }
      const coerced = coerceValue(value, slot);
      if (coerced !== undefined) payload[pk] = coerced;
    }
  }

  // 2. Canonical args — fill remaining slots
  for (const [canonicalName, value] of Object.entries(canonicalArgs)) {
    if (value === undefined || value === null) continue;
    const slot = findSlotForCanonical(canonicalName, slotIndex);
    if (!slot) {
      dropped.push({ source: 'canonical', key: canonicalName });
      continue;
    }
    if (payload[slot.providerKey] !== undefined) continue;
    const coerced = coerceValue(value, slot);
    if (coerced !== undefined) payload[slot.providerKey] = coerced;
  }

  // 3. Apply manifest defaults
  for (const slot of slotIndex.list) {
    if (slot.default === undefined) continue;
    if (payload[slot.providerKey] !== undefined) continue;
    const coerced = coerceValue(slot.default, slot);
    if (coerced !== undefined) payload[slot.providerKey] = coerced;
  }

  if (dropped.length) log('dropped fields not in manifest', { modelId: model.id, dropped });

  return { payload, slotIndex };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────
function isEmpty(v) {
  return v === undefined || v === null || v === '' ||
         (Array.isArray(v) && v.length === 0);
}

function validateAgainstManifest({ model, payload, slotIndex }) {
  const errors = [];
  const missing = [];

  // Required slots
  for (const slot of slotIndex.list) {
    if (!slot.required) continue;
    const v = payload[slot.providerKey];
    if (isEmpty(v)) {
      errors.push(`missing_required:${slot.key}`);
      missing.push(slot.key);
      continue;
    }
    if (slot.type === 'image_array' && slot.minItems &&
        Array.isArray(v) && v.length < slot.minItems) {
      errors.push(`min_items_not_met:${slot.key}:${slot.minItems}`);
      missing.push(slot.key);
    }
  }

  // Manifest constraints
  const constraints = model?.capabilities?.constraints || [];
  for (const c of constraints) {
    const fields = c.fields || [];
    const presentKeys = fields.filter((f) => {
      const slot = slotIndex.byKey.get(f);
      const pk = slot ? slot.providerKey : f;
      return !isEmpty(payload[pk]);
    });

    if (c.type === 'requires_one_of' && presentKeys.length === 0) {
      errors.push(c.message || `requires_one_of:${fields.join(',')}`);
    }
    if (c.type === 'mutual_exclusive' && presentKeys.length > 1) {
      errors.push(c.message || `mutual_exclusive:${fields.join(',')}`);
    }
    if (c.type === 'requires_all_of') {
      const missingF = fields.filter((f) => {
        const slot = slotIndex.byKey.get(f);
        const pk = slot ? slot.providerKey : f;
        return isEmpty(payload[pk]);
      });
      if (missingF.length) errors.push(c.message || `requires_all_of:${missingF.join(',')}`);
    }
  }

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.code    = 'missing_required_field';
    err.details = errors;
    err.missing = missing;
    err.modelId = model.id;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aspect ratio enum validation
// ─────────────────────────────────────────────────────────────────────────────
function _validateAspectRatioInPayload({ model, payload, slotIndex }) {
  if (!model.supportedAspectRatios?.length) return;
  const aspectSlot = slotIndex.byKey.get('aspectRatio');
  if (!aspectSlot) return;
  const inPayload = payload[aspectSlot.providerKey];
  if (!inPayload) return;
  const allowed = aspectSlot.options || model.supportedAspectRatios;
  if (!allowed.includes(inPayload)) {
    const err = new Error(
      `Model ${model.id} does not support aspect ratio ${inPayload}. ` +
      `Supported: ${model.supportedAspectRatios.join(', ')}`
    );
    err.code = 'invalid_aspect_ratio';
    err.modelId = model.id;
    err.aspectRatio = inPayload;
    err.suggestedAspectRatios = model.supportedAspectRatios;
    throw err;
  }
}
function snapDuration({ model, payload, slotIndex }) {
  const slot = slotIndex.byKey.get('durationSec') || slotIndex.byKey.get('duration');
  if (!slot) return { adjusted: false, requested: 0, effective: 0 };
 
  const slotDef = model.capabilities.inputSlots.find(
    (s) => s.key === 'durationSec' || s.key === 'duration',
  );
  const rawOptions = slotDef?.options || [];
 
  const raw = payload[slot.providerKey];
  if (raw === undefined || raw === null || raw === '') {
    return { adjusted: false, requested: 0, effective: 0 };
  }
 
  // 'auto' is a valid sentinel: the model chooses its own length. Leave it
  // untouched in the payload, but report effective:0 so the caller knows
  // there is no concrete number yet (quoteCredits handles the fallback).
  if (String(raw).toLowerCase() === 'auto') {
    return { adjusted: false, requested: 0, effective: 0, auto: true };
  }
 
  const requested = parseInt(raw, 10);
  if (Number.isNaN(requested)) {
    return { adjusted: false, requested: 0, effective: 0 };
  }
 
  // Build a NUMERIC list of selectable durations, dropping 'auto'/non-numeric.
  const numericSupported = rawOptions
    .map((o) => parseInt(o, 10))
    .filter((n) => Number.isFinite(n));
 
  // No constraint list → accept as requested.
  if (!numericSupported.length) {
    return { adjusted: false, requested, effective: requested };
  }
 
  // Exact match (now comparing number↔number). No adjustment.
  if (numericSupported.includes(requested)) {
    return { adjusted: false, requested, effective: requested };
  }
 
  // Snap to nearest; tie → shorter. Comparator can never see NaN now.
  let nearest = numericSupported[0];
  let bestDist = Math.abs(nearest - requested);
  for (const cur of numericSupported) {
    const dist = Math.abs(cur - requested);
    if (dist < bestDist || (dist === bestDist && cur < nearest)) {
      nearest = cur;
      bestDist = dist;
    }
  }
 
  payload[slot.providerKey] = slot.coerceToString ? String(nearest) : nearest;
  return { adjusted: true, requested, effective: nearest };
}

// ─────────────────────────────────────────────────────────────────────────────
// Credit quoting (lazy-loaded to avoid circular deps in tests)
// ─────────────────────────────────────────────────────────────────────────────
let _creditsService = null;
function getCreditsService() {
  if (_creditsService) return _creditsService;
  _creditsService = require('./creditsService');
  return _creditsService;
}



async function quoteCredits({ model, payload, kind, variants, durationSec }) {
  const pricing = require('./pricingEngine');
  const numImages = payload.num_images || variants || 1;
 
  // Pull a sane numeric duration. payload.duration may legitimately be 'auto'.
  const fromPayload = parseInt(payload.duration, 10);          // NaN if 'auto'
  const fromArg     = parseInt(durationSec, 10);               // NaN if 'auto'/0
  const modelDefault = (() => {
    const slotDef = (model.capabilities?.inputSlots || []).find(
      (s) => s.key === 'durationSec' || s.key === 'duration',
    );
    // If model default is 'auto', fall through; else use it.
    const d = parseInt(slotDef?.default, 10);
    return Number.isFinite(d) ? d : null;
  })();
 
  const resolvedDuration =
    (Number.isFinite(fromPayload) && fromPayload) ||
    (Number.isFinite(fromArg) && fromArg) ||
    modelDefault ||
    5; // hard floor — never NaN
 
  const params = {
    variants: numImages,
    duration: resolvedDuration,
    resolution: payload.resolution || '720p',
    quality: payload.quality || 'medium',
    audioEnabled: payload.generate_audio === true,
    image_url: payload.image_url,
    start_image_url: payload.start_image_url,
    image_urls: payload.image_urls,
    elements: payload.elements,
  };
 
  if (!model.costSpec) {
    return getCreditsService().quote({
      modelId: model.id, kind, variants: numImages,
      durationSec: params.duration, audio: params.audioEnabled ? { enabled: true } : null,
    });
  }
 
  const { credits } = pricing.computeCost(model, params);
 
  // Final safety net: if pricing ever returns NaN/negative, fail loud rather
  // than silently charging garbage or 0.
  if (!Number.isFinite(credits) || credits < 0) {
    const err = new Error(`computeCost returned invalid credits=${credits} for ${model.id}`);
    err.code = 'invalid_credit_quote';
    throw err;
  }
  return credits;
}

// ═════════════════════════════════════════════════════════════════════════════
// BACKWARD-COMPAT EXPORTS — used by adSetService, reelService, influencerService
// ═════════════════════════════════════════════════════════════════════════════

/**
 * resolveModel — DB-backed model lookup with prefix normalization.
 *
 * Used directly by adSetService.estimateVariant, reelService.estimateScene,
 * reelService.promoteToImageToVideoIfFramesPresent, and a few others.
 *
 * Throws typed errors:
 *   - 'requested_model_unavailable' when modelId given but not found
 *   - 'no_model_available' when no fallback model exists for the kind
 */
async function resolveModel({ requestedModelId, template, kind }) {
  if (!AiModel || typeof AiModel.findOne !== 'function') {
    const err = new Error('AiModel is not defined — fix the require() path in modelRouter.js');
    err.code = 'config_error';
    throw err;
  }

  let model = null;

  // 1. Explicit modelId
  if (requestedModelId) {
    model = await AiModel.findOne({ id: requestedModelId, isActive: true }).lean();
    if (!model) {
      const inactive = await AiModel.findOne({ id: requestedModelId }).lean();
      const err = new Error(
        inactive
          ? `Model "${requestedModelId}" exists but is inactive`
          : `Model "${requestedModelId}" not found`
      );
      err.code = 'requested_model_unavailable';
      err.requestedModelId = requestedModelId;
      err.availableModels = await AiModel.find({
        isActive: true,
        ...(kind ? { kind } : {}),
      }).select('id label kind').lean();
      throw err;
    }
  }

  // 2. Template's modelId
  if (!model && template?.modelId) {
    model = await AiModel.findOne({ id: template.modelId, isActive: true }).lean();
  }

  // 3. Kind-default
  if (!model && kind) {
    model = await AiModel.findOne({ kind, isActive: true, isDefault: true }).lean();
  }

  // 4. Any active model of this kind
  if (!model && kind) {
    model = await AiModel.findOne({ kind, isActive: true }).sort({ sortOrder: 1 }).lean();
  }

  if (!model) {
    const err = new Error(`No active model available for kind=${kind}`);
    err.code = 'no_model_available';
    throw err;
  }

  // ⚠️ DO NOT normalize falModelId here — falService.normalizeFalSlug() does
  //    that on the fly inside callFal(). If we strip prefixes here, the
  //    studioJob.falModelId field shows the wrong slug in admin tools.
  //    The slug stored in DB is the source of truth; callFal handles routing.
  return model;
}

/**
 * validateAspectRatio — used by adSetService.estimateVariant.
 * Throws 'invalid_aspect_ratio' if the model declares supportedAspectRatios
 * and the requested one isn't in that list.
 */
function validateAspectRatio(model, aspectRatio) {
  if (!aspectRatio) return;
  if (!model?.supportedAspectRatios?.length) return;
  if (model.supportedAspectRatios.includes(aspectRatio)) return;

  const err = new Error(
    `Model ${model.id} does not support aspect ratio ${aspectRatio}. ` +
    `Supported: ${model.supportedAspectRatios.join(', ')}`
  );
  err.code = 'invalid_aspect_ratio';
  err.modelId = model.id;
  err.aspectRatio = aspectRatio;
  err.suggestedAspectRatios = model.supportedAspectRatios;
  throw err;
}

/**
 * validateRequiredFields — used by adSetService.estimateVariant and
 * reelService.estimateScene. Pre-flight check before quoting credits.
 *
 * Walks the model's inputSlots; for each slot marked `required`, ensures
 * the corresponding canonical field is provided.
 *
 * `fields` is the "canonical bag" passed by callers, e.g.:
 *   { referenceImageUrl, endFrameUrl, prompt, ... }
 */
function validateRequiredFields(model, fields) {
  const slotIndex = indexSlots(model);
  const errors = [];
  const missing = [];

  // Build a lookup: which canonical fields are present?
  const fieldPresent = (canonicalName) => {
    const v = fields?.[canonicalName];
    return !isEmpty(v);
  };

  for (const slot of slotIndex.list) {
    if (!slot.required) continue;

    // Find which canonical field maps to this slot
    let satisfied = false;
    for (const [canon, candidates] of Object.entries(CANONICAL_TO_SLOT_KEY)) {
      if (candidates.includes(slot.key) || candidates.includes(slot.providerKey)) {
        if (fieldPresent(canon)) { satisfied = true; break; }
      }
    }
    // Direct-match fallback (e.g. fields.prompt → slot.key 'prompt')
    if (!satisfied && fieldPresent(slot.key)) satisfied = true;
    if (!satisfied && fieldPresent(slot.providerKey)) satisfied = true;

    if (!satisfied) {
      errors.push(`missing_required:${slot.key}`);
      missing.push(slot.key);
    }
  }

  if (errors.length) {
    const err = new Error(`Model ${model.id} requires: ${missing.join(', ')}`);
    err.code = 'missing_required_field';
    err.details = errors;
    err.missing = missing;
    err.modelId = model.id;
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY — used by studioController + (transitively) the services above
// ═════════════════════════════════════════════════════════════════════════════
const route = async (args) => {
  const {
    template,
    requestedModelId,
    providerInput,
    kind,
    prompts,
    aspectRatio,
    durationSec,
    variants = 1,
    referenceImageUrl,
    endFrameUrl,
    resolution,
    motion,
    seed,
    audio,
    constraints,
    slots,
    ...rest
  } = args;

  log('route() called', {
    requestedModelId,
    templateId: template?._id || null,
    kind,
    hasProviderInput: !!(providerInput && Object.keys(providerInput).length),
    hasReference: !!referenceImageUrl,
  });

  // 1. Resolve model
  const model = await resolveModel({ requestedModelId, template, kind });
  if (model.provider !== 'fal') {
    const err = new Error(`Unsupported provider: ${model.provider}`);
    err.code = 'unsupported_provider';
    throw err;
  }

  const effectiveKind = kind || model.kind;

  // 2. Pick fal endpoint
  const falModelId = effectiveKind === 'video'
    ? (model.falVideoModelId || model.falModelId)
    : model.falModelId;
  if (!falModelId) {
    const err = new Error(`Model ${model.id} has no fal endpoint for kind=${effectiveKind}`);
    err.code = 'model_missing_fal_endpoint';
    err.modelId = model.id;
    throw err;
  }

  // 3. Collapse caller args into canonical bag
  const audioGenerate = audio && typeof audio === 'object'
    ? (audio.enabled ?? audio.generate ?? null)
    : (typeof audio === 'boolean' ? audio : null);

  const canonicalArgs = {
    prompt: prompts?.finalPrompt,
    negativePrompt: prompts?.negativePrompt,
    aspectRatio,
    durationSec,
    referenceImageUrl,
    endFrameUrl,
    resolution,
    motion: motion || constraints?.motion,
    seed,
    audio: audioGenerate,
    audioUrl: audio?.audioUrl,
    voiceId: audio?.voiceId,
    language: audio?.language,
    // imageUrls: providerInput?.image_urls,
    numImages: variants,
    ...(slots || {}),
    ...(rest?.extras || {}),
  };

  // 4. Build payload from manifest
  const { payload, slotIndex } = buildPayloadFromSlots({
    model, canonicalArgs, providerInput,
  });

  // 5. Snap duration (video only)
  const durationSnap = snapDuration({ model, payload, slotIndex });

  // 6. Validate aspect ratio (in-payload)
  _validateAspectRatioInPayload({ model, payload, slotIndex });

  // 7. Validate required + constraints
  validateAgainstManifest({ model, payload, slotIndex });

  // 8. NOTE: We do NOT call falPayloadSanitizer.sanitize() here.
  //    falService.callFal() already runs the sanitizer right before fal.subscribe().
  //    Double-sanitizing is wasteful and risks dropping fields the worker just added.
  const input = payload;


  // 9. Quote credits
  const creditsCost = await quoteCredits({
    model, payload: input, kind: effectiveKind, variants,
    durationSec: durationSnap.effective || durationSec,
  });

  // 10. Compose envelope
  const effectiveDurationSec = effectiveKind === 'video'
    ? (durationSnap.effective ||
       (input.duration ? parseInt(input.duration, 10) : 0) || 0)
    : 0;

 

  return {
    modelId: model.id,
    provider: model.provider,
    falModelId,
    input,
    creditsCost,
    kind: effectiveKind,
    label: model.label,
    durationSec: effectiveDurationSec,
    durationSecAdjusted: durationSnap.adjusted,
    requestedDurationSec: durationSnap.requested || durationSec || 0,
  };
};

module.exports = {
  // Main entry — used by studioController
  route,

  // Backward-compat exports — used by adSetService / reelService / influencerService
  resolveModel,
  validateAspectRatio,
  validateRequiredFields,

  // Exposed for tests
  buildPayloadFromSlots,
  validateAgainstManifest,
  _internal: {
    indexSlots,
    findSlotForCanonical,
    coerceValue,
    snapDuration,
    CANONICAL_TO_SLOT_KEY,
  },
  loadModel: loadModel,
  buildProviderInput: buildProviderInput,
  validateRequiredFields: validateRequiredFields,
  snapDurationToSupported: snapDurationToSupported,
  validateAudioForModel: validateAudioForModel,
  modelSupportsNativeAudio: modelSupportsNativeAudio,
};