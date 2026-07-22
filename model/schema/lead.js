'use strict';

const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  // Either email or phone is required, validated at the controller layer so a
  // download-gate prompt can ask for *either* without breaking schema validation.
  email:        { type: String, required: false, lowercase: true, trim: true, index: true, sparse: true },
  phone:        { type: String, required: false, trim: true, index: true, sparse: true },
  sessionId:    { type: String, index: true, default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  source:       {
    type: String,
    enum: ['post_generation', 'exit_intent', 'share_page', 'waitlist', 'download_gate'],
    default: 'post_generation'
  },

  category:         { type: String, default: null },
  utmSource:        { type: String, default: null },
  utmMedium:        { type: String, default: null },
  utmCampaign:      { type: String, default: null },
  referralCode:     { type: String, default: null },
  firstAssetId:     { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null },
  // Track every asset a lead bounces back to download — handy for the CRM.
  lastAssetId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null },
  lastSeenAt:       { type: Date, default: null },

  emailSequenceStep: { type: Number, default: 0 },
  isConverted:       { type: Boolean, default: false },
  convertedAt:       { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
