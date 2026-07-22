// services/resolver/steps/fetchAndRender.js
const { chromium } = require('playwright');
const axios = require('axios');
const { isSafeUrl } = require('../utils/ssrfGuard');
const { randomUserAgent } = require('../utils/userAgents');
const { ensureHttps } = require('../utils/normalizeDomain');
const logger = require('../../../utils/logger');
const semaphore = require('../utils/browserSemaphore');



const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_HTML_SIZE = 2.5 * 1024 * 1024;  // 2.5 MB

/**
 * Fetch a URL using axios first (fast, cheap), fall back to Playwright if:
 *  - status is 403/429 (bot protection)
 *  - HTML is suspiciously empty (<1KB body + no meta tags)
 *  - Content-Type suggests SPA that needs JS
 * 
 * Returns: {
 *   html, renderedHtml, finalUrl, statusCode, headers, 
 *   responseTimeMs, screenshots, networkRequests, method
 * }
 */
async function fetchAndRender(url, opts = {}) {
  const normalizedUrl = ensureHttps(url);
  
  // SSRF guard
  const safety = await isSafeUrl(normalizedUrl);
  if (!safety.safe) {
    throw Object.assign(new Error('URL blocked by SSRF guard'), {
      code: 'SSRF_BLOCKED',
      reason: safety.reason,
    });
  }
  
  const start = Date.now();
  
  // ── Stage 1: Cheap axios fetch ─────────────────────────────
  let axiosResult = null;
  try {
    axiosResult = await axios.get(normalizedUrl, {
      timeout: 10_000,
      maxContentLength: MAX_HTML_SIZE,
      maxRedirects: 5,
      validateStatus: s => s < 500, // Accept 3xx, 4xx; only throw on 5xx
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': opts.acceptLanguage || 'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Upgrade-Insecure-Requests': '1',
      },
      responseType: 'text',
      decompress: true,
    });
  } catch (err) {
    logger.warn({ err: err.code, url }, 'axios fetch failed, falling back to Playwright');
  }
  
  const axiosOk = axiosResult 
    && axiosResult.status >= 200 && axiosResult.status < 400
    && typeof axiosResult.data === 'string'
    && axiosResult.data.length > 1024;
  
  // Heuristic: is this SPA-like (needs rendering)?
  const looksLikeSpa = axiosOk && (
    axiosResult.data.length < 5000 ||                    // Tiny HTML shell
    /<div\s+id=["']root["']\s*>\s*<\/div>/.test(axiosResult.data) ||
    /<div\s+id=["']app["']\s*>\s*<\/div>/.test(axiosResult.data)
  );
  

  // Detect WordPress in axios HTML — known lazy-loader of trackers
const isWordPress = axiosOk && /wp-content|wp-includes|wp-json/.test(axiosResult.data);

// Detect Shopify — same problem
const isShopify = axiosOk && /cdn\.shopify\.com|shopify\.theme/.test(axiosResult.data);

const forcePlaywright = opts.forcePlaywright 
  || looksLikeSpa
  || opts.needsScreenshot
  || isWordPress             // NEW — WP always lazy-loads tracking via wp_footer
  || isShopify               // NEW — Shopify's trekkie fires post-DOM
  || (axiosOk && !hasTrackingHints(axiosResult.data))
  || (axiosOk && axiosResult.data.length < 15_000);
  // If axios succeeded AND it's not SPA-like AND we don't need screenshots, we're done
  if (forcePlaywright) {
    logger.info({ 
      url: normalizedUrl, 
      reason: {
        looksLikeSpa,
        needsScreenshot: opts.needsScreenshot,
        isWordPress,
        isShopify,
        noTrackingHints: axiosOk && !hasTrackingHints(axiosResult.data),
        tinyHtml: axiosOk && axiosResult.data.length < 15_000,
      }
    }, '⚡ FORCING PLAYWRIGHT');
  }
  if (axiosOk && !looksLikeSpa && !opts.needsScreenshot && !forcePlaywright) {
    return {
      html: axiosResult.data,
      renderedHtml: axiosResult.data,
      finalUrl: axiosResult.request?.res?.responseUrl || normalizedUrl,
      statusCode: axiosResult.status,
      headers: axiosResult.headers,
      responseTimeMs: Date.now() - start,
      method: 'axios',
      screenshots: null,
      networkRequests: null,
    };
  }
  
  // ── Stage 2: Playwright render ─────────────────────────────
  return renderWithPlaywright(normalizedUrl, {
    ...opts,
    axiosFallback: axiosResult?.data,
    startTime: start,
  });
}

async function renderWithPlaywright(url, opts) {
  await semaphore.acquire();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
  });
  
  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Dubai',
      // Stealth tweaks
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
    });
    
    // Stealth: remove webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
    
    const page = await context.newPage();
    
    // Capture network requests — critical for detecting ad pixels,
    // tracking calls, and third-party scripts
    const networkRequests = [];
    page.on('request', req => {
      const reqUrl = req.url();
      // Only capture interesting ones
      if (isInterestingNetworkRequest(reqUrl)) {
        networkRequests.push({
          url: reqUrl,
          method: req.method(),
          resourceType: req.resourceType(),
        });
      }
    });
    
    // Block images/fonts/media if we don't need screenshots — saves ~60% bandwidth
    if (!opts.needsScreenshot) {
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,mp4,webm}', r => r.abort());
    }
    
    // Navigate
    const response = await page.goto(url, {
        waitUntil: opts.needsScreenshot ? 'networkidle' : 'domcontentloaded',
        timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
      });
      const domain = new URL(url).hostname;
      const isSlowPlatform = /myshopify\.com|shopify\.com/.test(domain) 
        || /squarespace|wix|webflow/.test(domain);
      
      if (isSlowPlatform) {
        // Wait for a second round of scripts to load (trackers, pixels)
        await page.waitForTimeout(3000);
        try {
          await page.waitForLoadState('networkidle', { timeout: 8000 });
        } catch {
          // networkidle can hang forever on chat widgets — move on
        }
      }
      
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const statusCode = response?.status() || 0;
    const headers = response?.headers() || {};
    
    const renderedHtml = await page.content();
    
    // Screenshots
    let screenshots = null;
    if (opts.needsScreenshot) {
      screenshots = {
        desktop: await page.screenshot({ 
          type: 'webp', 
          quality: 80,
          fullPage: false,
        }),
        fullPage: await page.screenshot({ 
          type: 'webp', 
          quality: 70,
          fullPage: true,
        }).catch(() => null),
      };
    }
    
    return {
      html: opts.axiosFallback || renderedHtml,
      renderedHtml,
      finalUrl,
      statusCode,
      headers,
      responseTimeMs: Date.now() - opts.startTime,
      method: 'playwright',
      screenshots,
      networkRequests,
    };
  } finally {
    await browser.close().catch(() => {});
    semaphore.release();
  }
}

// Network requests we care about for intelligence
const INTERESTING_REQUEST_PATTERNS = [
  /facebook\.net|facebook\.com/,
  /google-analytics|googletagmanager|googleads|doubleclick/,
  /analytics\.tiktok\.com/,
  /snap\.licdn\.com|linkedin\.com/,
  /tr\.snapchat\.com/,
  /ct\.pinterest\.com/,
  /analytics\.twitter\.com|static\.ads-twitter/,
  /hotjar\.com|clarity\.ms/,
  /segment\.com|segment\.io/,
  /klaviyo\.com/,
  /intercom\.io|intercom\.com/,
  /hs-scripts\.com|hubspot/,
  /stripe\.com|checkout\.com|paddle\.com/,
  /cdn\.shopify\.com/,
];

function isInterestingNetworkRequest(url) {
  return INTERESTING_REQUEST_PATTERNS.some(re => re.test(url));
}

function hasTrackingHints(html) {
    // Quick check: if the HTML contains ANY reference to a tracker,
    // axios result is probably usable.
    return /googletagmanager|google-analytics|gtag\(|fbq\(|ttq\.|hotjar|klaviyo|intercom|snaptr\(|linkedin_data_partner/i.test(html);
  }

module.exports = { fetchAndRender,  MAX_CONCURRENT_BROWSERS: parseInt(process.env.MAX_CONCURRENT_BROWSERS || '4', 10),
    // If we're at capacity, fall back to axios even if Playwright would be preferred
  CAPACITY_FALLBACK_ENABLED: true,
};