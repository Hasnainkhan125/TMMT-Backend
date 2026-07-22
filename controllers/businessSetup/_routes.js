const express = require('express');
const router = express.Router();
const businessSetupController = require('./businessSetupController');
const auth = require('../../middelwares/auth');

// Public routes (no authentication required)
router.get('/activities', businessSetupController.getBusinessActivities);
router.get('/freezones', businessSetupController.getFreezones);
router.post('/calculate', businessSetupController.calculateCost);
router.post('/submit', businessSetupController.submitLead);
router.post('/lite-lead', businessSetupController.submitLiteLead);

// Protected routes (admin only)
router.get('/leads', auth, businessSetupController.getLeads);
router.get('/leads/statistics', auth, businessSetupController.getStatistics);
router.get('/leads/:id', auth, businessSetupController.getLead);
router.patch('/leads/:id', auth, businessSetupController.updateLead);

module.exports = router;

