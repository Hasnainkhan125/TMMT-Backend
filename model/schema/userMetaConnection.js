'use strict';

const mongoose = require('mongoose');

const userMetaConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    accessToken: { type: String, default: null },
    tokenType: { type: String, default: 'bearer' },
    expiresAt: { type: Date, default: null },
    scopes: [{ type: String }],
    metaUserId: { type: String, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.models.UserMetaConnection
  || mongoose.model('UserMetaConnection', userMetaConnectionSchema);
