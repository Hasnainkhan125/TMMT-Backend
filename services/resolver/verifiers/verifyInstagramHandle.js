// services/resolver/verifiers/verifyInstagramHandle.js
const axios = require('axios');
const cheerio = require('cheerio');
const { randomUserAgent } = require('../utils/userAgents');
const { normalizeDomain } = require('../utils/normalizeDomain');
const logger = require('../../../utils/logger');

async function verifyInstagramHandle(handle, canonicalDomain) {
  if (!handle) return { confidence: 0, reason: 'no_handle' };
  
  const url = `https://www.instagram.com/${handle}/`;
  
  try {
    const response = await axios.get(url, {
      timeout: 10_000,
      maxContentLength: 2 * 1024 * 1024,
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,*/*;q=0.8',
      },
      validateStatus: s => s < 500,
    });
    
    if (response.status !== 200) {
      return { confidence: 0, reason: `http_${response.status}` };
    }
    
    const html = response.data;
    const $ = cheerio.load(html);
    
    // IG meta tags contain bio/external URL
    const ogDescription = $('meta[property="og:description"]').attr('content') || '';
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    
    // Bio often has external link
    const externalLinkMatch = html.match(/"external_url"\s*:\s*"([^"]+)"/);
    const bioLink = externalLinkMatch?.[1];
    
    // Followers count from og:description ("1,234 Followers...")
    const followersMatch = ogDescription.match(/([\d.,]+[KMB]?)\s*Followers/i);
    
    let confidence = 0;
    const evidence = [];
    
    // Domain match in bio
    if (bioLink && bioLink.includes(normalizeDomain(canonicalDomain))) {
      confidence += 0.7;
      evidence.push({ field: 'bio_link', value: bioLink, match: true });
    } else if (bioLink) {
      confidence += 0.2;
      evidence.push({ field: 'bio_link', value: bioLink, match: false });
    }
    
    // Page exists at all
    if (response.status === 200 && ogTitle) confidence += 0.2;
    
    return {
      confidence: Math.min(confidence, 1),
      evidence,
      data: {
        handle,
        bioLink,
        ogTitle,
        ogDescription,
        followers: followersMatch ? parseFollowerCount(followersMatch[1]) : null,
      },
    };
  } catch (err) {
    logger.warn({ err: err.code, handle }, 'IG verification failed');
    return { confidence: 0, reason: err.code || 'fetch_error' };
  }
}

function parseFollowerCount(str) {
  if (!str) return null;
  const cleaned = str.replace(/,/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  if (/K/i.test(str)) return Math.round(num * 1000);
  if (/M/i.test(str)) return Math.round(num * 1_000_000);
  if (/B/i.test(str)) return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

module.exports = { verifyInstagramHandle };