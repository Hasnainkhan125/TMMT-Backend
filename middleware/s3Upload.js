/**
 * s3Upload.js — Multer + storage middleware
 *
 * Storage priority (decided ONCE at module load):
 *   1. Cloudflare R2  — R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + CLOUDFLARE_ACCOUNT_ID + R2_BUCKET_NAME
 *   2. AWS S3         — AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 *   3. Local disk     — fallback (dev only; .location patched to an API URL)
 *
 * All paths set req.file.location to a public URL so uploadController is
 * storage-agnostic.
 *
 * IMPORTANT: the R2 config check happens at require-time. If dotenv hasn't
 * run yet when THIS file is first loaded, we silently end up in disk mode
 * for the lifetime of the process — and every downstream fal.ai call 422s
 * because localhost URLs aren't fetchable. We therefore run `dotenv.config()`
 * defensively right here as a second-line safety net (in addition to
 * index.js doing it on line 1).
 */

require('dotenv').config();

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// What Studio actually accepts today: reference frames (images), PDFs for
// brand decks, and — new in Phase 10 — short video clips that can be used
// as start/end transition clips in the reel builder. Keep this list narrow:
// widening it is a security surface, so every new type deserves an ADR.
const ALLOWED_MIMES = [
  // images
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/avif',
  // video
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  // docs (brand decks / press kits)
  'application/pdf',
];
// Videos are heavier than images. Bump the cap to 50 MB so a 5–10 s mp4
// from a phone camera doesn't bounce at the middleware.
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const hasR2Config = !!(
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.R2_BUCKET_NAME
);

const hasAwsConfig = !hasR2Config && !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);

let storage;
let s3 = null;
let BUCKET, KEY_PREFIX;
// Tagged so upstream code (uploadController, assertPublicUrl) can
// distinguish "cloud-backed" from "disk-backed" without re-reading env.
let STORAGE_MODE;

if (hasR2Config) {
  STORAGE_MODE = 'r2';
  const { S3Client } = require('@aws-sdk/client-s3');
  const multerS3    = require('multer-s3');

  BUCKET     = process.env.R2_BUCKET_NAME;
  KEY_PREFIX = 'qumak-assets';

  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

  storage = multerS3({
    s3,
    bucket: BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const folder = req.uploadFolder || 'general';
      const ext    = path.extname(file.originalname).toLowerCase();
      const name   = `${KEY_PREFIX}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
  });

  // multer-s3 sets file.location to the S3-compat URL; override with CDN URL.
  if (R2_PUBLIC_URL) {
    const _originalHandleFile = storage._handleFile.bind(storage);
    storage._handleFile = (req, file, cb) => {
      _originalHandleFile(req, file, (err, info) => {
        if (err) return cb(err);
        if (info && info.key) {
          info.location = `${R2_PUBLIC_URL}/${info.key}`;
        }
        cb(null, info);
      });
    };
  } else {
    console.warn(
      '[s3Upload] R2 credentials set but R2_PUBLIC_URL is empty. ' +
      'req.file.location will be the S3-compat endpoint, which is NOT a CDN URL. ' +
      'Set R2_PUBLIC_URL="https://pub-<hash>.r2.dev" in .env.'
    );
  }

} else if (hasAwsConfig) {
  STORAGE_MODE = 's3';
  const { S3Client }  = require('@aws-sdk/client-s3');
  const multerS3      = require('multer-s3');

  BUCKET     = process.env.AWS_S3_BUCKET || 'qumak-assets-prod';
  KEY_PREFIX = 'qumak-assets';

  s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  storage = multerS3({
    s3,
    bucket: BUCKET,
    acl: 'public-read',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const folder = req.uploadFolder || 'general';
      const ext    = path.extname(file.originalname).toLowerCase();
      const name   = `${KEY_PREFIX}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
  });

} else {
  STORAGE_MODE = 'disk';
  BUCKET     = null;
  KEY_PREFIX = 'qumak-assets';

  // LOUD warning on disk fallback — this class of bug is hard to debug
  // because the upload "works" (local URL is returned) but breaks later
  // when the URL is passed to an external service that can't reach
  // localhost. Make absolutely sure the operator notices.
  console.warn('');
  console.warn('[s3Upload] ─────────────────────────────────────────────────────────');
  console.warn('[s3Upload]  DISK FALLBACK ACTIVE — no R2 or S3 credentials detected.');
  console.warn('[s3Upload]  Uploads will return http://localhost:.../uploads/... URLs');
  console.warn('[s3Upload]  which FAL / external services CANNOT fetch. Every studio');
  console.warn('[s3Upload]  video reel + ad-set + influencer scene will 422.');
  console.warn('[s3Upload]  Fix it: set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /');
  console.warn('[s3Upload]  CLOUDFLARE_ACCOUNT_ID / R2_BUCKET_NAME / R2_PUBLIC_URL');
  console.warn('[s3Upload]  in qumak-backend/.env and restart the API.');
  console.warn('[s3Upload] ─────────────────────────────────────────────────────────');
  console.warn('');

  const diskDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(diskDir)) fs.mkdirSync(diskDir, { recursive: true });

  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = req.uploadFolder || 'general';
      const dir    = path.join(diskDir, folder);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
  });
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type "${file.mimetype}" not allowed. Accepted: ${ALLOWED_MIMES.join(', ')}`));
  },
});

function getFileUrl(req, file) {
  if (file.location) return file.location;
  const folder = req.uploadFolder || 'general';
  const base   = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
  return `${base}/uploads/${folder}/${file.filename}`;
}

function normalizeLocations(req, res, next) {
  if (!hasR2Config && !hasAwsConfig) {
    const patchFile = f => {
      if (f && !f.location) f.location = getFileUrl(req, f);
      return f;
    };
    if (req.file)  req.file  = patchFile(req.file);
    if (req.files) {
      if (Array.isArray(req.files)) req.files = req.files.map(patchFile);
      else Object.keys(req.files).forEach(k => { req.files[k] = req.files[k].map(patchFile); });
    }
  }
  next();
}

const uploadWithNormalize = {
  single: (field)      => [upload.single(field), normalizeLocations],
  array:  (field, max) => [upload.array(field, max), normalizeLocations],
  fields: (fields)     => [upload.fields(fields), normalizeLocations],
  any:    ()           => [upload.any(), normalizeLocations],
};

module.exports = {
  upload: uploadWithNormalize,
  s3,
  getFileUrl,
  BUCKET,
  KEY_PREFIX,
  STORAGE_MODE,       // 'r2' | 's3' | 'disk' — used by uploadController + tests
  ALLOWED_MIMES,
  MAX_FILE_SIZE,
};
