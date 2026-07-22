const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema({
  type: { type: String, required: true },
  path: { type: String, required: true },
  remarks: { type: String, default: "" },
  uploadDate: { type: Date, default: Date.now },
  expiryDate: { type: Date },
  documentNumber: { type: String },
  issuedBy: { type: String },
  issuedDate: { type: Date },
  status: { 
    type: String, 
    enum: ['valid', 'expiring_soon', 'expired', 'pending'], 
    default: 'valid' 
  },
  notificationSent: { type: Boolean, default: false },
  lastNotificationDate: { type: Date }
}, { _id: true });

const fileRefSchema = new mongoose.Schema({
  path: { type: String, required: true },
  remarks: { type: String, default: "" }
}, { _id: false });

const userSchema = new mongoose.Schema({
  // Clerk linkage
  // clerkId: { type: String, index: true },


  firstName: {
    type: String,
    // required: [true, 'First name is required']
  },
  lastName: {
    type: String,
    // required: [true, 'Last name is required']
  },
  fullName: {
    type: String,
    default: function() {
      return `${this.firstName} ${this.lastName}`;
    }
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    validate: {
      validator: function(v) {
        return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(v);
      },
      message: props => `${props.value} is not a valid email!`
    }
  },
  phoneNumber: {
    type: String,
  },
  password: {
    type: String,
    // required: function() { return !this.clerkId; },
    minlength: [6, 'Password must be at least 6 characters']
  },


  onboardingProfile: {
    completed:        { type: Boolean, default: false },
 
    // Q: "Which best describes your creative identity?"
    creativeIdentity: {
      type: String,
      enum: ['Solo Creator', 'Marketing or Agency', 'Filmmaker or Editor', 'AI Freelancer', null],
      default: null
    },
 
    // Q: experience cadence
    experienceLevel: {
      type: String,
      enum: ['just_starting', 'occasionally', 'weekly', 'daily', null],
      default: null
    },
 
    // Q: "What is your primary goal?"
    primaryGoal: {
      type: String,
      enum: [
        'high_quality_content',
        'monetize_production',
        'automate_production',
        'social_media_growth',
        null
      ],
      default: null
    },
 
    // Q: multi-select "which AI capabilities will you need most?"
    capabilities: [{ type: String }],
 
    // Q: "How many image gens for your first month?"
    monthlyVolume: {
      type: String,
      enum: ['just_testing', 'regular_practice', 'unlimited', null],
      default: null
    },
 
    // Q: "How many quality videos per month?"
    videosPerMonth: { type: String, default: null },
 
    // Likert 1–5: "AI is my unfair advantage"
    aiAdvantageScore: { type: Number, min: 1, max: 5, default: null },
 
    // Q: "How did you hear about us?"
    referralSource: {
      type: String,
      enum: [
        'instagram', 'twitter', 'tiktok', 'youtube', 'google_search',
        'linkedin', 'chatgpt', 'reddit', 'facebook', 'news_articles',
        'word_of_mouth', 'other', null
      ],
      default: null
    },
 
    // Derived bucket shown on the summary screen
    creatorLevel: {
      type: String,
      enum: ['Beginner', 'Mid', 'Upper', 'Top'],
      default: 'Beginner'
    },
 
    // Raw answer map, for any question added later without a migration
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
 
    completedAt: { type: Date }
  },





  // Role & Department
  role: {
    type: String,
    default: 'user'
  },
  status: {
    type: String,
    enum: ['active', 'frozen', 'blocked'],
    default: 'active',
    index: true
  },
  

  
    // Password Reset Fields
    resetToken: String,
    resetTokenExpires: Date,
    
    // One-Time Password (OTP) fields
    otpCode: String,
    otpExpires: Date,
  
    // Additional Fields for Amer Officers
    passportNumber: String,
    /** UAE Emirates ID — used with passport for marketplace bidding eligibility */
    emiratesId: String,
    company: String,
    country: String,
    // Documents & Profile
    profilePicture: fileRefSchema,
    documents: [documentSchema],
    dependents: [new mongoose.Schema({
      firstName: String,
      lastName: String,
      relationship: { type: String, enum: ['spouse','child','parent','other'] },
      passportNumber: String,
      nationality: String,
      dateOfBirth: Date,
      email: String,
      phoneNumber: String,
    }, { _id: true, timestamps: true })],
  lastLogin: Date,
  deleted: {
    type: Boolean,
    default: false
  },

  // Referral System
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  referredByCode: {
    type: String,
    default: null
  },
  referralEarnings: {
    type: Number,
    default: 0
  },
  referralCount: {
    type: Number,
    default: 0
  },
  referralHistory: [{
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referredUserName: String,
    referredUserEmail: String,
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'VisaApplication' },
    commission: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'credited', 'withdrawn'], default: 'pending' },
    creditedAt: Date,
    createdAt: { type: Date, default: Date.now }
  }],

  // Video Review & Discount System
  videoReviews: [{
    videoUrl: { type: String, required: true },
    thumbnailUrl: String,
    duration: Number,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    discountAmount: { type: Number, default: 0 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: String,
    submittedAt: { type: Date, default: Date.now }
  }],
  platformCredits: {
    type: Number,
    default: 0
  },
  /** Set true after AED 10,000 Qumak Cashback Bonus is credited (signup or first bidding-limit fetch) */
  marketplaceOnboardingBonus: {
    type: Boolean,
    default: false,
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  topUpHistory: [{
    amount: { type: Number, required: true },
    method: { type: String, enum: ['bank_wire', 'card', 'crypto', 'institutional_credit'], default: 'bank_wire' },
    reference: String,
    status: { type: String, enum: ['pending', 'credited', 'failed'], default: 'credited' },
    creditedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  }],
  
  // Business Information
  business: {
    hasCompany: { type: Boolean, default: false },
    companyName: String,
    tradeLicense: {
      number: String,
      path: String,
      issueDate: Date,
      expiryDate: Date,
      authority: String,
      type: { type: String, enum: ['mainland', 'freezone', 'offshore'] }
    },
    establishmentType: { type: String, enum: ['mainland', 'freezone', 'offshore'] },
    businessActivity: String,
    establishmentCard: {
      number: String,
      path: String,
      expiryDate: Date
    }
  },

  // Compliance & Notifications
  compliance: {
    score: { type: Number, default: 100, min: 0, max: 100 },
    lastChecked: Date,
    expiringDocuments: [{ 
      documentId: mongoose.Schema.Types.ObjectId,
      documentType: String,
      expiryDate: Date,
      daysRemaining: Number
    }],
    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
      expiryReminder30Days: { type: Boolean, default: true },
      expiryReminder15Days: { type: Boolean, default: true },
      expiryReminder7Days: { type: Boolean, default: true }
    }
  },





  
  
}, 


{
  timestamps: true,
});




// Auto-generate referral code on save if not set
userSchema.pre('save', function(next) {
  if (!this.referralCode) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'QMK-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    this.referralCode = code;
  }
  next();
});

const User = mongoose.model('User', userSchema);
module.exports = User;
