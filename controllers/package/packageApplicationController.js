// controllers/packageApplicationController.js

const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const PackageApplication = require('../../model/schema/packageApplication');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ================================================================

const UPLOAD_DIR = path.join(__dirname, '../../uploads/documents');

// Make sure upload directory exists when server starts
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ================================================================
// MULTER CONFIGURATION
// ================================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname);

    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${extension}`;

    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        'Invalid file type. Please upload PDF, DOC, DOCX, or image files.',
        400
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB
  },
  fileFilter
});

exports.uploadMiddleware = upload.single('document');

// ================================================================
// HELPERS
// ================================================================

const getHistoryActor = (user) => {
  if (!user) {
    return {
      id: null,
      name: 'System'
    };
  }

  return {
    id: user._id || user.id || null,
    name:
      user.firstName ||
      user.email ||
      user.name ||
      'User'
  };
};

/**
 * Build the base URL for the current request.
 *
 * Example:
 * http://localhost:5000
 */
const getBaseUrl = (req) => {
  const protocol =
    req.headers['x-forwarded-proto'] ||
    req.protocol ||
    'http';

  const host =
    req.headers['x-forwarded-host'] ||
    req.get('host');

  return `${protocol}://${host}`;
};

/**
 * Get document ID.
 *
 * Supports both:
 * - MongoDB _id
 * - custom docKey
 */
const getDocumentIdentifier = (doc) => {
  if (!doc) return null;

  return doc._id
    ? doc._id.toString()
    : doc.docKey || null;
};

/**
 * Build browser-accessible URLs.
 *
 * IMPORTANT:
 * Never send the Windows filesystem path as the browser URL.
 */
const buildDocumentUrls = (req, applicationId, doc) => {
  if (!doc) return doc;

  const docId = getDocumentIdentifier(doc);

  if (!docId) {
    return { ...doc };
  }

  const baseUrl = getBaseUrl(req);

  const previewUrl =
    `${baseUrl}/api/v1/package-applications/` +
    `${applicationId}/documents/${encodeURIComponent(docId)}/preview`;

  const downloadUrl =
    `${baseUrl}/api/v1/package-applications/` +
    `${applicationId}/documents/${encodeURIComponent(docId)}/download`;

  return {
    ...doc,
    filePath: doc.path || null,
    path: previewUrl,
    url: previewUrl,
    previewUrl,
    downloadUrl
  };
};

/**
 * Convert all application documents into frontend-safe documents.
 */
const serializeApplication = (req, application) => {
  const obj = application.toObject
    ? application.toObject()
    : { ...application };

  obj.documents = (obj.documents || []).map((doc) =>
    buildDocumentUrls(req, obj._id, doc)
  );

  return obj;
};

/**
 * Find a document by Mongo _id or docKey.
 */
const findDocument = (application, docId) => {
  if (!application?.documents) {
    return null;
  }

  return application.documents.find((doc) => {
    const mongoId = doc._id?.toString();

    return (
      mongoId === docId ||
      doc.docKey === docId ||
      doc.filename === docId
    );
  });
};

/**
 * Find document index.
 */
const findDocumentIndex = (application, docId) => {
  if (!application?.documents) {
    return -1;
  }

  return application.documents.findIndex((doc) => {
    const mongoId = doc._id?.toString();

    return (
      mongoId === docId ||
      doc.docKey === docId ||
      doc.filename === docId
    );
  });
};

/**
 * Resolve the actual server file path.
 *
 * Old database records may contain:
 * C:\TMMT-Backend-main\uploads\documents\file.png
 *
 * New records should also work.
 */
const resolveDocumentFilePath = (doc) => {
  if (!doc) {
    return null;
  }

  // First use existing database path.
  if (doc.path) {
    return path.normalize(doc.path);
  }

  // Fallback to filename.
  if (doc.filename) {
    return path.join(UPLOAD_DIR, doc.filename);
  }

  return null;
};

/**
 * Check whether user owns application or is admin.
 */
const canAccessApplication = (application, req) => {
  // If no user, check if the application is in a public state
  if (!req.user) {
    // Allow preview for submitted, processing, or completed applications
    // This allows image previews without authentication
    const publicStatuses = ['submitted', 'processing', 'completed'];
    if (publicStatuses.includes(application.status)) {
      return {
        isOwner: false,
        isAdmin: false,
        allowed: true,
        isPublic: true
      };
    }
    return {
      isOwner: false,
      isAdmin: false,
      allowed: false,
      isPublic: false
    };
  }

  const isOwner =
    application.user_id?.toString() ===
    req.user?._id?.toString();

  const isAdmin =
    req.user?.role === 'admin' ||
    req.user?.role === 'amer';

  return {
    isOwner,
    isAdmin,
    allowed: isOwner || isAdmin,
    isPublic: false
  };
};

// ================================================================
// SUBMIT PACKAGE APPLICATION
// ================================================================

exports.submitPackageApplication = catchAsync(
  async (req, res, next) => {
    const {
      packageSlug,
      packageName,
      applicantType,
      contact,
      pricing,
      user_id
    } = req.body;

    if (
      !packageSlug ||
      !contact?.fullName ||
      !contact?.phone
    ) {
      return next(
        new AppError(
          'Missing required fields',
          400
        )
      );
    }

    const referenceId =
      `PKG-${Date.now().toString(36).toUpperCase()}-` +
      `${uuidv4().slice(0, 6)}`;

    const userId =
      user_id ||
      req.user?._id ||
      null;

    const application =
      await PackageApplication.create({
        packageSlug,
        packageName,
        applicantType:
          applicantType || 'outside',
        contact,
        pricing,
        user_id: userId,
        referenceId,
        status: 'submitted',

        history: [
          {
            action: 'submitted',
            note:
              'Package application submitted',
            by:
              userId ||
              contact.fullName,
            at: new Date()
          }
        ]
      });

    res.status(201).json({
      status: 'success',

      data: {
        application:
          serializeApplication(
            req,
            application
          ),

        referenceId:
          application.referenceId,

        _id:
          application._id
      }
    });
  }
);

// ================================================================
// UPLOAD DOCUMENT (General - Anytime)
// ================================================================

exports.uploadGeneralDocument = catchAsync(
  async (req, res, next) => {
    const { label } = req.body;
    const applicationId = req.params.applicationId;

    if (!req.file) {
      return next(
        new AppError(
          'No file uploaded',
          400
        )
      );
    }

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    // Check authorization
    const access = canAccessApplication(application, req);
    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to upload documents for this application',
          403
        )
      );
    }

    // ------------------------------------------------------------
    // ADD DOCUMENT
    // ------------------------------------------------------------

    application.documents =
      application.documents || [];

    const newDoc = {
      docKey:
        `DOC-${Date.now()}-` +
        `${uuidv4().slice(0, 6)}`,

      label:
        label ||
        req.body.label ||
        req.file.originalname,

      originalName:
        req.file.originalname,

      filename:
        req.file.filename,

      path:
        req.file.path,

      size:
        req.file.size,

      mimeType:
        req.file.mimetype,

      uploadedAt:
        new Date(),

      status:
        'pending'
    };

    application.documents.push(
      newDoc
    );

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------

    application.history =
      application.history || [];

    application.history.push({
      action:
        'document_uploaded',

      note:
        `Uploaded: ${req.file.originalname}${label ? ` (${label})` : ''}`,

      by:
        req.user?._id ||
        req.user?.firstName ||
        'User',

      at:
        new Date()
    });

    await application.save();

    const responseDocument =
      buildDocumentUrls(
        req,
        application._id,
        newDoc
      );

    res.status(200).json({
      status: 'success',

      message:
        'Document uploaded successfully',

      data: {
        document:
          responseDocument,
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  }
);

// ================================================================
// UPLOAD DOCUMENT (With Requested Doc)
// ================================================================

exports.uploadPackageDocuments = catchAsync(
  async (req, res, next) => {
    const {
      requestedDocId,
      packageId,
      label
    } = req.body;

    const applicationId =
      packageId ||
      req.params.applicationId;

    if (!req.file) {
      return next(
        new AppError(
          'No file uploaded',
          400
        )
      );
    }

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    // Check authorization
    const access = canAccessApplication(application, req);
    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to upload documents for this application',
          403
        )
      );
    }

    // ------------------------------------------------------------
    // REQUESTED DOCUMENT
    // ------------------------------------------------------------

    if (requestedDocId) {
      const requestedDocIndex =
        application.requestedDocuments?.findIndex(
          (doc) =>
            doc._id?.toString() ===
            requestedDocId
        );

      if (
        requestedDocIndex === -1 ||
        requestedDocIndex === undefined
      ) {
        return next(
          new AppError(
            'Requested document not found',
            404
          )
        );
      }

      application.requestedDocuments[
        requestedDocIndex
      ].status = 'fulfilled';

      application.requestedDocuments[
        requestedDocIndex
      ].fulfilledAt = new Date();

      application.requestedDocuments[
        requestedDocIndex
      ].documentId =
        req.file.filename;
    }

    // ------------------------------------------------------------
    // ADD DOCUMENT
    // ------------------------------------------------------------

    application.documents =
      application.documents || [];

    const newDoc = {
      docKey:
        `DOC-${Date.now()}-` +
        `${uuidv4().slice(0, 6)}`,

      label:
        label ||
        req.body.label ||
        req.file.originalname,

      originalName:
        req.file.originalname,

      filename:
        req.file.filename,

      path:
        req.file.path,

      size:
        req.file.size,

      mimeType:
        req.file.mimetype,

      uploadedAt:
        new Date(),

      status:
        'pending'
    };

    application.documents.push(
      newDoc
    );

    // ------------------------------------------------------------
    // CHECK REQUESTED DOCUMENTS
    // ------------------------------------------------------------

    if (
      application.requestedDocuments &&
      application.requestedDocuments.length > 0
    ) {
      const allFulfilled =
        application.requestedDocuments.every(
          (doc) =>
            doc.status === 'fulfilled'
        );

      if (
        allFulfilled &&
        application.status ===
          'docs_required'
      ) {
        application.status =
          'submitted';

        application.history =
          application.history || [];

        application.history.push({
          action:
            'all_docs_uploaded',

          note:
            'All requested documents have been uploaded',

          by:
            req.user?._id ||
            req.user?.firstName ||
            'User',

          at:
            new Date()
        });
      }
    }

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------

    application.history =
      application.history || [];

    application.history.push({
      action:
        'document_uploaded',

      note:
        `Uploaded: ${req.file.originalname}`,

      by:
        req.user?._id ||
        req.user?.firstName ||
        'User',

      at:
        new Date()
    });

    await application.save();

    const responseDocument =
      buildDocumentUrls(
        req,
        application._id,
        newDoc
      );

    const requestedDoc =
      requestedDocId
        ? application.requestedDocuments.find(
            (d) =>
              d._id?.toString() ===
              requestedDocId
          )
        : undefined;

    res.status(200).json({
      status: 'success',

      message:
        'Document uploaded successfully',

      data: {
        document:
          responseDocument,
        requestedDoc,
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  }
);

// ================================================================
// UPLOAD TO SPECIFIC REQUESTED DOCUMENT
// ================================================================

exports.uploadToRequestedDoc =
  catchAsync(async (req, res, next) => {
    if (!req.file) {
      return next(
        new AppError(
          'No file uploaded',
          400
        )
      );
    }

    const {
      requestedDocId
    } = req.params;

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    // Check authorization
    const access = canAccessApplication(application, req);
    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to upload documents for this application',
          403
        )
      );
    }

    const requestedDocIndex =
      application.requestedDocuments?.findIndex(
        (doc) =>
          doc._id?.toString() ===
          requestedDocId
      );

    if (
      requestedDocIndex === -1 ||
      requestedDocIndex === undefined
    ) {
      return next(
        new AppError(
          'Requested document not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // UPDATE REQUESTED DOCUMENT
    // ------------------------------------------------------------

    application.requestedDocuments[
      requestedDocIndex
    ].status = 'fulfilled';

    application.requestedDocuments[
      requestedDocIndex
    ].fulfilledAt = new Date();

    application.requestedDocuments[
      requestedDocIndex
    ].documentId =
      req.file.filename;

    // ------------------------------------------------------------
    // ADD DOCUMENT
    // ------------------------------------------------------------

    application.documents =
      application.documents || [];

    const newDoc = {
      docKey:
        `DOC-${Date.now()}-` +
        `${uuidv4().slice(0, 6)}`,

      label:
        application
          .requestedDocuments[
            requestedDocIndex
          ].label,

      originalName:
        req.file.originalname,

      filename:
        req.file.filename,

      path:
        req.file.path,

      size:
        req.file.size,

      mimeType:
        req.file.mimetype,

      uploadedAt:
        new Date(),

      status:
        'pending'
    };

    application.documents.push(
      newDoc
    );

    // ------------------------------------------------------------
    // UPDATE APPLICATION STATUS
    // ------------------------------------------------------------

    const allFulfilled =
      application.requestedDocuments.every(
        (doc) =>
          doc.status === 'fulfilled'
      );

    if (
      allFulfilled &&
      application.status ===
        'docs_required'
    ) {
      application.status =
        'submitted';

      application.history =
        application.history || [];

      application.history.push({
        action:
          'all_docs_uploaded',

        note:
          'All requested documents have been uploaded',

        by:
          req.user?._id ||
          req.user?.firstName ||
          'User',

        at:
          new Date()
      });
    }

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------

    application.history =
      application.history || [];

    application.history.push({
      action:
        'doc_uploaded_to_request',

      note:
        `Uploaded ${req.file.originalname} for ` +
        `${application.requestedDocuments[requestedDocIndex].label}`,

      by:
        req.user?._id ||
        req.user?.firstName ||
        'User',

      at:
        new Date()
    });

    await application.save();

    const responseDocument =
      buildDocumentUrls(
        req,
        application._id,
        newDoc
      );

    res.status(200).json({
      status: 'success',

      message:
        'Document uploaded successfully',

      data: {
        document:
          responseDocument,
        requestedDoc:
          application
            .requestedDocuments[
              requestedDocIndex
            ],
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// ADMIN - GET ALL APPLICATIONS
// ================================================================

exports.getPackageApplications =
  catchAsync(async (req, res, next) => {
    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const {
      status,
      q
    } = req.query;

    const filter = {};

    if (
      status &&
      status !== 'all'
    ) {
      filter.status = status;
    }

    if (q) {
      filter.$or = [
        {
          'contact.fullName': {
            $regex: q,
            $options: 'i'
          }
        },
        {
          referenceId: {
            $regex: q,
            $options: 'i'
          }
        },
        {
          'contact.phone': {
            $regex: q,
            $options: 'i'
          }
        }
      ];
    }

    const applications =
      await PackageApplication
        .find(filter)
        .sort({
          createdAt: -1
        });

    const serialized =
      applications.map(
        (application) =>
          serializeApplication(
            req,
            application
          )
      );

    res.status(200).json({
      status: 'success',

      data: {
        applications:
          serialized
      }
    });
  });

// ================================================================
// CUSTOMER - GET OWN APPLICATIONS
// ================================================================

exports.getMyPackageApplications =
  catchAsync(async (req, res, next) => {
    const userId =
      req.user?._id;

    if (!userId) {
      return next(
        new AppError(
          'User not authenticated',
          401
        )
      );
    }

    const applications =
      await PackageApplication
        .find({
          user_id: userId
        })
        .sort({
          createdAt: -1
        });

    const serialized =
      applications.map(
        (application) =>
          serializeApplication(
            req,
            application
          )
      );

    res.status(200).json({
      status: 'success',

      data: {
        applications:
          serialized
      }
    });
  });

// ================================================================
// GET SINGLE APPLICATION
// ================================================================

exports.getPackageApplicationById =
  catchAsync(async (req, res, next) => {
    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const access =
      canAccessApplication(
        application,
        req
      );

    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to view this application',
          403
        )
      );
    }

    res.status(200).json({
      status: 'success',

      data: {
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// UPDATE PACKAGE STATUS
// ================================================================

exports.updatePackageStatus =
  catchAsync(async (req, res, next) => {
    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const {
      status,
      note
    } = req.body;

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const oldStatus =
      application.status;

    application.status =
      status;

    application.history =
      application.history || [];

    application.history.push({
      action:
        'status_updated',

      note:
        note ||
        `Status changed from ${oldStatus} to ${status}`,

      by:
        req.user._id ||
        req.user.id,

      at:
        new Date()
    });

    await application.save();

    res.status(200).json({
      status: 'success',

      data: {
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// REQUEST ADDITIONAL DOCUMENTS
// ================================================================

exports.requestDocuments =
  catchAsync(async (req, res, next) => {
    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const {
      documents = [],
      note
    } = req.body;

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const requested =
      documents.map((doc) => ({
        _id:
          new mongoose.Types.ObjectId(),

        label:
          doc.label,

        description:
          doc.description ||
          note ||
          '',

        requestedAt:
          new Date(),

        status:
          'pending'
      }));

    application.requestedDocuments =
      application.requestedDocuments ||
      [];

    application.requestedDocuments.push(
      ...requested
    );

    if (
      application.status !==
      'docs_required'
    ) {
      application.status =
        'docs_required';

      application.history =
        application.history || [];

      application.history.push({
        action:
          'docs_requested',

        note:
          `${documents.length} document(s) requested: ` +
          `${documents.map(d => d.label).join(', ')}`,

        by:
          req.user._id ||
          req.user.id,

        at:
          new Date()
      });
    }

    await application.save();

    res.status(200).json({
      status: 'success',

      data: {
        requestedDocuments:
          requested,

        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// ADD COMMENT
// ================================================================

exports.addComment =
  catchAsync(async (req, res, next) => {
    const {
      message,
      by
    } = req.body;

    if (
      !message ||
      !message.trim()
    ) {
      return next(
        new AppError(
          'Message is required',
          400
        )
      );
    }

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const isAdmin =
      by === 'admin' ||
      req.user?.role === 'admin' ||
      req.user?.role === 'amer';

    const authorName =
      isAdmin
        ? (
            req.user?.firstName ||
            req.user?.email ||
            'Admin'
          )
        : (
            req.user?.firstName ||
            req.user?.email ||
            application.contact?.fullName ||
            'Customer'
          );

    application.comments =
      application.comments || [];

    const newComment = {
      _id:
        new mongoose.Types.ObjectId(),

      message:
        message.trim(),

      by:
        isAdmin
          ? 'admin'
          : 'customer',

      authorName,

      isAdmin,

      isUser:
        !isAdmin,

      type:
        isAdmin
          ? 'admin'
          : 'user',

      role:
        isAdmin
          ? 'admin'
          : 'customer',

      at:
        new Date()
    };

    application.comments.push(
      newComment
    );

    application.updatedAt =
      new Date();

    const historyBy =
      req.user?._id ||
      req.user?.id ||
      authorName;

    application.history =
      application.history || [];

    application.history.push({
      action:
        'comment_added',

      note:
        `${authorName}: ` +
        `${message.trim().substring(0, 50)}` +
        `${
          message.trim().length > 50
            ? '...'
            : ''
        }`,

      by:
        historyBy,

      at:
        new Date()
    });

    await application.save();

    res.status(200).json({
      status: 'success',

      data: {
        comment:
          newComment
      }
    });
  });

// ================================================================
// UPDATE PAYMENT
// ================================================================

exports.updatePayment =
  catchAsync(async (req, res, next) => {
    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const {
      status,
      paymentLink,
      paidAmount,
      provider,
      transactionId
    } = req.body;

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    application.payment =
      application.payment || {};

    if (status) {
      application.payment.status =
        status;
    }

    if (paymentLink) {
      application.payment.paymentLink =
        paymentLink;
    }

    if (
      paidAmount !== undefined &&
      paidAmount !== null
    ) {
      application.payment.paidAmount =
        paidAmount;
    }

    if (provider) {
      application.payment.provider =
        provider;
    }

    if (transactionId) {
      application.payment.transactionId =
        transactionId;
    }

    if (status === 'paid') {
      application.payment.paidAt =
        new Date();
    }

    if (
      status === 'paid' &&
      application.status ===
        'pending_payment'
    ) {
      application.status =
        'processing';

      application.history =
        application.history || [];

      application.history.push({
        action:
          'payment_received',

        note:
          `Payment of AED ${paidAmount || 0} received. ` +
          `Transaction: ${transactionId || 'N/A'}`,

        by:
          req.user._id ||
          req.user.id,

        at:
          new Date()
      });
    }

    await application.save();

    res.status(200).json({
      status: 'success',

      data: {
        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// DOWNLOAD DOCUMENT
// ================================================================

exports.downloadDocument =
  catchAsync(async (req, res, next) => {
    const {
      applicationId,
      docId
    } = req.params;

    console.log(
      'Download request:',
      {
        applicationId,
        docId
      }
    );

    // ------------------------------------------------------------
    // FIND APPLICATION
    // ------------------------------------------------------------

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // AUTHORIZATION
    // ------------------------------------------------------------

    const access =
      canAccessApplication(
        application,
        req
      );

    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to download this document',
          403
        )
      );
    }

    // ------------------------------------------------------------
    // FIND DOCUMENT
    // ------------------------------------------------------------

    const doc =
      findDocument(
        application,
        docId
      );

    if (!doc) {
      return next(
        new AppError(
          'Document not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // SERVER FILE PATH
    // ------------------------------------------------------------

    const filePath =
      resolveDocumentFilePath(
        doc
      );

    if (!filePath) {
      return next(
        new AppError(
          'File path not found',
          404
        )
      );
    }

    console.log(
      'Resolved document path:',
      filePath
    );

    // ------------------------------------------------------------
    // FILE EXISTS?
    // ------------------------------------------------------------

    if (!fs.existsSync(filePath)) {
      console.error(
        'File does not exist:',
        filePath
      );

      return next(
        new AppError(
          'File not found on server',
          404
        )
      );
    }

    const filename =
      doc.originalName ||
      doc.filename ||
      'document';

    console.log(
      'Sending file:',
      filePath
    );

    // ------------------------------------------------------------
    // DOWNLOAD
    // ------------------------------------------------------------

    return res.download(
      filePath,
      filename,
      (err) => {
        if (err) {
          console.error(
            'Download error:',
            err
          );

          if (!res.headersSent) {
            return next(
              new AppError(
                'Error downloading file',
                500
              )
            );
          }
        }
      }
    );
  });

// ================================================================
// PREVIEW DOCUMENT - PUBLIC ACCESS (No Auth Required)
// ================================================================

exports.previewDocument =
  catchAsync(async (req, res, next) => {
    const {
      applicationId,
      docId
    } = req.params;

    console.log(
      'Preview request:',
      {
        applicationId,
        docId
      }
    );

    // ------------------------------------------------------------
    // FIND APPLICATION
    // ------------------------------------------------------------

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // AUTHORIZATION - Check without requiring auth middleware
    // ------------------------------------------------------------

    let isAuthorized = false;
    
    // Check if user is authenticated via token
    if (req.user) {
      const access = canAccessApplication(application, req);
      isAuthorized = access.allowed;
    } else {
      // For public access, allow preview if the application is in a public state
      // This allows image previews in the browser without authentication
      const publicStatuses = ['submitted', 'processing', 'completed'];
      if (publicStatuses.includes(application.status)) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return next(
        new AppError(
          'You do not have permission to view this document',
          403
        )
      );
    }

    // ------------------------------------------------------------
    // FIND DOCUMENT
    // ------------------------------------------------------------

    const doc =
      findDocument(
        application,
        docId
      );

    if (!doc) {
      return next(
        new AppError(
          'Document not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // RESOLVE FILE
    // ------------------------------------------------------------

    const filePath =
      resolveDocumentFilePath(
        doc
      );

    if (!filePath) {
      return next(
        new AppError(
          'File path not found',
          404
        )
      );
    }

    if (!fs.existsSync(filePath)) {
      console.error(
        'Preview file does not exist:',
        filePath
      );

      return next(
        new AppError(
          'File not found on server',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // CONTENT TYPE
    // ------------------------------------------------------------

    const mimeType =
      doc.mimeType ||
      'application/octet-stream';

    res.setHeader(
      'Content-Type',
      mimeType
    );

    res.setHeader(
      'Content-Disposition',
      'inline'
    );

    res.setHeader(
      'Cache-Control',
      'private, max-age=3600'
    );

    // ------------------------------------------------------------
    // SEND FILE
    // ------------------------------------------------------------

    return res.sendFile(
      path.resolve(filePath),
      (err) => {
        if (err) {
          console.error(
            'Preview error:',
            err
          );

          if (!res.headersSent) {
            return next(
              new AppError(
                'Error previewing file',
                500
              )
            );
          }
        }
      }
    );
  });

// ================================================================
// DELETE PACKAGE APPLICATION
// ================================================================

exports.deletePackageApplication =
  catchAsync(async (req, res, next) => {
    if (!req.user) {
      return next(
        new AppError(
          'You must be logged in',
          401
        )
      );
    }

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Package application not found',
          404
        )
      );
    }

    const access =
      canAccessApplication(
        application,
        req
      );

    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to delete this package',
          403
        )
      );
    }

    // ------------------------------------------------------------
    // DELETE FILES
    // ------------------------------------------------------------

    if (
      application.documents &&
      application.documents.length > 0
    ) {
      for (
        const doc of application.documents
      ) {
        const filePath =
          resolveDocumentFilePath(
            doc
          );

        if (
          filePath &&
          fs.existsSync(filePath)
        ) {
          try {
            fs.unlinkSync(
              filePath
            );
          } catch (err) {
            console.error(
              'Error deleting file:',
              err
            );
          }
        }
      }
    }

    // ------------------------------------------------------------
    // DELETE APPLICATION
    // ------------------------------------------------------------

    await application.deleteOne();

    res.status(200).json({
      status: 'success',

      message:
        'Package application deleted successfully'
    });
  });

// ================================================================
// APPROVE DOCUMENT
// ================================================================

exports.approveDocument =
  catchAsync(async (req, res, next) => {
    const {
      applicationId,
      docId
    } = req.params;

    // ------------------------------------------------------------
    // ADMIN CHECK
    // ------------------------------------------------------------

    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const docIndex =
      findDocumentIndex(
        application,
        docId
      );

    if (docIndex === -1) {
      return next(
        new AppError(
          'Document not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // UPDATE
    // ------------------------------------------------------------

    application.documents[
      docIndex
    ].status = 'approved';

    application.documents[
      docIndex
    ].approvedAt = new Date();

    application.documents[
      docIndex
    ].approvedBy =
      req.user._id;

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------

    application.history =
      application.history || [];

    application.history.push({
      action:
        'document_approved',

      note:
        `Document "${application.documents[docIndex].label || application.documents[docIndex].originalName}" approved`,

      by:
        req.user._id ||
        req.user.id,

      at:
        new Date()
    });

    await application.save();

    res.status(200).json({
      status: 'success',

      message:
        'Document approved successfully',

      data: {
        document:
          buildDocumentUrls(
            req,
            application._id,
            application.documents[
              docIndex
            ]
          ),

        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// REJECT DOCUMENT
// ================================================================

exports.rejectDocument =
  catchAsync(async (req, res, next) => {
    const {
      applicationId,
      docId
    } = req.params;

    const {
      reason
    } = req.body;

    // ------------------------------------------------------------
    // ADMIN CHECK
    // ------------------------------------------------------------

    if (
      !req.user ||
      (
        req.user.role !== 'amer' &&
        req.user.role !== 'admin'
      )
    ) {
      return next(
        new AppError(
          'Unauthorized',
          403
        )
      );
    }

    const application =
      await PackageApplication.findById(
        applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const docIndex =
      findDocumentIndex(
        application,
        docId
      );

    if (docIndex === -1) {
      return next(
        new AppError(
          'Document not found',
          404
        )
      );
    }

    // ------------------------------------------------------------
    // UPDATE
    // ------------------------------------------------------------

    application.documents[
      docIndex
    ].status = 'rejected';

    application.documents[
      docIndex
    ].rejectedAt =
      new Date();

    application.documents[
      docIndex
    ].rejectedBy =
      req.user._id;

    application.documents[
      docIndex
    ].rejectionReason =
      reason ||
      'No reason provided';

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------

    application.history =
      application.history || [];

    application.history.push({
      action:
        'document_rejected',

      note:
        `Document "${application.documents[docIndex].label || application.documents[docIndex].originalName}" rejected: ${reason || 'No reason provided'}`,

      by:
        req.user._id ||
        req.user.id,

      at:
        new Date()
    });

    await application.save();

    res.status(200).json({
      status: 'success',

      message:
        'Document rejected',

      data: {
        document:
          buildDocumentUrls(
            req,
            application._id,
            application.documents[
              docIndex
            ]
          ),

        application:
          serializeApplication(
            req,
            application
          )
      }
    });
  });

// ================================================================
// SEND MESSAGE
// ================================================================

exports.sendMessage =
  catchAsync(async (req, res, next) => {
    const {
      message,
      by
    } = req.body;

    if (
      !message ||
      !message.trim()
    ) {
      return next(
        new AppError(
          'Message content is required',
          400
        )
      );
    }

    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const isAdmin =
      by === 'admin' ||
      req.user?.role === 'admin' ||
      req.user?.role === 'amer';

    const authorName =
      isAdmin
        ? (
            req.user?.firstName ||
            req.user?.email ||
            'Admin'
          )
        : (
            req.user?.firstName ||
            req.user?.email ||
            application.contact?.fullName ||
            'Customer'
          );

    application.comments =
      application.comments || [];

    const newMessage = {
      _id:
        new mongoose.Types.ObjectId(),

      message:
        message.trim(),

      by:
        isAdmin
          ? 'admin'
          : 'customer',

      authorName,

      isAdmin,

      isUser:
        !isAdmin,

      type:
        isAdmin
          ? 'admin'
          : 'user',

      role:
        isAdmin
          ? 'admin'
          : 'customer',

      at:
        new Date()
    };

    application.comments.push(
      newMessage
    );

    application.updatedAt =
      new Date();

    const historyBy =
      req.user?._id ||
      req.user?.id ||
      authorName;

    application.history =
      application.history || [];

    application.history.push({
      action:
        'message_sent',

      note:
        `${authorName}: ` +
        `${message.trim().substring(0, 50)}` +
        `${
          message.trim().length > 50
            ? '...'
            : ''
        }`,

      by:
        historyBy,

      at:
        new Date()
    });

    await application.save();

    res.status(201).json({
      status: 'success',

      data:
        newMessage,

      message:
        'Message sent successfully'
    });
  });

// ================================================================
// GET ALL MESSAGES
// ================================================================

exports.getMessages =
  catchAsync(async (req, res, next) => {
    const application =
      await PackageApplication.findById(
        req.params.applicationId
      );

    if (!application) {
      return next(
        new AppError(
          'Application not found',
          404
        )
      );
    }

    const access =
      canAccessApplication(
        application,
        req
      );

    if (!access.allowed) {
      return next(
        new AppError(
          'You do not have permission to view these messages',
          403
        )
      );
    }

    res.status(200).json({
      status: 'success',

      data:
        application.comments || [],

      count:
        application.comments?.length ||
        0
    });
  });
