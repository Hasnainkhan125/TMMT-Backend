'use strict';

/**
 * WhatsApp messaging utility (Twilio Sandbox + Business API).
 *
 * Configuration env vars:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   default: 'whatsapp:+14155238886' (Twilio sandbox)
 *
 * If credentials are missing, the module is a no-op that logs a warning so
 * dev/test environments don't crash. Production should set the env vars.
 */

let _client = null;
function getClient() {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  // Lazy require so a missing twilio package never crashes app startup.
  const twilio = require('twilio');
  _client = twilio(sid, token);
  return _client;
}

function normalizeWhatsAppNumber(num) {
  if (!num) return null;
  if (num.startsWith('whatsapp:')) return num;
  return `whatsapp:${num.replace(/[^+\d]/g, '')}`;
}

/**
 * sendWhatsappMessage - send a WhatsApp text message (and optional media).
 *
 * @param {object} data
 *   - to:        e.g. '+971501234567' or 'whatsapp:+971501234567'
 *   - body:      message text
 *   - mediaUrl:  optional string or array of URLs to attach (image/video)
 *   - from:      optional override; defaults to TWILIO_WHATSAPP_FROM
 * @returns {Promise<{ ok: boolean, sid?: string, simulated?: boolean, error?: string }>}
 */
async function sendWhatsappMessage(data = {}) {
  const to = normalizeWhatsAppNumber(data.to);
  const from = normalizeWhatsAppNumber(
    data.from || process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'
  );
  const body = data.body || data.message || '';
  const mediaUrl = data.mediaUrl || data.media || undefined;

  if (!to) {
    return { ok: false, error: 'missing_to' };
  }

  const client = getClient();
  if (!client) {
    console.warn('[whatsApp] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — message not sent.');
    return { ok: false, simulated: true, error: 'twilio_not_configured' };
  }

  try {
    const payload = { from, to, body };
    if (mediaUrl) {
      payload.mediaUrl = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl];
    }
    const message = await client.messages.create(payload);
    return { ok: true, sid: message.sid };
  } catch (err) {
    console.error('[whatsApp] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsappMessage, normalizeWhatsAppNumber };
