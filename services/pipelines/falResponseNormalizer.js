'use strict';

/**
 * falResponseNormalizer — extracts output URLs from fal.ai responses.
 *
 * Different fal models return data in different shapes. This module
 * centralizes the extraction so one schema change doesn't break 4 files.
 *
 * Supported response shapes:
 *   - data.video.url          (Seedance, Kling, most video models)
 *   - data.video_url          (some older endpoints)
 *   - data.output.url         (Hedra, Character 3)
 *   - data.output[0].url      (batch endpoints)
 *   - data.images[0].url      (Flux, Seedream)
 *   - data.image.url          (some image models)
 *   - video.url               (models without .data wrapper)
 */

function extractVideoUrl(falResult) {
  return (
    falResult?.data?.video?.url
    ?? falResult?.data?.video_url
    ?? falResult?.data?.output?.url
    ?? (Array.isArray(falResult?.data?.output) ? falResult.data.output[0]?.url : null)
    ?? falResult?.video?.url
    ?? falResult?.url
    ?? null
  );
}

function extractImageUrl(falResult) {
  return (
    falResult?.data?.images?.[0]?.url
    ?? falResult?.data?.image?.url
    ?? falResult?.data?.output?.url
    ?? (Array.isArray(falResult?.data?.output) ? falResult.data.output[0]?.url : null)
    ?? falResult?.data?.image_url
    ?? falResult?.image?.url
    ?? falResult?.url
    ?? null
  );
}

function extractAudioUrl(falResult) {
  return (
    falResult?.data?.audio?.url
    ?? falResult?.data?.audio_url
    ?? falResult?.audio?.url
    ?? null
  );
}

function extractAllImageUrls(falResult) {
  if (Array.isArray(falResult?.data?.images)) {
    return falResult.data.images.map((i) => i.url).filter(Boolean);
  }
  if (Array.isArray(falResult?.data?.output)) {
    return falResult.data.output.map((o) => o.url || o).filter(Boolean);
  }
  const single = extractImageUrl(falResult);
  return single ? [single] : [];
}

module.exports = {
  extractVideoUrl,
  extractImageUrl,
  extractAudioUrl,
  extractAllImageUrls,
};