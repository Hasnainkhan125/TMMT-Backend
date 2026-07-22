const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Job title is required'],
    trim: true
  },
  company: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true
  },
  location: {
    type: String,
    required: [true, 'Location is required'],
    trim: true
  },
  emirate: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['full_time', 'part_time', 'contract', 'freelance', 'internship'],
    required: true
  },
  category: {
    type: String,
    enum: [
      'technology', 'healthcare', 'finance', 'education', 'engineering',
      'marketing', 'sales', 'hospitality', 'construction', 'legal',
      'hr', 'logistics', 'retail', 'media', 'government', 'other'
    ],
    required: true
  },
  description: {
    type: String,
    required: [true, 'Job description is required']
  },
  requirements: [{
    type: String
  }],
  responsibilities: [{
    type: String
  }],
  salaryRange: {
    min: { type: Number },
    max: { type: Number },
    currency: { type: String, default: 'AED' },
    period: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' }
  },
  benefits: [{
    type: String
  }],
  visaSponsorship: {
    type: Boolean,
    default: false
  },
  experienceLevel: {
    type: String,
    enum: ['entry', 'mid', 'senior', 'lead', 'executive'],
    required: true
  },
  applicationFee: {
    type: Number,
    default: 0
  },
  applicationDeadline: {
    type: Date
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  applicationsCount: {
    type: Number,
    default: 0
  },
  views: {
    type: Number,
    default: 0
  },
  tags: [{
    type: String,
    trim: true
  }],
  contactEmail: {
    type: String,
    trim: true
  },
  contactPhone: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
jobSchema.index({ isActive: 1, createdAt: -1 });
jobSchema.index({ category: 1 });
jobSchema.index({ emirate: 1 });
jobSchema.index({ type: 1 });
jobSchema.index({ experienceLevel: 1 });
jobSchema.index({ title: 'text', company: 'text', description: 'text' });

const Job = mongoose.model('Job', jobSchema);
module.exports = Job;

