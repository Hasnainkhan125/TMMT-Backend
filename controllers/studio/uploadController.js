'use strict';

/**
 * uploadController — single handler for every studio file upload.
 *
 * The contract downstream services rely on:
 *   - The returned `url` MUST be publicly fetchable (i.e. NOT localhost /
 *     private IP / RFC1918). If it isn't, FAL / Replicate / Gemini can't
 *     fetch it and the job silently 422s 30 seconds later with a useless
 *     error message. We'd rather fail at the upload call — loudly, with a
 *     clear remediation — than hand back a URL that's a time bomb.
 *
 *   - If multer-s3 routed the file straight to R2, we trust the URL and
 *     return it. If not, we try a best-effort buffer → R2 fallback (this
 *     lets us recover from a transient multer-s3 miss without dropping the
 *     user's file). If both fail, we return 503 with guidance.
 */

const fs   = require('fs');
const path = require('path');
const { uploadBufferToR2 } = require('../../services/storageService');
const { STORAGE_MODE }     = require('../../middleware/s3Upload');

const PURPOSE_FOLDERS = {
  reference:     'studio-references',
  'start-frame': 'studio-frames-start',
  'end-frame':   'studio-frames-end',
  character:     'studio-characters',
  avatar:        'studio-avatars',
  scene:         'studio-scenes',
};

function pickFolder(req) {
  const purpose = String(req.query.purpose || req.body?.purpose || 'reference').toLowerCase();
  return PURPOSE_FOLDERS[purpose] || 'studio-uploads';
}

function setFolder(req, _res, next) {
  req.uploadFolder = pickFolder(req);
  next();
}

/**
 * isPublicUrl — conservative reachability check. Anything fal.ai can't
 * fetch should return false here.
 *
 * We reject:
 *   - protocol-less or non-http(s) URLs
 *   - localhost / 127.0.0.1 / 0.0.0.0 / ::1
 *   - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - link-local (169.254/16)
 *   - .local mDNS hosts
 *
 * Anything else is "assumed public" — we do NOT DNS-resolve here because
 * that's expensive and the caller is usually a CDN domain anyway.
 */
function isPublicUrl(u) {
  if (!u || typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
  if (host.endsWith('.local')) return false;
  // IPv4 literals — block RFC1918 + loopback + link-local
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map((x) => parseInt(x, 10));
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

async function uploadReference(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error:   'no_file',
      message: 'No file uploaded. Use the "file" form field.',
    });
  }

  let url = req.file.location || null;

  // Fallback: if multer used disk (either by policy or transient multer-s3
  // failure), try a one-shot buffer → R2 upload before giving up.
  if (req.file.path) {
    try {
      const buf    = fs.readFileSync(req.file.path);
      const ext    = path.extname(req.file.originalname).toLowerCase();
      const folder = req.uploadFolder || 'studio-uploads';
      const key    = `qumak-assets/${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const r2Url  = await uploadBufferToR2({ buffer: buf, key, contentType: req.file.mimetype });
      if (r2Url) {
        url = r2Url;
        fs.unlink(req.file.path, () => {});
      }
    } catch (e) {
      console.warn('[uploadController] R2 buffer-fallback failed:', e.message);
    }
  }

  // Contract enforcement — we flat-out refuse to return a URL that FAL
  // can't reach. This replaces the silent-failure mode that made the reel
  // pipeline return "Unprocessable Entity" 30 seconds after upload.
  if (!url) {
    return res.status(500).json({
      success: false,
      error:   'no_url',
      message: 'Upload succeeded but no public URL was returned. Check storage configuration.',
    });
  }

  if (!isPublicUrl(url)) {
    // Burn the just-saved disk file too — it's useless.
    if (req.file.path) fs.unlink(req.file.path, () => {});
    console.error(
      '[uploadController] REFUSING to return non-public URL:', url,
      '| storage mode:', STORAGE_MODE,
    );
    return res.status(503).json({
      success: false,
      error:   'storage_not_public',
      storageMode: STORAGE_MODE,
      message:
        'This server is running in disk-storage mode — uploaded files are only ' +
        'reachable on localhost and cannot be consumed by FAL / Replicate / Gemini. ' +
        'Configure Cloudflare R2 (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, ' +
        'CLOUDFLARE_ACCOUNT_ID, R2_BUCKET_NAME, R2_PUBLIC_URL) in qumak-backend/.env ' +
        'and restart the API.',
    });
  }

  return res.json({
    success:      true,
    url,
    storageMode:  STORAGE_MODE,
    folder:       req.uploadFolder,
    purpose:      req.query.purpose || req.body?.purpose || 'reference',
    size:         req.file.size,
    mimetype:     req.file.mimetype,
    originalName: req.file.originalname,
  });
}

module.exports = { setFolder, uploadReference, isPublicUrl };
