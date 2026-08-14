// services/resolver/verifiers/verifyFacebookPage.js
// Cross-verify that a Facebook Page actually belongs to this brand.
// We scrape the PUBLIC page HTML (not Ads Library, no auth needed).

const axios = require('axios');
const cheerio = require('cheerio');
const { randomUserAgent } = require('../utils/userAgents');
const { sharesRootDomain, normalizeDomain } = require('../utils/normalizeDomain');
const logger = require('../../../utils/logger');

/**
 * Given a candidate FB page URL and the brand's canonical domain,
 * return a confidence score that they are the same entity.
 */
async function verifyFacebookPage(fbPageUrl, canonicalDomain) {
  if (!fbPageUrl || !canonicalDomain) {
    return { confidence: 0, reason: 'missing_input' };
  }
  
  try {
    const response = await axios.get(fbPageUrl, {
      timeout: 10_000,
      maxContentLength: 2 * 1024 * 1024,
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    
    if (response.status !== 200) {
      return { confidence: 0, reason: `http_${response.status}` };
    }
    
    const html = response.data;
    const $ = cheerio.load(html);
    
    // Signal 1: Page's listed website (via meta tags, OG data, or inline JSON)
    const pageWebsite = extractPageWebsite(html, $);
    
    let domainMatch = false;
    if (pageWebsite) {
      domainMatch = sharesRootDomain(pageWebsite, canonicalDomain);
    }
    
    // Signal 2: Page title contains domain-like text or brand name?
    const pageTitle = $('title').text() || $('meta[property="og:title"]').attr('content') || '';
    
    // Signal 3: Page description mentions domain?
    const pageDesc = $('meta[property="og:description"]').attr('content') 
                  || $('meta[name="description"]').attr('content')
                  || '';
    const descMentionsDomain = pageDesc.toLowerCase().includes(normalizeDomain(canonicalDomain));
    
    // Signal 4: Page image exists (active page)
    const hasImage = !!$('meta[property="og:image"]').attr('content');
    
    // Compute confidence
    let confidence = 0;
    const evidence = [];
    
    if (domainMatch) { 
      confidence += 0.7; 
      evidence.push({ field: 'pageWebsite', value: pageWebsite, match: true }); 
    } else if (pageWebsite) {
      confidence += 0.1;
      evidence.push({ field: 'pageWebsite', value: pageWebsite, match: false });
    }
    
    if (descMentionsDomain) { 
      confidence += 0.15; 
      evidence.push({ field: 'description_domain_mention', match: true });
    }
    
    if (hasImage) confidence += 0.05;
    
    // Extract additional useful data
    const likesText = html.match(/(\d{1,3}(?:,\d{3})*)\s+(?:people\s+like|likes)/i);
    const followersText = html.match(/(\d{1,3}(?:,\d{3})*)\s+followers/i);
    
    return {
      confidence: Math.min(confidence, 1),
      evidence,
      data: {
        pageTitle: pageTitle.split(' | ')[0].trim(),
        pageWebsite,
        pageDescription: pageDesc,
        pageImage: $('meta[property="og:image"]').attr('content'),
        likes: likesText ? parseInt(likesText[1].replace(/,/g, ''), 10) : null,
        followers: followersText ? parseInt(followersText[1].replace(/,/g, ''), 10) : null,
      },
    };
  } catch (err) {
    logger.warn({ err: err.code, fbPageUrl }, 'FB page verification failed');
    return { confidence: 0, reason: err.code || 'fetch_error' };
  }
}

function extractPageWebsite(html, $) {
  // Try multiple extraction methods — FB HTML varies
  
  // 1. Explicit link elements
  const extUrl = $('a[href*="lm.facebook.com/l.php"]').attr('href');
  if (extUrl) {
    const match = extUrl.match(/[?&]u=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  
  // 2. Inline JSON often has "website" field
  const websiteMatch = html.match(/"website"\s*:\s*"([^"]+)"/);
  if (websiteMatch) return websiteMatch[1];
  
  // 3. Page info JSON blob
  const pageInfoMatch = html.match(/"page_info"[^}]*"url"\s*:\s*"([^"]+)"/);
  if (pageInfoMatch) return pageInfoMatch[1];
  
  // 4. Contact section URL pattern
  const contactMatch = html.match(/"\\?\/pages\\?\/[^"]*"[^}]*"website"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
  if (contactMatch) return contactMatch[1];
  
  return null;
}

module.exports = { verifyFacebookPage };