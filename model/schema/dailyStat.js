'use strict';

const mongoose = require('mongoose');

const dailyStatSchema = new mongoose.Schema({
  date: { type: String, index: true }, // YYYY-MM-DD

  totalJobs:     { type: Number, default: 0 },
  completedJobs: { type: Number, default: 0 },
  failedJobs:    { type: Number, default: 0 },
  totalFalCost:  { type: Number, default: 0 },

  categoryBreakdown: {
    gym:        { type: Number, default: 0 },
    realestate: { type: Number, default: 0 },
    perfume:    { type: Number, default: 0 },
    saas:       { type: Number, default: 0 },
    restaurant: { type: Number, default: 0 },
    service:    { type: Number, default: 0 }
  },

  avgGenerationTimeMs: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('DailyStat', dailyStatSchema);
