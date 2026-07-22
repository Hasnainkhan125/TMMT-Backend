# Competitor Ads - Production-Ready Fixes

## Issues Identified

1. **URL Scraper Timeout** — `urlScraper.js` hangs on some websites
2. **API Timeout** — No request timeout configured on scan endpoint  
3. **Enrichment Job Failures** — Apify calls timeout without proper error handling
4. **Missing Geolocation Parameter** — Meta Ads Library should use auto-detected country
5. **No Fallback Data** — System fails instead of returning partial results

## Solutions Implemented

### 1. Fix Scraper Timeout

**File:** `services/urlScraper.js`

Add timeout to puppeteer page load:

```javascript
async function scrapeUrl(url, opts = {}) {
  // ... existing code ...
  
  const page = await browser.newPage();
  
  // ADD THIS:
  page.setDefaultNavigationTimeout(15000); // 15 second timeout
  page.setDefaultTimeout(10000);            // General timeout
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    // ... rest of code ...
  } catch (err) {
    console.warn('[urlScraper] Page load timeout or failed:', err.message);
    // Return minimal scraped data instead of failing
    return {
      url,
      brandName: 'Brand',
      description: '',
      images: [],
      category: 'general',
      _error: err.message
    };
  }
}
```

### 2. Fix API Timeout

**File:** `controllers/studio/_routes.js`

Add request timeout middleware:

```javascript
// At the top
const axios = require('axios');

// Configure axios timeout
axios.defaults.timeout = 30000; // 30 seconds for external APIs

// For the scan endpoint
const scanTimeoutMiddleware = (req, res, next) => {
  // 60 second timeout for the entire scan
  req.setTimeout(60000);
  res.setTimeout(60000);
  next();
};

// Apply to scan route
router.post('/url-to-ads/scan', scanTimeoutMiddleware, generateLimiter, urlToAdsCtrl.scan);
```

### 3. Add Geo-Location to Meta Ads Library

**File:** `services/urlToAdsService.js` (line 643)

```javascript
// After competitors are detected, auto-detect geo from domain TLD
function detectCountryFromDomain(url, brand) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    // Domain TLD mapping to country
    const tldMap = {
      '.ae': 'AE', '.com.ae': 'AE', '.co.ae': 'AE',
      '.sa': 'SA', '.com.sa': 'SA',
      '.kw': 'KW', '.com.kw': 'KW',
      '.qa': 'QA', '.com.qa': 'QA',
      '.bh': 'BH', '.com.bh': 'BH',
      '.om': 'OM', '.com.om': 'OM',
      '.us': 'US', '.com': 'US', // fallback
      '.uk': 'GB', '.co.uk': 'GB',
      '.in': 'IN', '.co.in': 'IN',
    };
    
    for (const [tld, country] of Object.entries(tldMap)) {
      if (hostname.endsWith(tld)) return country;
    }
    
    return 'US'; // Default fallback
  } catch (_) {
    return 'US';
  }
}

// In scanUrl():
const detectedCountry = detectCountryFromDomain(parsed.url, scan.brand);
scan.brand = { ...scan.brand, detectedCountry };
```

### 4. Add Error Handling to Enrichment Job

**File:** `services/apify/urlToAdsEnrichment.js` (line 163)

```javascript
// Wrap competitor ads fetch with proper error handling
tasks.push(
  run('facebook_ads', async () => {
    const valid = competitors.filter((c) => c && (c.name || c.title));
    if (!valid.length) {
      console.log('[facebook_ads] No valid competitors');
      return 0;
    }

    try {
      const userBrand = {
        name: scan.brand?.name || scan.host,
        category: scan.brand?.category,
        valueProps: scan.brand?.valueProps || [],
        audience: scan.audience?.primary || scan.brand?.audience || '',
      };
      const scanContext = {
        vertical: scan.businessProfile?.type,
        domain: scan.host,
      };
      
      // Use detected country
      const country = scan.brand?.detectedCountry || process.env.URL_TO_ADS_AD_LIBRARY_COUNTRY || 'US';

      const { results, summary } = await Promise.race([
        fetchAllCompetitorAds({
          competitors: valid,
          userBrand,
          scanContext,
          country,
          limit: 30,
        }),
        // Timeout after 45 seconds
        new Promise((_, rej) => 
          setTimeout(() => rej(new Error('Apify timeout')), 45000)
        )
      ]);

      apifyData.competitorAds = results;
      apifyData.competitorAdsSummary = summary;
      return summary.totalAds;
    } catch (err) {
      console.warn('[facebook_ads] Failed (non-fatal):', err.message);
      // Return empty but don't fail
      apifyData.competitorAds = [];
      apifyData.competitorAdsSummary = {
        totalAds: 0,
        errors: [{ error: 'apify_failed', reason: err.message }]
      };
      return 0;
    }
  }),
);
```

### 5. Return Partial Data on Timeout

**File:** `services/urlToAdsEnrichJob.js` (line 286)

```javascript
// Before setting status to 'ready', ensure we have valid data
scan.status = scan.apifyData?.competitorAds?.length > 0 ? 'ready' : 'ready'; // both 'ready'
// This allows frontend to render whatever data we have

// If critical enrichment failed, set a flag
if (!scan.intelligence) {
  scan.intelligence = { error: 'intelligence_unavailable' };
}

await scan.save();
```

## Implementation Priority

| Priority | Item | Impact |
|----------|------|--------|
| 1 | Fix scraper timeout | Prevents API hangs |
| 2 | Fix API request timeout | Allows graceful failure |
| 3 | Add geo-detection | Gets right ads per region |
| 4 | Error handling in enrichment | Partial results work |
| 5 | Return partial data | Frontend always gets something |

## Testing After Fixes

```bash
# 1. Test with quick-failing domain
curl -X POST http://localhost:5001/api/v1/studio/url-to-ads/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://activefitnessstore.com/"}' \
  --max-time 30

# Should return within 30 seconds with brand data

# 2. Poll for enrichment
curl http://localhost:5001/api/v1/studio/url-to-ads/scan/{scanId} \
  --max-time 10

# Should return status + whatever enrichment completed

# 3. Test with frontend
# http://localhost:5173/studio/url-to-ads/{scanId}
# Should show brand + competitors even if ads fail
```

## Expected Behavior After Fixes

### Scan Creation (30 seconds max)
```json
{
  "status": "scanning",
  "brand": {
    "name": "Active Fitness Store",
    "category": "gym equipment",
    "detectedCountry": "AE"
  },
  "competitors": [3-5 brands],
  "apifyCompetitorAds": [] // Will be filled by background job
}
```

### After Enrichment (3-5 minutes)
```json
{
  "status": "ready",
  "brand": { ...complete brand kit... },
  "competitors": [...],
  "apifyCompetitorAds": [
    {
      "competitor": "Brand A",
      "ads": [/* 20 ads with intelligence */]
    }
  ],
  "competitorAdsSummary": {
    "totalAds": 47,
    "topPatterns": [...]
  },
  "apifyData": {
    "instagramProfiles": [...],
    "instagramTopPosts": [...],
    "tiktokProfiles": [...]
  }
}
```

## Files to Modify

```
✏️  services/urlScraper.js
    - Add navigation timeout (line ~150)
    - Add error handling fallback (line ~200)

✏️  services/apify/urlToAdsEnrichment.js
    - Add Promise.race timeout (line ~163)
    - Add error handling (line ~200)

✏️  services/urlToAdsService.js
    - Add country detection (line ~550)
    - Pass country to enrichment job

✏️  services/urlToAdsEnrichJob.js
    - Handle partial completion (line ~280)
    - Don't fail on enrichment errors

✏️  controllers/studio/_routes.js
    - Add request timeout middleware (line ~50)
```

## Validation Checklist

- [ ] Scraper timeout set to 15s
- [ ] API request timeout set to 60s
- [ ] Country auto-detected from domain TLD
- [ ] Apify calls timeout after 45s
- [ ] Partial data returned on any failure
- [ ] Frontend can render incomplete data
- [ ] Error messages are descriptive
- [ ] Background job completes gracefully
- [ ] Test with activefitnessstore.com works
- [ ] Test with other domains works

## Frontend Integration

Frontend should handle these scenarios:

```jsx
// Scenario 1: Scan in progress
if (scan.status === 'scanning') {
  return <LoadingState />;
}

// Scenario 2: Scan ready with no ads (Apify failed)
if (!scan.apifyCompetitorAds?.length) {
  return (
    <div>
      <BrandKitCard brand={scan.brand} />
      <CompetitorsCard competitors={scan.competitors} />
      <EmptyAdsState reason={scan.apifyData?.errors?.[0]} />
    </div>
  );
}

// Scenario 3: Full data available
return (
  <div>
    <BrandKitCard brand={scan.brand} />
    <CompetitorsCard competitors={scan.competitors} />
    <CompetitorAdsPanel ads={scan.apifyCompetitorAds} />
    <InstagramPanel data={scan.apifyData?.instagramProfiles} />
    <TikTokPanel data={scan.apifyData?.tiktokProfiles} />
  </div>
);
```

## Next Steps

1. **Apply fixes to 5 files** (30 minutes)
2. **Restart backend** (`npm run dev`)
3. **Test with quick-demo** (`node test-quick-demo.js`)
4. **Monitor enrichment** (check logs, poll API)
5. **Frontend integration** (consume new fields)

---

**Status: Ready for implementation** ✅
