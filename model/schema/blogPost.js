const mongoose = require('mongoose');

const blogPostSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, unique: true, lowercase: true, trim: true },
  excerpt: { type: String, maxlength: 500 },
  content: { type: String, required: true },
  coverImage: { type: String },
  featured: { type: Boolean, default: false },
  publishedAt: { type: Date },
  tags: [{ type: String, trim: true }],
  author: { type: String, default: 'Qumak Team' },
}, { timestamps: true });

blogPostSchema.pre('save', function (next) {
  if (!this.slug && this.title) {
    this.slug = this.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  next();
});

blogPostSchema.index({ publishedAt: -1 });
blogPostSchema.index({ slug: 1 });

module.exports = mongoose.model('BlogPost', blogPostSchema);
