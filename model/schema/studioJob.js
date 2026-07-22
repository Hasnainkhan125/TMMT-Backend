'use strict';

/**
 * studioJob.js — v3
 *
 * WHAT CHANGED FROM v2:
 *   1. category: enum → String with index. intentEngine classifies domains
 *      freely ('fashion', 'streetwear', 'automotive_luxury', Arabic tokens).
 *      The enum was silently rejecting saves AFTER the controller passed
 *      Zod validation. Worst kind of bug — credits charged, job not saved.
 *
 *   2. promptPipeline.strategy: enum → String. intentEngine emits intent
 *      types like 'ad_image', 'creative_video', 'director', 'url_to_ad' —
 *      the old enum of ['normal','business','template'] rejected all of them.
 *
 *   3. Added promptPipeline.intentType, domain, gulfRelevant, confidence
 *      so the worker + analytics can read classification output without
 *      JSON-stuffing it into `extras`.
 *
 *   4. Added `output.variants[]` for multi-variant image generation so the
 *      worker can store N draft URLs against a single job (no sibling job
 *      explosion for the common "4 drafts" case).
 *
 *   5. Added index on (sessionId, createdAt) — the free-tier monthly count
 *      query ran a collection scan for every generation.
 *
 * MIGRATION: existing rows with old enum values remain readable. New writes
 * use the open string. No data backfill needed.
 */

const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  startedAt:   { type: Date, required: true },
  completedAt: { type: Date, default: null },
  metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

// Individual variant output — used when a single job produces N images.
// Persisting variants on the parent job avoids creating N StudioJob docs
// for every generation (which would blow out the jobs list + ledger).
const variantOutputSchema = new mongoose.Schema({
  index:        { type: Number, required: true },        // 0..N-1
  rawUrl:       { type: String, default: null },
  storedUrl:    { type: String, default: null },
  watermarkedUrl:{ type: String, default: null },
  cleanUrl:     { type: String, default: null },
  thumbnailUrl: { type: String, default: null },
  assetId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null },
  seed:         { type: String, default: null },
  // Snapshot of the constraints used for THIS variant (so "variant 2" can
  // be re-rendered with the same direction even if the parent constraints
  // changed).
  constraints:  { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const studioJobSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sessionId: { type: String, required: true, index: true },

  // Category is an OPEN STRING. intentEngine classifies it — could be any
  // of the built-in DOMAIN_DNA keys, a new one, or an Arabic domain name.
  // We keep it indexed for analytics filtering but no longer validated.
  category: { type: String, default: 'unclassified', index: true },

  userInputs: {
    brandName:         { type: String, maxlength: 100, default: '' },
    description:       { type: String, maxlength: 4000, default: '' },
    prompt:            { type: String, maxlength: 4000, default: '' },
    userCopy:          { type: String, maxlength: 600, default: '' },  // VO line spoken by TTS
    targetAudience:    { type: String, maxlength: 500, default: '' },
    vibe:              { type: String, maxlength: 80, default: '' },
    locale:            { type: String, enum: ['gulf', 'global'], default: 'gulf' },
    aspectRatio:       { type: String, enum: ['16:9','9:16','1:1','4:5','3:4','4:3'], default: '16:9' },
    duration:          { type: Number},
    referenceImageUrl: { type: String, default: null },
    referenceImageUrls: { type: [String], default: [] },
    endFrameUrl:       { type: String, default: null },
    resolution:        { type: String, default: null },
    motion:            { type: String, default: null },
    sceneIndex:        { type: Number, default: null },
    sceneCount:        { type: Number, default: null },
    constraints:       { type: mongoose.Schema.Types.Mixed, default: {} },
    extras:            { type: mongoose.Schema.Types.Mixed, default: {} },
    _providerInput:    { type: mongoose.Schema.Types.Mixed, default: {} },
    audio: {
      enabled:    { type: Boolean, default: false },
      mode:       { type: String, enum: ['native', 'tts', 'upload'], default: 'native' },
      script:     { type: String, default: null },
      voiceId:    { type: String, default: null },
      language:   { type: String, default: null },
      musicStyle: { type: String, default: null },
      audioUrl:   { type: String, default: null },
    },
  },

  promptPipeline: {
    rawUserIntent:   { type: String, default: '' },
    enhancedPrompt:  { type: String, default: '' },
    finalPrompt:     { type: String, default: '' },
    negativePrompt:  { type: String, default: '' },
    refinementNotes: { type: String, default: '' },
    // OPEN STRING — intentEngine emits 'creative_image', 'ad_video', 'director',
    // 'url_to_ad', 'template', etc. Enum dropped.
    strategy:        { type: String, default: 'unknown', index: true },
    // New fields — read by analytics, worker, admin dashboard
    intentType:      { type: String, default: null, index: true },
    domain:          { type: String, default: null, index: true },
    gulfRelevant:    { type: Boolean, default: true },
    confidence:      { type: Number, default: 0.5 },
    // Which prompt source contributed the user's scene text — helps us
    // debug "why did my prompt get ignored" complaints.
    sceneFromUser:   { type: Boolean, default: false },
  },

  stages: { type: [stageSchema], default: [] },

  status: {
    type: String,
    enum: ['queued','prompt_building','generating','upscaling',
           'postprocessing','storing','completed','failed','cancelled'],
    default: 'queued',
    index: true,
  },

  progress:      { type: Number, min: 0, max: 100, default: 0 },
  statusMessage: { type: String, default: 'Initializing...' },

  falJobId:    { type: String, default: null },
  falResponse: { type: mongoose.Schema.Types.Mixed, default: null },

  output: {
    rawVideoUrl:    { type: String, default: null },
    storedVideoUrl: { type: String, default: null },
    rawImageUrl:    { type: String, default: null },
    storedImageUrl: { type: String, default: null },
    thumbnailUrl:   { type: String, default: null },
    watermarkedUrl: { type: String, default: null },
    cleanUrl:       { type: String, default: null },
    duration:       { type: Number, default: null },
    resolution:     { type: String, default: null },
    fileSize:       { type: Number, default: null },
    mimeType:       { type: String, default: 'video/mp4' },
    // Multi-variant image output — populated when variantsRequested > 1
    variants:       { type: [variantOutputSchema], default: [] },
  },

  kind: { type: String, enum: ['image','video'], default: 'video', index: true },
  tier: { type: String, enum: ['free','starter','pro','agency'], default: 'free' },

  isWatermarked: { type: Boolean, default: true },

  generationTimeMs:    { type: Number, default: null },
  totalPipelineTimeMs: { type: Number, default: null },
  falCostUsd:          { type: Number, default: null },

  error: {
    message: { type: String, default: null },
    code:    { type: String, default: null },
    stack:   { type: String, default: null },
  },

  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 2 },

  templateId:        { type: mongoose.Schema.Types.ObjectId, ref: 'GenerationTemplate', default: null, index: true },
  modelId:           { type: String, default: null, index: true },
  falModelId:        { type: String, default: null },
  variantsRequested: { type: Number, default: 1, min: 1, max: 6 },
  variantIndex:      { type: Number, default: 0 },
  parentJobId:       { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null, index: true },

  creditsCharged:  { type: Number, default: 0 },
  creditsRefunded: { type: Number, default: 0 },
  ledgerEntryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CreditLedger', default: null },

  assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null, index: true },

  startedAt:   { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

// ─── Compound indexes ───────────────────────────────────────────────────────
// The free-tier monthly-cap query did a collection scan every time:
//   StudioJob.countDocuments({ sessionId, status: { $in: [...] }, createdAt: { $gte: monthStart } })
// This index makes it an index-only lookup.
studioJobSchema.index({ sessionId: 1, createdAt: -1 });

// The history/list query pattern: find jobs for (user OR session), sorted by
// recency. Mongo picks the most selective single-field index for the OR and
// does an in-memory sort; this compound ensures both sides hit an index.
studioJobSchema.index({ userId: 1, createdAt: -1 });

// Analytics — "what's trending by domain this week"
studioJobSchema.index({ 'promptPipeline.domain': 1, createdAt: -1 });

// ─── Instance methods ───────────────────────────────────────────────────────
studioJobSchema.methods.addStage = function (name, metadata = {}) {
  this.stages.push({ name, startedAt: new Date(), metadata });
};

studioJobSchema.methods.completeStage = function (name, metadata = {}) {
  const stage = this.stages.find(s => s.name === name && !s.completedAt);
  if (stage) {
    stage.completedAt = new Date();
    Object.assign(stage.metadata, metadata);
  }
};

// New: record a variant URL atomically
studioJobSchema.methods.addVariant = function (variant) {
  if (!this.output) this.output = {};
  if (!this.output.variants) this.output.variants = [];
  this.output.variants.push(variant);
};

module.exports = mongoose.model('StudioJob', studioJobSchema);
