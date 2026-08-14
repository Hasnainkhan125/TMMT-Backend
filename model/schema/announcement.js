const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  level: { type: String, enum: ['info','warning','critical'], default: 'info' },
  active: { type: Boolean, default: true, index: true },
  locale: { type: String, default: 'en' },
  createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
  startsAt: { type: Date },
  endsAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);


