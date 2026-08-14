'use strict';

/**
 * AiModel — a single source of truth for every generative model exposed
 * to the user in the Studio model picker.
 *
 * Why this lives in Mongo (and not just a static JSON):
 *   - we want to flip a model on/off without redeploying
 *   - cost in credits changes monthly as fal.ai re-prices
 *   - the frontend reads `logoUrl` for the model picker chip
 *
 * One document per model. `id` is the slug the frontend stores; `falModelId`
 * is what we actually pass to @fal-ai/client (so we can A/B underlying
 * providers without touching the UI).
 */

const mongoose = require('mongoose');

const aiModelSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true }, // slug e.g. 'nano_banana_2'
  label: { type: String, required: true },            // display name
  shortLabel: { type: String, default: null },        // optional pill-friendly shorter label
  description: { type: String, default: '' },

  // Provider routing — what we actually call.
  provider: {
    type: String,
    enum: ['fal', 'openai','gemini', 'replicate', 'higgsfield', 'creatify', 'qumak'],
    default: 'fal',
  },
  falModelId: { type: String, default: null },        // e.g. 'fal-ai/flux/schnell'
  falVideoModelId: { type: String, default: null },   // optional second endpoint (img2video etc.)

  // Capability matrix.
  kind: { type: String, enum: ['image', 'video', 'both'], required: true, index: true },

  // For video models: is this a text-to-video or image-to-video variant?
  // Used by reelService.promoteToImageToVideoIfFramesPresent() to auto-swap
  // a user-selected t2v model for its i2v sibling when frame URLs are
  // attached, instead of silently dropping the frames at the provider boundary.
  videoVariant: { type: String, enum: ['t2v', 'i2v','r2v','v2v', null], default: null },
  // Slug of the matching image-to-video sibling for this model. Only set on
  // t2v entries; the reel promoter reads this to decide what to upgrade to.
  i2vSibling: { type: String, default: null },
  supportsReferenceImage: { type: Boolean, default: false },
  supportsCharacterLock:  { type: Boolean, default: false },
  supportsAudio:          { type: Boolean, default: false },
  supportedAspectRatios:  [{ type: String }],          // ['1:1','9:16','16:9','3:4','4:3']
  supportedDurations:     [{ type: Number }],          // for video: e.g. [5,10]
  maxResolution:          { type: Number, default: 1024 },

  // Extended capability manifest (Phase 1).
  //
  // The UI uses these fields to render model-specific controls (end-frame
  // slot, motion slider, multi-shot toggle, resolution picker). The backend
  // uses `providerParamMap` to declaratively build the provider payload —
  // so adding a new model is a pure data change, no router code edits.
  capabilities: {
    supportsEndFrame:       { type: Boolean, default: false },
    supportsNegativePrompt: { type: Boolean, default: false },
    supportsSeed:           { type: Boolean, default: true  },
    supportsMotionControl:  { type: Boolean, default: false },
    supportsMultiShot:      { type: Boolean, default: false },
    supportedResolutions:   [{ type: String }],        // ['720p','1080p','4k']
    // Field names the UI collects → the field names the provider expects.
    // e.g. Kling wants 'image_url' for the i2v start frame, Seedance wants
    // 'image_url' too, but Nano Banana Pro edit wants 'image_urls' array.
    providerParamMap: {
      referenceImageUrl: { type: String, default: 'image_url' },
      endFrameUrl:       { type: String, default: 'end_image_url' },
      duration:          { type: String, default: 'duration' },
      motion:            { type: String, default: 'motion_bucket_id' },
      negativePrompt:    { type: String, default: 'negative_prompt' },
    },
    // Fields that MUST be present on the request for this model. The
    // controller validates this before queueing so errors surface at the
    // API boundary, not inside fal half a minute later.
    requiredFields: [{ type: String }],                // e.g. ['referenceImageUrl']
    // Audio (Studio video / reel / UGC). Falls back to root `supportsAudio` when unset.
    audio: {
      supportsNativeAudio: { type: Boolean, default: false },
      supportsAudioUrl:    { type: Boolean, default: false },
      requiresAudio:       { type: Boolean, default: false },
      audioParamKey:       { type: String, default: null },
      audioUrlParamKey:    { type: String, default: 'audio_url' },
    },

    // inputSlots: [{
    //   key:         { type: String, required: true },  // semantic key: 'startFrame', 'refImages', 'elements'
    //   type:        { 
    //     type: String, 
    //     enum: ['image', 'image_array', 'video', 'video_array', 'audio_array', 
    //            'string', 'string_array', 'enum', 'number', 'boolean', 'element_array'],
    //     required: true 
    //   },
    //   providerKey: { type: String, required: true },  // 'image_url', 'image_urls', 'elements', etc
    //   required:    { type: Boolean, default: false },
    //   minItems:    { type: Number, default: null },
    //   maxItems:    { type: Number, default: null },
    //   options:     [String],  // for enums
      
    //   // For element_array (Kling-style nested objects)
    //   elementShape: {
    //     fields: [{
    //       key:         String,
    //       providerKey: String,
    //       type:        String,  // 'image' | 'image_array' | 'video'
    //       required:    Boolean,
    //       maxItems:    Number,
    //     }],
    //     // Mutually exclusive groups: e.g. Kling element = either {frontal+refs} OR {video_url}
    //     oneOfGroups: [[String]],
    //   },
      
    //   // UI hints for ModelInputRenderer
    //   uiLabel: String,
    //   uiHint:  String,
    //   uiOrder: Number,
    // }],
    
    // // NEW: Cross-slot constraints
    // constraints: [{
    //   type:    { type: String, enum: ['sum_max', 'requires_one_of', 'mutual_exclusive'] },
    //   fields:  [String],
    //   value:   Number,    // for sum_max
    //   message: String,
    // }],

    inputSlots:  [{ type: mongoose.Schema.Types.Mixed }],
    constraints: [{ type: mongoose.Schema.Types.Mixed }],

    
    // NEW: How the FE picker renders this model's controls
    uiVariant: {
      type: String,
      enum: ['t2i_simple', 'i2i_edit', 't2v_simple', 'i2v_simple', 'i2v_with_end',
             'i2v_lipsync', 'ref2v_multi_image', 'ref2v_with_video_refs', 
             'ref2v_elements', 'multi_shot', 'lipsync_only'],
      default: 't2i_simple',
    },
  },

  // Internal cost baselines (finance / margin). Not exposed to FE by default.
  providerCostUsdEstimate: { type: Number, default: null },
  lastCostRefreshAt:       { type: Date, default: null },

  // Pricing.
  // Cost is expressed in QUMAK CREDITS (1 credit ≈ AED 0.50 retail).
  creditsPerImage:        { type: Number, default: 1 },
  creditsPerSecondVideo:  { type: Number, default: 1 },
  // For burst pricing where the first N seconds cost a flat rate.
  baseCreditsForVideo:    { type: Number, default: 0 },

  // Plan gating.
  minPlan: { type: String, enum: ['free', 'starter', 'pro', 'agency'], default: 'free', index: true },

  // UI presentation.
  logoUrl:    { type: String, required: true },        // small square PNG/SVG
  badge:      { type: String, default: null },         // 'New', 'Beta', 'Hot' etc.
  sortOrder:  { type: Number, default: 100 },          // lower = earlier in picker
  isDefault:  { type: Boolean, default: false },       // exactly one per kind should be true

  // Operational.
  isActive: { type: Boolean, default: true, index: true },

}, { timestamps: true });

aiModelSchema.index({ kind: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.models.AiModel || mongoose.model('AiModel', aiModelSchema);
