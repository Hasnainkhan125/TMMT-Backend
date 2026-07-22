const mongoose = require('mongoose');

const visaApplicationSchema = new mongoose.Schema({
  // Application Details
  applicationType: {
    type: String,
    required: [true, 'Application type is required'],
    enum: [
      // New Entry Permits
      'son_daughter_residence_visa',
      'spouse_residence_visa',
      'parents_residence_visa',
      'investor_partner_visa',
      'entry_permit_short_term_visit_parents_siblings_inlaws',
      'entry_permit_short_term_visit_spouse_kids',
      'entry_permit_long_term_visit_parents_siblings_inlaws',
      'entry_permit_long_term_visit_spouse_kids',
      
      // Change Status
      'change_status_family',
      'change_status_employee',
      'change_status_visit_visa',
      
      // Visa Stamping
      'spouse_children_visa_stamping',
      'parents_visa_stamping',
      'employee_visa_stamping',
      'son_daughter_visa_stamping',
      'partner_investor_visa_stamping_2_years',
      
      // Residence Visa Renewal
      'spouse_children_visa_renewal',
      'son_above_18_visa_renewal',
      'partner_investor_visa_renewal_2_years',
      'parents_visa_renewal_1_year',
      
      // Cancellation
      'family_residence_visa_cancellation',
      'employment_visa_cancellation',
      'partner_investor_visa_cancellation',
      'cancellation_entry_permit_before_entry_company',
      'cancellation_entry_permit_after_entry_family',
      'cancellation_entry_permit_after_entry_company',
      
      // Newborn & Employment
      'new_born_residence_visa',
      'employment_visa',
      
      // Golden Visa
      'golden_visa_commercial_investor',
      'golden_visa_director_manager',
      'golden_visa_doctors',
      'golden_visa_engineers',
      'golden_visa_new_born_baby',
      'golden_visa_phd_holder',
      'golden_visa_scientists',
      'golden_visa_family_members',
      'golden_visa_commercial_investor_2m_deposit',
      'golden_visa_outstanding_student_highschool',
      'golden_visa_outstanding_student_university',
      'golden_visa_creative_people_culture_art',
      
      // Establishment Card
      'new_establishment_card_with_online',
      'new_establishment_card_without_online',
      'renewal_establishment_card_with_online',
      'renewal_establishment_card_without_online',
      'immigration_employee_list',
      'modification_immigration_card',
      
      // Holding Visa
      'holding_visa_family',
      
      // Data Modification
      'data_modification_family',
      'data_modification_company',
      
      // PRO Card
      'new_pro_card',
      'renewal_pro_card',
      'modify_pro_card',
      'reconsideration_rejected_visa_application',
      
      // Visa Extension
      'family_visit_visa_extend',
      
      // Travel Report
      'travel_report_family',
      'travel_report_company',
      
      // Security Deposit
      'security_deposit',
      
      // Legacy (for backward compatibility)
      'family_visa_spouse',
      'family_visa_child',
      'residence_visa',
      'entry_permit',
      'emirates_id',
      'visa_renewal',
      'medical',
      'change_status',
      'visa_stamping'
    ]
  },
  status: {
    type: String,
    required: [true, 'Status is required'],
    enum: ['draft', 'submitted', 'under_review', 'docs_required', 'approved', 'rejected', 'closed', 'fraud_detected', 'penalty_issued'],
    default: 'draft'
  },
  accessStatus: {
    type: String,
    enum: ['normal', 'frozen', 'blocked'],
    default: 'normal',
    index: true
  },

  // Sponsor Information - Only userId required, Amer officer will collect other data
  sponsor: {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: [true, 'Sponsor user ID is required']
    },
    firstName: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    lastName: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    email: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    phone: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    emiratesId: {
      type: String
      // Removed required - Amer officer will collect this data
    }
  },

  // Sponsored Person Information - All optional, Amer officer will collect data
  sponsored: {
    firstName: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    lastName: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    dateOfBirth: {
      type: Date
      // Removed required - Amer officer will collect this data
    },
    nationality: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    passportNumber: {
      type: String
      // Removed required - Amer officer will collect this data
    },
    relationship: {
      type: String,
      enum: ['spouse', 'child', 'parent', 'other']
      // Removed required - Amer officer will collect this data
    },
    occupation: String,
    income: Number
  },

  // Document Attachments (applicant submitted documents)
  attachments: [{
    type: {
      type: String,
      required: true,
      // enum: [
      //   'sponsor_visa',
      //   'sponsor_emirates_id',
      //   'sponsor_passport',
      //   'sponsor_salary_certificate',
      //   'sponsor_trade_license',
      //   'sponsor_establishment_card',
      //   'sponsored_passport_front',
      //   'sponsored_passport_back',
      //   'sponsored_photo',
      //   'marriage_certificate',
      //   'birth_certificate',
      //   'medical_certificate',
      //   'police_clearance',
      //   'other'
      // ]
    },
    label: {
      type: String,
      // required: true
    },
    path: {
      type: String,
      required: true
    },
    originalName: {
      type: String,
      required: true
    },
    fileSize: {
      type: Number,
      required: true
    },
    mimeType: {
      type: String,
      required: true
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'requested'],
      default: 'pending'
    },
    extractedData: {
      type: mongoose.Schema.Types.Mixed
    },
    isRequested: {
      type: Boolean,
      default: false
    },
    requestedAt: {
      type: Date
    },
    requestedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    rejectionReason: {
      type: String
    },
    rejectedAt: {
      type: Date
    },
    rejectedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    approvedAt: {
      type: Date
    },
    approvedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    comments: [{
      userId: {
        type: mongoose.Schema.ObjectId,
        ref: 'User',
        required: true
      },
      comment: String,
      timestamp: {
        type: Date,
        default: Date.now
      }
    }]
  }],

  // Result Documents (ICP receipts, transaction papers, visa approvals - uploaded by Amer officers)
  resultDocuments: [{
    type: {
      type: String,
      required: true,
      enum: ['icp_receipt', 'transaction_paper', 'visa_approval', 'visa_result', 'other_result']
    },
    label: {
      type: String,
      required: true
    },
    path: {
      type: String,
      required: true
    },
    originalName: {
      type: String,
      required: true
    },
    fileSize: {
      type: Number,
      required: true
    },
    mimeType: {
      type: String,
      required: true
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: true
    },
    uploadedByRole: {
      type: String,
    },
    extractedData: {
      type: mongoose.Schema.Types.Mixed
    },
    description: {
      type: String
    },
    isPublic: {
      type: Boolean,
      default: true
    },
    downloadUrl: {
      type: String
    }
  }],

  // Application Metadata
  metadata: {
    submittedAt: Date,
    lastUpdated: {
      type: Date,
      default: Date.now
    },
    completedAt: Date,
    assignedOfficer: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    govStage: { type: String, enum: ['draft','mohre_pending','gdrfa_pending','icp_pending','printing','completed'], default: 'draft' },
    requiredDocuments: [{ type: String }],
    // Service information from services.json
    serviceId: { type: String },
    serviceName: { type: String },
    serviceRequirements: [{ type: String }],
    chatHistory: [{
      type: {
        type: String,
        enum: ['user', 'bot', 'system', 'amer'],
        required: true
      },
      content: {
        type: String,
        required: true
      },
      timestamp: {
        type: Date,
        default: Date.now
      },
      userId: mongoose.Schema.ObjectId
    }]
  },

  // Fraud Detection
  fraudAlerts: [{
    type: {
      type: String,
      enum: ['document_verification', 'identity_mismatch', 'suspicious_activity', 'other'],
      required: true
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high'],
      required: true
    },
    description: String,
    detectedAt: {
      type: Date,
      default: Date.now
    },
    resolvedAt: Date,
    resolvedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  }],

  // Penalties
  penalties: [{
    type: {
      type: String,
      enum: ['late_submission', 'document_forgery', 'false_information', 'other'],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    description: String,
    issuedAt: {
      type: Date,
      default: Date.now
    },
    issuedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: true
    },
    paidAt: Date,
    paymentReference: String
  }],

  // Payments (application fees, priority boosts, etc.)
  payments: [{
    type: {
      type: String,
      enum: ['application_fee', 'priority_boost', 'additional_service', 'government_fee', 'other'],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: 'AED'
    },
    description: String,
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending'
    },
    paymentMethod: {
      type: String,
      enum: ['card', 'bank_transfer', 'cash', 'wallet', 'other']
    },
    transactionId: String,
    receiptUrl: String,
    paidAt: {
      type: Date,
      default: Date.now
    },
    paidBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed
    }
  }],

  // Requested Documents (documents requested by Amer officers)
  requestedDocuments: [{
    documentType: {
      type: String,
      required: true
    },
    description: String,
    requestedAt: {
      type: Date,
      default: Date.now
    },
    requestedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    deadline: Date,
    status: {
      type: String,
      enum: ['pending', 'uploaded', 'approved'],
      default: 'pending'
    },
    uploadedDocumentId: mongoose.Schema.ObjectId,
    uploadedAt: Date
  }],

  // OTP Requests (for verification purposes)
  otpRequests: [{
    phone: {
      type: String,
      required: true
    },
    code: String,
    purpose: {
      type: String,
      default: 'verification'
    },
    requestedAt: {
      type: Date,
      default: Date.now
    },
    requestedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    expiresAt: Date,
    verifiedAt: Date,
    status: {
      type: String,
      enum: ['pending', 'verified', 'expired', 'failed'],
      default: 'pending'
    }
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Application history (actions log)
visaApplicationSchema.add({
  history: [{
    action: { type: String, required: true },
    by: { type: String },
    note: { type: String },
    at: { type: Date, default: Date.now }
  }]
});

// Indexes
visaApplicationSchema.index({ 'sponsor.userId': 1 });
visaApplicationSchema.index({ status: 1 });
visaApplicationSchema.index({ 'metadata.assignedOfficer': 1 });
visaApplicationSchema.index({ createdAt: 1 });

// Virtual populate reviews
visaApplicationSchema.virtual('reviews', {
  ref: 'Review',
  foreignField: 'application',
  localField: '_id'
});

// Pre-save middleware
visaApplicationSchema.pre('save', function(next) {
  this.metadata.lastUpdated = new Date();
  next();
});

// Instance methods
visaApplicationSchema.methods.isComplete = function() {
  // Simplified completion check - only requires document uploads
  return this.status !== 'draft' && this.attachments.length > 0;
};

visaApplicationSchema.methods.canSubmit = function() {
  // Application can be submitted with just documents - Amer officer will collect other data
  return this.attachments.length > 0;
};

visaApplicationSchema.methods.addComment = function(userId, comment) {
  this.metadata.chatHistory.push({
    type: 'user',
    content: comment,
    userId
  });
  return this.save();
};

visaApplicationSchema.methods.addFraudAlert = function(type, severity, description) {
  this.fraudAlerts.push({
    type,
    severity,
    description
  });
  return this.save();
};

visaApplicationSchema.methods.issuePenalty = function(type, amount, description, issuedBy) {
  this.penalties.push({
    type,
    amount,
    description,
    issuedBy
  });
  return this.save();
};

const VisaApplication = mongoose.model('VisaApplication', visaApplicationSchema);

module.exports = VisaApplication;