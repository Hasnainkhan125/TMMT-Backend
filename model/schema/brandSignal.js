'use strict';

const mongoose = require('mongoose');

/**
 * BrandSignal — a single extracted insight about a brand.
 *
 * Signals are the output of Layer 3 extractors (hook-pattern, offer-structure,
 * audience-angle, visual-motif, competitive-gap). They're long-lived because:
 *   1. Re-running the extractor with a new version should ADD signals, not
 *      overwrite history — we want to see drift over time.
 *   2. The scoring layer re-evaluates composite scores on read, so freshness
 *      changes the ranking without rewriting rows.
 *   3. Debug / eval workflows need the full evidence trail.
 *
 * The `payload` field is Mixed — every extractor serializes its own shape,
 * but they all conform to the Signal TS interface documented in the
 * architecture brief: summary, detail, supportingEvidence[], actionable.
 */
const brandSignalSchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    kind: {
      type: String,
      enum: [
        'hook_pattern',
        'offer_structure',
        'audience_angle',
        'visual_motif',
        'funnel_stage',
        'timing_pattern',
        'competitive_gap',
      ],
      required: true,
      index: true,
    },

    /** For reproducibility & migrations. Bump when the extractor logic changes. */
    extractorVersion: { type: String, required: true, default: '1.0.0' },

    /** 0-1 confidence as emitted by the extractor itself. */
    confidence: { type: Number, default: 0, min: 0, max: 1 },

    /** 0-100 composite as computed by the scoring layer; updated on refresh. */
    compositeScore: { type: Number, default: 0, min: 0, max: 100 },
    tier: { type: String, enum: ['hero', 'strong', 'supporting', 'noise'], default: 'supporting' },

    /** The full Signal object — summary, detail, supportingEvidence, actionable. */
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Which sources supported this signal — used by scoring for source-diversity. */
    sourceTypes: { type: [String], default: [] },

    extractedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

brandSignalSchema.index({ brandId: 1, kind: 1, extractedAt: -1 });
brandSignalSchema.index({ brandId: 1, compositeScore: -1 });

module.exports = mongoose.models.BrandSignal
  || mongoose.model('BrandSignal', brandSignalSchema);
