// services/resolver/steps/extractTrackingIds.js
const cheerio = require('cheerio');
const { extractAllTrackingIds } = require('../utils/patternMatchers');

/**
 * Extract all tracking/analytics IDs from HTML.
 * Runs against: inline scripts, external script src, HTML body, network requests.
 */
function extractTrackingIds(html, networkRequests = [], renderedHtml = null) {

  // Search in both raw HTML and rendered HTML (rendered catches lazy-loaded scripts)
  const searchText = [html, renderedHtml || ''].join('\n');
  
  // Also append network request URLs — pixel scripts often have IDs in URL params
  const networkUrlText = networkRequests?.length > 0 ? networkRequests.map(r => r.url).join('\n') : '';
  const fullText = [searchText, networkUrlText].join('\n');
  

  const extracted = extractAllTrackingIds(fullText);
  
  // Additionally, parse for indirect signals
  const $ = cheerio.load(html);
  
  // Plausible Analytics (no ID, just presence)
  const plausiblePresent = $('script[src*="plausible.io"]').length > 0
    || $('script[data-domain]').length > 0;
  
  // Fathom Analytics
  const fathomPresent = $('script[src*="usefathom.com"]').length > 0
    || $('script[data-site]').length > 0;
  
  // Matomo / Piwik
  const matomoPresent = /var\s+_paq\s*=/.test(fullText) 
    || $('script[src*="matomo"]').length > 0;
  
  // Cookie consent managers (they tell us about GDPR/tracking complexity)
  const cookieConsent = {
    onetrust:  /cdn\.cookielaw\.org|onetrust/i.test(fullText),
    cookiebot: /consent\.cookiebot\.com/i.test(fullText),
    osano:     /cmp\.osano\.com/i.test(fullText),
    iubenda:   /cdn\.iubenda\.com/i.test(fullText),
    cookieyes: /cookie-?yes|cdn-cookieyes/i.test(fullText),
  };
  
  // Customer engagement platforms
  const engagement = {
    intercom:  /intercom/i.test(fullText),
    drift:     /js\.driftt\.com/i.test(fullText),
    crisp:     /client\.crisp\.chat/i.test(fullText),
    tawk:      /embed\.tawk\.to/i.test(fullText),
    zendeskWidget: /static\.zdassets\.com\/ekr/i.test(fullText),
    hubspotChat: /js\.hs-scripts\.com/i.test(fullText),
  };
  
  // Email capture tools
  const emailCapture = {
    klaviyo:    /klaviyo/i.test(fullText),
    mailchimp:  /mailchimp|list-manage\.com/i.test(fullText),
    omnisend:   /omnisend/i.test(fullText),
    mailerlite: /mailerlite/i.test(fullText),
    convertkit: /convertkit/i.test(fullText),
  };
  
  return {
    ids: extracted,
    presence: {
      plausible: plausiblePresent,
      fathom:    fathomPresent,
      matomo:    matomoPresent,
    },
    cookieConsent,
    engagement,
    emailCapture,
  };
}

/**
 * Convert raw extraction into the structured trackingIds field on the model.
 */
function normalizeTrackingIds(raw) {
  const { ids, presence } = raw;
  
  return {
    googleAnalytics:     [...(ids.googleAnalytics4 || []), ...(ids.googleAnalyticsUA || [])],
    googleTagManager:    ids.googleTagManager || [],
    googleAdsConversion: ids.googleAdsConversion || [],
    facebookPixel:       ids.facebookPixel || [],
    tiktokPixel:         ids.tiktokPixel || [],
    linkedinInsight:     ids.linkedinInsight || [],
    snapchatPixel:       ids.snapchatPixel || [],
    pinterestTag:        ids.pinterestTag || [],
    twitterPixel:        ids.twitterPixel || [],
    redditPixel:         ids.redditPixel || [],
    microsoftUet:        ids.microsoftUet || [],
    clarity:             ids.clarityId || [],
    hotjar:              ids.hotjar || [],
    mixpanel:            ids.mixpanel || [],
    segment:             ids.segment || [],
    amplitude:           ids.amplitude || [],
    intercom:            ids.intercom || [],
    hubspot:             ids.hubspotTracking || [],
    klaviyo:             ids.klaviyo || [],
    plausible:           presence.plausible,
    fathom:              presence.fathom,
  };
}

/**
 * Derive ad signals from tracking IDs + network requests.
 * "Are they running ads right now?" — critical intelligence.
 */
function deriveAdSignals(trackingIds, networkRequests = []) {
  const hasMetaPixel = trackingIds.facebookPixel?.length > 0;
  const hasTikTokPixel = trackingIds.tiktokPixel?.length > 0;
  const hasGoogleAds = trackingIds.googleAdsConversion?.length > 0
    || networkRequests?.length > 0 ? networkRequests.some(r => /googleads\.g\.doubleclick\.net|googlesyndication/.test(r.url)) : false;
  const hasLinkedInPixel = trackingIds.linkedinInsight?.length > 0;
  const hasSnapPixel = trackingIds.snapchatPixel?.length > 0;
  
  // Conversion API detection — they're running SERIOUS ads if CAPI is active
  const hasMetaCAPI = networkRequests?.length > 0 ? networkRequests.some(r => 
    r?.url && /graph\.facebook\.com\/v\d+\.\d+\/\d+\/events/.test(r.url)
  ) : false;
  
  // Advanced matching parameters in pixel calls = mature advertiser
  const hasAdvancedMatching = networkRequests?.length > 0 ? networkRequests.some(r => 
    r?.url && /facebook\.com\/tr\?.*\bem=/.test(r.url)
  ) : false;
  
  return {
    runningMetaAds:      hasMetaPixel,
    runningGoogleAds:    hasGoogleAds,
    runningTikTokAds:    hasTikTokPixel,
    runningLinkedInAds:  hasLinkedInPixel,
    runningSnapchatAds:  hasSnapPixel,
    conversionApiActive: hasMetaCAPI,
    advancedMatchingActive: hasAdvancedMatching,
    // Multi-channel advertiser = serious budget
    multiChannelAdvertiser: [hasMetaPixel, hasGoogleAds, hasTikTokPixel, hasLinkedInPixel, hasSnapPixel]
      .filter(Boolean).length >= 2,
  };
}

module.exports = { extractTrackingIds, normalizeTrackingIds, deriveAdSignals };