// controllers/visa/_routes.js
const express = require('express');
const router = express.Router();
const visaApplicationController = require('./visaApplicationController');
const auth = require('../../middelwares/auth');

// Protect all routes
router.use(auth);

// Officer/admin collection routes FIRST
router.get('/applications', auth.requireRole('amer', 'admin'), visaApplicationController.getAllApplications);
router.get('/stats', auth.requireRole('amer', 'admin'), visaApplicationController.getStats);
router.get('/applications/:email', visaApplicationController.getApplicationsByUserId);
router.get('/applications/user/:userId', visaApplicationController.getApplicationsByUserObjectId);
router.put('/applications/:applicationId/status', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationStatus);
router.post('/applications/:applicationId/fraud-alert', auth.requireRole('amer', 'admin'), visaApplicationController.addFraudAlert);
router.post('/applications/:applicationId/penalty', auth.requireRole('amer', 'admin'), visaApplicationController.issuePenalty);
router.post('/applications/:applicationId/stage', auth.requireRole('amer', 'admin'), visaApplicationController.setGovStage);
router.patch('/applications/:applicationId/details', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationDetails);

// Routes accessible by all authenticated users
router.post('/', auth, visaApplicationController.createApplication);
router.get('/my-applications', visaApplicationController.getMyApplications);

// Amer: request additional documents
router.post('/:applicationId/request-documents', auth.requireRole('amer', 'admin'), visaApplicationController.requestDocuments);
router.post('/:applicationId/result-documents', auth.requireRole('amer', 'admin'), visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadResultDocuments);
router.post('/:applicationId/otp', auth.requireRole('amer', 'admin'), visaApplicationController.requestOTP);
router.post('/:applicationId/attachments/:attachmentId/review', auth.requireRole('amer', 'admin'), visaApplicationController.reviewAttachment);
router.get('/:applicationId/attachments/:attachmentId/download', visaApplicationController.downloadAttachment);
router.get('/:applicationId/result-documents/:attachmentId/download', visaApplicationController.downloadResultDocument);

// Documents upload
router.post('/:applicationId/documents', auth, visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadDocuments);
router.put('/:applicationId/documents', auth, visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadDocuments);

// Comments
router.post('/:applicationId/comments', visaApplicationController.addComment);

// Priority boost
router.post('/:applicationId/boost', visaApplicationController.priorityBoost);
router.post('/:applicationId/attachments/upload', visaApplicationController.uploadApplicationFiles, visaApplicationController.uploadAdditionalDocument);

// ✅ RECEIPT ROUTES
// Upload receipt
router.post('/:applicationId/receipt', 
  auth, 
  visaApplicationController.uploadReceiptMiddleware, 
  visaApplicationController.uploadReceipt
);


// Get receipts
router.get('/:applicationId/receipts', 
  auth, 
  visaApplicationController.getReceipts
);
// Delete receipt
router.delete('/:applicationId/receipt/:receiptId', 
  auth, 
  visaApplicationController.deleteReceipt
);

// Get application (must be last)
router.get('/:applicationId', visaApplicationController.getApplication);

router.delete('/:id', auth, visaApplicationController.deleteApplication);// Legacy routes
router.patch('/:applicationId/status', auth.requireRole('amer', 'admin'), visaApplicationController.updateApplicationStatus);
router.post('/:applicationId/fraud-alerts', auth.requireRole('amer', 'admin'), visaApplicationController.addFraudAlert);
router.post('/:applicationId/penalties', auth.requireRole('amer', 'admin'), visaApplicationController.issuePenalty);
router.get('/uploads/applications/:attachmentId', visaApplicationController.downloadAnyDocument);

module.exports = router;