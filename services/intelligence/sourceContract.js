'use strict';

/**
 * sourceContract — the shape every Layer-2 collector must conform to.
 *
 * Every collector is a class with:
 *   - `name`      : stable string used in metrics / circuit breakers / reports
 *   - `reliability`: hint for the orchestrator (0–1) — lower reliability means
 *                    the breaker opens on smaller error samples
 *   - `async collect(brandIdentity, ctx)` : performs the work.
 *
 * Return shape from `collect`:
 *   {
 *     success:     boolean
 *     data:        <collector-specific payload>   // present if success
 *     reason:      <short code>                    // present if !success
 *     retryable:   boolean                         // optional hint
 *     fromCache:   boolean                         // optional
 *     durationMs:  number                          // orchestrator fills in
 *     recordsCollected: number                     // for dashboards
 *   }
 *
 * Collectors MUST NOT throw for expected failures (site blocked, no handle,
 * empty results). They should return `{ success: false, reason: '…' }` so
 * the orchestrator can feed that into the circuit breaker intelligently.
 * Uncaught throws are treated as hard bugs.
 */

class BaseCollector {
  /**
   * @param {string} name
   * @param {object} opts
   * @param {number} opts.reliability — 0-1, defaults to 0.8
   * @param {object} opts.cache       — optional Redis-like adapter for TTL caches
   */
  constructor(name, opts = {}) {
    if (!name) throw new Error('BaseCollector: name is required');
    this.name = name;
    this.reliability = opts.reliability ?? 0.8;
    this.cache = opts.cache || null;
  }

  // Subclasses override this. Must not throw for expected failures.
  async collect(_brandIdentity, _ctx = {}) {
    throw new Error(`Collector ${this.name} does not implement collect()`);
  }

  // Helper for cache-first collection. `keyFn` returns a string key, `ttl`
  // is seconds. `compute` is the actual fetch; only called on miss.
  async cached(keyFn, ttlSec, compute) {
    if (!this.cache || !keyFn || !ttlSec) return compute();
    const key = `intel:${this.name}:${keyFn()}`;
    try {
      const hit = await this.cache.get(key);
      if (hit) {
        return { ...JSON.parse(hit), fromCache: true };
      }
    } catch (_e) {
      // Cache read failures are non-fatal — fall through and recompute.
    }
    const result = await compute();
    if (result?.success && this.cache) {
      try {
        await this.cache.set(key, JSON.stringify(result), 'EX', ttlSec);
      } catch (_e) {
        // Cache write failures don't propagate.
      }
    }
    return result;
  }

  // Graceful failure helpers — subclasses call these instead of throwing.
  softFail(reason, extra = {}) {
    return { success: false, reason, retryable: false, ...extra };
  }

  retryableFail(reason, extra = {}) {
    return { success: false, reason, retryable: true, ...extra };
  }

  ok(data, extra = {}) {
    return {
      success: true,
      data: data || {},
      recordsCollected: estimateRecords(data),
      ...extra,
    };
  }
}

function estimateRecords(data) {
  if (!data || typeof data !== 'object') return 0;
  let count = 0;
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

module.exports = { BaseCollector };
