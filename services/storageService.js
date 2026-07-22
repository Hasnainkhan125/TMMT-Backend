'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return s3Client;
}

/**
 * uploadToR2 — uploads a local file to Cloudflare R2.
 * @param {object} params - { localPath, key, contentType }
 * @returns {string|null} public URL or null on failure
 */
async function uploadToR2({ localPath, key, contentType = 'video/mp4' }) {
  try {
    const client = getS3Client();
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!bucket || !publicUrl) {
      console.warn('[storageService] R2 env vars not configured, skipping upload');
      return null;
    }

    const fileStream = fs.createReadStream(localPath);
    const stats = fs.statSync(localPath);

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
      ContentLength: stats.size
    }));

    // Strip trailing slash from public URL
    const baseUrl = publicUrl.replace(/\/$/, '');
    return `${baseUrl}/${key}`;
  } catch (err) {
    console.error('[storageService] uploadToR2 failed:', err.message);
    return null;
  }
}

/**
 * uploadBufferToR2 — uploads an in-memory Buffer to Cloudflare R2.
 * Used for Gemini/OpenAI responses that arrive as base64, not local files.
 * @param {object} params - { buffer: Buffer, key: string, contentType: string }
 * @returns {string|null} public URL or null on failure
 */
async function uploadBufferToR2({ buffer, key, contentType = 'image/jpeg' }) {
  try {
    const client = getS3Client();
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!bucket || !publicUrl) {
      console.warn('[storageService] R2 env vars not configured, skipping upload');
      return null;
    }

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.length,
    }));

    const baseUrl = publicUrl.replace(/\/$/, '');
    return `${baseUrl}/${key}`;
  } catch (err) {
    console.error('[storageService] uploadBufferToR2 failed:', err.message);
    return null;
  }
}

module.exports = { uploadToR2, uploadBufferToR2 };
