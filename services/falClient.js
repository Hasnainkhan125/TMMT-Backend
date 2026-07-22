'use strict';

/**
 * falClient.js
 *
 * Thin wrapper around @fal-ai/client that:
 *   1. NEVER prepends fal-ai/ to endpoints (this is what's breaking gpt-image-2).
 *   2. Strips accidental fal-ai/ prefixes when the model is under a different org
 *      (openai/, bytedance/, etc.).
 *   3. Provides a single subscribe() entry point with consistent error shape.
 *
 * The fal SDK accepts the FULL endpoint slug exactly as fal documents it:
 *   - fal-ai/flux/schnell           (fal-ai org)
 *   - openai/gpt-image-2/edit       (openai org)
 *   - bytedance/seedance-2.0/...    (bytedance org)
 *
 * If your code anywhere does `fal.subscribe('fal-ai/' + falModelId, ...)`, that's
 * the bug. Always pass falModelId verbatim.
 */

const { fal } = require('@fal-ai/client');

const DEBUG = process.env.STUDIO_DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[falClient]', ...args);

// Configure fal credentials once
if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
}

const KNOWN_ORGS = ['openai/', 'bytedance/', 'google/', 'stability-ai/',
                     'meta/', 'kwaivgi/', 'minimax/', 'fal-ai/'];

function normalizeEndpoint(slug) {
  if (!slug) throw new Error('falClient: endpoint is required');

  // Strip accidental fal-ai/ prefix when followed by another org
  if (slug.startsWith('fal-ai/')) {
    const rest = slug.slice('fal-ai/'.length);
    for (const org of KNOWN_ORGS) {
      if (rest.startsWith(org)) {
        log('stripped fal-ai/ prefix', { from: slug, to: rest });
        return rest;
      }
    }
  }
  return slug;
}

/**
 * Submit a job to fal.
 * @param {string} endpoint - exact fal endpoint, e.g. "openai/gpt-image-2/edit"
 * @param {object} input    - sanitized payload
 * @param {object} opts     - { logs, mode, onQueueUpdate }
 */
async function subscribe(endpoint, input, opts = {}) {
  const normalized = normalizeEndpoint(endpoint);

  log('subscribe', {
    endpoint: normalized,
    inputKeys: Object.keys(input || {}),
  });

  try {
    const result = await fal.subscribe(normalized, {
      input,
      logs: opts.logs ?? false,
      mode: opts.mode,
      onQueueUpdate: opts.onQueueUpdate,
      pollInterval: opts.pollInterval,
    });
    return result;
  } catch (err) {
    // fal SDK errors have a `body` field with structured detail
    const detail = err?.body || err?.response?.data || null;
    const msg = detail?.detail || err.message || 'fal request failed';
    const wrapped = new Error(`fal[${normalized}]: ${msg}`);
    wrapped.code = 'fal_provider_error';
    wrapped.endpoint = normalized;
    wrapped.detail = detail;
    wrapped.status = err?.status || err?.statusCode || null;
    throw wrapped;
  }
}

/**
 * Submit-and-poll mode (queue-based) for long-running jobs.
 */
async function queue(endpoint, input, opts = {}) {
  const normalized = normalizeEndpoint(endpoint);
  log('queue.submit', { endpoint: normalized });

  try {
    const { request_id } = await fal.queue.submit(normalized, { input });
    return { requestId: request_id, endpoint: normalized };
  } catch (err) {
    const detail = err?.body || err?.response?.data || null;
    const wrapped = new Error(`fal[${normalized}]: ${detail?.detail || err.message}`);
    wrapped.code = 'fal_provider_error';
    wrapped.endpoint = normalized;
    wrapped.detail = detail;
    throw wrapped;
  }
}

async function status(endpoint, requestId, opts = {}) {
  const normalized = normalizeEndpoint(endpoint);
  return fal.queue.status(normalized, { requestId, logs: opts.logs ?? false });
}

async function result(endpoint, requestId) {
  const normalized = normalizeEndpoint(endpoint);
  return fal.queue.result(normalized, { requestId });
}

module.exports = {
  subscribe,
  queue,
  status,
  result,
  normalizeEndpoint, // exposed for tests
};