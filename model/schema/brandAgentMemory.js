'use strict';

/**
 * BrandAgentMemory — single doc per BrandProject for the marketing-cofounder
 * agent's memory. Replaces the embedded `brandProject.agentMemory` blob and
 * the unbounded `agentInsights[]`/`videoRequests[]`/`scheduledPosts[]` arrays.
 *
 * One-to-one with BrandProject (unique index on `brandProject`).
 */

const mongoose = require('mongoose');

const brandAgentMemorySchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, unique: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  lastResearchAt: Date,
  lastStrategyAt: Date,
  lastContentAt:  Date,
  lastGrowthAt:   Date,

  competitors: [{
    name:              String,
    platform:          String,
    handle:            String,
    strengths:         [String],
    weaknesses:        [String],
    recentPostTopics:  [String],
    avgEngagementRate: Number,
    lastScannedAt:     Date,
    _id: false,
  }],

  usp: {
    current:           String,
    history: [{
      statement:   String,
      rationale:   String,
      generatedAt: Date,
      version:     Number,
      _id: false,
    }],
    competitiveGap:    String,
    customerPainPoints:[String],
  },

  audience: {
    primary: {
      description:        String,
      platforms:           [String],
      peakHours:           [String],
      contentPreferences:  [String],
      buyingTriggers:      [String],
    },
    b2bTargets: [{
      companyType:       String,
      decisionMaker:     String,
      painPoint:         String,
      approachChannel:   String,
      emailSubjectLine:  String,
      coldEmailTemplate: String,
      _id: false,
    }],
  },

  growthStage: {
    current:        String,
    weeklyGoal:     String,
    suggestedFocus: String,
    metrics: {
      followersTarget: Number,
      leadsTarget:     Number,
      revenueTarget:   Number,
    },
  },

  s3Paths: {
    root:     String,
    research: String,
    content:  String,
    assets:   String,
    memory:   String,
  },
}, { timestamps: true });

module.exports = mongoose.model('BrandAgentMemory', brandAgentMemorySchema);
