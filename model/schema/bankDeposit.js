/**
 * BankDeposit — Tracks manual bank transfer deposits for marketplace listings
 */
const mongoose = require('mongoose');

const bankDepositSchema = new mongoose.Schema({
  depositNumber: { type: String, unique: true },

  listingId:  { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessListing', required: true, index: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  amount:     { type: Number, required: true },
  currency:   { type: String, default: 'AED' },

  // What they submitted
  senderName:   { type: String, required: true },
  senderBank:   { type: String },
  transferRef:  { type: String },          // bank reference number
  transferDate: { type: Date },
  proofUrl:     { type: String },          // uploaded screenshot/receipt

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected', 'refunded'],
    default: 'pending',
    index: true,
  },

  adminNote:   { type: String },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  confirmedAt: { type: Date },
  refundedAt:  { type: Date },

}, { timestamps: true });

bankDepositSchema.pre('validate', async function (next) {
  if (!this.depositNumber) {
    const d = new Date();
    const yy = d.getFullYear().toString().slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('BankDeposit').countDocuments() + 1;
    this.depositNumber = `QBD-${yy}${mm}-${String(count).padStart(4, '0')}`;
  }
  next();
});

bankDepositSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('BankDeposit', bankDepositSchema);
