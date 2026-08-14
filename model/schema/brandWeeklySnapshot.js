'use strict';

const mongoose = require('mongoose');

const brandWeeklySnapshotSchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    weekOf: { type: Date, required: true, index: true },
    competitorAdsSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    instagramMetricsSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

brandWeeklySnapshotSchema.index({ brandId: 1, weekOf: -1 });

module.exports = mongoose.models.BrandWeeklySnapshot
  || mongoose.model('BrandWeeklySnapshot', brandWeeklySnapshotSchema);
