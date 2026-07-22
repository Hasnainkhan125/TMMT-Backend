'use strict';

const mongoose = require('mongoose');

const studioUserSchema = new mongoose.Schema({
  // One of these will be set
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  sessionId: { type: String, default: null, index: true },

  referralCode:   { type: String, unique: true, sparse: true, default: null },
  referredBy:     { type: String, default: null },
  creditsBonus:   { type: Number, default: 0 },

  // First-touch UTM — never overwritten after set
  utmSource:      { type: String, default: null },
  utmMedium:      { type: String, default: null },
  utmCampaign:    { type: String, default: null },

  emailCaptured:  { type: Boolean, default: false },
  onboardingDone: { type: Boolean, default: false },
  lastActiveAt:   { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('StudioUser', studioUserSchema);
