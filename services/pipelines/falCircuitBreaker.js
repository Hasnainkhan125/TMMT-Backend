'use strict';

/**
 * falCircuitBreaker — per-model circuit breaker with fallback routing.
 *
 * When a fal model starts failing (timeouts, 5xx, etc.), we:
 *   1. Open the circuit after 40% error rate in rolling window
 *   2. Route subsequent calls to the configured fallback model
 *   3. Mark the model's healthScore in DB for admin visibility
 *   4. Attempt recovery after 30 seconds (half-open state)
 *
 * Without this, a 10-minute fal outage = 10 minutes of failed jobs +
 * 10 minutes of angry users on Twitter. With this, fallback absorbs
 * 95% of the hit transparently.
 *
 * npm install opossum
 */

const CircuitBreaker = require('opossum');
const { fal } = require('@fal-ai/client');

// In-memory breaker registry. One breaker per falModelId.
const breakers = new Map();

// Fallback map — if this model fails, try this other one.
// Populate from aiModel.reliability.fallbackModelId in production.
const FALLBACK_MAP = {
  'fal-ai/kling-video/v2/master/text-to-video': 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': 'fal-ai/minimax/hailuo-02/pro/text-to-video',
  'fal-ai/minimax/hailuo-02/pro/text-to-video': 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
  'fal-ai/veo3/fast': 'fal-ai/minimax/hailuo-02/pro/text-to-video',
  'fal-ai/hedra/character-3': 'fal-ai/veed/avatars',
  'fal-ai/kling-video/v1/pro/ai-avatar': 'fal-ai/veed/avatars',
  'fal-ai/flux-pro/v1.1': 'fal-ai/flux/dev',
  'fal-ai/flux/dev': 'fal-ai/flux/schnell',
};

const BREAKER_OPTIONS = {
  timeout: 180000,                    // 3 min (fal can be slow for premium models)
  errorThresholdPercentage: 40,       // Open at 40% error rate
  rollingCountTimeout: 60000,         // 60s rolling window
  rollingCountBuckets: 10,            // 6s buckets
  resetTimeout: 30000,                // Attempt recovery after 30s
  volumeThreshold: 5,                 // Don't open until 5 requests in window
};

/**
 * Core fal call — what gets wrapped by the breaker.
 */
async function _rawCallFal(falModelId, input, { onQueueUpdate } = {}) {
  return await fal.subscribe(falModelId, {
    input,
    logs: false,
    onQueueUpdate: (update) => {
      if (onQueueUpdate) onQueueUpdate(update);
    },
  });
}

/**
 * Get or create a breaker for this model.
 */
function getBreaker(falModelId) {
  if (breakers.has(falModelId)) return breakers.get(falModelId);
  
  const breaker = new CircuitBreaker(
    async (input, opts) => _rawCallFal(falModelId, input, opts),
    {
      ...BREAKER_OPTIONS,
      name: falModelId,
    }
  );
  
  breaker.on('open', () => {
    console.warn(`[circuit] OPEN: ${falModelId} — routing to fallback`);
    _markModelUnhealthy(falModelId);
  });
  
  breaker.on('halfOpen', () => {
    console.log(`[circuit] HALF-OPEN: ${falModelId} — attempting recovery`);
  });
  
  breaker.on('close', () => {
    console.log(`[circuit] CLOSE: ${falModelId} — recovered`);
    _markModelHealthy(falModelId);
  });
  
  breakers.set(falModelId, breaker);
  return breaker;
}

/**
 * Update health score in DB for admin dashboard visibility.
 */
async function _markModelUnhealthy(falModelId) {
  try {
    const AiModel = require('../../model/schema/aiModel');
    await AiModel.updateMany(
      { $or: [{ falModelId }, { falVideoModelId: falModelId }] },
      { 
        $set: { 
          'reliability.healthScore': 0,
          'reliability.lastFailureAt': new Date(),
        }
      }
    );
  } catch (_err) { /* non-fatal */ }
}

async function _markModelHealthy(falModelId) {
  try {
    const AiModel = require('../../model/schema/aiModel');
    await AiModel.updateMany(
      { $or: [{ falModelId }, { falVideoModelId: falModelId }] },
      { $set: { 'reliability.healthScore': 100 } }
    );
  } catch (_err) { /* non-fatal */ }
}

/**
 * Public entry — call fal with circuit breaker + automatic fallback.
 */
async function callFalWithCircuitBreaker({ falModelId, input, onQueueUpdate }) {
  const breaker = getBreaker(falModelId);
  
  try {
    return await breaker.fire(input, { onQueueUpdate });
  } catch (err) {
    // Breaker rejected (open) OR underlying call failed
    const fallbackModelId = FALLBACK_MAP[falModelId];
    
    if (!fallbackModelId) {
      // No fallback configured — propagate the original error
      throw err;
    }
    
    console.warn(
      `[circuit] ${falModelId} failed (${err.message?.slice(0, 80)}), ` +
      `falling back to ${fallbackModelId}`
    );
    
    // Emit metric for observability
    try {
      const metrics = require('../../utils/metrics');
      metrics.counter('circuit.fallback', 1, {
        primary: falModelId,
        fallback: fallbackModelId,
      });
    } catch (_) { /* optional */ }
    
    // Call fallback through ITS breaker
    const fallbackBreaker = getBreaker(fallbackModelId);
    return await fallbackBreaker.fire(input, { onQueueUpdate });
  }
}

/**
 * Admin endpoint helper — return current state of all breakers.
 */
function getBreakerStates() {
  const out = {};
  for (const [modelId, breaker] of breakers.entries()) {
    out[modelId] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed',
      stats: breaker.stats,
    };
  }
  return out;
}

module.exports = {
  callFalWithCircuitBreaker,
  getBreakerStates,
  // Exposed for tests
  _rawCallFal,
};