'use strict';

/**
 * extractSocialHandles — unit tests.
 *
 * Locks down the regression that surfaced on afghanpalace.ae:
 *   - When the user pasted a deep-link page, the canonical FB/IG icons
 *     lived in the homepage header (Font Awesome <ul class="fa-ul"><li><a>)
 *     and the deep-link page didn't link them at all.
 *   - The previous extractor visited only the deep link, so handles
 *     resolved to null and every downstream collector silently failed.
 *
 * The fix added an async homepage-fallback variant. These tests cover
 * both the sync extractor and the async wrapper.
 */

const {
  extractSocialHandles,
  extractSocialHandlesFromUrl,
  isDeepLink,
} = require('../services/resolver/steps/extractSocialHandles');

describe('extractSocialHandles (sync)', () => {
  it('returns the empty shape for null / empty HTML without throwing', () => {
    const empty = extractSocialHandles('');
    expect(empty.facebook).toEqual({ urls: [], handles: [] });
    expect(empty.instagram).toEqual({ urls: [], handles: [] });
    expect(empty.tiktok).toEqual({ urls: [], handles: [] });

    const nullish = extractSocialHandles(null);
    expect(nullish.facebook.handles).toEqual([]);
  });

  it('extracts FB + IG handles from a Font Awesome icon list (the Afghan Palace pattern)', () => {
    // Mirrors the actual HTML the user pasted — icon-only anchors inside
    // a <ul class="fa-ul">, no text label, no obvious "social" class on
    // the wrapper. Only the href is signal.
    const html = `
      <header>
        <ul class="fa-ul">
          <li><a href="https://www.facebook.com/AfghanPalaceRestaurant"><i class="fab fa-facebook"></i></a></li>
          <li><a href="https://www.instagram.com/AfghanPalaceRestaurant/"><i class="fab fa-instagram"></i></a></li>
          <li><a href="https://wa.me/971501234567"><i class="fab fa-whatsapp"></i></a></li>
        </ul>
      </header>`;
    const out = extractSocialHandles(html);
    expect(out.facebook.handles).toContain('AfghanPalaceRestaurant');
    expect(out.instagram.handles).toContain('afghanpalacerestaurant');
    expect(out.whatsapp.handles).toContain('971501234567');
  });

  it('does NOT mistake share/sharer/post URLs for brand handles', () => {
    const html = `
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://afghanpalace.ae">Share on FB</a>
      <a href="https://www.facebook.com/tr?id=12345">FB Pixel</a>
      <a href="https://twitter.com/intent/tweet?text=Hello">Tweet</a>
      <a href="https://www.instagram.com/p/CqXyZ123/">IG post</a>
      <a href="https://www.instagram.com/reel/abc123/">IG reel</a>`;
    const out = extractSocialHandles(html);
    expect(out.facebook.handles).toEqual([]);
    expect(out.twitter.handles).toEqual([]);
    expect(out.instagram.handles).toEqual([]);
  });

  it('picks up handles from schema.org sameAs even when no <a> tag is present', () => {
    const html = '<html><body><h1>No social icons here</h1></body></html>';
    const schemaOrg = {
      organization: {
        sameAs: [
          'https://www.facebook.com/AfghanPalaceRestaurant',
          'https://www.instagram.com/afghanpalacerestaurant',
          'https://twitter.com/afghan_palace',
        ],
      },
    };
    const out = extractSocialHandles(html, schemaOrg);
    expect(out.facebook.handles).toContain('AfghanPalaceRestaurant');
    expect(out.instagram.handles).toContain('afghanpalacerestaurant');
    expect(out.twitter.handles).toContain('afghan_palace');
  });

  it('skips malformed URLs and non-http hrefs without throwing', () => {
    const html = `
      <a href="javascript:void(0)">js</a>
      <a href="mailto:hi@example.com">mail</a>
      <a href="tel:+971501234567">phone</a>
      <a href="not-a-valid-url">bad</a>
      <a href="https://twitter.com/realbrand">good</a>`;
    const out = extractSocialHandles(html);
    expect(out.twitter.handles).toContain('realbrand');
  });
});

describe('extractSocialHandlesFromUrl (async, with homepage fallback)', () => {
  it('does NOT fetch the homepage when the user pasted the homepage itself', async () => {
    const fetcher = jest.fn();
    const out = await extractSocialHandlesFromUrl({
      url: 'https://afghanpalace.ae/',
      html: '<html><body>No socials here</body></html>',
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out._meta.sources.homepage).toBe(false);
  });

  it('fetches the homepage when given a deep link AND merges in handles found there', async () => {
    const deepLinkHtml = '<html><body><h1>Product page — no socials</h1></body></html>';
    const homepageHtml = `
      <ul class="fa-ul">
        <li><a href="https://www.facebook.com/AfghanPalaceRestaurant"><i class="fab fa-facebook"></i></a></li>
        <li><a href="https://www.instagram.com/AfghanPalaceRestaurant"><i class="fab fa-instagram"></i></a></li>
      </ul>`;

    const fetcher = jest.fn(async (url) => {
      expect(url).toBe('https://afghanpalace.ae/');
      return homepageHtml;
    });

    const out = await extractSocialHandlesFromUrl({
      url: 'https://afghanpalace.ae/menu/karak',
      html: deepLinkHtml,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out._meta.sources.homepage).toBe(true);
    expect(out.facebook.handles).toContain('AfghanPalaceRestaurant');
    expect(out.instagram.handles).toContain('afghanpalacerestaurant');
  });

  it('skips the homepage fetch when the deep link already exposed a primary handle', async () => {
    const fetcher = jest.fn();
    const out = await extractSocialHandlesFromUrl({
      url: 'https://afghanpalace.ae/menu/karak',
      html: '<a href="https://facebook.com/AfghanPalaceRestaurant">FB</a>',
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.facebook.handles).toContain('AfghanPalaceRestaurant');
  });

  it('returns the deep-link result and records the error when the homepage fetch fails', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const out = await extractSocialHandlesFromUrl({
      url: 'https://afghanpalace.ae/menu/karak',
      html: '<a href="https://twitter.com/afghan_palace">X</a>',
      fetcher,
    });
    expect(fetcher).toHaveBeenCalled();
    expect(out._meta.sources.homepage).toBe(false);
    expect(out._meta.homepageError).toMatch(/ECONNREFUSED/);
    expect(out.twitter.handles).toContain('afghan_palace');
  });
});

describe('isDeepLink', () => {
  it('treats / and "" as homepage, anything else as deep link', () => {
    expect(isDeepLink('https://example.com/')).toBe(false);
    expect(isDeepLink('https://example.com')).toBe(false);
    expect(isDeepLink('https://example.com/menu')).toBe(true);
    expect(isDeepLink('https://example.com/shop/abc-product')).toBe(true);
    expect(isDeepLink('not-a-url')).toBe(false);
  });
});
