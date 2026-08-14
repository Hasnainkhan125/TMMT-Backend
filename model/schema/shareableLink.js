'use strict';

const mongoose = require('mongoose');

const shareableLinkSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, index: true },
  assetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true },
  jobId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null },
  sessionId:  { type: String, default: null },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  category:   { type: String, default: '' },

  viewCount:  { type: Number, default: 0 },
  clickCount: { type: Number, default: 0 },
  isActive:   { type: Boolean, default: true },
  expiresAt:  { type: Date, required: true }
}, { timestamps: true });

shareableLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ShareableLink', shareableLinkSchema);
