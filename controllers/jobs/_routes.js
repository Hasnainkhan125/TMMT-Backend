const express = require('express');
const router = express.Router();
const jobController = require('./jobController');
const auth = require('../../middelwares/auth');
const { requireRole } = require('../../middelwares/auth');

// ==================== PUBLIC ROUTES ====================
router.get('/', jobController.getJobs);
router.get('/categories/stats', jobController.getCategoryStats);
router.get('/:id', jobController.getJobById);

// ==================== AUTHENTICATED ROUTES (logged-in users) ====================
router.post('/apply', auth, jobController.applyToJob);
router.post('/', auth, jobController.applyToJob);
router.get('/user/my-applications', auth, jobController.getMyApplications);
router.post('/pay-later/:applicationId', auth, jobController.completePayLaterPayment);

// ==================== ADMIN ROUTES (amer officers / admins) ====================
router.post('/admin/create', auth, jobController.createJob);
router.patch('/admin/:id', auth, jobController.updateJob);
router.delete('/admin/:id', auth, jobController.deactivateJob);
router.delete('/admin/:id/delete', auth, jobController.deleteJob);
router.get('/admin/all', auth, jobController.getAllJobsAdmin);
router.get('/admin/statistics', auth, jobController.getJobStatistics);
router.get('/admin/applications/:jobId', auth, jobController.getJobApplications);
router.get('/applications/all', auth, jobController.getJobApplications);
router.patch('/admin/applications/:applicationId/status', auth, jobController.updateApplicationStatus);
router.delete('/admin/applications/:applicationId', auth, jobController.deleteJobApplication);

module.exports = router;

