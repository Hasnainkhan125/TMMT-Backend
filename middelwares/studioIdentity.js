'use strict';

/**
 * Anonymous Studio callers are keyed by `x-session-id` (set from browser
 * localStorage) or the `qumak_session` cookie. When neither is present we
 * mint a fresh id, Set-Cookie it (HttpOnly), and attach it to the request
 * so list endpoints never run "wide open" and credits/usage share the same
 * identity as generation.
 */

const crypto = require('crypto');

const STUDIO_SESSION_COOKIE = 'qumak_session';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeSessionKey(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length > 128 ? s.slice(0, 128) : s;
}

function readSessionFromHeadersCookies(req) {
  const h = normalizeSessionKey(req.headers['x-session-id']);
  if (h) return h;
  return normalizeSessionKey(req.cookies?.[STUDIO_SESSION_COOKIE]);
}

/**
 * Prefer middleware-attached id, then header, then cookie.
 */
function getStudioSessionId(req) {
  const fromReq = normalizeSessionKey(req.sessionId);
  if (fromReq) return fromReq;
  return readSessionFromHeadersCookies(req);
}

function ensureStudioIdentity(req, res, next) {
  if (req.sessionId != null && req.sessionId !== '') {
    return next();
  }

  if (req.user?._id) {
    req.sessionId = readSessionFromHeadersCookies(req);
    return next();
  }

  let sid = readSessionFromHeadersCookies(req);
  if (!sid) {
    sid = `sess_${crypto.randomBytes(16).toString('hex')}`;
    res.cookie(STUDIO_SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ONE_YEAR_MS,
      path: '/',
    });
  }
  req.sessionId = sid;
  return next();
}

module.exports = {
  STUDIO_SESSION_COOKIE,
  ensureStudioIdentity,
  getStudioSessionId,
};
