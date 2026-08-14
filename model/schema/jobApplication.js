const mongoose = require("mongoose");

const jobApplicationSchema = new mongoose.Schema({
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  applicant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Applicant details snapshot (in case user profile changes)
  applicantDetails: {
    fullName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String },
    nationality: { type: String },
    currentLocation: { type: String }
  },
  coverLetter: {
    type: String,
    trim: true
  },
  resumePath: {
    type: String
  },
  yearsOfExperience: {
    type: Number,
    min: 0
  },
  currentSalary: {
    type: Number
  },
  expectedSalary: {
    type: Number
  },
  noticePeriod: {
    type: String,
    enum: ['immediate', '1_week', '2_weeks', '1_month', '2_months', '3_months'],
    default: '1_month'
  },
  visaStatus: {
    type: String,
    enum: ['valid_visa', 'visit_visa', 'no_visa', 'cancellation_in_progress'],
    default: 'no_visa'
  },
  status: {
    type: String,
    enum: ['pending', 'reviewing', 'shortlisted', 'interview', 'offered', 'hired', 'rejected', 'withdrawn'],
    default: 'pending'
  },
  // Payment tracking
  payment: {
    status: {
      type: String,
      enum: ['not_required', 'pending', 'completed', 'failed', 'pay_later'],
      default: 'not_required'
    },
    amount: { type: Number, default: 0 },
    method: { type: String, enum: ['card', 'bank_transfer', 'wallet', 'pay_later'], default: 'card' },
    transactionId: { type: String },
    paidAt: { type: Date },
    payLaterDeadline: { type: Date }
  },
  notes: [{
    text: { type: String },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now }
  }],
  statusHistory: [{
    status: { type: String },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    reason: { type: String }
  }]
}, {
  timestamps: true
});

// Indexes
jobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true }); // One application per job per user
jobApplicationSchema.index({ applicant: 1, createdAt: -1 });
jobApplicationSchema.index({ job: 1, status: 1 });
jobApplicationSchema.index({ 'payment.status': 1 });

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);
module.exports = JobApplication;

