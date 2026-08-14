'use strict';

/**
 * buildCostSpec — generates a validated costSpec for an AiModel.
 *
 * One source of truth for "how this model charges." Pass the REAL provider
 * cost facts (from fal/openai/anthropic pricing pages) and the model's
 * billing shape; get back a costSpec object to store on the AiModel doc.
 *
 * The same costSpec is later consumed by pricingEngine.computeCost(model, params)
 * to produce { usdCost, credits }. Generator and consumer share the schema,
 * so they cannot drift.
 *
 * USAGE:
 *   const spec = buildCostSpec({
 *     unit: 'per_second',
 *     baseUsd: 0.2419,
 *     resolutionMultipliers: { '480p': 0.5, '720p': 1.0 },
 *     reference: { mode: 'discount', value: 0.6 },
 *     markup: 2.5,
 *   });
 *   // paste `spec` into AiModel.costSpec
 */

const VALID_UNITS = new Set([
  'per_image',
  'per_image_tiered',
  'per_second',
  'token_based',
  'llm_tokens',
]);

const DEFAULT_MARKUP = 2.5; // 2.5x = 60% margin floor

function buildCostSpec(opts = {}) {
  const {
    unit,
    markup = DEFAULT_MARKUP,
    // per_image
    baseUsd,
    // per_image_tiered
    qualityUsd,        // { low: 0.015, medium: 0.061, high: 0.219 }  — absolute $ per quality
    sizeMultipliers,   // { '1024x1024': 1.0, '1024x1536': 0.9, ... } — optional multiplier on quality $
    // per_second
    resolutionMultipliers,  // { '480p': 0.5, '720p': 1.0, '1080p': 2.5 }
    reference,         // { mode: 'discount'|'surcharge'|'per_item', value, perItemUsd, freeCount }
    audio,             // { mode: 'multiplier'|'flat', value }
    // token_based (video token billing, e.g. Seedance true formula)
    tokenRateUsd,      // $ per 1000 tokens
    tokenFormula,      // 'hwdt' = height*width*duration*24/1024
    // llm_tokens (Claude/Gemini/GPT text)
    inputRateUsd,      // $ per 1M input tokens
    outputRateUsd,     // $ per 1M output tokens
  } = opts;

  if (!VALID_UNITS.has(unit)) {
    throw new Error(`buildCostSpec: invalid unit "${unit}". Must be one of ${[...VALID_UNITS].join(', ')}`);
  }
  if (!(markup >= 1.5)) {
    throw new Error(`buildCostSpec: markup ${markup} too low; min 1.5 (would be <34% margin)`);
  }

  const spec = { unit, markup, usd: {} };

  switch (unit) {
    case 'per_image': {
        if (!(baseUsd > 0)) throw new Error('per_image requires baseUsd > 0');
        spec.usd.base = round(baseUsd);
        if (resolutionMultipliers) {        // ← ADD
          validateMultipliers('resolutionMultipliers', resolutionMultipliers);
          spec.usd.byResolution = resolutionMultipliers;
        }
        break;
      }

    case 'per_image_tiered': {
      if (!qualityUsd || typeof qualityUsd !== 'object') {
        throw new Error('per_image_tiered requires qualityUsd map, e.g. { low, medium, high }');
      }
      // Store absolute $ per quality. Validate all positive.
      for (const [q, v] of Object.entries(qualityUsd)) {
        if (!(v > 0)) throw new Error(`qualityUsd.${q} must be > 0`);
      }
      spec.usd.byQuality = mapRound(qualityUsd);
      if (sizeMultipliers) {
        validateMultipliers('sizeMultipliers', sizeMultipliers);
        spec.usd.bySize = sizeMultipliers;
      }
      break;
    }

    case 'per_second': {
      if (!(baseUsd > 0)) throw new Error('per_second requires baseUsd > 0 (cost per second at base resolution)');
      spec.usd.base = round(baseUsd);
      if (resolutionMultipliers) {
        validateMultipliers('resolutionMultipliers', resolutionMultipliers);
        spec.usd.byResolution = resolutionMultipliers;
      }
      if (reference) {
        spec.usd.reference = validateReference(reference);
      }
      if (audio) {
        if (!['multiplier', 'flat'].includes(audio.mode)) throw new Error('audio.mode must be multiplier|flat');
        if (!(audio.value >= 0)) throw new Error('audio.value must be >= 0');
        spec.usd.audio = { mode: audio.mode, value: round(audio.value) };
      }
      break;
    }

    case 'token_based': {
      if (!(tokenRateUsd > 0)) throw new Error('token_based requires tokenRateUsd > 0 ($/1000 tokens)');
      if (tokenFormula !== 'hwdt') throw new Error('token_based currently supports tokenFormula "hwdt" only');
      spec.usd.tokenRateUsd = tokenRateUsd;
      spec.usd.tokenFormula = tokenFormula;
      if (resolutionMultipliers) {
        // resolution implies h×w, so the formula already captures it; multipliers optional
        validateMultipliers('resolutionMultipliers', resolutionMultipliers);
        spec.usd.byResolution = resolutionMultipliers;
      }
      if (reference) spec.usd.reference = validateReference(reference);
      break;
    }

    case 'llm_tokens': {
      if (!(inputRateUsd > 0) || !(outputRateUsd > 0)) {
        throw new Error('llm_tokens requires inputRateUsd and outputRateUsd > 0 ($/1M tokens)');
      }
      spec.usd.inputRateUsd = inputRateUsd;
      spec.usd.outputRateUsd = outputRateUsd;
      break;
    }
  }

  // Self-check: emit the worst-case cost so you can eyeball it before saving.
  spec._worstCaseUsd = estimateWorstCase(spec);
  spec._worstCaseCredits = Math.ceil(
    (spec._worstCaseUsd * markup) / Number(process.env.PRICE_PER_CREDIT_USD || 0.03)
  );

  return spec;
}

// ── validators ──
function validateMultipliers(name, m) {
  if (typeof m !== 'object') throw new Error(`${name} must be an object`);
  for (const [k, v] of Object.entries(m)) {
    if (!(v > 0)) throw new Error(`${name}.${k} must be > 0`);
  }
}

function validateReference(reference) {
  const { mode } = reference;
  if (!['discount', 'surcharge', 'per_item'].includes(mode)) {
    throw new Error('reference.mode must be discount|surcharge|per_item');
  }
  if (mode === 'per_item') {
    if (!(reference.perItemUsd > 0)) throw new Error('reference per_item requires perItemUsd > 0');
    return {
      mode,
      perItemUsd: round(reference.perItemUsd),
      freeCount: reference.freeCount || 0,
    };
  }
  if (!(reference.value > 0)) throw new Error('reference discount/surcharge requires value > 0');
  return { mode, value: round(reference.value) };
}

// ── worst-case estimator (for the eyeball check) ──
function estimateWorstCase(spec) {
  const u = spec.usd;
  switch (spec.unit) {
    case 'per_image': {
        const maxRes = u.byResolution ? Math.max(...Object.values(u.byResolution)) : 1;
        return round(u.base * maxRes);
      }
    case 'per_image_tiered': {
      const maxQ = Math.max(...Object.values(u.byQuality));
      const maxSize = u.bySize ? Math.max(...Object.values(u.bySize)) : 1;
      return round(maxQ * maxSize);
    }
    case 'per_second': {
      const maxRes = u.byResolution ? Math.max(...Object.values(u.byResolution)) : 1;
      let perSec = u.base * maxRes;
      // worst case: surcharge ref + audio multiplier, assume 10s
      if (u.reference?.mode === 'surcharge') perSec *= u.reference.value;
      if (u.audio?.mode === 'multiplier') perSec *= u.audio.value;
      let cost = perSec * 10; // worst-case duration
      if (u.reference?.mode === 'per_item') cost += u.reference.perItemUsd * 4; // assume 4 refs
      if (u.audio?.mode === 'flat') cost += u.audio.value;
      return round(cost);
    }
    case 'token_based':
      // worst case: 1080p 10s → big token count. Rough upper bound.
      return round((1920 * 1080 * 10 * 24 / 1024 / 1000) * u.tokenRateUsd);
    case 'llm_tokens':
      // worst case: a heavy scan, ~50k in + 10k out
      return round((50000 / 1e6) * u.inputRateUsd + (10000 / 1e6) * u.outputRateUsd);
    default:
      return 0;
  }
}

const round = (n) => Math.round(n * 10000) / 10000;
const mapRound = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]));

module.exports = { buildCostSpec, VALID_UNITS, DEFAULT_MARKUP };