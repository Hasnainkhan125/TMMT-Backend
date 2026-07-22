# Competitor Ads Flow — Getting Started

## 🎯 Quick Summary

The system has **two phases**:

1. **Phase 1 (Sync)**: Scrape brand website, detect competitors, return initial data
   - Takes: **30-60 seconds** (depends on website complexity)
   - Returns: Brand data, competitor names, ad blueprints
   
2. **Phase 2 (Async)**: Fetch competitor ads, Instagram/TikTok, enrich with AI
   - Takes: **2-5 minutes** (runs in background)
   - Returns: Meta ads, patterns, insights, social media profiles

---

## 🚀 How to Test (Simple)

### Step 1: Start the Backend

```bash
cd /Users/gaian/Projects/startups/Qumak/qumak-backend

# Kill any existing servers
pkill -f "node index.js" || true

# Start the dev server
npm run dev

# Wait for startup message:
# [nodemon] watching for file changes
# Server running on http://localhost:5001
```

###  Step 2: Create a Scan (Using Curl)

This step takes 30-60 seconds. **Be patient.**

```bash
curl -X POST http://localhost:5001/api/v1/studio/url-to-ads/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://activefitnessstore.com/"}' \
  --max-time 90 \
  | python3 -m json.tool | head -200
```

**What you'll see:**

```json
{
  "success": true,
  "scan": {
    "id": "69fcb7baa17a283fad451ef8",
    "status": "scanning",
    "brand": {
      "name": "Active Fitness Store",
      "category": "premium gym equipment retailer",
      "description": "...",
      "images": [...],
      "socialHandles": {
        "instagramUrl": null,
        "facebookUrl": null
      }
    },
    "competitors": [
      { "name": "Fitness Brand A" },
      { "name": "Fitness Brand B" },
      ...
    ],
    "apifyCompetitorAds": [],    // Not yet - filled by async job
    "competitorAdsSummary": null  // Not yet - filled by async job
  }
}
```

**Save the scan ID** (the `"id"` field).

### Step 3: Check Progress (Poll every 15 seconds)

```bash
SCAN_ID="69fcb7baa17a283fad451ef8"  # Replace with your scan ID

# Check status
curl -s http://localhost:5001/api/v1/studio/url-to-ads/scan/$SCAN_ID | python3 -m json.tool | head -300
```

**Progress indicators:**

```
status: "scanning"        → Still processing
status: "ready"           → Complete!

Look for these fields to appear:
apifyCompetitorAds       → Competitor Meta ads starting to load
competitorAdsSummary     → Summary starting to populate
apifyData.instagramProfiles  → Instagram data loaded
```

### Step 4: When Ready (status = "ready")

You'll see the **complete data structure**:

```json
{
  "scan": {
    "id": "...",
    "status": "ready",
    
    // ✅ Brand intelligence
    "brand": {
      "name": "Active Fitness Store",
      "category": "...",
      "socialHandles": { ... }
    },
    
    // ✅ Competitors detected
    "competitors": [...],
    
    // ✅ Meta ads + AI enrichment
    "apifyCompetitorAds": [
      {
        "competitor": "Competitor Brand",
        "ads": [
          {
            "adId": "12345",
            "adText": "Ad copy...",
            "mediaType": "image|video|carousel",
            "daysRunning": 60,
            "weeklySpendTier": "medium",
            "intelligence": {
              "relevanceScore": 85,
              "creativePattern": "before_after_transformation",
              "isWinner": true,
              "stealableInsight": "Use split-screen at 0.5s"
            }
          }
        ]
      }
    ],
    
    // ✅ Summary + patterns
    "competitorAdsSummary": {
      "totalAds": 47,
      "winners": 12,
      "topPatterns": [
        { "pattern": "before_after", "count": 8 },
        { "pattern": "lifestyle", "count": 6 }
      ],
      "spendingHeavyweights": [
        { "competitor": "Brand A", "activeAdCount": 24 }
      ]
    },
    
    // ✅ Social media data
    "apifyData": {
      "instagramProfiles": [
        {
          "username": "...",
          "followerCount": 10000,
          "postCount": 250
        }
      ],
      "instagramTopPosts": [
        {
          "caption": "...",
          "likeCount": 1500,
          "commentCount": 45
        }
      ],
      "tiktokProfiles": [
        {
          "username": "@...",
          "followerCount": 50000
        }
      ]
    }
  }
}
```

---

## 📊 Real-World Timings

| Phase | Action | Duration | Notes |
|-------|--------|----------|-------|
| 1 | Website scrape | 5-15s | Fast on simple sites, slow on complex ones |
| 1 | Competitor detection (Claude) | 3-5s | API call to Anthropic |
| 1 | Return to user | <1s | Immediate response |
| 2 | Multi-page crawl | 15-30s | Background, optional |
| 2 | Meta Ads Library (Apify) | 20-60s | Parallel per competitor, may timeout |
| 2 | Instagram scraping (Apify) | 10-30s | Parallel, optional |
| 2 | TikTok scraping (Apify) | 10-30s | Parallel, optional |
| 2 | Intelligence/Money Math (Claude) | 10-20s | Optional enrichment |
| | **Total time to "ready"** | **2-5 min** | Depends on API availability |

---

## 🔍 What's Running?

### At Startup

```bash
# Terminal 1: Backend API server
npm run dev
# Listens on port 5001

# Terminal 2: Enrichment worker (auto-started in index.js)
# Picks up jobs from Redis queue
# Processes in background
```

### During a Scan

```
User POST /scan
    ↓
[Backend] urlToAdsService.scrapeUrl()
    ├─ Fetch + parse HTML
    ├─ Extract brand data, OG tags
    ├─ Detect competitors (Claude)
    └─ Return scan doc with status="scanning"
    ↓
[Background Worker] enqueued
    ├─ Multi-page crawl
    ├─ Apify: Meta ads
    ├─ Apify: Instagram
    ├─ Apify: TikTok
    ├─ Claude: AI enrichment
    └─ Update scan doc with status="ready"
```

---

## 🐛 Troubleshooting

### "Scan created but status never changes from 'scanning'"

**Cause**: Enrichment worker not running or crashed

**Fix**:
```bash
# Check if worker is running
ps aux | grep urlToAdsEnrichWorker

# If not, start it:
node workers/urlToAdsEnrichWorker.js

# Or restart backend (auto-starts worker):
npm run dev
```

### "apifyCompetitorAds stays empty"

**Cause**: Apify timeout or API failure (non-blocking)

**Check logs**:
```bash
tail -100 /tmp/backend.log | grep -i apify
```

**Expected behavior**: System continues without Apify data (graceful degradation)

### "Response takes >90 seconds"

**Cause**: Scraper is slow on that domain

**Why**: Some websites:
- Have heavy JavaScript
- Block automated scraping
- Take time to load content

**Fix**: Timeout at 30s and return fallback data

---

## 🎯 Testing Checklist

- [ ] Backend starts without errors
- [ ] `POST /scan` endpoint responds (takes 30-60s)
- [ ] Status changes from "scanning" to "ready"
- [ ] `apifyCompetitorAds` array populated
- [ ] Each ad has `intelligence.relevanceScore`
- [ ] `competitorAdsSummary` has `topPatterns`
- [ ] `apifyData.instagramProfiles` loaded
- [ ] `apifyData.tiktokProfiles` loaded

---

## 📝 For Frontend Development

### What Data is Always Available

These fields are guaranteed (even if enrichment fails):

```javascript
scan.brand.name                // ✅ Always
scan.brand.category            // ✅ Always
scan.competitors               // ✅ Always
scan.ads (3 blueprints)        // ✅ Always
scan.apifyData?.instagramProfiles  // ✅ Usually
scan.apifyData?.tiktokProfiles     // ✅ Usually
```

### What Data is Optional

These may be empty if Apify fails:

```javascript
scan.apifyCompetitorAds        // ❓ May be []
scan.competitorAdsSummary      // ❓ May be {}
scan.apifyData?.instagramTopPosts  // ❓ May be []
```

### Graceful Fallback (Frontend)

```jsx
function UrlToAdsPage({ scanId }) {
  const [scan, setScan] = useState(null);

  useEffect(() => {
    const poll = async () => {
      const res = await fetch(`/api/v1/studio/url-to-ads/scan/${scanId}`);
      const { scan } = await res.json();
      setScan(scan);
      
      // Poll every 10 seconds while "scanning"
      if (scan.status !== 'ready') {
        setTimeout(poll, 10000);
      }
    };
    poll();
  }, [scanId]);

  if (!scan) return <LoadingSpinner />;
  if (scan.status === 'scanning') return <ProgressBar />;

  return (
    <div>
      <BrandCard brand={scan.brand} />
      <CompetitorsCard competitors={scan.competitors} />
      
      {/* Graceful degradation */}
      {scan.apifyCompetitorAds?.length > 0 ? (
        <CompetitorAdsPanel ads={scan.apifyCompetitorAds} />
      ) : (
        <EmptyState message="Competitor ads still loading..." />
      )}
    </div>
  );
}
```

---

## 🔑 API Reference

### Create Scan

```bash
POST /api/v1/studio/url-to-ads/scan
Content-Type: application/json

{
  "url": "https://example.com"
}

Response:
{
  "success": true,
  "scan": { id, status: "scanning", brand, competitors, ... }
}
```

###Get Scan

```bash
GET /api/v1/studio/url-to-ads/scan/{scanId}

Response:
{
  "success": true,
  "scan": { ...full data with apifyCompetitorAds, etc... }
}
```

---

## 📚 File Structure

```
services/
├── urlToAdsService.js              # Main orchestrator
├── apify/
│   ├── urlToAdsEnrichment.js      # Apify orchestrator (parallelizes tasks)
│   └── actors/
│       └── facebookAdsLibrary.js   # Meta Ads Library + AI enrichment
└── urlToAdsEnrichJob.js            # Background job (runs in worker)

controllers/studio/
└── urlToAdsController.js           # HTTP endpoints

workers/
└── urlToAdsEnrichWorker.js         # BullMQ worker
```

---

## ✅ You're Ready!

Now you can:

1. ✅ Create scans
2. ✅ Poll for results
3. ✅ Consume competitor ads + socials
4. ✅ Build frontend UI
5. ✅ Handle failures gracefully

**Next**: Check the frontend integration guide in COMPETITOR_ADS_IMPLEMENTATION.md

---

**Questions?** Check the detailed docs: `docs/COMPETITOR_ADS_FLOW.md`
