const mongoose = require('mongoose');

/**
 * SellerSubmission — Qumak Marketplace
 * Captures seller intent before formal verification.
 * Submitted via the hidden "Submit a Business for Review" page.
 */
const sellerSubmissionSchema = new mongoose.Schema({

  /* ─── Submission Reference ─── */
  submissionNumber: {
    type: String,
    unique: true,
    // auto-generated
  },

  /* ─── Step 1: Basic Info ─── */
  businessName: {
    type: String,
    required: [true, 'Business name is required'],
    trim: true,
  },

  industry: {
    type: String,
    required: [true, 'Industry is required'],
    enum: [
      'E-commerce', 'Restaurant / Food', 'Digital Marketing',
      'Real Estate', 'Retail', 'Tech / SaaS', 'Healthcare',
      'Education', 'Logistics', 'Manufacturing', 'Other',
    ],
  },

  location: {
    type: String,
    required: [true, 'Location is required'],
    enum: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'],
  },

  yearsOperating: {
    type: String,
    enum: ['Less than 1 year', '1–2 years', '2–5 years', '5–10 years', '10+ years'],
  },

  /* ─── Step 2: Financials ─── */
  monthlyRevenue: {
    type: Number,
    required: [true, 'Monthly revenue is required'],
    min: 0,
  },

  monthlyProfit: {
    type: Number,
    required: [true, 'Monthly profit is required'],
    min: 0,
  },

  askingPrice: {
    type: Number,
    required: [true, 'Asking price is required'],
    min: 0,
  },

  vatRegistered: {
    type: Boolean,
    default: false,
  },

  /* ─── Step 3: Contact ─── */
  ownerName: {
    type: String,
    required: [true, 'Owner name is required'],
    trim: true,
  },

  ownerPhone: {
    type: String,
    required: [true, 'Phone number is required'],
  },

  ownerEmail: {
    type: String,
    trim: true,
    lowercase: true,
  },

  reasonForSale: {
    type: String,
    maxlength: 500,
  },

  /** Preferred exit format — ops maps to BusinessListing.listingType */
  preferredListingType: {
    type: String,
    enum: ['public_auction', 'private_sealed', 'off_market_reserved', 'buy_now', 'undecided'],
    default: 'undecided',
  },

  /* ─── Step 4: Document Readiness ─── */
  documents: {
    tradeLicenseReady: { type: Boolean, default: false },
    vatReturnsReady: { type: Boolean, default: false },
    bankStatementsReady: { type: Boolean, default: false },
  },

  /* ─── Uploaded Files (after verification call) ─── */
  uploadedFiles: [{
    type: { type: String, enum: ['trade_license', 'vat_returns', 'bank_statements', 'other'] },
    filename: String,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
  }],

  /* ─── Internal Verification Workflow ─── */
  verificationStatus: {
    type: String,
    enum: ['submitted', 'contacted', 'documents_requested', 'under_review', 'approved', 'rejected', 'on_hold'],
    default: 'submitted',
    index: true,
  },

  verificationChecks: {
    vatFilings: { type: Boolean, default: false },
    banking: { type: Boolean, default: false },
    liabilities: { type: Boolean, default: false },
    legalCompliance: { type: Boolean, default: false },
    operationalInterview: { type: Boolean, default: false },
  },

  rejectionReason: String,

  internalNotes: String,

  assignedTo: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
  },

  /* ─── Linked Listing (if approved) ─── */
  businessListingId: {
    type: mongoose.Schema.ObjectId,
    ref: 'BusinessListing',
  },

  /* ─── Source Tracking ─── */
  source: {
    type: String,
    enum: ['website', 'referral', 'whatsapp', 'direct', 'other'],
    default: 'website',
  },

  ipAddress: String,
  userAgent: String,

  /* ─── Notifications ─── */
  notifications: {
    confirmationSent: { type: Boolean, default: false },
    confirmationSentAt: Date,
    whatsappSent: { type: Boolean, default: false },
    whatsappSentAt: Date,
    adminNotified: { type: Boolean, default: false },
  },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/* ─── Pre-validate: auto-generate submission number ─── */
sellerSubmissionSchema.pre('validate', async function (next) {
  if (!this.submissionNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('SellerSubmission').countDocuments() + 1;
    const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    this.submissionNumber = `QSS-${year}${month}-${String(count).padStart(4, '0')}-${suffix}`;
  }
  next();
});

/* ─── Virtuals ─── */
sellerSubmissionSchema.virtual('profitMargin').get(function () {
  if (this.monthlyRevenue && this.monthlyProfit) {
    return ((this.monthlyProfit / this.monthlyRevenue) * 100).toFixed(1) + '%';
  }
  return null;
});

sellerSubmissionSchema.virtual('priceToAnnualRevenue').get(function () {
  if (this.askingPrice && this.monthlyRevenue) {
    return (this.askingPrice / (this.monthlyRevenue * 12)).toFixed(2) + 'x';
  }
  return null;
});

/* ─── Indexes ─── */
sellerSubmissionSchema.index({ ownerEmail: 1 });
sellerSubmissionSchema.index({ ownerPhone: 1 });
sellerSubmissionSchema.index({ verificationStatus: 1 });
sellerSubmissionSchema.index({ createdAt: -1 });
sellerSubmissionSchema.index({ industry: 1 });

/* ─── Instance methods ─── */
sellerSubmissionSchema.methods.approve = async function () {
  this.verificationStatus = 'approved';
  return this.save();
};

sellerSubmissionSchema.methods.reject = async function (reason) {
  this.verificationStatus = 'rejected';
  this.rejectionReason = reason;
  return this.save();
};

const SellerSubmission = mongoose.model('SellerSubmission', sellerSubmissionSchema);

module.exports = SellerSubmission;


