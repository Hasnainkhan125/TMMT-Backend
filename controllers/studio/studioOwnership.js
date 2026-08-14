'use strict';

const { getStudioSessionId } = require('../../middelwares/studioIdentity');

/**
 * Mongo filter for listing jobs/assets for the current caller.
 * Admins must pass ?adminScope=all to disable scoping (support / QA only).
 */
function listOwnershipFilter(req) {
  const sessionId = getStudioSessionId(req);
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') {
    if (req.query?.adminScope === 'all') return {};
    if (req.user?._id && sessionId) {
      return { $or: [{ userId: req.user._id }, { sessionId }] };
    }
    if (req.user?._id) return { userId: req.user._id };
    if (sessionId) return { sessionId };
    return { _id: null };
  }
  if (req.user?._id && sessionId) {
    return { $or: [{ userId: req.user._id }, { sessionId }] };
  }
  if (req.user?._id) return { userId: req.user._id };
  if (sessionId) return { sessionId };
  return { _id: null };
}

module.exports = { listOwnershipFilter };
