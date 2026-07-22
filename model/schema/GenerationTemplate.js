/**
 * GenerationTemplate — the intelligence layer
 *
 * This is what was MISSING from the manifest.
 * The manifest tracks WHERE files live (asset inventory).
 * This schema tracks HOW to generate new content (generation blueprints).
 *
 * Sources mapped:
 *   - Higgsfield presets (higgsfield_presets_ads.json) → label/mode/product/avatar/cinematic prompt
 *   - Higgsfield community (higgsfield.json) → model/duration/resolution/engagement
 *   - TopView templates (topviewads.json) → i18nPrompts/supportedModels/modelParameters/pricing
 *   - Creatify (creatify raw JSON) → inputSchema/gen_type/plan_level
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─── Model parameter constraints (from TopView's absurdly detailed API data) ───
const modelParametersSchema = new Schema({
  // What kind of image input this model accepts
  inputImageMode: {
    type: String,
    enum: ['none', 'startFrame', 'endFrame', 'startEndFrame', 'reference', 'product'],
    default: 'none',
  },
  nativeAudio:     { type: Boolean, default: false },
  promptSupport:   [{ type: String, enum: ['positive', 'negative'] }],
  durations:       [Number],            // e.g. [4,5,6,7,8,9,10,11,12,13,14,15]
  resolutions:     [Number],            // e.g. [480, 720, 1080]
  maxPromptLength: { type: Number, default: 2000 },
  multiShotSupport:{ type: Boolean, default: false },
  maxShots:        { type: Number, default: 1 },
  minShotDuration: { type: Number, default: 3 },
  imageSpecLimits: {
    minHeight:           { type: Number, default: 300 },
    maxHeight:           { type: Number, default: 6000 },
    minWidth:            { type: Number, default: 300 },
    maxWidth:            { type: Number, default: 6000 },
    maxFileSizeBytes:    { type: Number, default: 31457280 }, // 30MB
    requireSameAspect:   { type: Boolean, default: false },
  },
}, { _id: false });

// ─── Per-model pricing (from TopView's pricing field) ────────────────────────
const modelPricingSchema = new Schema({
  modelId:         { type: String, required: true },
  creditsPer720s:  { type: Number, default: 1 },   // credits per second at 720p
  creditsPer480s:  { type: Number, default: 0.5 },
  creditsWithAudio:{ type: Number, default: 0 },   // additional cost for audio
}, { _id: false });

// ─── Input slot (what the user must provide to use this template) ─────────────
// Maps Creatify's inputSchema + Higgsfield's product/avatar spec
const inputSlotSchema = new Schema({
  key:      { type: String, required: true },  // e.g. "product_image", "avatar", "product_name"
  type:     {
    type: String,
    required: true,
    enum: ['image', 'text', 'dropdown', 'avatar', 'product_object', 'brand_kit'],
  },
  title:    { type: String },
  required: { type: Boolean, default: true },
  default:  { type: Schema.Types.Mixed },
  options:  [{ label: String, value: String }], // for dropdown type
  // Validation hints
  maxLength:     Number,
  allowedFormats:[String],
  maxFileSizeMB: Number,
}, { _id: false });

// ─── i18n prompts (from TopView's i18nPrompts — 9 languages) ─────────────────
const i18nPromptSchema = new Schema({
  en: String,
  ar: String,   // We add Arabic — none of the competitors have this
  zh: String,
  ja: String,
  ko: String,
  de: String,
  fr: String,
  es: String,
  pt: String,
  vi: String,
}, { _id: false });

// ─── i18n SEO (from TopView's i18nSeo) ───────────────────────────────────────
const i18nSeoSchema = new Schema({
  title:           String,
  description:     String,
  longDescription: String,
}, { _id: false });

// ─── Cinematic constraints ────────────────────────────────────────────────────
// Mirrors constraint vocabulary in services/constraintRender.js (used by
// promptBuilder_v2) so the
// frontend (constraints picker) and backend (prompt builder) speak the same
// vocabulary. Keep these enums tight — they get composed into the prompt as
// natural-language clauses.
const constraintsSchema = new Schema({
  // How the camera frames the action
  cameraAngle: {
    type: String,
    enum: [
      null, 'eye_level', 'low_angle', 'high_angle', 'birds_eye', 'over_shoulder',
      'dutch', 'pov', 'tracking', 'orbit',
    ],
    default: null,
  },
  // Quality and direction of light
  lighting: {
    type: String,
    enum: [
      null, 'natural', 'studio_softbox', 'golden_hour', 'blue_hour',
      'high_key', 'low_key', 'rim_light', 'backlit', 'neon', 'cinematic',
    ],
    default: null,
  },
  // Focal length / framing tightness
  shotType: {
    type: String,
    enum: [
      null, 'extreme_closeup', 'closeup', 'medium', 'medium_wide',
      'wide', 'extreme_wide', 'aerial', 'macro',
    ],
    default: null,
  },
  // Subject/camera motion
  motion: {
    type: String,
    enum: [
      null, 'static', 'slow_pan', 'fast_pan', 'tilt', 'dolly_in', 'dolly_out',
      'handheld', 'gimbal', 'whip_pan', 'crash_zoom',
    ],
    default: null,
  },
  // Pacing / cut frequency
  pace: {
    type: String,
    enum: [null, 'slow', 'medium', 'fast', 'frenetic'],
    default: null,
  },
  // Color/mood pass
  colorGrade: {
    type: String,
    enum: [
      null, 'natural', 'warm', 'cool', 'desaturated', 'high_contrast',
      'pastel', 'sepia', 'noir', 'vibrant',
    ],
    default: null,
  },
}, { _id: false });

// ─── Engagement scores (from Higgsfield community + Creatify scoring) ─────────
const engagementSchema = new Schema({
  viewsCount:    { type: Number, default: 0 },
  likesCount:    { type: Number, default: 0 },
  renderCount:   { type: Number, default: 0 },    // Creatify render_count
  downloadRatio: { type: Number, default: 0 },    // Creatify download_ratio
  finalScore:    { type: Number, default: 0 },    // Creatify final_score composite
  // Computed quality tier for curation (we add this — competitors don't expose it)
  qualityTier: {
    type: String,
    enum: ['hero', 'featured', 'standard', 'hidden'],
    default: 'standard',
  },
}, { _id: false });

// ─── Main template schema ─────────────────────────────────────────────────────
const generationTemplateSchema = new Schema({

  // ── Identity ─────────────────────────────────────────────────────────────
  source: {
    type: String,
    required: true,
    enum: [
      // Legacy origin tags — preserved for back-compat with already-ingested
      // documents but new ingests should use the Qumak families below.
      'higgsfield_preset',
      'higgsfield_community',
      'topview',
      'creatify',
      'qumak_original',
      // Qumak families — surfaced to the user as plain "Qumak templates".
      // The actual external origin (if any) is kept in `meta.originSource`.
      'qumak_cinematic',
      'qumak_product',
      'qumak_static',
    ],
  },
  sourceId:  { type: String, required: true },  // original ID from source
  sourceHash:{ type: String },                  // for dedup across re-ingests

  name:        { type: String, required: true },
  description: { type: String, default: '' },

  // ── Content type taxonomy ─────────────────────────────────────────────────
  // Maps Higgsfield label/mode/groups and Creatify category_tags/label_tags
  contentType: {
    type: String,
    required: true,
    enum: [
      // UGC styles
      'ugc_review', 'ugc_how_to', 'ugc_unboxing', 'ugc_virtual_try_on',
      'ugc_talking_head', 'ugc_lifestyle',
      // Product styles
      'product_hero', 'product_showcase', 'product_3d', 'product_cinematic',
      // Brand styles
      'brand_story', 'brand_lifestyle', 'brand_luxury',
      // Food/F&B specific
      'food_closeup', 'food_lifestyle',
      // Creative/cinematic
      'cinematic_scene', 'cinematic_lifestyle',
      // Recruitment / B2B
      'recruitment_ad', 'service_showcase',
      // General
      'general',
    ],
  },
  contentGroup: {
    type: String,
    enum: ['ugc', 'product', 'brand', 'food', 'cinematic', 'business', 'general'],
    default: 'general',
  },

  // ── Output spec ───────────────────────────────────────────────────────────
  outputType:     { type: String, enum: ['image', 'video', 'image_grid'], default: 'video' },
  aspectRatio:    { type: String, enum: ['1:1', '4:5', '9:16', '16:9', '3:4', '4:3'], default: '9:16' },
  defaultDuration:{ type: Number, default: 15 },   // seconds
  defaultResolution: { type: Number, default: 720 },

  // ── Prompt intelligence ───────────────────────────────────────────────────
  // The generation blueprint — this is what was COMPLETELY MISSING from the manifest.
  // Carries the full cinematic prompt with injection tokens.
  //
  // Injection tokens (normalized across sources):
  //   {product_image}   ← replaces @Image 1 (TopView) / <<<product:ID>>> (Higgsfield)
  //   {brand_name}      ← brand name substitution
  //   {product_name}    ← product title
  //   {product_desc}    ← product description
  //   {avatar}          ← avatar reference (Higgsfield)
  //   {hook_line}       ← first-line hook text (generated by our copy engine)
  //   {cta_line}        ← CTA text
  //
  // Scene-structure prompts (Higgsfield-style) carry second-by-second direction.
  // Style prompts (TopView-style) carry aesthetic direction + [Duration][Device][Style] grammar.
  promptBlueprint: {
    type: String,
    required: true,
    // Example (Higgsfield preset style):
    // "{product_image} A 15-second vertical UGC review. iPhone aesthetic.
    //  0-2s HOOK: {hook_line}. Presenter holds product close to camera.
    //  2-8s: Demonstrates key features with excitement.
    //  8-13s: Shows result/before-after.
    //  13-15s: {cta_line}. Clean final hero shot."
  },

  // Gulf/Arabic variant of the prompt — our moat, added by us, not from source
  promptBlueprintAr: { type: String, default: null },

  // i18n prompts (from TopView) — we add 'ar' which they never had
  i18nPrompts: { type: i18nPromptSchema, default: () => ({}) },

  // i18n SEO metadata
  i18nSeo: { type: Map, of: i18nSeoSchema, default: () => new Map() },

  // Gulf-specific context modifier appended at prompt-build time
  // These are the 120-char vibes strings from promptBuilder.js, but now
  // they live on the template, not hardcoded in the worker.
  gulfContextModifier: { type: String, default: null },

  // Negative prompt
  negativePrompt: { type: String, default: '' },

  // ── Model routing ─────────────────────────────────────────────────────────
  // Which models can render this template (from TopView's supportedModels)
  supportedModels: [{
    type: String,
    enum: [
      // Video models
      'seedance_2.0', 'seedance_2.0_fast', 'seedance_1.5_pro',
      'kling_3.0', 'kling_o1_edit', 'kling_motion_control',
      'sora_2', 'veo_3.1', 'veo_3.1_lite',
      'minimax_hailuo_2.3', 'grok_video',
      'wan_2.7', 'higgsfield_marketing_studio',
      // Image models
      'flux_schnell', 'flux_pro', 'flux_1.1_pro',
      'gpt_image_1', 'nano_banana_pro', 'nano_banana_2',
      'seedream_5.0', 'grok_imagine',
      // Generic
      'auto',
    ],
  }],
  recommendedModel: { type: String, default: 'auto' }, // best model for this template
  modelParameters:  { type: modelParametersSchema, default: () => ({}) },
  modelPricing:     [modelPricingSchema],

  // ── Input requirements ────────────────────────────────────────────────────
  // Maps Creatify's inputSchema + Higgsfield's product/avatar requirements.
  // The frontend reads this to build the generation form dynamically.
  inputSlots: [inputSlotSchema],

  // Convenience flags derived from inputSlots
  requiresProductImage: { type: Boolean, default: false },
  requiresAvatar:       { type: Boolean, default: false },
  requiresBrandKit:     { type: Boolean, default: false },

  // ── Business/category intelligence ───────────────────────────────────────
  // Which business categories this template works well for
  bestCategories: [{
    type: String,
    enum: [
      'restaurant', 'cafe', 'food_delivery',
      'perfume', 'fashion', 'jewelry', 'beauty', 'skincare', 'haircare',
      'realestate', 'interior',
      'gym', 'sports', 'wellness',
      'tech', 'saas', 'app',
      'ecommerce', 'retail',
      'automotive',
      'hotel', 'travel',
      'education',
      'general',
    ],
  }],
  bestPlatforms: [{
    type: String,
    enum: ['instagram', 'tiktok', 'facebook', 'youtube', 'snapchat', 'whatsapp', 'general'],
  }],
  locale: { type: String, enum: ['gulf', 'global', 'both'], default: 'both' },

  // ── Media assets (from manifest — R2 URLs only) ───────────────────────────
  media: {
    coverUrl:      { type: String },   // thumbnail image
    previewVideo:  { type: String },   // short compressed preview
    referenceImage:{ type: String },   // reference/style image
    showcases:     [String],           // multiple output examples
    // Multiple still previews — usually 3–6 hand-picked frames a designer
    // can scrub through. Used by TemplateCard hover and the Detail dialog.
    previewImages: [String],
  },

  // ── Default cinematic constraints baked into the template ─────────────────
  // These flow into promptBuilder_v2.buildFromTemplate({ constraints }) and
  // can be overridden per-generation by the user in the Studio create page.
  constraints: { type: constraintsSchema, default: () => ({}) },

  // ── Hook tags (for hookGenerator + analytics) ─────────────────────────────
  // Short labels describing the kind of opening hooks this template uses well.
  // Free-form (we control the vocabulary in the seed/ingest scripts) so we
  // can iterate on hook taxonomy without schema migrations.
  hookTags: {
    type: [String],
    default: [],
    index: true,
  },

  // ── Engagement & curation ─────────────────────────────────────────────────
  engagement: { type: engagementSchema, default: () => ({}) },

  // Curation flags
  isFeatured:   { type: Boolean, default: false, index: true },
  isActive:     { type: Boolean, default: true,  index: true },
  isNewArrival: { type: Boolean, default: false },
  planLevel:    { type: String, enum: ['free', 'starter', 'pro', 'agency'], default: 'free' },

  // ── Internal-only metadata ────────────────────────────────────────────────
  // Anything we want to keep alongside the template that isn't user-facing —
  // e.g. the original `originSource: 'higgsfield'` so we can re-ingest later
  // without losing provenance. Never returned by the public templates API.
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Gulf seasonal packs ───────────────────────────────────────────────────
  // Our moat — competitors have zero seasonal intelligence
  seasonalPacks: [{
    type: String,
    enum: ['ramadan', 'eid_fitr', 'eid_adha', 'uae_national_day', 'ksa_national_day',
           'new_year', 'valentine', 'mothers_day', 'back_to_school', 'summer'],
  }],

}, { timestamps: true });

// ── Indexes ──────────────────────────────────────────────────────────────────
generationTemplateSchema.index({ source: 1, sourceId: 1 }, { unique: true });
generationTemplateSchema.index({ contentType: 1, isActive: 1 });
generationTemplateSchema.index({ bestCategories: 1, locale: 1, isActive: 1 });
generationTemplateSchema.index({ contentGroup: 1, outputType: 1 });
generationTemplateSchema.index({ 'engagement.finalScore': -1 });
generationTemplateSchema.index({ isFeatured: 1, isActive: 1 });
generationTemplateSchema.index({ seasonalPacks: 1 });
generationTemplateSchema.index({ supportedModels: 1 });
generationTemplateSchema.index({ planLevel: 1, isActive: 1 });

// ── Static helpers ────────────────────────────────────────────────────────────
// Build the final prompt by substituting injection tokens with actual values
generationTemplateSchema.statics.buildPrompt = function(blueprint, substitutions = {}) {
  let prompt = blueprint;
  for (const [key, value] of Object.entries(substitutions)) {
    if (value) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    } else {
      // Remove unfilled optional tokens
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), '');
    }
  }
  // Clean up double spaces from removed tokens
  return prompt.replace(/\s{2,}/g, ' ').trim();
};

// Get best model for a given output type and tier
generationTemplateSchema.statics.selectModel = function(template, tier = 'free') {
  if (template.recommendedModel && template.recommendedModel !== 'auto') {
    return template.recommendedModel;
  }
  // Fall back to first supported model
  if (template.supportedModels?.length > 0) {
    return template.supportedModels[0];
  }
  // Ultimate fallback by output type
  return template.outputType === 'video' ? 'seedance_2.0' : 'flux_schnell';
};

const GenerationTemplate = mongoose.model('GenerationTemplate', generationTemplateSchema);
module.exports = { GenerationTemplate };
