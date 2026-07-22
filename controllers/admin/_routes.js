const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');
const AuditLog = require('../../model/schema/auditLog');
const User = require('../../model/schema/user');
const VisaApplication = require('../../model/schema/visaApplication');
const Announcement = require('../../model/schema/announcement');
const BrandSubmission = require('../../model/schema/brandSubmission');

// Admin-only
router.use(auth, auth.requireRole('admin', 'amer'));

// Brand submissions / funnel tracking
router.get('/brand-submissions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.highIntent === 'true') filter.isHighIntent = true;
    if (req.query.hasEmail === 'true') filter.emailCaptured = true;

    const [submissions, total] = await Promise.all([
      BrandSubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      BrandSubmission.countDocuments(filter),
    ]);

    const stats = await BrandSubmission.aggregate([
      { $group: {
        _id: null,
        total: { $sum: 1 },
        withEmail: { $sum: { $cond: ['$emailCaptured', 1, 0] } },
        highIntent: { $sum: { $cond: ['$isHighIntent', 1, 0] } },
        licenseCTA: { $sum: { $cond: ['$tradeLicenseCTA', 1, 0] } },
        avgLaunchScore: { $avg: '$launchScore' },
      }},
    ]);

    res.json({ status: 'success', data: { submissions, total, pages: Math.ceil(total / limit), stats: stats[0] || {} } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/audit-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const logs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(limit).lean();
    res.json({ status: 'success', data: { logs } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

module.exports = router;
// Officer KPI metrics
router.get('/officers/metrics', async (req, res) => {
  try {
    // Average review times: using application history entries (submitted -> under_review/approved)
    const pipeline = [
      { $match: { 'metadata.assignedOfficer': { $exists: true, $ne: null } } },
      { $project: {
          officer: '$metadata.assignedOfficer',
          createdAt: 1,
          updatedAt: 1,
          status: 1,
          history: 1
      }},
      { $unwind: { path: '$history', preserveNullAndEmptyArrays: true } },
      { $group: {
          _id: '$officer',
          totalApplications: { $addToSet: '$_id' },
          reviews: { $push: { action: '$history.action', at: '$history.at' } }
      }},
      { $project: {
          applicationsCount: { $size: '$totalApplications' },
          avgReviewMs: {
            $avg: {
              $map: {
                input: '$reviews',
                as: 'r',
                in: 0
              }
            }
          }
      }}
    ];
    // Note: Placeholder for deeper computation. For brevity, return counts by officer.
    const byOfficer = await VisaApplication.aggregate([
      { $match: { 'metadata.assignedOfficer': { $exists: true, $ne: null } } },
      { $group: { _id: '$metadata.assignedOfficer', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    // SLA breaches: count docs_required older than 7 days
    const slaBreaches = await VisaApplication.aggregate([
      { $match: { status: 'docs_required', updatedAt: { $lte: new Date(Date.now() - 7*24*60*60*1000) } } },
      { $group: { _id: '$metadata.assignedOfficer', count: { $sum: 1 } } }
    ]);
    res.json({ status:'success', data: { byOfficer, slaBreaches } });
  } catch (e) { res.status(500).json({ status:'error', message:e.message }) }
});

// Admin actions: freeze/block user
router.post('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['active','frozen','blocked'].includes(status)) return res.status(400).json({ status:'error', message:'Invalid status' })
    const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!user) return res.status(404).json({ status:'error', message:'User not found' })
    await AuditLog.createEntry({ action:'OTHER', actor:{ type:req.user.role, id:String(req.user.userId||req.user._id) }, entity:{ type:'user', id:String(user._id), description:'Status change' }, diff:{ before:null, after:{ status } }, request_id: req.headers['x-request-id']||Date.now().toString(), result:'success' })
    res.json({ status:'success', data:{ user }})
  } catch(e){ res.status(500).json({ status:'error', message:e.message }) }
});

// Admin actions: freeze/block application
router.post('/applications/:id/access', async (req, res) => {
  try {
    const { accessStatus } = req.body || {};
    if (!['normal','frozen','blocked'].includes(accessStatus)) return res.status(400).json({ status:'error', message:'Invalid accessStatus' })
    const app = await VisaApplication.findByIdAndUpdate(req.params.id, { accessStatus }, { new: true });
    if (!app) return res.status(404).json({ status:'error', message:'Application not found' })
    await AuditLog.createEntry({ action:'OTHER', actor:{ type:req.user.role, id:String(req.user.userId||req.user._id) }, entity:{ type:'visa_application', id:String(app._id), description:'Access change' }, diff:{ before:null, after:{ accessStatus } }, request_id: req.headers['x-request-id']||Date.now().toString(), result:'success' })
    res.json({ status:'success', data:{ application: app }})
  } catch(e){ res.status(500).json({ status:'error', message:e.message }) }
});

// Announcements
router.get('/announcements', async (req, res) => {
  try {
    const now = new Date()
    const list = await Announcement.find({ active: true, $or: [{ startsAt: null }, { startsAt: { $lte: now } }], $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }).sort({ createdAt: -1 }).limit(10)
    res.json({ status:'success', data:{ announcements: list }})
  } catch (e) { res.status(500).json({ status:'error', message:e.message }) }
});
router.post('/announcements', async (req, res) => {
  try {
    const { title, message, level='info', locale='en', startsAt=null, endsAt=null, active=true } = req.body || {}
    const ann = await Announcement.create({ title, message, level, locale, startsAt, endsAt, active, createdBy: req.user.userId || req.user._id })
    res.json({ status:'success', data:{ announcement: ann }})
  } catch (e) { res.status(500).json({ status:'error', message:e.message }) }
});
router.post('/announcements/:id/toggle', async (req, res) => {
  try {
    const ann = await Announcement.findById(req.params.id)
    if (!ann) return res.status(404).json({ status:'error', message:'Not found' })
    ann.active = !ann.active; await ann.save();
    res.json({ status:'success', data:{ announcement: ann }})
  } catch (e) { res.status(500).json({ status:'error', message:e.message }) }
});

// Officers list with basic counts
router.get('/officers', async (req, res) => {
  try {
    const officers = await User.find({ role: 'amer' }).select('firstName lastName email status').lean();
    const counts = await VisaApplication.aggregate([
      { $match: { 'metadata.assignedOfficer': { $exists: true, $ne: null } } },
      { $group: { _id: '$metadata.assignedOfficer', count: { $sum: 1 }, byStatus: { $push: '$status' } } }
    ]);
    const countMap = new Map(counts.map(c => [String(c._id), c]));
    const data = officers.map(o => {
      const c = countMap.get(String(o._id)) || { count: 0, byStatus: [] };
      return { ...o, applicationsCount: c.count };
    });
    res.json({ status: 'success', data: { officers: data } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }) }
});

// Officer applications
router.get('/officers/:id/applications', async (req, res) => {
  try {
    const { status, stage, q } = req.query || {};
    const filter = { 'metadata.assignedOfficer': req.params.id };
    if (status) filter.status = status;
    if (stage) filter['metadata.govStage'] = stage;
    if (q) filter.$or = [
      { 'sponsor.firstName': new RegExp(q, 'i') },
      { 'sponsor.lastName': new RegExp(q, 'i') },
      { 'sponsor.email': new RegExp(q, 'i') }
    ];
    const apps = await VisaApplication.find(filter).sort('-createdAt').limit(200).lean();
    res.json({ status: 'success', data: { applications: apps } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }) }
});

// ─── Phase 8: Ops dashboard ────────────────────────────────────────────────
// Tighter gate than the rest of /admin (which also accepts visa 'amer'
// officers). Ops data includes finance rollups and per-user spend, so we
// scope it to admin/superadmin only.
const opsCtrl = require('./adminOpsController');
const requireAdminOnly = auth.requireRole('admin', 'superadmin');
router.get('/ops/overview',          requireAdminOnly, opsCtrl.getOverview);
router.get('/ops/jobs',              requireAdminOnly, opsCtrl.listJobs);
router.get('/ops/jobs/:id',          requireAdminOnly, opsCtrl.getJob);
router.get('/ops/credits/ledger',    requireAdminOnly, opsCtrl.listLedger);
router.get('/ops/credits/summary',   requireAdminOnly, opsCtrl.creditsSummary);
router.get('/ops/users/top-spenders',requireAdminOnly, opsCtrl.topSpenders);
router.get('/ops/scans',             requireAdminOnly, opsCtrl.listScans);
router.get('/ops/health',            requireAdminOnly, opsCtrl.health);

