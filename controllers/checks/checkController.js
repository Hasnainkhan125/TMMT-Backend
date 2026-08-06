// controllers/checks/checkController.js
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const Check = require('../../model/schema/check');
const fs = require('fs').promises;
const path = require('path');

// ─── Free services (no subscription required) ────────────────────────────
const FREE_SERVICES = ['overstay-fine', 'absconding'];

// ─── Create a new check ──────────────────────────────────────────────────────
exports.createCheck = catchAsync(async (req, res, next) => {
  const { serviceId, serviceType, identifiers, speedTier } = req.body;
  const files = req.files || [];
  const userId = req.user._id;

  console.log('📝 Creating check:', { 
    serviceId, 
    serviceType, 
    identifiers, 
    speedTier, 
    userId,
    fileCount: files.length 
  });

  // Parse identifiers
  let parsedIdentifiers = {};
  try {
    parsedIdentifiers = typeof identifiers === 'string' 
      ? JSON.parse(identifiers) 
      : identifiers || {};
  } catch (e) {
    parsedIdentifiers = {};
  }

  // ─── ✅ SUBSCRIPTION CHECK ──────────────────────────────────────────────
  const isFreeService = FREE_SERVICES.includes(serviceId);

  if (!isFreeService) {
    try {
      const Subscription = require('../../model/schema/Subscription');
      const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        currentPeriodEnd: { $gt: new Date() }
      });

      if (!subscription) {
        return next(new AppError(
          'Subscription required to submit this check. Please subscribe to continue.',
          403
        ));
      }
    } catch (err) {
      console.error('❌ Subscription check failed:', err.message);
    }
  } else {
    console.log(`✅ Free service "${serviceId}" - no subscription required`);
  }

  // ─── Save to database ─────────────────────────────────────────────────────
  const check = await Check.create({
    userId: userId,
    serviceId: serviceId,
    serviceType: serviceType,
    identifiers: parsedIdentifiers,
    speedTier: speedTier || 'standard',
    documents: files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      size: f.size,
      mimeType: f.mimetype,
      path: `/uploads/checks/${f.filename}`,
    })),
    status: 'pending',
    createdAt: new Date(),
    // Initialize empty arrays for new fields
    requestedDocuments: [],
    resultDocuments: [],
    comments: [],
    history: []
  });

  // Log the uploaded files
  if (files.length > 0) {
    console.log('📎 Uploaded files:', files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      webPath: `/uploads/checks/${f.filename}`
    })));
  }

  // Return success response
  res.status(201).json({
    success: true,
    message: 'Check submitted successfully',
    data: {
      id: check._id,
      status: check.status,
      serviceId: check.serviceId,
      serviceType: check.serviceType,
      speedTier: check.speedTier,
      documents: check.documents,
      createdAt: check.createdAt,
      identifiers: check.identifiers,
      requestedDocuments: check.requestedDocuments,
      resultDocuments: check.resultDocuments,
      comments: check.comments,
      history: check.history
    }
  });
});

// ─── Get all checks for user ──────────────────────────────────────────────
exports.getChecks = catchAsync(async (req, res, next) => {
  const userId = req.user._id;
  
  // Use lean() to get plain JavaScript objects
  const checks = await Check.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  // Log to verify data
  console.log('📊 Total checks found:', checks.length);
  if (checks.length > 0) {
    console.log('📄 First check keys:', Object.keys(checks[0]));
    console.log('📄 requestedDocuments:', checks[0].requestedDocuments);
    console.log('📄 requestedDocuments type:', typeof checks[0].requestedDocuments);
    console.log('📄 resultDocuments:', checks[0].resultDocuments);
    console.log('📄 comments:', checks[0].comments);
    console.log('📄 history:', checks[0].history);
  }
  
  res.status(200).json({
    success: true,
    data: {
      checks: checks,
      total: checks.length
    }
  });
});

// ─── Get a single check ────────────────────────────────────────────────────
exports.getCheck = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user._id;
  
  const check = await Check.findOne({ _id: id, userId }).lean();
  
  if (!check) {
    return next(new AppError('Check not found', 404));
  }
  
  console.log('🔍 Single check keys:', Object.keys(check));
  console.log('📄 requestedDocuments:', check.requestedDocuments);
  
  res.status(200).json({
    success: true,
    data: {
      check: check
    }
  });
});

// ─── Update check status ─────────────────────────────────────────────────────
exports.updateCheckStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status, result, note } = req.body;
  
  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }
  
  // Initialize history if it doesn't exist
  if (!check.history) {
    check.history = [];
  }
  
  // Add to history
  check.history.push({
    action: 'STATUS_UPDATED',
    note: note || `Status changed to ${status}`,
    at: new Date(),
    by: req.user._id,
    byRole: req.user.role || 'officer'
  });
  
  // Update status and result
  check.status = status;
  if (result) {
    check.result = result;
  }
  check.updatedAt = new Date();
  
  await check.save();
  
  // Fetch updated check with all fields
  const updatedCheck = await Check.findById(id).lean();
  
  res.status(200).json({
    success: true,
    data: { 
      check: updatedCheck,
      message: 'Status updated successfully'
    }
  });
});

// ─── Delete a check ──────────────────────────────────────────────────────────
exports.deleteCheck = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user._id;
  
  const check = await Check.findOneAndDelete({ _id: id, userId });
  
  if (!check) {
    return next(new AppError('Check not found', 404));
  }
  
  // Delete associated files
  for (const doc of check.documents) {
    try {
      const filePath = path.join(__dirname, '../../', doc.path);
      await fs.unlink(filePath);
    } catch (err) {
      console.warn('Failed to delete file:', doc.path);
    }
  }
  
  res.status(200).json({
    success: true,
    message: 'Check deleted successfully'
  });
});

// ─── ✅ Add comment ──────────────────────────────────────────────────────────
exports.addComment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { text } = req.body;
  const userId = req.user._id;
  const userRole = req.user.role || 'officer';

  if (!text || text.trim().length === 0) {
    return next(new AppError('Comment text is required', 400));
  }

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  if (!check.comments) {
    check.comments = [];
  }
  
  if (!check.history) {
    check.history = [];
  }

  check.comments.push({
    text: text.trim(),
    author: userId,
    role: userRole,
    createdAt: new Date()
  });
  
  // Add to history
  check.history.push({
    action: 'COMMENT_ADDED',
    note: text.trim().substring(0, 100),
    at: new Date(),
    by: userId,
    byRole: userRole
  });

  check.updatedAt = new Date();
  await check.save();

  // Fetch updated check with all fields
  const updatedCheck = await Check.findById(id).lean();

  console.log('✅ Comment added:', {
    checkId: id,
    commentCount: updatedCheck.comments?.length || 0
  });

  res.status(200).json({
    success: true,
    message: 'Comment added successfully',
    data: { 
      comments: updatedCheck.comments,
      check: updatedCheck
    }
  });
});

// ─── ✅ Request documents ────────────────────────────────────────────────────
exports.requestDocuments = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { documents } = req.body;
  const userId = req.user._id;
  const userRole = req.user.role || 'officer';

  if (!documents || documents.length === 0) {
    return next(new AppError('At least one document request is required', 400));
  }

  console.log('📤 Requesting documents for check:', { id, documentsCount: documents.length, userId });

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  // Initialize arrays if they don't exist
  if (!check.requestedDocuments) {
    check.requestedDocuments = [];
  }
  if (!check.history) {
    check.history = [];
  }

  // Add each document request
  const docs = documents.map(doc => ({
    label: doc.label || doc.documentType || 'Document',
    description: doc.description || '',
    requestedAt: new Date(),
    requestedBy: userId,
    status: 'pending'
  }));
  
  check.requestedDocuments.push(...docs);

  // Add to history
  check.history.push({
    action: 'DOCUMENTS_REQUESTED',
    note: `${documents.length} document(s) requested: ${documents.map(d => d.label || d.documentType).join(', ')}`,
    at: new Date(),
    by: userId,
    byRole: userRole
  });

  // Update status
  check.status = 'requires_documents';
  check.updatedAt = new Date();
  await check.save();

  // Fetch the updated check with all fields
  const updatedCheck = await Check.findById(id).lean();

  console.log('✅ Document requests saved:', {
    checkId: id,
    requestedDocuments: updatedCheck.requestedDocuments,
    requestedCount: updatedCheck.requestedDocuments?.length || 0,
    status: updatedCheck.status,
    history: updatedCheck.history
  });

  res.status(200).json({
    success: true,
    message: 'Document requests sent successfully',
    data: {
      check: updatedCheck,
      requestedDocuments: updatedCheck.requestedDocuments
    }
  });
});


// ─── ✅ DEBUG: Check requested documents for a specific check ──────────────
exports.debugCheck = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user._id;
  
  // Check if the user owns this check or is an admin
  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }
  
  // Allow if user owns the check or is admin/officer
  const isOwner = check.userId.toString() === userId.toString();
  const isOfficer = req.user.role === 'officer' || req.user.role === 'admin';
  
  if (!isOwner && !isOfficer) {
    return next(new AppError('You do not have permission to view this check', 403));
  }
  
  // Get the raw document from MongoDB
  const rawCheck = await Check.findById(id).lean();
  
  res.status(200).json({
    success: true,
    data: {
      check: rawCheck,
      hasRequestedDocuments: !!rawCheck.requestedDocuments,
      requestedDocumentsCount: rawCheck.requestedDocuments?.length || 0,
      requestedDocuments: rawCheck.requestedDocuments || [],
      status: rawCheck.status,
      allKeys: Object.keys(rawCheck)
    }
  });
});

// ─── ✅ Upload result ────────────────────────────────────────────────────────
exports.uploadResult = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { resultSummary, resultStatus } = req.body;
  const files = req.files || [];
  const userId = req.user._id;
  const userRole = req.user.role || 'officer';

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  if (!check.resultDocuments) {
    check.resultDocuments = [];
  }
  if (!check.history) {
    check.history = [];
  }

  files.forEach(file => {
    check.resultDocuments.push({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      path: `/uploads/checks/${file.filename}`,
      uploadedAt: new Date(),
      uploadedBy: userId
    });
  });

  if (resultSummary) {
    check.resultSummary = resultSummary;
  }

  if (resultStatus) {
    check.resultStatus = resultStatus;
  }

  // Add to history
  check.history.push({
    action: 'RESULT_UPLOADED',
    note: `Result uploaded with ${files.length} file(s)`,
    at: new Date(),
    by: userId,
    byRole: userRole
  });

  check.status = 'completed';
  check.updatedAt = new Date();
  await check.save();

  // Fetch updated check with all fields
  const updatedCheck = await Check.findById(id).lean();

  res.status(200).json({
    success: true,
    message: 'Result uploaded successfully',
    data: {
      check: updatedCheck,
      resultDocuments: updatedCheck.resultDocuments,
      resultSummary: updatedCheck.resultSummary,
      resultStatus: updatedCheck.resultStatus
    }
  });
});

// ─── ✅ Mark document as fulfilled ──────────────────────────────────────────
exports.fulfillDocument = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { documentIndex } = req.body;
  const userId = req.user._id;

  if (documentIndex === undefined || documentIndex === null) {
    return next(new AppError('Document index is required', 400));
  }

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  if (!check.requestedDocuments || documentIndex >= check.requestedDocuments.length) {
    return next(new AppError('Document not found', 404));
  }

  check.requestedDocuments[documentIndex].status = 'fulfilled';
  check.requestedDocuments[documentIndex].fulfilledAt = new Date();
  check.updatedAt = new Date();
  await check.save();

  const updatedCheck = await Check.findById(id).lean();

  res.status(200).json({
    success: true,
    message: 'Document marked as fulfilled',
    data: {
      check: updatedCheck,
      requestedDocuments: updatedCheck.requestedDocuments
    }
  });
});