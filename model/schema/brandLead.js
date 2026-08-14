'use strict';

/**
 * BrandLead — separate collection for sales leads attached to a BrandProject.
 *
 * Replaces the embedded `brandProject.leads[]` array which grows unbounded
 * and will exceed MongoDB's 16MB per-document limit on active projects.
 *
 * Migration helper: `services/brandProjectMigration.js#migrateLeadsForProject`.
 */

const mongoose = require('mongoose');

const outreachMessageSchema = new mongoose.Schema({
  channel:         { type: String, enum: ['email', 'linkedin', 'whatsapp'], default: 'email' },
  subject:         String,
  body:            String,
  aiGenerated:     { type: Boolean, default: true },
  edited:          { type: Boolean, default: false },
  status:          { type: String, enum: ['draft', 'approved', 'sent', 'opened', 'replied', 'bounced'], default: 'draft' },
  sentAt:          Date,
  openedAt:        Date,
  repliedAt:       Date,
  resendMessageId: String,
  sequenceNumber:  { type: Number, default: 1 },
}, { _id: true });

const brandLeadSchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  source:        { type: String, enum: ['apollo', 'manual', 'linkedin_import'], default: 'apollo' },
  apolloId:      { type: String, index: true },

  firstName:     String,
  lastName:      String,
  fullName:      String,
  email:         { type: String, index: true },
  emailVerified: { type: Boolean, default: false },
  title:         String,
  company:       String,
  companySize:   String,
  industry:      String,
  linkedinUrl:   String,
  website:       String,
  location:      String,

  icpScore:        { type: Number, default: 0 },
  icpRationale:    String,
  leadStage:       { type: String, enum: ['new', 'contacted', 'replied', 'meeting', 'closed', 'not_fit'], default: 'new', index: true },

  outreachMessages: { type: [outreachMessageSchema], default: [] },

  agentNotes:       String,
  painPointMatched: String,
  uspAngle:         String,
  lastContactedAt:  Date,
  nextFollowUpAt:   Date,
  estimatedDealValueAED: { type: Number, default: 0 },
}, { timestamps: true });

brandLeadSchema.index({ brandProject: 1, leadStage: 1, createdAt: -1 });
brandLeadSchema.index({ brandProject: 1, email: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('BrandLead', brandLeadSchema);
