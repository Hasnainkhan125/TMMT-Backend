'use strict';

/**
 * Persona — a saved AI Influencer / Avatar / Character identity.
 *
 * The point of an AI influencer (vs. a one-shot face) is identity continuity:
 * "Layla" should look like the SAME Layla whether she's at Marina, in a
 * rooftop café, or driving down Sheikh Zayed Road. That only works if we
 * persist three things for each identity:
 *
 *   1. The vocabulary the user chose in the builder rail (attributes) —
 *      so every future scene re-uses the same identity tokens.
 *   2. The "hero" render — a canonical portrait we can feed back as a
 *      reference image into identity-preserving models
 *      (flux_kontext_pro, nano_banana_*_edit, seedream_*_edit).
 *   3. The seed prompt + model used to create the hero — so if the hero is
 *      ever lost/deleted we can regenerate with the exact same recipe
 *      instead of drifting to a new face.
 *
 * Scene renders generated off a persona are NOT stored on this document —
 * they're regular StudioJobs tagged `promptPipeline.strategy='persona_scene'`
 * with `extras.personaId` pointing back here. That keeps the asset pipeline,
 * credits ledger, and History list single-sourced on StudioJob.
 */

const mongoose = require('mongoose');

const personaSchema = new mongoose.Schema({
  // ── Ownership ────────────────────────────────────────────────────────────
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',  default: null, index: true },
  sessionId: { type: String, required: true, index: true },

  // ── Identity ─────────────────────────────────────────────────────────────
  // Free-form name the user gives the persona. Defaults to something like
  // "Layla" or "Avatar #3" if the user doesn't pick one — never blank so
  // the library UI always has a label to render.
  name: { type: String, required: true, trim: true, maxlength: 60 },

  // The tool the persona was created under — influences defaults in the UI
  // (avatar = headshot, character = full-body concept, influencer = lifestyle).
  kind: {
    type: String,
    enum: ['avatar', 'character', 'influencer'],
    default: 'influencer',
    index: true,
  },

  // Canonical builder attributes (characterType, gender, ethnicity, eyeColor,
  // skinMaterial, horns, etc.). We keep them as an open Mixed map — the
  // vocabulary is driven by the UI and may grow over time (new options for
  // fantasy characters, wearables, hair styles). Validating every possible
  // key in Mongoose would fight the UI instead of helping it.
  attributes: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Optional free-form refinement the user typed in the builder rail —
  // layered on top of attributes in the final prompt.
  userPrompt: { type: String, default: '', maxlength: 600 },

  // ── Hero (canonical portrait) ────────────────────────────────────────────
  heroJobId:   { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob',   default: null, index: true },
  heroAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null },
  // Denormalised for fast list rendering (library tiles don't need to
  // hydrate the Job + Asset documents just to show a thumbnail).
  heroImageUrl:     { type: String, default: null },
  heroThumbnailUrl: { type: String, default: null },

  // The recipe that created the hero — lets us regenerate deterministically
  // if the hero asset is ever lost or the user asks for an "alternate hero".
  seedPrompt:  { type: String, default: '' },
  seedModelId: { type: String, default: null },
  seedSeed:    { type: Number, default: null },  // numeric seed (when the provider exposes one)

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // 'draft'         = created but hero not enqueued yet (rare; only used by
  //                   imports from an uploaded photo where we skip the hero).
  // 'generating'    = hero job queued/running.
  // 'ready'         = hero completed and heroImageUrl populated.
  // 'failed'        = hero job failed terminally; user can retry.
  // 'archived'      = soft-deleted; hidden from the library.
  status: {
    type: String,
    enum: ['draft', 'generating', 'ready', 'failed', 'archived'],
    default: 'generating',
    index: true,
  },

  // ── Engagement stats (denormalised counters) ─────────────────────────────
  sceneCount: { type: Number, default: 0 },   // how many scenes have been rendered off this persona
  lastUsedAt: { type: Date, default: Date.now, index: true },

  // Free-form tags the user can attach (gym, restaurant, uae, female-lead…)
  // — not used for matching today but indexed so we can power a filter
  // without a schema change later.
  tags: [{ type: String, lowercase: true, trim: true }],

  // Optional uploaded reference — when the user imports an existing
  // portrait instead of generating one. When set, the hero pipeline skips
  // the render and flips status straight to 'ready' using this URL.
  importedReferenceUrl: { type: String, default: null },
}, { timestamps: true });

// Composite index for the "my library" query: userId + not archived,
// sorted by most-recently-used. Covers both logged-in and anon sessions.
personaSchema.index({ userId: 1, status: 1, lastUsedAt: -1 });
personaSchema.index({ sessionId: 1, status: 1, lastUsedAt: -1 });

module.exports = mongoose.model('Persona', personaSchema);
