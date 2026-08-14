// services/resolver/enrichment/enrichmentQueue.js
// Background worker — upgrades stale BrandIdentity records + captures screenshots
const { Queue, Worker } = require('bullmq');
const BrandIdentity = require('../../../model/schema/brandIdentity');
const { resolveBrandIdentity } = require('../brandIdentityResolver');
const { uploadToR2 } = require('../../../services/storageService');   // Your existing R2/S3 client
const { chromium } = require('playwright');
const { randomUserAgent } = require('../utils/userAgents');
const logger = require('../../../utils/logger');

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
};

const enrichmentQueue = new Queue('brand-enrichment', { connection });

// Job: screenshot capture (runs after main resolve)
const screenshotQueue = new Queue('brand-screenshots', { connection });

/**
 * Schedule enrichment for a brand.
 * Fire-and-forget from the synchronous resolver.
 */
async function scheduleEnrichment(brandId, opts = {}) {
  await enrichmentQueue.add('enrich', { brandId, ...opts }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

async function scheduleScreenshotCapture(brandId) {
  await screenshotQueue.add('capture', { brandId }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 3 * 24 * 3600, count: 500 },
  });
}

// ── Enrichment worker ──────────────────────────────────────
const enrichmentWorker = new Worker('brand-enrichment', async (job) => {
  const { brandId, force } = job.data;
  const brand = await BrandIdentity.findById(brandId);
  if (!brand) throw new Error('brand_not_found');
  
  logger.info({ brandId, canonical: brand.canonicalDomain }, 'Running enrichment');
  
  // Re-resolve — picks up new fields from latest extractor version
  await resolveBrandIdentity(brand.inputUrl, { forceRefresh: force });
  
  return { brandId };
}, { 
  connection,
  concurrency: 4,
  limiter: { max: 20, duration: 60_000 },
});

// ── Screenshot worker ──────────────────────────────────────
const screenshotWorker = new Worker('brand-screenshots', async (job) => {
  const { brandId } = job.data;
  const brand = await BrandIdentity.findById(brandId);
  if (!brand) throw new Error('brand_not_found');
  
  const url = brand.inputUrl;
  const browser = await chromium.launch({ headless: true });
  
  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
    await page.waitForTimeout(1500);
    
    // Desktop
    const desktopBuf = await page.screenshot({ type: 'webp', quality: 82 });
    const desktopKey = `brand-screenshots/${brand.canonicalDomain}/desktop-${Date.now()}.webp`;
    const desktopUrl = await uploadToR2(desktopBuf, desktopKey, 'image/webp');
    
    // Full page
    const fullBuf = await page.screenshot({ type: 'webp', quality: 75, fullPage: true });
    const fullKey = `brand-screenshots/${brand.canonicalDomain}/full-${Date.now()}.webp`;
    const fullUrl = await uploadToR2(fullBuf, fullKey, 'image/webp');
    
    // Mobile
    await context.close();
    const mobileContext = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Version/17.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
    await mobilePage.waitForTimeout(1500);
    const mobileBuf = await mobilePage.screenshot({ type: 'webp', quality: 82 });
    const mobileKey = `brand-screenshots/${brand.canonicalDomain}/mobile-${Date.now()}.webp`;
    const mobileUrl = await uploadToR2(mobileBuf, mobileKey, 'image/webp');
    
    brand.assets = brand.assets || {};
    brand.assets.screenshots = {
      desktop: desktopUrl,
      mobile: mobileUrl,
      fullPage: fullUrl,
    };
    await brand.save();
    
    return { brandId, desktopUrl, mobileUrl, fullUrl };
  } finally {
    await browser.close();
  }
}, {
  connection,
  concurrency: 2,  // Screenshots are heavy
  limiter: { max: 10, duration: 60_000 },
});

// Error logging
enrichmentWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Enrichment failed');
});
screenshotWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Screenshot failed');
});

module.exports = { 
  enrichmentQueue, 
  screenshotQueue,
  scheduleEnrichment, 
  scheduleScreenshotCapture,
};