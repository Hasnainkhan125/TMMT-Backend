'use strict';

/**
 * Step 01 — Scrape a URL: HTML, social handles, palette, products.
 * Reuses your existing services so we test the same code paths Qumak uses.
 *
 * Run: node scripts/apify/01-website.js --url https://www.lifepharmacy.com
 */

const { parseFlags, writeOutput, hashKey, rootDomain } = require('./lib/runner');
const { scrapeUrl } = require('../../services/urlScraper');
const { crawl: multiPageCrawl } = require('../../services/scraper/multiPageCrawler');
const { extractSocialHandles } = require('../../services/scraper/extractSocialHandles');
const { extractBrandPalette } = require('../../services/scraper/extractBrandPalette');
const { extractTeamAndServices } = require('../../services/scraper/extractTeamAndServices');

(async () => {
  const flags = parseFlags(process.argv);
  const url = flags.url;
  if (!url) { console.error('Usage: --url <url>'); process.exit(1); }

  const key = hashKey({ url, step: '01-website' });

  console.log(`[01-website] crawling ${url}`);
  const crawlResult = await multiPageCrawl({ url }).catch((e) => {
    console.warn('multiPageCrawl failed, falling back to single-page:', e.message);
    return null;
  });
  const richHtml = crawlResult?.rawHtml || '';

  const scrape = await scrapeUrl(url, { only: ['palette', 'products', 'ads'] });

  const social = richHtml
    ? await extractSocialHandles({ html: richHtml, url, brand: scrape.brandName })
    : { handles: scrape.socialHandles || {} };

  const palette = richHtml ? extractBrandPalette({ html: richHtml }) : null;
  const teamServices = richHtml
    ? extractTeamAndServices({ html: richHtml, baseUrl: crawlResult?.homepage || url })
    : { team: [], services: [], stats: { teamCount: 0, servicesCount: 0 } };

  const result = {
    url,
    rootDomain: rootDomain(url),
    brandName: scrape.brandName,
    siteName: scrape.siteName,
    title: scrape.title,
    description: scrape.description,
    headlines: scrape.headlines?.slice(0, 10) || [],
    favicon: scrape.favicon,
    socialHandles: { ...scrape.socialHandles, ...social.handles },
    palette: palette || scrape.brandPalette || null,
    fonts: scrape.fonts || [],
    team: teamServices.team.slice(0, 20),
    services: teamServices.services.slice(0, 20),
    productCatalog: scrape.productCatalog || null,
    images: scrape.images?.slice(0, 12) || [],
    pagesCrawled: crawlResult?.pageCount || 1,
  };

  writeOutput('01-website', key, result);

  console.log('\n── Summary ──');
  console.log(` Brand: ${result.brandName}`);
  console.log(` Pages: ${result.pagesCrawled}`);
  console.log(` IG: ${result.socialHandles.instagramHandle || '(none)'}`);
  console.log(` FB: ${result.socialHandles.facebookHandle || '(none)'}`);
  console.log(` TikTok: ${result.socialHandles.tiktokHandle || '(none)'}`);
  console.log(` Team: ${result.team.length} | Services: ${result.services.length}`);
  console.log(` Palette: ${result.palette?.palette?.length || 0} colors`);
})().catch((e) => { console.error(e); process.exit(1); });