const mongoose = require('mongoose');

const checkSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  serviceId: {
    type: String,
    required: true,
  },
  serviceType: {
    type: String,
    required: true,
  },
  identifiers: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  speedTier: {
    type: String,
    enum: ['standard', 'fast-track'],
    default: 'standard',
  },
  documents: [{
    filename: String,
    originalName: String,
    path: String,
    mimeType: String,
    size: Number,
  }],
  status: {
    type: String,
    enum: ['pending', 'processing', 'reviewing', 'requires_documents', 'completed', 'failed', 'cancelled', 'submitted', 'draft'],
    default: 'pending',
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  processedAt: {
    type: Date,
  },
  notes: {
    type: String,
  },
  
  // ─── COMMENTS ──────────────────────────────────────────────────────────────
  comments: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    text: {
      type: String,
      required: true,
    },
    message: {
      type: String,
    },
    by: {
      type: String,
      enum: ['admin', 'customer', 'system'],
      default: 'customer',
    },
    authorName: {
      type: String,
      default: 'User',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    role: {
      type: String,
      default: 'customer',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    at: {
      type: Date,
      default: Date.now,
    }
  }],
  
  // ─── REQUESTED DOCUMENTS ──────────────────────────────────────────────────
  requestedDocuments: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    label: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    fulfilledAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['pending', 'fulfilled', 'rejected'],
      default: 'pending',
    },
    documentId: {
      type: String,
      default: null,
    }
  }],
  
  // ─── RESULT DOCUMENTS ──────────────────────────────────────────────────────
  resultDocuments: [{
    filename: {
      type: String,
      required: true,
    },
    originalName: {
      type: String,
    },
    size: {
      type: Number,
    },
    mimeType: {
      type: String,
    },
    path: {
      type: String,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }
  }],
  
  // ─── RESULT SUMMARY & STATUS ─────────────────────────────────────────────
  resultSummary: {
    type: String,
    default: '',
  },
  resultStatus: {
    type: String,
    enum: ['clear', 'flagged', 'pending'],
    default: 'pending',
  },
  
  // ─── HISTORY ──────────────────────────────────────────────────────────────
  history: [{
    action: {
      type: String,
    },
    note: {
      type: String,
    },
    at: {
      type: Date,
      default: Date.now,
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    byRole: {
      type: String,
      default: 'system',
    }
  }],
  
  // ─── PAYMENT ──────────────────────────────────────────────────────────────
  isFreeService: {
    type: Boolean,
    default: false,
  },
  amount: {
    type: Number,
    default: 0,
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

checkSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

checkSchema.index({ userId: 1, createdAt: -1 });
checkSchema.index({ status: 1 });
checkSchema.index({ serviceId: 1 });

module.exports = mongoose.model('Check', checkSchema);