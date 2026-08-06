const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const PackageApplication = require('../../model/schema/packageApplication');
const { v4: uuidv4 } = require('uuid');

// ─── Submit package application ────────────────────────────────
exports.submitPackageApplication = catchAsync(async (req, res, next) => {
  const { packageSlug, packageName, applicantType, contact, pricing, user_id } = req.body;

  if (!packageSlug || !contact?.fullName || !contact?.phone) {
    return next(new AppError('Missing required fields', 400));
  }

  const referenceId = `PKG-${Date.now().toString(36).toUpperCase()}-${uuidv4().slice(0, 6)}`;

  const application = await PackageApplication.create({
    packageSlug,
    packageName,
    applicantType: applicantType || 'outside',
    contact,
    pricing,
    user_id: user_id || req.user?._id,
    referenceId,
    status: 'submitted',
  });

  res.status(201).json({
    status: 'success',
    data: {
      application,
      referenceId: application.referenceId,
      _id: application._id,
    },
  });
});

// ─── Upload documents (placeholder) ────────────────────────────
exports.uploadPackageDocuments = catchAsync(async (req, res, next) => {
  res.status(200).json({ status: 'success', message: 'Documents upload endpoint ready' });
});

// ─── Admin: list all applications ──────────────────────────────
exports.getPackageApplications = catchAsync(async (req, res, next) => {
  if (!req.user || (req.user.role !== 'amer' && req.user.role !== 'admin')) {
    return next(new AppError('Unauthorized', 403));
  }

  const { status, q } = req.query;
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (q) {
    filter.$or = [
      { 'contact.fullName': { $regex: q, $options: 'i' } },
      { referenceId: { $regex: q, $options: 'i' } },
      { 'contact.phone': { $regex: q, $options: 'i' } },
    ];
  }

  const applications = await PackageApplication.find(filter).sort({ createdAt: -1 });
  res.status(200).json({ status: 'success', data: { applications } });
});

// ─── Customer: get their own applications ──────────────────────
exports.getMyPackageApplications = catchAsync(async (req, res, next) => {
  const userId = req.user?._id;
  if (!userId) return next(new AppError('User not authenticated', 401));

  const applications = await PackageApplication.find({ user_id: userId }).sort({ createdAt: -1 });
  res.status(200).json({ status: 'success', data: { applications } });
});

// ─── Update status (admin only) ────────────────────────────────
exports.updatePackageStatus = catchAsync(async (req, res, next) => {
  if (!req.user || (req.user.role !== 'amer' && req.user.role !== 'admin')) {
    return next(new AppError('Unauthorized', 403));
  }

  const { status, note } = req.body;
  const application = await PackageApplication.findById(req.params.applicationId);
  if (!application) return next(new AppError('Application not found', 404));

  application.status = status;
  if (note) {
    application.history = application.history || [];
    application.history.push({ action: 'status_updated', note, by: req.user._id });
  }
  await application.save();

  res.status(200).json({ status: 'success', data: { application } });
});

// ─── Request additional documents ──────────────────────────────
exports.requestDocuments = catchAsync(async (req, res, next) => {
  if (!req.user || (req.user.role !== 'amer' && req.user.role !== 'admin')) {
    return next(new AppError('Unauthorized', 403));
  }

  const { documents = [], note } = req.body;
  const application = await PackageApplication.findById(req.params.applicationId);
  if (!application) return next(new AppError('Application not found', 404));

  const requested = documents.map((doc) => ({
    label: doc.label,
    description: doc.description || note || '',
    requestedAt: new Date(),
    status: 'pending',
  }));
  application.requestedDocuments = application.requestedDocuments || [];
  application.requestedDocuments.push(...requested);
  await application.save();

  res.status(200).json({ status: 'success', data: { requestedDocuments: requested } });
});

// ─── Add a comment ──────────────────────────────────────────────
exports.addComment = catchAsync(async (req, res, next) => {
  const { message } = req.body;
  if (!message) return next(new AppError('Message is required', 400));

  const application = await PackageApplication.findById(req.params.applicationId);
  if (!application) return next(new AppError('Application not found', 404));

  application.comments = application.comments || [];
  application.comments.push({
    message,
    by: req.user?.role === 'amer' || req.user?.role === 'admin' ? 'admin' : 'customer',
    authorName: req.user?.firstName || req.user?.email || 'User',
    at: new Date(),
  });
  await application.save();

  res.status(200).json({ status: 'success', data: { comment: application.comments[application.comments.length - 1] } });
});

// ─── Update payment info ────────────────────────────────────────
exports.updatePayment = catchAsync(async (req, res, next) => {
  if (!req.user || (req.user.role !== 'amer' && req.user.role !== 'admin')) {
    return next(new AppError('Unauthorized', 403));
  }

  const { status, paymentLink, paidAmount, provider, transactionId } = req.body;
  const application = await PackageApplication.findById(req.params.applicationId);
  if (!application) return next(new AppError('Application not found', 404));

  application.payment = application.payment || {};
  if (status) application.payment.status = status;
  if (paymentLink) application.payment.paymentLink = paymentLink;
  if (paidAmount) application.payment.paidAmount = paidAmount;
  if (provider) application.payment.provider = provider;
  if (transactionId) application.payment.transactionId = transactionId;
  if (status === 'paid') application.payment.paidAt = new Date();

  await application.save();
  res.status(200).json({ status: 'success', data: { application } });
});

// ─── Download document (placeholder) ────────────────────────────
exports.downloadDocument = catchAsync(async (req, res, next) => {
  res.status(200).json({ status: 'success', message: 'Download endpoint placeholder' });
});

// ─── DELETE package application ────────────────────────────────
exports.deletePackageApplication = catchAsync(async (req, res, next) => {
  // 1. Check authentication
  if (!req.user) {
    return next(new AppError('You must be logged in', 401));
  }

  // 2. Check authorization: admin/amer OR owner
  const application = await PackageApplication.findById(req.params.applicationId);
  if (!application) {
    return next(new AppError('Package application not found', 404));
  }

  const isOwner = application.user_id?.toString() === req.user._id?.toString();
  const isAdmin = req.user.role === 'admin' || req.user.role === 'amer';

  if (!isOwner && !isAdmin) {
    return next(new AppError('You do not have permission to delete this package', 403));
  }

  // 3. Delete
  await application.deleteOne();

  res.status(200).json({
    status: 'success',
    message: 'Package application deleted successfully'
  });
});