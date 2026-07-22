'use strict';

const mongoose = require('mongoose');

const userSubscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  // Stripe ids — needed for portal sessions and reconciliation
  stripeCustomerId:     { type: String, required: true, index: true },
  stripeSubscriptionId: { type: String, default: null, index: true },

  // Current plan state
  planId:   { type: String, default: null }, // 'plus_monthly' etc.
  tier:     { type: String, default: 'free' }, // 'free' | 'starter' | 'plus' | 'ultra'
  status:   { type: String, default: 'inactive' }, // 'active' | 'past_due' | 'canceled' | 'inactive'
  interval: { type: String, default: null }, // 'month' | 'year'
  creditsPerCycle: { type: Number, default: 0 },

  // Billing cycle tracking — drives the next renewal grant
  currentPeriodStart: { type: Date, default: null },
  currentPeriodEnd:   { type: Date, default: null },
  cancelAtPeriodEnd:  { type: Boolean, default: false },

  // Idempotency log — every Stripe event we've successfully processed.
  // Prevents a webhook retry from double-granting credits.
  processedEventIds: { type: [String], default: [], index: true },
}, { timestamps: true });

module.exports = mongoose.model('UserSubscription', userSubscriptionSchema);