'use strict';

/**
 * services/models/dispatcher.js
 *
 * The missing import. modelRouter.route() already calls:
 *   await dispatcher.validateInput(model.id, slotInput)
 *   await dispatcher.buildProviderPayload(model.id, slotInput)
 *
 * This file makes those two functions exist. Pure translation — no network,
 * no side effects. It reads `capabilities.inputSlots` from the model doc
 * (cached via AiModel.findOne lean) and walks them to:
 *   1. Validate against required + min/max + enum + cross-field constraints
 *   2. Map canonical slot keys → fal providerKey, applying coercions
 *
 * After buildProviderPayload, the result still passes through
 * falPayloadSanitizer.sanitize() inside falService for defense-in-depth.
 */

const AiModel = require('../../model/schema/aiModel');

// In-memory model cache. Models change rarely — invalidate on seed re-run.
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
async function validateInput(modelId, slotInput = {}) {
  const model = await _loadModel(modelId);
  if (!model) return { valid: false, errors: [`unknown_model:${modelId}`] };

  const slots = model.capabilities?.inputSlots || [];
  const constraints = model.capabilities?.constraints || [];

  if (slots.length === 0) return { valid: true, errors: [], legacy: true };

  const errors = [];

  for (const slot of slots) {
    const value = slotInput[slot.key];
    const isEmpty = value == null || value === '' || (Array.isArray(value) && value.length === 0);

    if (slot.required && isEmpty) {
      errors.push(`${slot.uiLabel || slot.key} is required`);
      continue;
    }
    if (isEmpty) continue;

    if ((slot.type === 'image_array' || slot.type === 'video_array' ||
         slot.type === 'audio_array' || slot.type === 'string_array' ||
         slot.type === 'element_array') && Array.isArray(value)) {
      if (slot.minItems && value.length < slot.minItems)
        errors.push(`${slot.uiLabel || slot.key} needs at least ${slot.minItems} item(s)`);
      if (slot.maxItems && value.length > slot.maxItems)
        errors.push(`${slot.uiLabel || slot.key} accepts at most ${slot.maxItems} item(s)`);
    }

    if (slot.options?.length && value != null && !isEmpty) {
      const matches = slot.options.some(o => String(o) === String(value));
      if (!matches) {
        errors.push(`${slot.uiLabel || slot.key} must be one of: ${slot.options.join(', ')}`);
      }
    }
  }

  for (const c of constraints) {
    if (c.type === 'sum_max') {
      const sum = c.fields.reduce((acc, f) => {
        const v = slotInput[f];
        return acc + (Array.isArray(v) ? v.length : (v != null && v !== '' ? 1 : 0));
      }, 0);
      if (sum > c.value) errors.push(c.message);
    }

    if (c.type === 'requires_one_of') {
      const hasOne = c.fields.some(f => {
        const v = slotInput[f];
        return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      });
      if (!hasOne) errors.push(c.message);
    }

    if (c.type === 'mutual_exclusive') {
      const present = c.fields.filter(f => {
        const v = slotInput[f];
        return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      });
      if (present.length > 1) errors.push(c.message);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build the provider payload from slot input.
 * Returns the object to pass to fal.subscribe (still goes through
 * falPayloadSanitizer for whitelist defense).
 */
async function buildProviderPayload(modelId, slotInput = {}) {
  const model = await _loadModel(modelId);
  if (!model) throw new Error(`unknown_model:${modelId}`);

  const slots = model.capabilities?.inputSlots || [];
  if (slots.length === 0) return null; // legacy path

  const payload = {};

  for (const slot of slots) {
    let value = slotInput[slot.key];
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    switch (slot.type) {
      case 'element_array':
        // Kling-style nested elements: { frontal, references, video, voiceId }
        if (Array.isArray(value) && slot.elementShape?.fields) {
          payload[slot.providerKey] = value.map(el => {
            const out = {};
            for (const f of slot.elementShape.fields) {
              const v = el[f.key];
              if (v != null && !(Array.isArray(v) && v.length === 0) && v !== '') {
                out[f.providerKey] = v;
              }
            }
            return out;
          }).filter(el => Object.keys(el).length > 0);
        }
        break;

      case 'string_array_with_duration':
        // Kling multi_prompt: per-shot { prompt, duration } only
        if (Array.isArray(value)) {
          payload[slot.providerKey] = value
            .filter(s => s.prompt)
            .map(shot => {
              const s = { prompt: String(shot.prompt).slice(0, 2500) };
              if (shot.duration != null) {
                s.duration = String(Math.max(1, Math.min(15, Math.round(Number(shot.duration)))));
              }
              return s;
            });
        }
        break;

      case 'enum':
        payload[slot.providerKey] = slot.coerceToString === false ? value : String(value);
        break;

      case 'enum_integer':
      case 'integer':
      case 'number':
        payload[slot.providerKey] = Number(value);
        break;

      case 'boolean':
        payload[slot.providerKey] = Boolean(value);
        break;

      default:
        // image, image_array, video, video_array, audio_array, string, string_array
        payload[slot.providerKey] = value;
    }
  }

  return payload;
}

/**
 * Convenience — returns the manifest in the shape /:id/manifest needs.
 */
async function getManifest(modelId) {
  const model = await _loadModel(modelId);
  if (!model) return null;

  const caps = model.capabilities || {};
  return {
    id: model.id,
    kind: model.kind,
    uiVariant: caps.uiVariant || null,
    inputSlots: caps.inputSlots || [],
    constraints: caps.constraints || [],
    promptTokens: caps.promptTokens || null,
  };
}

module.exports = {
  validateInput,
  buildProviderPayload,
  getManifest,
  invalidateCache,
};