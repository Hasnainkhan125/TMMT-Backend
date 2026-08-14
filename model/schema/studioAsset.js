'use strict';

const mongoose = require('mongoose');

const studioAssetSchema = new mongoose.Schema({
  jobId:        { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', required: true, index: true },
  sessionId:    { type: String, required: true, index: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  category:     { type: String, default: '' },
  brandName:    { type: String, default: '' },
  
  scanId:       { type: mongoose.Schema.Types.ObjectId, ref: 'UrlToAdsScan', default: null, index: true },
  adIndex:      { type: Number, default: null },
  adSetId:      { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  productId:    { type: String, default: null, index: true },
  source:       { type: String, enum: ['url_to_ads_scan', 'per_product', 'studio_direct'], default: 'studio_direct', index: true },


  type:         { type: String, enum: ['video', 'image_hd', 'image_lifestyle'], default: 'video' },
  /** When set, this row is one of N variant outputs for the same job (multi-variant / edit pipelines). */
  variantIndex: { type: Number, default: null, index: true },
  status:       { type: String, enum: ['processing', 'completed', 'failed'], default: 'completed' },

  url:              { type: String, default: null },   // main URL (watermarked or clean)
  watermarkedUrl:   { type: String, default: null },
  cleanUrl:         { type: String, default: null },
  thumbnailUrl:     { type: String, default: null },
  mimeType:         { type: String, default: 'video/mp4' },
  fileSize:         { type: Number, default: null },
  resolution:       { type: String, default: null },

  tier:             { type: String, enum: ['free', 'starter', 'pro', 'agency'], default: 'free' },
  isWatermarked:    { type: Boolean, default: true },

  // Quality + engagement signals
  rating:           { type: Number, enum: [1, -1, 0], default: 0 },
  shareCode:        { type: String, index: true, sparse: true, default: null },
  shareViewCount:   { type: Number, default: 0 },
  copyGenCount:     { type: Number, default: 0 },
  downloadCount:    { type: Number, default: 0 },
  downloadedAt:     { type: Date, default: null },

  // ─── WhatsApp delivery tracking ─────────────────────────────────────────
  whatsappSendCount: { type: Number, default: 0 },
  whatsappSends: [{
    to:       String,
    sid:      String,
    sentAt:   { type: Date, default: Date.now },
    sentBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    language: { type: String, enum: ['en', 'ar', 'both'], default: 'both' },
  }],

  // ─── One-click campaign launches (Meta + Snap MENA, etc.) ───────────────
  // Populated by /facebook/launch-campaign and /snap/launch-campaign.
  // Kept on the asset (not a separate collection) because each asset has
  // very few launches — capped via the `launches` UI to ≤10 per asset.
  campaigns: [{
    platform:        { type: String, enum: ['meta', 'snap', 'tiktok'], required: true },
    campaignId:      String,
    adSetId:         String,    // Meta = ad_set, Snap = ad_squad
    creativeId:      String,
    adId:            String,
    status:          { type: String, default: 'PAUSED' },
    dailyBudgetAed:  Number,
    countries:       [String],
    launchedAt:      { type: Date, default: Date.now },
    launchedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes:           String,
  }],
}, { timestamps: true });

module.exports = mongoose.model('StudioAsset', studioAssetSchema);
