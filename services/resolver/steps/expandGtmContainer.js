// services/resolver/steps/expandGtmContainer.js
const axios = require('axios');
const { extractAllTrackingIds } = require('../utils/patternMatchers');
const logger = require('../../../lib/logger');

/**
 * When a site has a GTM container (GTM-XXXXXX) but no visible GA/pixel IDs,
 * fetch the GTM container JavaScript and extract IDs from IT.
 * 
 * This is the trick that catches 90% of modern sites where tracking is
 * configured server-side through GTM rather than hardcoded in HTML.
 */
async function expandGtmContainer(gtmId) {
  if (!gtmId || !/^GTM-[A-Z0-9]+$/.test(gtmId)) {
    return { ids: {}, error: 'invalid_gtm_id' };
  }
  
  // GTM containers are publicly accessible JavaScript bundles
  const url = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
  
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxContentLength: 3 * 1024 * 1024,  // GTM containers can be ~1-2MB
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      validateStatus: s => s === 200,
    });
    
    const containerJs = response.data;
    
    // Run our pattern library against the container JS
    const extracted = extractAllTrackingIds(containerJs);
    
    logger.info({ 
      gtmId, 
      foundIds: Object.fromEntries(
        Object.entries(extracted).map(([k, v]) => [k, v.length])
      ),
    }, 'GTM container expansion complete');
    
    return { ids: extracted, containerSize: containerJs.length };
  } catch (err) {
    logger.debug({ err: err.code, gtmId }, 'GTM container fetch failed');
    return { ids: {}, error: err.code };
  }
}

module.exports = { expandGtmContainer };