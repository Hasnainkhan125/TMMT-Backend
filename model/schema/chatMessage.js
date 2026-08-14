const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  application: { type: mongoose.Schema.Types.ObjectId, ref: 'VisaApplication', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  role: { type: String, enum: ['user', 'assistant', 'system'], default: 'user' },
  content: { type: String, required: true },
  language: { type: String, default: 'auto' },
  isAI: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('ChatMessage', chatMessageSchema); 