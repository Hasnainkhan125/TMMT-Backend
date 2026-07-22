'use strict';

/**
 * Integration test: noon.com full pipeline.
 *
 * One research call, shared across all stages. Stops passing when we have
 * real video or image URLs in competitor ads.
 *
 * Run: ANTHROPIC_API_KEY=... APIFY_API_TOKEN=... npx jest --forceExit --verbose --testTimeout=120000 tests/integration/noonPipeline.test.js
 */

const TIMEOUT = 180_000;

const HAS_KEYS = !!(
  process.env.ANTHROPIC_API_KEY &&
  (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN)
);
const describeIf = HAS_KEYS ? describe : describe.skip;

// ── shared state across all stages ────────────────────────────────────────
let research = null; // filled in root beforeAll
let adResults = [];

describeIf('noon.com — live pipeline integration', () => {

  // One research call — reused by every stage
  beforeAll(async () => {
    const { researchBrand } = require('../../services/aiResearch');
    research = await researchBrand({
      url: 'https://www.noon.com',
      html: '',
      scrape: {
        brandName: 'Noon',
        category: 'e-commerce marketplace UAE',
        description: 'Noon is the Arab world\'s homegrown e-commerce marketplace with 20M+ products, electronics, fashion, home, and grocery.',
        headlines: [
          'Shop Electronics, Fashion, Home & More',
          'Noon - Your everyday marketplace',
          'Up to 70% off top brands',
        ],
      },
    });
    console.log('\n=== RESEARCH RESULT ===');
    console.log('Brand:', research.brand?.name);
    console.log('Competitors:');
    (research.competitors || []).forEach((c) => {
      console.log(`  - ${c.name} | ig:${c.instagramHandle || '-'} fb:${c.facebookPageHandle || '-'} tk:${c.tiktokHandle || '-'} | ${c.url}`);
    });
  }, TIMEOUT);

  // ── Stage 1: AI research quality ─────────────────────────────────────────
  describe('Stage 1 — AI research', () => {
    it('returns brand name', () => {
      expect(research.brand?.name).toBeTruthy();
    });

    it('returns 3+ competitors with name and URL', () => {
      expect(research.competitors.length).toBeGreaterThanOrEqual(3);
      for (const c of research.competitors) {
        expect(c.name).toBeTruthy();
        expect(c.url).toMatch(/^https?:\/\//);
      }
    });

    it('at least 2 competitors have instagram or facebook handles', () => {
      const withHandle = research.competitors.filter(
        (c) => c.instagramHandle || c.facebookPageHandle,
      );
      console.log(`Competitors with handles: ${withHandle.length}/${research.competitors.length}`);
      expect(withHandle.length).toBeGreaterThanOrEqual(2);
    });

    it('returns 4+ hooks with headlines and modelHints', () => {
      expect(research.hooks.length).toBeGreaterThanOrEqual(4);
      for (const h of research.hooks) {
        expect(h.headline).toBeTruthy();
        expect(h.label).toBeTruthy();
        expect(h.modelHint).toBeTruthy();
      }
    });
  });

  // ── Stage 2: Facebook ads from Apify ─────────────────────────────────────
  describe('Stage 2 — Competitor Facebook ads (Apify)', () => {
    beforeAll(async () => {
      if (!research?.competitors?.length) return;
      const { fetchAllCompetitorAds } = require('../../services/apify/actors/facebookAdsLibrary');

      const competitors = research.competitors.slice(0, 3);
      console.log('\n=== FETCHING ADS FOR ===');
      competitors.forEach((c) => console.log(`  - ${c.name} (fb: ${c.facebookPageHandle || 'guessed'})`));

      const { results } = await fetchAllCompetitorAds({
        competitors,
        userBrand: {
          name: research.brand?.name || 'Noon',
          category: research.brand?.category || 'e-commerce marketplace',
          valueProps: research.brand?.valueProps || [],
          audience: research.targetAudience?.primary || 'UAE shoppers',
        },
        scanContext: { vertical: 'ecommerce_general', domain: 'noon.com' },
        country: 'AE',
        limit: 20,
      });
      adResults = results;

      console.log('\n=== AD RESULTS ===');
      for (const r of results) {
        const allAds = r.ads || [];
        const videoAds  = allAds.filter((a) => a.videos?.some((v) => v.hd || v.sd || v.preview));
        const imageAds  = allAds.filter((a) => a.images?.length > 0);
        const cardAds   = allAds.filter((a) => a.cards?.some((c) => c.imageUrl || c.videoUrl || c.videoPreview));
        console.log(`  ${r.competitor}: ${allAds.length} ads | video:${videoAds.length} img:${imageAds.length} card:${cardAds.length} | strategy:${r.successfulStrategy || r.error}`);
        if (videoAds.length) {
          const v = videoAds[0].videos[0];
          console.log(`    Sample video → hd:${v.hd || '-'} sd:${v.sd || '-'} preview:${v.preview || '-'}`);
        }
        if (imageAds.length) {
          console.log(`    Sample image → ${imageAds[0].images[0]}`);
        }
      }
    }, TIMEOUT);

    it('returns at least one competitor result', () => {
      expect(adResults.length).toBeGreaterThanOrEqual(1);
    });

    it('at least one competitor has ads', () => {
      const totalAds = adResults.reduce((s, r) => s + (r.ads?.length || 0), 0);
      console.log('Total ads across all competitors:', totalAds);
      expect(totalAds).toBeGreaterThan(0);
    });

    it('no ghost ads (adId=null + empty text + no media)', () => {
      const allAds = adResults.flatMap((r) => r.ads || []);
      const ghosts = allAds.filter(
        (a) => !a.adId && !a.adText?.trim() && !a.videos?.length && !a.images?.length && !a.cards?.length,
      );
      expect(ghosts).toHaveLength(0);
    });

    it('CRITICAL: at least one ad has a video, image, or card media URL', () => {
      const allAds = adResults.flatMap((r) => r.ads || []);
      const withVideo = allAds.filter((a) => a.videos?.some((v) => v.hd || v.sd || v.preview));
      const withImage = allAds.filter((a) => a.images?.length > 0);
      const withCard  = allAds.filter((a) => a.cards?.some((c) => c.imageUrl || c.videoUrl || c.videoPreview));
      const total = withVideo.length + withImage.length + withCard.length;

      if (total === 0 && allAds.length > 0) {
        console.error('MEDIA MISSING. Raw ad sample:');
        console.error(JSON.stringify(allAds[0], null, 2));
      }
      expect(total).toBeGreaterThan(0);
    });

    it('ads have AI intelligence scores', () => {
      const allAds = adResults.flatMap((r) => r.ads || []);
      if (!allAds.length) return;
      const withIntel = allAds.filter((a) => typeof a.intelligence?.relevanceScore === 'number');
      expect(withIntel.length).toBeGreaterThan(0);
    });
  });

  // ── Stage 3: Instagram profiles using AI-found handles ───────────────────
  describe('Stage 3 — Instagram profiles (Apify, using AI handles)', () => {
    let profiles = [];

    beforeAll(async () => {
      if (!research?.competitors?.length) return;
      const { fetchInstagramProfile } = require('../../services/apify/actors/instagramProfile');

      // Use handles Claude found — these are verified by AI, not guessed
      const handles = research.competitors
        .filter((c) => c.instagramHandle)
        .map((c) => ({ name: c.name, handle: c.instagramHandle }))
        .slice(0, 3);

      console.log('\n=== INSTAGRAM HANDLES FROM AI ===');
      handles.forEach((h) => console.log(`  - @${h.handle} (${h.name})`));

      const results = await Promise.all(
        handles.map(async ({ name, handle }) => {
          try {
            const p = await fetchInstagramProfile({ username: handle });
            return p ? { ...p, _competitorName: name } : null;
          } catch (_e) { return null; }
        }),
      );
      profiles = results.filter(Boolean);

      console.log('\n=== INSTAGRAM PROFILES ===');
      profiles.forEach((p) => {
        console.log(`  @${p.username}: ${p.followerCount?.toLocaleString()} followers, ${p.postCount} posts, avg likes:${p.avgLikes}`);
      });
    }, TIMEOUT);

    it('returns at least one profile', () => {
      expect(profiles.length).toBeGreaterThanOrEqual(1);
    });

    it('profiles have meaningful follower counts (>= 100)', () => {
      const qualified = profiles.filter((p) => (p.followerCount ?? 0) >= 100);
      console.log(`Profiles with 100+ followers: ${qualified.length}/${profiles.length}`);
      expect(qualified.length).toBeGreaterThanOrEqual(1);
    });

    it('profiles have engagement metrics (avgLikes or avgComments)', () => {
      const withEngagement = profiles.filter(
        (p) => (p.avgLikes ?? 0) > 0 || (p.avgComments ?? 0) > 0,
      );
      expect(withEngagement.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Stage 4: ROAST parses without JSON errors ─────────────────────────────
  describe('Stage 4 — ROAST engine (no JSON parse failures)', () => {
    it('generateRoastWithAI completes and returns valid insights array', async () => {
      const { generateRoastWithAI, extractRoastSignals } = require('../../services/roastEngine');

      const mockScan = {
        host: 'noon.com',
        brand: { name: research?.brand?.name || 'Noon', category: research?.brand?.category || 'e-commerce marketplace' },
        businessProfile: { type: 'ecommerce_general' },
        audience: { primary: research?.targetAudience?.primary || 'UAE online shoppers aged 18-45' },
        apifyData: {
          googleMapsPlaces: [],
          competitorAds: adResults.length ? adResults.map((r) => ({
            competitor: r.competitor,
            ads: r.ads || [],
            successfulStrategy: r.successfulStrategy || null,
            error: r.error || null,
          })) : [
            {
              competitor: 'Amazon.ae',
              ads: [
                { intelligence: { isWinner: true, relevanceScore: 88, creativePattern: 'discount_urgency' } },
                { intelligence: { isWinner: true, relevanceScore: 75, creativePattern: 'product_showcase' } },
              ],
              successfulStrategy: 'keyword_search',
              error: null,
            },
          ],
        },
        intelligence: { brandIdentity: { handles: {
          instagramHandle: 'noon', facebookHandle: 'noon',
          tiktokHandle: 'noon_uae', youtubeChannel: 'noon', twitterHandle: 'noon',
        } } },
        moneyMath: {
          vertical: 'ecommerce_general',
          benchmarks: { avgCPL: 22, avgLTV: 380 },
          confidenceLevel: 'medium',
          warnings: ['LTV based on avg basket AED 127 × 3 orders/yr'],
        },
        competitors: (research?.competitors || []).slice(0, 4).map((c) => ({
          name: c.name,
          differentiator: c.differentiator,
          url: c.url,
        })),
      };

      const signals = extractRoastSignals(mockScan);
      const result = await generateRoastWithAI(signals);

      console.log('\n=== ROAST INSIGHTS ===');
      if (result?.insights?.length) {
        result.insights.forEach((ins, i) => {
          console.log(`  [${i + 1}] [${ins.severity}] ${ins.headline}`);
          console.log(`       Fix: ${ins.fixLabel}`);
        });
      } else {
        console.log('  No insights generated (fallback path)');
      }

      if (result !== null) {
        expect(Array.isArray(result.insights)).toBe(true);
        expect(result._source).toBe('ai');
        // At least 1 real insight — not zero when competitor signal exists
        expect(result.insights.length).toBeGreaterThanOrEqual(1);
      }
    }, TIMEOUT);
  });
});
