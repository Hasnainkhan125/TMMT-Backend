'use strict';

const { Worker } = require('bullmq');
const { getRedis } = require('../services/redis');
const { QUEUE_NAMES } = require('../services/queues');
const { runScanEnrichmentJob } = require('../services/urlToAdsEnrichJob');

const CONCURRENCY = Number(process.env.URL_ADS_ENRICH_CONCURRENCY || 2);

let worker = null;

function startUrlToAdsEnrichWorker({ connection = getRedis(), logger = console } = {}) {
  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAMES.URL_ADS_ENRICH,
    async (job) => {
      const { scanId, userId } = job.data || {};
      if (!scanId) throw new Error('url-ads-enrich: missing scanId');
      return runScanEnrichmentJob({ scanId, userId });
    },
    {
      connection,
      concurrency: CONCURRENCY,
      limiter: { max: 15, duration: 60_000 },
    },
  );

  worker.on('completed', (job, result) => {
    logger.log?.(`[url-ads-enrich] done job=${job.id} scan=${result?.scanId} ok=${result?.ok}`);
  });
  worker.on('failed', (job, err) => {
    logger.error?.(`[url-ads-enrich] FAILED job=${job?.id} err=${err?.message}`);
  });

  return worker;
}

async function stopUrlToAdsEnrichWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

module.exports = { startUrlToAdsEnrichWorker, stopUrlToAdsEnrichWorker };

if (require.main === module) {
  console.log(`[url-ads-enrich-worker] starting (concurrency=${CONCURRENCY})`);
  startUrlToAdsEnrichWorker();
}
