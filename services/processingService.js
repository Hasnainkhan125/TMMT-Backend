'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storageService = require('./storageService');

const execAsync = promisify(exec);

const TMP_DIR = '/tmp/qumak-processing';

// Ensure temp directory exists on module load
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * FFmpeg filter chains for color grading — no LUT files required.
 */
const GRADE_PRESETS = {
  cinematic_teal_orange: [
    'curves=r=\'0/0 0.2/0.15 0.5/0.5 0.8/0.9 1/1\':g=\'0/0 0.2/0.2 0.5/0.5 0.8/0.8 1/1\':b=\'0/0 0.2/0.25 0.5/0.55 0.8/0.75 1/1\'',
    'eq=saturation=1.2:contrast=1.1:brightness=-0.02',
    'unsharp=5:5:0.5:5:5:0.0'
  ].join(','),

  luxury_warm: [
    'curves=r=\'0/0 0.2/0.22 0.5/0.55 0.8/0.85 1/1\':g=\'0/0 0.2/0.18 0.5/0.48 0.8/0.78 1/0.95\':b=\'0/0 0.2/0.12 0.5/0.38 0.8/0.65 1/0.85\'',
    'eq=saturation=0.95:contrast=1.08:brightness=0.01',
    'unsharp=3:3:0.3:3:3:0.0'
  ].join(','),

  clean_professional: [
    'curves=r=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\':g=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\':b=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\'',
    'eq=saturation=1.05:contrast=1.05:brightness=0.02',
    'unsharp=3:3:0.2:3:3:0.0'
  ].join(','),

  food_warmth: [
    'curves=r=\'0/0 0.2/0.24 0.5/0.56 0.8/0.88 1/1\':g=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/0.98\':b=\'0/0 0.2/0.14 0.5/0.40 0.8/0.68 1/0.88\'',
    'eq=saturation=1.15:contrast=1.06:brightness=0.01',
    'unsharp=5:5:0.4:5:5:0.0'
  ].join(',')
};

const CATEGORY_GRADE_MAP = {
  gym:        'cinematic_teal_orange',
  realestate: 'luxury_warm',
  perfume:    'luxury_warm',
  saas:       'clean_professional',
  restaurant: 'food_warmth',
  service:    'clean_professional'
};

/**
 * downloadFile — downloads a URL to a local path using axios stream.
 */
async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/**
 * downloadOrDecodeFile — writes URL content to destPath.
 * Handles both normal https:// URLs and data: URIs (Gemini fallback).
 */
async function downloadOrDecodeFile(url, destPath) {
  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    if (commaIdx === -1) throw new Error('Invalid data URI: no comma separator');
    const b64 = url.slice(commaIdx + 1);
    fs.writeFileSync(destPath, Buffer.from(b64, 'base64'));
    return;
  }
  return downloadFile(url, destPath);
}

/**
 * checkFFmpeg — returns true if ffmpeg is available in PATH.
 */
async function checkFFmpeg() {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * processVideo — download → color grade → optional watermark → upload to R2.
 * Non-fatal: on any FFmpeg failure, returns original URL.
 *
 * @param {object} params - { videoUrl, jobId, category, brandName, isWatermarked, aspectRatio, onProgress }
 * @returns {{ storedUrl: string, processedLocally: boolean }}
 */
async function processVideo({ videoUrl, jobId, category, brandName, isWatermarked, aspectRatio = '16:9', onProgress }) {
  const inputPath = path.join(TMP_DIR, `${jobId}_input.mp4`);
  const gradedPath = path.join(TMP_DIR, `${jobId}_graded.mp4`);
  const outputPath = path.join(TMP_DIR, `${jobId}_output.mp4`);

  try {
    // Step 1: Download
    if (onProgress) onProgress(10);
    console.log(`[processingService] Downloading video for job ${jobId}`);
    await downloadFile(videoUrl, inputPath);

    if (onProgress) onProgress(30);

    // Step 2: Apply color grade
    const gradePreset = GRADE_PRESETS[CATEGORY_GRADE_MAP[category] || 'clean_professional'];
    const gradeCmd = [
      'ffmpeg -y',
      `-i "${inputPath}"`,
      `-vf "${gradePreset}"`,
      '-c:v libx264 -crf 18 -preset slow',
      '-pix_fmt yuv420p -movflags +faststart',
      '-c:a copy',
      `"${gradedPath}"`
    ].join(' ');

    console.log(`[processingService] Applying color grade for job ${jobId}`);
    await execAsync(gradeCmd, { timeout: 120000 });

    if (onProgress) onProgress(60);

    // Step 3: Optionally burn watermark
    if (isWatermarked) {
      const watermarkCmd = [
        'ffmpeg -y',
        `-i "${gradedPath}"`,
        `-vf "drawtext=text='QUMAK STUDIO':fontsize=24:fontcolor=white@0.7:x=w-tw-20:y=h-th-20:shadowcolor=black@0.5:shadowx=2:shadowy=2"`,
        '-c:v libx264 -crf 18 -preset slow',
        '-pix_fmt yuv420p -movflags +faststart',
        '-c:a copy',
        `"${outputPath}"`
      ].join(' ');

      console.log(`[processingService] Adding watermark for job ${jobId}`);
      await execAsync(watermarkCmd, { timeout: 120000 });
    } else {
      fs.renameSync(gradedPath, outputPath);
    }

    if (onProgress) onProgress(80);

    // Step 4: Upload to R2
    const r2Key = `studio/videos/${jobId}/output.mp4`;
    console.log(`[processingService] Uploading to R2 for job ${jobId}`);
    const storedUrl = await storageService.uploadToR2({
      localPath: outputPath,
      key: r2Key,
      contentType: 'video/mp4'
    });

    if (onProgress) onProgress(100);

    // IMPORTANT: we used to fall back silently to `videoUrl` (the raw fal.ai URL)
    // when R2 upload failed or was not configured. That URL expires, which meant
    // the asset row in Mongo ended up permanently pointing at a dead link. We now
    // fail loudly so the worker can mark the job as failed, refund credits, and
    // emit a real error the operator can act on.
    if (!storedUrl) {
      const err = new Error('R2 upload returned null — check R2 env vars and storageService logs.');
      err.code = 'R2_UPLOAD_FAILED';
      throw err;
    }

    return {
      storedUrl,
      processedLocally: true,
    };
  } catch (err) {
    // FFmpeg failures are still recoverable — we can still upload the raw
    // fal.ai download (`inputPath`) to R2 so the user gets SOMETHING back and
    // the asset URL in Mongo is still on our CDN (not a fal.ai media URL).
    if (err.code === 'R2_UPLOAD_FAILED') {
      throw err;
    }
    console.warn(`[processingService] processVideo ffmpeg step failed for job ${jobId}, attempting raw R2 upload:`, err.message);
    try {
      if (!fs.existsSync(inputPath)) throw err;
      const r2Key = `studio/videos/${jobId}/output-raw.mp4`;
      const storedUrl = await storageService.uploadToR2({
        localPath: inputPath,
        key: r2Key,
        contentType: 'video/mp4',
      });
      if (!storedUrl) {
        const rerr = new Error('R2 upload returned null after ffmpeg fallback.');
        rerr.code = 'R2_UPLOAD_FAILED';
        throw rerr;
      }
      return { storedUrl, processedLocally: false };
    } catch (uploadErr) {
      uploadErr.code = uploadErr.code || 'R2_UPLOAD_FAILED';
      throw uploadErr;
    }
  } finally {
    // Cleanup temp files
    [inputPath, gradedPath, outputPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

/**
 * extractThumbnail — extract frame at 1s, scale to 1280x720, upload to R2.
 * Returns URL or null on failure.
 */
async function extractThumbnail(videoUrl, jobId) {
  const inputPath = path.join(TMP_DIR, `${jobId}_thumb_input.mp4`);
  const thumbPath = path.join(TMP_DIR, `${jobId}_thumb.jpg`);

  try {
    await downloadFile(videoUrl, inputPath);

    const thumbCmd = [
      'ffmpeg -y',
      `-i "${inputPath}"`,
      '-ss 00:00:01 -vframes 1',
      `-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"`,
      `"${thumbPath}"`
    ].join(' ');

    await execAsync(thumbCmd, { timeout: 30000 });

    const r2Key = `studio/thumbnails/${jobId}/thumb.jpg`;
    const thumbUrl = await storageService.uploadToR2({
      localPath: thumbPath,
      key: r2Key,
      contentType: 'image/jpeg'
    });

    return thumbUrl;
  } catch (err) {
    console.warn(`[processingService] extractThumbnail failed for job ${jobId}:`, err.message);
    return null;
  } finally {
    [inputPath, thumbPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

/**
 * processImage — download → optional watermark → upload to R2.
 * Watermarking uses ffmpeg if available (prevents adding sharp as a hard dep);
 * if ffmpeg is missing it uploads the unwatermarked image and the caller
 * decides whether to flag it.
 *
 * @param {object} params - { imageUrl, jobId, category, brandName, isWatermarked, aspectRatio }
 * @returns {{ storedUrl: string, processedLocally: boolean }}
 */
async function processImage({ imageUrl, jobId, isWatermarked }) {
  const inputPath = path.join(TMP_DIR, `${jobId}_input.jpg`);
  const outputPath = path.join(TMP_DIR, `${jobId}_output.jpg`);

  try {
    await downloadOrDecodeFile(imageUrl, inputPath);

    let finalPath = inputPath;
    if (isWatermarked && (await checkFFmpeg())) {
      const watermarkCmd = [
        'ffmpeg -y',
        `-i "${inputPath}"`,
        `-vf "drawtext=text='qumak.ae':fontsize=28:fontcolor=white@0.7:x=w-tw-24:y=h-th-24:shadowcolor=black@0.55:shadowx=2:shadowy=2"`,
        '-q:v 2',
        `"${outputPath}"`
      ].join(' ');
      try {
        await execAsync(watermarkCmd, { timeout: 60000 });
        finalPath = outputPath;
      } catch (e) {
        console.warn(`[processingService] image watermark failed (non-fatal): ${e.message}`);
      }
    }

    const r2Key = `studio/images/${jobId}/output.jpg`;
    const storedUrl = await storageService.uploadToR2({
      localPath: finalPath,
      key: r2Key,
      contentType: 'image/jpeg'
    });

    if (!storedUrl) {
      const err = new Error('R2 upload returned null — check R2 env vars and storageService logs.');
      err.code = 'R2_UPLOAD_FAILED';
      throw err;
    }

    return {
      storedUrl,
      processedLocally: true,
    };
  } catch (err) {
    if (err.code === 'R2_UPLOAD_FAILED') throw err;
    console.warn(`[processingService] processImage failed for job ${jobId}:`, err.message);
    const e = new Error(`Image post-processing failed: ${err.message}`);
    e.code = 'IMAGE_PROCESSING_FAILED';
    throw e;
  } finally {
    [inputPath, outputPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

/**
 * mixVoiceoverWithVideo — overlay a TTS/audio file on top of a stored video.
 *
 * The voiceover plays at full volume; original video audio is ducked to 15%.
 * The output is re-uploaded to R2 at the same key as the input (overwrite).
 * Returns the storedUrl (same R2 URL — we overwrite in place).
 *
 * Non-fatal: if ffmpeg or R2 fails we log a warning and return the original URL.
 */
async function mixVoiceoverWithVideo({ videoUrl, audioUrl, jobId }) {
  if (!videoUrl || !audioUrl) return videoUrl;

  const videoPath = path.join(TMP_DIR, `${jobId}_vo_video.mp4`);
  const audioPath = path.join(TMP_DIR, `${jobId}_vo_audio.mp3`);
  const outPath   = path.join(TMP_DIR, `${jobId}_vo_out.mp4`);

  try {
    await Promise.all([
      downloadFile(videoUrl, videoPath),
      downloadFile(audioUrl, audioPath),
    ]);

    // Duck original audio to 15%, voiceover at full. Shortest clip wins so
    // the video never runs past the generated speech.
    const cmd = [
      'ffmpeg -y',
      `-i "${videoPath}"`,
      `-i "${audioPath}"`,
      '-filter_complex "[0:a]volume=0.15[orig];[1:a]volume=1.0[vo];[orig][vo]amix=inputs=2:duration=shortest[aout]"',
      '-map 0:v -map "[aout]"',
      '-c:v copy -c:a aac -b:a 128k',
      '-shortest',
      `"${outPath}"`,
    ].join(' ');

    await execAsync(cmd, { timeout: 60000 });

    const r2Key = `studio/videos/${jobId}/output.mp4`;
    const storedUrl = await storageService.uploadToR2({
      localPath: outPath,
      key: r2Key,
      contentType: 'video/mp4',
    });

    return storedUrl || videoUrl;
  } catch (err) {
    console.warn(`[processingService] mixVoiceoverWithVideo failed for job ${jobId} (non-fatal):`, err.message);
    return videoUrl;
  } finally {
    [videoPath, audioPath, outPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

module.exports = { processVideo, processImage, extractThumbnail, checkFFmpeg, mixVoiceoverWithVideo, GRADE_PRESETS, CATEGORY_GRADE_MAP };
