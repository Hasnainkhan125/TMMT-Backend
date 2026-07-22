const express = require('express');
const router = express.Router();
const visaApplicationController = require('./visaApplicationController');
const auth = require('../../middelwares/auth');
// const { auth } = require('../../middelwares/auth');

// Protect all routes
router.use(auth);

// Officer/admin collection routes FIRST (avoid ":applicationId" conflicts)
router.get('/applications', auth.requireRole('amer', 'admin'), visaApplicationController.getAllApplications);
router.get('/stats', auth.requireRole('amer', 'admin'), visaApplicationController.getStats);
router.get('/applications/:email', visaApplicationController.getApplicationsByUserId);
router.get('/applications/user/:userId', visaApplicationController.getApplicationsByUserObjectId);
// Aliases to match frontend hook conventions
router.put('/applications/:applicationId/status', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationStatus);
router.post('/applications/:applicationId/fraud-alert', auth.requireRole('amer', 'admin'), visaApplicationController.addFraudAlert);
router.post('/applications/:applicationId/penalty', auth.requireRole('amer', 'admin'), visaApplicationController.issuePenalty);
router.post('/applications/:applicationId/stage', auth.requireRole('amer', 'admin'), visaApplicationController.setGovStage);
router.patch('/applications/:applicationId/details', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationDetails);

// Routes accessible by all authenticated users
router.post('/',auth, visaApplicationController.createApplication);
router.get('/my-applications', visaApplicationController.getMyApplications);
// Amer: request additional documents (must come before /:applicationId)
router.post('/:applicationId/request-documents', auth.requireRole('amer', 'admin'), visaApplicationController.requestDocuments);
router.post('/:applicationId/result-documents', auth.requireRole('amer', 'admin'), visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadResultDocuments);
router.post('/:applicationId/otp', auth.requireRole('amer', 'admin'), visaApplicationController.requestOTP);
router.post('/:applicationId/attachments/:attachmentId/review', auth.requireRole('amer', 'admin'), visaApplicationController.reviewAttachment);
router.get('/:applicationId/attachments/:attachmentId/download', visaApplicationController.downloadAttachment);
router.get('/:applicationId/result-documents/:attachmentId/download', visaApplicationController.downloadResultDocument);
router.post('/:applicationId/documents',auth, visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadDocuments);
router.put('/:applicationId/documents',auth, visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadDocuments);
router.post('/:applicationId/comments', visaApplicationController.addComment);
// Priority boost and additional documents
router.post('/:applicationId/boost', visaApplicationController.priorityBoost);
router.post('/:applicationId/attachments/upload', visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadAdditionalDocument);
router.get('/:applicationId', visaApplicationController.getApplication);

// Legacy officer/admin routes (kept for compatibility)
router.patch('/:applicationId/status', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationStatus);
router.post('/:applicationId/fraud-alerts', auth.requireRole('amer', 'admin'), visaApplicationController.addFraudAlert);
router.post('/:applicationId/penalties', auth.requireRole('amer', 'admin'), visaApplicationController.issuePenalty);

router.get('/uploads/applications/:attachmentId', visaApplicationController.downloadAnyDocument);
module.exports = router;