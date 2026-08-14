'use strict';

/**
 * BullMQ queues — single source of truth.
 *
 * Every controller that wants to enqueue work should `require()` from here
 * instead of `new Queue(...)` inline. That guarantees:
 *   - one connection (via services/redis.js) instead of N
 *   - one queue name across API + worker (no silent typos)
 *   - one defaultJobOptions policy
 */

const { Queue, Worker } = require('bullmq');
const { getRedis } = require('./redis');

const QUEUE_NAMES = {
  STUDIO: 'video-generation', // historical name; image + video both use this queue
  INTELLIGENCE: 'brand-intelligence', // competitor intelligence collection + scoring
  URL_ADS_ENRICH: 'url-ads-enrich', // Apify + money math + intel after core scan
  VIDEO_STITCH: 'video-stitch',
};

// IMPORTANT: `attempts: 1` means BullMQ will NOT automatically re-run a
// failed job. When a generation fails, the worker marks the StudioJob
// `status: 'failed'`, the user sees the error in Studio/History, and a
// fresh job is only enqueued when they explicitly click Regenerate from
// the UI. Historically this was `attempts: 2`, which silently spent
// credits / Fal quota on retries the user never asked for.
const DEFAULT_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400, count: 200 },
};

let studioQueue = null;

function getStudioQueue() {
  if (!studioQueue) {
    studioQueue = new Queue(QUEUE_NAMES.STUDIO, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_OPTIONS,
    });
    console.log(`[queues] Studio queue ready (name=${QUEUE_NAMES.STUDIO})`);
  }
  return studioQueue;
}

/**
 * Enqueue a Studio job.
 *   kind === 'image' → BullMQ name 'generate-image' (videoWorker.processImageJob)
 *   kind === 'video' → BullMQ name 'generate'        (videoWorker.processVideoJob)
 */
async function enqueueStudioJob({ jobId, kind = 'video', priority = 5, opts = {} }) {
  if (!jobId) throw new Error('enqueueStudioJob: jobId required');
  const name = kind === 'image' ? 'generate-image' : 'generate';
  return getStudioQueue().add(
    name,
    { jobId: String(jobId), kind },
    { priority, jobId: String(jobId), ...opts },
  );
}

// ─── Intelligence queue ──────────────────────────────────────────────────────
// Used by services/intelligence/pipeline.js to run Layer-2 collection + Layer-3
// extraction off the request thread. Concurrency and per-source rate limits
// live on the worker side (workers/intelligenceWorker.js) — NOT here.

let intelligenceQueue = null;

const INTELLIGENCE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  // Intelligence runs are cheap relative to video — keep more history so
  // ops can eyeball recent runs without trawling Mongo.
  removeOnComplete: { age: 7 * 86400, count: 1000 },
  removeOnFail: { age: 14 * 86400, count: 500 },
};

function getIntelligenceQueue() {
  if (!intelligenceQueue) {
    intelligenceQueue = new Queue(QUEUE_NAMES.INTELLIGENCE, {
      connection: getRedis(),
      defaultJobOptions: INTELLIGENCE_JOB_OPTIONS,
    });
    console.log(`[queues] Intelligence queue ready (name=${QUEUE_NAMES.INTELLIGENCE})`);
  }
  return intelligenceQueue;
}

/**
 * Enqueue an intelligence run.
 *
 * @param {object} opts
 *   brandId      — Brand._id (optional, but either brandId OR url is required)
 *   url          — the URL to resolve if no brandId
 *   userId       — for CollectionRun attribution
 *   triggeredBy  — 'scan' | 'refresh' | 'background' | 'manual'
 *   priority     — default 5; 1 is highest, 20 is lowest
 */
async function enqueueIntelligenceRun({
  brandId,
  url,
  userId,
  triggeredBy = 'scan',
  priority = 5,
  opts = {},
}) {
  if (!brandId && !url) throw new Error('enqueueIntelligenceRun: brandId or url required');
  return getIntelligenceQueue().add(
    'run',
    { brandId: brandId ? String(brandId) : null, url: url || null, userId: userId ? String(userId) : null, triggeredBy },
    { priority, ...opts },
  );
}

// ─── URL → Ads enrichment queue ─────────────────────────────────────────────

let urlAdsEnrichQueue = null;

const URL_ADS_ENRICH_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 45_000 },
  removeOnComplete: { age: 7 * 86400, count: 2000 },
  removeOnFail: { age: 14 * 86400, count: 500 },
};

function getUrlAdsEnrichQueue() {
  if (!urlAdsEnrichQueue) {
    urlAdsEnrichQueue = new Queue(QUEUE_NAMES.URL_ADS_ENRICH, {
      connection: getRedis(),
      defaultJobOptions: URL_ADS_ENRICH_OPTIONS,
    });
    console.log(`[queues] URL Ads enrich queue ready (name=${QUEUE_NAMES.URL_ADS_ENRICH})`);
  }
  return urlAdsEnrichQueue;
}

async function enqueueUrlToAdsEnrich({ scanId, userId, priority = 3, opts = {} }) {
  if (!scanId) throw new Error('enqueueUrlToAdsEnrich: scanId required');
  return getUrlAdsEnrichQueue().add(
    'enrich',
    { scanId: String(scanId), userId: userId ? String(userId) : null },
    { priority, ...opts },
  );
}



let videoStitchQueue = null;

const VIDEO_STITCH_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,    
};

function getVideoStitchQueue() {
  if (!videoStitchQueue) {
    videoStitchQueue = new Queue(QUEUE_NAMES.VIDEO_STITCH, {
      connection: getRedis(),
      defaultJobOptions: VIDEO_STITCH_OPTIONS,
    });

    console.log(
      `[queues] Video stitch queue ready (name=${QUEUE_NAMES.VIDEO_STITCH})`,
    );
  }

  return videoStitchQueue;
}

async function enqueueStitchJob({ scanId, adJobId, priority = 5, opts = {} }) {
  const id = `stitch_${scanId}_${adJobId}`;
  const q = getVideoStitchQueue();

  const existing = await q.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') await existing.remove();
    else return existing;   // already waiting/active — don't double-add
  }
  return q.add('stitch', { scanId: String(scanId), adJobId: String(adJobId) },
    { priority, jobId: id, ...opts });
}
// ─── Ad Ingest queue (competitor video → adSpec draft) ──────────────────────

const AD_INGEST_QUEUE_NAME = 'ad-ingest';
const AD_INGEST_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400, count: 200 },
};

let adIngestQueue = null;

function getAdIngestQueue() {
  if (!adIngestQueue) {
    adIngestQueue = new Queue(AD_INGEST_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: AD_INGEST_OPTIONS,
    });
    console.log(`[queues] Ad ingest queue ready (name=${AD_INGEST_QUEUE_NAME})`);

    new Worker(AD_INGEST_QUEUE_NAME, async (job) => {
      const UrlToAdsScan = require('../model/schema/urlToAdsScan');
      const { ingestCompetitorAd } = require('./adSpec/adIngestService');

      const scan = await UrlToAdsScan.findById(job.data.scanId);
      if (!scan) throw new Error(`scan_not_found:${job.data.scanId}`);

      const emitPhase = (p) => {
        try { job.updateProgress({ phase: p, ts: Date.now() }); } catch {}
      };

      const { spec } = await ingestCompetitorAd({
        scan,
        source: job.data.source,
        competitorName: job.data.competitorName,
        intelligence: job.data.intelligence || {},
        opts: { model: process.env.WHISPER_MODEL || 'base', maxFrames: 8 },
        onPhase: emitPhase,
      });

      scan.adSpecs = [...(scan.adSpecs || []), spec];
      scan.markModified('adSpecs');
      await scan.save();

      // Persist teardown record for training data + user replay (best effort)
      try {
        const TeardownRecord = require('../model/schema/teardownRecord');
        await TeardownRecord.create({
          scanId: scan._id,
          userId: scan.userId || null,
          specId: spec.specId,
          competitor: job.data.competitorName || null,
          sourceVideoR2Key: spec.teardownEvidence?.sourceVideoR2Key || null,
          audioSegments: spec.teardownEvidence?.audioSegments || [],
          transcript: {
            text: '',
            wordCount: spec.teardownEvidence?.wordCount || 0,
            language: null,
          },
          sceneCount: spec.teardownEvidence?.sceneCount || 0,
          durationSec: spec.teardownEvidence?.durationSec || null,
          frameUrls: spec.teardownEvidence?.frameUrls || [],
          detectedStructure: spec.structure,
          hookType: spec.beats?.[0]?.hookType || null,
          triggers: spec.triggers || [],
          pacing: spec.teardownEvidence?.pacing || null,
          visionNotes: spec.teardownEvidence?.visionNotes || null,
        });
      } catch (e) {
        console.warn('[queues] teardownRecord persist failed (non-blocking):', e.message);
      }

      return { specId: spec.specId };
    }, { connection: getRedis(), concurrency: 2 });
  }
  return adIngestQueue;
}

module.exports = {
  QUEUE_NAMES,
  getStudioQueue,
  enqueueStudioJob,
  getIntelligenceQueue,
  enqueueIntelligenceRun,
  getUrlAdsEnrichQueue,
  enqueueUrlToAdsEnrich,
  getVideoStitchQueue,
  enqueueStitchJob,
  getAdIngestQueue,
};
