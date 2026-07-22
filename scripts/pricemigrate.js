'use strict';
/**
 * migrate-model-pricing.js
 *
 * Sets each active model's billing fields to worst-case-safe values.
 * - costSpec: full spec (for the weekend pricingEngine; unused by billing today)
 * - providerCostUsdEstimate: worst-case USD (feeds the margin guard NOW)
 * - creditsPerImage / creditsPerSecondVideo: worst-case flat (what the router charges TODAY)
 *
 * Run: node scripts/migrate-model-pricing.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { buildCostSpec } = require('./aimodelpricing');
const AiModel = require('../model/schema/aiModel');

const PRICE_PER_CREDIT_USD = Number(process.env.PRICE_PER_CREDIT_USD || 0.03);

// modelId in DB → { spec, worstCaseDurationSec (video only), isActive, gate }
const PLAN = {
  // ─── VIDEO ───
  wan_v27_ref2vid: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.10,
      resolutionMultipliers: { '480p': 1.0, '720p': 1.0 }, markup: 2.5 }),
    worstDur: 10, isActive: true,
  },
  seedance_2_0_fast: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.2419,
      resolutionMultipliers: { '480p': 0.5, '720p': 1.0 },
      reference: { mode: 'discount', value: 0.6 }, markup: 2.5 }),
    worstDur: 10, isActive: true,
  },
   
  seedance_2_0_fast_i2v: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.2419,
      resolutionMultipliers: { '480p': 0.5, '720p': 1.0 },
      reference: { mode: 'discount', value: 0.6 }, markup: 2.5 }),
    worstDur: 10, isActive: true,
  },
   
  kling_o3_4k_ref2v: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.112,
      resolutionMultipliers: { '720p': 1.0 },
      audio: { mode: 'multiplier', value: 1.25 }, markup: 2.5 }),
    worstDur: 10, isActive: true,   // re-enabled — it was never the $8
  },
  kling_v3_pro: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.112,
      audio: { mode: 'multiplier', value: 1.5 }, markup: 2.5 }),
    worstDur: 10, isActive: true,
  },
  seedance_2_standard: {
    spec: buildCostSpec({ unit: 'per_second', baseUsd: 0.3024,
      resolutionMultipliers: { '480p': 0.5, '720p': 1.0, '1080p': 2.5 },
      reference: { mode: 'discount', value: 0.6 }, markup: 2.5 }),
    worstDur: 10, isActive: false,  // gate to ultra later
  },

  // ─── IMAGE flat ───
  flux_schnell:    { spec: buildCostSpec({ unit: 'per_image', baseUsd: 0.003, markup: 2.5 }), isActive: true },
  flux_pro:        { spec: buildCostSpec({ unit: 'per_image', baseUsd: 0.05,  markup: 2.5 }), isActive: true },
  seedream_5_0: { spec: buildCostSpec({ unit: 'per_image', baseUsd: 0.035, markup: 2.5 }), isActive: true },

  // ─── IMAGE resolution-tiered ───
  nano_banana_2: {
    spec: buildCostSpec({ unit: 'per_image', baseUsd: 0.15,
      resolutionMultipliers: { '1k': 1.0, '2k': 1.0, '4k': 2.0 }, markup: 2.5 }),
    isActive: true,
  },
  nano_banana_pro: {
    spec: buildCostSpec({ unit: 'per_image', baseUsd: 0.15,
      resolutionMultipliers: { '1k': 1.0, '2k': 1.0, '4k': 2.0 }, markup: 2.5 }),
    isActive: false,  // gate to paid
  },

  // ─── IMAGE quality-tiered ───
  gpt_image_2_edit: {
    spec: buildCostSpec({ unit: 'per_image_tiered',
      qualityUsd: { low: 0.015, medium: 0.061, high: 0.219 }, markup: 2.5 }),
    isActive: true,
  },
  gpt_image_2: {
    spec: buildCostSpec({ unit: 'per_image_tiered',
      qualityUsd: { low: 0.015, medium: 0.061, high: 0.219 }, markup: 2.5 }),
    isActive: true,
  },

  // ─── DEACTIVATE ───
  'seedance_2.0': { isActive: false, deactivateOnly: true }, // legacy alias, the 4cr/sec loss leak
  kling_o3_4k_i2v: { isActive: false, deactivateOnly: true }, // premium 4K, not the $8 (that was upscale)
};

async function main() {
  await mongoose.connect((process.env.DB_URL || 'mongodb://127.0.0.1:27017') + '/' + (process.env.DB || 'qumak'));

  for (const [modelId, cfg] of Object.entries(PLAN)) {
    const doc = await AiModel.findOne({ id: modelId });
    if (!doc) { console.warn(`  SKIP (not found): ${modelId}`); continue; }

    if (cfg.deactivateOnly) {
      await AiModel.updateOne({ id: modelId }, { $set: { isActive: false } });
      console.log(`  DEACTIVATED: ${modelId}`);
      continue;
    }

    const { spec } = cfg;
    const worstUsd = spec._worstCaseUsd;
    const worstCredits = spec._worstCaseCredits;

    const update = {
      costSpec: spec,
      providerCostUsdEstimate: worstUsd,
      lastCostRefreshAt: new Date(),
      isActive: cfg.isActive,
    };

    if (spec.unit === 'per_second') {
      // Flat per-second = worst-case-credits / worst-case-duration, rounded UP.
      // This guarantees even the most expensive (longest, no-ref, audio) gen is covered.
      update.creditsPerSecondVideo = Math.ceil(worstCredits / cfg.worstDur);
      update.baseCreditsForVideo = 0;
    } else {
      // per_image / per_image_tiered → flat per-image = worst-case credits.
      update.creditsPerImage = worstCredits;
    }

    await AiModel.updateOne({ id: modelId }, { $set: update });
    console.log(
      `  ${cfg.isActive ? 'ACTIVE' : 'gated'} ${modelId}: ` +
      `worst $${worstUsd} → ${worstCredits}cr` +
      (spec.unit === 'per_second' ? ` (${update.creditsPerSecondVideo}cr/sec flat)` : ` (flat/img)`)
    );
  }

  console.log('\nDone. Verify the per-sec/per-image numbers above before going live.');
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });