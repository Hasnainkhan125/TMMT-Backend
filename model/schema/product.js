const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  store:         { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  name:          { type: String, required: true, trim: true, maxlength: 200 },
  description:   { type: String, maxlength: 3000, default: '' },
  price:         { type: Number, required: true, min: 0 },
  comparePrice:  { type: Number, min: 0, default: null },  // original price for "sale" display
  currency:      { type: String, default: 'AED' },
  quantity:      { type: Number, default: 0, min: 0 },
  images:        [{ type: String }],   // S3 URLs (up to 8)
  category:      { type: String, default: '' },
  tags:          [{ type: String }],
  sku:           { type: String, default: '' },
  weight:        { type: Number, default: 0 },  // grams, for shipping
  isPublished:   { type: Boolean, default: true },
  isFeatured:    { type: Boolean, default: false },
  salesCount:    { type: Number, default: 0 },
  /** Cached NAS / ICP lead payload (synced from external job or manual import) */
  nasLeadsCache: { type: mongoose.Schema.Types.Mixed, default: null },
  productType:   { type: String, default: 'PHYSICAL_PRODUCT' },
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
