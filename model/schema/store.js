const mongoose = require('mongoose');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const storeSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  slug:         { type: String, unique: true, index: true },
  name:         { type: String, required: true, trim: true, maxlength: 100 },
  description:  { type: String, maxlength: 1000, default: '' },
  profileImage: { type: String, default: '' },   // S3 URL
  coverImage:   { type: String, default: '' },   // S3 URL
  brandColor:   { type: String, default: '#944a00' },
  category:     {
    type: String,
    enum: ['perfume', 'skincare', 'jewelry', 'fashion', 'electronics', 'food', 'other'],
    default: 'other',
  },
  socialLinks: {
    instagram: { type: String, default: '' },
    tiktok:    { type: String, default: '' },
    facebook:  { type: String, default: '' },
    website:   { type: String, default: '' },
  },
  paymentConfig: {
    stripeAccountId: { type: String, default: '' },
    enabled:         { type: Boolean, default: false },
  },
  isPublished:  { type: Boolean, default: false },
  views:        { type: Number, default: 0 },
  currency:     { type: String, default: 'AED' },
}, { timestamps: true });

// Auto-generate slug on save
storeSchema.pre('save', async function (next) {
  if (!this.isModified('name') && this.slug) return next();
  let base = slugify(this.name);
  let slug = base;
  let count = 1;
  while (await mongoose.model('Store').findOne({ slug, _id: { $ne: this._id } })) {
    slug = `${base}-${count++}`;
  }
  this.slug = slug;
  next();
});

module.exports = mongoose.model('Store', storeSchema);
