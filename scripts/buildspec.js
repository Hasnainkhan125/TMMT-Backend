
const { buildCostSpec } = require('./aimodelpricing');

const SPECS = {
  // ═══ VIDEO ═══
  wan_v27_ref2vid: buildCostSpec({                    // ← cheapest, make this default
    unit: 'per_second',
    baseUsd: 0.10,
    resolutionMultipliers: { '480p': 1.0, '720p': 1.0 }, // flat $0.10 regardless
    markup: 2.5,
  }),

  seedance_2_0_fast: buildCostSpec({
    unit: 'per_second',
    baseUsd: 0.2419,
    resolutionMultipliers: { '480p': 0.5, '720p': 1.0 },
    reference: { mode: 'discount', value: 0.6 },  // 0.2419 → 0.1452
    markup: 2.5,
  }),
  seedance_2_0_fast_i2v: buildCostSpec({
    unit: 'per_second',
    baseUsd: 0.2419,
    resolutionMultipliers: { '480p': 0.5, '720p': 1.0 },
    reference: { mode: 'discount', value: 0.6 },  // 0.2419 → 0.1452
    markup: 2.5,
  }),

  kling_o3_pro_ref2v: buildCostSpec({          // RE-ENABLE — it was never the problem
    unit: 'per_second',
    baseUsd: 0.112,
    resolutionMultipliers: { '720p': 1.0 },
    audio: { mode: 'multiplier', value: 1.25 },  // 0.112 → 0.14 = 1.25x
    markup: 2.5,
  }),

  kling_v3_pro: buildCostSpec({
    unit: 'per_second',
    baseUsd: 0.112,
    audio: { mode: 'multiplier', value: 1.5 },   // 0.112 → 0.168
    markup: 2.5,
  }),

  seedance_2_standard: buildCostSpec({         // gate to ultra (1080p)
    unit: 'per_second',
    baseUsd: 0.3024,
    resolutionMultipliers: { '480p': 0.5, '720p': 1.0, '1080p': 2.5 },
    reference: { mode: 'discount', value: 0.6 },
    markup: 2.5,
  }),

  // ═══ IMAGE (flat) ═══
  flux_schnell: buildCostSpec({ unit: 'per_image', baseUsd: 0.003, markup: 2.5 }),
  flux_pro:     buildCostSpec({ unit: 'per_image', baseUsd: 0.05,  markup: 2.5 }),
  seedream_5_0: buildCostSpec({ unit: 'per_image', baseUsd: 0.035, markup: 2.5 }),

  // ═══ IMAGE (resolution-tiered — 4K doubles) ═══
  nano_banana_2: buildCostSpec({
    unit: 'per_image',                // reuse per_second engine path? NO — see note below
    // Actually use per_image with a resolution multiplier. If your buildCostSpec
    // per_image doesn't support byResolution, add it (see patch below).
    baseUsd: 0.15,
    resolutionMultipliers: { '1k': 1.0, '2k': 1.0, '4k': 2.0 },
    markup: 2.5,
  }),

  nano_banana_pro: buildCostSpec({
    unit: 'per_image',     
    baseUsd: 0.15,
    resolutionMultipliers: { '1k': 1.0, '2k': 1.0, '4k': 2.0 },
    markup: 2.5,
  }),

  // ═══ IMAGE (quality-tiered) ═══
  gpt_image_2_edit: buildCostSpec({
    unit: 'per_image_tiered',
    qualityUsd: { low: 0.015, medium: 0.061, high: 0.219 },
    markup: 2.5,
    // lock UI to 'medium'; gate 'high' to ultra
  }),
  gpt_image_2: buildCostSpec({
    unit: 'per_image_tiered',
    qualityUsd: { low: 0.015, medium: 0.061, high: 0.219 },
    markup: 2.5,
    // lock UI to 'medium'; gate 'high' to ultra
  }),
};
for (const [id, spec] of Object.entries(SPECS)) {
    console.log(`${id}: worst-case $${spec._worstCaseUsd} → ${spec._worstCaseCredits} credits`);
  }