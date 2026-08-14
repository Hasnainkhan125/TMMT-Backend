/**
 * brandSubmission.js — Logs every AI brand generation
 * Captures anonymous sessions + leads + funnel state for follow-up automation
 */
const mongoose = require('mongoose');

const brandSubmissionSchema = new mongoose.Schema({
  sessionId:    { type: String, required: true, index: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email:        { type: String, trim: true, lowercase: true },
  phone:        { type: String },
  name:         { type: String },
  emailCaptured:{ type: Boolean, default: false },
  category:     { type: String, enum: ['perfume', 'skincare', 'custom', 'jewelry', 'clothing'], required: true },
  mode:         { type: String, enum: ['auto', 'wizard'] },
  inputs:       { type: mongoose.Schema.Types.Mixed },
  brand:        { type: mongoose.Schema.Types.Mixed },
  mockupsGenerated: { type: Number, default: 0 },
  tabsVisited:      { type: [String], default: [] },
  downloadedKit:    { type: Boolean, default: false },
  connectedSocial:  { type: Boolean, default: false },
  savedToAccount:   { type: Boolean, default: false },
  tradeLicenseCTA:  { type: Boolean, default: false },
  tradeLicensePaid: { type: Boolean, default: false },
  followUp: {
    email1Sent:   { type: Boolean, default: false },
    email2Sent:   { type: Boolean, default: false },
    email3Sent:   { type: Boolean, default: false },
    email1SentAt: { type: Date },
    email2SentAt: { type: Date },
    email3SentAt: { type: Date },
    unsubscribed: { type: Boolean, default: false },
  },
  utm: {
    source:   { type: String },
    medium:   { type: String },
    campaign: { type: String },
    content:  { type: String },
  },
  referrer:   { type: String },
  ipAddress:  { type: String },
  userAgent:  { type: String },
  launchScore:  { type: Number, default: 20 },
  isHighIntent: { type: Boolean, default: false },
  adminExported:   { type: Boolean, default: false },
  adminExportedAt: { type: Date },
  adminContactLog: [{
    note:        { type: String },
    outcome:     { type: String, enum: ['interested','not_now','converted','no_answer'] },
    contactedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    contactedAt: { type: Date },
  }],
  adminLastContacted: { type: Date },
}, { timestamps: true });

brandSubmissionSchema.index({ createdAt: -1 });
brandSubmissionSchema.index({ category: 1, createdAt: -1 });
brandSubmissionSchema.index({ isHighIntent: 1, 'followUp.email1Sent': 1 });
brandSubmissionSchema.index({ email: 1 });

module.exports = mongoose.model('BrandSubmission', brandSubmissionSchema);
