'use strict';

/**
 * facebookAdsLibrary.normalizeAd — unit tests.
 *
 * Normalization is the seam between Apify's raw response and every panel
 * that renders competitor ads. If videos[] doesn't get hd/sd/preview
 * extracted, the UI shows "No preview" — which is the exact bug that
 * surfaced on the Hot Shay scan ("5 ads back, 0 previews rendered").
 *
 * These tests pin down the contract:
 *   - video ad → videos[0].hd/sd/preview present, mediaType='video'
 *   - image ad → images[] non-empty, mediaType='image'
 *   - carousel  → cards[] with imageUrl/title/cta, mediaType='carousel'
 *   - daysRunning computed from start_date / end_date timestamps
 *   - null / non-object input returns null (don't crash the normaliser)
 */

const { normalizeAd } = require('../services/apify/actors/facebookAdsLibrary');

const HOUR  = 3600;
const DAY   = 86400;
const NOW_S = Math.floor(Date.now() / 1000);

describe('facebookAdsLibrary.normalizeAd', () => {
  it('extracts video URLs (hd/sd/preview) and tags mediaType="video"', () => {
    const raw = {
      ad_archive_id: 'AD_1',
      page_id: 'P_1',
      page_name: 'Sharaf DG',
      start_date: NOW_S - 7 * DAY,
      end_date:   null,
      snapshot: {
        videos: [{
          video_hd_url: 'https://video.fbcdn.net/v/sharaf_hd.mp4',
          video_sd_url: 'https://video.fbcdn.net/v/sharaf_sd.mp4',
          video_preview_image_url: 'https://scontent.fbcdn.net/v/sharaf_poster.jpg',
        }],
        body: { text: 'Limited weekend offer on iPhone 15.' },
        cta_text: 'Shop now',
        link_url: 'https://uae.sharafdg.com/iphone15',
      },
    };

    const out = normalizeAd(raw);
    expect(out).not.toBeNull();
    expect(out.adId).toBe('AD_1');
    expect(out.pageName).toBe('Sharaf DG');
    expect(out.adText).toBe('Limited weekend offer on iPhone 15.');
    expect(out.cta).toBe('Shop now');
    expect(out.landingPageUrl).toBe('https://uae.sharafdg.com/iphone15');
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0].hd).toBe('https://video.fbcdn.net/v/sharaf_hd.mp4');
    expect(out.videos[0].sd).toBe('https://video.fbcdn.net/v/sharaf_sd.mp4');
    expect(out.videos[0].preview).toBe('https://scontent.fbcdn.net/v/sharaf_poster.jpg');
    expect(out.images).toEqual([]);
    expect(out.cards).toEqual([]);
    expect(out.mediaType).toBe('video');
    expect(out.daysRunning).toBeGreaterThanOrEqual(7);
    expect(out.daysRunning).toBeLessThanOrEqual(8);
    expect(out.adLibraryUrl).toBe('https://www.facebook.com/ads/library/?id=AD_1');
  });

  it('extracts image URLs (original then resized) and tags mediaType="image"', () => {
    const raw = {
      ad_archive_id: 'AD_2',
      snapshot: {
        videos: [],
        images: [
          { original_image_url: 'https://scontent.fbcdn.net/full.jpg', resized_image_url: 'https://scontent.fbcdn.net/thumb.jpg' },
          { resized_image_url: 'https://scontent.fbcdn.net/thumb2.jpg' }, // no original — should fall back to resized
        ],
      },
    };

    const out = normalizeAd(raw);
    expect(out.images).toEqual([
      'https://scontent.fbcdn.net/full.jpg',
      'https://scontent.fbcdn.net/thumb2.jpg',
    ]);
    expect(out.videos).toEqual([]);
    expect(out.mediaType).toBe('image');
  });

  it('extracts carousel cards with title, image, video, cta, link — mediaType="carousel"', () => {
    const raw = {
      ad_archive_id: 'AD_3',
      snapshot: {
        videos: [],
        images: [],
        cards: [
          {
            title: 'Iced Karak Pack',
            link_description: '5 cups for AED 25',
            original_image_url: 'https://scontent.fbcdn.net/karak1.jpg',
            video_hd_url: null,
            cta_text: 'Order now',
            link_url: 'https://hotshay.ae/karak-pack',
          },
          {
            title: 'Family Bundle',
            link_description: '2L jug + 4 cups',
            resized_image_url: 'https://scontent.fbcdn.net/karak2_thumb.jpg',
            video_sd_url: 'https://video.fbcdn.net/karak2.mp4',
            cta_text: 'Order now',
            link_url: 'https://hotshay.ae/family',
          },
        ],
      },
    };

    const out = normalizeAd(raw);
    expect(out.mediaType).toBe('carousel');
    expect(out.cards).toHaveLength(2);
    expect(out.cards[0]).toMatchObject({
      title: 'Iced Karak Pack',
      description: '5 cups for AED 25',
      imageUrl: 'https://scontent.fbcdn.net/karak1.jpg',
      videoUrl: null,
      cta: 'Order now',
      linkUrl: 'https://hotshay.ae/karak-pack',
    });
    expect(out.cards[1].imageUrl).toBe('https://scontent.fbcdn.net/karak2_thumb.jpg');
    expect(out.cards[1].videoUrl).toBe('https://video.fbcdn.net/karak2.mp4');
  });

  it('returns null for null / non-object inputs and empty for empty snapshot', () => {
    expect(normalizeAd(null)).toBeNull();
    expect(normalizeAd(undefined)).toBeNull();
    expect(normalizeAd('not an object')).toBeNull();
    expect(normalizeAd(42)).toBeNull();

    const out = normalizeAd({ ad_archive_id: 'AD_X', snapshot: {} });
    expect(out.videos).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.cards).toEqual([]);
    expect(out.mediaType).toBe('unknown');
    expect(out.daysRunning).toBe(0);
  });

  it('uses end_date when present so completed ads still surface daysRunning', () => {
    const raw = {
      ad_archive_id: 'AD_4',
      start_date: NOW_S - 30 * DAY - HOUR,
      end_date:   NOW_S - 5  * DAY,
      snapshot: { videos: [{ video_hd_url: 'x' }] },
    };
    const out = normalizeAd(raw);
    expect(out.daysRunning).toBeGreaterThanOrEqual(24);
    expect(out.daysRunning).toBeLessThanOrEqual(26);
    expect(out.endedAt).toBeInstanceOf(Date);
  });

  it('keeps a poster-only video entry so the panel renders the still', () => {
    // CDN policy frequently strips video_hd_url / video_sd_url for some
    // markets but leaves the preview image. The OLD normalizer dropped
    // these rows entirely → "No preview" in the UI. This pins the fix.
    const raw = {
      ad_archive_id: 'POSTER_ONLY',
      snapshot: {
        videos: [{
          video_hd_url: null,
          video_sd_url: null,
          video_preview_image_url: 'https://scontent.fbcdn.net/poster.jpg',
        }],
      },
    };
    const out = normalizeAd(raw);
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0].preview).toBe('https://scontent.fbcdn.net/poster.jpg');
    expect(out.mediaType).toBe('video');
    expect(out.hasPlayableVideo).toBe(false);
  });

  it('handles single-image shape (snapshot.image)', () => {
    const raw = {
      ad_archive_id: 'SINGLE_IMG',
      snapshot: {
        image: { original_image_url: 'https://scontent.fbcdn.net/single.jpg' },
      },
    };
    const out = normalizeAd(raw);
    expect(out.images).toEqual(['https://scontent.fbcdn.net/single.jpg']);
    expect(out.mediaType).toBe('image');
  });

  it('handles single-video shape (snapshot.video) and exposes hasPlayableVideo', () => {
    const raw = {
      ad_archive_id: 'SINGLE_VID',
      snapshot: {
        video: {
          video_hd_url: 'https://video.fbcdn.net/single.mp4',
          video_preview_image_url: 'https://scontent.fbcdn.net/poster.jpg',
        },
      },
    };
    const out = normalizeAd(raw);
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0].hd).toBe('https://video.fbcdn.net/single.mp4');
    expect(out.hasPlayableVideo).toBe(true);
    expect(out.mediaType).toBe('video');
  });

  it('derives weeklySpendTier from estSpendRange.upper', () => {
    const tier = (upper) =>
      normalizeAd({
        ad_archive_id: 'X',
        spend: { lower_bound: 0, upper_bound: upper, currency: 'AED' },
        snapshot: { images: [{ original_image_url: 'i.jpg' }] },
      }).weeklySpendTier;
    expect(tier(60_000)).toBe('huge');
    expect(tier(15_000)).toBe('heavy');
    expect(tier(3_000)).toBe('medium');
    expect(tier(500)).toBe('light');
    expect(tier(50)).toBe('minimal');
    expect(normalizeAd({ ad_archive_id: 'X', snapshot: {} }).weeklySpendTier).toBeNull();
  });

  it('preserves carousel mediaType even when cards contain videos', () => {
    const raw = {
      ad_archive_id: 'CAR_VID',
      snapshot: {
        cards: [
          { title: 'A', original_image_url: 'a.jpg' },
          { title: 'B', video_hd_url: 'b.mp4', video_preview_image_url: 'b.jpg' },
        ],
      },
    };
    const out = normalizeAd(raw);
    expect(out.mediaType).toBe('carousel');
    expect(out.hasPlayableVideo).toBe(true);
  });
});
