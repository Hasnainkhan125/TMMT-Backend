# Competitor Ads Implementation Summary

## What Was Delivered

A complete test suite + integration fix for rendering competitor Meta ads on the UrlToAds page.

**Status**: ✅ Ready for frontend integration

---

## Problem Solved

Users could scan a URL and get competitor brand names, but **competitor ads from Apify weren't being rendered**. The pipeline existed but was missing:

1. ✅ Unit tests for ad normalization + enrichment
2. ✅ Integration tests for full flow
3. ✅ Manual test runner
4. ✅ API response serialization fix
5. ✅ Comprehensive documentation

---

## What's New

### Test Files Created

#### 1. Unit Tests: `__tests__/services/apify/facebookAdsLibrary.test.js`
- **normalizeAd()** — Tests Apify response shaping
  - Video ads (with/without playable content)
  - Image ads (single/multiple)
  - Carousel ads
  - Spend tier calculation
  - Ghost row filtering
  
- **fetchCompetitorAds()** — Tests single competitor pipeline
  - Strategy fallback when first attempt fails
  - Zero ads handling
  - Apify timeout gracefully
  
- **enrichAdsWithIntelligence()** — Tests AI enrichment
  - Relevance scoring (0-100)
  - Creative pattern tagging
  - Winner determination
  - Insight generation
  
- **fetchAllCompetitorAds()** — Tests parallel fan-out
  - Multiple competitors in parallel
  - Top patterns extraction
  - Partial failure handling

#### 2. Integration Tests: `__tests__/integration/urlToAds-competitor-ads.test.js`
- Full flow: `POST /scan` → enrichment → `GET /scan/{id}`
- Polls until enrichment completes
- Validates data structure
- Tests Apify failure recovery
- Verifies serialization for frontend

#### 3. Manual Test Runner: `__tests__/manual/test-competitor-ads-flow.js`
```bash
# Usage:
node __tests__/manual/test-competitor-ads-flow.js https://brand.com

# Output:
# ✅ Scan created
# ✅ Enrichment complete
# 📊 Summary: 47 ads | 12 winners
# 🎨 Top patterns: before_after (8), lifestyle (6)
# 💰 Biggest spenders: Brand A (24 ads)
```

### Documentation

#### 1. `docs/COMPETITOR_ADS_FLOW.md` — Comprehensive Reference
- Data flow diagram
- All 5 stages of fetching/enrichment
- Data structure reference
- Environment variables
- Debugging guide
- Common issues & fixes

#### 2. `docs/COMPETITOR_ADS_QUICK_START.md` — Quick Reference
- Before/after example
- Setup checklist
- Testing commands
- Rendering tips
- Frontend integration examples
- Troubleshooting flowchart

### Code Changes

#### 1. `services/apify/urlToAdsEnrichment.js`
- Cleaned up debug `console.log` statements
- Already integrated with `fetchAllCompetitorAds()`

#### 2. `controllers/studio/urlToAdsController.js`
- **Added**: `apifyCompetitorAds` serializer
- **Added**: `competitorAdsSummary` serializer
- Now returns competitor ads + summary to frontend

#### 3. `services/apify/actors/facebookAdsLibrary.js`
- No changes (already functional)
- Reference: Claude AI pipeline for search strategies + enrichment

#### 4. `services/apify/urlToAdsEnrichment.js`
- No changes (already calling the right function)
- Reference: Orchestrates Apify parallel tasks

---

## Data Flow (Updated)

### Request
```
POST /studio/url-to-ads/scan
{
  "url": "https://brand.com"
}
```

### Response (Immediate)
```json
{
  "success": true,
  "scan": {
    "id": "scan_123",
    "status": "scanning",
    "brand": { "name": "Brand" },
    "competitors": [ "CompA", "CompB", "CompC" ],
    "apifyCompetitorAds": [],
    "competitorAdsSummary": null
  }
}
```

### Background Job (30-90s)
```
runScanEnrichmentJob()
  ├─ runApifyEnrichment()
  │  └─ fetchAllCompetitorAds()
  │     ├─ Resolve search strategies (AI)
  │     ├─ Fetch from Apify
  │     ├─ Normalize ads
  │     └─ Enrich with intelligence (AI)
  ├─ Money math
  ├─ Intelligence layer
  └─ Roast engine
  → scan.apifyData.competitorAds = results
  → save()
```

### Frontend Fetch (Poll until ready)
```
GET /studio/url-to-ads/scan/scan_123

{
  "success": true,
  "scan": {
    "id": "scan_123",
    "status": "ready",
    "apifyCompetitorAds": [
      {
        "competitor": "CompA",
        "ads": [
          {
            "adId": "12345",
            "adText": "Copy...",
            "mediaType": "image",
            "daysRunning": 60,
            "intelligence": {
              "relevanceScore": 85,
              "creativePattern": "before_after_transformation",
              "isWinner": true,
              "stealableInsight": "Use split-screen..."
            }
          }
        ]
      }
    ],
    "competitorAdsSummary": {
      "totalAds": 47,
      "winners": 12,
      "topPatterns": [
        { "pattern": "before_after_transformation", "count": 8 }
      ],
      "spendingHeavyweights": [
        { "competitor": "CompA", "activeAdCount": 24 }
      ]
    }
  }
}
```

---

## Key Data Structures

### Normalized Ad
```javascript
{
  adId: "12345",           // Apify ID
  pageId: "67890",         // Facebook page ID
  pageName: "Brand Name",  // Advertiser name
  adText: "Copy...",       // Ad copy
  cta: "Shop Now",         // Call-to-action
  
  // Media detection
  mediaType: "image" | "video" | "carousel",
  images: ["url1", "url2"],
  videos: [{ hd, sd, preview }],
  cards: [{ title, image, cta }],  // for carousel
  
  // Lifecycle signals
  startedAt: "2025-12-01T...",
  daysRunning: 152,        // Days the ad has been live
  
  // Spend intelligence
  estSpendRange: { lower: 5000, upper: 10000 },
  weeklySpendTier: "medium",  // light|medium|heavy|huge
  
  // AI enrichment
  intelligence: {
    relevanceScore: 87,     // 0-100, weighted by user's vertical
    creativePattern: "before_after_transformation",  // Tag
    primaryAngle: "transformation",  // Emotion/psychological lever
    isWinner: true,         // AI judges profitability
    winnerReason: "Running 152 days...",  // Explanation
    stealableInsight: "Use before/after split-screen at 0.5s"
  }
}
```

### Competitor Result
```javascript
{
  competitor: "Brand Name",
  competitorUrl: "https://...",
  ads: [/* normalized ads */],  // Top 20 by relevance
  strategiesAttempted: [/* which search methods were tried */],
  successfulStrategy: "keyword_search" | "page_id" | null,
  error: null,  // or error code
  fetchedAt: "2026-05-07T..."
}
```

### Summary
```javascript
{
  totalAds: 47,
  withVideo: 15,
  withImage: 28,
  withCarousel: 4,
  winners: 12,
  competitorsFetched: 3,
  competitorsFailed: 0,
  errors: [],
  
  topPatterns: [
    { pattern: "before_after_transformation", count: 8 },
    { pattern: "lifestyle_aspirational", count: 6 },
    ...
  ],
  
  spendingHeavyweights: [
    {
      competitor: "Brand A",
      activeAdCount: 24,
      winnerCount: 6,
      videoCount: 8,
      avgRelevance: 72
    },
    ...
  ]
}
```

---

## Running Tests

### Install dependencies (if needed)
```bash
npm install
```

### Run all tests
```bash
npm test
```

### Run specific test suites

#### Unit tests (ad normalization)
```bash
npm test -- __tests__/services/apify/facebookAdsLibrary.test.js
```

#### Integration tests (full flow)
```bash
npm test -- __tests__/integration/urlToAds-competitor-ads.test.js
```

#### Manual test (real data)
```bash
node __tests__/manual/test-competitor-ads-flow.js https://realstore.com
```

---

## Environment Setup

```bash
# .env
APIFY_API_TOKEN=your_apify_token
APIFY_FB_ADS_ACTOR=curious_coder/facebook-ads-library-scraper
ANTHROPIC_API_KEY=your_anthropic_key
CLAUDE_MODEL_FAST=claude-haiku-4-5-20251001
URL_TO_ADS_AD_LIBRARY_COUNTRY=AE
```

## Start Services

```bash
# Terminal 1: Start the enrichment worker
node workers/urlToAdsEnrichWorker.js

# Terminal 2: Start your API server
npm start

# Terminal 3: Test
node __tests__/manual/test-competitor-ads-flow.js https://brand.com
```

---

## Frontend Integration

### 1. Add `apifyCompetitorAds` to your component

```jsx
function UrlToAdsPage({ scanId }) {
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const poll = async () => {
      const res = await fetch(`/studio/url-to-ads/scan/${scanId}`);
      const { scan } = await res.json();
      setScan(scan);
      
      if (scan.status !== 'ready') {
        setTimeout(poll, 2000);
      } else {
        setLoading(false);
      }
    };
    poll();
  }, [scanId]);

  return (
    <div>
      {loading && <Spinner />}
      {scan?.apifyCompetitorAds?.length > 0 && (
        <CompetitorAdsPanel
          competitorAds={scan.apifyCompetitorAds}
          summary={scan.competitorAdsSummary}
        />
      )}
    </div>
  );
}
```

### 2. Display competitor ads

```jsx
function CompetitorAdsPanel({ competitorAds, summary }) {
  return (
    <div className="competitor-ads">
      {/* Summary stats */}
      <SummaryCards
        totalAds={summary.totalAds}
        winners={summary.winners}
        topPatterns={summary.topPatterns}
      />

      {/* Competitor grids */}
      {competitorAds.map((comp) => (
        <CompetitorSection
          key={comp.competitor}
          competitor={comp.competitor}
          ads={comp.ads}
        />
      ))}
    </div>
  );
}

function CompetitorSection({ competitor, ads }) {
  return (
    <div>
      <h3>{competitor}</h3>
      <div className="ad-grid">
        {ads.map((ad) => (
          <AdCard
            key={ad.adId}
            image={ad.images?.[0]}
            video={ad.videos?.[0]}
            text={ad.adText}
            pattern={ad.intelligence.creativePattern}
            relevance={ad.intelligence.relevanceScore}
            isWinner={ad.intelligence.isWinner}
            insight={ad.intelligence.stealableInsight}
            daysRunning={ad.daysRunning}
            spendTier={ad.weeklySpendTier}
          />
        ))}
      </div>
    </div>
  );
}
```

---

## Files Summary

```
📁 __tests__/
  📁 services/apify/
    ✅ facebookAdsLibrary.test.js         [NEW - Unit tests]
  📁 integration/
    ✅ urlToAds-competitor-ads.test.js    [NEW - Integration tests]
  📁 manual/
    ✅ test-competitor-ads-flow.js        [NEW - Manual test runner]

📁 controllers/studio/
  📝 urlToAdsController.js                [MODIFIED - Added serializers]

📁 docs/
  ✅ COMPETITOR_ADS_FLOW.md              [NEW - Full reference]
  ✅ COMPETITOR_ADS_QUICK_START.md       [NEW - Quick start]

✅ COMPETITOR_ADS_IMPLEMENTATION.md      [NEW - This file]
```

---

## Quality Checklist

- ✅ Unit tests for ad normalization
- ✅ Unit tests for enrichment pipeline
- ✅ Integration tests for full flow
- ✅ Manual test runner with real API calls
- ✅ API serialization updated (controller)
- ✅ Comprehensive documentation
- ✅ Quick start guide
- ✅ Troubleshooting guide
- ✅ Data structure reference
- ✅ Environment variables documented
- ✅ Frontend integration examples

---

## Next Steps for Frontend Team

1. **Consume the new fields**
   - `scan.apifyCompetitorAds` (array of competitor results)
   - `scan.competitorAdsSummary` (dashboard data)

2. **Implement CompetitorAdsPanel**
   - Display summary stats (total ads, winners, top patterns)
   - Show competitor brands
   - Render ads grid with media (image/video)
   - Display creative pattern badges
   - Show relevance score
   - Display stealable insight on hover/click

3. **Handle loading states**
   - Poll `/scan/{id}` while `status !== 'ready'`
   - Show spinner while enriching
   - Display empty state if no competitor ads

4. **Test with manual runner**
   ```bash
   node __tests__/manual/test-competitor-ads-flow.js https://testbrand.com
   ```

5. **Iterate on UI based on data**
   - Adjust for video vs. image rendering
   - Style patterns/insights
   - Handle edge cases (no ads, errors)

---

## Common Frontend Questions

**Q: Why is `status: 'scanning'` in the first response?**
A: The scan is created immediately, but enrichment runs in the background. Poll until `status === 'ready'`.

**Q: What if `apifyCompetitorAds` is empty?**
A: Either (1) enrichment still running, (2) Apify failed (check errors), or (3) no competitors were detected.

**Q: How do I display video ads?**
A: Check `mediaType === 'video'`. Use `intelligence.videos[0].preview` for poster, link to video player.

**Q: What does `relevanceScore` mean?**
A: 0-100 score of how useful this competitor's ad is for the user's vertical. AI judges based on user's business type and value props.

**Q: What's a "winner" ad?**
A: AI determines profitability based on duration + user vertical. Not just `daysRunning > 60`.

**Q: How are ads sorted?**
A: By `intelligence.relevanceScore` descending. Only top 20 per competitor are returned.

---

## Support

For detailed info, see:
- `docs/COMPETITOR_ADS_FLOW.md` — Full technical reference
- `docs/COMPETITOR_ADS_QUICK_START.md` — Quick reference & troubleshooting
- Test files — Working examples of data structures

---

**Status: Ready for frontend integration** ✅
