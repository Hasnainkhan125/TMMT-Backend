const express = require('express');
const router = express.Router();
const packageController = require('./packageApplicationController');
const auth = require('../../middelwares/auth');

// ─── Customer endpoints ─────────────────────────────────────────
router.post('/', auth, packageController.submitPackageApplication);
router.get('/me/list', auth, packageController.getMyPackageApplications);
router.post('/:applicationId/documents', auth, packageController.uploadPackageDocuments);

// ─── Admin & Amer endpoints ────────────────────────────────────
router.get('/', auth, packageController.getPackageApplications);
router.patch('/:applicationId/status', auth, packageController.updatePackageStatus);
router.post('/:applicationId/request-documents', auth, packageController.requestDocuments);
router.post('/:applicationId/comments', auth, packageController.addComment);
router.patch('/:applicationId/payment', auth, packageController.updatePayment);
router.get('/:applicationId/documents/:docId/download', auth, packageController.downloadDocument);
router.delete('/:applicationId', auth, packageController.deletePackageApplication); // ✅ DELETE

module.exports = router;