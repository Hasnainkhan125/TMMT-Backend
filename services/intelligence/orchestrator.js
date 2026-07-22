'use strict';

/**
 * CollectionOrchestrator — Layer 2 of the intelligence engine.
 *
 * Given a BrandIdentity, it runs every registered collector in parallel,
 * wraps each in a per-source circuit breaker (opossum), and returns a
 * structured per-source report. One collector blowing up, Meta starting
 * to block scrapers, or a transient timeout will NEVER crash the pipeline
 * — the breaker opens, that source is skipped for the reset window, and
 * the remaining sources still produce signals.
 *
 * Why opossum and not a hand-rolled breaker:
 *   - already an approved dependency in this repo (falCircuitBreaker uses it)
 *   - rolling window + volume threshold = no flapping on cold starts
 *   - emits events (open/halfOpen/close) we can wire to ops dashboards
 *
 * Design notes:
 *   - Breakers are keyed by collector `name` and live for process lifetime.
 *   - `collectAll` is idempotent — calling twice in parallel on the same
 *     identity will produce two independent runs (collectors handle cache).
 *   - The orchestrator never mutates the identity — collectors may return
 *     discovered landing domains, which the caller persists.
 */

const CircuitBreaker = require('opossum');

class CollectionOrchestrator {
  /**
   * @param {BaseCollector[]} collectors — array of Layer-2 collectors
   * @param {object} opts
   *   breakerTimeoutMs      — per-collector hard timeout, default 25s
   *   errorThresholdPercent — open the breaker at this %, default 50
   *   rollingCountMs        — rolling window, default 5 min
   *   resetTimeoutMs        — attempt recovery after, default 2 min
   *   logger                — injected logger (defaults to console)
   */
  constructor(collectors, opts = {}) {
    if (!Array.isArray(collectors) || !collectors.length) {
      throw new Error('CollectionOrchestrator: collectors array is required');
    }
    this.collectors = collectors;
    this.logger = opts.logger || console;

    const breakerOpts = {
      timeout: opts.breakerTimeoutMs ?? 25_000,
      errorThresholdPercentage: opts.errorThresholdPercent ?? 50,
      rollingCountTimeout: opts.rollingCountMs ?? 5 * 60_000,
      rollingCountBuckets: 10,
      resetTimeout: opts.resetTimeoutMs ?? 2 * 60_000,
      // Don't open the breaker on the first failure — wait for signal.
      volumeThreshold: 4,
    };

    this.breakers = new Map();
    for (const collector of this.collectors) {
      // A breaker expects a fn(args) and times out if it hangs. We wrap the
      // collector's `collect` so collector-level soft failures (returning
      // `{success:false}`) don't trip the breaker — only uncaught errors
      // and timeouts do. This is important: we DON'T want the breaker to
      // open just because Meta returned an empty result for one brand.
      const breaker = new CircuitBreaker(
        async (identity, ctx) => {
          const result = await collector.collect(identity, ctx);
          // Convert retryable soft-fails into thrown errors so the breaker
          // sees them as signals; non-retryable ones remain graceful.
          if (result && result.success === false && result.retryable) {
            throw Object.assign(new Error(result.reason || 'retryable_fail'), {
              code: result.reason || 'retryable_fail',
            });
          }
          return result;
        },
        {
          ...breakerOpts,
          // Tune threshold by collector's own reliability hint — less
          // reliable sources (e.g. Meta Ad Library) open sooner.
          errorThresholdPercentage: Math.round(
            (opts.errorThresholdPercent ?? 50) * (collector.reliability ?? 0.8),
          ),
          name: `intel:${collector.name}`,
        },
      );

      breaker.on('open', () => this.logger.warn?.(`[intel] breaker open for ${collector.name}`));
      breaker.on('halfOpen', () => this.logger.info?.(`[intel] breaker half-open for ${collector.name}`));
      breaker.on('close', () => this.logger.info?.(`[intel] breaker closed for ${collector.name}`));
      breaker.fallback(() => ({ success: false, reason: 'circuit_open' }));

      this.breakers.set(collector.name, breaker);
    }
  }

  /**
   * Run every collector in parallel. Returns a per-source report plus the
   * merged `data` payload (keyed by collector name) that downstream
   * extractors consume.
   */
  async collectAll(brandIdentity, ctx = {}) {
    if (!brandIdentity || !brandIdentity.canonicalDomain) {
      throw new Error('collectAll: brandIdentity with canonicalDomain required');
    }

    const startedAt = Date.now();

    const tasks = this.collectors.map(async (collector) => {
      const breaker = this.breakers.get(collector.name);
      const t0 = Date.now();
      try {
        const result = await breaker.fire(brandIdentity, ctx);
        const durationMs = Date.now() - t0;
        return {
          source: collector.name,
          status: result?.success ? 'ok' : deriveFailStatus(result),
          durationMs,
          fromCache: !!result?.fromCache,
          reason: result?.reason || null,
          data: result?.success ? result.data : null,
          recordsCollected: result?.recordsCollected || 0,
        };
      } catch (err) {
        const durationMs = Date.now() - t0;
        const status = err?.code === 'circuit_open'
          ? 'circuit_open'
          : err?.code === 'fetch_timeout' || /timeout/i.test(err?.message || '')
            ? 'timeout'
            : 'failed';
        return {
          source: collector.name,
          status,
          durationMs,
          fromCache: false,
          reason: err?.code || err?.message || 'unknown_error',
          data: null,
          recordsCollected: 0,
        };
      }
    });

    const perSource = await Promise.all(tasks);

    const successful = perSource.filter((r) => r.status === 'ok');
    const mergedData = {};
    for (const row of perSource) {
      if (row.status === 'ok' && row.data) mergedData[row.source] = row.data;
    }

    return {
      brandIdentity,
      startedAt: new Date(startedAt),
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
      sources: perSource,
      sourcesTotal: this.collectors.length,
      sourcesHealthy: successful.length,
      coverageScore: this.collectors.length
        ? Number((successful.length / this.collectors.length).toFixed(3))
        : 0,
      mergedData,
    };
  }

  /**
   * Admin / ops: get the current health state of each breaker.
   */
  healthReport() {
    const out = {};
    for (const [name, breaker] of this.breakers.entries()) {
      out[name] = {
        state: breaker.opened ? 'open' : breaker.halfOpen ? 'half_open' : 'closed',
        stats: breaker.stats,
      };
    }
    return out;
  }
}

function deriveFailStatus(result) {
  if (!result) return 'failed';
  if (result.reason === 'no_handle' || result.reason === 'unsupported') return 'skipped';
  if (result.reason === 'circuit_open') return 'circuit_open';
  return 'failed';
}

module.exports = { CollectionOrchestrator };
