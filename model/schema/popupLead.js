const mongoose = require('mongoose');

const popupLeadSchema = new mongoose.Schema({
  leadNumber: {
    type: String,
    unique: true,
  },
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    trim: true,
    default: '',
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true,
  },
  service: {
    type: String,
    enum: ['business-setup', 'visa-inquiry', 'ecommerce', 'talk-to-expert', 'family-visa', 'acquire-business', null],
    default: null,
  },
  source: {
    type: String,
    default: 'welcome_popup',
  },
  page: {
    type: String,
    default: '/',
  },
  message: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'converted', 'not-interested'],
    default: 'new',
  },
  notes: {
    type: String,
    default: '',
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, {
  timestamps: true,
});

// Auto-generate lead number
popupLeadSchema.pre('validate', async function(next) {
  if (!this.leadNumber) {
    const count = await this.constructor.countDocuments();
    this.leadNumber = `PL-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

// Indexes
popupLeadSchema.index({ phone: 1 });
popupLeadSchema.index({ email: 1 });
popupLeadSchema.index({ status: 1 });
popupLeadSchema.index({ service: 1 });
popupLeadSchema.index({ source: 1 });
popupLeadSchema.index({ createdAt: -1 });

const PopupLead = mongoose.model('PopupLead', popupLeadSchema);

module.exports = PopupLead;
