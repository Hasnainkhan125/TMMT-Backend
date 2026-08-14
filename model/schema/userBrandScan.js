'use strict';

const mongoose = require('mongoose');

/**
 * UserBrandScan — M:N join between users and the deduplicated Brand table.
 *
 * Every time a user "scans" a brand URL, we look up (or create) the shared
 * Brand record and then insert a UserBrandScan linking the user to that
 * brand. This lets us:
 *   - enforce free-tier quotas (count distinct brands scanned this month)
 *   - power "my war room" — saved brands per user
 *   - let the user tag/note a brand without mutating the shared Brand doc
 */
const userBrandScanSchema = new mongoose.Schema(
  {
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    sessionId: { type: String, default: null, index: true },

    firstScannedAt:  { type: Date, default: Date.now },
    lastAccessedAt:  { type: Date, default: Date.now },

    tags:  { type: [String], default: [] },
    notes: { type: String, default: '' },

    /** Has the user pinned this brand to their "war room" for ongoing tracking? */
    saved: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

userBrandScanSchema.index({ userId: 1, brandId: 1 }, { unique: true });
userBrandScanSchema.index({ userId: 1, saved: 1, lastAccessedAt: -1 });

module.exports = mongoose.models.UserBrandScan
  || mongoose.model('UserBrandScan', userBrandScanSchema);
