'use strict';

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');
const { getAdIngestQueue } = require('../../services/queues');

async function ownedScan(req, id) {
  const scan = await UrlToAdsScan.findById(id);
  if (!scan) { const e = new Error('Scan not found.'); e.code = 'not_found'; throw e; }
  const owns =
    (req.user?._id && String(scan.userId) === String(req.user._id)) ||
    (scan.sessionId && scan.sessionId === (req.cookies?.qumak_session || req.headers['x-session-id']));
  if (!owns && scan.userId) { const e = new Error('forbidden'); e.code = 'forbidden'; throw e; }
  return scan;
}

function fail(res, err) {
  const map = { not_found: 404, forbidden: 403, bad_request: 400 };
  const status = map[err?.code] || 500;
  if (status === 500) console.error('[adIngestController]', err);
  return res.status(status).json({ success: false, error: err?.code || 'server_error', message: err?.message });
}

async function startIngest(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const { source, competitorName } = req.body || {};
    if (!source) {
      const e = new Error('source (video URL or CDN mp4) is required.'); e.code = 'bad_request'; throw e;
    }

    const queue = getAdIngestQueue();
    const job = await queue.add('ingest', {
      scanId: String(scan._id),
      source,
      competitorName: competitorName || null,
      intelligence: req.body.intelligence || {},
    }, { attempts: 1 });

    return res.json({ success: true, jobId: job.id, status: 'ingesting' });
  } catch (err) { return fail(res, err); }
}

async function ingestStatus(req, res) {
  try {
    await ownedScan(req, req.params.id);
    const queue = getAdIngestQueue();
    const job = await queue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'job_not_found' });

    const state = await job.getState();
    const result = job.returnvalue;

    const progress = job.progress;
    const phase = (progress && typeof progress === 'object' && progress.phase)
      ? String(progress.phase) : null;

    return res.json({
      success: true,
      status: state,
      phase,
      specId: result?.specId || null,
      error: state === 'failed' ? (job.failedReason || 'ingest_failed') : null,
    });
  } catch (err) { return fail(res, err); }
}

module.exports = { startIngest, ingestStatus };
