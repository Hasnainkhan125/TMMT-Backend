/**
 * routes/templates.js
 *
 * API routes for the generation_templates collection.
 * The frontend reads these to:
 *   1. Show a browsable template gallery
 *   2. Build the generation form dynamically from template.inputSlots
 *   3. Know which models are available for each template
 *   4. Display quality-curated results
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

function getModel() {
  return mongoose.model('GenerationTemplate');
}

// GET /api/v1/templates
// Browse templates — used by gallery page and template picker
// Query params: category, contentType, outputType, locale, featured, page, limit
router.get('/', async (req, res) => {
  const {
    category,
    contentType,
    contentGroup,
    outputType,
    locale,
    featured,
    planLevel,
    sortBy = 'score',   // 'score' | 'newest' | 'popular'
    page = 1,
    limit = 20,
    cursor,             // for cursor-based pagination
  } = req.query;

  const GenerationTemplate = getModel();
  const query = { isActive: true };

  if (category)     query.bestCategories = category;
  if (contentType)  query.contentType = contentType;
  if (contentGroup) query.contentGroup = contentGroup;
  if (outputType)   query.outputType = outputType;
  if (featured === 'true') query.isFeatured = true;
  if (planLevel)    query.planLevel = { $in: ['free', planLevel] };

  if (locale === 'gulf') {
    query.locale = { $in: ['gulf', 'both'] };
  } else if (locale === 'global') {
    query.locale = { $in: ['global', 'both'] };
  }

  // Cursor-based pagination on _id for infinite scroll
  if (cursor) {
    query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
  }

  const sortMap = {
    score:   { 'engagement.finalScore': -1, isFeatured: -1 },
    newest:  { createdAt: -1 },
    popular: { 'engagement.renderCount': -1 },
  };
  const sort = sortMap[sortBy] || sortMap.score;

  const pageSize = Math.min(parseInt(limit), 50);
  const items = await GenerationTemplate.find(query
  //   , {
  //   name: 1,
  //   contentType: 1,
  //   contentGroup: 1,
  //   outputType: 1,
  //   aspectRatio: 1,
  //   defaultDuration: 1,
  //   bestCategories: 1,
  //   bestPlatforms: 1,
  //   requiresProductImage: 1,
  //   requiresAvatar: 1,
  //   planLevel: 1,
  //   isFeatured: 1,
  //   'media.coverUrl': 1,
  //   'media.previewVideo': 1,
  //   'media.previewImages': 1,
  //   'engagement.qualityTier': 1,
  //   'engagement.finalScore': 1,
  //   supportedModels: 1,
  //   locale: 1,
  //   seasonalPacks: 1,
  //   constraints: 1,
  //   hookTags: 1,
  // }
)
    .sort(sort)
    .limit(pageSize + 1)
    .lean();

  const hasMore = items.length > pageSize;
  const results = hasMore ? items.slice(0, pageSize) : items;
  const nextCursor = hasMore ? results[results.length - 1]._id.toString() : null;

  return res.json({
    success: true,
    items: results,
    nextCursor,
    hasMore,
  });
});

// GET /api/v1/templates/categories
// Returns available categories with counts — for filter UI
router.get('/categories', async (req, res) => {
  const GenerationTemplate = getModel();
  const counts = await GenerationTemplate.aggregate([
    { $match: { isActive: true } },
    { $unwind: '$bestCategories' },
    { $group: { _id: '$bestCategories', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return res.json({
    success: true,
    categories: counts.map(c => ({ category: c._id, count: c.count })),
  });
});

// GET /api/v1/templates/seasonal
// Returns templates matching current Gulf season
// The frontend can show "Ramadan Pack" prominently during Ramadan
router.get('/seasonal', async (req, res) => {
  const GenerationTemplate = getModel();

  // Determine current season
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const y = now.getFullYear();

  let currentSeason = null;
  if (y === 2026 && m === 3 && d >= 1 && d <= 30) currentSeason = 'ramadan';
  else if ((y === 2026 && m === 3 && d >= 31) || (y === 2026 && m === 4 && d <= 2)) currentSeason = 'eid_fitr';
  else if (m === 12 && (d === 2 || d === 3)) currentSeason = 'uae_national_day';
  else if (m === 9 && d === 23) currentSeason = 'ksa_national_day';

  if (!currentSeason) {
    return res.json({ success: true, season: null, items: [] });
  }

  const items = await GenerationTemplate.find({
    isActive: true,
    seasonalPacks: currentSeason,
  }, {
    name: 1, contentType: 1, 'media.coverUrl': 1, 'media.previewVideo': 1,
  })
    .sort({ 'engagement.finalScore': -1 })
    .limit(10)
    .lean();

  return res.json({ success: true, season: currentSeason, items });
});

// GET /api/v1/templates/:id
// Full template detail — used when user selects a template to see input form
router.get('/:id', async (req, res) => {
  const GenerationTemplate = getModel();

  let template;
  try {
    template = await GenerationTemplate.findById(req.params.id).lean();
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid template ID' });
  }

  if (!template) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }

  // Strip internal-only fields. `meta.originSource` would leak the upstream
  // provider (Higgsfield / Creatify) — we present every template as Qumak.
  const { meta, ...publicTemplate } = template;

  // Return full detail including inputSlots for form building.
  return res.json({ success: true, template: publicTemplate });
});

// GET /api/v1/templates/stats
// Admin endpoint — template collection health
router.get('/admin/stats', async (req, res) => {
  const GenerationTemplate = getModel();

  const [
    total, bySource, byContentType, byQualityTier,
    withArabic, withProductSlot, featured,
  ] = await Promise.all([
    GenerationTemplate.countDocuments({ isActive: true }),
    GenerationTemplate.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    GenerationTemplate.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$contentType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    GenerationTemplate.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$engagement.qualityTier', count: { $sum: 1 } } },
    ]),
    GenerationTemplate.countDocuments({ 'i18nPrompts.ar': { $ne: null } }),
    GenerationTemplate.countDocuments({ requiresProductImage: true }),
    GenerationTemplate.countDocuments({ isFeatured: true }),
  ]);

  return res.json({
    success: true,
    total,
    bySource: Object.fromEntries(bySource.map(s => [s._id, s.count])),
    byContentType: Object.fromEntries(byContentType.map(s => [s._id, s.count])),
    byQualityTier: Object.fromEntries(byQualityTier.map(s => [s._id, s.count])),
    withArabicPrompt: withArabic,
    requiresProductImage: withProductSlot,
    featured,
  });
});

module.exports = router;