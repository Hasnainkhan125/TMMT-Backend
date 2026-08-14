'use strict';

/**
 * Locks down the active-path URL harvester used by the URL-to-Ads scan.
 *
 * Real production failure: `https://www.afghanpalace.ae` had FB/IG handles
 * in the homepage header, but the resolver's `https?://[^"'\s<>)]+/` regex
 * missed them because the site rendered the icons as Font Awesome `<a>`
 * tags whose href used a protocol-relative URL form (`//facebook.com/...`).
 * The new cheerio pass now resolves those into absolute URLs so the
 * downstream extractors can tag them as social handles.
 */

// Block redis startup on require — none of the modules here actually need it,
// but pulling brandIdentity transitively imports this in some envs.
jest.mock('../services/redis', () => ({ getRedis: () => null }), { virtual: true });

const { _internals } = require('../services/intelligence/brandIdentity');
const {
  collectCandidateUrls,
  extractFacebookHandle,
  extractInstagramHandle,
} = _internals;

describe('brandIdentity.collectCandidateUrls', () => {
  it('returns [] for null/empty html', () => {
    expect(collectCandidateUrls(null, 'https://example.com')).toEqual([]);
    expect(collectCandidateUrls('', 'https://example.com')).toEqual([]);
  });

  it('catches plain absolute URLs in raw HTML (legacy regex pass)', () => {
    const html = `
      <html><body>
        <p>follow us at https://facebook.com/AfghanPalaceRestaurant</p>
        <script>const ig = "https://instagram.com/AfghanPalaceRestaurant";</script>
      </body></html>
    `;
    const urls = collectCandidateUrls(html, 'https://www.afghanpalace.ae');
    expect(urls.some((u) => u.includes('facebook.com/AfghanPalaceRestaurant'))).toBe(true);
    expect(urls.some((u) => u.includes('instagram.com/AfghanPalaceRestaurant'))).toBe(true);
  });

  it('catches protocol-relative <a href> URLs that the regex would miss', () => {
    // The Afghan Palace bug: icon-only Font Awesome links rendered in <ul class="fa-ul">
    // with hrefs like //www.facebook.com/... — no `https:` prefix, so the legacy
    // regex `https?://[^"'\s<>)]+` skipped them.
    const html = `
      <html><body>
        <ul class="fa-ul">
          <li><a href="//www.facebook.com/AfghanPalaceRestaurant"><i class="fa fa-facebook"></i></a></li>
          <li><a href="//www.instagram.com/AfghanPalaceRestaurant"><i class="fa fa-instagram"></i></a></li>
        </ul>
      </body></html>
    `;
    const urls = collectCandidateUrls(html, 'https://www.afghanpalace.ae/');
    expect(urls.some((u) => /^https:\/\/www\.facebook\.com\/AfghanPalaceRestaurant/.test(u))).toBe(true);
    expect(urls.some((u) => /^https:\/\/www\.instagram\.com\/AfghanPalaceRestaurant/.test(u))).toBe(true);

    // And the existing extractors should now pick them up.
    expect(extractFacebookHandle(urls)).toEqual(
      expect.objectContaining({ handle: 'AfghanPalaceRestaurant' })
    );
    expect(extractInstagramHandle(urls)).toEqual(
      expect.objectContaining({ handle: 'AfghanPalaceRestaurant' })
    );
  });

  it('resolves relative <a href> URLs against the base URL', () => {
    const html = `
      <html><body>
        <a href="/about">About us</a>
        <a href="contact">Contact</a>
      </body></html>
    `;
    const urls = collectCandidateUrls(html, 'https://example.com/landing/page');
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://example.com/about',
        'https://example.com/landing/contact',
      ])
    );
  });

  it('does not crash on malformed HTML — falls back to the regex set', () => {
    const html = '<<<not really html https://facebook.com/Brand'; // unclosed
    const urls = collectCandidateUrls(html, 'https://example.com');
    expect(urls.some((u) => u.includes('facebook.com/Brand'))).toBe(true);
  });

  it('keeps absolute URLs from <a href> alongside protocol-relative ones', () => {
    const html = `
      <a href="https://www.tiktok.com/@brand">TikTok</a>
      <a href="//www.youtube.com/@brand">YouTube</a>
      <a href="mailto:x@y.com">Email</a>
    `;
    const urls = collectCandidateUrls(html, 'https://brand.com/');
    expect(urls.some((u) => u.includes('tiktok.com/@brand'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://www.youtube.com/@brand'))).toBe(true);
    // mailto: doesn't survive URL resolution? — it does, but that's fine; downstream
    // extractors filter to known social hosts.
  });
});
