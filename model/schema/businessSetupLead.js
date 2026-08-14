const mongoose = require('mongoose');

const businessSetupLeadSchema = new mongoose.Schema({
  // Lead Information
  leadNumber: {
    type: String,
    unique: true
    // Not required - auto-generated in pre-validate hook
  },
  
  // Contact Information
  fullName: {
    type: String,
    required: [true, 'Full name is required']
  },
  email: {
    type: String,
    // required: [true, 'Email is required'],
    // validate: {
    //   validator: function(v) {
    //     return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(v);
    //   },
    //   message: props => `${props.value} is not a valid email!`
    // }
  },
  phoneNumber: {
    type: String,
    // required: [true, 'Phone number is required']
  },
  countryCode: {
    type: String,
    default: '+971'
  },
  nationality: {
    type: String,
    // Not required for lite leads
  },

  // Business Setup Type
  setupType: {
    type: String,
    required: [true, 'Setup type is required'],
    enum: ['mainland', 'freezone']
  },

  // Freezone Specific
  freezone: {
    type: String,
    enum: [
      'RAKEZ',
      'AJMAN_FREEZONE',
      'MEYDAN_FREEZONE',
      'IFZA',
      'JAFZA',
      'DIFC',
      'DMCC',
      'ADGM',
      'SHAMS',
      'DAFZA',
      'SAIF_ZONE',
      'OTHER'
    ]
  },
  freezoneOther: {
    type: String // If user selects 'OTHER'
  },

  // Business Activity
  businessActivity: {
    type: String,
    required: [true, 'Business activity is required']
  },
  businessActivityCategory: {
    type: String,
    // enum: [
    //   'GENERAL_TRADING',
    //   'CONSULTANCY',
    //   'IT_SERVICES',
    //   'E_COMMERCE',
    //   'FOOD_BEVERAGE',
    //   'HEALTHCARE',
    //   'EDUCATION',
    //   'REAL_ESTATE',
    //   'CONSTRUCTION',
    //   'MANUFACTURING',
    //   'LOGISTICS',
    //   'IMPORT_EXPORT',
    //   'MEDIA_MARKETING',
    //   'TOURISM_HOSPITALITY',
    //   'PROFESSIONAL_SERVICES',
    //   'RETAIL',
    //   'OTHER'
    // ]
  },
  businessDescription: {
    type: String,
    maxlength: 1000
  },

  // Visa Requirements (for Mainland)
  visaCount: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  // Budget Range
  budgetRange: {
    type: String,
    required: [true, 'Budget range is required'],
    enum: [
      '4999_13000',     // 4,999 - 13,000 AED
      '13999_18999',    // 13,999 - 18,999 AED
      '25000_30000',    // 25,000 - 30,000 AED
      '30000_plus'      // 30,000+ AED (Custom/Premium)
    ]
  },

  // Estimated Costs (calculated by system)
  estimatedCost: {
    licenseFee: { type: Number, default: 0 },
    visaCost: { type: Number, default: 0 },
    officeCost: { type: Number, default: 0 },
    governmentFees: { type: Number, default: 0 },
    totalEstimate: { type: Number, default: 0 },
    currency: { type: String, default: 'AED' }
  },

  // Additional Preferences
  officeRequired: {
    type: String,
    enum: ['flexi_desk', 'dedicated_desk', 'private_office', 'warehouse', 'none'],
    default: 'none'
  },
  urgency: {
    type: String,
    enum: ['immediate', 'within_week', 'within_month', 'exploring'],
    default: 'exploring'
  },
  additionalServices: [{
    type: String,
    enum: [
      'bank_account_opening',
      'pro_services',
      'vat_registration',
      'accounting_services',
      'legal_documentation',
      'trademark_registration',
      'visa_processing',
      'office_setup'
    ]
  }],

  // Marketing & Source Tracking
  source: {
    type: String,
    enum: ['google_ads', 'facebook', 'instagram', 'linkedin', 'referral', 'organic', 'direct', 'landing_page_lite', 'cost_calculator', 'other'],
    default: 'direct'
  },
  
  // Lite Lead Flag
  isLiteLead: {
    type: Boolean,
    default: false
  },
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmContent: String,
  landingPage: String,
  referrer: String,

  // Lead Status & Management
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost', 'not_interested'],
    default: 'new',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  assignedTo: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  
  // Communication Log
  communications: [{
    type: {
      type: String,
      enum: ['email', 'whatsapp', 'call', 'meeting', 'note'],
      required: true
    },
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      default: 'outbound'
    },
    subject: String,
    content: String,
    sentAt: {
      type: Date,
      default: Date.now
    },
    sentBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'replied', 'failed'],
      default: 'sent'
    }
  }],

  // Quotation
  quotations: [{
    quotationNumber: String,
    totalAmount: Number,
    breakdown: mongoose.Schema.Types.Mixed,
    validUntil: Date,
    sentAt: Date,
    status: {
      type: String,
      enum: ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'],
      default: 'draft'
    },
    createdBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  }],

  // Consent & Compliance
  marketingConsent: {
    type: Boolean,
    default: false
  },
  termsAccepted: {
    type: Boolean,
    required: true,
    default: false
  },
  privacyAccepted: {
    type: Boolean,
    required: true,
    default: false
  },

  // Notification Tracking
  notifications: {
    emailSent: { type: Boolean, default: false },
    emailSentAt: Date,
    whatsappSent: { type: Boolean, default: false },
    whatsappSentAt: Date,
    adminNotified: { type: Boolean, default: false },
    adminNotifiedAt: Date,
    n8nTriggered: { type: Boolean, default: false },
    n8nTriggeredAt: Date
  },

  // Metadata
  ipAddress: String,
  userAgent: String,
  deviceType: {
    type: String,
    enum: ['mobile', 'tablet', 'desktop'],
    default: 'desktop'
  },
  
  // Conversion Tracking
  convertedToClient: {
    type: Boolean,
    default: false
  },
  convertedAt: Date,
  clientId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },

  // Notes
  internalNotes: String

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Generate unique lead number before validation
businessSetupLeadSchema.pre('validate', async function(next) {
  if (!this.leadNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('BusinessSetupLead').countDocuments() + 1;
    // Add random suffix to prevent duplicates during concurrent saves
    const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    this.leadNumber = `QBS-${year}${month}-${String(count).padStart(5, '0')}-${randomSuffix}`;
  }
  next();
});

// Indexes for better query performance
businessSetupLeadSchema.index({ email: 1 });
businessSetupLeadSchema.index({ phoneNumber: 1 });
businessSetupLeadSchema.index({ status: 1 });
businessSetupLeadSchema.index({ createdAt: -1 });
businessSetupLeadSchema.index({ setupType: 1, freezone: 1 });
businessSetupLeadSchema.index({ source: 1, createdAt: -1 });

// Virtual for full phone number
businessSetupLeadSchema.virtual('fullPhoneNumber').get(function() {
  return `${this.countryCode}${this.phoneNumber}`;
});

// Instance methods
businessSetupLeadSchema.methods.addCommunication = function(type, content, sentBy, direction = 'outbound') {
  this.communications.push({
    type,
    content,
    sentBy,
    direction,
    sentAt: new Date()
  });
  return this.save();
};

businessSetupLeadSchema.methods.updateStatus = function(newStatus, note) {
  this.status = newStatus;
  if (note) {
    this.communications.push({
      type: 'note',
      content: note,
      direction: 'outbound',
      sentAt: new Date()
    });
  }
  return this.save();
};

// Static method to calculate estimated costs
businessSetupLeadSchema.statics.calculateEstimatedCost = function(data) {
  let licenseFee = 0;
  let visaCost = 0;
  let officeCost = 0;
  let governmentFees = 0;

  // Base costs by setup type and freezone
  if (data.setupType === 'mainland') {
    licenseFee = 15000;
    governmentFees = 3000;
    visaCost = (data.visaCount || 0) * 3500;
  } else if (data.setupType === 'freezone') {
    const freezoneCosts = {
      'RAKEZ': { license: 5750, visa: 3000 },
      'AJMAN_FREEZONE': { license: 6500, visa: 3200 },
      'MEYDAN_FREEZONE': { license: 12000, visa: 3500 },
      'IFZA': { license: 11750, visa: 3500 },
      'JAFZA': { license: 15000, visa: 4000 },
      'DIFC': { license: 50000, visa: 5000 },
      'DMCC': { license: 18000, visa: 4500 },
      'ADGM': { license: 45000, visa: 5000 },
      'SHAMS': { license: 5750, visa: 3000 },
      'DAFZA': { license: 12000, visa: 3500 },
      'SAIF_ZONE': { license: 7500, visa: 3200 }
    };
    
    const freezoneData = freezoneCosts[data.freezone] || { license: 10000, visa: 3500 };
    licenseFee = freezoneData.license;
    visaCost = (data.visaCount || 0) * freezoneData.visa;
    governmentFees = 1500;
  }

  // Office costs
  const officeCosts = {
    'flexi_desk': 5000,
    'dedicated_desk': 12000,
    'private_office': 25000,
    'warehouse': 50000,
    'none': 0
  };
  officeCost = officeCosts[data.officeRequired] || 0;

  const totalEstimate = licenseFee + visaCost + officeCost + governmentFees;

  return {
    licenseFee,
    visaCost,
    officeCost,
    governmentFees,
    totalEstimate,
    currency: 'AED'
  };
};

const BusinessSetupLead = mongoose.model('BusinessSetupLead', businessSetupLeadSchema);

module.exports = BusinessSetupLead;

