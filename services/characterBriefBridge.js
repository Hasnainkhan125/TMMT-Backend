/**
 * characterBriefBridge.js — wire the AvatarPreset picker (frontend) to the
 * per-clip reference lock (backend), preserving CHARACTER + OBJECT + ENVIRONMENT
 * across every shot.
 *
 * KEY MODEL FACT (from the Seedance 2.0 Multi-Reference screen): the model takes
 * up to 12 named references and you address them in the prompt as @Image1,
 * @Image2, etc. THAT is how we lock identity across clips without chaining:
 *   @Image1 = character (locked face/presenter)
 *   @Image2 = product   (the brand's item)
 *   @Image3 = environment (optional locked scene)
 * The SAME refs go into EVERY shot's blueprint, so the character/product/scene
 * are identical in clip 1, 2, 3 — generated in PARALLEL, clean cuts.
 *
 * HONESTY GUARD: voice/caption/lipsync from the AvatarBrief are NOT generated
 * yet (no lipsync pipeline). We carry them through as metadata + prompt VO
 * direction only, behind URL_TO_ADS_LIPSYNC=off. Do not surface them as live
 * until the lipsync milestone ships.
 */

const LIPSYNC_ENABLED = process.env.URL_TO_ADS_LIPSYNC === 'on';

// Map a shot role → which model to use. Cheaper i2v for product-only macros;
// multi-reference (identity-preserving) only where a person must stay consistent.
const MODEL_BY_ROLE = {
  // person-bearing roles → need character lock → multi-reference model
  hook:    'seedance_2_multiref',
  problem: 'seedance_2_multiref',
  demo:    'seedance_2_multiref',
  result:  'seedance_2_multiref',
  cta:     'seedance_2_multiref',
  reveal:  'seedance_2_multiref',
  // product-only macro → no face to keep consistent → cheaper i2v
  product: 'kling_o3_i2v',
};

// Map our internal model keys → the fal/provider slugs your router knows.
const MODEL_SLUGS = {
  seedance_2_multiref: { modelId: 'seedance_v2_ref', falSlug: 'fal-ai/bytedance/seedance/v2/reference-to-video', supportsMultiRef: true,  costC: 80 },
  kling_o3_i2v:        { modelId: 'kling_o3_i2v',    falSlug: 'fal-ai/kling-video/o3/4k/image-to-video',         supportsMultiRef: false, costC: 60 },
  wan_v27_ref2vid:     { modelId: 'wan_v27_ref2vid', falSlug: 'fal-ai/wan/v2.7/reference-to-video',              supportsMultiRef: true,  costC: 60 },
};

/**
 * Build the locked reference SET for the whole ad — resolved ONCE, reused per shot.
 * @returns { character, product, environment } each = { url, label } | null
 */
function buildReferenceSet({ avatarBrief, productImageUrl, environmentImageUrl }) {
  const character = avatarBrief?.preset?.previewCoverUrl || avatarBrief?.avatarThumbUrl || null;
  return {
    character:   character          ? { url: character,          label: 'Image1' } : null,
    product:     productImageUrl    ? { url: productImageUrl,     label: 'Image2' } : null,
    environment: environmentImageUrl? { url: environmentImageUrl, label: 'Image3' } : null,
  };
}

// Render the @ImageN reference instruction + identity lock for a shot prompt.
function refMentionBlock(refSet, { includeCharacter }) {
  const parts = [];
  if (includeCharacter && refSet.character) parts.push(`@Image1 is the presenter — SAME person, identical face, in every shot`);
  if (refSet.product)                       parts.push(`@Image2 is the product — keep packaging, color, label identical`);
  if (refSet.environment)                   parts.push(`@Image3 is the environment/scene — keep consistent`);
  return parts.length ? `References: ${parts.join('. ')}.` : '';
}

/**
 * applyBriefToShots — the core wiring. For each recipe shot:
 *   - choose model by role (cheap i2v for product-only, multi-ref otherwise)
 *   - attach the locked refs (character+product+environment) the model supports
 *   - prepend the @ImageN mention block + identity lock to the prompt
 *   - carry voice/caption as metadata only (NOT generated yet)
 */
function applyBriefToShots(shots, { avatarBrief, productImageUrl, environmentImageUrl }) {
  const refSet = buildReferenceSet({ avatarBrief, productImageUrl, environmentImageUrl });
  const voiceHint = avatarBrief?.voice?.promptHint || '';
  const speakSource = avatarBrief?.speakSource || 'model_freestyle';

  return shots.map((s) => {
    const modelKey = MODEL_BY_ROLE[s.role] || 'seedance_2_multiref';
    const model = MODEL_SLUGS[modelKey];
    const includeCharacter = s.role !== 'product' && !!refSet.character;

    // Which refs actually get passed to this shot:
    const refs = [];
    if (includeCharacter)   refs.push(refSet.character);
    if (refSet.product)     refs.push(refSet.product);
    if (refSet.environment && model.supportsMultiRef) refs.push(refSet.environment);

    // If model does NOT support multi-ref (Kling i2v), it can take ONE image —
    // use product for product shots, character otherwise.
    const referenceImageUrls = model.supportsMultiRef
      ? refs.map(r => r.url)
      : [ (includeCharacter ? refSet.character : refSet.product)?.url ].filter(Boolean);

    const mention = model.supportsMultiRef ? refMentionBlock(refSet, { includeCharacter }) : '';
    // VO direction is prompt-only until lipsync ships.
    const voLine = (includeCharacter && voiceHint)
      ? `Delivery (for later VO, not lip-synced yet): ${voiceHint}.` : '';

    const prompt = [mention, s.prompt, voLine].filter(Boolean).join('\n\n');

    return {
      ...s,
      modelId: model.modelId,
      falSlug: model.falSlug,
      referenceImageUrls,
      referenceImageUrl: referenceImageUrls[0],   // back-compat single field
      startImageUrl: referenceImageUrls[0],
      prompt,
      // metadata for the row / post-production — carried, not generated:
      _brief: {
        voiceId: avatarBrief?.voice?.id || null,
        captionId: avatarBrief?.caption?.id || null,
        visualStyle: avatarBrief?.visualStyle || null,
        speakSource,
        script: avatarBrief?.script || null,
        lipsync: LIPSYNC_ENABLED,   // false until milestone ships
      },
      estCostC: model.costC,
    };
  });
}

// Total credit estimate for an ad (sum of per-shot model costs).
function estimateAdCost(shotsWithModels) {
  return shotsWithModels.reduce((sum, s) => sum + (s.estCostC || 0), 0);
}

module.exports = { applyBriefToShots, buildReferenceSet, estimateAdCost, MODEL_BY_ROLE, MODEL_SLUGS };