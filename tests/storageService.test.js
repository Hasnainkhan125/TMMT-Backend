'use strict';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: jest.fn().mockImplementation((args) => args),
}));

process.env.R2_BUCKET_NAME = 'test-bucket';
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

const { uploadBufferToR2 } = require('../services/storageService');

test('uploadBufferToR2 returns a public CDN URL', async () => {
  const buf = Buffer.from('fake-image-bytes');
  const url = await uploadBufferToR2({ buffer: buf, key: 'test/image.png', contentType: 'image/png' });
  expect(url).toBe('https://cdn.example.com/test/image.png');
});

test('uploadBufferToR2 returns null when R2 env vars are missing', async () => {
  const saved = process.env.R2_BUCKET_NAME;
  delete process.env.R2_BUCKET_NAME;
  const url = await uploadBufferToR2({ buffer: Buffer.from('x'), key: 'bad.png', contentType: 'image/png' });
  expect(url).toBeNull();
  process.env.R2_BUCKET_NAME = saved;
});
