'use strict';

/**
 * Single entry-point for all Apify actor runs. Callers use actor-specific
 * modules under services/apify/actors — they must not import apify-client
 * directly so caching, metrics, and timeouts stay consistent.
 */

const crypto = require('crypto');
const { ApifyClient } = require('apify-client');
const { getRedis } = require('../redis');
const m = require('../../utils/metrics');

let _client;

function getClient() {
  if (!process.env.APIFY_API_TOKEN) {
    const err = new Error('APIFY_API_TOKEN is not configured');
    err.code = 'apify_failed';
    throw err;
  }
  if (!_client) {
    _client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  }
  return _client;
}

function _bumpApify(kind) {
  try {
    if (m.incApify) m.incApify(kind);
  } catch (_e) { /* optional */ }
}

function cacheKey(actorId, input) {
  const h = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `apify:${actorId}:${h}`;
}

/**
 * @param {string} actorId  e.g. 'apify/facebook-ads-scraper'
 * @param {object} input    actor-specific JSON input
 * @param {object} [opts]
 * @param {number} [opts.timeoutSecs=180]
 * @param {number} [opts.memoryMbytes=2048]
 * @param {number} [opts.cacheTTL=86400]
 * @returns {Promise<{ items: any[], runId: string|null, runTimeMs: number, fromCache: boolean }>}
 */
async function runActor(actorId, input, opts = {}) {
  const {
    timeoutSecs = 180,
    memoryMbytes = 512,
    cacheTTL = 86400,
    skipCache = false,
  } = opts;

  if (!actorId || typeof actorId !== 'string') {
    const err = new Error('runActor: actorId required');
    err.code = 'apify_failed';
    err.actorId = actorId;
    throw err;
  }

  const noCache = skipCache === true || process.env.APIFY_SCRIPT_NO_CACHE === '1';
  const key = cacheKey(actorId, input);
  const t0 = Date.now();

  if (!noCache) {
    try {
      const redis = getRedis();
      const cached = await redis.get(key);
      if (cached) {
        _bumpApify('total');
        _bumpApify('cached');
        const parsed = JSON.parse(cached);
        return {
          items: Array.isArray(parsed.items) ? parsed.items : [],
          runId: parsed.runId || null,
          runTimeMs: 0,
          fromCache: true,
        };
      }
    } catch (_e) {
      console.log('cache miss or redis down — continue to Apify', _e);
      /* cache miss or redis down — continue to Apify */
    }
  }

  _bumpApify('total');
  let run;
  try {
    const client = getClient();

    run = await client.actor(actorId).call(input, {
      waitSecs: timeoutSecs,
      memory: 512,
    });

  } catch (e) {
    // _bumpApify('failed');
    const err = new Error(e.message || 'Apify actor failed');
    err.code = 'apify_failed';
    err.actorId = actorId;
    throw err;
  }

  const runId = run?.id || run?.data?.id || null;
  let items = [];
  try {
    const client = getClient();
    const ds = run?.defaultDatasetId;
    if (ds) {
      const res = await client.dataset(ds).listItems({ limit: 50_000 });
     
      items = res.items || res || [];
      if (!Array.isArray(items)) items = [];
    }
  } catch (e) {
    _bumpApify('failed');
    const err = new Error(e.message || 'Apify dataset read failed');
    err.code = 'apify_failed';
    err.actorId = actorId;
    throw err;
  }

  const runTimeMs = Date.now() - t0;
  const payload = JSON.stringify({ items, runId });

  if (!noCache) {
    try {
      const redis = getRedis();
      await redis.setex(key, cacheTTL, payload);
    } catch (_e) { /* non-fatal */ }
  }

  return { items, runId, runTimeMs, fromCache: false };
}

module.exports = { runActor, cacheKey };
