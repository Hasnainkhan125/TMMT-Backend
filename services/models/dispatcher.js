


'use strict';

/**
 * services/models/dispatcher.js
*
* Reads the manifest (capabilities.inputSlots) for a given model and
* produces a CLEAN, schema-correct fal payload. Strict by design — only
* fields declared in inputSlots are emitted. Mistyped extras silently dropped.
*
* This file is the missing piece behind the 422 error: Kling O3 reference-
* to-video doesn't accept `image_url`/`start_image_url`, only `elements` +
* `image_urls` + `prompt`. The old dispatcher was leaking canonical
* referenceImageUrl through. Now we only emit slots that are actually in
* the manifest.
*
* Validation pass mirrors the frontend manifest validator so the server
* fails BEFORE it burns provider credits.
*/

const AiModel = require('../../model/schema/aiModel');

// ─── Cache ────────────────────────────────────────────────────────────────
const _modelCache = new Map();
const CACHE_TTL_MS = 60_000;

async function _loadModel(modelId) {
  const hit = _modelCache.get(modelId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.model;

  const model = await AiModel.findOne({ id: modelId, isActive: true })
    .select('id capabilities falModelId falVideoModelId kind videoVariant supportedDurations supportedAspectRatios')
    .lean();
  if (!model) return null;

  _modelCache.set(modelId, { model, at: Date.now() });
  return model;
}

function invalidateCache(modelId) {
  if (modelId) _modelCache.delete(modelId);
  else _modelCache.clear();
}

/**
 * Validate slot input against the model's inputSlots + constraints.
 * Returns { valid: boolean, errors: string[] }.
 * Always succeeds (returns valid:true) for models without inputSlots — the
 * caller falls back to the legacy buildProviderInput path.
 */


/**
 * Build the provider payload from slot input.
 * Returns the object to pass to fal.subscribe (still goes through
 * falPayloadSanitizer for whitelist defense).
 */

/**
 * Convenience — returns the manifest in the shape /:id/manifest needs.
 */
async function getManifest(modelId) {
  const model = await loadModel(modelId);
  if (!model) return null;

  const caps = model.capabilities || {};
  return {
    id: model.id,
    kind: model.kind,
    uiVariant: caps.uiVariant || null,
    inputSlots: caps.inputSlots || [],
    constraints: caps.constraints || [],
    promptTokens: caps.promptTokens || null,
    audio: caps.audio || null,
  };
}

async function loadModel(modelId) {
  const cached = _modelCache.get(modelId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.model;
  const model = await AiModel.findOne({ id: modelId }).lean();
  if (!model) throw new Error(`unknown_model:${modelId}`);
  _modelCache.set(modelId, { model, at: Date.now() });
  return model;
}

function clearCache() { _modelCache.clear(); }

// ─── Coercion helpers — match each slot type to its provider expectation ──

function coerceValue(slot, raw) {
  if (raw === undefined || raw === null) return undefined;

  switch (slot.type) {
    case 'string':
      return String(raw).slice(0, slot.maxLength || 50000);

    case 'integer': {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) return undefined;
      const clamped = Math.max(slot.min ?? -Infinity, Math.min(slot.max ?? Infinity, n));
      return clamped;
    }

    case 'number': {
      const n = parseFloat(raw);
      if (Number.isNaN(n)) return undefined;
      return Math.max(slot.min ?? -Infinity, Math.min(slot.max ?? Infinity, n));
    }

    case 'boolean':
      return Boolean(raw);

    case 'enum':
      // Coerce to string and validate against options. coerceToString flag
      // exists because some fal endpoints want STRING enums even for numerics
      // (Kling duration "5"/"10", Seedance 2 duration "auto"/"4"/.../"15").
      const s = slot.coerceToString === false ? raw : String(raw);
      if (slot.options && !slot.options.includes(s) && !slot.options.includes(Number(s))) {
        return undefined;  // silently drop invalid enum
      }
      return slot.coerceToString === false ? Number(s) : s;

    case 'enum_integer': {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) return undefined;
      if (slot.options && !slot.options.includes(n)) return undefined;
      return n;
    }

    case 'image':
    case 'video':
    case 'audio':
      return typeof raw === 'string' && raw.trim() ? raw : undefined;

    case 'image_array':
    case 'video_array':
    case 'audio_array': {
      if (!Array.isArray(raw)) return undefined;
      const cleaned = raw.filter((u) => typeof u === 'string' && u.trim());
      if (cleaned.length === 0) return undefined;
      return slot.maxItems ? cleaned.slice(0, slot.maxItems) : cleaned;
    }

    case 'element_array': {
      // Kling O3 elements — each item is { frontal_image_url, reference_image_urls,
      // video_url, voice_id }. Empty / malformed elements are dropped.
      if (!Array.isArray(raw)) return undefined;
      const cleaned = raw
        .map((el) => coerceElement(slot, el))
        .filter((el) => el && Object.keys(el).length > 0);
      if (cleaned.length === 0) return undefined;
      return slot.maxItems ? cleaned.slice(0, slot.maxItems) : cleaned;
    }

    case 'string_array_with_duration': {
      // Kling O3 multi_prompt: [{ prompt, duration }]
      if (!Array.isArray(raw)) return undefined;
      const cleaned = raw
        .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
        .map((s) => {
          const out = { prompt: String(s.prompt).slice(0, 2500) };
          if (s.duration != null) {
            const n = Math.max(1, Math.min(15, Math.round(Number(s.duration))));
            out.duration = String(n);
          }
          return out;
        });
      return cleaned.length ? cleaned : undefined;
    }

    default:
      return raw;
  }
}

function coerceElement(slot, el) {
  if (!el || typeof el !== 'object') return null;
  const shape = slot.elementShape;
  if (!shape || !Array.isArray(shape.fields)) return el;
  const out = {};
  for (const field of shape.fields) {
    const val = el[field.providerKey] ?? el[field.key];
    if (val === undefined || val === null || val === '') continue;
    if (field.type === 'image_array') {
      if (Array.isArray(val) && val.length) {
        out[field.providerKey] = field.maxItems ? val.slice(0, field.maxItems) : val;
      }
    } else {
      out[field.providerKey] = val;
    }
  }
  // oneOf gating: at least ONE group must have all its fields satisfied
  if (Array.isArray(shape.oneOfGroups) && shape.oneOfGroups.length > 0) {
    const satisfied = shape.oneOfGroups.some((group) =>
      group.some((key) => {
        const f = shape.fields.find((x) => x.key === key);
        const v = f ? out[f.providerKey] : undefined;
        return v !== undefined && v !== null && v !== '' &&
               !(Array.isArray(v) && v.length === 0);
      })
    );
    if (!satisfied) return null;
  }
  return out;
}

// ─── Validation — same checks the frontend runs, server-side ──────────────

async function validateInput(modelId, slotInput) {
  const model = await loadModel(modelId);
  const slots = model.capabilities?.inputSlots || [];
  const constraints = model.capabilities?.constraints || [];
  const errors = [];

  for (const slot of slots) {
    const v = slotInput[slot.key];
    const has = v !== undefined && v !== null && v !== '' &&
                !(Array.isArray(v) && v.length === 0);
    if (slot.required && !has) {
      errors.push(`${slot.uiLabel || slot.key} is required`);
      continue;
    }
    if (!has) continue;

    if (slot.type === 'enum' && slot.options) {
      const want = slot.coerceToString === false ? Number(v) : String(v);
      if (!slot.options.includes(want) && !slot.options.includes(v)) {
        errors.push(`${slot.uiLabel || slot.key} must be one of ${slot.options.join(', ')}`);
      }
    }
    if (slot.type === 'enum_integer' && slot.options) {
      if (!slot.options.includes(Number(v))) {
        errors.push(`${slot.uiLabel || slot.key} must be one of ${slot.options.join(', ')}`);
      }
    }
    if (Array.isArray(v)) {
      if (slot.minItems && v.length < slot.minItems) {
        errors.push(`${slot.uiLabel || slot.key} needs at least ${slot.minItems}`);
      }
      if (slot.maxItems && v.length > slot.maxItems) {
        errors.push(`${slot.uiLabel || slot.key} max ${slot.maxItems}`);
      }
    }
  }

  for (const c of constraints) {
    if (c.type === 'sum_max') {
      const total = c.fields.reduce((a, k) => {
        const x = slotInput[k];
        return a + (Array.isArray(x) ? x.length : x ? 1 : 0);
      }, 0);
      if (total > (c.value || 0)) errors.push(c.message);
    }
    if (c.type === 'mutual_exclusive') {
      const set = c.fields.filter((k) => {
        const x = slotInput[k];
        return x !== undefined && x !== null && x !== '' &&
               !(Array.isArray(x) && x.length === 0);
      });
      if (set.length > 1) errors.push(c.message);
    }
    if (c.type === 'requires_one_of') {
      const any = c.fields.some((k) => {
        const x = slotInput[k];
        return x !== undefined && x !== null && x !== '' &&
               !(Array.isArray(x) && x.length === 0);
      });
      if (!any) errors.push(c.message);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Main: build the fal payload from slot input ──────────────────────────

async function buildProviderPayload(modelId, slotInput) {
  const model = await loadModel(modelId);
  const slots = model.capabilities?.inputSlots || [];

  const payload = {};

  for (const slot of slots) {
    const raw = slotInput[slot.key];
    let value = coerceValue(slot, raw);

    // Apply default if user didn't provide one — only for primitives + enums
    if (value === undefined && slot.default !== undefined) {
      const PRIMITIVE = ['string', 'integer', 'number', 'boolean', 'enum', 'enum_integer'];
      if (PRIMITIVE.includes(slot.type)) {
        value = coerceValue(slot, slot.default);
      }
    }

    if (value === undefined) continue;
    payload[slot.providerKey] = value;
  }

  // ── Per-model post-processing — handles oddball provider quirks that
  //    can't be expressed in pure manifest declarations.

  // Kling O3 reference-to-video: `shot_type` is a const "customize". And we
  // must NOT send prompt + multi_prompt together (XOR). Constraint validator
  // catches this, but we also enforce here.
  if (model.id === 'kling_o3_4k_ref2v') {
    payload.shot_type = 'customize';
    if (payload.prompt && Array.isArray(payload.multi_prompt) && payload.multi_prompt.length > 0) {
      // Prefer multi_prompt — that's the more specific intent
      delete payload.prompt;
    }
    // Kling O3 reference-to-video does NOT accept image-to-video frame fields
    delete payload.start_image_url;
    delete payload.end_image_url;
  }

  // Seedance 2.0 fast tiers don't support 1080p — clamp
  if (model.id?.includes('seedance_2_0_fast') && payload.resolution === '1080p') {
    payload.resolution = '720p';
  }

  return payload;
}

module.exports = {
  loadModel,
  validateInput,
  buildProviderPayload,
  clearCache,
  getManifest,
  // Exported for tests
  coerceValue,
  coerceElement,
};