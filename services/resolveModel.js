'use strict';

/**
 * resolveModel.js
 *
 * Resolves a model from the registry. Throws typed errors so the controller
 * can map them to HTTP status codes.
 *
 * IMPORTANT: This file imports the AiModel Mongoose model. The "AiModel is not
 * defined" error in production was caused by a missing/wrong import path here.
 * Update the require() path on line 22 to match YOUR project structure.
 */

// ⚠️ FIX THIS PATH if your AiModel lives elsewhere:
//    Common locations:
//      ../../model/schema/aiModel
//      ../../models/AiModel
//      ../models/aiModel
//    The file MUST export the Mongoose model (module.exports = mongoose.model('AiModel', schema))
const AiModel = require('../model/schema/aiModel');

const DEBUG = process.env.STUDIO_DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[resolveModel]', ...args);

// fal hosts models under multiple orgs. The endpoint slug is FLAT —
// "openai/gpt-image-2/edit" is correct, NOT "fal-ai/openai/gpt-image-2/edit".
const KNOWN_FAL_ORGS = [
  'openai/', 'bytedance/', 'google/', 'stability-ai/',
  'meta/', 'kwaivgi/', 'minimax/', 'fal-ai/',
];

/**
 * Strip accidental "fal-ai/" prefix when the endpoint is under a different org.
 *
 *   fal-ai/openai/gpt-image-2/edit  → openai/gpt-image-2/edit       ✓ stripped
 *   fal-ai/bytedance/seedance/...   → bytedance/seedance/...        ✓ stripped
 *   fal-ai/flux/schnell             → fal-ai/flux/schnell           ✓ left alone
 *   openai/gpt-image-2/edit         → openai/gpt-image-2/edit       ✓ left alone
 */
function normalizeFalEndpoint(slug) {
  if (!slug || typeof slug !== 'string') return slug;
  if (!slug.startsWith('fal-ai/')) return slug;
  const rest = slug.slice('fal-ai/'.length);
  for (const org of KNOWN_FAL_ORGS) {
    if (rest.startsWith(org)) {
      return rest;
    }
  }
  return slug;
}

async function resolveModel({ requestedModelId, template, kind }) {
  let model = null;

  // Defensive: AiModel might be undefined if the import path was wrong
  if (!AiModel || typeof AiModel.findOne !== 'function') {
    const err = new Error('AiModel is not defined — fix the require() path in resolveModel.js');
    err.code = 'config_error';
    throw err;
  }

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
    model = await AiModel.findOne({ kind, isActive: true })
      .sort({ sortOrder: 1 })
      .lean();
  }

  if (!model) {
    const err = new Error(`No active model available for kind=${kind}`);
    err.code = 'no_model_available';
    throw err;
  }

  // Normalize falModelId
  if (model.falModelId) {
    const original = model.falModelId;
    model.falModelId = normalizeFalEndpoint(model.falModelId);
    if (original !== model.falModelId) {
      log('normalized falModelId', { from: original, to: model.falModelId });
    }
  }
  if (model.falVideoModelId) {
    model.falVideoModelId = normalizeFalEndpoint(model.falVideoModelId);
  }

  return model;
}

module.exports = {
  resolveModel,
  normalizeFalEndpoint,
};