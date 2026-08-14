'use strict';

/**
 * BrandProfile — saved brand identity used by Studio to keep generated ads
 * on-brand without re-typing brand inputs each time.
 *
 * Owned by either a user (logged in) or a session (anonymous). Anonymous
 * profiles graduate to user-owned profiles when the session signs up.
 */

const mongoose = require('mongoose');

const brandProfileSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  sessionId: { type: String, default: null, index: true },

  name:           { type: String, required: true, maxlength: 100 },
  category:       { type: String, enum: ['gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service', 'general'], default: 'general' },

  description:    { type: String, maxlength: 800, default: '' },
  targetAudience: { type: String, maxlength: 200, default: '' },
  vibe:           { type: String, maxlength: 50, default: '' },

  brandColors:    [{ type: String }],   // ['#0A0A0A', '#D4AF37']
  fonts:          [{ type: String }],
  logoUrl:        { type: String, default: null },

  // Locales & languages
  locale:         { type: String, enum: ['gulf', 'global'], default: 'gulf' },
  languages:      [{ type: String, enum: ['ar', 'en', 'fr', 'hi', 'tl'] }],

  // Channels (used by content calendar / launcher integrations)
  channels: {
    instagram: { type: String, default: null },
    tiktok:    { type: String, default: null },
    facebook:  { type: String, default: null },
    snapchat:  { type: String, default: null },
    whatsapp:  { type: String, default: null },
    website:   { type: String, default: null },
  },

  // Free-form extras for power users
  extras: { type: mongoose.Schema.Types.Mixed, default: {} },

  isDefault: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
}, { timestamps: true });

brandProfileSchema.index({ userId: 1, isArchived: 1 });
brandProfileSchema.index({ sessionId: 1, isArchived: 1 });

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
