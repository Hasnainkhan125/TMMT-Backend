const express = require('express');
const router = express.Router();
const auth = require('../middelwares/auth');
const { requireRole } = require('../middelwares/auth');
const ctrl = require('../controllers/brandProject/brandProjectController');

const requireAdmin = [auth, requireRole('admin', 'superadmin')];

// All routes require authentication
router.use(auth);

// Admin routes (must be before /:id to avoid conflicts)
router.get('/admin/all',     requireAdmin, ctrl.adminGetAll);
router.patch('/admin/:id',   requireAdmin, ctrl.adminUpdateProject);
router.post('/admin/credits/grant', requireAdmin, ctrl.adminGrantCredits);

// Credits — Stripe (card, AED) + Tabby + Tamara (BNPL, AED)
router.get('/credits/balance',     ctrl.getCreditsBalance);
router.get('/credits/packages',    ctrl.getCreditPackages);
router.get('/credits',             ctrl.getCredits);
router.post('/credits/buy',        ctrl.buyCredits);        // Stripe Checkout (card)
router.post('/credits/buy/tabby',  ctrl.buyCreditsTabby);   // Tabby BNPL
router.post('/credits/buy/tamara', ctrl.buyCreditsTamara);  // Tamara BNPL
router.post('/credits/confirm',    ctrl.confirmCredits);    // verifies Stripe session

// Projects CRUD
router.post('/',             ctrl.createProject);
router.get('/',              ctrl.listProjects);
router.get('/:id',           ctrl.getProject);
router.put('/:id',           ctrl.updateProject);
router.delete('/:id',        ctrl.archiveProject);

// Generation
router.post('/:id/generate-asset',  ctrl.generateAsset);
router.post('/:id/generate-video',  ctrl.generateAdVideo);
router.post('/:id/send-quotation',  ctrl.sendQuotation);

module.exports = router;
