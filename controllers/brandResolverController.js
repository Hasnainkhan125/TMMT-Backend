// controllers/brandResolverController.js
const { resolveBrandIdentity } = require('../services/resolver/brandIdentityResolver');
const { scheduleScreenshotCapture, scheduleEnrichment } = require('../services/resolver/enrichment/enrichmentQueue');
const BrandIdentity = require('../model/schema/brandIdentity');
const logger = require('../utils/logger');

/**
 * POST /api/v1/brand/resolve
 * Body: { url: string, forceRefresh?: boolean }
 * 
 * Returns BrandIdentity, triggers background screenshot + enrichment.
 */
async function resolveBrand(req, res) {
  const { url, forceRefresh = false } = req.body;
  
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url_required' });
  }
  console.log('brand===============>resolveBrand', url);
  try {
    console.log('brand===============>resolveBrandIdentity', url);
      const brand = await resolveBrandIdentity(url, { 
          forceRefresh,
          capturaScreenshot: false,  // Defer to background — faster response
        });
        
        console.log('brand resolveBrandIdentity', brand);
    // Schedule background screenshot if missing
    if (!brand.assets?.screenshots?.desktop) {
      scheduleScreenshotCapture(brand._id).catch(err => 
        logger.warn({ err, brandId: brand._id }, 'failed to schedule screenshot')
      );
    }
    
    // Stale? Schedule enrichment
    const ageMs = Date.now() - (brand.resolvedAt?.getTime() || 0);
    if (ageMs > 24 * 60 * 60 * 1000) {
      scheduleEnrichment(brand._id).catch(err =>
        logger.warn({ err, brandId: brand._id }, 'failed to schedule enrichment')
      );
    }
    
    return res.json({ brand });
  } catch (err) {
    logger.error({ err, url }, 'resolveBrand failed');
    
    const statusCode = err.code === 'SSRF_BLOCKED' ? 400
      : err.code === 'INVALID_DOMAIN' ? 400
      : 500;
    
    return res.status(statusCode).json({
      error: err.code || 'resolve_failed',
      message: err.message,
    });
  }
}

/**
 * GET /api/v1/brand/:domain
 * Return an already-resolved brand identity.
 */
async function getBrand(req, res) {
  const { domain } = req.params;
  const brand = await BrandIdentity.findOne({ canonicalDomain: domain.toLowerCase() });
  
  if (!brand) return res.status(404).json({ error: 'not_found' });
  
  return res.json({ brand });
}

module.exports = { resolveBrand, getBrand };