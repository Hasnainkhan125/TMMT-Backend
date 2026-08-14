'use strict';

const {
  isPublicHttpUrl,
  assertPublicUrl,
  assertSceneAssetsPublic,
} = require('../utils/assertPublicUrl');

describe('assertPublicUrl', () => {
  describe('isPublicHttpUrl', () => {
    const PUBLIC = [
      'https://pub-63c528fcac614eac98746e7a6cb5fe0f.r2.dev/qumak-assets/x.jpg',
      'https://cdn.qumak.io/logo.png',
      'http://fal.media/files/x.mp4',
      'https://8.8.8.8/tiny.webp',
    ];
    const BAD = [
      'http://localhost:5001/uploads/x.jpg',
      'http://127.0.0.1:8080/file.png',
      'http://10.0.0.5/asset.webp',
      'http://192.168.1.42/file.jpg',
      'http://172.20.1.1/file.jpg',
      'http://169.254.1.1/file.jpg',
      'http://::1/file.jpg',
      'http://host.local/file.jpg',
      'file:///etc/passwd',
      'ftp://example.com/x.jpg',
      '',
      null,
      undefined,
      'not-a-url',
    ];

    it.each(PUBLIC)('accepts public URL %s', (u) => {
      expect(isPublicHttpUrl(u)).toBe(true);
    });

    it.each(BAD)('rejects private / malformed URL %s', (u) => {
      expect(isPublicHttpUrl(u)).toBe(false);
    });
  });

  describe('assertPublicUrl', () => {
    it('is a no-op for nullish URLs (optional field)', () => {
      expect(() => assertPublicUrl(null)).not.toThrow();
      expect(() => assertPublicUrl(undefined)).not.toThrow();
      expect(() => assertPublicUrl('')).not.toThrow();
    });

    it('throws a tagged error for localhost URL', () => {
      expect.assertions(4);
      try {
        assertPublicUrl('http://localhost:5001/uploads/x.jpg', {
          fieldName: 'firstFrameUrl',
          sceneIndex: 2,
        });
      } catch (err) {
        expect(err.code).toBe('unreachable_asset_url');
        expect(err.fieldName).toBe('firstFrameUrl');
        expect(err.url).toBe('http://localhost:5001/uploads/x.jpg');
        expect(err.sceneIndex).toBe(2);
      }
    });

    it('passes for an R2 CDN URL', () => {
      expect(() =>
        assertPublicUrl('https://pub-abc.r2.dev/qumak-assets/ok.jpg', {
          fieldName: 'lastFrameUrl',
        })
      ).not.toThrow();
    });
  });

  describe('assertSceneAssetsPublic', () => {
    it('validates every known asset URL on a scene', () => {
      const good = {
        sceneIndex: 0,
        firstFrameUrl: 'https://cdn.x.io/a.jpg',
        lastFrameUrl:  'https://cdn.x.io/b.jpg',
      };
      expect(() => assertSceneAssetsPublic(good)).not.toThrow();

      const bad = {
        sceneIndex: 3,
        firstFrameUrl: 'https://cdn.x.io/a.jpg',
        lastFrameUrl:  'http://localhost:5001/bad.jpg',
      };
      try {
        assertSceneAssetsPublic(bad);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe('unreachable_asset_url');
        expect(err.fieldName).toBe('lastFrameUrl');
        expect(err.sceneIndex).toBe(3);
      }
    });
  });
});
