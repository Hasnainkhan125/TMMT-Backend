/**
 * syncShotJobToVideoAd.js — PHASE 2.
 *
 * When a child StudioJob finishes, its clip URL must land in the video ad
 * row's shotPlan. This mirrors how your image ads sync (jobId is the link),
 * but writes into shotPlan[i].clipUrl instead of ad.assetUrl, because a video
 * ad has N child clips, not one.
 *
 * Call this from the SAME place your worker calls syncStudioJobToUrlToAdsScan
 * for images — on job completion. Add a branch: if the job belongs to a video
 * ad's shotJobIds, route here instead of the image sync.
 *
 * When ALL shots are ready, flip the row to 'shots_ready' — that's Phase 3's
 * signal to show all clips, and Phase 4's trigger to stitch.
 */

const UrlToAdsScan = require('../model/schema/urlToAdsScan');   // adjust path

function clipUrlFromJob(job) {
  return (
    job?.output?.storedVideoUrl ||
    job?.output?.cleanUrl ||
    job?.output?.watermarkedUrl ||
    job?.output?.rawVideoUrl ||
    null
  );
}
 
async function syncShotJobToVideoAd(job) {
  const jobId = String(job._id || job.id);
 
  const scan = await UrlToAdsScan.findOne({ 'ads.shotJobIds': jobId });
  if (!scan) {
    console.warn('[syncShot] no scan has shotJobIds containing', jobId);
    return { matched: false };
  }
 
  const clipUrl = clipUrlFromJob(job);
  console.log('[syncShot]', jobId, '| clipUrl=', clipUrl, '| jobStatus=', job.status);
 
  let touchedRow = null;
  let allReady = false;
 
  scan.ads = (scan.ads || []).map((a) => {
    const ad = a.toObject ? a.toObject() : a;
    if (ad.kind !== 'video' || !Array.isArray(ad.shotJobIds)) return ad;
 
    const shotIndex = ad.shotJobIds.findIndex((jid) => String(jid) === jobId);
    if (shotIndex === -1) return ad;
 
    const failed = job.status === 'failed' || job.status === 'cancelled';
    const url = failed ? null : clipUrl;
 
    const shotPlan = (ad.shotPlan || []).map((sp) =>
      sp.index === shotIndex
        ? { ...sp, clipUrl: url || sp.clipUrl, status: failed ? 'failed' : (url ? 'ready' : sp.status) }
        : sp,
    );
 
    const everyReady = shotPlan.length > 0 && shotPlan.every((sp) => sp.status === 'ready');
    const anyFailed = shotPlan.some((sp) => sp.status === 'failed');
    const nextStatus = everyReady ? 'shots_ready' : anyFailed ? 'partial' : 'rendering';
 
    allReady = everyReady;
    touchedRow = { ...ad, shotPlan, status: nextStatus };
    return touchedRow;
  });
 
  scan.markModified('ads');
  await scan.save();

  // Stamp the originating spec as ready (if this adSet came from a spec confirm)
  const specIdx = (scan.adSpecs || []).findIndex(
    (s) => s.renderedAdSetId === touchedRow?.adSetId
  );
  if (specIdx !== -1) {
    scan.adSpecs[specIdx] = { ...scan.adSpecs[specIdx], status: 'ready', updatedAt: new Date().toISOString() };
    scan.markModified('adSpecs');
    await scan.save();
  }

  console.log('[syncShot] saved. row status=', touchedRow?.status,
    '| ready=', touchedRow?.shotPlan?.filter(s => s.status === 'ready').length,
    '/', touchedRow?.shotPlan?.length);
 
  return { matched: true, allReady, scanId: String(scan._id), adRow: touchedRow };
}
 
module.exports = { syncShotJobToVideoAd, clipUrlFromJob };