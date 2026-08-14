'use strict';

/**
 * adminOpsController — Phase 8 operational dashboard API.
 *
 * Everything here is read-mostly and aggregation-heavy. It lives under
 * /api/v1/admin/ops/* and is gated by requireRole('admin','superadmin').
 *
 * Surfaces:
 *   GET  /ops/overview           → 24h/7d/30d rollups for the hero dashboard
 *   GET  /ops/jobs               → paginated StudioJob list with filters
 *   GET  /ops/jobs/:id           → one job with stages + ledger entries
 *   GET  /ops/credits/ledger     → global ledger search
 *   GET  /ops/credits/summary    → reason × window aggregation
 *   GET  /ops/users/top-spenders → top N by credits burned
 *   GET  /ops/scans              → Phase-7 URL→Ads scans, admin view
 *   GET  /ops/health             → worker / queue / counters
 *
 * We keep responses shaped as { success: true, ... } for consistency with
 * the rest of the Qumak API (makes the existing axios interceptors happy).
 */

const mongoose     = require('mongoose');
const StudioJob    = require('../../model/schema/studioJob');
const CreditLedger = require('../../model/schema/creditLedger');
const User         = require('../../model/schema/user');
const DailyStat    = require('../../model/schema/dailyStat');
const metrics      = require('../../utils/metrics');

let UrlToAdsScan = null;
try { UrlToAdsScan = require('../../model/schema/urlToAdsScan'); } catch (_e) { /* optional */ }

// ─── helpers ────────────────────────────────────────────────────────────────

function daysAgo(n) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000); }
function hoursAgo(n) { return new Date(Date.now() - n * 60 * 60 * 1000); }

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: 'bad_request', message });
}

function serverError(res, err, req) {
  req?.log?.error({ err }, 'admin_ops_error');
  return res.status(500).json({
    success: false,
    error: 'server_error',
    message: err?.message || 'Internal error',
  });
}

// ─── GET /ops/overview ──────────────────────────────────────────────────────
// Hero dashboard tile data. One parallel fan-out of aggregations, all
// scoped to the requested window (default 30d). Prefer a single handler
// over many narrow ones because the UI renders them all at once.
exports.getOverview = async (req, res) => {
  try {
    const windowDays = clampInt(req.query.windowDays, 1, 365, 30);
    const since = daysAgo(windowDays);
    const since24h = hoursAgo(24);

    const [
      // Credits ledger rollups — sold vs burned
      creditsByReason,
      // Jobs — status split inside the window
      jobsByStatus,
      // Jobs — 24h activity pulse
      jobs24h,
      // Typical success rates + durations, completed only
      completedStats,
      // Fal.ai cost telemetry (from DailyStat if the worker wrote it)
      dailyCosts,
      // URL→Ads funnel (optional)
      scanRollup,
      // Active users (last 24h)
      activeUsers24h,
    ] = await Promise.all([
      CreditLedger.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$reason', total: { $sum: '$delta' }, count: { $sum: 1 } } },
      ]),
      StudioJob.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      StudioJob.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        { $group: {
          _id: null,
          total:     { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed:    { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        } },
      ]),
      StudioJob.aggregate([
        { $match: { createdAt: { $gte: since }, status: 'completed' } },
        { $group: {
          _id: null,
          avgDurationMs: { $avg: '$totalPipelineTimeMs' },
          p95DurationMs: { $max: '$totalPipelineTimeMs' },   // cheap proxy; real p95 needs $percentile (Mongo 7+)
          totalJobs:     { $sum: 1 },
          totalFalCost:  { $sum: '$falCostUsd' },
        } },
      ]),
      DailyStat.find({ date: { $gte: since.toISOString().split('T')[0] } })
        .sort({ date: -1 })
        .limit(windowDays)
        .lean(),
      UrlToAdsScan
        ? UrlToAdsScan.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
      StudioJob.distinct('userId', { createdAt: { $gte: since24h }, userId: { $ne: null } }),
    ]);

    // Partition credit movements into sold (positive topups) vs burned
    // (negative charges). Refunds bump 'reversed' so finance can see
    // gross vs net.
    const creditsRollup = { sold: 0, burned: 0, reversed: 0, byReason: {} };
    for (const row of creditsByReason) {
      const reason = row._id;
      creditsRollup.byReason[reason] = { total: row.total, count: row.count };
      if (reason.startsWith('topup_'))   creditsRollup.sold     += row.total;
      if (reason.startsWith('charge_'))  creditsRollup.burned   += Math.abs(row.total);
      if (reason.startsWith('refund_'))  creditsRollup.reversed += row.total;
    }

    const jobsStatusMap = Object.fromEntries(jobsByStatus.map((r) => [r._id, r.count]));
    const j24 = jobs24h[0] || { total: 0, completed: 0, failed: 0 };
    const cStats = completedStats[0] || { avgDurationMs: 0, p95DurationMs: 0, totalJobs: 0, totalFalCost: 0 };

    return res.json({
      success: true,
      windowDays,
      since: since.toISOString(),
      credits: creditsRollup,
      jobs: {
        byStatus: jobsStatusMap,
        total: Object.values(jobsStatusMap).reduce((a, b) => a + b, 0),
        last24h: j24,
        successRatePct: j24.total
          ? Math.round(((j24.completed) / j24.total) * 1000) / 10
          : 0,
        avgDurationMs: Math.round(cStats.avgDurationMs || 0),
        maxDurationMs: Math.round(cStats.p95DurationMs || 0),
        totalFalCostUsd: Math.round((cStats.totalFalCost || 0) * 100) / 100,
      },
      scans: {
        byStatus: Object.fromEntries(scanRollup.map((r) => [r._id, r.count])),
        total:    scanRollup.reduce((acc, r) => acc + r.count, 0),
      },
      dailyCosts: dailyCosts.map((d) => ({
        date: d.date,
        jobs: d.totalJobs || 0,
        completed: d.completedJobs || 0,
        failed: d.failedJobs || 0,
        falCostUsd: d.totalFalCost || 0,
      })),
      activeUsers24h: activeUsers24h.length,
    });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/jobs ──────────────────────────────────────────────────────────
// Filters: status, kind, userId, sessionId, since(days). Sort by createdAt desc.
exports.listJobs = async (req, res) => {
  try {
    const limit  = clampInt(req.query.limit, 1, 200, 50);
    const page   = clampInt(req.query.page, 1, 10000, 1);
    const skip   = (page - 1) * limit;

    const filter = {};
    if (req.query.status)    filter.status    = req.query.status;
    if (req.query.kind)      filter.kind      = req.query.kind;
    if (req.query.userId && mongoose.isValidObjectId(req.query.userId))
      filter.userId = new mongoose.Types.ObjectId(req.query.userId);
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;
    if (req.query.sinceDays) filter.createdAt = { $gte: daysAgo(clampInt(req.query.sinceDays, 1, 365, 7)) };

    const [rows, total] = await Promise.all([
      StudioJob.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('_id userId sessionId kind status progress statusMessage templateId modelId variantIndex parentJobId creditsCharged creditsRefunded totalPipelineTimeMs falCostUsd startedAt completedAt createdAt error.message')
        .lean(),
      StudioJob.countDocuments(filter),
    ]);

    return res.json({ success: true, total, page, limit, jobs: rows });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/jobs/:id ──────────────────────────────────────────────────────
exports.getJob = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return badRequest(res, 'Invalid job id.');

    const job = await StudioJob.findById(id).lean();
    if (!job) return res.status(404).json({ success: false, error: 'not_found' });

    const [ledger, user, children] = await Promise.all([
      CreditLedger.find({ jobId: job._id }).sort({ createdAt: -1 }).lean(),
      job.userId ? User.findById(job.userId).select('email name role platformCredits').lean() : null,
      StudioJob.find({ parentJobId: job._id })
        .select('_id status progress variantIndex creditsCharged output.variants output.url error.message createdAt completedAt')
        .lean(),
    ]);

    return res.json({ success: true, job, ledger, user, children });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/credits/ledger ────────────────────────────────────────────────
exports.listLedger = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const page  = clampInt(req.query.page, 1, 10000, 1);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.reason) filter.reason = req.query.reason;
    if (req.query.userId && mongoose.isValidObjectId(req.query.userId))
      filter.userId = new mongoose.Types.ObjectId(req.query.userId);
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;
    if (req.query.sinceDays) filter.createdAt = { $gte: daysAgo(clampInt(req.query.sinceDays, 1, 365, 30)) };
    if (req.query.sign === 'in')  filter.delta = { $gt: 0 };
    if (req.query.sign === 'out') filter.delta = { $lt: 0 };

    const [rows, total] = await Promise.all([
      CreditLedger.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'email name')
        .lean(),
      CreditLedger.countDocuments(filter),
    ]);

    return res.json({ success: true, total, page, limit, ledger: rows });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/credits/summary ───────────────────────────────────────────────
exports.creditsSummary = async (req, res) => {
  try {
    const windowDays = clampInt(req.query.windowDays, 1, 365, 30);
    const since = daysAgo(windowDays);

    const rows = await CreditLedger.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: {
        _id: { reason: '$reason', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
        total: { $sum: '$delta' },
        count: { $sum: 1 },
      } },
      { $sort: { '_id.day': 1 } },
    ]);

    // Pivot to { day: { reason: total, ... } } — easier to stack-chart in UI.
    const byDay = {};
    const byReason = {};
    for (const r of rows) {
      const d = r._id.day, rn = r._id.reason;
      byDay[d]     = byDay[d]     || {};
      byDay[d][rn] = r.total;
      byReason[rn] = (byReason[rn] || 0) + r.total;
    }

    return res.json({ success: true, windowDays, byDay, byReason });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/users/top-spenders ────────────────────────────────────────────
exports.topSpenders = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 100, 20);
    const windowDays = clampInt(req.query.windowDays, 1, 365, 30);

    const rows = await CreditLedger.aggregate([
      { $match: {
        createdAt: { $gte: daysAgo(windowDays) },
        delta: { $lt: 0 },
        userId: { $ne: null },
        reason: { $in: ['charge_studio_image', 'charge_studio_video'] },
      } },
      { $group: {
        _id: '$userId',
        burned: { $sum: { $abs: '$delta' } },
        jobs:   { $sum: 1 },
      } },
      { $sort: { burned: -1 } },
      { $limit: limit },
      { $lookup: {
        from: 'users', localField: '_id', foreignField: '_id', as: 'user',
      } },
      { $project: {
        _id: 1, burned: 1, jobs: 1,
        email: { $arrayElemAt: ['$user.email', 0] },
        name:  { $arrayElemAt: ['$user.name',  0] },
        platformCredits: { $arrayElemAt: ['$user.platformCredits', 0] },
      } },
    ]);

    return res.json({ success: true, windowDays, users: rows });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/scans ─────────────────────────────────────────────────────────
exports.listScans = async (req, res) => {
  if (!UrlToAdsScan) return res.json({ success: true, total: 0, scans: [] });
  try {
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const page  = clampInt(req.query.page, 1, 10000, 1);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.userId && mongoose.isValidObjectId(req.query.userId))
      filter.userId = new mongoose.Types.ObjectId(req.query.userId);

    const [rows, total] = await Promise.all([
      UrlToAdsScan.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('_id userId sessionId url host brand.name brand.category status adSetId freeTrialConsumed createdAt')
        .lean(),
      UrlToAdsScan.countDocuments(filter),
    ]);

    return res.json({ success: true, total, page, limit, scans: rows });
  } catch (err) { return serverError(res, err, req); }
};

// ─── GET /ops/health ────────────────────────────────────────────────────────
// Surface worker heartbeat, queue depth, and counter snapshots. We keep
// this intentionally cheap — called as often as every 5s by the dashboard.
exports.health = async (req, res) => {
  try {
    const [queued, inFlight, failedLast1h] = await Promise.all([
      StudioJob.countDocuments({ status: 'queued' }),
      StudioJob.countDocuments({ status: { $in: ['generating', 'postprocessing'] } }),
      StudioJob.countDocuments({ status: 'failed', createdAt: { $gte: hoursAgo(1) } }),
    ]);

    const counterSnapshot = {};
    for (const row of metrics._counters.values()) {
      const key = row.name;
      counterSnapshot[key] = (counterSnapshot[key] || 0) + row.value;
    }

    return res.json({
      success: true,
      queue: { queued, inFlight, failedLast1h },
      counters: counterSnapshot,
      process: {
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        nodeVersion: process.version,
        memRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      worker: {
        // The worker runs in-process in dev; in prod it's a separate proc.
        inProcess: process.env.STUDIO_WORKER_INPROC !== 'false' && process.env.NODE_ENV !== 'test',
      },
    });
  } catch (err) { return serverError(res, err, req); }
};
