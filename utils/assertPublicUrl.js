'use strict';

/**
 * assertPublicUrl — shared guard used by every studio service that hands a
 * URL off to an external provider (FAL, Replicate, Gemini, OpenAI image
 * edit, …). These providers fetch the URL from *their* servers, which
 * means anything on localhost / RFC1918 / link-local is unreachable.
 *
 * When the URL is unreachable we throw a structured error:
 *
 *   { code: 'unreachable_asset_url',
 *     message: '…',
 *     fieldName: 'firstFrameUrl',     // which input offends
 *     url: 'http://localhost:5001/…', // the bad URL itself
 *     sceneIndex?: number }           // for reel / ad-set fan-outs
 *
 * Controllers translate this into HTTP 400 with a helpful body so the UI
 * can say "Your start frame isn't publicly reachable — re-upload it" with
 * no guesswork.
 *
 * The rules here must stay in sync with uploadController.isPublicUrl so a
 * URL that passes upload-time will pass enqueue-time too.
 */

function isPublicHttpUrl(u) {
  if (!u || typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
  if (host.endsWith('.local')) return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map((x) => parseInt(x, 10));
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

/**
 * assertPublicUrl — throw a tagged error when `url` isn't reachable.
 * `url` is nullable: a missing URL is allowed (it'll be caught by
 * modelRouter.validateRequiredFields if the model actually needs it).
 *
 * Use this BEFORE calling modelRouter.route / fal.subscribe.
 */
function assertPublicUrl(url, { fieldName, sceneIndex = null } = {}) {
  if (url == null || url === '') return;
  if (isPublicHttpUrl(url)) return;

  const err = new Error(
    `The ${fieldName || 'asset URL'} "${url}" isn't publicly reachable. ` +
    `External generation services (FAL, Replicate, Gemini) can't fetch ` +
    `localhost or private-network URLs. Re-upload the file through the ` +
    `/studio/upload/reference endpoint so it lands on R2 / CDN, then retry.`
  );
  err.code = 'unreachable_asset_url';
  err.fieldName = fieldName || null;
  err.url = url;
  if (sceneIndex != null) err.sceneIndex = sceneIndex;
  throw err;
}

/**
 * assertSceneAssetsPublic — convenience wrapper for services that iterate
 * scenes (reelService, adSetService, influencerService).
 */
function assertSceneAssetsPublic(scene) {
  assertPublicUrl(scene.firstFrameUrl,     { fieldName: 'firstFrameUrl',     sceneIndex: scene.sceneIndex });
  assertPublicUrl(scene.lastFrameUrl,      { fieldName: 'lastFrameUrl',      sceneIndex: scene.sceneIndex });
  assertPublicUrl(scene.referenceImageUrl, { fieldName: 'referenceImageUrl', sceneIndex: scene.sceneIndex });
  assertPublicUrl(scene.endFrameUrl,       { fieldName: 'endFrameUrl',       sceneIndex: scene.sceneIndex });
}

module.exports = {
  assertPublicUrl,
  assertSceneAssetsPublic,
  isPublicHttpUrl,
};
