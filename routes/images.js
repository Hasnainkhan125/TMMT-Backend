const express = require('express');
const router = express.Router();
const auth = require('../middelwares/auth');
const imagePromptPurifier = require('../services/imagePromptPurifier');
const tokenMeter = require('../services/tokenMeter');
const BrandProject = require('../model/schema/brandProject');

// Optional auth (allows public generation with limited quota)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers['x-access-token'];
  if (!authHeader) return next();
  try {
    auth(req, res, next);
  } catch (_) {
    next();
  }
};

function buildBrandContext(brand) {
  const cfg = brand.config?.brand || {};
  return {
    brandId: brand._id,
    brandName: cfg.brandName || brand.projectName,
    category: brand.businessType,
    tone: (cfg.brandVoice || [])[0] || 'luxury',
    colorPalette: cfg.colorPalette,
    positioning: cfg.positioning,
    targetPersona: cfg.customerPersona,
    pricePoint: brand.fragranceConfig?.pricePoint || brand.skincareConfig?.priceTier,
    fragranceFamily: brand.fragranceConfig?.family || brand.fragranceConfig?.fragranceFamily,
    inputs: brand.fragranceConfig || brand.skincareConfig || brand.config?.inputs || {},
    skinConcerns: brand.skincareConfig?.targetConcern || brand.skincareConfig?.skinConcerns,
    packagingStyle: brand.skincareConfig?.packagingStyle,
    keyIngredients: brand.skincareConfig?.keyIngredients,
    bottleShape: brand.fragranceConfig?.bottleShape || brand.packaging?.bottleShape,
    bottleMaterial: brand.fragranceConfig?.bottleMaterial || brand.packaging?.bottleMaterial,
    capStyle: brand.fragranceConfig?.capStyle || brand.packaging?.capStyle,
    labelFinish: brand.fragranceConfig?.labelFinish || brand.packaging?.labelFinish,
    outerBox: brand.fragranceConfig?.outerBox || brand.packaging?.packagingType,
    boxExterior: brand.fragranceConfig?.boxExterior,
  };
}

// POST /api/v1/images/generate
router.post('/generate', optionalAuth, async (req, res) => {
  try {
    const { brandId, imageType } = req.body;
    if (!brandId || !imageType) {
      return res.status(400).json({ success: false, message: 'brandId and imageType required' });
    }

    const brand = await BrandProject.findById(brandId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const userId = req.user?._id;
    if (userId) {
      const plan = req.user?.plan || 'trial';
      const { allowed, reason } = await tokenMeter.checkCanGenerate(userId, plan, 'image_generation');
      if (!allowed) {
        return res.status(429).json({
          success: false,
          message: reason === 'image_limit_reached'
            ? `You've used all ${tokenMeter.PLAN_LIMITS[plan].imagesPerMonth} image generations this month. Upgrade for more.`
            : 'Monthly AI credits exhausted. Upgrade to continue.',
          upgradeUrl: '/pricing',
          reason,
        });
      }
    }

    const brandContext = buildBrandContext(brand);
    res.setTimeout(120000);

    const result = await imagePromptPurifier.generateBrandImage(brandContext, imageType, userId);

    let imageUrl = result.url;
    if (result.base64) {
      imageUrl = `data:image/webp;base64,${result.base64}`;
    }

    await BrandProject.findByIdAndUpdate(brand._id, {
      $push: {
        generatedAssets: {
          type: imageType === 'heroBottle' ? 'mockup' : imageType === 'logo' ? 'logo' : 'mockup',
          url: imageUrl?.startsWith('data:') ? '(base64-stored)' : imageUrl,
          prompt: result.purifiedPrompt?.substring(0, 500),
          generatedAt: new Date(),
          status: 'ready',
        },
      },
    });

    return res.json({
      success: true,
      url: imageUrl,
      model: result.model,
      imageType,
    });
  } catch (err) {
    console.error('[images/generate]', err.message);

    if (err.message?.includes('content_policy') || err.message?.includes('safety')) {
      return res.status(400).json({
        success: false,
        message: 'Image was blocked by safety filter. Try adjusting your brand description.',
      });
    }

    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/images/generate-set — Batch generate all 4 mockup types
router.post('/generate-set', optionalAuth, async (req, res) => {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ success: false, message: 'brandId required' });

    const brand = await BrandProject.findById(brandId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const brandContext = buildBrandContext(brand);
    const userId = req.user?._id;
    res.setTimeout(300000);

    const results = await imagePromptPurifier.generateMockupSet(brandContext, userId);

    const formatted = {};
    for (const [type, result] of Object.entries(results)) {
      if (result.error) {
        formatted[type] = { error: result.error };
        continue;
      }
      let url = result.url;
      if (result.base64) url = `data:image/webp;base64,${result.base64}`;
      formatted[type] = { url, model: result.model };
    }

    return res.json({ success: true, images: formatted });
  } catch (err) {
    console.error('[images/generate-set]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/images/generate-logo
router.post('/generate-logo', optionalAuth, async (req, res) => {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ success: false, message: 'brandId required' });

    const brand = await BrandProject.findById(brandId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const brandContext = buildBrandContext(brand);
    const userId = req.user?._id;
    res.setTimeout(120000);

    const result = await imagePromptPurifier.generateLogoImage(brandContext, userId);

    let imageUrl = result.url;
    if (result.base64) imageUrl = `data:image/webp;base64,${result.base64}`;

    await BrandProject.findByIdAndUpdate(brand._id, {
      $push: {
        generatedAssets: {
          type: 'logo',
          url: '(logo-generated)',
          prompt: result.purifiedPrompt?.substring(0, 500),
          generatedAt: new Date(),
          status: 'ready',
        },
      },
    });

    return res.json({ success: true, url: imageUrl, model: result.model, imageType: 'logo' });
  } catch (err) {
    console.error('[images/generate-logo]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/images/usage — Token & image usage stats
router.get('/usage', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.json({
        success: true,
        stats: {
          plan: 'trial',
          tokensUsed: 0, tokensLimit: 50000, tokensPercent: 0, tokensRemaining: 50000,
          imagesUsed: 0, imagesLimit: 5, imagesPercent: 0,
          totalCostUSD: 0, resetDate: new Date().toISOString(), breakdown: [],
        },
      });
    }
    const plan = req.user?.plan || 'trial';
    const stats = await tokenMeter.getUserStats(userId, plan);
    return res.json({ success: true, stats });
  } catch (err) {
    console.error('[images/usage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
