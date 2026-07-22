const express = require('express');
const router = express.Router();
const popupLeadsController = require('./popupLeadsController');
const auth = require('../../middelwares/auth');

// Public routes
router.post('/', popupLeadsController.submitLead);
router.post('/update-service', popupLeadsController.updateService);

// Protected routes (admin only)
router.get('/', auth, popupLeadsController.getLeads);
router.get('/stats', auth, popupLeadsController.getStats);
router.put('/:id', auth, popupLeadsController.updateLead);
router.delete('/:id', auth, popupLeadsController.deleteLead);

module.exports = router;

