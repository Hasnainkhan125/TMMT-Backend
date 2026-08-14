const mongoose = require('mongoose');

/**
 * AuctionRegistration — Pre-bid registration for a listing.
 * Allows investors to register interest before auction opens.
 */
const auctionRegistrationSchema = new mongoose.Schema({
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessListing',
    required: true,
    index: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  name: { type: String, trim: true, required: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  investmentBudget: { type: Number },  // max they're willing to pay
  message: { type: String, maxlength: 500 },

  /* Referral tracking */
  referralCode: { type: String, trim: true, index: true },  // code used by THIS registrant
  referredBy: { type: String, trim: true, index: true },    // code that brought THIS person here

  status: {
    type: String,
    enum: ['registered', 'approved', 'rejected', 'converted'],
    default: 'registered',
    index: true,
  },
  approvedAt: Date,
  convertedToBidAt: Date,
}, {
  timestamps: true,
});

auctionRegistrationSchema.index({ listing: 1, email: 1 }, { unique: true, sparse: true });

const AuctionRegistration = mongoose.model('AuctionRegistration', auctionRegistrationSchema);
module.exports = AuctionRegistration;
