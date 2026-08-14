'use strict';

/**
 * templatesController — read-only surface that serves UGC / Product /
 * Vibe Motion / Lipsync portrait templates to the frontend from the
 * three static data files shipped with the backend:
 *
 *   data/manifest.json              (motion tiles for Vibe Motion)
 *   scripts/creatify_templates.json (UGC + product templates)
 *   scripts/topview_templates.json  (Seedance templates)
 *
 * All endpoints are cheap (no DB, no LLM, no Fal) — results are derived
 * in-process from the JSON files, which templatesCatalog caches.
 *
 *   GET /studio/templates/ugc               → UGC creator templates
 *   GET /studio/templates/product           → Product showcase templates
 *   GET /studio/templates/seedance          → Seedance/TopView templates
 *   GET /studio/templates/vibe-motion       → Preset list + tiles per preset
 *   GET /studio/templates/vibe-motion/:preset → Tiles for a single preset
 *   GET /studio/templates/lipsync-portraits → Pre-curated lipsync portraits
 *   GET /studio/templates/:id               → Any template by id
 */

const catalog = require('../../services/templatesCatalog');

function readInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function ugc(req, res) {
  const limit  = Math.min(readInt(req.query.limit, 24), 60);
  const offset = Math.max(readInt(req.query.offset, 0), 0);
  const { total, items } = catalog.listUgcTemplates({ limit, offset });
  return res.json({ success: true, total, items });
}

async function product(req, res) {
  const limit  = Math.min(readInt(req.query.limit, 24), 60);
  const offset = Math.max(readInt(req.query.offset, 0), 0);
  const { total, items } = catalog.listProductTemplates({ limit, offset });
  return res.json({ success: true, total, items });
}

async function seedance(req, res) {
  const limit  = Math.min(readInt(req.query.limit, 24), 60);
  const offset = Math.max(readInt(req.query.offset, 0), 0);
  const { total, items } = catalog.listSeedanceTemplates({ limit, offset });
  return res.json({ success: true, total, items });
}

async function vibeMotion(_req, res) {
  const presets = catalog.listVibeMotionPresets();
  return res.json({ success: true, presets });
}

async function vibeMotionTiles(req, res) {
  const preset = (req.params.preset || '').trim();
  const limit  = Math.min(readInt(req.query.limit, 18), 48);
  const { items } = catalog.listVibeMotionTiles({ preset, limit });
  return res.json({ success: true, preset, items });
}

async function lipsyncPortraits(req, res) {
  const limit  = Math.min(readInt(req.query.limit, 18), 48);
  const { items } = catalog.listLipsyncPortraits({ limit });
  return res.json({ success: true, items });
}

async function byId(req, res) {
  const id = (req.params.id || '').trim();
  const t = catalog.getTemplateById(id);
  if (!t) return res.status(404).json({ success: false, error: 'not_found' });
  return res.json({ success: true, template: t });
}

module.exports = {
  ugc,
  product,
  seedance,
  vibeMotion,
  vibeMotionTiles,
  lipsyncPortraits,
  byId,
};
