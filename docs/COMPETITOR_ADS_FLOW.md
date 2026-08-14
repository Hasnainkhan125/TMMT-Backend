# Competitor Ads Flow — UrlToAds Integration

## Overview

The competitor ads feature integrates Facebook/Instagram Ad Library intelligence into the UrlToAds scan report. When a user pastes a URL:

1. **Scan creation** (sync) — scrapes the brand, infers competitors
2. **Enrichment** (async background job) — fetches competitor Meta ads, normalizes them, enriches with AI intelligence
3. **Frontend rendering** — displays competitor ads with creative patterns, spend tiers, and actionable insights

## Data Flow Diagram

```
User Pastes URL
    ↓
scanUrl() [urlToAdsService.js]
    ├─ Scrape brand/competitors (sync)
    ├─ Create UrlToAdsScan document
    └─ Enqueue enrichment job
         ↓
    runScanEnrichmentJob() [urlToAdsEnrichJob.js]
         ├─ Multi-page crawl
         ├─ runApifyEnrichment() [urlToAdsEnrichment.js]
         │   ├─ fetchAllCompetitorAds() [facebookAdsLibrary.js]
         │   │   ├─ resolveCompetitorSearchInputs() — AI picks search strategy
         │   │   ├─ fetchAdsForSearchInput() — Apify call
         │   │   ├─ normalizeAd() — shape Apify response
         │   │   └─ enrichAdsWithIntelligence() — AI scores & tags
         │   ├─ Instagram profiles
         │   ├─ TikTok profiles
         │   └─ Google Maps places
         ├─ Money math
         ├─ Intelligence layer
         └─ Roast engine
         ↓
    scan.save() with apifyData.competitorAds populated
         ↓
Frontend GET /scan/{id}
    ↓
serializer [urlToAdsController.js]
    ├─ apifyCompetitorAds (from apifyData.competitorAds)
    ├─ competitorAdsSummary (from apifyData.competitorAdsSummary)
    └─ JSON response
         ↓
UrlToAdsPage renders competitor ads panel
```

## Key Files

| File | Purpose |
|------|---------|
| `services/urlToAdsService.js` | Main orchestrator; calls scanUrl, generateAds |
| `services/apify/actors/facebookAdsLibrary.js` | Apify + AI pipeline; fetches/enriches ads |
| `services/apify/urlToAdsEnrichment.js` | Background enrichment orchestrator |
| `services/urlToAdsEnrichJob.js` | BullMQ worker; runs background enrichment |
| `controllers/studio/urlToAdsController.js` | HTTP serializer; returns data to frontend |
| `model/schema/urlToAdsScan.js` | MongoDB schema; stores all scan data |

## Data Structures

### Scan Response (Frontend)

```javascript
{
  id: "scan_123",
  url: "https://brand.com",
  status: "ready", // "scanning" | "ready" | "rendering" | "partial" | "failed"
  
  // ← NEW: Competitor ads from Apify pipeline
  apifyCompetitorAds: [
    {
      competitor: "Competitor Brand Name",
      competitorUrl: "https://competitor.com",
      ads: [ /* normalized ads with intelligence */ ],
      strategiesAttempted: [ /* which search strategies were tried */ ],
      successfulStrategy: "keyword_search" | "page_id" | null,
      error: null | "error_code",
      fetchedAt: "2026-05-07T15:30:00Z"
    }
  ],

  // ← NEW: Summary statistics for the dashboard
  competitorAdsSummary: {
    totalAds: 47,
    withVideo: 15,
    withImage: 28,
    withCarousel: 4,
    winners: 12,
    competitorsFetched: 3,
    competitorsFailed: 0,
    errors: [ /* per-competitor errors */ ],
    topPatterns: [
      { pattern: "before_after_transformation", count: 8 },
      { pattern: "lifestyle_aspirational", count: 6 }
    ],
    spendingHeavyweights: [
      {
        competitor: "Brand A",
        activeAdCount: 24,
        winnerCount: 6,
        videoCount: 8,
        avgRelevance: 72
      }
    ]
  },

  // Existing fields still present
  brand: { /* brand kit */ },
  businessProfile: { /* inferred type, category */ },
  competitors: [ /* AI-generated competitor list */ ],
  ads: [ /* 3 blueprint ads */ ],
  ...
}
```

### Normalized Ad Structure

```javascript
{
  // Apify-sourced fields
  adId: "123456",
  pageId: "789",
  pageName: "Brand Name",
  adText: "Copy from the ad",
  cta: "Shop Now",
  
  // Media detection
  mediaType: "image" | "video" | "carousel",
  images: ["https://cdn.url"],
  videos: [
    { hd: "url", sd: "url", preview: "url" }
  ],
  cards: [ /* carousel items */ ],
  
  // Lifecycle
  startedAt: "2025-12-01T00:00:00Z",
  endedAt: "2026-05-01T00:00:00Z",
  daysRunning: 152,
  
  // Spend intelligence
  estSpendRange: { lower: 5000, upper: 10000, currency: "AED" },
  weeklySpendTier: "light" | "medium" | "heavy" | "huge",
  
  // Advertiser signals
  advertiser: {
    pageLikes: 50000,
    igFollowers: 25000,
    verified: true,
    category: "Fashion & Apparel"
  },
  
  // ← AI enrichment (critical for product)
  intelligence: {
    relevanceScore: 87,  // 0-100; how useful for user's brand
    creativePattern: "before_after_transformation" | "ugc_testimonial" | ...,
    primaryAngle: "transformation" | "scarcity" | "authority" | ...,
    isWinner: true,  // AI determined; not just daysRunning > 60
    winnerReason: "Running 152 days in beauty = long-term profitability",
    stealableInsight: "Use before/after split-screen at 0.5s mark for 34% higher engagement"
  }
}
```

## Execution Flow

### 1. Initial Scan (Synchronous, <15s)

```javascript
// POST /studio/url-to-ads/scan
const scan = await urlToAdsService.scanUrl({ url, req });

// Returns:
// {
//   id: "scan_123",
//   status: "scanning",  // ← user sees "Loading..."
//   brand: { ... },
//   competitors: [ /* AI-picked */ ],
//   ads: [ /* 3 blueprints */ ],
//   apifyCompetitorAds: [],  // ← empty (not yet fetched)
//   competitorAdsSummary: null
// }
```

**What happens:**
- `scrapeUrl()` fetches the page
- `researchBrand()` calls Claude for brand/audience/competitors (one API call)
- `buildAdBlueprint()` creates 3 ad variants
- Document saved with `status='scanning'`

**NOT DONE YET:** Competitor ads from Apify

---

### 2. Background Enrichment (Async, 30-90s)

```javascript
// BullMQ worker runs:
const { apifyData } = await runApifyEnrichment(scan, { budgetMs: 60_000 });
scan.set('apifyData', apifyData);
await scan.save();
```

**In `runApifyEnrichment()`, parallel tasks:**

#### Task: Facebook Ads Library Fetch

```javascript
const { results, summary } = await fetchAllCompetitorAds({
  competitors: scan.competitors,  // AI-picked brands
  userBrand: { name, category, valueProps },
  scanContext: { vertical, domain },
  country: 'AE',
  limit: 30
});

// results = [ per-competitor result object ]
// summary = { totalAds, winners, topPatterns, spendingHeavyweights, errors }

apifyData.competitorAds = results;
apifyData.competitorAdsSummary = summary;
```

**Inside `fetchAllCompetitorAds()`, per competitor:**

1. **Stage 1: Resolve search strategy**
   ```javascript
   const { strategies } = await resolveCompetitorSearchInputs({
     competitor: { name: "Nike", url: "https://nike.com" },
     userBrand, country, scanContext
   });
   // Claude picks 3 strategies (keyword, page URL, page ID)
   ```

2. **Stage 2: Fetch from Apify**
   ```javascript
   for (const strategy of strategies) {
     const items = await fetchAdsForSearchInput({
       apifyUrl: strategy.apifyUrl,
       country: 'AE',
       limit: 30
     });
     if (items.length > 0) break;  // Try next if empty
   }
   ```

3. **Stage 3: Normalize**
   ```javascript
   const normalized = items.map(normalizeAd).filter(Boolean);
   // Extracts: adId, text, images, videos, spend, daysRunning, etc.
   ```

4. **Stage 4: AI Enrichment**
   ```javascript
   const enriched = await enrichAdsWithIntelligence({
     ads: normalized,
     competitor, userBrand, scanContext
   });
   // Claude scores each ad:
   // - relevanceScore (0-100 based on user's vertical)
   // - creativePattern (tags like "before_after", "ugc", "carousel")
   // - isWinner (AI judges profitability)
   // - stealableInsight (actionable takeaway)
   ```

5. **Stage 5: Return**
   ```javascript
   return {
     competitor: "Nike",
     competitorUrl: "...",
     ads: enriched,  // Sorted by relevance, top 20
     strategiesAttempted: [/* which were tried */],
     successfulStrategy: "keyword_search",
     error: null
   };
   ```

---

### 3. Frontend Fetch (On Demand, <1s)

```javascript
// GET /studio/url-to-ads/scan/:id
const scan = await UrlToAdsScan.findById(id);
const serialized = serializeScan(scan);
```

**Serializer returns:**
```javascript
{
  apifyCompetitorAds: scan.apifyData?.competitorAds || [],
  competitorAdsSummary: scan.apifyData?.competitorAdsSummary || null,
  // ... other fields
}
```

---

## Environment Variables

```bash
# Apify configuration
APIFY_FB_ADS_ACTOR=curious_coder/facebook-ads-library-scraper
URL_TO_ADS_AD_LIBRARY_COUNTRY=AE  # or US, UK, etc.

# Claude (for search strategy + enrichment)
ANTHROPIC_API_KEY=sk-...
CLAUDE_MODEL_FAST=claude-haiku-4-5-20251001

# Optional: skip enrichment for testing
URL_TO_ADS_SKIP_SUPPLEMENTAL_MAPS=1
```

---

## Debugging

### Ads not showing on frontend?

**Check 1: Is enrichment job running?**
```bash
# Watch the Redis queue
redis-cli
> XREAD STREAMS bullmq:url_ads_enrich 0
```

**Check 2: Are competitor ads populated in the database?**
```javascript
db.urlToadScans.findOne({ _id: ObjectId("...") }, {
  "apifyData.competitorAds": 1,
  "apifyData.competitorAdsSummary": 1
});
```

**Check 3: Is the controller serializing correctly?**
- Check `urlToAdsController.js` `serializeScan()` function
- Make sure `apifyCompetitorAds` and `competitorAdsSummary` are included

**Check 4: Is Apify responding?**
- Check logs: `[urlToAdsEnrichment] facebook_ads` task
- If timeout, increase `budgetMs` in `runApifyEnrichment()`

**Check 5: Are competitors being detected?**
- `scan.competitors` should have 3-5 brands picked by Claude
- If empty, `researchBrand()` may have failed (check API limit)

---

## Testing

### Unit Tests
```bash
# Test ad normalization
npm test -- __tests__/services/apify/facebookAdsLibrary.test.js

# Test enrichment orchestration
npm test -- __tests__/services/apify/urlToAdsEnrichment.test.js
```

### Integration Tests
```bash
# Test full flow: scan → enrich → response
npm test -- __tests__/integration/urlToAds-competitor-ads.test.js
```

### Manual Testing
```bash
# Local test runner (polls until enrichment completes)
node __tests__/manual/test-competitor-ads-flow.js https://example.com

# Expected output:
# ✅ Scan created
# ✅ Enrichment complete
# ✅ 47 competitor ads found
# ✅ Top patterns: before_after (8), lifestyle (6)
# ✅ Data structure valid
```

---

## Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| `apifyCompetitorAds` is `[]` | Enrichment job failed | Check Redis queue, Apify error logs |
| `competitorAdsSummary` is `null` | Search strategies all failed | Check `resolveCompetitorSearchInputs()` output |
| No competitor ads but no error | Apify returned 0 items for all strategies | Verify Apify actor is working; try country code |
| AI enrichment missing | Claude API unavailable | Check `ANTHROPIC_API_KEY` and rate limits |
| Slow enrichment (>2min) | Apify timeouts | Reduce competitors count or increase `budgetMs` |
| Wrong competitor data | Invalid search strategy | Run `researchBrand()` manually; check Claude output |

---

## Frontend Integration

### Display Competitor Ads Panel

```jsx
// UrlToAdsPage.jsx
function CompetitorAdsSection({ scan }) {
  const { apifyCompetitorAds, competitorAdsSummary } = scan;

  if (!apifyCompetitorAds?.length) {
    return <EmptyState />;
  }

  return (
    <div>
      {/* Summary Dashboard */}
      <SummaryCards summary={competitorAdsSummary} />
      
      {/* Top Patterns */}
      <TopPatternsGrid patterns={competitorAdsSummary.topPatterns} />
      
      {/* Competitor Ads Grid */}
      {apifyCompetitorAds.map((competitorResult) => (
        <CompetitorSection key={competitorResult.competitor} {...competitorResult} />
      ))}
    </div>
  );
}

function CompetitorSection({ competitor, ads }) {
  return (
    <div>
      <h3>{competitor}</h3>
      <Grid>
        {ads.map((ad) => (
          <AdCard
            key={ad.adId}
            ad={ad}
            // Show creative pattern as badge
            pattern={ad.intelligence.creativePattern}
            // Show relevance score
            relevance={ad.intelligence.relevanceScore}
            // Show stealable insight in tooltip
            insight={ad.intelligence.stealableInsight}
          />
        ))}
      </Grid>
    </div>
  );
}
```

---

## Performance Notes

- **Apify cost**: ~$0.30-0.50 per scan (5 competitors × 30 ads)
- **Claude cost**: ~$0.02-0.05 per scan (search strategies + enrichment)
- **Latency**: 30-90 seconds background, 1-2 seconds frontend fetch
- **Cache**: Redis caches search strategies 24h per (competitor, country)

---

## Future Enhancements

- [ ] Export competitor ads as CSV
- [ ] Batch social ads from Google Ads (not just Meta)
- [ ] Real-time ad spend tracking
- [ ] Competitor alerts ("Brand X launched 3 new ads")
- [ ] A/B test performance prediction
