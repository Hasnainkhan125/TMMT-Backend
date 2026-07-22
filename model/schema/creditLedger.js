'use strict';

/**
 * CreditLedger — append-only log of every credit movement.
 *
 * Reasons we don't just decrement a counter on the User:
 *   1. We need a refund trail when a generation fails.
 *   2. We need to reconcile fal.ai cost-USD against our retail credit cost.
 *   3. Finance wants a per-day "what did we sell vs what did we burn" report.
 *
 * One row per movement. Positive `delta` is a top-up; negative is a charge.
 * `balanceAfter` is materialised so we don't need a SUM() at read time.
 *
 * Owner identity is one of {userId, sessionId} — anonymous trial users only
 * have a sessionId until they sign up, at which point we backfill `userId`.
 */

const mongoose = require('mongoose');

const creditLedgerSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  sessionId: { type: String, default: null, index: true },

  delta:        { type: Number, required: true },     // signed
  balanceAfter: { type: Number, required: true },     // running balance after this row

  reason: {
    type: String,
    enum: [
      'topup_stripe', 'topup_tabby', 'topup_tamara', 'topup_admin', 'topup_signup_bonus',
      'charge_studio_image', 'charge_studio_video',
      'charge_studio_video_native_audio', 'charge_studio_audio_tts', 'charge_studio_audio_upload',
      'refund_studio_failure', 'refund_admin',
      'adjustment_admin',
    ],
    required: true,
    index: true,
  },

  // Provenance — links back to the thing that caused the movement.
  jobId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null, index: true },
  modelId:  { type: String, default: null },          // AiModel.id slug, for analytics
  templateId:{ type: mongoose.Schema.Types.ObjectId, ref: 'GenerationTemplate', default: null },

  // Free-form metadata (Stripe charge id, idempotency key, etc.).
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },

}, { timestamps: true });

creditLedgerSchema.index({ userId: 1, createdAt: -1 });
creditLedgerSchema.index({ sessionId: 1, createdAt: -1 });

module.exports = mongoose.models.CreditLedger || mongoose.model('CreditLedger', creditLedgerSchema);
