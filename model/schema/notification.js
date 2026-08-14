const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.ObjectId, ref: 'User', index: true, required: true },
  applicationId: { type: mongoose.Schema.ObjectId, ref: 'VisaApplication' },
  type: { type: String, enum: ['info', 'success', 'warning', 'error', 'docs_required', 'status_update', 'payment'], default: 'info' },
  title: { type: String },
  message: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed },
  read: { type: Boolean, default: false },
}, { timestamps: true });

notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);


