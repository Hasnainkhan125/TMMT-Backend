'use strict';

const mongoose = require('mongoose');

/**
 * Brand — deduplicated brand identity graph shared across all Qumak users.
 *
 * The critical architectural decision: brands are NOT per-user. If ten
 * users all paste `nike.com`, we run ONE collection run, store ONE brand
 * record, generate ONE counter-strategy, and serve it to all ten users.
 * Every additional user on the same brand is free — that's what makes the
 * unit economics work at AED 20k MRR and beyond.
 *
 * Shape choices:
 *   - `canonicalDomain` is unique; `aliases` holds legacy/regional variants.
 *   - `identity` is the full BrandIdentity payload (Mixed) so we can evolve
 *     the resolver without migrations.
 *   - `lastCollectionAt` / `nextEnrichAt` drive the refresh cadence.
 */
const brandSchema = new mongoose.Schema(
  {
    canonicalDomain: { type: String, required: true, unique: true, index: true },
    brandName:       { type: String, required: true },
    aliases:         { type: [String], default: [] },

    markets:   { type: [String], default: [] },
    languages: { type: [String], default: [] },

    /** Full BrandIdentity payload from the resolver. */
    identity: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Convenience mirrors — indexed for lookup without descending into .identity. */
    handles: { type: mongoose.Schema.Types.Mixed, default: {} },

    knownLandingDomains: { type: [String], default: [] },

    /** Latest counter-strategy produced by the composer. Cached; refreshed on cadence. */
    lastStrategy:    { type: mongoose.Schema.Types.Mixed, default: null },
    lastStrategyAt:  { type: Date, default: null },

    /** Latest collection metadata (sources healthy, coverage score). */
    lastCollection: { type: mongoose.Schema.Types.Mixed, default: null },

    resolvedAt:      { type: Date, default: null },
    lastEnrichedAt:  { type: Date, default: null },
    nextEnrichAt:    { type: Date, default: null },
  },
  { timestamps: true }
);

brandSchema.index({ 'handles.facebookPageUrl': 1 });
brandSchema.index({ 'handles.instagramHandle': 1 });
brandSchema.index({ lastEnrichedAt: -1 });

module.exports = mongoose.models.Brand
  || mongoose.model('Brand', brandSchema);
