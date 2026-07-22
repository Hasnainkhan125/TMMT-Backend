/**
 * renderVideoAd.js - PHASE 1 + 2 (live shot generation, no stub, no Remotion).
 * buildShotRecipe is ASYNC now - it is awaited. This is the fix for the
 * `recipe.shots.map is undefined` crash (recipe was a Promise).
 */

const { buildShotRecipe } = require('./shotRecipeEngine');
const adSetService = require('../services/adSetService');   // adjust path

function extractChildJobIds(result) {
  if (Array.isArray(result?.childJobIds)) return result.childJobIds.map(String);
  if (Array.isArray(result?.children)) return result.children.map((c) => String(c._id || c.id));
  return [];
}

async function resolveShotClips(recipe, { req, scan, brand, productImageUrl, competitorPosterUrl, avatarBrief, audio, startImageUrl }) {
 

const variantBlueprints = recipe.shots.map((s) => {
    const presenter = avatarBrief?.preset?.previewCoverUrl || avatarBrief?.avatarThumbUrl || null;
    const product   = productImageUrl || s.sourceRef || null;

    // Per-beat reference images: beat's own edited frames/refs first, then
    // presenter + product as fallback anchors. Wan supports up to 4 images.
    const beatRefs = Array.isArray(s.beatAssetUrls) ? s.beatAssetUrls : [];
    const referenceImageUrls = [
      ...beatRefs,
      presenter,
      product,
    ].filter((u, i, arr) => u && arr.indexOf(u) === i)  // dedupe
     .slice(0, 4);

    // startImageUrl: prefer the first beat-specific edited frame if available,
    // otherwise fall back to product image for visual anchor.
    const shotStartUrl = beatRefs[0] || product || undefined;

    return {
      prompt:             s.prompt,
      userCopy:           s.userCopy || '',    // VO line per shot
      aspectRatio:        s.aspectRatio,
      modelId:            s.modelId,
      durationSec:        s.durationSec,
      referenceImageUrls,
      referenceImageUrl:  shotStartUrl,
      startImageUrl:      shotStartUrl,
      competitorPosterUrl: competitorPosterUrl || undefined,
      avatarBrief:        avatarBrief?.preset?.previewCoverUrl || startImageUrl || undefined,
      audio:              audio || undefined,
      presenterImageUrl:  presenter || undefined,
      label:              `shot-${s.index}-${s.role}`,
    };
  });

  const seed = recipe.shots[0];
  const inputs = {
    // Top-level prompt = first shot's director prompt (used if adSetService falls
    // back to a single-variant path). Each shot's real prompt is in variantBlueprints.
    prompt:        seed.prompt,
    kind:          'video',
    numVariants:   recipe.shots.length,
    aspectRatio:   recipe.aspect,
    durationSec:   seed.durationSec,
    brandName:     brand.brandName,
    resolution:    seed.resolution,
    category:      brand.category || '',
    locale:        'global',
    vibe:          'cinematic',
    referenceImageUrls: variantBlueprints[0].referenceImageUrls,
    presenterImageUrl:  variantBlueprints[0].presenterImageUrl,
    competitorPosterUrl: variantBlueprints[0].competitorPosterUrl,
    avatarBrief:        variantBlueprints[0].avatarBrief,
    audio:              variantBlueprints[0].audio,
    startImageUrl:      variantBlueprints[0].startImageUrl,
    generateCopy:  false,
    // Each element has its own prompt, referenceImageUrls, durationSec, userCopy —
    // adSetService fans these out as independent child jobs.
    variantBlueprints,
    extras: { sourceScanId: brand.scanId, source: 'url_to_ads_video', videoAd: true },
  };

  const result = await adSetService.enqueueAdSet({ req, inputs });
  const jobIds = extractChildJobIds(result);

  return {
    adSetId: result?.adSetId || null,
    clips: recipe.shots.map((s, i) => ({
      durationSec: s.durationSec,
      shotIndex: i,
      jobId: jobIds[i] ? String(jobIds[i]) : null,
      clipUrl: null,
      status: jobIds[i] ? 'queued' : 'failed',
    })),
  };
}

async function  renderVideoAd({
  scan, req, templateKey, headline, cta, productImageUrl,
  aspectRatio, shotCount = 3, durationSec = 12,
  lipsync = false, textOverlay = true,
  competitorPosterUrl, avatarBrief, audio, startImageUrl,
  brandName,     // from spec.brand.name, takes precedence over scan.brand.name
  __specBeats,   // per-beat data from adSpecToRecipeOpts — drives per-shot prompts + images
  deps = {},
}) {
  const brand = {
    scanId: String(scan._id),
    brandName: brandName || scan.brand?.name || 'the brand',
    category: scan.brand?.category || '',
    angle: headline || scan.ads?.[0]?.headline || '',
    palette: (scan.brandPalette?.swatches || []).map((s) => s?.hex).filter(Boolean).slice(0, 4),
    productImageUrl: productImageUrl || null,
    logoUrl: scan.brand?.logoUrl || null,
  };

  const recipe = await buildShotRecipe(
    brand,
    { templateKey, headline, cta, shotCount, durationSec, aspectRatio, productImageUrl, competitorPosterUrl, avatarBrief, audio, startImageUrl, __specBeats },
    deps,
  );



  const { adSetId, clips } = await resolveShotClips(recipe, {
    req, scan, brand, productImageUrl: productImageUrl || null, competitorPosterUrl, avatarBrief, audio, startImageUrl,
  });

  const adRow = {
    label: recipe.label,
    kind: 'video',
    aspectRatio: recipe.aspect,
    status: 'rendering',
    assetUrl: undefined,
    shotPlan: recipe.shots.map((s) => ({
      index: s.index,
      role: s.role,
      durationSec: s.durationSec,
      clipUrl: null,
      status: clips[s.index]?.status || 'queued',
      overlay: s.overlay || null,
    })),
    shotJobIds: clips.map((c) => c.jobId),
    overlayPlan: recipe.overlayPlan,
    totalDurationSec: recipe.totalDurationSec,
    adSetId,
    jobId: `videoad-${Date.now()}`,
    post: { lipsync, textOverlay },
  };

  scan.ads = [...(scan.ads || []), adRow];
  if (scan.status !== 'rendering') scan.status = 'rendering';
  await scan.save();

  return { scan, recipe, adRow };
}

module.exports = { renderVideoAd, resolveShotClips, extractChildJobIds };