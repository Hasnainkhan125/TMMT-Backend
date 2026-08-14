'use strict';

const mongoose = require('mongoose');

/**
 * CollectionRun — one attempt by the orchestrator to pull data from the
 * Layer-2 source network for a given brand.
 *
 * We store one row per run so operators can see, at a glance:
 *   - which sources succeeded vs failed vs were short-circuited
 *   - how long each source took
 *   - whether the run is still backfilling or complete
 *
 * Raw scraped payloads are NOT stored here (they live compressed under
 * rawCollectionData) — this collection is intentionally small so we can
 * index/aggregate it freely.
 */
const sourceReportSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    status: { type: String, enum: ['ok', 'failed', 'skipped', 'circuit_open', 'timeout'], required: true },
    durationMs: { type: Number, default: 0 },
    fromCache: { type: Boolean, default: false },
    reason: { type: String, default: null },
    recordsCollected: { type: Number, default: 0 },
  },
  { _id: false }
);

const collectionRunSchema = new mongoose.Schema(
  {
    brandId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    triggeredBy: { type: String, enum: ['scan', 'refresh', 'background', 'manual'], default: 'scan' },
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    startedAt:   { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    durationMs:  { type: Number, default: 0 },

    sources: [sourceReportSchema],
    sourcesAttempted: { type: [String], default: [] },
    sourcesSucceeded: { type: [String], default: [] },

    /** Refs to BrandSignal documents generated from this run. */
    signalsGenerated: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BrandSignal' }],

    coverageScore: { type: Number, default: 0, min: 0, max: 1 },

    status: {
      type: String,
      enum: ['running', 'complete', 'partial', 'failed'],
      default: 'running',
      index: true,
    },

    error: { type: String, default: null },
  },
  { timestamps: true }
);

collectionRunSchema.index({ brandId: 1, startedAt: -1 });

module.exports = mongoose.models.CollectionRun
  || mongoose.model('CollectionRun', collectionRunSchema);
