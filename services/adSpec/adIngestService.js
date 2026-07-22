'use strict';

/**
 * adIngestService.js — Node orchestration for the competitor-ad ingest stage.
 *
 * Bridges the Python worker (adIngest.py) into your existing teardown:
 *
 *   competitor URL ──adIngest.py──▶ manifest {audio, scenes, frames, transcript}
 *                  ──vision-LLM───▶ visual notes
 *                  ──teardownToSpec─▶ draft adSpec  (your existing module)
 *
 * Designed to run inside a BullMQ worker (you already use BullMQ + the
 * adSetService fan-out). Frames are uploaded to R2 so the vision-LLM can see
 * them and so the report UI can show "what we tore down".
 *
 * Everything fails safe: if vision/transcribe degrade, the spec still builds
 * from whatever signal exists (heuristic classify) — the funnel never blocks.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const execFileP = promisify(execFile);

const { teardownToSpec, regenerateCopy } = require('./adSpecTeardown');

// Inject your real deps. Kept optional so this module is testable offline.
let _uploadToR2 = null;        // ({ localPath, key, contentType }) => Promise<url|null>
let _uploadBufferToR2 = null;  // ({ buffer, key, contentType }) => Promise<url|null>
let callLLM = null;
let callVisionLLM = null;
try {
  const s = require('../storageService');
  _uploadToR2 = s.uploadToR2;
  _uploadBufferToR2 = s.uploadBufferToR2;
} catch {}
try { callLLM = require('../llm/callHaiku').callHaiku; } catch {}
try { callVisionLLM = require('../llm/callVision').callVision; } catch {}

// Thin wrappers so call-sites stay readable
const uploadFile = (localPath, key, contentType = 'application/octet-stream') =>
  _uploadToR2 ? _uploadToR2({ localPath, key, contentType }) : Promise.resolve(null);

const PY = process.env.PYTHON_BIN || 'python3';
const WORKER = path.join(__dirname, 'adIngest.py');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

/**
 * runIngestWorker — shells out to adIngest.py, returns the parsed manifest.
 * @param {string} source  competitor ad URL or local/CDN mp4
 * @param {object} opts     { maxFrames, allowDownload, model }
 */
async function runIngestWorker(source, opts = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qumak-ingest-'));
  const args = [
    WORKER, '--source', source, '--out', outDir,
    '--model', opts.model || WHISPER_MODEL,
    '--max-frames', String(opts.maxFrames || 8),
  ];
  if (opts.allowDownload === false) args.push('--no-download');

  try {
    await execFileP(PY, args, { maxBuffer: 1024 * 1024 * 50, timeout: 1000 * 60 * 8 });
  } catch (e) {
    // worker prints JSON error to stderr; surface it (don't swallow — the lesson)
    const msg = (e.stderr || e.message || '').trim();
    const err = new Error(`ingest_worker_failed: ${msg}`);
    err.code = 'ingest_failed';
    err.outDir = outDir;
    throw err;
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest._outDir = outDir;
  return manifest;
}

/**
 * uploadFrames — push sampled frames to R2 so the vision-LLM (and the UI) can
 * see them. Returns the manifest frames with public URLs attached.
 */
async function uploadFrames(manifest, { scanId, specHint = 'teardown' }) {
  const out = [];
  for (const f of manifest.frames) {
    try {
      const key = `teardowns/${scanId}/${specHint}/scene_${f.sceneIndex}.jpg`;
      const url = await uploadFile(f.path, key, 'image/jpeg');
      out.push({ ...f, url });
    } catch (e) {
      out.push({ ...f, url: null });
    }
  }
  return out;
}

/**
 * reserveSourceAssets — upload the raw source video + per-beat audio slices
 * to private R2 for later user replay and fine editing.
 * Returns { sourceVideoR2Key, audioSegments[] }
 */
async function reserveSourceAssets(manifest, { scanId, specId }) {
  const result = { sourceVideoR2Key: null, audioSegments: [] };

  // Reserve the source video (private key — never exposed as public URL)
  if (manifest.localPath && fs.existsSync(manifest.localPath)) {
    try {
      const key = `private/teardowns/${scanId}/${specId}/source.mp4`;
      await uploadFile(manifest.localPath, key, 'video/mp4');
      result.sourceVideoR2Key = key;
    } catch (e) {
      console.warn('[adIngestService] source video reserve failed:', e.message);
    }
  }

  // Upload per-beat audio slices to PUBLIC prefix so in-browser <audio> works
  for (const seg of (manifest.audioBeats || [])) {
    if (!seg.path || !fs.existsSync(seg.path)) continue;
    try {
      const key = `teardowns/${scanId}/${specId}/beat_${String(seg.beatIndex).padStart(2, '0')}.wav`;
      const url = await uploadFile(seg.path, key, 'audio/wav');
      result.audioSegments.push({
        beatIndex: seg.beatIndex,
        start: seg.start,
        end: seg.end,
        r2Key: key,
        publicUrl: url,
      });
    } catch (e) {
      console.warn(`[adIngestService] beat audio ${seg.beatIndex} reserve failed:`, e.message);
    }
  }

  return result;
}

/**
 * visionNotes — single vision-LLM call over the sampled frames. Replaces the
 * YOLO+CLIP+Tesseract trio for v1. Returns a short prose note the structure
 * classifier folds in (format: UGC vs studio, talking-head, on-screen text…).
 */
async function visionNotes(framesWithUrls) {
  const urls = framesWithUrls.map((f) => f.url).filter(Boolean).slice(0, 8);
  if (!callVisionLLM || urls.length === 0) return '';
  const prompt = [
    'These are sampled frames from a competitor video ad, in order.',
    'In 2-3 sentences describe ONLY the structural/visual format:',
    'is it UGC or studio, talking-head or product-demo, is there on-screen text,',
    'what is the overall pacing/energy. Do not describe the brand or product specifics.',
  ].join(' ');
  try {
    return String(await callVisionLLM({ prompt, imageUrls: urls }) || '').trim();
  } catch (e) {
    console.warn('[adIngestService] vision notes failed:', e.message);
    return '';
  }
}

/**
 * cleanup — remove the temp work dir after we've uploaded what we need.
 */
function cleanup(manifest) {
  try { if (manifest?._outDir) fs.rmSync(manifest._outDir, { recursive: true, force: true }); }
  catch (e) { /* best effort */ }
}

/**
 * ingestCompetitorAd — THE public entry point.
 * Runs ingest → uploads frames → vision notes → teardownToSpec → regenerateCopy.
 *
 * @param {object} args
 *   scan           the UrlToAdsScan doc (brand seed)
 *   source         competitor ad URL or CDN mp4 (e.g. from apifyData video_hd_url)
 *   competitorName
 *   intelligence   optional apify intelligence object
 *   overrides      { structure?, aspectRatio?, avatar?, product? }
 *   opts           { maxFrames, allowDownload, model }
 * @returns { spec, manifestMeta } — spec is a draft adSpec ready for the editor
 */
async function ingestCompetitorAd(args) {
  const { scan, source, competitorName = null, intelligence = {},
          overrides = {}, opts = {}, onPhase = () => {} } = args;

  let manifest;
  try {
    onPhase('downloading');
    manifest = await runIngestWorker(source, opts);
  } catch (e) {
    // Hard fail on ingest → fall back to intelligence-only teardown so the
    // user STILL gets an editable spec (no transcript, heuristic structure).
    console.warn('[adIngestService] ingest failed, intelligence-only teardown:', e.message);
    onPhase('classifying');
    let spec = await teardownToSpec({ scan, transcript: '', competitorName, intelligence, overrides },
      callLLM ? { callLLM } : {});
    onPhase('rewriting');
    spec = await regenerateCopy(spec, callLLM ? { callLLM } : {});
    return { spec, manifestMeta: { ok: false, reason: e.message } };
  }

  onPhase('frames');
  const framesWithUrls = await uploadFrames(manifest, { scanId: String(scan?._id || 'anon') });
  onPhase('transcribing');
  const vision = await visionNotes(framesWithUrls);
  const transcript = manifest.transcript?.text || '';

  onPhase('classifying');
  let spec = await teardownToSpec({
    scan, transcript, competitorName, intelligence, vision, overrides,
  }, callLLM ? { callLLM } : {});
  onPhase('rewriting');
  spec = await regenerateCopy(spec, callLLM ? { callLLM } : {});

  // Reserve source video + per-beat audio in private R2 (training data + user replay)
  const reserved = await reserveSourceAssets(manifest, {
    scanId: String(scan?._id || 'anon'),
    specId: spec.specId,
  });

  // attach lightweight teardown evidence for the report UI (NOT competitor copy)
  spec.teardownEvidence = {
    sceneCount: manifest.scenes?.length || 0,
    durationSec: manifest.meta?.duration || null,
    frameUrls: framesWithUrls.map((f) => f.url).filter(Boolean),
    visionNotes: vision || null,
    wordCount: manifest.transcript?.words?.length || 0,
    transcript: manifest.transcript?.text || null,
    pacing: derivePacing(manifest),
    sourceVideoR2Key: reserved.sourceVideoR2Key || null,
    audioSegments: reserved.audioSegments || [],
  };

  cleanup(manifest);
  return {
    spec,
    manifestMeta: {
      ok: true,
      scenes: manifest.scenes?.length,
      words: spec.teardownEvidence.wordCount,
      sourceReserved: !!reserved.sourceVideoR2Key,
      audioSegments: reserved.audioSegments.length,
    },
  };
}

// crude pacing signal from scene density (cuts per second)
function derivePacing(manifest) {
  const d = manifest.meta?.duration || 0;
  const n = manifest.scenes?.length || 0;
  if (!d || !n) return 'medium';
  const cutsPerSec = n / d;
  if (cutsPerSec > 0.5) return 'fast';
  if (cutsPerSec < 0.2) return 'cinematic';
  return 'medium';
}

module.exports = {
  ingestCompetitorAd,
  runIngestWorker,
  uploadFrames,
  visionNotes,
  derivePacing,
};