'use strict';

/**
 * adBrain.js — v3 (compatibility shim)
 *
 * adBrain USED to be a hardcoded 6-category DNA switch. That's dead.
 * Everything routes through intentEngine now.
 *
 * This file exists ONLY because three callers still import it:
 *   1. videoWorker.js — fallback when controller didn't set a prompt
 *   2. urlToAdController.js — building the 3 free ad blueprints
 *   3. studioController.previewPrompt — /preview-prompt endpoint
 *
 * Rather than touch those 3 files in 3 PRs, we keep the API shape and
 * delegate to intentEngine. When each of those 3 sites migrates to call
 * intentEngine directly, this file can finally be deleted.
 *
 * KEY DIFFERENCE: this version NEVER blocks. The worker fallback must be
 * synchronous-safe because it runs in a catch block. We provide:
 *   - buildAdPrompt (sync) — deterministic build, no Haiku call
 *   - buildAdPromptAsync (async) — full intentEngine run for URL-to-Ad
 */

const intentEngine = require('./intentEngine');

/**
 * Synchronous prompt builder — safe to call from worker fallbacks.
 * Uses intentEngine's deterministic classifier (no network calls).
 * Returns same shape as the old adBrain.buildAdPrompt.
 */
function buildAdPrompt(inputs = {}) {
  const {
    category      = '',
    brandName     = '',
    description   = '',
    targetAudience= '',
    vibe          = '',
    locale        = 'gulf',
    userPrompt    = '',
    featuredProducts = [],
  } = inputs;

  const rawInput = (userPrompt || description || '').trim();

  // Deterministic classification — no Haiku, no timeout risk
  const intent = intentEngine.deterministicClassify(rawInput, locale, {
    brandName,
    targetAudience,
    featuredProducts,
  });

  // If the caller provided a hint category, prefer it (they know the domain
  // better than our regex does — they may have already classified upstream).
  if (category && intentEngine.DOMAIN_DNA[category.toLowerCase()]) {
    intent.domain = category.toLowerCase();
  }

  // Build the domain context WITHOUT the async assembleContext — we just
  // want the static DNA. Seasonal context is cheap/sync, so include it.
  const dna = intentEngine.DOMAIN_DNA[intent.domain] || intentEngine.DOMAIN_DNA.default;
  const context = {
    dna,
    seasonal: null, // sync path skips seasonal — not worth a Date.now() round trip here
    gulfMod: intent.gulf_relevant ? dna.gulfMod : null,
    brandKit: null,
    urlData: null,
  };

  const { finalPrompt, negativePrompt, promptMetadata } = intentEngine.synthesizePrompt({
    intent,
    context,
    inputs: { prompt: rawInput, brandName, description, targetAudience, vibe, locale },
    constraints: null,
  });

  // Shape-compat with legacy callers expecting `{ finalPrompt, negativePrompt, promptMetadata }`
  return { finalPrompt, negativePrompt, promptMetadata };
}

/**
 * Async version — runs the full intentEngine pipeline including Haiku
 * classification. Used by urlToAdController where we have the time budget.
 */
async function buildAdPromptAsync(inputs = {}, { urlScrapeData = null } = {}) {
  const engineResult = await intentEngine.run({
    knownDomain: inputs.category,
    inputs: {
      ...inputs,
      prompt:      inputs.userPrompt || inputs.description || '',
      description: inputs.description || '',
    },
    urlScrapeData,
  });

  return {
    finalPrompt:    engineResult.finalPrompt,
    negativePrompt: engineResult.negativePrompt,
    promptMetadata: engineResult.promptMetadata,
    intent:         engineResult.intent,
  };
}

/**
 * getAllCategories — preserved for frontend category picker endpoint.
 * Returns the intentEngine's DOMAIN_DNA as a gallery list.
 */
function getAllCategories() {
  return Object.keys(intentEngine.DOMAIN_DNA)
    .filter(k => k !== 'default')
    .map(id => ({
      id,
      label: id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
      // Legacy callers expected vibes + categoryInputs — we no longer enforce
      // these, so return empty arrays. The frontend falls back gracefully.
      vibes: [],
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe'],
    }));
}

/**
 * getCategoryDNA — still used by a couple of admin/debug endpoints.
 * Returns the intentEngine's DNA entry or null.
 */
function getCategoryDNA(category) {
  return intentEngine.DOMAIN_DNA[category] || null;
}

module.exports = {
  buildAdPrompt,
  buildAdPromptAsync,
  getAllCategories,
  getCategoryDNA,
  // Expose the full engine for advanced callers that want to migrate directly
  intentEngine,
};
