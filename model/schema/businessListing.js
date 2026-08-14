const mongoose = require('mongoose');

/**
 * BusinessListing — Qumak Marketplace
 * Represents a verified (or pending) business for sale on the Qumak platform.
 */
const businessListingSchema = new mongoose.Schema({

  /* ─── Core Identity ─── */
  listingNumber: {
    type: String,
    unique: true,
    // auto-generated in pre-validate hook
  },

  name: {
    type: String,
    required: [true, 'Business name is required'],
    trim: true,
    maxlength: 200,
  },

  slug: {
    type: String,
    unique: true,
    // auto-generated from name
  },

  industry: {
    type: String,
    required: [true, 'Industry is required'],
    enum: [
      'E-commerce', 'Restaurant', 'Restaurant / Food', 'Digital Marketing',
      'Real Estate', 'Retail', 'Tech', 'Tech / SaaS', 'Healthcare',
      'Education', 'Logistics', 'Manufacturing', 'Other',
    ],
  },

  location: {
    emirate: {
      type: String,
      required: true,
      enum: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'],
    },
    area: String, // e.g. "Business Bay"
    setupType: {
      type: String,
      enum: ['mainland', 'freezone'],
    },
  },

  /* ─── Financials ─── */
  financials: {
    askingPrice: {
      type: Number,
      required: [true, 'Asking price is required'],
      min: 0,
    },
    monthlyRevenue: {
      type: Number,
      required: true,
      min: 0,
    },
    monthlyProfit: {
      type: Number,
      min: 0,
    },
    profitMargin: {
      type: Number, // percentage, auto-calculated
      min: 0,
      max: 100,
    },
    annualRevenue: {
      type: Number,
    },
    currency: {
      type: String,
      default: 'AED',
    },
    vatRegistered: {
      type: Boolean,
      default: false,
    },
  },

  /* ─── Business Details ─── */
  yearsInOperation: {
    type: Number,
    required: true,
    min: 0,
  },

  employees: {
    type: Number,
    default: 0,
  },

  description: {
    type: String,
    required: [true, 'Business description is required'],
    maxlength: 3000,
  },

  shortDescription: {
    type: String,
    maxlength: 300,
  },

  /* ─── Assets ─── */
  assetsIncluded: [{
    type: String,
    trim: true,
  }],

  reasonForSale: {
    type: String,
    maxlength: 500,
  },

  /* ─── Media ─── */
  images: [{
    url: String,
    caption: String,
    isPrimary: { type: Boolean, default: false },
  }],

  /* ─── Verification ─── */
  verificationStatus: {
    type: String,
    enum: ['pending', 'under_review', 'verified', 'rejected', 'suspended'],
    default: 'pending',
    index: true,
  },

  verificationDetails: {
    financialReview: { type: Boolean, default: false },
    vatValidation: { type: Boolean, default: false },
    bankValidation: { type: Boolean, default: false },
    complianceCheck: { type: Boolean, default: false },
    operationalInterview: { type: Boolean, default: false },
    reviewedBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    reviewedAt: Date,
    notes: String,
  },

  /* ─── Listing Status ─── */
  listingStatus: {
    type: String,
    enum: ['draft', 'active', 'under_offer', 'sold', 'withdrawn', 'expired'],
    default: 'draft',
    index: true,
  },

  isPublished: {
    type: Boolean,
    default: false,
    index: true,
  },

  publishedAt: Date,

  expiresAt: {
    type: Date,
    // default: 6 months from creation
  },

  /* ─── Seller Reference ─── */
  seller: {
    type: mongoose.Schema.ObjectId,
    ref: 'SellerSubmission',
  },

  /* ─── Engagement Metrics ─── */
  metrics: {
    views: { type: Number, default: 0 },
    inquiries: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    bids: { type: Number, default: 0 },
    viewsToday: { type: Number, default: 0 },
    watchers: { type: Number, default: 0 },
    highestBid: { type: Number, default: 0 },
  },

  /* ─── Auction (when listingMode = 'auction') ─── */
  auction: {
    startingBid: Number,
    reservePrice: Number,
    bidIncrement: { type: Number, default: 5000 },
    endsAt: Date,
    extendedBy: { type: Number, default: 0 },
  },

  /* ─── Listing Mode (legacy) ─── */
  listingMode: {
    type: String,
    enum: ['fixed', 'auction'],
    default: 'fixed',
  },

  /**
   * Marketplace strategy: how the deal is run (see config/listingTypeDefinitions.js).
   * Prefer this over listingMode for new listings.
   */
  listingType: {
    type: String,
    enum: ['public_auction', 'private_sealed', 'off_market_reserved', 'buy_now'],
    default: 'public_auction',
    index: true,
  },

  /** Type-specific windows, fees, and UI flags */
  listingTypeConfig: {
    countdownDays: { type: Number, default: 7 },
    sealedWindowDays: { type: Number, default: 14 },
    sealedWindowEndsAt: Date,
    reserveHiddenUntilMet: { type: Boolean, default: true },
    listingFeeAED: { type: Number },
    successFeePercent: { type: Number },
    buyNowDueDiligenceHours: { type: Number, default: 48 },
    /** Shown in UI: unlock CIM / financials */
    depositToUnlockAED: { type: Number, default: 500 },
    financialsLocked: { type: Boolean, default: true },
  },

  /* ─── Qumak Commission ─── */
  commission: {
    percentage: { type: Number, default: 5 }, // 3–10%
    agreedAmount: Number,
    paid: { type: Boolean, default: false },
    paidAt: Date,
  },

  /* ─── Tags / Search ─── */
  tags: [{ type: String, trim: true }],

  /* ─── Featured ─── */
  isFeatured: { type: Boolean, default: false },
  featuredUntil: Date,

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/* ─── Pre-validate hooks ─── */
businessListingSchema.pre('validate', async function (next) {
  // Auto-generate listing number
  if (!this.listingNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('BusinessListing').countDocuments() + 1;
    const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    this.listingNumber = `QML-${year}${month}-${String(count).padStart(4, '0')}-${suffix}`;
  }

  // Auto-generate slug
  if (!this.slug && this.name) {
    const base = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const count = await mongoose.model('BusinessListing').countDocuments({ slug: new RegExp(`^${base}`) });
    this.slug = count > 0 ? `${base}-${count}` : base;
  }

  // Auto-calculate profit margin
  if (this.financials?.monthlyRevenue && this.financials?.monthlyProfit) {
    this.financials.profitMargin = Math.round((this.financials.monthlyProfit / this.financials.monthlyRevenue) * 100);
  }

  // Set expiry (6 months)
  if (!this.expiresAt) {
    const exp = new Date();
    exp.setMonth(exp.getMonth() + 6);
    this.expiresAt = exp;
  }

  next();
});

/* ─── Virtuals ─── */
businessListingSchema.virtual('priceMultiple').get(function () {
  if (this.financials?.monthlyProfit && this.financials?.askingPrice) {
    const annualProfit = this.financials.monthlyProfit * 12;
    return (this.financials.askingPrice / annualProfit).toFixed(1) + 'x';
  }
  return null;
});

/* ─── Indexes ─── */
businessListingSchema.index({ 'location.emirate': 1 });
businessListingSchema.index({ industry: 1 });
businessListingSchema.index({ 'financials.askingPrice': 1 });
businessListingSchema.index({ 'financials.monthlyRevenue': 1 });
businessListingSchema.index({ listingStatus: 1, isPublished: 1 });
businessListingSchema.index({ createdAt: -1 });
businessListingSchema.index({ isFeatured: 1, publishedAt: -1 });
businessListingSchema.index({ listingType: 1, listingStatus: 1, isPublished: 1 });

/* ─── Static methods ─── */
businessListingSchema.statics.getActiveListings = function (filters = {}) {
  return this.find({ isPublished: true, listingStatus: 'active', ...filters }).sort({ isFeatured: -1, publishedAt: -1 });
};

const BusinessListing = mongoose.model('BusinessListing', businessListingSchema);

module.exports = BusinessListing;


