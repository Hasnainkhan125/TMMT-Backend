const mongoose = require('mongoose');

/**
 * MarketplaceBid — Qumak Marketplace
 * Represents a bid placed by a user on a business listing.
 */
const marketplaceBidSchema = new mongoose.Schema({
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessListing',
    required: [true, 'Listing is required'],
    index: true,
  },
  bidder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Bidder is required'],
    index: true,
  },
  amount: {
    type: Number,
    required: [true, 'Bid amount is required'],
    min: 0,
  },
  bidType: {
    type: String,
    enum: ['full', 'equity', 'installment'],
    default: 'full',
  },
  timeline: {
    type: String,
    trim: true,
    maxlength: 100,
  },
  message: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'withdrawn', 'winning', 'outbid'],
    default: 'pending',
    index: true,
  },

  /* ─── Referral / Broker commission ─── */
  referredBy: {
    type: String,  // referral code e.g. "REF-abc123"
    trim: true,
    index: true,
  },
  referrerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  referralCommissionRate: {
    type: Number,
    default: 0,  // percentage e.g. 2.5
  },
  referralCommissionAmount: {
    type: Number,
    default: 0,
  },
  referralCommissionPaid: {
    type: Boolean,
    default: false,
  },

  /* ─── Private sealed listing ─── amounts hidden from public until window closes */
  isSealed: {
    type: Boolean,
    default: false,
    index: true,
  },
  sealedRevealedAt: {
    type: Date,
  },

  /* ─── Pre-bid registration ─── */
  isPreBid: {
    type: Boolean,
    default: false,
  },
  maxAutoBid: {
    type: Number,
    default: 0,  // auto-bid ceiling; 0 = disabled
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

marketplaceBidSchema.index({ listing: 1, bidder: 1 });
marketplaceBidSchema.index({ bidder: 1, createdAt: -1 });
marketplaceBidSchema.index({ listing: 1, amount: -1 });

const MarketplaceBid = mongoose.model('MarketplaceBid', marketplaceBidSchema);

module.exports = MarketplaceBid;
