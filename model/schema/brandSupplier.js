'use strict';

/**
 * BrandSupplier — separate collection for supplier records attached to a brand.
 * Replaces the embedded `businessProfile.suppliers[]` (and freeform supplier
 * data on quotations) so brands with hundreds of researched suppliers don't
 * inflate the parent doc.
 */

const mongoose = require('mongoose');

const brandSupplierSchema = new mongoose.Schema({
  brandProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', required: true, index: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name:         { type: String, required: true },
  type:         String,                     // manufacturer, packaging, raw materials, etc
  location:     String,
  country:      String,
  relevance:    String,
  contactType:  { type: String, enum: ['website', 'whatsapp', 'walk_in', 'registration', 'phone', 'email'] },
  contactValue: String,
  estimatedCost: String,

  source:       { type: String, enum: ['ai_research', 'manual', 'directory_import'], default: 'ai_research' },
  notes:        String,

  // Quotation tracking
  lastQuotation: {
    quantity:     Number,
    pricePerUnit: Number,
    totalCost:    Number,
    currency:     { type: String, default: 'USD' },
    leadTimeDays: Number,
    status:       { type: String, enum: ['pending', 'sent', 'accepted', 'rejected'], default: 'pending' },
    sentAt:       Date,
  },
}, { timestamps: true });

brandSupplierSchema.index({ brandProject: 1, name: 1 });

module.exports = mongoose.model('BrandSupplier', brandSupplierSchema);
