/**
 * leadsRoutes.js — Express router for the Leads Engine
 *
 * Webhook route is public (no auth).
 * All other routes require authentication.
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../../middelwares/auth');
const ctrl    = require('./leadsController');

// Public: webhook (no auth required)
router.post('/webhook/resend', ctrl.handleResendWebhook);

// All routes below require authentication
router.use(auth);

router.post('/:brandId/find',                     ctrl.findLeads);
router.get('/:brandId/stats',                     ctrl.getStats);
router.get('/:brandId',                           ctrl.getLeads);
router.post('/:brandId/generate-batch-messages',  ctrl.generateBatchMessages);
router.post('/:brandId/send-batch',               ctrl.sendBatch);
router.post('/:brandId/:leadId/messages',         ctrl.generateMessage);
router.patch('/:brandId/:leadId/messages/:messageIndex', ctrl.updateMessage);
router.post('/:brandId/:leadId/send',             ctrl.sendEmail);
router.patch('/:brandId/:leadId/stage',           ctrl.updateLeadStage);
router.delete('/:brandId/:leadId',                ctrl.deleteLead);

module.exports = router;
