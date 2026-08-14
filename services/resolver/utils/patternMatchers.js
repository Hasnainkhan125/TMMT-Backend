// services/resolver/utils/patternMatchers.js
// THE GOLDMINE. Every pattern here unlocks competitive intel.

const PATTERNS = {
    // ═══════════════════════════════════════════════════════════
    // GOOGLE
    // ═══════════════════════════════════════════════════════════
    
    // GA4 Measurement ID — "G-" followed by 10 alphanumeric
    googleAnalytics4: {
      regex: /\bG-[A-Z0-9]{10}\b/g,
      validate: id => /^G-[A-Z0-9]{10}$/.test(id),
      context: ['gtag', 'google-analytics', 'googletagmanager'],
    },
    
    // Universal Analytics (legacy but still present)
    googleAnalyticsUA: {
      regex: /\bUA-\d{4,10}-\d{1,4}\b/g,
      validate: id => /^UA-\d+-\d+$/.test(id),
    },
    
    // Google Tag Manager container
    googleTagManager: {
      regex: /\bGTM-[A-Z0-9]{5,8}\b/g,
      validate: id => /^GTM-[A-Z0-9]+$/.test(id),
    },
    
    // Google Ads conversion
    googleAdsConversion: {
      regex: /\bAW-\d{9,11}\b/g,
      validate: id => /^AW-\d+$/.test(id),
    },
    
    // DoubleClick / Floodlight
    doubleclickAdvertiser: {
      regex: /DC-\d+/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // META (FACEBOOK/INSTAGRAM)
    // ═══════════════════════════════════════════════════════════
    
    // Meta Pixel — fbq('init', 'XXXXXXXXXXXXXXX')
    // 15-16 digit numeric ID
    facebookPixel: {
      // Match inside fbq('init', ...) or connect.facebook.net/.../fbevents.js?id=
      regexes: [
        /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{13,17})['"]/g,
        /pixel[_-]?id['"]?\s*[:=]\s*['"](\d{13,17})['"]/gi,
        /connect\.facebook\.net\/[^\/]+\/fbevents\.js\?[^"']*\bid=(\d{13,17})/g,
      ],
    },
    
    // Facebook App ID (from SDK loads)
    facebookAppId: {
      regexes: [
        /FB\.init\s*\(\s*{\s*appId\s*:\s*['"](\d{10,20})['"]/g,
        /<meta\s+property=["']fb:app_id["']\s+content=["'](\d+)["']/gi,
      ],
    },
    
    // Facebook Page ID (from meta tags or iframes)
    facebookPageId: {
      regexes: [
        /<meta\s+property=["']fb:page_id["']\s+content=["'](\d{6,20})["']/gi,
        /<meta\s+property=["']fb:pages["']\s+content=["'](\d[\d,]*)["']/gi,
        /facebook\.com\/plugins\/page\.php\?[^"']*\bhref=[^"']*facebook\.com%2F([^%&"']+)/gi,
      ],
    },
    
    // ═══════════════════════════════════════════════════════════
    // TIKTOK
    // ═══════════════════════════════════════════════════════════
    
    // TikTok Pixel — ttq.load('XXXXXXXX')
    // 20-char alphanumeric usually prefixed with C
    tiktokPixel: {
      regexes: [
        /ttq\.load\s*\(\s*['"]([A-Z0-9]{15,25})['"]/g,
        /analytics\.tiktok\.com\/i18n\/pixel\/[^"']+?\?sdkid=([A-Z0-9]{15,25})/g,
      ],
    },
    
    // ═══════════════════════════════════════════════════════════
    // LINKEDIN
    // ═══════════════════════════════════════════════════════════
    
    // LinkedIn Insight Tag — _linkedin_partner_id
    linkedinInsight: {
      regexes: [
        /_linkedin_partner_id\s*=\s*['"](\d{4,10})['"]/g,
        /_linkedin_data_partner_ids\.push\s*\(\s*['"]?(\d{4,10})['"]?\s*\)/g,
      ],
    },
    
    // ═══════════════════════════════════════════════════════════
    // SNAPCHAT
    // ═══════════════════════════════════════════════════════════
    
    // Snap Pixel — snaptr('init', 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX')
    snapchatPixel: {
      regex: /snaptr\s*\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]{36})['"]/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // PINTEREST
    // ═══════════════════════════════════════════════════════════
    
    pinterestTag: {
      regex: /pintrk\s*\(\s*['"]load['"]\s*,\s*['"](\d{10,20})['"]/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // TWITTER/X
    // ═══════════════════════════════════════════════════════════
    
    twitterPixel: {
      regex: /twq\s*\(\s*['"]config['"]\s*,\s*['"]([a-z0-9]{5,10})['"]/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // MICROSOFT
    // ═══════════════════════════════════════════════════════════
    
    // Microsoft UET (Bing Ads)
    microsoftUet: {
      regex: /UET[^"']*?['"]ti['"]\s*:\s*['"](\d{4,10})['"]/g,
    },
    
    // Microsoft Clarity
    clarityId: {
      regex: /clarity\.ms\/tag\/([a-z0-9]+)/gi,
    },
    
    // ═══════════════════════════════════════════════════════════
    // REDDIT
    // ═══════════════════════════════════════════════════════════
    
    redditPixel: {
      regex: /rdt\s*\(\s*['"]init['"]\s*,\s*['"]([a-z0-9_]+)['"]/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // ANALYTICS TOOLS (non-ad)
    // ═══════════════════════════════════════════════════════════
    
    hotjar: {
      regexes: [
        /hjid\s*[:=]\s*['"]?(\d{4,10})['"]?/g,
        /static\.hotjar\.com\/c\/hotjar-(\d+)\.js/g,
      ],
    },
    
    mixpanel: {
      regex: /mixpanel\.init\s*\(\s*['"]([a-f0-9]{32})['"]/g,
    },
    
    segment: {
      regex: /analytics\.load\s*\(\s*['"]([a-zA-Z0-9]{16,40})['"]/g,
    },
    
    amplitude: {
      regex: /amplitude\.(?:init|getInstance\(\)\.init)\s*\(\s*['"]([a-f0-9]{32})['"]/g,
    },
    
    // ═══════════════════════════════════════════════════════════
    // MARKETING / CRM
    // ═══════════════════════════════════════════════════════════
    
    intercom: {
      regex: /Intercom\s*\(\s*['"]boot['"]\s*,\s*{\s*app_id\s*:\s*['"]([a-z0-9]{8})['"]/gi,
    },
    
    hubspotTracking: {
      regex: /js\.hs-scripts\.com\/(\d{4,10})\.js/g,
    },
    
    klaviyo: {
      regex: /static\.klaviyo\.com\/onsite\/js\/klaviyo\.js\?[^"']*company_id=([A-Z0-9]{6,10})/gi,
    },
    
    // Drift
    drift: {
      regex: /drift\.load\s*\(\s*['"]([a-z0-9]+)['"]/gi,
    },
    
    // Zendesk
    zendesk: {
      regex: /static\.zdassets\.com\/ekr\/snippet\.js\?key=([a-f0-9-]{36})/gi,
    },
  };
  
  // ═══════════════════════════════════════════════════════════════
  // Platform/CMS detection — what's the site built on?
  // ═══════════════════════════════════════════════════════════════
  
  const PLATFORM_SIGNATURES = {
    shopify: {
      indicators: [
        /cdn\.shopify\.com/i,
        /Shopify\.theme/,
        /<meta\s+name=["']generator["']\s+content=["']Shopify/i,
        /\/cdn\.shopifycdn\.net\//i,
      ],
    },
    woocommerce: {
      indicators: [
        /wp-content\/plugins\/woocommerce/i,
        /<meta\s+name=["']generator["']\s+content=["']WooCommerce/i,
      ],
    },
    wordpress: {
      indicators: [
        /wp-content\//i,
        /<meta\s+name=["']generator["']\s+content=["']WordPress/i,
        /wp-json\/wp\/v2/,
      ],
    },
    wix: {
      indicators: [
        /static\.wixstatic\.com/,
        /X-Wix-/,
        /<meta\s+name=["']generator["']\s+content=["']Wix/i,
      ],
    },
    squarespace: {
      indicators: [
        /static1\.squarespace\.com/,
        /<!--[^>]*This is Squarespace/i,
      ],
    },
    webflow: {
      indicators: [
        /assets-global\.website-files\.com/,
        /<html[^>]*data-wf-site=/i,
        /<meta\s+name=["']generator["']\s+content=["']Webflow/i,
      ],
    },
    magento: {
      indicators: [
        /\/mage\//,
        /Mage\.Cookies/,
        /<meta\s+name=["']generator["']\s+content=["']Magento/i,
      ],
    },
    bigcommerce: {
      indicators: [
        /cdn\d*\.bigcommerce\.com/,
        /<meta\s+name=["']generator["']\s+content=["']BigCommerce/i,
      ],
    },
    framer: {
      indicators: [
        /framerstatic\.com/,
        /<meta\s+name=["']generator["']\s+content=["']Framer/i,
      ],
    },
    ghost: {
      indicators: [
        /<meta\s+name=["']generator["']\s+content=["']Ghost/i,
      ],
    },
  };
  
  // ═══════════════════════════════════════════════════════════════
  // Framework detection (React/Vue/Next/etc.)
  // ═══════════════════════════════════════════════════════════════
  
  const FRAMEWORK_SIGNATURES = {
    nextjs:   [/__NEXT_DATA__/, /_next\/static/, /_next\/image/],
    nuxt:     [/__NUXT__/, /_nuxt\//],
    react:    [/react(?:-dom)?\.production\.min\.js/, /data-reactroot/, /data-reactid/],
    vue:      [/Vue\.config/, /v-app/, /data-v-/],
    angular:  [/ng-version=/, /angular\.js/],
    svelte:   [/svelte-/],
    remix:    [/__remix/],
    gatsby:   [/gatsby-/, /___gatsby/],
  };
  
  // ═══════════════════════════════════════════════════════════════
  // Hosting / CDN detection (from response headers in Playwright)
  // ═══════════════════════════════════════════════════════════════
  
  const HOSTING_HEADERS = {
    cloudflare: /cloudflare/i,
    vercel:     /vercel|now\.sh/i,
    netlify:    /netlify/i,
    fastly:     /fastly/i,
    aws:        /cloudfront|amazonaws/i,
    google:     /google|gws/i,
  };
  
  /**
   * Runs all patterns against a text blob and returns findings.
   * Deduplicates, validates, and normalizes each match.
   */
  function extractAllTrackingIds(text) {
    const results = {};
    
    for (const [key, def] of Object.entries(PATTERNS)) {
      const matches = new Set();
      const regexes = def.regexes || [def.regex];
      
      for (const re of regexes) {
        // Reset stateful regex
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const value = m[1] || m[0];
          if (def.validate && !def.validate(value)) continue;
          matches.add(value);
        }
      }
      
      if (matches.size > 0) {
        results[key] = Array.from(matches);
      }
    }
    
    return results;
  }
  
  function detectPlatform(text) {
    for (const [name, { indicators }] of Object.entries(PLATFORM_SIGNATURES)) {
      if (indicators.some(re => re.test(text))) {
        return name;
      }
    }
    return null;
  }
  
  function detectFramework(text) {
    const detected = [];
    for (const [name, indicators] of Object.entries(FRAMEWORK_SIGNATURES)) {
      if (indicators.some(re => re.test(text))) {
        detected.push(name);
      }
    }
    return detected;
  }
  
  function detectHosting(responseHeaders) {
    if (!responseHeaders) return null;
    const server = (responseHeaders['server'] || '').toLowerCase();
    const via = (responseHeaders['via'] || '').toLowerCase();
    const xPowered = (responseHeaders['x-powered-by'] || '').toLowerCase();
    const cfRay = responseHeaders['cf-ray'];
    const xVercel = responseHeaders['x-vercel-id'];
    const xNf = responseHeaders['x-nf-request-id'];
    
    if (cfRay) return 'cloudflare';
    if (xVercel) return 'vercel';
    if (xNf) return 'netlify';
    
    for (const [name, re] of Object.entries(HOSTING_HEADERS)) {
      if (re.test(server) || re.test(via) || re.test(xPowered)) {
        return name;
      }
    }
    return null;
  }
  
  module.exports = { 
    PATTERNS, 
    extractAllTrackingIds, 
    detectPlatform, 
    detectFramework,
    detectHosting,
  };