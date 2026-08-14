/**
 * Store & Product Routes
 * Mounted at: /api/v1/store
 *
 * Public:
 *   GET  /public/:slug              — public store page (products + info)
 *
 * Protected (auth required):
 *   GET  /me/dashboard              — my store + products + stats
 *   GET  /me                        — get my store info
 *   POST /me                        — create / update store (with image uploads)
 *   POST /me/publish                — toggle publish
 *
 *   GET  /me/products               — list my products
 *   POST /me/products               — create product (with image uploads)
 *   GET  /me/products/:id           — get single product
 *   PATCH /me/products/:id          — update product
 *   DELETE /me/products/:id         — delete product
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../../middelwares/auth');
const storeCtrl   = require('./storeController');
const productCtrl = require('./productController');
const { upload: s3Upload } = require('../../middleware/s3Upload');

// Set upload folder for store assets
const storeFolder   = (req, _res, next) => { req.uploadFolder = 'store-assets'; next(); };
const productFolder = (req, _res, next) => { req.uploadFolder = 'product-images'; next(); };

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/public/:slug', storeCtrl.getPublicStore);

// ── Protected — Store ─────────────────────────────────────────────────────────
router.get('/me/dashboard', auth, storeCtrl.getStoreDashboard);
router.get('/me',           auth, storeCtrl.getMyStore);
router.post('/me',          auth, storeFolder, s3Upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'coverImage',   maxCount: 1 },
]), storeCtrl.upsertStore);
router.post('/me/publish',  auth, storeCtrl.publishStore);

// ── Protected — Products ──────────────────────────────────────────────────────
router.get('/me/products',           auth, productCtrl.listMyProducts);
router.post('/me/products',          auth, productFolder, s3Upload.array('images', 8), productCtrl.createProduct);
router.get('/me/products/:id/nas-leads', auth, productCtrl.getNasLeadsForProduct);
router.get('/me/products/:id',       auth, productCtrl.getProduct);
router.patch('/me/products/:id',     auth, productFolder, s3Upload.array('images', 8), productCtrl.updateProduct);
router.delete('/me/products/:id',    auth, productCtrl.deleteProduct);

// ── AI Marketing ──────────────────────────────────────────────────────────────
router.post('/me/ai/product-content', auth, storeCtrl.generateProductContent);
router.post('/me/ai/product-image',   auth, storeCtrl.generateProductImagePrompt);

// ── Brand → Store Launch ──────────────────────────────────────────────────
router.post('/launch-from-brand', auth, storeCtrl.launchStoreFromBrand);

module.exports = router;
