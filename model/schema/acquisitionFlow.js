const mongoose = require('mongoose');

/**
 * AcquisitionFlow — tracks the full post-win acquisition process.
 * Created when an auction ends and a winner is determined.
 *
 * Flow: deposit_pending → dd_period → agreement → final_payment → transfer → completed
 */
const acquisitionFlowSchema = new mongoose.Schema({

  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessListing',
    required: true,
    index: true,
  },

  winningBid: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplaceBid',
    required: true,
  },

  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  /* ─── Deal Summary ─── */
  winningAmount: { type: Number, required: true },
  depositAmount: { type: Number }, // 10% of winningAmount
  finalPaymentAmount: { type: Number }, // 90% of winningAmount

  currency: { type: String, default: 'AED' },

  /* ─── Acquisition Stage ─── */
  stage: {
    type: String,
    enum: [
      'deposit_pending',   // winner must pay 10% deposit within 24h
      'dd_period',         // 14-30 day due diligence window
      'agreement',         // e-sign SPA / APA
      'final_payment',     // remaining 90% to escrow
      'transfer',          // trade license, visas, bank, IP transfer
      'completed',         // done
      'cancelled',         // deal fell through
    ],
    default: 'deposit_pending',
    index: true,
  },

  /* ─── Stage Timestamps & Deadlines ─── */
  stages: {
    deposit: {
      dueAt: Date,           // 24h from auction end
      paidAt: Date,
      amount: Number,
      paymentMethod: { type: String, enum: ['stripe', 'bank_wire', 'usdc', 'usdt'] },
      paymentRef: String,
      stripePaymentIntentId: String,
      cryptoTxHash: String,
    },
    dueDiligence: {
      startedAt: Date,
      dueAt: Date,           // 14-30 days from deposit
      completedAt: Date,
      notes: String,
    },
    agreement: {
      sentAt: Date,
      signedByBuyerAt: Date,
      signedBySellerAt: Date,
      documentUrl: String,
      docusignEnvelopeId: String,
      agreementType: { type: String, enum: ['SPA', 'APA'], default: 'SPA' },
    },
    finalPayment: {
      dueAt: Date,
      paidAt: Date,
      amount: Number,
      paymentMethod: { type: String, enum: ['stripe', 'bank_wire', 'usdc', 'usdt'] },
      paymentRef: String,
      stripePaymentIntentId: String,
      cryptoTxHash: String,
      escrowRef: String,
    },
    transfer: {
      startedAt: Date,
      completedAt: Date,
      tradeLicenseTransferred: { type: Boolean, default: false },
      visasTransferred: { type: Boolean, default: false },
      bankAccountTransferred: { type: Boolean, default: false },
      digitalAssetsTransferred: { type: Boolean, default: false },
    },
  },

  /* ─── KYC requirement ─── */
  buyerKycStatus: {
    type: String,
    enum: ['pending', 'submitted', 'approved', 'rejected'],
    default: 'pending',
  },

  /* ─── Communication thread ─── */
  messages: [{
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderRole: { type: String, enum: ['buyer', 'seller', 'broker', 'admin'] },
    content: { type: String, maxlength: 2000 },
    attachmentUrl: String,
    createdAt: { type: Date, default: Date.now },
  }],

  /* ─── Notes / Broker ─── */
  brokerNotes: String,
  assignedBroker: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  cancellationReason: String,
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

acquisitionFlowSchema.virtual('depositDueHours').get(function () {
  if (!this.stages?.deposit?.dueAt) return null;
  const ms = this.stages.deposit.dueAt.getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 3_600_000));
});

acquisitionFlowSchema.index({ buyer: 1, stage: 1 });
acquisitionFlowSchema.index({ listing: 1, stage: 1 });

const AcquisitionFlow = mongoose.model('AcquisitionFlow', acquisitionFlowSchema);
module.exports = AcquisitionFlow;
