'use strict';

/**
 * BrandContentItem — separate collection for content calendar items.
 *
 * Replaces embedded `brandProject.contentItems[]` and `brandProject.contentCalendar[]`.
 * 30 items per brand × N brands × image URLs × hashtags would inflate the parent doc.
 */

const mongoose = require('mongoose');

const brandContentItemSchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  agentGenerated:         { type: Boolean, default: false },
  platform:               { type: String, enum: ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'snapchat', 'youtube'], index: true },
  contentType:            { type: String, enum: ['post', 'reel', 'story', 'carousel', 'article', 'thread', 'video_description'] },
  status:                 { type: String, enum: ['draft', 'approved', 'scheduled', 'posted'], default: 'draft', index: true },

  caption:                String,
  hashtags:               [String],
  hook:                   String,
  visualPrompt:           String,
  imageUrl:               String,
  videoUrl:               String,
  videoApprovalStatus:    { type: String, enum: ['pending_admin', 'approved', 'rejected'] },
  videoApprovalRequestedAt: Date,
  topic:                  String,
  strategicGoal:          { type: String, enum: ['awareness', 'engagement', 'conversion', 'retention'] },
  competitorGapExploited: String,
  callToAction:           String,
  contentPillar:          { type: String, enum: ['education', 'entertainment', 'inspiration', 'promotion', 'social_proof'] },
  audienceSegment:        String,
  estimatedBestTime:      String,
  dayNumber:              Number,
  scheduledAt:            Date,
  postedAt:               Date,
  zapierWebhookFired:     { type: Boolean, default: false },

  performance: {
    views:      Number,
    likes:      Number,
    comments:   Number,
    shares:     Number,
    leads:      Number,
    founderNote: String,
  },

  // For calendar items merged in from the legacy `contentCalendar`.
  // Kept loose because legacy schema used different enum sets.
  legacy: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

brandContentItemSchema.index({ brandProject: 1, scheduledAt: 1 });
brandContentItemSchema.index({ brandProject: 1, status: 1, dayNumber: 1 });

module.exports = mongoose.model('BrandContentItem', brandContentItemSchema);
