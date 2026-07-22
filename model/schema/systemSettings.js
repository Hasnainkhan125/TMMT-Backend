/**
 * SystemSettings — key-value store for platform configuration
 * Used for: bank details, platform fees, feature flags, etc.
 */
const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true, trim: true },
  value: { type: mongoose.Schema.Types.Mixed },
  label: { type: String },         // human-readable description
  group: { type: String, default: 'general' }, // 'bank', 'fees', 'general'
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

systemSettingsSchema.statics.get = async function (key) {
  const doc = await this.findOne({ key });
  return doc ? doc.value : null;
};

systemSettingsSchema.statics.set = async function (key, value, meta = {}) {
  return this.findOneAndUpdate(
    { key },
    { $set: { key, value, ...meta } },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
