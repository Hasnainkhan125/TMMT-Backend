const mongoose = require('mongoose');

/**
 * AuctionDocument — documents associated with a business listing.
 * Uploaded by seller, verified by Qumak, accessible by NDA-signed buyers.
 */
const auctionDocumentSchema = new mongoose.Schema({

  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessListing',
    required: true,
    index: true,
  },

  /* ─── Who uploaded ─── */
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  uploaderRole: {
    type: String,
    enum: ['seller', 'admin', 'broker'],
    default: 'seller',
  },

  /* ─── Document Classification ─── */
  category: {
    type: String,
    enum: ['legal', 'financial', 'operational', 'ip', 'visa', 'other'],
    required: true,
    index: true,
  },

  documentType: {
    type: String,
    enum: [
      // Legal
      'moa', 'aoa', 'partnership_agreement', 'power_of_attorney', 'share_certificate',
      // Financial
      'bank_statement', 'audited_pl', 'tax_return', 'vat_filing', 'management_accounts',
      // Operational
      'trade_license', 'freezone_registration', 'noc', 'business_permit',
      // IP
      'trademark', 'domain_ownership', 'social_media_proof', 'software_license',
      // Visa
      'investor_visa', 'employee_visa_list', 'establishment_card',
      // Other
      'other',
    ],
    required: true,
  },

  label: { type: String, required: true, maxlength: 200 },
  description: { type: String, maxlength: 500 },

  /* ─── File Storage ─── */
  fileUrl: { type: String },      // Supabase / S3 URL
  fileName: { type: String },
  fileSize: { type: Number },     // bytes
  mimeType: { type: String },

  /* ─── Verification ─── */
  verificationStatus: {
    type: String,
    enum: ['missing', 'pending', 'self_submitted', 'verified', 'rejected'],
    default: 'pending',
    index: true,
  },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  verificationNote: String,

  /* ─── Access Control ─── */
  isConfidential: { type: Boolean, default: false },
  ndaRequired: { type: Boolean, default: false },

  /* ─── AI Extraction ─── */
  aiExtracted: {
    expiryDate: String,
    issuer: String,
    licenseNumber: String,
    summary: String,
    extractedAt: Date,
  },

  isRequired: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },

}, {
  timestamps: true,
});

auctionDocumentSchema.index({ listing: 1, category: 1, documentType: 1 });

const AuctionDocument = mongoose.model('AuctionDocument', auctionDocumentSchema);
module.exports = AuctionDocument;
