'use strict';

/**
 * BrandAgentInsight — separate collection for agent-generated insights.
 * Replaces embedded `brandProject.agentInsights[]`. Items pile up fast (one
 * per agent per surfaceable event); putting them inline blows up the parent.
 */

const mongoose = require('mongoose');

const brandAgentInsightSchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  agentType:     { type: String, enum: ['research', 'strategy', 'content', 'growth'], index: true },
  type:          { type: String, enum: ['competitor_gap', 'usp', 'content_idea', 'growth_action', 'trend_alert', 'weekly_theme'] },
  title:         String,
  body:          String,
  actionLabel:   String,
  actionPayload: { type: mongoose.Schema.Types.Mixed },
  priority:      { type: Number, default: 3, index: true },
  read:          { type: Boolean, default: false, index: true },
  dismissed:     { type: Boolean, default: false },
}, { timestamps: true });

brandAgentInsightSchema.index({ brandProject: 1, dismissed: 1, priority: -1, createdAt: -1 });

module.exports = mongoose.model('BrandAgentInsight', brandAgentInsightSchema);
