'use strict';

/**
 * BrandTradeLicense — separate collection for trade license applications.
 * Replaces embedded `brandProject.tradeLicenseApplication`. Now allows
 * multiple applications, status history, and document attachments without
 * polluting the parent doc.
 */

const mongoose = require('mongoose');

const brandTradeLicenseSchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  package:        { type: String, enum: ['starter', 'growth', 'premium'] },
  fullName:       String,
  email:          String,
  phone:          String,
  passportNumber: String,
  companyName:    String,
  visaEligible:   { type: Boolean, default: true },
  numberOfVisas:  { type: Number, default: 1 },
  officeType:     { type: String, enum: ['flexi_desk', 'dedicated', 'warehouse', 'virtual'], default: 'flexi_desk' },
  freeZone:       { type: String, default: 'RAKEZ' },
  notes:          String,

  status:         { type: String, enum: ['submitted', 'processing', 'approved', 'rejected'], default: 'submitted', index: true },
  submittedAt:    { type: Date, default: Date.now },

  statusHistory: [{
    status:    String,
    note:      String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    _id: false,
  }],

  documents: [{
    name:        String,
    url:         String,
    uploadedAt:  { type: Date, default: Date.now },
    uploadedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    _id: false,
  }],
}, { timestamps: true });

module.exports = mongoose.model('BrandTradeLicense', brandTradeLicenseSchema);
