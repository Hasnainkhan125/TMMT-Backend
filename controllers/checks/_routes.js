// routes/checkRoutes.js

const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');
const checkController = require('./checkController');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/checks');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'doc-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF are allowed.'));
    }
  }
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/v1/checks - Submit a new check
router.post('/', auth, upload.array('documents', 10), checkController.createCheck);

// GET /api/v1/checks - Get all checks for the current user
router.get('/', auth, checkController.getChecks);

// GET /api/v1/checks/:id - Get a specific check
router.get('/:id', auth, checkController.getCheck);

// PUT /api/v1/checks/:id - Update entire check
router.put('/:id', auth, checkController.updateCheck);

// PUT /api/v1/checks/:id/status - Update check status
router.put('/:id/status', auth, checkController.updateCheckStatus);

// ─── COMMENT ROUTES ──────────────────────────────────────────────────────
router.post('/:id/comments', auth, checkController.addComment);
router.post('/:id/comment', auth, checkController.addComment);
router.delete('/:id/comments/:commentId', auth, checkController.deleteComment);

// ─── DOCUMENT REQUEST ROUTES ─────────────────────────────────────────────
// POST /api/v1/checks/:id/request-docs - Request documents
router.post('/:id/request-docs', auth, checkController.requestDocuments);

// POST /api/v1/checks/:id/documents - Upload a document (user)
router.post('/:id/documents', auth, upload.single('file'), checkController.uploadDocument);

// POST /api/v1/checks/:id/result - Upload result
// Support both 'resultFiles' and 'documents' field names
router.post('/:id/result', auth, upload.fields([
  { name: 'resultFiles', maxCount: 5 },
  { name: 'documents', maxCount: 5 },
  { name: 'file', maxCount: 5 }
]), checkController.uploadResult);

// POST /api/v1/checks/:id/fulfill-document - Mark document as fulfilled
router.post('/:id/fulfill-document', auth, checkController.fulfillDocument);

// DELETE /api/v1/checks/:id - Delete a check
router.delete('/:id', auth, checkController.deleteCheck);

// GET /api/v1/checks/:id/debug - Debug endpoint
router.get('/:id/debug', auth, checkController.debugCheck);

module.exports = router;