'use strict';

/**
 * DemoSession — one row per public 60s demo run.
 *
 * Holds: the IG handle the visitor pasted, the resolved profile snapshot,
 * the 10 StudioJobs we enqueued, and any WhatsApp delivery intent so the
 * worker can fire each finished asset back to the visitor.
 *
 * Lives in its own file (not inside the controller) so both the API
 * process AND the BullMQ worker process can register the model.
 */

const mongoose = require('mongoose');

const demoSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  instagramHandle: { type: String, required: true, index: true },
  profile:         { type: Object, default: {} },
  category:        { type: String, default: 'general' },
  language:        { type: String, enum: ['en', 'ar', 'both'], default: 'both' },

  whatsappNumber:  { type: String, default: null },
  deliveryStatus:  {
    type: String,
    enum: ['none', 'pending', 'sending', 'sent', 'failed'],
    default: 'none',
  },

  jobs: [{
    jobId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', index: true },
    template: String,
    language: String,
  }],
}, { timestamps: true });

module.exports = mongoose.models.DemoSession
  || mongoose.model('DemoSession', demoSessionSchema);
