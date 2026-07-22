# Competitor Ads — Quick Start

## What Changed?

Your API now returns competitor Meta ads in the UrlToAds scan response.

### Before
```json
{
  "scan": {
    "id": "scan_123",
    "status": "ready",
    "competitors": [/* brand names */],
    "apifyCompetitorAds": []  // empty
  }
}
```

### After
```json
{
  "scan": {
    "id": "scan_123",
    "status": "ready",
    "competitors": [/* brand names */],
    "apifyCompetitorAds": [
      {
        "competitor": "Brand A",
        "ads": [
          {
            "adId": "12345",
            "adText": "Copy from ad",
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
      "topPatterns": [/* patterns */ ]
    }
  }
}
```

---

## Setup

### 1. Ensure environment variables are set

```bash
# .env
APIFY_API_TOKEN=your_token
APIFY_FB_ADS_ACTOR=curious_coder/facebook-ads-library-scraper
ANTHROPIC_API_KEY=your_key
CLAUDE_MODEL_FAST=claude-haiku-4-5-20251001
URL_TO_ADS_AD_LIBRARY_COUNTRY=AE
```

### 2. Verify Redis is running

```bash
redis-cli ping
# Should return: PONG
```

### 3. Start the enrichment worker

```bash
node workers/urlToAdsEnrichWorker.js
# Should print: [url-ads-enrich-worker] starting (concurrency=2)
```

---

## Test It

### Quick Test (Local)
```bash
node __tests__/manual/test-competitor-ads-flow.js https://brand-to-test.com

# Expected output:
# ✅ Scan created: scan_123
# ✅ Status: ready | Competitor Ads: 47
# 📊 Summary: 47 ads | 12 winners
# 🎨 Top patterns: before_after (8)
# 💰 Biggest spenders: Brand A (24 ads)
```

### Unit Tests
```bash
npm test -- __tests__/services/apify/facebookAdsLibrary.test.js
```

### Full Integration
```bash
npm test -- __tests__/integration/urlToAds-competitor-ads.test.js
```

---

## Data Flow at a Glance

```
POST /scan → scanUrl()              [1s]
               ↓
            [Background Job Starts]
               ↓
         runApifyEnrichment()
         │  ├─ fetchAllCompetitorAds()
         │  │  ├─ AI picks search strategy
         │  │  ├─ Apify fetches ads
         │  │  └─ AI enriches (score, pattern, insight)
         │  ├─ Instagram profiles
         │  ├─ Google Maps
         │  └─ TikTok
         │    [~60 seconds]
               ↓
            save() with apifyData
               ↓
GET /scan/{id} → response includes apifyCompetitorAds + summary
```

---

## What Frontend Gets

### `apifyCompetitorAds` - Array of Competitor Results

```javascript
{
  competitor: "Competitor Name",
  competitorUrl: "https://...",
  ads: [
    {
      adId: "...",
      adText: "...",
      mediaType: "image|video|carousel",
      images: ["url"],
      videos: [{ hd, sd, preview }],
      daysRunning: 60,
      weeklySpendTier: "light|medium|heavy|huge",
      intelligence: {
        relevanceScore: 85,        // 0-100
        creativePattern: "...",    // tag
        primaryAngle: "...",       // emotion/angle
        isWinner: true,            // AI judgment
        stealableInsight: "..."    // actionable tip
      }
    }
  ],
  successfulStrategy: "keyword_search|page_id|null",
  error: null // or error code if failed
}
```

### `competitorAdsSummary` - Dashboard Data

```javascript
{
  totalAds: 47,
  winners: 12,
  withVideo: 15,
  withImage: 28,
  withCarousel: 4,
  
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
  ],
  
  errors: [
    { competitor: "BrandX", error: "no_ads_found" }
  ]
}
```

---

## Rendering Tips

### Show Summary Stats
```jsx
<div>
  <p>{summary.totalAds} competitor ads found</p>
  <p>{summary.winners} performing 60+ days</p>
  <p>Top pattern: {summary.topPatterns[0].pattern}</p>
</div>
```

### Show Competitor Ads Grid
```jsx
{apifyCompetitorAds.map((comp) => (
  <div key={comp.competitor}>
    <h3>{comp.competitor}</h3>
    {comp.ads.map((ad) => (
      <AdCard
        image={ad.images[0]}
        video={ad.videos[0]?.preview}
        text={ad.adText}
        pattern={ad.intelligence.creativePattern}
        relevance={ad.intelligence.relevanceScore}
        isWinner={ad.intelligence.isWinner}
        insight={ad.intelligence.stealableInsight}
      />
    ))}
  </div>
))}
```

### Handle Empty/Failed State
```jsx
if (!apifyCompetitorAds?.length) {
  if (competitorAdsSummary?.errors?.length) {
    return <ErrorState errors={competitorAdsSummary.errors} />;
  }
  return <EmptyState />;
}
```

---

## Key Fields for UI

| Field | Usage |
|-------|-------|
| `adId` | Unique key for list |
| `mediaType` | Determine rendering (image/video/carousel) |
| `images[0]` | Thumbnail |
| `videos[0].preview` | Video poster |
| `daysRunning` | "Running 60 days" label |
| `weeklySpendTier` | Budget badge ("💰 heavy spend") |
| `intelligence.relevanceScore` | Star rating (⭐⭐⭐) |
| `intelligence.creativePattern` | Tag/chip ("Before/After") |
| `intelligence.isWinner` | ✅ or ❌ icon |
| `intelligence.stealableInsight` | Tooltip/hover text |

---

## Troubleshooting

### Ads aren't showing?

1. **Check if enrichment job is running**
   ```bash
   ps aux | grep urlToAdsEnrichWorker
   # Should see the worker process
   ```

2. **Check Redis queue**
   ```bash
   redis-cli
   > XREAD STREAMS bullmq:url_ads_enrich 0
   # Should show jobs
   ```

3. **Check scan status**
   ```bash
   GET /scan/{id}
   # Status should be "ready" before ads appear
   ```

4. **Check database directly**
   ```javascript
   db.urlToadScans.findOne({ _id: ObjectId("...") }, {
     "apifyData.competitorAds": 1
   });
   // Should see array of competitor results
   ```

5. **Check logs**
   ```bash
   tail -f logs/*.log | grep -i "facebook_ads\|apify\|competitor"
   ```

---

## Performance

- **First scan**: 40-90 seconds (includes enrichment)
- **Frontend response**: <1 second
- **Cost per scan**: ~$0.05 (Apify + Claude)
- **Cached results**: Search strategies cached 24h (same competitor, same country)

---

## Limits

- **Max competitors scanned**: 5
- **Max ads per competitor**: 30
- **Max displayed**: 20 top ads (sorted by relevance)
- **Timeout**: 60 seconds for enrichment

---

## Files You Modified

```
✅ services/urlToAdsService.js
   - Already calls enrichment (no change needed)

✅ services/apify/urlToAdsEnrichment.js
   - Cleaned up console.logs
   - Already calls fetchAllCompetitorAds

✅ services/apify/actors/facebookAdsLibrary.js
   - Already integrated (no change)

✅ controllers/studio/urlToAdsController.js
   + Added apifyCompetitorAds to serializer
   + Added competitorAdsSummary to serializer

✅ model/schema/urlToAdsScan.js
   - Already supports apifyData field

📁 NEW: __tests__/services/apify/facebookAdsLibrary.test.js
📁 NEW: __tests__/integration/urlToAds-competitor-ads.test.js
📁 NEW: __tests__/manual/test-competitor-ads-flow.js
📁 NEW: docs/COMPETITOR_ADS_FLOW.md
📁 NEW: docs/COMPETITOR_ADS_QUICK_START.md
```

---

## Next Steps

1. **Test locally**
   ```bash
   npm test -- facebookAdsLibrary.test.js
   ```

2. **Run integration test**
   ```bash
   npm test -- urlToAds-competitor-ads.test.js
   ```

3. **Manual test on real data**
   ```bash
   node __tests__/manual/test-competitor-ads-flow.js https://realstore.com
   ```

4. **Update frontend**
   - Consume `apifyCompetitorAds` and `competitorAdsSummary`
   - Render competitor ads panel
   - Display summary stats and patterns

---

## Questions?

See `docs/COMPETITOR_ADS_FLOW.md` for:
- Detailed data flow diagram
- Field reference
- Debugging guide
- Environment variables
