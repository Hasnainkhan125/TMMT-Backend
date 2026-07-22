// services/resolver/steps/enrichWithTraffic.js
// Progressive traffic enrichment. Free tier first, optional paid API.
const axios = require('axios');
const logger = require('../../../utils/logger');

/**
 * Get rough traffic signals without requiring auth.
 * All these sources are 'best-effort' — fail silently.
 */
async function enrichWithTraffic(domain) {
  const results = {
    estimatedMonthlyVisits: null,
    trafficSource: null,
    domainAge: null,
    hasStructuredData: null,
    hasSitemap: null,
    pageCount: null,
  };
  
  // 1. Sitemap detection (free, reliable)
  try {
    const sitemapUrl = `https://${domain}/sitemap.xml`;
    const sitemapResp = await axios.head(sitemapUrl, { timeout: 4000 });
    if (sitemapResp.status === 200) {
      results.hasSitemap = true;
      // Try to count URLs in sitemap (rough "site size" signal)
      try {
        const content = await axios.get(sitemapUrl, { 
          timeout: 6000, 
          maxContentLength: 2 * 1024 * 1024,
        });
        const urlCount = (content.data.match(/<url>/g) || []).length;
        const sitemapIndexCount = (content.data.match(/<sitemap>/g) || []).length;
        results.pageCount = urlCount || sitemapIndexCount * 50; // Rough estimate for sitemap index
      } catch {}
    }
  } catch {
    results.hasSitemap = false;
  }
  
  // 2. Robots.txt presence
  try {
    const robotsResp = await axios.get(`https://${domain}/robots.txt`, { 
      timeout: 4000, 
      maxContentLength: 50 * 1024,
    });
    if (robotsResp.data) {
      // Extract sitemap URLs listed in robots.txt
      const sitemapLines = robotsResp.data.match(/^Sitemap:\s*(.+)$/gmi) || [];
      if (sitemapLines.length > 0) {
        results.additionalSitemaps = sitemapLines.map(l => l.replace(/^Sitemap:\s*/i, '').trim());
      }
    }
  } catch {}
  
  // 3. SSL certificate age (rough proxy for domain age)
  // No cheap way to get this from frontend — skip for now, could add Whois API later
  
  // 4. Optional: SimilarWeb free rank endpoint (undocumented, often works)
  // Only if you have SIMILARWEB_API_KEY env var set
  if (process.env.SIMILARWEB_API_KEY) {
    try {
      const swResp = await axios.get(
        `https://api.similarweb.com/v1/similar-rank/${domain}/rank`,
        {
          params: { api_key: process.env.SIMILARWEB_API_KEY },
          timeout: 8000,
        }
      );
      if (swResp.data?.similar_rank) {
        results.alexaRank = swResp.data.similar_rank.rank;
        results.trafficSource = 'similarweb';
      }
    } catch (err) {
      logger.debug({ err: err.code }, 'similarweb enrichment failed');
    }
  }
  
  return results;
}

module.exports = { enrichWithTraffic };