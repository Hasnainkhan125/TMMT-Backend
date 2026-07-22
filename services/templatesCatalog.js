'use strict';

/**
 * templatesCatalog — unified read-through API over the three static asset
 * sources we ship with the backend, so the frontend doesn't have to hit
 * multiple endpoints to populate Lipsync / UGC Factory / Vibe Motion:
 *
 *   data/manifest.json               — ingested Higgsfield/Seedance samples
 *                                      used as generic motion-preview tiles.
 *   scripts/creatify_templates.json  — product-showcase + UGC creator
 *                                      templates with promptBlueprint +
 *                                      modelParameters (the actual rec for
 *                                      a model to run).
 *   scripts/topview_templates.json   — Seedance / TopView templates.
 *
 * This service is loaded lazily: all three files are big-ish JSON blobs,
 * so we cache parsed + filtered views for the life of the process.
 *
 * Public getters:
 *   listUgcTemplates({ limit, cursor })      - creatify contentGroup=ugc
 *   listProductTemplates({ limit, cursor })  - creatify contentGroup=product
 *   listVibeMotionPresets({ preset, limit }) - manifest video tiles bucketed
 *                                               to the 6 Vibe Motion presets
 *                                               (Infographics / Text Animation
 *                                               / Posters / Presentation /
 *                                               From scratch / Your projects)
 *   listLipsyncPortraits({ limit })          - image tiles suitable as
 *                                               lipsync base portraits.
 *   getTemplateById(id)                      - look up any template by
 *                                               sourceId / sourceHash.
 */

const path = require('path');

let _creatify = null;
let _topview  = null;
let _manifest = null;

function loadCreatify() {
  if (_creatify) return _creatify;
  _creatify = require(path.join(__dirname, '..', 'scripts', 'creatify_templates.json'));
  return _creatify;
}
function loadTopview() {
  if (_topview) return _topview;
  _topview = require(path.join(__dirname, '..', 'scripts', 'topview_templates.json'));
  return _topview;
}
function loadManifest() {
  if (_manifest) return _manifest;
  _manifest = require(path.join(__dirname, '..', 'data', 'manifest.json'));
  return _manifest;
}

// ─── Shaping helpers ───────────────────────────────────────────────────────

function urlOf(entry) {
  return entry?.publicUrl || entry?.sourceUrl || null;
}

function shapeCreatify(t) {
  if (!t) return null;
  return {
    id:           t.sourceId || t.sourceHash,
    source:       t.source,
    name:         t.name || 'Template',
    description:  t.description || '',
    contentGroup: t.contentGroup,
    contentType:  t.contentType,
    outputType:   t.outputType,
    aspectRatio:  t.aspectRatio,
    defaultDuration:   t.defaultDuration,
    defaultResolution: t.defaultResolution,
    promptBlueprint:   t.promptBlueprint || '',
    negativePrompt:    t.negativePrompt  || '',
    supportedModels:   t.supportedModels || [],
    recommendedModel:  t.recommendedModel || null,
    modelParameters:   t.modelParameters  || null,
    previewUrl:        null, // Creatify templates don't ship thumbs in-repo
    tags:              [t.contentGroup, t.contentType, t.outputType].filter(Boolean),
  };
}

function shapeTopview(t) {
  if (!t) return null;
  return {
    id:           t.sourceHash,
    source:       t.source,
    name:         t.name || 'Template',
    description:  t.description || '',
    contentGroup: t.contentGroup,
    contentType:  t.contentType,
    outputType:   t.outputType,
    aspectRatio:  t.aspectRatio,
    defaultDuration:   t.defaultDuration,
    defaultResolution: t.defaultResolution,
    promptBlueprint:   t.promptBlueprint || '',
    negativePrompt:    t.negativePrompt  || '',
    supportedModels:   t.supportedModels || [],
    recommendedModel:  t.recommendedModel || null,
    modelParameters:   t.modelParameters  || null,
    previewUrl:        null,
    tags:              [t.contentGroup, t.contentType, t.outputType].filter(Boolean),
  };
}

function shapeManifest(entry) {
  if (!entry) return null;
  const url = urlOf(entry);
  return {
    id:         entry.urlHash || entry.sourceId,
    source:     entry.source,
    name:       entry.sourceMetadata?.prompt?.slice(0, 60) || 'Sample',
    description: entry.sourceMetadata?.prompt || '',
    outputType: entry.mediaType,
    aspectRatio: (entry.width && entry.height)
      ? (entry.width / entry.height > 1.5 ? '16:9'
         : entry.width / entry.height > 1.0 ? '4:3'
         : entry.width === entry.height   ? '1:1'
         : entry.height / entry.width > 1.5 ? '9:16' : '4:5')
      : null,
    url,
    previewUrl: url,
    prompt:     entry.sourceMetadata?.prompt || '',
    width:      entry.width,
    height:     entry.height,
  };
}

// ─── Vibe Motion bucketing ────────────────────────────────────────────────
// We don't have pre-labeled vibe tags on the manifest, so we derive the
// six Vibe Motion presets by keyword-matching the original prompt text.
// This is deterministic and fast — caller doesn't pay an LLM cost per hit.

const VIBE_RULES = {
  infographics: /chart|graph|infographic|dashboard|data|statistic|number|metric|analytic|visualization/i,
  textAnimation: /text|typography|caption|title|kinetic|lettering|word|headline|type|letter/i,
  posters:       /poster|banner|print|flyer|editorial|magazine cover|layout/i,
  presentation:  /slide|presentation|deck|pitch|keynote|transition/i,
  scratch:       /.*/, // everything else / generic
};

function bucketVibe(entry) {
  const text = (entry?.sourceMetadata?.prompt || entry?.description || '').toString();
  for (const [key, re] of Object.entries(VIBE_RULES)) {
    if (key === 'scratch') continue;
    if (re.test(text)) return key;
  }
  return 'scratch';
}

const VIBE_PRESETS = [
  { id: 'infographics', name: 'Infographics',    tagline: 'Animate charts, data, and visual storytelling elements' },
  { id: 'textAnimation', name: 'Text Animation', tagline: 'Bring titles, captions, and typography to life' },
  { id: 'posters',       name: 'Posters',        tagline: 'Turn static posters into eye-catching motion visuals' },
  { id: 'presentation',  name: 'Presentation',   tagline: 'Create smooth, engaging slides and motion decks' },
  { id: 'scratch',       name: 'From scratch',   tagline: 'Start with a blank canvas and build any motion you want' },
  { id: 'yourProjects',  name: 'Your projects',  tagline: 'Resume and remix motion projects you\'ve already started' },
];

// ─── Public API ────────────────────────────────────────────────────────────

function listUgcTemplates({ limit = 24, offset = 0 } = {}) {
  const all = loadCreatify()
    .filter((t) => t.contentGroup === 'ugc')
    .map(shapeCreatify);
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

function listProductTemplates({ limit = 24, offset = 0 } = {}) {
  const all = loadCreatify()
    .filter((t) => t.contentGroup === 'product')
    .map(shapeCreatify);
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

function listSeedanceTemplates({ limit = 12, offset = 0 } = {}) {
  const all = loadTopview().map(shapeTopview);
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

function listVibeMotionPresets() {
  return VIBE_PRESETS;
}

function listVibeMotionTiles({ preset, limit = 18 } = {}) {
  if (!preset || preset === 'yourProjects') return { preset, items: [] };
  const manifest = loadManifest().filter(
    (e) => e.mediaType === 'video' && (e.publicUrl || e.sourceUrl)
  );
  const filtered = preset === 'scratch'
    ? manifest.filter((e) => bucketVibe(e) === 'scratch')
    : manifest.filter((e) => bucketVibe(e) === preset);
  // If a bucket is sparse (likely true for infographics since we have
  // mostly product-style assets), fall back to random generic tiles so
  // the grid never looks empty.
  const items = (filtered.length >= limit ? filtered : filtered.concat(manifest))
    .slice(0, limit)
    .map(shapeManifest)
    .filter(Boolean);
  return { preset, items };
}

function listLipsyncPortraits({ limit = 18 } = {}) {
  const manifest = loadManifest().filter(
    (e) => e.mediaType === 'image' && (e.publicUrl || e.sourceUrl)
  );
  return {
    items: manifest.slice(0, limit).map(shapeManifest).filter(Boolean),
  };
}

function getTemplateById(id) {
  if (!id) return null;
  const hit1 = loadCreatify().find((t) => t.sourceId === id || t.sourceHash === id);
  if (hit1) return shapeCreatify(hit1);
  const hit2 = loadTopview().find((t) => t.sourceHash === id);
  if (hit2) return shapeTopview(hit2);
  return null;
}

module.exports = {
  listUgcTemplates,
  listProductTemplates,
  listSeedanceTemplates,
  listVibeMotionPresets,
  listVibeMotionTiles,
  listLipsyncPortraits,
  getTemplateById,
};
