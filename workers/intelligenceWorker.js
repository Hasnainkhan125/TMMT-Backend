'use strict';

/**
 * Intelligence worker — consumes jobs from the `brand-intelligence` queue
 * and runs the Layer-1 → Layer-5 pipeline.
 *
 * Design decisions (why these knobs, not others):
 *
 *   concurrency: 4
 *     Each run fires ~5 outbound scrapers in parallel inside the
 *     orchestrator. 4 workers × 5 scrapers = 20 concurrent outbound
 *     connections — enough to feel fast, few enough to avoid tripping
 *     rate limits on any single source, and bounded memory (no headless
 *     browsers yet, but when we add Playwright the same cap keeps us
 *     under 2GB).
 *
 *   limiter: 20 jobs / minute
 *     Prevents the queue from slamming Google SERP / Meta / TikTok with
 *     bursts of 50+ requests when a dashboard refresh stacks jobs. The
 *     circuit breakers handle per-source fairness; this limiter handles
 *     overall polite-rate.
 *
 *   removeOnComplete / removeOnFail
 *     Inherited from services/queues.js — 7d success / 14d failure.
 *
 * The worker is designed to run as its own process:
 *   `node workers/intelligenceWorker.js`
 * or be required into a multi-worker host process.
 */

const { Worker } = require('bullmq');
const { getRedis } = require('../services/redis');
const { QUEUE_NAMES } = require('../services/queues');
const { runIntelligenceRun } = require('../services/intelligence/pipeline');

const CONCURRENCY = Number(process.env.INTELLIGENCE_WORKER_CONCURRENCY || 4);

let worker = null;

function startIntelligenceWorker({ connection = getRedis(), logger = console } = {}) {
  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAMES.INTELLIGENCE,
    async (job) => {
      const { brandId, url, userId, triggeredBy } = job.data || {};
      if (!brandId && !url) {
        throw new Error('intelligence job: missing brandId and url');
      }

      // Resolve from brandId if we have one — skips the Layer-1 fetch.
      let brandIdentity = null;
      if (brandId) {
        const Brand = require('../model/schema/brand');
        const brandDoc = await Brand.findById(brandId);
        if (brandDoc?.identity) brandIdentity = brandDoc.identity;
      }

      const result = await runIntelligenceRun({
        url,
        brandIdentity,
        userId,
        triggeredBy: triggeredBy || 'scan',
        persist: true,
      });

      return {
        brandId: result.persisted?.brandId || brandId || null,
        collectionRunId: result.persisted?.collectionRunId || null,
        sourcesHealthy: result.collectionReport?.sourcesHealthy || 0,
        sourcesTotal: result.collectionReport?.sourcesTotal || 0,
        signalsGenerated: result.persisted?.signalIds?.length || 0,
      };
    },
    {
      connection,
      concurrency: CONCURRENCY,
      limiter: {
        max: 20,
        duration: 60_000,
      },
    },
  );

  worker.on('completed', (job, result) => {
    logger.log?.(
      `[intel-worker] done job=${job.id} brand=${result.brandId} healthy=${result.sourcesHealthy}/${result.sourcesTotal} signals=${result.signalsGenerated}`,
    );
  });
  worker.on('failed', (job, err) => {
    logger.error?.(`[intel-worker] FAILED job=${job?.id} err=${err?.message}`);
  });

  return worker;
}

async function stopIntelligenceWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

module.exports = { startIntelligenceWorker, stopIntelligenceWorker };

// Allow `node workers/intelligenceWorker.js` to run standalone.
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(`[intel-worker] starting (concurrency=${CONCURRENCY})`);
  startIntelligenceWorker();
}
