'use strict';

/**
 * Shared Redis client(s).
 *
 * One module owns every Redis connection so the API process, the BullMQ
 * worker, the socket.io adapter, and the rate-limiter all share the same
 * pool instead of each lib spawning its own. Three singletons are exposed:
 *
 *   - getRedis()       → general-purpose client (BullMQ-safe options)
 *   - getPubSubClients() → dedicated pub/sub pair for socket.io adapter
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it owns
 * (otherwise the worker will throw on the first idle reconnect).
 */

const Redis = require('ioredis');

let client = null;
let pubClient = null;
let subClient = null;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function makeClient(label) {
  const c = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  c.on('error', (err) => console.error(`[Redis:${label}] error:`, err.message));
  c.on('connect', () => console.log(`[Redis:${label}] connected (${REDIS_URL.replace(/:[^/]*@/, ':***@')})`));
  return c;
}

function getRedis() {
  if (!client) client = makeClient('main');
  return client;
}

// Separate pub/sub clients for the socket.io Redis adapter (or any other
// Pub/Sub use). Per ioredis docs, a connection in subscribe mode cannot
// issue regular commands, so we keep these isolated from `getRedis()`.
function getPubSubClients() {
  if (!pubClient) {
    pubClient = makeClient('pub');
    subClient = pubClient.duplicate();
    subClient.on('error', (err) => console.error('[Redis:sub] error:', err.message));
  }
  return { pubClient, subClient };
}

module.exports = { getRedis, getPubSubClients, REDIS_URL };
