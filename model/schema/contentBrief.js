'use strict';

const mongoose = require('mongoose');

const contentBriefSchema = new mongoose.Schema({
  brandId:   { type: mongoose.Schema.Types.ObjectId, ref: 'AutonomousBrand', required: true, index: true },

  platform:    { type: String, required: true },
  outputKind:  { type: String, enum: ['image', 'video'], required: true },
  aspectRatio: { type: String, default: '4:5' },

  angle:   { type: String, default: 'lifestyle moment' },
  product: {
    name:       { type: String, default: null },
    price:      { type: Number, default: null },
    currency:   { type: String, default: 'AED' },
    imageUrl:   { type: String, default: null },
    productUrl: { type: String, default: null },
  },

  script:   { type: String, default: null },
  caption:  { type: String, default: null },
  hashtags: { type: [String], default: [] },

  studioJobId:  { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null, index: true },
  assetUrl:     { type: String, default: null },
  thumbnailUrl: { type: String, default: null },

  qualityStatus:   { type: String, enum: ['pending', 'passed', 'failed', 'human_review'], default: 'pending' },
  qualityReasons:  { type: [String], default: [] },
  qualityAttempts: { type: Number, default: 0 },

  scheduledFor:   { type: Date, required: true, index: true },
  postedAt:       { type: Date, default: null },
  platformPostId: { type: String, default: null },

  status: {
    type: String,
    enum: ['pending', 'generating', 'quality_check', 'ready', 'posted', 'failed', 'skipped'],
    default: 'pending',
    index: true,
  },

  error: { type: String, default: null },
}, { timestamps: true });

contentBriefSchema.index({ brandId: 1, scheduledFor: 1 });
contentBriefSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model('ContentBrief', contentBriefSchema);
