'use strict';

/**
 * Studio router — URL → Ads journey (test / smoke targets):
 *
 * | Step    | Method | Path                               | Notes                          |
 * |---------|--------|------------------------------------|--------------------------------|
 * | Scan    | POST   | /studio/url-to-ads/scan            | body: { url }                  |
 * | List    | GET    | /studio/url-to-ads/scans           | session / auth                 |
 * | Get     | GET    | /studio/url-to-ads/scan/:id        |                                |
 * | Generate| POST   | /studio/url-to-ads/scan/:id/generate | optional body              |
 * | Archive | DELETE | /studio/url-to-ads/scan/:id        |                                |
 * | Image   | POST   | /studio/generate/image             | Idempotency-Key supported      |
 * | Video   | POST   | /studio/generate/video             | Idempotency-Key supported      |
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const router = express.Router();
const ctrl = require('./studioController');
const adminCtrl = require('./adminStudioController');
const uploadCtrl = require('./uploadController');
const { upload: s3Upload } = require('../../middleware/s3Upload');
const auth = require('../../middelwares/auth');
const { optionalAuth } = require('../../middelwares/auth');
const { ensureStudioIdentity } = require('../../middelwares/studioIdentity');
const { getRedis } = require('../../services/redis');
const { generateCreativeFromStudio } = require('../../services/generateCreativeFromStudio');
const { generateSingleAd } = require('../../services/urlToAdsService');
const { generateVideoAdController } = require('../studio/urlToAdsController');
// Soft-auth on every studio route — anonymous callers still work
// (sessionId fallback) but logged-in users get `req.user` populated for
// ownership + history queries on /jobs and /assets.
router.use(optionalAuth);
router.use(ensureStudioIdentity);

const limiterHandler = (req, res) =>
  res.status(429).json({
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many generation requests. Please wait before trying again.',
  });

function buildGenerateLimiter() {
  const windowMs = 60 * 60 * 1000;
  const max = 25;
  const base = {
    windowMs,
    max,
    keyGenerator: (req) =>
      (req.user?._id ? `user:${req.user._id}` : null) ||
      req.cookies?.qumak_session ||
      req.headers['x-session-id'] ||
      req.ip,
    handler: limiterHandler,
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (process.env.STUDIO_RATE_LIMIT_REDIS === '0') {
    return rateLimit(base);
  }
  try {
    const client = getRedis();
    return rateLimit({
      ...base,
      store: new RedisStore({
        sendCommand: (command, ...args) => client.call(command, ...args),
      }),
    });
  } catch (err) {
    console.warn('[studio _routes] Redis rate-limit store unavailable, using memory', err.message);
    return rateLimit(base);
  }
}

const generateLimiter = buildGenerateLimiter();
// Multi-layer rate limiting
// const generateLimiter = rateLimit({
//   windowMs: 60 * 60 * 1000,
//   max: (req) => {
//     if (req.user?.plan === 'agency') return 500;
//     if (req.user?.plan === 'growth') return 200;
//     if (req.user?.plan === 'pro') return 100;
//     if (req.user?._id) return 25;
//     return 5; // anonymous — MUCH lower than 25
//   },
//   keyGenerator: (req) => {
//     // Authenticated users: key by userId (can't bypass by clearing cookies)
//     if (req.user?._id) return `user:${req.user._id}`;
//     // Anonymous: key by IP + session + user-agent fingerprint (harder to spoof)
//     const fp = crypto.createHash('sha256')
//       .update(`${req.ip}|${req.cookies?.qumak_session}|${req.headers['user-agent']}`)
//       .digest('hex');
//     return `anon:${fp}`;
//   },
//   // store: getRedisClient(), // CURRENTLY IN-MEMORY — breaks across multiple Node instances
// });
// const getRedisClient = () => {
//   return getRedis();
// };
// const ipHardLimit = rateLimit({ max: 50, windowMs: 3600000, keyGenerator: req => req.ip });

// + Add Cloudflare Turnstile / hCaptcha on anonymous generation
// + Add cost-based limiting: daily spend ceiling per anonymous session

// Public routes (anonymous + session-based ownership checks inside controller)
router.post('/generate', generateLimiter, ctrl.createGeneration);
router.post('/generate/video', ctrl.createVideoGeneration);
router.post('/generate/image', generateLimiter, ctrl.createImageGeneration);
router.post('/enhance-image', generateLimiter, ctrl.enhanceImage);

// URL → Ad: scrape a website and return brand kit + 3 free ad blueprints.
// This endpoint is read-only (no credits charged) — the user picks a card
// and the actual generation flows through /generate/image with a billing
// charge attached.
const urlToAdCtrl = require('./urlToAdController');
router.post('/url-to-ad/scan',generateLimiter, urlToAdCtrl.scan);
// router.post('/url-to-ad/meta-scan',generateLimiter, urlToAdCtrl.metaScan);
router.get('/url-to-ad/meta-scan',generateLimiter, urlToAdCtrl.metaScan);
router.get('/url-to-ad/meta-scan/:id',generateLimiter, urlToAdCtrl.metaScanById);

// URL → Ads (Phase 7) — persistent "scan report" used by the dedicated
// /studio/url-to-ads page. Scrapes the site once, caches brand kit +
// competitors + copy + 3 free ad blueprints as a UrlToAdsScan document,
// and lets the user hit "generate all 3" to fan out into an adSet render.
const urlToAdsCtrl = require('./urlToAdsController');
router.post  ('/url-to-ads/scan',                 generateLimiter, urlToAdsCtrl.scan);
router.get   ('/url-to-ads/scans',                                 urlToAdsCtrl.list);
router.get   ('/url-to-ads/scan/:id',                              urlToAdsCtrl.getById);
router.post  ('/url-to-ads/scan/:id/generate',    generateLimiter, urlToAdsCtrl.generate);
router.post  ('/url-to-ads/scan/:id/generate-products', generateLimiter, urlToAdsCtrl.generatePerProduct);
router.post  ('/url-to-ads/scan/:id/confirm', generateLimiter, urlToAdsCtrl.confirmBrand);
router.post  ('/url-to-ads/scan/:id/refresh-library', generateLimiter, urlToAdsCtrl.refreshCompetitorAds);
// controller
router.post('/url-to-ads/scan/:id/ad',generateLimiter, async (req, res) => {
  try {
    const { kind, modelId, prompt, label, aspectRatio, referenceImageUrl, creativeStyleHint, sourceCompetitor } = req.body;
    const out = await generateSingleAd({
      scanId: req.params.id, req, kind, modelId, prompt, label,
      aspectRatio, referenceImageUrl, creativeStyleHint, sourceCompetitor,
    });
    res.json({ success: true, scan: out.scan });
  } catch (e) {
    res.status(e.code === 'forbidden' ? 403 : 400).json({ success: false, message: e.message });
  }
});
router.post('/url-to-ads/scan/:id/generate-video',generateLimiter,generateVideoAdController);


router.post('/url-to-ads/scan/:id/generate-creative', async (req, res) => {
  try {
    const { scan, adSetId, childJobIds, totalCreditsCost } =
      await generateCreativeFromStudio({
        req,
        body: { ...req.body, scanId: req.params.id },
      });

    return res.json({
      success: true,
      scan,
      adSetId,
      childJobIds,
      creditsCharged: totalCreditsCost,
    });
  } catch (err) {
    const status =
      err.code === 'not_found' ? 404
      : err.code === 'forbidden' ? 403
      : err.code === 'scan_not_ready' ? 409
      : err.code === 'insufficient_credits' ? 402
      : err.code === 'reference_cap_exceeded' || err.code === 'ref_url_blocked' ? 400
      : err.name === 'ZodError' ? 400
      : 500;

    if (status === 500) {
      console.error('[urlToAds] generate-creative error:', err);
    }

    return res.status(status).json({
      success: false,
      error: err.code || (err.name === 'ZodError' ? 'validation_error' : 'server_error'),
      message: err.message,
      ...(err.code === 'insufficient_credits'
        ? { required: err.required, balance: err.balance }
        : {}),
      ...(err.name === 'ZodError' ? { issues: err.issues } : {}),
    });
  }
});
router.patch ('/url-to-ads/scan/:id/digest',                        urlToAdsCtrl.patchDigest);
router.delete('/url-to-ads/scan/:id',                              urlToAdsCtrl.archive);
router.post('/url-to-ads/scan/:id/refresh-library', generateLimiter, urlToAdsCtrl.refreshCompetitorAds);

// Ad Spec (editable blueprint before generation)
const adSpecCtrl = require('./adSpecController');
router.post('/url-to-ads/scan/:id/spec/teardown',                generateLimiter, adSpecCtrl.teardown);
router.post('/url-to-ads/scan/:id/spec',                         generateLimiter, adSpecCtrl.createFromScan);
router.put ('/url-to-ads/scan/:id/spec/:specId',                                  adSpecCtrl.update);
router.post('/url-to-ads/scan/:id/spec/:specId/regenerate-copy',                  adSpecCtrl.regenCopy);
router.post('/url-to-ads/scan/:id/spec/:specId/confirm',         generateLimiter, adSpecCtrl.confirm);






// Meta Marketing API — OAuth + deploy (Phase 1: connect flow; full automation gated on app review).
const metaOAuthCtrl = require('./metaOAuthController');
router.get('/meta/connect',    metaOAuthCtrl.connect);
router.get('/meta/callback',   metaOAuthCtrl.callback);

// Scene Builder (Phase 4) — multi-clip reel rendering. Parent StudioJob
// aggregates N child scene jobs. See services/reelService.js.
const reelCtrl = require('./reelController');
router.post('/reel/estimate', reelCtrl.estimate);
router.post('/reel/enqueue',  generateLimiter, reelCtrl.enqueue);
router.get('/reel/:id',       reelCtrl.get);

// Ads Pipeline (Phase 5) — 3-5 creative variants from one brief, with
// optional async copy generation on the parent. Same parent/child shape
// as reels so History and the assets pipeline "just work".
const adSetCtrl = require('./adSetController');
router.post('/ads/estimate', adSetCtrl.estimate);
router.post('/ads/enqueue',  generateLimiter, adSetCtrl.enqueue);
router.get('/ads/:id',       adSetCtrl.get);

// Avatar / Character / AI-Influencer builder (Phase 6).
//
// Legacy: /influencer/generate — one-off face render (no persona persisted).
//
// Persona system: the identity survives across multiple scenes. Saving a
// persona renders a canonical "hero" face; future scenes re-use the hero
// URL as a reference image against identity-preserving models
// (flux_kontext_pro, seedream_v45_edit, nano_banana_*_edit) so "Layla at
// Marina" actually looks like Layla. Scene fan-outs (numVariants > 1)
// reuse the Phase-5 adSetService so the variant grid UI "just works".
const influencerCtrl = require('./influencerController');
router.post('/influencer/generate', generateLimiter, influencerCtrl.generate);
router.post  ('/influencer/persona',                   generateLimiter, influencerCtrl.createPersona);
router.get   ('/influencer/personas',                                   influencerCtrl.listPersonas);
router.get   ('/influencer/persona/:id',                                influencerCtrl.getPersona);
router.post  ('/influencer/persona/:id/scene',         generateLimiter, influencerCtrl.generateScene);
router.post  ('/influencer/persona/:id/finalize',                       influencerCtrl.finalizeHero);
router.delete('/influencer/persona/:id',                                influencerCtrl.archivePersona);
router.post('/preview-prompt', ctrl.previewPrompt);
// Free, non-charging endpoint that runs the same intelligence layer the
// generator uses, so users can preview / iterate on their prompt before
// spending credits.
router.post('/enhance-prompt', ctrl.enhancePromptPreview);
router.post('/track', ctrl.trackEvent);
router.get('/categories', ctrl.getCategories);
router.get('/jobs', ctrl.getUserJobs);
router.get('/assets', ctrl.getUserAssets);
router.get('/job/:id', ctrl.getJobStatus);
router.delete('/job/:id', ctrl.cancelJob);
router.post('/jobs/:id/cancel', ctrl.cancelJobAndRefund);



// Reference / start-frame / end-frame / character image uploads.
// Use ?purpose=reference|start-frame|end-frame|character to control folder.
router.post(
  '/upload/reference',
  uploadCtrl.setFolder,
  ...s3Upload.single('file'),
  uploadCtrl.uploadReference
);

// Templates catalog — reads from data/manifest.json,
// scripts/creatify_templates.json, scripts/topview_templates.json.
// Cheap, cached, no DB. Fuels Lipsync / UGC Factory / Vibe Motion grids.
const templatesCtrl = require('./templatesController');
router.get('/templates/ugc',                         templatesCtrl.ugc);
router.get('/templates/product',                     templatesCtrl.product);
router.get('/templates/seedance',                    templatesCtrl.seedance);
router.get('/templates/vibe-motion',                 templatesCtrl.vibeMotion);
router.get('/templates/vibe-motion/:preset',         templatesCtrl.vibeMotionTiles);
router.get('/templates/lipsync-portraits',           templatesCtrl.lipsyncPortraits);
router.get('/templates/:id',                         templatesCtrl.byId);

// Lipsync Studio — real, Fal-backed lipsync pipeline.
// Catalog is public (no auth); TTS + generate go through the standard
// rate limiter since they spend credits / upstream quota.
const lipsyncCtrl = require('./lipsyncController');
router.get ('/lipsync/catalog',                                 lipsyncCtrl.catalog);
router.post('/lipsync/tts',          generateLimiter,           lipsyncCtrl.tts);
router.post('/lipsync/generate',     generateLimiter,           lipsyncCtrl.generate);

// UGC Factory — spokesperson UGC clips from templates + user inputs.
const ugcCtrl = require('./ugcController');
router.post('/ugc/generate',         generateLimiter,           ugcCtrl.generate);

// Vibe Motion — Infographics / Text Animation / Posters /
// Presentation / From scratch text→video (and image→video where
// required). Uses manifest.json tiles as visual seeds.
const vibeMotionCtrl = require('./vibeMotionController');
router.post('/vibe-motion/generate', generateLimiter,           vibeMotionCtrl.generate);

// Brand profiles (saved brand identities)
const brandProfileCtrl = require('./brandProfileController');
router.get('/brand-profiles',         brandProfileCtrl.list);
router.post('/brand-profiles',        brandProfileCtrl.create);
router.put('/brand-profiles/:id',     brandProfileCtrl.update);
router.delete('/brand-profiles/:id',  brandProfileCtrl.remove);

// WhatsApp delivery — Gulf-native sign-off step
const whatsappDeliveryCtrl = require('./whatsappDeliveryController');
router.post('/asset/:id/whatsapp', whatsappDeliveryCtrl.sendAsset);

// 60-second public demo: paste IG handle → 10 Arabic+English ads → WhatsApp send
const demoFlowCtrl = require('./demoFlowController');
router.post('/demo',              demoFlowCtrl.demoLimiter, demoFlowCtrl.startDemo);
router.get('/demo/:id/status',    demoFlowCtrl.getDemoStatus);

// Admin routes — require JWT auth + admin role
const { requireRole } = require('../../middelwares/auth');
router.get('/admin/stats', auth, requireRole('admin', 'superadmin'), adminCtrl.getDashboardStats);

module.exports = router;
