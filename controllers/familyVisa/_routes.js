const express = require('express');
const router = express.Router();
const familyVisaController = require('./familyVisaController');
const auth = require('../../middelwares/auth');

// Public routes (no authentication required)
router.get('/requirements', familyVisaController.getSalaryRequirements);
router.post('/check-eligibility', familyVisaController.checkEligibility);

// Protected routes (admin only)
router.get('/leads', auth, familyVisaController.getLeads);
router.get('/leads/statistics', auth, familyVisaController.getStatistics);
router.get('/leads/:id', auth, familyVisaController.getLead);
router.patch('/leads/:id', auth, familyVisaController.updateLead);
router.put('/leads/:id', auth, familyVisaController.updateLead);
router.delete('/leads/:id', auth, familyVisaController.deleteLead);

module.exports = router;

