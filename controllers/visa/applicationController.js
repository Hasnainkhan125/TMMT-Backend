const VisaApplication = require('../../model/schema/visaApplication');
const User = require('../../model/schema/user');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const appId = req.params.id || 'new';
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

const upload = multer({ storage });

const uploadMiddleware = upload.array('files', 10);

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
      history: [{ action: 'created', by: sponsorId, note: 'Application created' }]
    });

    return res.status(201).json({ application });
  } catch (err) {
    console.error('Create application error:', err);
    return res.status(500).json({ message: 'Failed to create application' });
  }
};

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

const getApplication = async (req, res) => {
  try {
    const application = await VisaApplication.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Not found' });
    return res.json({ application });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch application' });
  }
};

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

const requestDocuments = async (req, res) => {
  try {
    const { requested } = req.body; // array of strings
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

const uploadApplicationDocs = async (req, res) => {
  try {
    const files = req.files || [];
    const application = await VisaApplication.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Not found' });

    const attachments = files.map(f => ({ path: f.path, filename: f.originalname }));

    application.attachments.push(...attachments);
    application.history.push({ action: 'documents_uploaded', by: req.user?.userId, note: `${files.length} file(s) uploaded` });
    await application.save();

    return res.json({ application });
  } catch (err) {
    console.error('Upload docs error:', err);
    return res.status(500).json({ message: 'Failed to upload documents' });
  }
};

module.exports = {
  uploadMiddleware,
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
  submitApplication,
  requestDocuments,
  approveApplication,
  rejectApplication,
  uploadApplicationDocs
}; 