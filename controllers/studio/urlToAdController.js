'use strict';

/**
 * urlToAdController — paste a URL → get a real brand research report +
 * 3 ready-to-render ad blueprints, powered by a SINGLE Anthropic call.
 *
 *   POST /api/v1/studio/url-to-ad/scan { url }
 *     → { brand, audience, competitors, competitorAds, ads }
 *
 * v2 changes (2026-04 rewrite):
 *   • competitorSeeds.js hardcoded buckets are GONE. Competitors and
 *     audience are inferred by Claude from the actual page snapshot.
 *   • targetAudience is a full research object (primary, secondary, JTBD,
 *     pain points, watering holes) — not a canned one-liner.
 *   • Hooks / headlines / aspect ratios / model hints all come from the
 *     same Claude call so the 3 "free" blueprints feel tailored instead
 *     of generic.
 *   • Still FREE to call (no credits) — charging only happens when the
 *     user picks a card and /generate/image runs.
 */

const { scrapeUrl }   = require('../../services/urlScraper');
const { researchBrand } = require('../../services/aiResearch');
const adBrain          = require('../../services/adBrain');
const { fetchViaApify } = require('../../services/scraper/metaAdLibrary');
const { normalizeApifyAd } = require('../../services/scraper/metaAdLibrary');
// Simple in-memory per-process LRU so retries within a single server
// instance don't re-call Claude. TTL 30m, cap 200 entries.
const _cache = new Map(); // key -> { value, expiresAt }
const _CACHE_TTL_MS = 30 * 60 * 1000;
const _CACHE_MAX = 200;

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { _cache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + _CACHE_TTL_MS });
  if (_cache.size > _CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function pickAspectForIndex(i, hook) {
  const preferred = hook?.aspectRatio;
  if (preferred) return preferred;
  return ['1:1', '9:16', '4:5'][i] || '1:1';
}

function effectiveCategory(research, scrape) {
  if (research?._source === 'fallback' && scrape?.category) return scrape.category;
  return research?.brand?.category || scrape?.category || 'general';
}

function buildBlueprint({ scrape, research, hook, index }) {
  const brand = research?.brand?.name || scrape.brandName;
  const audience =
    research?.targetAudience?.primary ||
    'modern buyers ready to discover a brand that fits their life';
  const vibe = hook?.vibe || 'cinematic';
  const aspectRatio = pickAspectForIndex(index, hook);
  const category = effectiveCategory(research, scrape);

  const description = hook?.body
    || research?.brand?.summary
    || scrape.description
    || scrape.paragraphs?.[0]
    || `${brand}, premium product`;

  const headline = hook?.headline || `Meet ${brand}.`;

  const built = adBrain.buildAdPrompt({
    brandName:      brand,
    description:    `${headline} ${description}`.slice(0, 800),
    targetAudience: audience,
    category,
    vibe,
    locale:         'gulf',
    aspectRatio,
  });

  return {
    label:             hook?.label
      || hook?.headline?.slice(0, 42)
      || ['Hero shot', 'Social-first', 'Conversion CTA'][index]
      || 'Ad',
    headline,
    hookLine:          headline,
    body:              hook?.body || '',
    cta:               hook?.cta  || 'Discover',
    aspectRatio,
    vibe,
    category,
    prompt:            built.finalPrompt,
    negativePrompt:    built.negativePrompt,
    modelId:           hook?.modelHint || 'flux_pro',
    referenceImageUrl: scrape.images?.[0] || null,
  };
}

async function metaScan(req, res) {
  const brandName = (req.body?.brandName || '').trim();

  try{

    const items = await fetchViaApify({
      brandName: brandName,
      country: 'US',
      pageId: null,
      limit: 10,
    });
    return res.json({
      success: true,
      items: items.map(normalizeApifyAd),
    });
  }catch(err){
    console.log(err,"this is err")
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

async function metaScanById(req, res) {
  const id = (req.params?.id || '').trim();

  try{

    const items = await fetchViaApify({
      brandName: "Noon",
      country: 'AE',
      pageId: null,
      limit: 10,
    });
    return res.json({
      success: true,
      items: items.map(normalizeApifyAd),
    });
  }catch(err){
    console.log(err,"this is err")
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

async function scan(req, res) {
  const url = (req.body?.url || '').trim();
  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'invalid_url',
      message: 'A URL is required.',
    });
  }

  // Scrape (raw HTML captured inside scrape.rawHtml for aiResearch).
  let scrape;
  try {
    scrape = await scrapeUrl(url);
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: err.code || 'scrape_failed',
      message: err.message || 'We could not reach that website right now.',
    });
  }
  // Anthropic research (cached).
  const cacheKey = scrape.url.toLowerCase();
  let research = cacheGet(cacheKey);
  if (!research) {
    try {
      research = await researchBrand({
        url: scrape.url,
        html: scrape.rawHtml,
        scrape,
      });
      cacheSet(cacheKey, research);
    } catch (err) {
      console.warn('[urlToAdController] researchBrand failed:', err.message);
      // researchBrand already returns a deterministic fallback if Claude
      // fails, so this should rarely hit — keep it defensive anyway.
      research = {
        brand: { name: scrape.brandName },
        targetAudience: {},
        competitors: [],
        competitorAds: [],
        hooks: [],
        _source: 'error',
      };
    }
  }

  // Always three blueprints — pad with nulls when Claude returns fewer hooks.
  const fromHooks = Array.isArray(research.hooks) ? research.hooks.slice(0, 3) : [];
  const hooks = [0, 1, 2].map((i) => fromHooks[i] ?? null);
  // const ads = hooks.map((hook, index) =>
  //   buildBlueprint({ scrape, research, hook, index })
  // );
  const ads = [];

  return res.json({
    success: true,
    brand: {
    
      name:        research.brand?.name        || scrape.brandName,
      siteName:    scrape.siteName,
      url:         scrape.url,
      host:        scrape.host,
      title:       scrape.title,
      description: research.brand?.summary     || scrape.description,
      headlines:   scrape.headlines,
      paragraphs:  (scrape.paragraphs || []).slice(0, 4),
      images:      scrape.images,
      favicon:     scrape.favicon,
      category:
        research?._source === 'fallback' && scrape?.category
          ? scrape.category
          : (research.brand?.category || scrape.category || 'general'),
      audience:    research.targetAudience?.primary || '',
    
      oneLiner:    research.brand?.oneLiner    || '',
      summary:     research.brand?.summary     || '',
      subcategory: research.brand?.subcategory || '',
      vibe:        research.brand?.vibe        || '',
      keywords:    research.brand?.keywords    || [],
      valueProps:  research.brand?.valueProps  || [],
      tone:        research.brand?.tone        || '',
      palette:     research.brand?.palette     || [],
    },
    audience:      research.targetAudience  || {},
    competitors:   research.competitors     || [],
    competitorAds: research.competitorAds   || [],
    hooks:         research.hooks           || [],
    ads,
    source:        research._source         || 'unknown',
  });
}

module.exports = { scan, metaScan, metaScanById };
