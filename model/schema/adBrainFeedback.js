'use strict';

const mongoose = require('mongoose');

const adBrainFeedbackSchema = new mongoose.Schema({
  assetId:          { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true },
  sessionId:        { type: String, default: null },
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  rating:           { type: Number, enum: [1, -1], required: true },
  category:         { type: String, default: '' },
  modelUsed:        { type: String, default: '' },
  vibe:             { type: String, default: '' },
  locale:           { type: String, default: '' },
  promptSnapshot:   { type: String, default: '' },
  regeneratedAfter: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('AdBrainFeedback', adBrainFeedbackSchema);
