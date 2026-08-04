// controllers/visa/visaController.js
const VisaApplication = require('../../model/schema/visaApplication');
const User = require('../../model/schema/user');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// ─── Storage Configuration ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const appId = req.params.id || req.params.applicationId || 'new';
    const uploadDir = path.join('uploads', 'applications', appId);
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${base}-${timestamp}${ext}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF are allowed.'));
    }
  }
});

const uploadMiddleware = upload.array('files', 10);

// ─── Receipt Storage Configuration ────────────────────────────────────────
const receiptStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const appId = req.params.id || req.params.applicationId || 'new';
    const uploadDir = path.join('uploads', 'applications', appId, 'receipts');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `receipt-${base}-${timestamp}${ext}`);
  }
});

const receiptUpload = multer({ 
  storage: receiptStorage,
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

const uploadReceiptMiddleware = receiptUpload.single('receipt');

// ─── Create Application ────────────────────────────────────────────────────
const createApplication = async (req, res) => {
  try {
    const {
      applicationType,
      sponsoredId,
      metadata
    } = req.body;

    const sponsorId = req.user?.userId || req.user?._id;

    const application = await VisaApplication.create({
      applicationType,
      sponsor: sponsorId,
      sponsored: sponsoredId || null,
      metadata: metadata || {},
      status: 'draft',
      receipts: [],
      history: [{ action: 'created', by: sponsorId, note: 'Application created' }]
    });

    return res.status(201).json({ application });
  } catch (err) {
    console.error('Create application error:', err);
    return res.status(500).json({ message: 'Failed to create application' });
  }
};

// ─── List Applications ─────────────────────────────────────────────────────
const listApplications = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    const role = req.user?.role;
    const query = role === 'amer' || role === 'admin' ? {} : { $or: [{ sponsor: userId }, { sponsored: userId }] };
    const applications = await VisaApplication.find(query).sort({ createdAt: -1 });
    return res.json({ applications });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to list applications' });
  }
};

// ─── Get Application ──────────────────────────────────────────────────────
const getApplication = async (req, res) => {
  try {
    const application = await VisaApplication.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch application' });
  }
};

// ─── Update Application ────────────────────────────────────────────────────
const updateApplication = async (req, res) => {
  try {
    const updates = req.body;
    const application = await VisaApplication.findByIdAndUpdate(
      req.params.id,
      { $set: updates, $push: { history: { action: 'updated', by: req.user?.userId, note: 'Application updated' } } },
      { new: true }
    );
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to update application' });
  }
};

// ─── Submit Application ────────────────────────────────────────────────────
const submitApplication = async (req, res) => {
  try {
    const application = await VisaApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'submitted' }, $push: { history: { action: 'submitted', by: req.user?.userId } } },
      { new: true }
    );
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to submit application' });
  }
};

// ─── Request Documents ────────────────────────────────────────────────────
const requestDocuments = async (req, res) => {
  try {
    const { requested } = req.body;
    const application = await VisaApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'docs_required' }, $push: { history: { action: 'docs_required', by: req.user?.userId, note: JSON.stringify(requested) } } },
      { new: true }
    );
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to request documents' });
  }
};

// ─── Approve Application ───────────────────────────────────────────────────
const approveApplication = async (req, res) => {
  try {
    const application = await VisaApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'approved' }, $push: { history: { action: 'approved', by: req.user?.userId } } },
      { new: true }
    );
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to approve application' });
  }
};

// ─── Reject Application ────────────────────────────────────────────────────
const rejectApplication = async (req, res) => {
  try {
    const { reason } = req.body;
    const application = await VisaApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'rejected' }, $push: { history: { action: 'rejected', by: req.user?.userId, note: reason || '' } } },
      { new: true }
    );
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to reject application' });
  }
};

// ─── Upload Application Documents ─────────────────────────────────────────
const uploadApplicationDocs = async (req, res) => {
  try {
    const files = req.files || [];
    const application = await VisaApplication.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Not found' });

    const attachments = files.map(f => ({ 
      path: f.path, 
      filename: f.originalname,
      originalName: f.originalname,
      size: f.size,
      mimeType: f.mimetype,
      uploadedAt: new Date()
    }));

    application.attachments.push(...attachments);
    application.history.push({ 
      action: 'documents_uploaded', 
      by: req.user?.userId, 
      note: `${files.length} file(s) uploaded` 
    });
    await application.save();

    return res.json({ application });
  } catch (err) {
    console.error('Upload docs error:', err);
    return res.status(500).json({ message: 'Failed to upload documents' });
  }
};

// ─── ✅ UPLOAD RECEIPT ──────────────────────────────────────────────────────
const uploadReceipt = async (req, res) => {
  try {
    // ✅ Fix: Support both 'id' and 'applicationId' params
    const applicationId = req.params.id || req.params.applicationId || req.body.applicationId;
    
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No receipt file uploaded' 
      });
    }

    // Find the application
    const application = await VisaApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ 
        success: false,
        message: 'Application not found' 
      });
    }

    // Create receipt object with _id
    const receipt = {
      _id: new (require('mongoose').Types.ObjectId)(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
      uploadedBy: req.user?.userId || req.user?._id,
      uploadedByRole: req.user?.role || 'user'
    };

    // Initialize receipts array if it doesn't exist
    if (!application.receipts) {
      application.receipts = [];
    }

    // Add receipt to application
    application.receipts.push(receipt);
    
    // Update status to payment_received if it was pending
    if (application.status === 'pending_payment' || application.status === 'draft' || application.status === 'submitted') {
      application.status = 'payment_received';
    }
    
    // Add to history
    application.history.push({
      action: 'receipt_uploaded',
      by: req.user?.userId || req.user?._id,
      byRole: req.user?.role || 'user',
      note: `Receipt uploaded: ${req.file.originalname}`,
      at: new Date()
    });

    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Receipt uploaded successfully',
      data: {
        receipt: receipt,
        application: application
      }
    });

  } catch (err) {
    console.error('Upload receipt error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to upload receipt',
      error: err.message 
    });
  }
};

// ─── Get Receipts ──────────────────────────────────────────────────────────
const getReceipts = async (req, res) => {
  try {
    // ✅ Fix: Support both 'id' and 'applicationId' params
    const applicationId = req.params.id || req.params.applicationId;
    
    const application = await VisaApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ 
        success: false,
        message: 'Application not found' 
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        receipts: application.receipts || [],
        applicationId: application._id
      }
    });
  } catch (err) {
    console.error('Get receipts error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to fetch receipts' 
    });
  }
};

// ─── Delete Receipt ──────────────────────────────────────────────────────────
const deleteReceipt = async (req, res) => {
  try {
    // ✅ Fix: Support both 'id' and 'applicationId' params
    const applicationId = req.params.id || req.params.applicationId;
    const receiptId = req.params.receiptId;
    
    const application = await VisaApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ 
        success: false,
        message: 'Application not found' 
      });
    }

    // Find the receipt
    const receiptIndex = application.receipts.findIndex(r => r._id.toString() === receiptId);
    if (receiptIndex === -1) {
      return res.status(404).json({ 
        success: false,
        message: 'Receipt not found' 
      });
    }

    // Remove receipt from array
    const removedReceipt = application.receipts[receiptIndex];
    application.receipts.splice(receiptIndex, 1);

    // Delete the file from disk
    try {
      if (removedReceipt.path && fs.existsSync(removedReceipt.path)) {
        fs.unlinkSync(removedReceipt.path);
      }
    } catch (fileErr) {
      console.warn('Failed to delete receipt file:', fileErr);
    }

    application.history.push({
      action: 'receipt_deleted',
      by: req.user?.userId || req.user?._id,
      byRole: req.user?.role || 'user',
      note: `Receipt deleted: ${removedReceipt.originalName}`,
      at: new Date()
    });

    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Receipt deleted successfully',
      data: { receipts: application.receipts }
    });

  } catch (err) {
    console.error('Delete receipt error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to delete receipt' 
    });
  }
};

module.exports = {
  uploadMiddleware,
  uploadReceiptMiddleware,
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
  submitApplication,
  requestDocuments,
  approveApplication,
  rejectApplication,
  uploadApplicationDocs,
  uploadReceipt,
  getReceipts,
  deleteReceipt
};