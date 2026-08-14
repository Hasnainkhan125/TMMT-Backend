'use strict';

const mongoose = require('mongoose');

const adCopySchema = new mongoose.Schema({
  assetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true, index: true },
  jobId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null },
  category:   { type: String, default: '' },
  brandName:  { type: String, default: '' },

  captions:   { type: [String], default: [] },   // 3 variants
  headlines:  { type: [String], default: [] },   // 2 variants
  ctas:       { type: [String], default: [] },   // 2 variants
  hashtags:   { type: [String], default: [] },   // 10 tags

  platform:   { type: String, default: 'instagram' },
  locale:     { type: String, default: 'gulf' },
  promptUsed: { type: String, default: '' },
  modelUsed:  { type: String, default: 'claude-haiku' }
}, { timestamps: true });

module.exports = mongoose.model('AdCopy', adCopySchema);
