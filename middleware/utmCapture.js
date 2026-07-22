'use strict';

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const UTM_TTL_SECONDS = 24 * 60 * 60; // 24 hours

let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: false
    });
    _redis.on('error', (err) => {
      console.error('[utmCapture] Redis error (non-fatal):', err.message);
    });
  }
  return _redis;
}

/**
 * utmCapture — middleware that stores UTM params in Redis keyed by sessionId.
 * Non-fatal: if Redis is unavailable, the request continues.
 */
async function utmCapture(req, res, next) {
  try {
    const { utm_source, utm_medium, utm_campaign, utm_content, ref } = req.query;

    // Only act if at least one UTM param is present
    if (!utm_source && !utm_medium && !utm_campaign && !ref) {
      return next();
    }

    const sessionId = req.cookies?.qumak_session || req.headers['x-session-id'];
    if (!sessionId) return next();

    const utmData = {};
    if (utm_source)   utmData.utm_source   = utm_source;
    if (utm_medium)   utmData.utm_medium   = utm_medium;
    if (utm_campaign) utmData.utm_campaign = utm_campaign;
    if (utm_content)  utmData.utm_content  = utm_content;
    if (ref)          utmData.ref          = ref;

    const key = `utm:${sessionId}`;
    const redis = getRedis();
    await redis.set(key, JSON.stringify(utmData), 'EX', UTM_TTL_SECONDS);
  } catch (err) {
    // Non-fatal — UTM capture failure must never break the main request
    console.warn('[utmCapture] Failed to store UTM data (non-fatal):', err.message);
  }
  next();
}

/**
 * getUtmData — retrieves stored UTM data for a sessionId.
 * @param {string} sessionId
 * @returns {object|null}
 */
async function getUtmData(sessionId) {
  try {
    if (!sessionId) return null;
    const redis = getRedis();
    const data = await redis.get(`utm:${sessionId}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.warn('[utmCapture] getUtmData failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { utmCapture, getUtmData };
