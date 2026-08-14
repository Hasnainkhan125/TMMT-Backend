// controllers/checkController.js

const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const Check = require('../../model/schema/check');
const mongoose = require('mongoose');
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
    requestedDocuments: [],
    resultDocuments: [],
    comments: [],
    history: [{
      action: 'CHECK_CREATED',
      note: `Check created for ${serviceType}`,
      at: new Date(),
      by: userId,
      byRole: 'customer'
    }]
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
  const { text, message } = req.body;
  const userId = req.user._id;
  const userRole = req.user.role || 'customer';

  const commentText = text || message;

  if (!commentText || commentText.trim().length === 0) {
    return next(new AppError('Comment text is required', 400));
  }

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  const isOwner = check.userId.toString() === userId.toString();
  
  // ─── FIX: Allow admin, officer, and amer roles ──────────────────────────
  const allowedRoles = ['admin', 'officer', 'amer'];
  const isOfficer = allowedRoles.includes(req.user.role);

  if (!isOwner && !isOfficer) {
    return next(new AppError('You do not have permission to comment on this check', 403));
  }

  if (!check.comments) {
    check.comments = [];
  }
  
  if (!check.history) {
    check.history = [];
  }

  const isAdmin = isOfficer;
  const commentBy = isAdmin ? 'admin' : 'customer';
  const authorName = req.user.firstName || req.user.email || (isAdmin ? 'Admin' : 'You');

  const comment = {
    _id: new mongoose.Types.ObjectId(),
    text: commentText.trim(),
    message: commentText.trim(),
    by: commentBy,
    authorName: authorName,
    author: userId,
    role: userRole,
    createdAt: new Date(),
    at: new Date()
  };

  check.comments.push(comment);
  
  check.history.push({
    action: 'COMMENT_ADDED',
    note: `${authorName} added a comment: ${commentText.trim().substring(0, 50)}${commentText.length > 50 ? '...' : ''}`,
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
      comment: comment,
      comments: updatedCheck.comments,
      check: updatedCheck
    }
  });
});

// ─── DELETE COMMENT ──────────────────────────────────────────────────────────
exports.deleteComment = catchAsync(async (req, res, next) => {
  const { id, commentId } = req.params;
  const userId = req.user._id;

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  if (!check.comments || check.comments.length === 0) {
    return next(new AppError('No comments found', 404));
  }

  const commentIndex = check.comments.findIndex(c => 
    c._id && c._id.toString() === commentId
  );

  if (commentIndex === -1) {
    return next(new AppError('Comment not found', 404));
  }

  const comment = check.comments[commentIndex];
  const isOwner = check.userId.toString() === userId.toString();
  const isAdmin = req.user.role === 'admin' || req.user.role === 'officer';
  const isCommentAuthor = comment.author && comment.author.toString() === userId.toString();

  if (!isOwner && !isAdmin && !isCommentAuthor) {
    return next(new AppError('You do not have permission to delete this comment', 403));
  }

  check.comments.splice(commentIndex, 1);

  if (!check.history) {
    check.history = [];
  }
  check.history.push({
    action: 'COMMENT_DELETED',
    note: `Comment deleted by ${req.user.email || 'User'}`,
    at: new Date(),
    by: userId,
    byRole: req.user.role || 'customer'
  });

  check.updatedAt = new Date();
  await check.save();

  const updatedCheck = await Check.findById(id).lean();

  res.status(200).json({
    success: true,
    message: 'Comment deleted successfully',
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

  // ─── FIX: Allow admin, officer, and amer roles ──────────────────────────
  const allowedRoles = ['admin', 'officer', 'amer'];
  const isAllowed = allowedRoles.includes(req.user.role);
  
  // Also allow if user is the owner of the check
  const isOwner = check.userId.toString() === userId.toString();

  if (!isAllowed && !isOwner) {
    console.log('❌ Permission denied. User role:', req.user.role, 'User ID:', userId);
    return next(new AppError(
      'You do not have permission to request documents. Only admin, officer, or amer can request documents.',
      403
    ));
  }

  // Initialize arrays if they don't exist
  if (!check.requestedDocuments) {
    check.requestedDocuments = [];
  }
  if (!check.history) {
    check.history = [];
  }

  // Add each document request with proper _id
  const docs = documents.map(doc => ({
    _id: new mongoose.Types.ObjectId(),
    label: doc.label || doc.documentType || 'Document',
    description: doc.description || '',
    requestedAt: new Date(),
    requestedBy: userId,
    status: 'pending',
    fulfilledAt: null,
    documentId: null
  }));
  
  check.requestedDocuments.push(...docs);

  // Add to history
  check.history.push({
    action: 'DOCUMENTS_REQUESTED',
    note: `${documents.length} document(s) requested: ${documents.map(d => d.label || d.documentType).join(', ')}`,
    at: new Date(),
    by: userId,
    byRole: req.user.role || 'officer'
  });

  // Update status to requires_documents
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
      comments: rawCheck.comments || [],
      history: rawCheck.history || [],
      status: rawCheck.status,
      allKeys: Object.keys(rawCheck)
    }
  });
});

// ─── ✅ Upload result ────────────────────────────────────────────────────────
exports.uploadResult = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { resultSummary, resultStatus } = req.body;
  
  // ─── Handle files properly ─────────────────────────────────────────────
  let files = [];
  
  if (req.files) {
    if (Array.isArray(req.files)) {
      files = req.files;
    } else if (typeof req.files === 'object') {
      Object.keys(req.files).forEach(key => {
        if (Array.isArray(req.files[key])) {
          files = files.concat(req.files[key]);
        }
      });
    }
  } else if (req.file) {
    files = [req.file];
  }

  console.log('📤 Uploading result for check:', { id, resultSummary, resultStatus, fileCount: files.length });

  const userId = req.user._id;
  const userRole = req.user.role || 'officer';

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  // ─── FIX: Allow admin, officer, and amer roles ──────────────────────────
  const allowedRoles = ['admin', 'officer', 'amer'];
  const isAllowed = allowedRoles.includes(req.user.role);
  
  if (!isAllowed) {
    console.log('❌ Permission denied for upload result. User role:', req.user.role);
    return next(new AppError(
      'You do not have permission to upload results. Only admin, officer, or amer can upload results.',
      403
    ));
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
  const { documentId } = req.body;
  const userId = req.user._id;

  if (!documentId) {
    return next(new AppError('Document ID is required', 400));
  }

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  // Find the document by _id
  const docIndex = check.requestedDocuments.findIndex(
    doc => doc._id && doc._id.toString() === documentId
  );

  if (docIndex === -1) {
    return next(new AppError('Document not found', 404));
  }

  check.requestedDocuments[docIndex].status = 'fulfilled';
  check.requestedDocuments[docIndex].fulfilledAt = new Date();
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

// ─── ✅ NEW: Upload a document (user uploads for a check) ──────────────────
exports.uploadDocument = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user._id;
  const file = req.file; // single file

  if (!file) {
    return next(new AppError('No file uploaded', 400));
  }

  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }

  // Check ownership: only the user who created the check can upload
  if (check.userId.toString() !== userId.toString()) {
    return next(new AppError('You are not authorized to upload to this check', 403));
  }

  // Initialize documents array if needed
  if (!check.documents) {
    check.documents = [];
  }

  // Add the new document
  const newDoc = {
    filename: file.filename,
    originalName: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
    path: `/uploads/checks/${file.filename}`,
  };
  check.documents.push(newDoc);

  // Optionally, if a documentLabel was provided, mark a requested document as fulfilled
  const documentLabel = req.body.documentLabel;
  if (documentLabel && check.requestedDocuments && check.requestedDocuments.length > 0) {
    const requestedDoc = check.requestedDocuments.find(
      d => d.label === documentLabel && d.status === 'pending'
    );
    if (requestedDoc) {
      requestedDoc.status = 'fulfilled';
      requestedDoc.fulfilledAt = new Date();
    }
  }

  // Add to history
  if (!check.history) {
    check.history = [];
  }
  check.history.push({
    action: 'DOCUMENT_UPLOADED',
    note: `User uploaded document: ${file.originalname}`,
    at: new Date(),
    by: userId,
    byRole: 'user',
  });

  // If the check status is 'requires_documents' and all requested docs are fulfilled, update status
  if (check.status === 'requires_documents' && check.requestedDocuments && check.requestedDocuments.length > 0) {
    const allFulfilled = check.requestedDocuments.every(d => d.status === 'fulfilled');
    if (allFulfilled) {
      check.status = 'processing';
      check.history.push({
        action: 'STATUS_UPDATED',
        note: 'All requested documents fulfilled, moving to processing',
        at: new Date(),
        by: userId,
        byRole: 'user',
      });
    }
  }

  check.updatedAt = new Date();
  await check.save();

  // Fetch updated check
  const updatedCheck = await Check.findById(id).lean();

  console.log('📎 Document uploaded:', {
    checkId: id,
    filename: file.filename,
    originalName: file.originalname,
    documentLabel: documentLabel || 'none',
  });

  res.status(200).json({
    success: true,
    message: 'Document uploaded successfully',
    data: {
      check: updatedCheck,
      document: newDoc,
    },
  });
});

// ─── ✅ UPDATE check (update entire check document) ──────────────────────────
exports.updateCheck = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updates = req.body;
  const userId = req.user._id;
  
  console.log('🔄 Updating check:', { id, updates });
  
  const check = await Check.findById(id);
  if (!check) {
    return next(new AppError('Check not found', 404));
  }
  
  // Check if user owns this check or is an admin/officer
  const isOwner = check.userId.toString() === userId.toString();
  const isOfficer = req.user.role === 'officer' || req.user.role === 'admin';
  
  if (!isOwner && !isOfficer) {
    return next(new AppError('You do not have permission to update this check', 403));
  }
  
  // Apply updates
  if (updates.requestedDocuments !== undefined) {
    check.requestedDocuments = updates.requestedDocuments;
  }
  if (updates.comments !== undefined) {
    check.comments = updates.comments;
  }
  if (updates.status) {
    check.status = updates.status;
  }
  if (updates.resultSummary !== undefined) {
    check.resultSummary = updates.resultSummary;
  }
  if (updates.resultStatus !== undefined) {
    check.resultStatus = updates.resultStatus;
  }
  if (updates.resultDocuments !== undefined) {
    check.resultDocuments = updates.resultDocuments;
  }
  if (updates.documents !== undefined) {
    check.documents = updates.documents;
  }
  if (updates.identifiers !== undefined) {
    check.identifiers = updates.identifiers;
  }
  if (updates.serviceType !== undefined) {
    check.serviceType = updates.serviceType;
  }
  if (updates.speedTier !== undefined) {
    check.speedTier = updates.speedTier;
  }
    
  
  // Add to history for any update
  if (!check.history) {
    check.history = [];
  }
  check.history.push({
    action: 'CHECK_UPDATED',
    note: 'Check information was updated',
    at: new Date(),
    by: userId,
    byRole: req.user.role || 'officer'
  });
  
  check.updatedAt = new Date();
  await check.save();
  
  // Fetch updated check
  const updatedCheck = await Check.findById(id).lean();
  
  console.log('✅ Check updated successfully:', { id });
  
  res.status(200).json({
    success: true,
    message: 'Check updated successfully',
    data: {
      check: updatedCheck
    }
  });
});