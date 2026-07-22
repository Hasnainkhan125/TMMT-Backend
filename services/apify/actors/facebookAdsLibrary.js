'use strict';

/**
 * facebookAdsLibrary.js — Apify Meta Ad Library integration with
 * AI-generated intelligence layer.
 *
 * Pipeline:
 *   resolveCompetitorSearchInputs()  ← Claude generates 3 search strategies per competitor
 *     ↓
 *   fetchAdsForSearchInput()          ← Apify call with the AI-chosen strategy
 *     ↓
 *   normalizeAd()                     ← deterministic field shaping
 *     ↓
 *   scoreAdRelevance()                ← Claude scores each ad's value to the user
 *     ↓
 *   classifyCreativePattern()         ← Claude tags creative type/angle/winner-status
 *
 * Why AI per stage instead of hardcode:
 *   - Apify's actor input format varies — keyword search vs page URL vs page id —
 *     and the right format depends on the competitor. Claude picks per-competitor.
 *   - "Profitable ad" isn't always days_running > 60 — for a flash sale brand,
 *     14 days is profitable. Claude reads the brand context and chooses thresholds.
 *   - "Relevant ad" depends on what the USER's brand is doing. Claude scores each
 *     competitor ad against the user's brand profile and surfaces only the top-N.
 *
 * Cost ceiling per scan: ~$0.06 in Claude calls + Apify spend (avg $0.40-0.80).
 * Cache aggressively: search-strategy and creative-pattern outputs cache 24h on
 * (competitorName, userVertical) tuple — same brand asking about same competitor
 * tomorrow reuses yesterday's strategy.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { runActor } = require('../apifyClient');
const { getRedis } = require('../../redis');
const { enrichCompetitorsWithFbPages } = require('../competitorResolution');
const { buildAdLibraryUrl, buildApifyInput, facebookAdsMemoryMbytesForInput } = require('./buildAdLibraryUrl');

// ──────────────────────────────────────────────────────────────────────────
// Anthropic client (lazy)
// ──────────────────────────────────────────────────────────────────────────

let _claude;
function getClaude() {
  if (!_claude) {
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _claude;
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001';

// Failures must NEVER block the whole scan. We always fall back to a
// deterministic strategy that has worked in production (keyword search by
// competitor name in user's country).
async function safeClaude(messages, { systemPrompt, maxTokens = 1024, fallback }) {
  try {
    const response = await getClaude().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });
    const text = response.content[0]?.text || '';
    // Strip ```json fences if Claude adds them
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[fb-ads-ai] Claude call failed, using fallback:', err.message);
    return fallback;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 1 — AI generates Apify search inputs per competitor
// ──────────────────────────────────────────────────────────────────────────

/**
 * Claude looks at the competitor (name, url, tagline) plus user country and
 * vertical, and returns up to 3 ranked search strategies. Each strategy is a
 * complete Apify input ready to pass through.
 *
 * Why 3 strategies?
 *   - Strategy 1 might fail because the competitor doesn't run keyword-matching
 *     ads (their FB page exists but never used the keyword "X" in copy).
 *   - Strategy 2 falls back to page URL if we know it.
 *   - Strategy 3 falls back to a broader keyword (parent company name, etc).
 *
 *   We try them in order until one returns ads.
 */
async function resolveCompetitorSearchInputs({ competitor, userBrand, country, scanContext }) {
  const cacheKey = `fb-ads-strategy:${competitor.name?.toLowerCase()}:${country}:${scanContext.vertical || 'unknown'}`;
  const redis = getRedis();
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch (_e) { /* fall through */ }
  }

  // If the competitor page was pre-resolved, inject it as rank-0 strategy
  // so we try the direct page URL FIRST before AI-generated keyword searches.
  const resolvedPageId = competitor._fbPageResolution?.pageId || null;
  if (resolvedPageId) {
    const directStrategy = {
      rank: 0,
      approach: 'page_id',
      reasoning: 'Pre-resolved numeric FB page ID — highest confidence, bypasses keyword matching',
      apifyUrl: buildAdLibraryUrl({ mode: 'page', pageId: resolvedPageId, country }),
      expectedRecall: 'high',
      _resolved: true,
    };
    // Build rest of strategies via AI, prepend the resolved one
    const aiResult = await resolveSearchStrategiesViaAI({ competitor, userBrand, country, scanContext });
    const merged = { strategies: [directStrategy, ...(aiResult.strategies || [])] };
    await redis.setex(cacheKey, 86400, JSON.stringify(merged)).catch(() => {});
    return merged;
  }

  const result = await resolveSearchStrategiesViaAI({ competitor, userBrand, country, scanContext });
  await redis.setex(cacheKey, 86400, JSON.stringify(result)).catch(() => {});
  return result;
}

async function resolveSearchStrategiesViaAI({ competitor, userBrand, country, scanContext }) {
  const systemPrompt = `You are an expert in Meta Ad Library search strategies. Given a competitor brand, you generate up to 3 ranked search strategies for Apify's Facebook Ads Library scraper.

Output ONLY valid JSON in this shape:
{
  "strategies": [
    {
      "rank": 1,
      "approach": "keyword_search" | "page_url" | "page_id_search",
      "reasoning": "1-sentence why this approach for this brand",
      "apifyUrl": "https://www.facebook.com/ads/library/?...",
      "expectedRecall": "high" | "medium" | "low"
    }
  ]
}

Rules:
- For well-known brands with strong brand-name advertising (luxury, retail, tech), use keyword_search with the brand's exact name as the q parameter.
- For brands whose ad copy uses category terms more than brand name (real estate, healthcare, services), use 2 strategies: one with brand name, one with category keyword.
- The Ad Library URL format is: https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=<COUNTRY>&q=<URL_ENCODED_QUERY>&search_type=keyword_unordered&media_type=all
- Only use page_url approach if the competitor's url field clearly contains a facebook.com page link.
- Country code is always 2-letter ISO (AE, SA, KW, QA, BH, OM, US, UK, IN, etc).
- If the competitor's "name" looks like a description (e.g. "Local Dealer Showrooms", "Edmunds equivalent regional sites") not a real brand, return strategies: [] — we shouldn't waste Apify spend on hallucinated competitors.`;

  const userMessage = `User's brand: ${userBrand.name} (${scanContext.vertical || 'unknown vertical'})
User's country: ${country}

Competitor to research:
  Name: ${competitor.name}
  URL: ${competitor.url || 'unknown'}
  Tagline: ${competitor.tagline || 'unknown'}
  Why they're a competitor: ${competitor.why || 'unknown'}

Generate ranked search strategies for this competitor. Maximum 3.`;

  const fallback = {
    strategies: [{
      rank: 1,
      approach: 'keyword_search',
      reasoning: 'Default fallback — keyword search by competitor name',
      apifyUrl: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(competitor.name)}&search_type=keyword_unordered&media_type=all`,
      expectedRecall: 'medium',
    }],
  };

  return safeClaude(
    [{ role: 'user', content: userMessage }],
    { systemPrompt, maxTokens: 800, fallback }
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2 — Apify call per search input
// ──────────────────────────────────────────────────────────────────────────

// curious_coder/facebook-ads-library-scraper: $0.005/ad, residential proxy, more reliable
// than apify/facebook-ads-scraper ($5/1K, often blocked by Meta anti-bot)
const APIFY_ACTOR_ID = process.env.APIFY_FB_ADS_ACTOR || 'curious_coder/facebook-ads-library-scraper';

function buildActorInput(apifyUrl, country, limit) {
  const actorId = APIFY_ACTOR_ID;
  // curious_coder actor: confirmed working input shape (Hamza, 2026-04-27)
  if (actorId.startsWith('curious_coder/')) {
    return buildApifyInput({ url: apifyUrl, count: limit, countryCode: country });
  }
  if (actorId.startsWith('webdatalabs/')) {
    return {
      searchUrls: [apifyUrl],
      maxResults: limit,
      proxyConfig: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: country,
      },
    };
  }
  // Default: apify/facebook-ads-scraper format
  return {
    urls: [apifyUrl],
    count: limit,
    'scrapePageAds.activeStatus': 'all',
    proxyConfig: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: country,
    },
  };
}

async function fetchAdsForSearchInput({ apifyUrl, country, limit = 30 }) {
  const input = buildActorInput(apifyUrl, country, limit);

  console.log('[fb-ads-debug] Actor:', APIFY_ACTOR_ID);
  console.log('[fb-ads-debug] Input:', JSON.stringify(input, null, 2));

  const result = await runActor(APIFY_ACTOR_ID, input, {
    timeoutSecs: 240,
    memoryMbytes: facebookAdsMemoryMbytesForInput(input, APIFY_ACTOR_ID),
    cacheTTL: 21600,
  });

  const items = result?.items || [];
  if (items.length > 0) {
    console.log('[fb-ads-debug] Raw item[0]:', JSON.stringify(items[0], null, 2));
  } else {
    console.log('[fb-ads-debug] Actor returned 0 items. fromCache:', result?.fromCache, 'runId:', result?.runId);
  }

  return items;
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3 — Deterministic normalization
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apify's response shape is well-documented and stable. Normalization is
 * deterministic — no AI needed here. We extract the goldmine fields:
 * videos, images, run dates, advertiser strength, platforms.
 */
function normalizeAd(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const startedAt = raw.start_date ? new Date(raw.start_date * 1000) : null;
  const endedAt = raw.end_date ? new Date(raw.end_date * 1000) : null;
  const daysRunning = startedAt
    ? Math.floor(((endedAt || new Date()) - startedAt) / 86400000)
    : 0;

  // ── Media extraction — be aggressive. Apify returns 4 shape variants:
  //    1. snapshot.videos[]              — multi-video page
  //    2. snapshot.video                  — single-video shape
  //    3. snapshot.images[]               — multi-image
  //    4. snapshot.image                  — single-image shape
  //    5. snapshot.cards[]                — carousel
  //  We MUST keep poster-only video rows (no hd/sd) so the panel can
  //  render the still as a fallback. Old code dropped those, which is
  //  the root cause of the "No preview ×5" symptom on real ad data.

  const videoArr = Array.isArray(raw.snapshot?.videos) ? raw.snapshot.videos : [];
  const singleVideo = raw.snapshot?.video && typeof raw.snapshot.video === 'object'
    ? [raw.snapshot.video]
    : [];
  const videos = [...videoArr, ...singleVideo]
    .map((v) => ({
      hd: v?.video_hd_url || null,
      sd: v?.video_sd_url || null,
      preview: v?.video_preview_image_url || v?.image_url || null,
    }))
    .filter((v) => v.hd || v.sd || v.preview);

  const imageArr = Array.isArray(raw.snapshot?.images) ? raw.snapshot.images : [];
  const singleImage = raw.snapshot?.image && typeof raw.snapshot.image === 'object'
    ? [raw.snapshot.image]
    : [];
  const images = [...imageArr, ...singleImage]
    .map((i) => i?.original_image_url || i?.resized_image_url || i?.url || null)
    .filter(Boolean);

  const cards = (raw.snapshot?.cards || []).map((c) => ({
    title: c.title || c.body || '',
    description: c.link_description || '',
    imageUrl: c.original_image_url || c.resized_image_url || null,
    videoUrl: c.video_hd_url || c.video_sd_url || null,
    videoPreview: c.video_preview_image_url || null,
    cta: c.cta_text || null,
    linkUrl: c.link_url || null,
  }));

  // mediaType resolution: carousels win when present (a multi-card carousel
  // with a video inside is still a carousel). Otherwise video > image > unknown.
  // A row with a poster-only video is still "video" so the play chrome shows
  // even when CDN policy strips the actual video URLs.
  const playableVideoCount = videos.filter((v) => v.hd || v.sd).length;
  const cardHasVideo = cards.some((c) => c.videoUrl);
  const mediaType = cards.length > 0
    ? 'carousel'
    : videos.length > 0
      ? 'video'
      : images.length > 0
        ? 'image'
        : 'unknown';

  const advertiser = raw.advertiser?.ad_library_page_info?.page_info || {};

  // Spend tier — we derive a coarse band from estSpendRange so the UI can
  // show "🔥 BIG SPEND" badges without each panel re-deriving it. AED-only
  // for now; adapt if estSpendRange.currency surfaces other units.
  const spendUpper = raw.spend?.upper_bound;
  const weeklySpendTier = (() => {
    if (!spendUpper && spendUpper !== 0) return null;
    if (spendUpper >= 50_000) return 'huge';      // $50K+/week — top 1%
    if (spendUpper >= 10_000) return 'heavy';     // serious player
    if (spendUpper >= 2_000)  return 'medium';    // testing
    if (spendUpper >= 100)    return 'light';     // small budget
    return 'minimal';
  })();

  const ad = {
    adId: raw.ad_archive_id || raw.id || null,
    pageId: raw.page_id || raw.snapshot?.page_id || null,
    pageName: raw.page_name || raw.snapshot?.page_name || null,

    adText: raw.snapshot?.body?.text || '',
    cta: raw.snapshot?.cta_text || raw.snapshot?.cta_type || null,
    landingPageUrl: raw.snapshot?.link_url || null,
    linkCaption: raw.snapshot?.caption || null,

    videos,
    images,
    cards,
    mediaType,
    hasPlayableVideo: playableVideoCount > 0 || cardHasVideo,
    _playableVideoCount: playableVideoCount,

    startedAt,
    endedAt,
    daysRunning,

    platforms: Array.isArray(raw.publisher_platform) ? raw.publisher_platform : [],
    targetingCountries: Array.isArray(raw.targeted_or_reached_countries) ? raw.targeted_or_reached_countries : [],
    estSpendRange: raw.spend
      ? { lower: raw.spend.lower_bound, upper: raw.spend.upper_bound, currency: raw.spend.currency }
      : null,
    estImpressionsRange: raw.impressions
      ? { lower: raw.impressions.lower_bound, upper: raw.impressions.upper_bound }
      : null,
    weeklySpendTier,

    advertiser: {
      pageLikes: advertiser.likes || null,
      igFollowers: advertiser.ig_followers || null,
      igUsername: advertiser.ig_username || null,
      verified: advertiser.page_verification === 'BLUE_VERIFIED',
      category: advertiser.page_category || null,
      profilePhoto: advertiser.profile_photo || raw.snapshot?.page_profile_picture_url || null,
    },

    adLibraryUrl: raw.ad_library_url || (raw.ad_archive_id
      ? `https://www.facebook.com/ads/library/?id=${raw.ad_archive_id}`
      : null),

    fetchedAt: new Date(),
  };

  // Apify sometimes returns metadata/status rows with no ad content at all.
  // These poison AI scoring and show "No preview" cards in the UI.
  if (!ad.adId && !ad.adText?.trim() && !ad.videos.length && !ad.images.length && !ad.cards.length) {
    console.log('[fb-ads-debug] Ghost row filtered. raw keys:', Object.keys(raw).join(', '));
    return null;
  }

  return ad;
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 4 — AI scores each ad's relevance + tags creative pattern
// ──────────────────────────────────────────────────────────────────────────

/**
 * Claude looks at a batch of normalized ads (max 30) for a single competitor
 * and the user's brand context, and returns:
 *   - relevance score (0-100) — how useful this ad is for the user to study
 *   - creative pattern tag — auto-derived, not from a hardcoded list
 *   - winner status — AI determines per brand context
 *   - one-line "why this matters" insight
 *
 * Why AI instead of hardcoded thresholds?
 *   - "Winner" for a luxury brand might mean 90+ days. For a flash-sale brand, 14 days.
 *   - Creative patterns we haven't predicted (e.g. "AI-generated UGC", "live-shopping
 *     replay") emerge constantly — Claude tags what's actually there.
 *   - User relevance depends on USER'S vertical, audience, and angle gaps.
 */

async function enrichWithAI(ads) {
  const batches = chunk(ads, 10);
  return Promise.all(batches.map(async batch => {
    const prompt = `For each of these 10 Meta ads, in strict JSON, return:
    [{adId, creativePattern, primaryAngle, stealableInsight}].
    Pattern: choose from [testimonial, product_demo, lifestyle, urgency, 
    social_proof, before_after, founder_story, price_anchor, FOMO].
    Insight: 1-sentence on what makes this ad work for someone to copy.
    Ads: ${JSON.stringify(batch.map(a => ({id: a.adId, text: a.adText, daysRunning: a.daysRunning, mediaType: a.mediaType})))}`;
    
    const resp = await getClaude().messages.create({
      messages: [{ role: 'user', content: prompt }],
    });
    return JSON.parse(resp.content[0]?.text || '');
  })).then(arr => arr.flat());
}

async function enrichAdsWithIntelligence({ ads, competitor, userBrand, scanContext }) {
  if (!ads || ads.length === 0) return [];

  // Strip down ads to just the fields Claude needs (saves tokens)
  const adSummaries = ads.map((ad, idx) => ({
    idx,
    pageName: ad.pageName,
    text: (ad.adText || '').slice(0, 400),
    mediaType: ad.mediaType,
    daysRunning: ad.daysRunning,
    platforms: ad.platforms,
    cta: ad.cta,
    advertiserVerified: ad.advertiser.verified,
    advertiserIgFollowers: ad.advertiser.igFollowers,
  }));

  const systemPrompt = `You are a senior performance marketer analyzing competitor ads. For each ad, you produce structured intelligence the user can act on.

Output ONLY valid JSON in this exact shape:
{
  "ads": [
    {
      "idx": 0,
      "relevanceScore": 87,
      "creativePattern": "before_after_transformation" | "ugc_testimonial" | "carousel_product_grid" | "lifestyle_aspirational" | "discount_urgency" | "social_proof_metrics" | "founder_speaks" | "feature_demo" | "<your_own_label>",
      "primaryAngle": "trust" | "scarcity" | "transformation" | "authority" | "convenience" | "price" | "social_proof" | "exclusivity" | "<your_own>",
      "isWinner": true,
      "winnerReason": "Running 87 days = Meta hasn't killed it = profitable",
      "stealableInsight": "One-sentence specific tactical takeaway the user can apply tomorrow"
    }
  ]
}

Rules:
- relevanceScore: 0-100, weighted by how much the user can learn from this ad given their brand context.
- isWinner: true if this ad is likely profitable based on duration relative to the user's vertical's typical ad lifecycle. Use your judgment per brand category — fast-moving categories have shorter winner thresholds.
- creativePattern: Use the pre-defined labels when they fit, but invent new specific labels when none fit. Don't force-fit.
- stealableInsight: Must be specific and actionable, not generic. Example: "Use 'AED 599/month' price anchoring in your headline" not "Lower the price barrier."
- Skip ads that are clearly off-topic for the user (e.g. job posts, recruitment ads when user is e-commerce).`;

  const userMessage = `User's brand: ${userBrand.name}
User's vertical: ${scanContext.vertical || 'unspecified'}
User's category: ${userBrand.category || 'unspecified'}
User's value props: ${(userBrand.valueProps || []).slice(0, 3).join('; ')}
User's audience: ${userBrand.audience || 'unspecified'}

Competitor being analyzed: ${competitor.name}
Competitor's positioning: ${competitor.tagline || competitor.differentiator || ''}

Competitor ads to score (${ads.length} total):
${JSON.stringify(adSummaries, null, 2)}

Score each ad's relevance and tag creative patterns.`;

  const fallback = {
    ads: ads.map((_a, idx) => ({
      idx,
      relevanceScore: 50,
      creativePattern: 'unanalyzed',
      primaryAngle: 'unknown',
      isWinner: ads[idx].daysRunning > 60,
      winnerReason: ads[idx].daysRunning > 60 ? 'Running >60 days' : 'Recent or short-run',
      stealableInsight: 'Manual review needed — AI analysis unavailable.',
    })),
  };

  const result = await safeClaude(
    [{ role: 'user', content: userMessage }],
    { systemPrompt, maxTokens: 4096, fallback }
  );

  // Merge intelligence back onto the ads
  return ads.map((ad, idx) => {
    const intel = (result.ads || []).find((a) => a.idx === idx) || fallback.ads[idx];
    return {
      ...ad,
      intelligence: {
        relevanceScore: intel.relevanceScore,
        creativePattern: intel.creativePattern,
        primaryAngle: intel.primaryAngle,
        isWinner: intel.isWinner,
        winnerReason: intel.winnerReason,
        stealableInsight: intel.stealableInsight,
      },
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 5 — Per-competitor pipeline
// ──────────────────────────────────────────────────────────────────────────

async function fetchCompetitorAds({ competitor, userBrand, scanContext, country = 'AE', limit = 30 }) {
  const result = {
    competitor: competitor.name,
    competitorUrl: competitor.url,
    ads: [],
    strategiesAttempted: [],
    error: null,
    fetchedAt: new Date(),
  };

  try {
    // Stage 1 — AI picks search strategies
    const { strategies } = await resolveCompetitorSearchInputs({
      competitor, userBrand, country, scanContext,
    });

    if (!strategies || strategies.length === 0) {
      result.error = 'no_viable_strategy';
      result.errorReason = 'Competitor name resembles a description rather than a real brand';
      return result;
    }

    // Stage 2 — Try strategies in order until one returns ads
    let rawAds = [];
    for (const strategy of strategies) {
      result.strategiesAttempted.push({
        rank: strategy.rank,
        approach: strategy.approach,
        reasoning: strategy.reasoning,
      });
      try {
        const items = await fetchAdsForSearchInput({
          apifyUrl: strategy.apifyUrl,
          country,
          limit,
        });
        if (items.length > 0) {
          rawAds = items;
          result.successfulStrategy = strategy.approach;
          break;
        }
      } catch (err) {
        result.strategiesAttempted[result.strategiesAttempted.length - 1].failed = err.message;
      }
    }

    if (rawAds.length === 0) {
      result.error = 'no_ads_found';
      result.errorReason = 'All search strategies returned 0 ads. Competitor may not run Meta ads in this country, or page is not in the public Ad Library.';
      return result;
    }

    // Stage 3 — Normalize
    const normalizedAds = rawAds.map(normalizeAd).filter(Boolean);

    // Stage 4 — AI enriches with relevance + creative pattern
    const enrichedAds = await enrichAdsWithIntelligence({
      ads: normalizedAds, competitor, userBrand, scanContext,
    });

    // Sort by relevance score descending; cap to top 20 to avoid UI overflow
    result.ads = enrichedAds
      .sort((a, b) => (b.intelligence?.relevanceScore || 0) - (a.intelligence?.relevanceScore || 0))
      .slice(0, 20);

    return result;
  } catch (err) {
    result.error = 'pipeline_failed';
    result.errorReason = err.message || 'Unknown error in fetchCompetitorAds';
    console.error('[fb-ads-ai] pipeline error for', competitor.name, err);
    return result;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 6 — Parallel fan-out for multiple competitors
// ──────────────────────────────────────────────────────────────────────────

/**
 * Top-level entry point called from urlToAdsService.
 *
 * Fans out competitor ad fetches in parallel with bounded concurrency (3 at a
 * time). Each fetch is independent — one competitor failing doesn't block the
 * others. Returns a structured summary the UI can render directly.
 */
async function fetchAllCompetitorAds({ competitors, userBrand, scanContext, country = 'AE', limit = 30 }) {
  if (!competitors || competitors.length === 0) {
    return { results: [], summary: { totalAds: 0, withVideo: 0, winners: 0, errors: [] } };
  }
  // Pre-resolve Facebook page URLs for each competitor before building search
  // strategies. This converts ~20% success rate to ~65-70% by giving Claude
  // a real page URL rather than guessing from a domain name alone.
  let resolvedCompetitors = competitors;
  try {
    resolvedCompetitors = await enrichCompetitorsWithFbPages(
      competitors,
      country,
      scanContext?.vertical,
    );
  } catch (err) {
    console.warn('[fb-ads-ai] Competitor page resolution failed, proceeding without:', err.message);
  }
  // Bounded concurrency to avoid hammering Apify and Claude simultaneously
  const CONCURRENCY = 3;
  const results = [];
  const queue = [...resolvedCompetitors];

  async function worker() {
    while (queue.length > 0) {
      const competitor = queue.shift();
      if (!competitor) return;
      const result = await fetchCompetitorAds({
        competitor, userBrand, scanContext, country, limit,
      });
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Aggregate summary across all competitors
  const allAds = results.flatMap((r) => r.ads || []);
  const summary = {
    totalAds: allAds.length,
    withVideo: allAds.filter((a) => a.mediaType === 'video').length,
    withImage: allAds.filter((a) => a.mediaType === 'image').length,
    withCarousel: allAds.filter((a) => a.mediaType === 'carousel').length,
    winners: allAds.filter((a) => a.intelligence?.isWinner).length,
    competitorsFetched: results.filter((r) => r.ads.length > 0).length,
    competitorsFailed: results.filter((r) => r.error).length,
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ competitor: r.competitor, error: r.error, reason: r.errorReason })),

    // AI-derived top-level insights for the dashboard headline
    topPatterns: extractTopPatterns(allAds),
    spendingHeavyweights: extractSpendingHeavyweights(results),
  };

  return { results, summary };
}

// Helpers — count by tag, sort by frequency
function extractTopPatterns(ads) {
  const counts = {};
  for (const ad of ads) {
    const pattern = ad.intelligence?.creativePattern;
    if (pattern && pattern !== 'unanalyzed') {
      counts[pattern] = (counts[pattern] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));
}

function extractSpendingHeavyweights(results) {
  return results
    .filter((r) => r.ads.length > 0)
    .map((r) => ({
      competitor: r.competitor,
      activeAdCount: r.ads.length,
      winnerCount: r.ads.filter((a) => a.intelligence?.isWinner).length,
      videoCount: r.ads.filter((a) => a.mediaType === 'video').length,
      avgRelevance: Math.round(
        r.ads.reduce((sum, a) => sum + (a.intelligence?.relevanceScore || 0), 0) / r.ads.length
      ),
    }))
    .sort((a, b) => b.activeAdCount - a.activeAdCount);
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────

module.exports = {
  // Main entry point used by urlToAdsService / urlToAdsEnrichment
  fetchAllCompetitorAds,

  // Single-competitor variant (useful for re-fetching one competitor on demand)
  fetchCompetitorAds,


  // Lower-level pieces, exposed for testability
  resolveCompetitorSearchInputs,
  fetchAdsForSearchInput,
  normalizeAd,
  enrichAdsWithIntelligence,
  enrichWithAI,
};
