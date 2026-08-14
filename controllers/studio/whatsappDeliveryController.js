'use strict';

/**
 * whatsappDeliveryController.js
 *
 * Sends a finished StudioAsset to a WhatsApp number for sign-off.
 * This is the Gulf-native "delivery" step — none of TopView/Creatify/Higgsfield
 * do this. SMEs in UAE/KSA live on WhatsApp; this is where they want previews.
 *
 * Flow:
 *   1. Owner picks a finished StudioAsset
 *   2. POST /api/v1/studio/asset/:id/whatsapp { to, message?, brandName? }
 *   3. We send via Twilio WhatsApp with the asset URL as media + bilingual caption
 *
 * Rate-limited per session/user to prevent spam.
 */

const { z } = require('zod');
const { sendWhatsappMessage, normalizeWhatsAppNumber } = require('../../utills/whatsAppMessage');
const StudioAsset = require('../../model/schema/studioAsset');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

// E.164-ish: starts with +, 8–15 digits.
const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, {
  message: 'Phone must be in E.164 format, e.g. +971501234567',
});

const bodySchema = z.object({
  to: phoneSchema,
  message: z.string().max(1000).optional(),
  brandName: z.string().max(80).optional(),
  language: z.enum(['en', 'ar', 'both']).default('both'),
});

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownsAsset(asset, req) {
  if (!asset) return false;
  if (req.user?._id && asset.userId && String(asset.userId) === String(req.user._id)) return true;
  const sid = getSessionId(req);
  if (sid && asset.sessionId === sid) return true;
  return false;
}

function buildBilingualCaption({ brandName, message, language }) {
  const en = message
    || `Here's your fresh ad from Qumak${brandName ? ` for ${brandName}` : ''}. Reply YES to publish, EDIT to revise.`;
  const ar = brandName
    ? `هذا إعلانك الجديد من قمك لـ${brandName}. رد بنعم للنشر أو تعديل لإجراء تغييرات.`
    : 'هذا إعلانك الجديد من قمك. رد بنعم للنشر أو تعديل لإجراء تغييرات.';

  if (language === 'en') return en;
  if (language === 'ar') return ar;
  return `${en}\n\n${ar}`;
}

/**
 * POST /api/v1/studio/asset/:id/whatsapp
 */
exports.sendAsset = async (req, res) => {
  try {
    const parse = bodySchema.safeParse(req.body || {});
    if (!parse.success) {
      return res.status(400).json({ success: false, error: 'invalid_input', issues: parse.error.issues });
    }
    const { to, message, brandName, language } = parse.data;

    const asset = await StudioAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    if (!ownsAsset(asset, req)) return res.status(403).json({ success: false, error: 'forbidden' });

    const mediaUrl = asset.cleanUrl || asset.url || asset.watermarkedUrl || asset.thumbnailUrl;
    if (!mediaUrl) {
      return res.status(400).json({ success: false, error: 'asset_has_no_media' });
    }

    // ── Per-asset rate limit: max 5 sends per asset ─────────────────────────
    if ((asset.whatsappSendCount || 0) >= 5) {
      return res.status(429).json({ success: false, error: 'send_cap_reached', cap: 5 });
    }

    const caption = buildBilingualCaption({
      brandName: brandName || asset.brandName,
      message,
      language,
    });

    const result = await sendWhatsappMessage({ to, body: caption, mediaUrl });

    if (!result.ok) {
      return res.status(result.simulated ? 503 : 502).json({
        success: false,
        error: result.error || 'whatsapp_send_failed',
        simulated: !!result.simulated,
      });
    }

    await StudioAsset.findByIdAndUpdate(asset._id, {
      $inc: { whatsappSendCount: 1 },
      $push: {
        whatsappSends: {
          to: normalizeWhatsAppNumber(to),
          sid: result.sid,
          sentAt: new Date(),
          sentBy: req.user?._id || null,
          language,
        },
      },
    });

    res.json({
      success: true,
      sid: result.sid,
      to: normalizeWhatsAppNumber(to),
      mediaUrl,
      message: 'Asset delivered to WhatsApp.',
    });
  } catch (err) {
    console.error('[whatsappDelivery] error:', err);
    res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
};
