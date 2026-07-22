'use strict';

/**
 * requestContext — attaches a per-request id + child logger + timing hook.
 *
 * Adds to every request:
 *   req.id       — a short stable id, surfaced as `x-request-id` response header.
 *                  If the client sent `x-request-id`, we honor it (useful for
 *                  multi-service tracing). Otherwise we generate one.
 *   req.log      — a logger bound with { requestId, userId, sessionId, method, path }.
 *   req.startTime — hrtime marker so downstream middleware can measure.
 *
 * On response finish we emit a single structured access-log record and bump
 * the http_requests_total counter (if metrics is loaded). This gives us the
 * "one request, one line" view ops dashboards expect.
 *
 * Placement: must be registered BEFORE routes. Safe BEFORE auth — userId will
 * just be null until auth populates req.user, which the access log captures
 * on response finish.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { getStudioSessionId } = require('./studioIdentity');

// Short-id generator: 12 hex chars is collision-safe for request volume
// we'd see in a year at 1k RPS, and much more readable in logs than a uuid.
function shortId() {
  return crypto.randomBytes(6).toString('hex');
}

// Routes we never want in access logs. Health checks dominate otherwise.
const QUIET_PATHS = new Set(['/health', '/metrics', '/favicon.ico']);

function requestContext(req, res, next) {
  // Incoming header takes precedence so multi-hop requests keep the same id.
  const inbound = req.headers['x-request-id'];
  req.id = (typeof inbound === 'string' && inbound.length > 0 && inbound.length < 128)
    ? inbound
    : shortId();

  res.setHeader('x-request-id', req.id);

  // Bind per-request context. Subsequent code can do req.log.info(...)
  // without re-attaching the request id every time.
  req.log = logger.child({
    requestId: req.id,
    method: req.method,
    path: req.originalUrl || req.url,
  });
  req.startTime = process.hrtime.bigint();

  res.on('finish', () => {
    // Skip noisy paths for the access log, but still bump metrics so
    // scrapes see the real request rate.
    const durationMs = Number(process.hrtime.bigint() - req.startTime) / 1e6;

    try {
      const metrics = require('../utils/metrics');
      metrics.observeHttp({
        method: req.method,
        route: (req.route && req.route.path) || req.path || 'unknown',
        status: res.statusCode,
        durationMs,
      });
    } catch (_e) { /* metrics optional */ }

    if (QUIET_PATHS.has(req.path)) return;

    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';

    req.log[level]({
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?._id || req.user?.id || null,
      sessionId: getStudioSessionId(req),
    }, 'http');
  });

  next();
}

module.exports = requestContext;
module.exports.shortId = shortId;
