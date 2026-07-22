'use strict';

const mongoose = require('mongoose');

const catalogItemSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  price:      { type: Number, default: null },
  currency:   { type: String, default: 'AED' },
  imageUrl:   { type: String, default: null },
  productUrl: { type: String, default: null },
  priority:   { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
}, { _id: false });

const personaSchema = new mongoose.Schema({
  name:              { type: String, required: true },
  templateId:        { type: String, default: null },
  referenceImageUrl: { type: String, required: true },
  referenceAngles:   { type: [String], default: [] },
  voiceId:           { type: String, default: null },
  age:               { type: Number, default: 28 },
  ethnicity:         { type: String, default: null },
  outfitStyle:       { type: String, default: null },
}, { _id: false });

const platformTokenSchema = new mongoose.Schema({
  platform:     { type: String, required: true },
  accessToken:  { type: String, required: true },
  refreshToken: { type: String, default: null },
  expiresAt:    { type: Date, default: null },
  accountId:    { type: String, default: null },
  accountName:  { type: String, default: null },
}, { _id: false });

const autonomousBrandSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  brandName:   { type: String, required: true, maxlength: 100 },
  description: { type: String, maxlength: 800, default: '' },
  category:    { type: String, default: 'general', index: true },
  locale:      { type: String, enum: ['gulf', 'global'], default: 'gulf' },
  timezone:    { type: String, default: 'Asia/Dubai' },

  persona: { type: personaSchema, required: true },
  catalog: { type: [catalogItemSchema], default: [] },

  postingSchedule: {
    postsPerDay: { type: Number, default: 2, min: 1, max: 4 },
    postTimes:   { type: [String], default: ['09:00', '18:00'] },
    platforms:   { type: [String], default: ['instagram'] },
    mixRatio:    { videoPercent: { type: Number, default: 30 } },
  },

  platformTokens: { type: [platformTokenSchema], default: [] },

  contentWeights: {
    productPriority: { type: mongoose.Schema.Types.Mixed, default: {} },
    angleWeights:    { type: mongoose.Schema.Types.Mixed, default: {} },
    timeWeights:     { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  tier:               { type: String, enum: ['starter', 'growth', 'brand', 'agency'], default: 'growth' },
  stripeSubId:        { type: String, default: null },
  postsUsedThisMonth: { type: Number, default: 0 },
  postsQuotaPerMonth: { type: Number, default: 60 },
  quotaResetDate:     { type: Date, default: null },

  status: {
    type: String,
    enum: ['active', 'paused', 'suspended', 'cancelled'],
    default: 'active',
    index: true,
  },

  lastPlannerRunAt: { type: Date, default: null },
  lastPostAt:       { type: Date, default: null },
}, { timestamps: true });

autonomousBrandSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('AutonomousBrand', autonomousBrandSchema);
