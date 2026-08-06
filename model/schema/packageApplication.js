const mongoose = require('mongoose');

const packageApplicationSchema = new mongoose.Schema(
  {
    packageSlug: { type: String, required: true },
    packageName: { type: String, required: true },
    applicantType: { type: String, enum: ['outside', 'inside'], default: 'outside' },
    contact: {
      fullName: { type: String, required: true },
      email: { type: String },
      phone: { type: String, required: true },
      nationality: { type: String },
      preferredLanguage: { type: String, default: 'en' },
    },
    pricing: {
      baseAmount: { type: Number },
      currency: { type: String, default: 'AED' },
      priceType: { type: String },
    },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referenceId: { type: String, unique: true },

    // ─── Full status flow ──────────────────────────────────────────
    status: {
      type: String,
      enum: [
        'submitted',
        'contacted',
        'docs_required',
        'pending_payment',
        'paid',
        'processing',
        'completed',
        'rejected',
        'cancelled',
      ],
      default: 'submitted',
    },

    // ─── Documents uploaded by customer ───────────────────────────
    documents: [
      {
        docKey: String,
        label: String,
        filename: String,
        originalName: String,
        path: String,
        size: Number,
        mimeType: String,
        uploadedAt: { type: Date, default: Date.now },
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      },
    ],

    // ─── Documents requested from customer (by admin) ────────────
    requestedDocuments: [
      {
        label: { type: String, required: true },
        description: String,
        requestedAt: { type: Date, default: Date.now },
        status: { type: String, enum: ['pending', 'fulfilled', 'rejected'], default: 'pending' },
        fulfilledAt: Date,
      },
    ],

    // ─── Conversation / comments ──────────────────────────────────
    comments: [
      {
        message: { type: String, required: true },
        by: { type: String, enum: ['admin', 'customer', 'system'], default: 'admin' },
        authorName: String,
        at: { type: Date, default: Date.now },
      },
    ],

    // ─── Payment tracking ──────────────────────────────────────────
    payment: {
      status: { type: String, enum: ['unpaid', 'pending', 'paid', 'failed', 'refunded'], default: 'unpaid' },
      provider: String,
      paymentLink: String,
      paidAmount: Number,
      paidAt: Date,
      transactionId: String,
      metadata: mongoose.Schema.Types.Mixed,
    },

    // ─── History log ──────────────────────────────────────────────
    history: [
      {
        action: String,
        note: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      },
    ],

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Indexes
packageApplicationSchema.index({ status: 1, createdAt: -1 });
packageApplicationSchema.index({ referenceId: 1 });
packageApplicationSchema.index({ 'contact.fullName': 'text', 'contact.phone': 'text' });

module.exports = mongoose.model('PackageApplication', packageApplicationSchema);