// routes/packageApplicationRoutes.js

const express = require('express');
const router = express.Router();

const packageController = require('./packageApplicationController');
const auth = require('../../middelwares/auth');

// ================================================================
// CUSTOMER ENDPOINTS
// ================================================================

// Create package application
router.post(
  '/',
  auth,
  packageController.submitPackageApplication
);

// Get logged-in customer's applications
router.get(
  '/me/list',
  auth,
  packageController.getMyPackageApplications
);

// ================================================================
// ADMIN / AMER - LIST APPLICATIONS
// IMPORTANT: Keep this BEFORE /:applicationId
// ================================================================

router.get(
  '/',
  auth,
  packageController.getPackageApplications
);

// ================================================================
// DOCUMENT UPLOAD ENDPOINTS
// ================================================================

// ✅ NEW: Upload a general document (anytime, not just for requested docs)
// Example: POST /api/v1/package-applications/:applicationId/documents
router.post(
  '/:applicationId/documents',
  auth,
  packageController.uploadMiddleware,
  packageController.uploadGeneralDocument
);

// Upload a normal document (with optional requestedDocId)
router.post(
  '/:applicationId/upload',
  auth,
  packageController.uploadMiddleware,
  packageController.uploadPackageDocuments
);

// Upload document for a specific requested document
router.post(
  '/:applicationId/upload-requested/:requestedDocId',
  auth,
  packageController.uploadMiddleware,
  packageController.uploadToRequestedDoc
);

// ================================================================
// DOCUMENT VIEW / DOWNLOAD
// ================================================================

// Preview document in browser
//
// Example:
// GET /api/v1/package-applications/APP_ID/documents/DOC_ID/preview
//
// Use this URL for:
// <img src="...">
// <iframe src="...">
// window.open(...)
router.get(
  '/:applicationId/documents/:docId/preview',
  packageController.previewDocument
);

// Download document
//
// Example:
// GET /api/v1/package-applications/APP_ID/documents/DOC_ID/download
router.get(
  '/:applicationId/documents/:docId/download',
  auth,
  packageController.downloadDocument
);
// ================================================================
// DOCUMENT APPROVAL / REJECTION
// ================================================================

// Approve document
router.patch(
  '/:applicationId/documents/:docId/approve',
  auth,
  packageController.approveDocument
);

// Reject document
router.patch(
  '/:applicationId/documents/:docId/reject',
  auth,
  packageController.rejectDocument
);

// ================================================================
// MESSAGES
// ================================================================

// Send message
router.post(
  '/:applicationId/messages',
  auth,
  packageController.sendMessage
);

// Get messages
router.get(
  '/:applicationId/messages',
  auth,
  packageController.getMessages
);

// ================================================================
// COMMENTS
// ================================================================

// Add comment
router.post(
  '/:applicationId/comments',
  auth,
  packageController.addComment
);

// Get comments
router.get(
  '/:applicationId/comments',
  auth,
  packageController.getMessages
);

// ================================================================
// APPLICATION STATUS / ADMIN ACTIONS
// ================================================================

// Update application status
router.patch(
  '/:applicationId/status',
  auth,
  packageController.updatePackageStatus
);

// Request additional documents
router.post(
  '/:applicationId/request-documents',
  auth,
  packageController.requestDocuments
);

// Update payment
router.patch(
  '/:applicationId/payment',
  auth,
  packageController.updatePayment
);

// ================================================================
// GET SINGLE APPLICATION
// IMPORTANT: Keep this AFTER all specific routes
// ================================================================

router.get(
  '/:applicationId',
  auth,
  packageController.getPackageApplicationById
);

// ================================================================
// DELETE APPLICATION
// ================================================================

router.delete(
  '/:applicationId',
  auth,
  packageController.deletePackageApplication
);

module.exports = router;