const mongoose = require('mongoose');

const familyVisaLeadSchema = new mongoose.Schema({
  // Reference Number
  referenceNumber: {
    type: String,
    unique: true
  },
  
  // Contact Information
  fullName: {
    type: String,
    required: [true, 'Full name is required']
  },
  contactMethod: {
    type: String,
    enum: ['whatsapp', 'email'],
    required: true
  },
  contactValue: {
    type: String,
    required: [true, 'Contact information is required']
  },
  
  // Sponsor Information
  sponsorSalary: {
    type: Number,
    required: [true, 'Salary is required'],
    min: 0
  },
  visaStatus: {
    type: String,
    enum: ['employment', 'partner', 'investor'],
    required: [true, 'Visa status is required']
  },
  nationality: {
    type: String,
    required: [true, 'Nationality is required']
  },
  
  // Dependent Information
  dependentType: {
    type: String,
    enum: ['spouse', 'child', 'parent'],
    required: [true, 'Dependent type is required']
  },
  numberOfDependents: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  
  // Eligibility Result
  eligibilityResult: {
    eligible: {
      type: Boolean,
      required: true
    },
    reasons: [{
      type: String
    }]
  },
  
  // Lead Status
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'converted', 'not_interested'],
    default: 'new',
    index: true
  },
  
  // Communication Log
  communications: [{
    type: {
      type: String,
      enum: ['whatsapp', 'email', 'call', 'note'],
      required: true
    },
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      default: 'outbound'
    },
    content: String,
    sentAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Metadata
  ipAddress: String,
  userAgent: String,
  source: {
    type: String,
    default: 'direct'
  },
  
  // Conversion tracking
  convertedToApplication: {
    type: Boolean,
    default: false
  },
  applicationId: {
    type: mongoose.Schema.ObjectId,
    ref: 'VisaApplication'
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Generate unique reference number before validation
familyVisaLeadSchema.pre('validate', async function(next) {
  if (!this.referenceNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('FamilyVisaLead').countDocuments() + 1;
    const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    this.referenceNumber = `FVE-${year}${month}-${String(count).padStart(4, '0')}-${randomSuffix}`;
  }
  next();
});

// Indexes
familyVisaLeadSchema.index({ contactValue: 1 });
familyVisaLeadSchema.index({ status: 1 });
familyVisaLeadSchema.index({ createdAt: -1 });
familyVisaLeadSchema.index({ 'eligibilityResult.eligible': 1 });

// Static method to check eligibility
familyVisaLeadSchema.statics.checkEligibility = function(data) {
  const reasons = [];
  const salary = parseInt(data.sponsorSalary) || 0;
  
  // Salary requirements
  const salaryRequirements = {
    spouse: 4000,
    child: 4000,
    parent: 20000
  };
  
  const requiredSalary = salaryRequirements[data.dependentType] || 4000;
  
  if (salary < requiredSalary) {
    reasons.push(`Minimum salary of AED ${requiredSalary.toLocaleString()} required for ${data.dependentType} sponsorship (your salary: AED ${salary.toLocaleString()})`);
  }
  
  if (!data.visaStatus) {
    reasons.push('Valid UAE visa status required (Employment or Partner)');
  }
  
  if (data.visaStatus === 'partner' && data.dependentType === 'parent') {
    reasons.push('Partner visa holders may have restrictions on parent sponsorship - consultation recommended');
  }
  
  // Additional checks based on nationality
  const restrictedNationalities = ['iranian', 'syrian'];
  if (restrictedNationalities.includes(data.nationality?.toLowerCase())) {
    reasons.push('Additional security clearance may be required for your nationality');
  }
  
  return {
    eligible: reasons.length === 0,
    reasons: reasons.length > 0 ? reasons : ['You meet the basic eligibility requirements!']
  };
};

const FamilyVisaLead = mongoose.model('FamilyVisaLead', familyVisaLeadSchema);

module.exports = FamilyVisaLead;

