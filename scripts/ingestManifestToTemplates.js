'use strict';

/**
 * ingestManifestToTemplates.js
 *
 * Reads `qumak-backend/data/manifest.json` (R2 asset inventory) and collapses
 * it into ~313 GenerationTemplate documents — one per unique (source, sourceId)
 * pair.
 *
 * Why this exists:
 *   The manifest is an inventory of files in R2, not a catalog of generation
 *   blueprints. The Studio gallery needs blueprints (cover image, preview
 *   video, prompt, model hint, name, category). This script bridges the two.
 *
 * Branding policy:
 *   We surface every template as a Qumak template. The original `source`
 *   ('higgsfield', 'creatify', …) is kept in `meta.originSource` for internal
 *   debugging only — the user-facing `name`, `description`, and the schema's
 *   `source` enum value are normalised to Qumak families
 *   ('qumak_cinematic', 'qumak_product', etc.).
 *
 * Mapping rules:
 *   HIGGSFIELD (user-generated, has prompt + job_set_type):
 *     coverUrl       ← thumb_min || thumb_raw publicUrl
 *     previewVideo   ← video_min publicUrl
 *     previewImages  ← every still in the asset bundle (thumb_*)
 *     promptBlueprint ← sourceMetadata.prompt
 *     name           ← derived from prompt (first sentence, max 80 chars)
 *     supportedModels ← inferred from job_set_type (seedance_2_0 → seedance_2.0)
 *     constraints    ← inferred from prompt + job_set_type (gimbal/orbit/...)
 *     hookTags       ← inferred from prompt vocabulary
 *
 *   CREATIFY (template presets):
 *     coverUrl       ← thumbnail publicUrl
 *     previewVideo   ← preview_video publicUrl
 *     previewImages  ← all showcase_preview publicUrls (also kept in showcases)
 *     referenceImage ← reference publicUrl
 *     name           ← sourceMetadata.name
 *     description    ← sourceMetadata.description
 *     promptBlueprint ← templated from name+description
 *     supportedModels ← ['flux_pro','seedance_2.0'] (Creatify-style)
 *
 * Idempotent: upsert by (source, sourceId).
 *
 * Usage:
 *   node qumak-backend/scripts/ingestManifestToTemplates.js
 *   node qumak-backend/scripts/ingestManifestToTemplates.js --dry-run
 *   node qumak-backend/scripts/ingestManifestToTemplates.js --limit=20
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { GenerationTemplate } = require('../model/schema/GenerationTemplate');

// New canonical location inside the backend tree. The legacy testing_saas
// path is no longer required.
const MANIFEST_PATH = path.resolve(__dirname, '../data/manifest.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

// ── Heuristics ───────────────────────────────────────────────────────────────

const HF_JOB_TO_MODEL = {
  seedance_2_0:        'seedance_2.0',
  seedance_2_0_fast:   'seedance_2.0_fast',
  seedance_1_5_pro:    'seedance_1.5_pro',
  kling_3_0:           'kling_3.0',
  veo_3_1:             'veo_3.1',
  sora_2:              'sora_2',
  wan_2_7:             'wan_2.7',
  minimax_hailuo_2_3:  'minimax_hailuo_2.3',
};

const CATEGORY_KEYWORDS = {
  restaurant:  ['food', 'kabab', 'shawarma', 'restaurant', 'meal', 'cafe', 'plate', 'kitchen', 'chef'],
  perfume:     ['perfume', 'oud', 'fragrance', 'attar', 'cologne', 'parfum'],
  fashion:     ['fashion', 'dress', 'abaya', 'kandura', 'thobe', 'model', 'runway', 'apparel', 'clothing'],
  jewelry:     ['jewelry', 'jewellery', 'ring', 'necklace', 'gold', 'bracelet', 'diamond'],
  beauty:      ['beauty', 'lipstick', 'mascara', 'cosmetic', 'makeup'],
  skincare:    ['skincare', 'serum', 'cream', 'moisturizer', 'facial'],
  haircare:    ['haircare', 'shampoo', 'hair'],
  realestate:  ['real estate', 'apartment', 'villa', 'property', 'penthouse', 'tower', 'marina', 'downtown', 'living room', 'kitchen interior'],
  gym:         ['gym', 'fitness', 'workout', 'training', 'crossfit', 'dumbbell', 'deadlift', 'athlete'],
  tech:        ['phone', 'laptop', 'tech', 'gadget', 'headphones', 'earbuds', 'device'],
  ecommerce:   ['product', 'showcase', 'unbox', 'review'],
  hotel:       ['hotel', 'resort', 'spa', 'suite'],
  automotive:  ['car', 'auto', 'vehicle', 'sedan', 'suv', 'drift'],
};

// Used to derive cinematic constraints from the free-text prompt.
const PROMPT_RULES = [
  // motion
  { match: /\b(orbit|rotate|rotating|spin)/i,           set: { motion: 'orbit' } },
  { match: /\b(gimbal|glide|smooth glide)/i,            set: { motion: 'gimbal' } },
  { match: /\b(handheld|shaky|raw)/i,                   set: { motion: 'handheld' } },
  { match: /\b(dolly in|push in)/i,                     set: { motion: 'dolly_in' } },
  { match: /\b(dolly out|pull back|pulling back)/i,     set: { motion: 'dolly_out' } },
  { match: /\b(whip pan)/i,                             set: { motion: 'whip_pan' } },
  { match: /\bslow pan/i,                               set: { motion: 'slow_pan' } },
  { match: /\b(crash zoom|snap zoom)/i,                 set: { motion: 'crash_zoom' } },
  { match: /\btilt\b/i,                                 set: { motion: 'tilt' } },
  { match: /\btracking shot|follow(ing)? (the )?(subject|board|car)/i, set: { motion: 'tracking', cameraAngle: 'tracking' } },

  // camera angle
  { match: /\bpov\b|first[- ]person|fisheye/i,          set: { cameraAngle: 'pov' } },
  { match: /\blow angle\b|hero shot/i,                  set: { cameraAngle: 'low_angle' } },
  { match: /\bhigh angle\b|top[- ]down/i,               set: { cameraAngle: 'high_angle' } },
  { match: /\b(birds|bird's) eye/i,                     set: { cameraAngle: 'birds_eye' } },
  { match: /\bover[- ]shoulder/i,                       set: { cameraAngle: 'over_shoulder' } },
  { match: /\bdutch (tilt|angle)/i,                     set: { cameraAngle: 'dutch' } },

  // lighting
  { match: /\bgolden hour|sunset|warm golden/i,         set: { lighting: 'golden_hour' } },
  { match: /\bblue hour|dusk/i,                         set: { lighting: 'blue_hour' } },
  { match: /\bneon|cyberpunk|reflective wet street/i,   set: { lighting: 'neon' } },
  { match: /\brim light|backlit/i,                      set: { lighting: 'rim_light' } },
  { match: /\bsoftbox|even soft/i,                      set: { lighting: 'studio_softbox' } },
  { match: /\bhigh[- ]key|bright airy/i,                set: { lighting: 'high_key' } },
  { match: /\blow[- ]key|moody|dark dramatic/i,         set: { lighting: 'low_key' } },
  { match: /\bcinematic (lighting|colour|color)/i,      set: { lighting: 'cinematic' } },
  { match: /\bnatural (light|lighting)/i,               set: { lighting: 'natural' } },

  // shot type
  { match: /\bmacro\b|extreme close[- ]up/i,            set: { shotType: 'macro' } },
  { match: /\bclose[- ]up/i,                            set: { shotType: 'closeup' } },
  { match: /\bwide (shot|framing)|landscape framing/i,  set: { shotType: 'wide' } },
  { match: /\baerial|drone shot/i,                      set: { shotType: 'aerial' } },

  // pace
  { match: /\bfast cuts|frenetic|chaotic/i,             set: { pace: 'fast' } },
  { match: /\bslow motion|slo[- ]mo|slowly/i,           set: { pace: 'slow' } },
];

// Higgsfield job_set_type → default constraints. Most presets are gimbal
// orbits, but a few lean POV/crash-zoom.
const HF_JOB_DEFAULT_CONSTRAINTS = {
  seedance_2_0:        { motion: 'gimbal', pace: 'medium' },
  seedance_2_0_fast:   { motion: 'gimbal', pace: 'fast' },
  seedance_1_5_pro:    { motion: 'gimbal' },
  kling_3_0:           { motion: 'gimbal' },
  veo_3_1:             { motion: 'gimbal' },
  sora_2:              { motion: 'gimbal' },
  wan_2_7:             { motion: 'gimbal' },
  minimax_hailuo_2_3:  { motion: 'gimbal' },
};

const HOOK_RULES = [
  { match: /unbox|reveal/i,             tag: 'reveal' },
  { match: /before.*after|transformation/i, tag: 'transformation' },
  { match: /(shop|buy|order|book) now/i, tag: 'urgency' },
  { match: /try on|virtual try/i,       tag: 'try_on' },
  { match: /walk.?through|tour/i,       tag: 'walkthrough' },
  { match: /testimonial|review|customer says/i, tag: 'social_proof' },
  { match: /how to|tutorial/i,          tag: 'how_to' },
  { match: /question|did you know/i,    tag: 'curiosity' },
  { match: /lifestyle/i,                tag: 'lifestyle' },
  { match: /macro|close[- ]up/i,        tag: 'macro_hero' },
  { match: /editorial|lookbook/i,       tag: 'editorial' },
  { match: /cinematic|film/i,           tag: 'cinematic' },
];

function inferCategories(text) {
  if (!text) return ['general'];
  const lower = text.toLowerCase();
  const matched = [];
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((k) => lower.includes(k))) matched.push(cat);
  }
  return matched.length ? matched.slice(0, 3) : ['general'];
}

function inferContentType(text, mediaType) {
  if (!text) return mediaType === 'video' ? 'product_showcase' : 'product_hero';
  const lower = text.toLowerCase();
  if (lower.includes('ugc') || lower.includes('review') || lower.includes('unbox')) return 'ugc_review';
  if (lower.includes('try on') || lower.includes('try-on') || lower.includes('virtual')) return 'ugc_virtual_try_on';
  if (lower.includes('food') || lower.includes('kabab') || lower.includes('plate')) return 'food_lifestyle';
  if (lower.includes('cinematic') || lower.includes('film')) return 'cinematic_scene';
  if (lower.includes('luxury') || lower.includes('premium')) return 'brand_luxury';
  if (lower.includes('lifestyle')) return 'brand_lifestyle';
  return mediaType === 'video' ? 'product_showcase' : 'product_hero';
}

function inferConstraints(text, jobType) {
  const constraints = { ...(HF_JOB_DEFAULT_CONSTRAINTS[jobType] || {}) };
  if (!text) return constraints;
  for (const rule of PROMPT_RULES) {
    if (rule.match.test(text)) Object.assign(constraints, rule.set);
  }
  return constraints;
}

function inferHookTags(text) {
  if (!text) return [];
  const tags = new Set();
  for (const rule of HOOK_RULES) {
    if (rule.match.test(text)) tags.add(rule.tag);
  }
  return [...tags].slice(0, 5);
}

function deriveName(prompt, fallback) {
  if (!prompt) return fallback;
  const firstSentence = String(prompt).split(/[.!?]/)[0].trim();
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + '…' : firstSentence;
}

function pickFirst(items, role) {
  return items.find((i) => i.assetRole === role && i.publicUrl)?.publicUrl || null;
}

function pickAll(items, role) {
  return items.filter((i) => i.assetRole === role && i.publicUrl).map((i) => i.publicUrl);
}

// ── Builders ─────────────────────────────────────────────────────────────────

function buildHiggsfieldTemplate(sourceId, items) {
  const meta = items[0].sourceMetadata || {};
  const prompt = meta.prompt || '';
  const jobType = meta.job_set_type || '';
  const model = HF_JOB_TO_MODEL[jobType] || 'seedance_2.0';

  const coverUrl = pickFirst(items, 'thumb_min') || pickFirst(items, 'thumb_raw');
  const previewVideo = pickFirst(items, 'video_min') || pickFirst(items, 'video_raw');
  const previewImages = [
    ...pickAll(items, 'thumb_min'),
    ...pickAll(items, 'thumb_raw'),
  ].filter((u) => u !== coverUrl).slice(0, 4);

  const baseName = deriveName(prompt, `Cinematic ${jobType.replace(/_/g, ' ') || 'video'}`);
  const name = baseName.replace(/^higgsfield\s*/i, '').trim() || 'Qumak Cinematic';
  const categories = inferCategories(prompt);
  const contentType = inferContentType(prompt, 'video');
  const constraints = inferConstraints(prompt, jobType);
  const hookTags = inferHookTags(prompt);

  // Promote prompt to a generic blueprint by inserting injection tokens.
  const blueprint =
    `${prompt}\n\nFor brand: {brand_name}. Product: {product_name} — {product_desc}. Reference: {product_image}`;

  const engagement = {
    viewsCount: meta.views_count || 0,
    likesCount: meta.likes_count || 0,
    finalScore: (meta.likes_count || 0) * 1.5 + Math.log10((meta.views_count || 1) + 1) * 10,
    qualityTier: (meta.views_count || 0) > 10000 ? 'featured' : 'standard',
  };

  return {
    // Source enum is normalised to a Qumak family — internal origin is kept
    // in `meta.originSource` for support / re-ingest only.
    source: 'qumak_cinematic',
    sourceId,
    name,
    description: prompt.slice(0, 280),
    contentType,
    contentGroup: 'cinematic',
    outputType: 'video',
    aspectRatio: items[0].width >= items[0].height ? '16:9' : '9:16',
    defaultDuration: 8,
    defaultResolution: 720,
    promptBlueprint: blueprint,
    negativePrompt: 'text overlay, watermark, logo, low quality, distorted, amateur',
    supportedModels: [model],
    recommendedModel: model,
    inputSlots: [
      { key: 'brand_name',   type: 'text', title: 'Brand name', required: true,  maxLength: 100 },
      { key: 'product_desc', type: 'text', title: 'Product description', required: false, maxLength: 500 },
      { key: 'product_image',type: 'image',title: 'Product image (optional)', required: false, allowedFormats: ['jpg','jpeg','png','webp'], maxFileSizeMB: 10 },
    ],
    bestCategories: categories,
    bestPlatforms: ['instagram', 'tiktok', 'snapchat'],
    locale: 'both',
    media: { coverUrl, previewVideo, referenceImage: null, showcases: [], previewImages },
    constraints,
    hookTags,
    engagement,
    isActive: !!coverUrl,
    isFeatured: engagement.qualityTier === 'featured',
    planLevel: 'free',
    meta: { originSource: 'higgsfield', originJobType: jobType },
  };
}

function buildCreatifyTemplate(sourceId, items) {
  const meta = items[0].sourceMetadata || {};
  const rawName = (meta.name || 'Qumak Product Template').trim();
  const name = rawName.replace(/^creatify\s*/i, '').trim() || 'Qumak Product';
  const description = (meta.description || '').trim();

  const coverUrl     = pickFirst(items, 'thumbnail');
  const previewVideo = pickFirst(items, 'preview_video');
  const referenceImage = pickFirst(items, 'reference');
  const showcases    = pickAll(items, 'showcase_preview');

  const haystack = `${name}\n${description}`;
  const categories = inferCategories(haystack);
  const contentType = inferContentType(haystack, 'video');
  const constraints = inferConstraints(haystack, 'seedance_2_0');
  const hookTags = inferHookTags(haystack);

  // Pseudo-prompt: Creatify doesn't expose its real cinematic prompt, so we
  // synthesise a Qumak-flavoured one using the template name + description.
  const blueprint = [
    `Create a 9:16 short ad in the style of "${name}".`,
    description ? `Style direction: ${description}` : '',
    `Subject: {brand_name} — {product_name}.`,
    `{product_desc}`,
    `Hook: {hook_line}. CTA: {cta_line}.`,
    `Reference imagery: {product_image}.`,
  ].filter(Boolean).join('\n');

  const renderCount = meta.render_count || 0;
  const finalScore = renderCount > 0 ? Math.log10(renderCount + 1) * 25 : 5;

  return {
    source: previewVideo ? 'qumak_product' : 'qumak_static',
    sourceId,
    name,
    description,
    contentType,
    contentGroup: 'product',
    outputType: previewVideo ? 'video' : 'image',
    aspectRatio: '9:16',
    defaultDuration: 6,
    defaultResolution: 720,
    promptBlueprint: blueprint,
    negativePrompt: 'text overlay, watermark, logo, low quality, distorted, amateur',
    supportedModels: previewVideo ? ['seedance_2.0', 'kling_3.0'] : ['flux_pro', 'flux_schnell'],
    recommendedModel: previewVideo ? 'seedance_2.0' : 'flux_pro',
    inputSlots: [
      { key: 'brand_name',   type: 'text',  title: 'Brand name', required: true, maxLength: 100 },
      { key: 'product_name', type: 'text',  title: 'Product name', required: true, maxLength: 100 },
      { key: 'product_desc', type: 'text',  title: 'Product description', required: false, maxLength: 500 },
      { key: 'product_image',type: 'image', title: 'Product image', required: true,
        allowedFormats: ['jpg','jpeg','png','webp'], maxFileSizeMB: 15 },
      { key: 'cta_line',     type: 'text',  title: 'Call to action', required: false, default: 'Shop now', maxLength: 60 },
    ],
    requiresProductImage: true,
    bestCategories: categories,
    bestPlatforms: ['instagram','tiktok','facebook'],
    locale: 'both',
    media: {
      coverUrl,
      previewVideo,
      referenceImage,
      showcases,
      previewImages: showcases.slice(0, 4),
    },
    constraints,
    hookTags,
    engagement: {
      renderCount,
      finalScore,
      qualityTier: renderCount > 100 ? 'featured' : 'standard',
    },
    isActive: !!coverUrl,
    isFeatured: renderCount > 200,
    planLevel: 'free',
    meta: { originSource: 'creatify' },
  };
}

// ── Driver ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('Manifest not found at', MANIFEST_PATH);
    console.error('Tip: copy testing_saas/bulk_Gain/manifest.json to qumak-backend/data/manifest.json');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`[ingest] manifest items: ${raw.length}`);

  // Group by (source, sourceId).
  const groups = new Map();
  for (const it of raw) {
    const key = `${it.source}:${it.sourceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  console.log(`[ingest] unique sourceIds: ${groups.size}`);

  // Build template docs.
  const docs = [];
  let skipped = 0;
  for (const [key, items] of groups) {
    const src = items[0].source;
    let doc;
    try {
      if (src === 'higgsfield') doc = buildHiggsfieldTemplate(items[0].sourceId, items);
      else if (src === 'creatify') doc = buildCreatifyTemplate(items[0].sourceId, items);
      else { skipped++; continue; }
    } catch (e) {
      console.warn(`[ingest] skip ${key}:`, e.message);
      skipped++;
      continue;
    }
    if (!doc.media.coverUrl && !doc.media.previewVideo) {
      // Nothing to display in the gallery — drop.
      skipped++;
      continue;
    }
    docs.push(doc);
    if (LIMIT && docs.length >= LIMIT) break;
  }

  console.log(`[ingest] producing ${docs.length} templates (skipped ${skipped})`);

  if (DRY_RUN) {
    console.log('[ingest] DRY RUN — first 2 docs:');
    console.log(JSON.stringify(docs.slice(0, 2), null, 2));
    return;
  }

  const dbUrl = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.DB || 'qumak';
  await mongoose.connect(`${dbUrl}/${dbName}`);
  console.log('[ingest] connected to', dbName);

  let upserted = 0;
  for (const doc of docs) {
    await GenerationTemplate.updateOne(
      { source: doc.source, sourceId: doc.sourceId },
      { $set: doc },
      { upsert: true },
    );
    upserted++;
    if (upserted % 50 === 0) console.log(`[ingest] upserted ${upserted}/${docs.length}`);
  }
  console.log(`[ingest] done — upserted ${upserted}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[ingest] fatal:', err);
  process.exit(1);
});
