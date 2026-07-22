/**
 * promptBuilder.js — v2
 *
 * Now reads from GenerationTemplate documents instead of a static lookup table.
 *
 * The key fix from the roast:
 * - v1: static GULF_CONTEXT object with 9 entries, 120 chars per entry
 * - v2: full cinematic prompt blueprints from templates, 1600-5150 chars, with
 *       injection tokens, scene structure, second-by-second direction
 *
 * Injection token substitution:
 *   {product_image}  → actual R2 URL of uploaded product photo
 *   {brand_name}     → user's brand name
 *   {product_name}   → product title
 *   {product_desc}   → product description
 *   {avatar}         → avatar reference URL
 *   {hook_line}      → generated hook (from copy engine)
 *   {cta_line}       → call to action text
 *
 * Gulf context modifier is stored ON the template, not hardcoded here.
 * This file now assembles the final prompt from parts.
 */

const mongoose = require('mongoose');
const {
  renderConstraintsClause,
  CONSTRAINT_VOCAB,
  STYLE_TAG_VOCAB,
  CONSTRAINT_AXES,
} = require('./constraintRender');

// ── Gulf context modifiers — loaded from template.gulfContextModifier ─────────
// These are the backup defaults if a template doesn't specify one.
// They're more specific than before but still just defaults.
const GULF_CONTEXT_DEFAULTS = {
  restaurant:   'warm Arabic hospitality aesthetic, rich layered food photography, golden hour side-lighting on marble surface, Emirates fine dining atmosphere, deep saffron and burnt amber tones',
  perfume:      'luxury oud fragrance aesthetic, dark polished obsidian marble, warm gold accents, arabesque lattice shadow patterns, Dubai premium retail atmosphere, floating dust motes in angled light',
  skincare:     'clean Gulf luxury beauty aesthetic, ultra-soft diffused key light on cream surface, clinical luxury with warm champagne undertones, macro pore-level texture detail',
  fashion:      'Gulf modest fashion editorial, clean minimal studio, strong directional light casting long shadows, premium heavyweight fabric texture, restrained luxury palette',
  realestate:   'Dubai luxury property photography, golden hour magic light through floor-to-ceiling windows, premium architectural finish, Marina or Downtown skyline implied in background',
  gym:          'Dubai premium fitness aesthetic, hard high-contrast directional light, sweat and effort visible, motivational not aspirational, deep shadow areas',
  jewelry:      'Gulf luxury jewelry commercial, cold studio light on polished metal, macro sparkle detail, black velvet or obsidian surface, ultra-sharp crystal facets',
  beauty:       'Gulf beauty editorial, warm studio key light, dewy skin finish, premium UAE cosmetics aesthetic',
  haircare:     'Gulf hair care premium, soft diffused light, silky texture emphasis, clean warm neutral background',
  tech:         'precision consumer electronics photography, clean dark background with single rim light, macro edge detail, Dubai tech retail premium aesthetic',
  ecommerce:    'clean product photography, white or light marble surface, professional multi-source studio light, crisp shadows',
  general:      'premium product photography, clean professional studio lighting, Dubai commercial advertising aesthetic',
};

// ── Seasonal modifiers (Gulf calendar) ───────────────────────────────────────
function getSeasonalModifier(locale = 'gulf') {
  if (locale !== 'gulf') return null;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();

  // Ramadan 2026: March 1–30
  if (y === 2026 && m === 3 && d >= 1 && d <= 30) {
    return 'Ramadan spirit — warm lantern glow, generous golden palette, family warmth, reflective and gracious mood, no hard sell';
  }
  // Eid Al-Fitr 2026: ~March 31 – April 2
  if ((y === 2026 && m === 3 && d >= 31) || (y === 2026 && m === 4 && d <= 2)) {
    return 'Eid Al-Fitr celebration — joyful warmth, gold and cream palette, festive generosity';
  }
  // Eid Al-Adha 2026: ~June 6–8
  if (y === 2026 && m === 6 && d >= 6 && d <= 8) {
    return 'Eid Al-Adha — rich warm tones, family gathering warmth, generous spirit';
  }
  // UAE National Day: December 2–3
  if (m === 12 && (d === 2 || d === 3)) {
    return 'UAE National Day — proud green and gold palette, celebratory national spirit';
  }
  // KSA National Day: September 23
  if (m === 9 && d === 23) {
    return 'Saudi National Day — green and gold, national pride, Vision 2030 energy';
  }

  return null;
}

/**
 * Build the final generation prompt from a template and user inputs.
 *
 * @param {object} template - GenerationTemplate document
 * @param {object} inputs - User-provided values
 * @param {string} inputs.productImageUrl - R2 URL of uploaded product image
 * @param {string} inputs.brandName - e.g. "Kabab House"
 * @param {string} inputs.productName - e.g. "Signature Lamb Kabab Platter"
 * @param {string} inputs.productDesc - e.g. "Slow-grilled over charcoal..."
 * @param {string} inputs.avatarUrl - R2 URL of selected avatar
 * @param {string} inputs.hookLine - Generated hook line
 * @param {string} inputs.ctaLine - e.g. "Order now on Talabat"
 * @param {string} inputs.locale - 'gulf' | 'global'
 * @param {string} inputs.language - 'en' | 'ar' | 'zh' etc
 * @returns {object} { finalPrompt, negativePrompt, modelId, modelParams }
 */
function buildFromTemplate(template, inputs = {}) {
  const {
    productImageUrl,
    brandName    = '',
    productName  = '',
    productDesc  = '',
    avatarUrl    = '',
    hookLine     = '',
    ctaLine      = 'Shop now',
    locale       = 'gulf',
    language     = 'en',
    constraints  = null,   // { cameraAngle, lighting, shotType, motion, pace }
  } = inputs;

  // 1. Select prompt blueprint — Arabic if Gulf+AR, else English
  let blueprint;
  if (language === 'ar' && template.promptBlueprintAr) {
    blueprint = template.promptBlueprintAr;
  } else if (language !== 'en' && template.i18nPrompts?.[language]) {
    blueprint = template.i18nPrompts[language];
  } else {
    blueprint = template.promptBlueprint;
  }

  if (!blueprint) {
    throw new Error(`Template ${template._id} has no promptBlueprint`);
  }

  // 2. Substitute injection tokens
  const substitutions = {
    product_image: productImageUrl || '',
    brand_name:    brandName,
    product_name:  productName || brandName,
    product_desc:  productDesc,
    avatar:        avatarUrl,
    hook_line:     hookLine,
    cta_line:      ctaLine,
  };

  let prompt = blueprint;
  for (const [key, value] of Object.entries(substitutions)) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  // Clean up leftover unfilled tokens
  prompt = prompt.replace(/\{[a-z_]+\}/g, '').replace(/\s{2,}/g, ' ').trim();

  // 3. Append Gulf context modifier if locale is gulf
  if (locale === 'gulf') {
    const gulfMod = template.gulfContextModifier
      || GULF_CONTEXT_DEFAULTS[template.bestCategories?.[0]]
      || GULF_CONTEXT_DEFAULTS.general;

    prompt = `${prompt}\n\nVisual style: ${gulfMod}.`;
  }

  // 4. Append seasonal modifier
  const seasonal = getSeasonalModifier(locale);
  if (seasonal) {
    prompt = `${prompt}\nSeasonal context: ${seasonal}.`;
  }

  // 5. Append directional constraints if provided.
  if (constraints) {
    // renderConstraintsClause is hoisted (function decl), safe to reference.
    const clause = renderConstraintsClause(constraints);
    if (clause) prompt += clause;
  }

  // 6. Append universal quality signals
  prompt += '\n\nProfessional advertising quality. 4K ultra-sharp. Cinematic lighting. No text overlays. No logos. No pre-existing packaging.';

  // 7. Select model
  const modelId = selectModel(template);

  return {
    finalPrompt: prompt,
    negativePrompt: template.negativePrompt || buildNegativePrompt(),
    modelId,
    modelParams: template.modelParameters || {},
    outputType: template.outputType,
    aspectRatio: template.aspectRatio,
    duration: template.defaultDuration,
    resolution: template.defaultResolution,
  };
}

/**
 * Fallback: build a prompt without a template (for when no template is matched).
 * Used by the imageWorker when generation_templates collection is empty or
 * no template matches the category.
 */
function buildFallbackPrompt(inputs = {}) {
  const {
    category    = 'general',
    brandName   = '',
    description = '',
    locale      = 'gulf',
  } = inputs;

  const gulfMod = GULF_CONTEXT_DEFAULTS[category] || GULF_CONTEXT_DEFAULTS.general;
  const seasonal = getSeasonalModifier(locale);

  const parts = [
    `Premium product advertisement for ${brandName}.`,
    description ? `Product: ${description}.` : '',
    locale === 'gulf' ? `Visual style: ${gulfMod}.` : '',
    seasonal ? `Context: ${seasonal}.` : '',
    'Professional advertising quality. Cinematic lighting. 4K. No text overlays.',
  ].filter(Boolean).join(' ');

  return {
    finalPrompt: parts,
    negativePrompt: buildNegativePrompt(),
    modelId: 'flux_schnell',
    outputType: 'image',
    aspectRatio: '1:1',
  };
}

function buildNegativePrompt() {
  return [
    'text overlay', 'watermark', 'logo', 'blurry', 'low quality',
    'distorted', 'cartoon', 'illustration', 'noise', 'grain',
    'overexposed', 'underexposed', 'amateur', 'stock photo look',
  ].join(', ');
}

function selectModel(template) {
  if (template.recommendedModel && template.recommendedModel !== 'auto') {
    return template.recommendedModel;
  }
  if (template.supportedModels?.length > 0) {
    return template.supportedModels[0];
  }
  return template.outputType === 'video' ? 'seedance_2.0' : 'flux_schnell';
}

/**
 * Find the best matching template from the database.
 * Called by the generation route before building the prompt.
 */
async function findBestTemplate(db, { category, contentType, outputType = 'image', locale, planLevel = 'free' }) {
  const GenerationTemplate = mongoose.model('GenerationTemplate');

  const query = {
    isActive: true,
    outputType,
    bestCategories: category,
    planLevel: { $in: ['free', planLevel] },
  };

  if (locale === 'gulf') {
    query.locale = { $in: ['gulf', 'both'] };
  }
  if (contentType) {
    query.contentType = contentType;
  }

  const template = await GenerationTemplate.findOne(query)
    .sort({ 'engagement.finalScore': -1, isFeatured: -1 })
    .lean();

  return template; // null if no match — caller uses fallback
}

/**
 * Build N prompt variants from a single template/inputs pair by mutating one
 * directorial axis at a time. We deliberately don't randomise the prompt body
 * — we vary direction so the variants look like they belong to one campaign.
 */
function buildVariants({ template, inputs, n = 3 }) {
  const safeN = Math.max(1, Math.min(6, Number(n) || 1));

  // Variation tracks — one per output. We loop motion+lighting because those
  // change the feel the most without changing the message.
  const tracks = [
    { motion: 'slow_push',  lighting: 'soft_natural', cameraAngle: 'eye_level',  shotType: 'medium' },
    { motion: 'orbit',      lighting: 'hard_studio',  cameraAngle: 'low_angle',  shotType: 'product_only' },
    { motion: 'handheld',   lighting: 'golden_hour',  cameraAngle: 'over_shoulder', shotType: 'close_up' },
    { motion: 'static',     lighting: 'low_key_moody',cameraAngle: 'eye_level',  shotType: 'extreme_close' },
    { motion: 'slow_pull',  lighting: 'high_key',     cameraAngle: 'high_angle', shotType: 'wide' },
    { motion: 'parallax',   lighting: 'neon_night',   cameraAngle: 'dutch',      shotType: 'medium' },
  ].slice(0, safeN);

  return tracks.map((trackConstraints, i) => {
    const merged = { ...trackConstraints, ...(inputs.constraints || {}) };
    const built = buildFromTemplate(template, { ...inputs });
    const constraintsClause = renderConstraintsClause(merged);
    return {
      ...built,
      finalPrompt: `${built.finalPrompt}${constraintsClause}`,
      variantIndex: i,
      constraints: merged,
    };
  });
}

module.exports = {
  buildFromTemplate,
  buildFallbackPrompt,
  buildNegativePrompt,
  findBestTemplate,
  buildVariants,
  renderConstraintsClause,
  CONSTRAINT_VOCAB,
  STYLE_TAG_VOCAB,
  CONSTRAINT_AXES,
  GULF_CONTEXT_DEFAULTS,
};
