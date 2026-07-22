'use strict';

const mongoose = require('mongoose');

const postPerformanceSchema = new mongoose.Schema({
  brandId:        { type: mongoose.Schema.Types.ObjectId, ref: 'AutonomousBrand', required: true, index: true },
  briefId:        { type: mongoose.Schema.Types.ObjectId, ref: 'ContentBrief', required: true, index: true },
  platform:       { type: String, required: true },
  platformPostId: { type: String, required: true },

  views:      { type: Number, default: 0 },
  likes:      { type: Number, default: 0 },
  comments:   { type: Number, default: 0 },
  shares:     { type: Number, default: 0 },
  saves:      { type: Number, default: 0 },
  clicks:     { type: Number, default: 0 },
  addToCarts: { type: Number, default: 0 },
  reach:      { type: Number, default: 0 },

  engagementRate: { type: Number, default: 0 },
  ctr:            { type: Number, default: 0 },

  angle:       { type: String, default: null },
  productName: { type: String, default: null },
  postHour:    { type: Number, default: null },

  collectedAt: { type: Date, default: Date.now },
}, { timestamps: true });

postPerformanceSchema.index({ brandId: 1, collectedAt: -1 });
postPerformanceSchema.index({ briefId: 1 });

module.exports = mongoose.model('PostPerformance', postPerformanceSchema);
