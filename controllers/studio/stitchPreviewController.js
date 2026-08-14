'use strict';

/**
 * stitchPreviewController.js — assemble beat frames into a preview MP4.
 *
 * POST /studio/url-to-ads/scan/:id/spec/:specId/stitch-preview
 *
 * Uses ffmpeg to:
 *   1. For each beat: create a still-image clip from the teardown keyframe
 *      (or a black placeholder if the frame isn't available) lasting `durationSec`.
 *   2. Concatenate all beat clips.
 *   3. Mix in the full audio track (first beat's audio extended) if available.
 *   4. Upload the resulting MP4 to public R2 and return the URL.
 *
 * This is a synchronous endpoint (fast-ish because frames are already downloaded
 * by the ingest pipeline). Typical 15-30s ad preview takes ~5s to stitch.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const execFileP = promisify(execFile);

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');

let uploadToR2 = null;
try { uploadToR2 = require('../../services/storageService').uploadToR2; } catch {}

function fail(res, err) {
  const status = err?.code === 'not_found' ? 404 : err?.code === 'bad_request' ? 400 : 500;
  if (status === 500) console.error('[stitchPreview]', err);
  return res.status(status).json({ success: false, error: err?.code || 'server_error', message: err?.message });
}

async function stitchPreview(req, res) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qumak-stitch-'));
  try {
    const { id: scanId, specId } = req.params;

    const scan = await UrlToAdsScan.findById(scanId);
    if (!scan) { const e = new Error('scan not found'); e.code = 'not_found'; throw e; }

    const plain = scan.toObject ? scan.toObject() : scan;
    const spec = (plain.adSpecs || []).find((s) => s.specId === specId);
    if (!spec) { const e = new Error('spec not found'); e.code = 'not_found'; throw e; }

    const beats = spec.beats || [];
    if (beats.length === 0) { const e = new Error('spec has no beats'); e.code = 'bad_request'; throw e; }

    const frameUrls = spec.teardownEvidence?.frameUrls || [];
    const audioSegments = spec.teardownEvidence?.audioSegments || [];

    // ── Step 1: Download frames to local tmp ──────────────────────────────────
    const localFrames = [];
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const frameUrl = frameUrls[i] || null;
      const localPath = path.join(workdir, `frame_${i.toString().padStart(2, '0')}.jpg`);

      if (frameUrl) {
        // Download via curl
        try {
          await execFileP('curl', ['-sSL', '-o', localPath, frameUrl], { timeout: 15000 });
          if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
            localFrames.push({ beat, localPath, durationSec: beat.durationSec });
            continue;
          }
        } catch {}
      }

      // Placeholder: solid dark frame
      await execFileP('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `color=c=#0D0F14:s=720x1280:d=${beat.durationSec}`,
        '-frames:v', '1', localPath, '-loglevel', 'error',
      ]);
      localFrames.push({ beat, localPath, durationSec: beat.durationSec });
    }

    // ── Step 2: Build an ffmpeg concat filter ─────────────────────────────────
    // Each frame is shown for durationSec by using -loop 1 -t durationSec
    // We build inputs + a concat filter for the video stream.
    const ffmpegArgs = ['-y'];
    for (const { localPath, durationSec } of localFrames) {
      ffmpegArgs.push('-loop', '1', '-t', String(durationSec), '-i', localPath);
    }

    // Video concat filter: scale each to 720x1280, pad, then concat
    const filterParts = localFrames.map((_, i) =>
      `[${i}:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
    );
    const concatInputs = localFrames.map((_, i) => `[v${i}]`).join('');
    const videoFilter = [
      ...filterParts,
      `${concatInputs}concat=n=${localFrames.length}:v=1:a=0[vout]`,
    ].join(';');

    const outputPath = path.join(workdir, 'preview.mp4');

    // Check if we have any audio segment with a publicUrl to mix in
    const firstAudioSeg = audioSegments.find((s) => s.publicUrl);
    if (firstAudioSeg?.publicUrl) {
      // Download audio
      const audioPath = path.join(workdir, 'audio.wav');
      try {
        await execFileP('curl', ['-sSL', '-o', audioPath, firstAudioSeg.publicUrl], { timeout: 15000 });
      } catch {}
      const hasAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
      const totalSec = localFrames.reduce((s, f) => s + f.durationSec, 0);

      if (hasAudio) {
        ffmpegArgs.push(
          '-i', audioPath,
          '-filter_complex', videoFilter,
          '-map', '[vout]', '-map', `${localFrames.length}:a`,
          '-shortest', '-c:v', 'libx264', '-preset', 'fast', '-crf', '26',
          '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outputPath,
        );
      } else {
        ffmpegArgs.push('-filter_complex', videoFilter, '-map', '[vout]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '26',
          '-movflags', '+faststart', outputPath);
      }
    } else {
      ffmpegArgs.push('-filter_complex', videoFilter, '-map', '[vout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '26',
        '-movflags', '+faststart', outputPath);
    }

    await execFileP('ffmpeg', ffmpegArgs, { maxBuffer: 50 * 1024 * 1024, timeout: 120_000 });

    if (!fs.existsSync(outputPath)) throw new Error('ffmpeg produced no output');

    // ── Step 3: Upload to public R2 ───────────────────────────────────────────
    let previewUrl = null;
    const totalSec = localFrames.reduce((s, f) => s + f.durationSec, 0);

    if (uploadToR2) {
      const key = `previews/${scanId}/${specId}/preview_${Date.now()}.mp4`;
      previewUrl = await uploadToR2({ localPath: outputPath, key, contentType: 'video/mp4' });
    } else {
      // Dev fallback: return a data URL (works locally without R2)
      const buf = fs.readFileSync(outputPath);
      previewUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
    }

    return res.json({ success: true, previewUrl, durationSec: totalSec });
  } catch (err) {
    return fail(res, err);
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { stitchPreview };
