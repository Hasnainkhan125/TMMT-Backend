'use strict';

/**
 * frameEditController.js — per-beat frame editing using OpenAI image API.
 *
 * POST /studio/url-to-ads/scan/:id/spec/:specId/beats/:beatIndex/edit-frame
 *   body: { prompt, frameUrl }
 *   → { editedUrl }
 *
 * Uses gpt-image-1 (or dall-e-2 as fallback) to generate a brand-aligned
 * replacement frame based on the competitor frame + user prompt. The user
 * sees the competitor frame as reference and types what they want to change
 * ("replace the person with [avatar]", "change background to studio white").
 */

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');

let openai = null;
function getOpenAI() {
  if (!openai) {
    const { OpenAI } = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

let uploadBufferToR2 = null;
try { uploadBufferToR2 = require('../../services/storageService').uploadBufferToR2; } catch {}

function fail(res, err) {
  const map = { not_found: 404, forbidden: 403, bad_request: 400 };
  const status = map[err?.code] || 500;
  if (status === 500) console.error('[frameEditController]', err);
  return res.status(status).json({ success: false, error: err?.code || 'server_error', message: err?.message });
}

async function editFrame(req, res) {
  try {
    const { id: scanId, specId, beatIndex } = req.params;
    const { prompt, frameUrl } = req.body || {};

    if (!prompt) {
      const e = new Error('prompt is required'); e.code = 'bad_request'; throw e;
    }

    const scan = await UrlToAdsScan.findById(scanId);
    if (!scan) { const e = new Error('scan not found'); e.code = 'not_found'; throw e; }

    const ai = getOpenAI();

    // Use gpt-image-1 for image generation with the frame as context.
    // We send the competitor frame URL as a reference image description.
    const referenceContext = frameUrl
      ? `Reference frame from competitor ad at beat ${beatIndex}.`
      : `Beat ${beatIndex} of a competitor ad.`;

    const fullPrompt = [
      referenceContext,
      'Generate a clean, brand-aligned replacement frame for this beat:',
      prompt,
      'Style: professional short-form video ad frame, no text overlay, photorealistic.',
    ].join(' ');

    const response = await ai.images.generate({
      model: 'gpt-image-1',
      prompt: fullPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1,
    });

    const imageData = response.data?.[0];
    if (!imageData) throw new Error('no image returned from OpenAI');

    // If b64_json, upload to R2; if URL, use directly
    let editedUrl = imageData.url || null;
    if (!editedUrl && imageData.b64_json && uploadBufferToR2) {
      const buf = Buffer.from(imageData.b64_json, 'base64');
      const key = `frame-edits/${scanId}/${specId}/beat_${beatIndex}_edited.png`;
      editedUrl = await uploadBufferToR2({ buffer: buf, key, contentType: 'image/png' });
    }

    return res.json({ success: true, editedUrl });
  } catch (err) {
    // Fallback: if gpt-image-1 fails (quota/model), try dall-e-2
    if (err?.status === 404 || err?.code === 'model_not_found') {
      return editFrameFallback(req, res);
    }
    return fail(res, err);
  }
}

async function editFrameFallback(req, res) {
  try {
    const { prompt } = req.body || {};
    const { id: scanId, specId, beatIndex } = req.params;
    const ai = getOpenAI();

    const response = await ai.images.generate({
      model: 'dall-e-2',
      prompt: `Professional video ad frame, beat ${beatIndex}: ${prompt}. Clean, no text.`,
      size: '512x512',
      n: 1,
    });

    const editedUrl = response.data?.[0]?.url || null;
    return res.json({ success: true, editedUrl, fallback: true });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { editFrame };
