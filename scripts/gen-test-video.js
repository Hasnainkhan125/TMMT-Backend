#!/usr/bin/env node
'use strict';

/**
 * gen-test-video.js — one-shot "does the whole video pipeline actually work"
 * smoke test.
 *
 * What it does:
 *   1. Loads qumak-backend/.env so FAL_API_KEY + R2 creds are present.
 *   2. Calls falService.generateVideo with a tiny 3-second prompt against a
 *      known-working slug (Kling v2.5-turbo standard text-to-video — free tier).
 *   3. Downloads the mp4 bytes to qumak-backend/tmp/test-video-<ts>.mp4.
 *   4. Uploads that local file to R2 via storageService.uploadToR2.
 *   5. Prints:
 *        • the requested + effective model id
 *        • the local path on disk
 *        • the public R2 URL
 *        • elapsed wall-clock time
 *
 * Run with:
 *   cd qumak-backend && node scripts/gen-test-video.js
 *
 * Override with env / CLI flags:
 *   PROMPT="a golden retriever running on a beach, cinematic"   (default provided)
 *   MODEL_SLUG=fal-ai/kling-video/v2.5-turbo/standard/text-to-video
 *   DURATION=3           (Kling minimum is 5 — script will coerce)
 *   ASPECT_RATIO=9:16
 *
 * Exit codes:
 *   0  — video generated, saved locally AND uploaded to R2
 *   1  — generation failed (fal error, sanitizer rejected payload, etc.)
 *   2  — generation worked but local save failed
 *   3  — generation + local save worked but R2 upload failed
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const falService = require('../services/falService');
const { uploadToR2 } = require('../services/storageService');

// ─── Config ────────────────────────────────────────────────────────────
const PROMPT = process.env.PROMPT
  || 'A golden retriever running across a sunlit beach at golden hour, '
  + 'shot in slow motion, cinematic depth of field, realistic fur detail';

const MODEL_SLUG = process.env.MODEL_SLUG
  || 'fal-ai/kling-video/v2.5-turbo/standard/text-to-video';

// Kling's minimum duration is 5s (sanitizer will coerce 3→5). We ask for 3
// to honour the user's "3 sec" brief, and log what the model actually ran.
const DURATION = Number(process.env.DURATION || 3);
const ASPECT_RATIO = process.env.ASPECT_RATIO || '16:9';

const TMP_DIR = path.resolve(__dirname, '..', 'tmp');

// ─── Helpers ───────────────────────────────────────────────────────────

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/**
 * Stream a remote URL to a local file. Follows a single redirect (Fal.media
 * serves videos via presigned URLs that sometimes 302). Returns the number
 * of bytes written so we can sanity-check.
 */
function downloadToFile(url, destPath, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'http:' ? http : https;
    const file = fs.createWriteStream(destPath);

    client.get(url, (res) => {
      // Follow redirects — Fal presigned URLs commonly return 302.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        if (redirectsLeft <= 0) {
          return reject(new Error(`Too many redirects while downloading ${url}`));
        }
        return resolve(downloadToFile(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
      }

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const stats = fs.statSync(destPath);
          resolve(stats.size);
        });
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      reject(err);
    });
  });
}

function log(label, value) {
  const w = 22;
  console.log(`  ${label.padEnd(w)} ${value}`);
}

function hr() {
  console.log('─'.repeat(72));
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  hr();
  console.log('  Qumak · video pipeline smoke test');
  hr();
  log('Prompt',        `"${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? '…' : ''}"`);
  log('Model (slug)',  MODEL_SLUG);
  log('Duration (s)',  `${DURATION} (will be coerced to 5 for Kling)`);
  log('Aspect ratio',  ASPECT_RATIO);
  log('Tmp dir',       TMP_DIR);
  hr();

  // 1. Pre-flight env checks — fail loudly with an actionable message.
  const missing = [];
  if (!process.env.FAL_API_KEY && !process.env.FAL_KEY) missing.push('FAL_API_KEY');
  if (!process.env.R2_ACCESS_KEY_ID)    missing.push('R2_ACCESS_KEY_ID');
  if (!process.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!process.env.R2_BUCKET_NAME)      missing.push('R2_BUCKET_NAME');
  if (!process.env.R2_PUBLIC_URL)       missing.push('R2_PUBLIC_URL');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (missing.length) {
    console.error(`\n✘ Missing env vars: ${missing.join(', ')}\n  Set them in qumak-backend/.env and retry.\n`);
    process.exit(1);
  }

  ensureTmpDir();

  // 2. Call falService.generateVideo.
  const t0 = Date.now();
  let falResult;
  try {
    console.log('→ Calling fal.ai…  (typical wait: 30-90s for Kling 5s clips)');
    falResult = await falService.generateVideo({
      prompt: PROMPT,
      aspectRatio: ASPECT_RATIO,
      duration: DURATION,
      tier: 'free',                   // ensures we pick free-tier model
      falModelId: MODEL_SLUG,
      onProgress: (() => {
        // Fal doesn't always stream progress — rate-limit to one line per
        // distinct value so the console doesn't get spammed with 300+ `0%`.
        let last = -1;
        return (p) => {
          if (p === last) return;
          last = p;
          process.stdout.write(`\r  progress: ${String(p).padStart(3)}%   `);
        };
      })(),
    });
    process.stdout.write('\n');
  } catch (err) {
    process.stdout.write('\n');
    console.error(`\n✘ Video generation failed [${err.code || 'UNKNOWN'}]: ${err.message}`);
    if (err.stack && process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }

  const genMs = Date.now() - t0;
  hr();
  console.log('✓ fal.ai returned a video');
  log('Requested model', falResult.requestedModel || MODEL_SLUG);
  log('Effective model', falResult.model);
  log('Gen wall-clock',  `${(genMs / 1000).toFixed(1)}s`);
  log('Fal request id',  falResult.requestId || '(n/a)');
  log('Remote video URL', falResult.videoUrl);
  log('Estimated cost',  `$${(falResult.estimatedCost || 0).toFixed(3)}`);
  hr();

  // 3. Download to local disk.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const localPath = path.join(TMP_DIR, `test-video-${ts}.mp4`);
  try {
    const bytes = await downloadToFile(falResult.videoUrl, localPath);
    log('Local file',    localPath);
    log('Local size',    `${(bytes / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error(`\n✘ Download to local disk failed: ${err.message}`);
    process.exit(2);
  }

  // 4. Upload to R2 so the file is CDN-backed + publicly resolvable.
  const r2Key = `studio/test-videos/${path.basename(localPath)}`;
  let publicUrl;
  try {
    publicUrl = await uploadToR2({
      localPath,
      key: r2Key,
      contentType: 'video/mp4',
    });
    if (!publicUrl) throw new Error('storageService returned null (check R2 env vars + logs)');
  } catch (err) {
    console.error(`\n✘ R2 upload failed: ${err.message}`);
    process.exit(3);
  }

  hr();
  console.log('✓ Uploaded to Cloudflare R2');
  log('R2 key',          r2Key);
  log('Public URL',      publicUrl);
  hr();

  // 5. Final summary.
  const totalMs = Date.now() - t0;
  console.log(`✓ Done in ${(totalMs / 1000).toFixed(1)}s — open the public URL in a browser to watch the video.\n`);

  // Intentionally not deleting the local file — the whole point is "save
  // locally as well". Operator can `rm qumak-backend/tmp/test-video-*.mp4`
  // whenever they want.
}

main().catch((err) => {
  console.error('\n✘ Unhandled error:', err);
  process.exit(1);
});
