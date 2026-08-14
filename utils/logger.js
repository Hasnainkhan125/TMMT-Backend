'use strict';

/**
 * logger — zero-dep structured JSON logger.
 *
 * Why not pino/winston? We don't need log rotation or async sinks (we ship
 * stdout to whatever process manager collects it). We *do* need JSON with
 * consistent fields so our ops/alerting layer can parse it. That's ~60 lines.
 *
 * Log shape (one line per record):
 *   { "t": "2025-01-01T00:00:00.000Z", "level": "info", "msg": "...",
 *     "requestId": "...", "userId": "...", ... }
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info({ userId }, 'user signed up');
 *   logger.child({ requestId }).warn({ path }, 'slow response');
 *
 * In tests (NODE_ENV=test) we downgrade to a silent logger so the Jest
 * output stays readable — the tests themselves can inject a mock.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const ENV_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN = LEVELS[ENV_LEVEL] ?? 30;
const SILENT = process.env.NODE_ENV === 'test' && process.env.LOG_VERBOSE !== 'true';

/**
 * write — emit a single JSON line. Swallows errors so a broken log sink
 * never breaks a request; that's the whole point of a log call.
 */
function write(level, bindings, payload, msg) {
  if (SILENT) return;
  if (LEVELS[level] < MIN) return;
  try {
    // Merge order: bindings (from .child) → payload (per-call) → top-level
    // fields. Per-call fields win on conflict so callers can override.
    const rec = Object.assign(
      {
        t: new Date().toISOString(),
        level,
        msg: msg || (typeof payload === 'string' ? payload : undefined),
      },
      bindings,
      typeof payload === 'object' && payload !== null ? payload : {},
    );
    // Never leak stack traces of Error objects as-is — they break JSON.
    if (rec.err instanceof Error) {
      rec.err = { message: rec.err.message, stack: rec.err.stack, code: rec.err.code };
    }
    const line = JSON.stringify(rec);
    // level >= warn → stderr so container orchestrators surface it.
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
    else                              process.stdout.write(line + '\n');
  } catch (_e) {
    // last-resort console fallback
    // eslint-disable-next-line no-console
    console[level === 'error' || level === 'fatal' ? 'error' : 'log'](level, msg, payload);
  }
}

function makeLogger(bindings = {}) {
  // The call signature is intentionally compatible with pino's:
  //   logger.info({ foo }, 'msg')  or  logger.info('msg')
  const makeFn = (level) => (payloadOrMsg, msg) => {
    if (typeof payloadOrMsg === 'string') {
      return write(level, bindings, null, payloadOrMsg);
    }
    return write(level, bindings, payloadOrMsg, msg);
  };

  return {
    level: ENV_LEVEL,
    trace: makeFn('trace'),
    debug: makeFn('debug'),
    info:  makeFn('info'),
    warn:  makeFn('warn'),
    error: makeFn('error'),
    fatal: makeFn('fatal'),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

module.exports = makeLogger({ service: 'qumak-api' });
module.exports.makeLogger = makeLogger;
