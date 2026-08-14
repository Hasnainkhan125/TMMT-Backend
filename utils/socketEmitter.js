'use strict';

/**
 * Cross-process job-update bridge.
 *
 * Worker process:    publishes payloads with emitJobUpdate(sessionId, payload)
 * API/web process:   setupJobUpdateSubscriber(io) once at boot, fans out to
 *                    socket.io rooms named `studio:<sessionId>`.
 *
 * Connections come from services/redis.js so we share a pool with BullMQ.
 */

const CHANNEL = 'qumak:job-updates';

// ⚠️ SAFE IMPORT: Try to load Redis, but don't crash if it fails
let getRedis, getPubSubClients;
let redisAvailable = false;

try {
  const redisModule = require('../services/redis');
  getRedis = redisModule.getRedis;
  getPubSubClients = redisModule.getPubSubClients;
  redisAvailable = true;
  console.log('[socketEmitter] Redis module loaded successfully');
} catch (err) {
  console.warn('[socketEmitter] Redis not available (running in degraded mode):', err.message);
}

async function emitJobUpdate(sessionId, payload) {
  if (!sessionId || !redisAvailable) return;
  try {
    const pub = getRedis();
    await pub.publish(CHANNEL, JSON.stringify({ sessionId, payload }));
  } catch (err) {
    console.error('[socketEmitter] emitJobUpdate failed (non-fatal):', err.message);
  }
}

function setupJobUpdateSubscriber(io) {
  if (!redisAvailable) {
    console.warn('[socketEmitter] Redis unavailable - job updates disabled');
    return null;
  }

  const { subClient } = getPubSubClients();

  subClient.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('[socketEmitter] Failed to subscribe to channel:', err.message);
      return;
    }
    console.log(`[socketEmitter] Subscribed to Redis channel: ${CHANNEL}`);
  });

  subClient.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const { sessionId, payload } = JSON.parse(message);
      const room = `studio:${sessionId}`;

      // Always emit the generic event for any future listeners.
      io.to(room).emit('studio:job-update', payload);

      // Fan out to the granular events the frontend's useSocket actually
      // subscribes to. This is what makes the loader, drafts, HD card,
      // etc. light up in real time.
      const status = payload?.status;
      if (status === 'queued') {
        io.to(room).emit('job:queued', payload);
      } else if (status === 'completed') {
        io.to(room).emit('job:complete', payload);
        // Image jobs deliver their HD URL on completion.
        if (payload?.output?.imageUrl || payload?.output?.hdUrl) {
          io.to(room).emit('job:hd', {
            ...payload,
            hdUrl: payload?.output?.hdUrl || payload?.output?.imageUrl,
          });
        }
      } else if (status === 'failed') {
        io.to(room).emit('job:failed', payload);
      } else {
        // prompt_building / generating / upscaling / postprocessing → progress
        io.to(room).emit('job:progress', payload);
      }
    } catch (err) {
      console.error('[socketEmitter] Failed to parse message:', err.message);
    }
  });

  return subClient;
}

module.exports = { emitJobUpdate, setupJobUpdateSubscriber, CHANNEL };