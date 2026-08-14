'use strict';

/**
 * extractSocialHandles — pulls Facebook, Instagram, TikTok, YouTube, Twitter/X,
 * LinkedIn, WhatsApp handles from raw HTML.
 *
 * Why this is a rewrite (and not a patch):
 *
 * The Malabar Dental scan returned ZERO handles even though the homepage HTML
 * contained `facebook.com/MalabarDentalClinics`, `instagram.com/malabardentalclinics`,
 * `youtube.com/@malabardentalclinic`, `+971521514300`, and `info@afghanpalace.ae`
 * (Afghan Palace had similar issues). Three failures combined to produce that
 * result:
 *
 *   1. The previous extractor only looked at <a href="..."> with text content.
 *      Modern sites render social icons as Font Awesome <i> tags inside <a>
 *      tags with NO text — Cheerio's text-content selectors miss them entirely.
 *
 *   2. Some themes (Blocksy is one) render social links via <a data-network="facebook">
 *      with the URL inside a <svg> sibling — not in the href at all.
 *
 *   3. WhatsApp configurations live in JS config blobs (Chaty, Tidio, Crisp,
 *      Tawk all do this), not in any anchor tag. The phone is in JSON,
 *      sometimes base64-encoded.
 *
 * This rewrite handles all three. It runs five extraction passes in order
 * of confidence, dedupes the results, and exposes per-source provenance so
 * downstream code can show "we found this handle on the homepage header" vs
 * "we inferred this from a JS config blob."
 */

const cheerio = require('cheerio');
const axios = require('axios');
const { chromium } = require('playwright');
// ---------- Pattern definitions ----------

// Each platform has:
//   - urlPattern: regex against href/url strings
//   - excludePaths: handles that aren't real (sharer, share, intent, etc.)
//   - handleValidator: optional further filter on extracted handle
const PLATFORM_PATTERNS = {
  facebook: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9._-]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set([
      'sharer', 'share', 'plugins', 'tr', 'dialog', 'home',
      'login', 'profile.php', 'pages', 'groups', 'events',
      'marketplace', 'watch', 'gaming', 'business',
    ]),
    handleValidator: (h) => h.length >= 2 && h.length <= 60,
  },
  instagram: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set([
      'p', 'reel', 'reels', 'tv', 'explore', 'accounts',
      'direct', 'stories', 'about',
    ]),
    handleValidator: (h) => h.length >= 1 && h.length <= 30,
  },
  tiktok: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.)?tiktok\.com\/@?([A-Za-z0-9._-]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set(['discover', 'tag', 'music', 'video']),
    handleValidator: (h) => h.length >= 2 && h.length <= 24,
    normalize: (h) => (h.startsWith('@') ? h.slice(1) : h),
  },
  youtube: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)?([A-Za-z0-9._-]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set([
      'watch', 'embed', 'shorts', 'playlist', 'feed',
      'gaming', 'results', 'live',
    ]),
    handleValidator: (h) => h.length >= 1 && h.length <= 100,
    // YouTube has @handles AND legacy /c/ /user/ /channel/ paths; preserve @ if present
    extractWithPrefix: true,
  },
  twitter: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set([
      'intent', 'share', 'home', 'search', 'i', 'compose',
      'hashtag', 'explore', 'notifications',
    ]),
    handleValidator: (h) => h.length >= 1 && h.length <= 15,
  },
  linkedin: {
    urlPattern:
      /(?:https?:)?\/\/(?:www\.)?linkedin\.com\/(?:company|in|school|organization)\/([A-Za-z0-9._-]+)(?:\/|\?|$|#)/i,
    excludePaths: new Set(['feed', 'jobs', 'learning', 'pulse', 'sales']),
    handleValidator: (h) => h.length >= 2 && h.length <= 100,
  },
  whatsapp: {
    // wa.me/971501234567, api.whatsapp.com/send?phone=971501234567,
    // chat.whatsapp.com/<groupcode>, wa.link/abc
    urlPattern:
      /(?:https?:)?\/\/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|chat\.whatsapp\.com\/|wa\.link\/)([A-Za-z0-9+-]+)/i,
    excludePaths: new Set(),
    handleValidator: (h) => /^\+?\d{7,16}$|^[A-Za-z0-9]{8,}$/.test(h),
  },
};

// Phone-as-WhatsApp fallback patterns. Many UAE businesses don't link to
// WhatsApp explicitly — they have a phone number that's also their WA.
// We extract any tel: with UAE/Saudi country codes as a candidate.
const PHONE_PATTERN = /tel:(\+?\d[\d\s()-]{6,18})/gi;
const WHATSAPP_CONFIG_PATTERNS = [
  // Chaty plugin: "value":"971521514300" inside chaty_settings
  /"channel"\s*:\s*"Whatsapp"[^}]*"value"\s*:\s*"(\+?\d{7,16})"/g,
  // Quoted-key JSON: "whatsapp": "971501234567"
  /"whatsapp"\s*:\s*"(\+?\d{7,16})"/gi,
  // Unquoted JS-object key: whatsapp: "971501234567" or whatsapp:"971501234567"
  /\bwhatsapp\s*:\s*["'](\+?\d{7,16})["']/gi,
  // wa.me link in JSON-encoded strings
  /wa\.me\\?\/(\+?\d{7,16})/g,
];

// Generic "data-network" attribute pattern (Blocksy, Astra, GeneratePress themes)
const DATA_NETWORK_PLATFORMS = [
  'facebook', 'instagram', 'tiktok', 'youtube', 'twitter', 'linkedin',
];

// ---------- Extraction passes ----------

/**
 * Pass 1: Match patterns against every <a href> attribute in the document.
 * This catches the common case: <a href="https://facebook.com/MyBrand">
 * AND the icon-only case: <a href="..."><i class="fa-facebook"></i></a>
 * because we don't care about the inner content, only the href.
 */
function extractFromAnchors($, candidates, opts = {}) {
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const $el = $(el);
    matchAgainstPlatforms(href, candidates, {
      source: opts.scopeBoost === 'footer' ? 'anchor_href_footer' : 'anchor_href',
      context: $el.attr('aria-label') || $el.attr('title') || '',
    });
  });
}



async function extractShopifyRuntimeData(page) {
  return await page.evaluate(() => {
    const result = {
      shopifySettings: null,
      themeSettings: null,
      st: null,
      socialLinks: [],
    };

    // 1. window.Shopify global
    if (typeof window.Shopify !== 'undefined') {
      try {
        result.shopifySettings = {
          shop: window.Shopify.shop,
          theme: window.Shopify.theme ? {
            id: window.Shopify.theme.id,
            name: window.Shopify.theme.name,
            settings: window.Shopify.theme.settings || null,
          } : null,
        };
      } catch (e) {}
    }

    // 2. window.__st
    if (typeof window.__st !== 'undefined') {
      try {
        result.st = JSON.parse(JSON.stringify(window.__st));
      } catch (e) {}
    }

    // 3. Look for theme settings in inline scripts
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const txt = s.textContent || '';
      // Shopify often inlines: var theme = {...} or window.theme = {...}
      const themeMatch = txt.match(/(?:window\.)?theme\s*=\s*(\{[\s\S]*?\});/);
      if (themeMatch) {
        try {
          const parsed = Function(`"use strict"; return (${themeMatch[1]})`)();
          if (parsed && typeof parsed === 'object') {
            result.themeSettings = parsed;
          }
        } catch (e) {}
      }
    }

    // 4. Harvest any href on the rendered page (post-hydration)
    const anchors = document.querySelectorAll('a[href]');
    const socialDomains = /facebook\.com|instagram\.com|tiktok\.com|youtube\.com|twitter\.com|x\.com|linkedin\.com|wa\.me|whatsapp\.com|pinterest\.com|snapchat\.com/i;
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (href && socialDomains.test(href)) {
        result.socialLinks.push({
          href,
          ariaLabel: a.getAttribute('aria-label') || '',
          containerClass: a.closest('[class]')?.className || '',
          text: a.textContent.trim().slice(0, 50),
        });
      }
    }

    return result;
  });
}

/**
 * Recursively walk a Shopify settings object and feed every social URL
 * we find into the candidate pool.
 */
function harvestShopifyRuntime(runtime, candidates) {
  if (!runtime) return;

  // 1. Direct social links from hydrated DOM
  for (const link of runtime.socialLinks || []) {
    matchAgainstPlatforms(link.href, candidates, {
      source: 'hydrated_dom',
      context: `${link.ariaLabel} | ${link.containerClass}`,
    });
  }

  // 2. Walk theme.settings recursively — Shopify themes nest settings deep
  const walk = (node, path = '') => {
    if (!node) return;
    if (typeof node === 'string') {
      // Any URL-shaped string gets matched against platform patterns
      if (/^https?:\/\//.test(node) || node.startsWith('//')) {
        matchAgainstPlatforms(node, candidates, {
          source: 'shopify_runtime',
          context: path,
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };

  walk(runtime.shopifySettings, 'Shopify');
  walk(runtime.themeSettings, 'theme');
  walk(runtime.st, '__st');
}

// ---------- NEW: Two-tier fetcher ----------

async function fetchHtmlFast(url) {
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return { html: res.data, networkText: '', source: 'axios' };
  } catch (err) {
    return null;
  }
}

async function fetchHtmlHydrated(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    const networkBodies = [];
    page.on('response', async (response) => {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('javascript') || ct.includes('text')) {
          const body = await response.text();
          if (body && body.length < 500_000) networkBodies.push(body);
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}

    // CRITICAL: scroll to footer FIRST, THEN wait for hydration
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 2000));
    }).catch(() => {});

    // Wait for ANY social link to appear in the DOM (max 8s)
    try {
      await page.waitForFunction(() => {
        const re = /facebook\.com|instagram\.com|tiktok\.com|youtube\.com|wa\.me/i;
        return Array.from(document.querySelectorAll('a[href]')).some(a => re.test(a.href || ''));
      }, { timeout: 8000 });
    } catch {
      // Site genuinely has no socials, or they're in a non-anchor element. Continue.
    }

    // Extra grace for chat widgets
    await page.waitForTimeout(2000);

    const runtime = await extractShopifyRuntimeData(page);
    const html = await page.content();

    return {
      html,
      networkText: networkBodies.join('\n'),
      runtime,
      source: 'playwright',
    };
  } finally {
    await browser.close();
  }
}

const THEME_VENDOR_BLOCKLIST = new Set([
  // Theme vendors
  'vamtam', 'envato', 'themeforest', 'elementor', 'elegantthemes', 
  'divi', 'astra', 'oceanwp', 'kadencewp', 'generatepress',
  'wpbakery', 'visualcomposer', 'avada', 'thrivethemes', 'flatsome',
  'blocksy', 'neve', 'hello-elementor', 'twentytwentyfour',
  
  // Page builders
  'beaverbuilder', 'breakdance', 'bricksbuilder', 'oxygen',
  
  // Plugin vendors with demo socials
  'yoast', 'jetpack', 'wpengine', 'wpforms', 'gravityforms',
  'rankmath', 'wordfence', 'elementorpro',
  
  // Stock content
  'shutterstock', 'unsplash', 'pexels', 'pixabay', 'freepik',
  
  // Common placeholders
  'yourcompany', 'yourbrand', 'example', 'demo', 'sample', 'test',
  'johndoe', 'janedoe', 'admin', 'user',
  
  // Generic
  'home', 'login', 'signup', 'about', 'contact',
]);



function scoreCandidate(candidate, brand) {
  let score = Number(candidate.score) || 0;
  const handle = String(candidate.handle || '').toLowerCase();

  if (!brand || !handle) return score;

  const brandTokens = Array.isArray(brand.tokens) ? brand.tokens.map(t => String(t).toLowerCase()) : [];
  const domainStem = String(brand.domainStem || '').toLowerCase();

  // String similarity
  if (brandTokens.some(t => t.length >= 4 && handle.includes(t))) score += 5;
  if (domainStem && handle.includes(domainStem)) score += 6;
  if (domainStem && domainStem.includes(handle) && handle.length >= 4) score += 4;

  // Levenshtein (now defined)
  if (brandTokens.length) {
    const minDist = Math.min(...brandTokens.map(t => levenshtein(handle, t)));
    if (minDist <= 2 && handle.length >= 4) score += 3;
  }

  // Theme/plugin blocklist
  if (THEME_VENDOR_BLOCKLIST.has(handle)) score -= 100;

  // Repetition
  if (candidate.timesSeen >= 3) score += 2;
  if (candidate.timesSeen === 1) score -= 1;

  // Country coherence for WhatsApp
  if (candidate.platform === 'whatsapp') {
    const handleCC = extractCountryCode(candidate.handle);
    if (handleCC && brand.country && handleCC === brand.country) score += 3;
    if (handleCC && brand.country && handleCC !== brand.country) score -= 2;
  }

  return score;
}

function levenshtein(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function extractCountryCode(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  // Common GCC country codes
  if (digits.startsWith('971')) return '971';
  if (digits.startsWith('966')) return '966';
  if (digits.startsWith('965')) return '965';
  if (digits.startsWith('974')) return '974';
  if (digits.startsWith('973')) return '973';
  if (digits.startsWith('968')) return '968';
  if (digits.startsWith('92'))  return '92';
  if (digits.startsWith('91'))  return '91';
  if (digits.startsWith('1'))   return '1';
  if (digits.startsWith('44'))  return '44';
  return digits.slice(0, 2);
}
// Accept only candidates above threshold
const ACCEPT_THRESHOLD = 3;

/**
 * Pass 2: data-network="facebook" attribute — Blocksy theme uses this.
 * The actual URL might be on the parent <a> or a sibling/child element.
 */
function extractFromDataNetwork($, candidates) {
  $('[data-network]').each((_, el) => {
    const $el = $(el);
    const network = ($el.attr('data-network') || '').toLowerCase().trim();
    if (!DATA_NETWORK_PLATFORMS.includes(network)) return;

    // Check the element itself, then parents, for an href
    let urlSource = $el.attr('href') || $el.attr('data-url') || '';
    if (!urlSource) {
      const $parentLink = $el.closest('a[href]');
      if ($parentLink.length) urlSource = $parentLink.attr('href') || '';
    }
    if (!urlSource) {
      const $childLink = $el.find('a[href]').first();
      if ($childLink.length) urlSource = $childLink.attr('href') || '';
    }

    if (urlSource) {
      matchAgainstPlatforms(urlSource, candidates, {
        source: 'data_network',
        context: network,
      });
    }
  });
}

/**
 * Pass 3: Extract handles from any text content matching social URL patterns.
 * Catches links rendered as plain text in JSON blobs, JS config, footer text,
 * meta tags (og:see_also), etc.
 */
function extractFromAllText(fullText, candidates) {
  // Take the entire HTML as a string and run global regex over it.
  // Slower than targeted extraction, but catches links in <script>, <meta>,
  // alt attributes, data-* attributes, etc.
  // const fullText = $?.root().html() || '';
  if (!fullText) return;

  for (const [platform, config] of Object.entries(PLATFORM_PATTERNS)) {
    // Use the urlPattern with a /g flag for multi-match
    const globalPattern = new RegExp(config.urlPattern.source, 'gi');
    let match;
    while ((match = globalPattern.exec(fullText)) !== null) {
      const handle = match[1];
      if (!handle) continue;

      addCandidate(platform, handle, candidates, {
        source: 'text_match',
        rawUrl: match[0],
      });

      // Safety: don't infinite-loop on zero-length matches
      if (match.index === globalPattern.lastIndex) globalPattern.lastIndex++;
    }
  }
}

/**
 * Pass 4: Pull WhatsApp from JS config blobs. Chaty, Tidio, Tawk, Crisp,
 * and many bespoke implementations store the WA number in a JSON config
 * inside a <script> tag. The number isn't reachable as a URL.
 */
function extractWhatsAppFromConfigs(html, candidates) {
  if (!html) return;

  for (const pattern of WHATSAPP_CONFIG_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = globalPattern.exec(html)) !== null) {
      const phone = (match[1] || '').replace(/[^\d+]/g, '');
      if (phone.length < 7 || phone.length > 16) continue;
      addCandidate('whatsapp', phone, candidates, {
        source: 'js_config',
      });
      if (match.index === globalPattern.lastIndex) globalPattern.lastIndex++;
    }
  }

  // Also extract tel: links as WA candidates if no explicit WA was found.
  // We only promote these later if no direct WA evidence exists.
  let telMatch;
  PHONE_PATTERN.lastIndex = 0;
  while ((telMatch = PHONE_PATTERN.exec(html)) !== null) {
    const phone = telMatch[1].replace(/[^\d+]/g, '');
    if (phone.length < 7 || phone.length > 16) continue;
    addCandidate('phone', phone, candidates, { source: 'tel_link' });
  }
}

// ---------- Candidate management ----------

function matchAgainstPlatforms(urlString, candidates, meta) {
  for (const [platform, config] of Object.entries(PLATFORM_PATTERNS)) {
    const m = urlString.match(config.urlPattern);
    if (!m) continue;

    const handle = m[1];
    if (!handle) continue;

    addCandidate(platform, handle, candidates, {
      ...meta,
      rawUrl: urlString,
    });
  }
}

function extractRelMe($, candidates){

   $('a[rel*=me]').each((_,el)=>{

      const href=$(el).attr('href');

      matchAgainstPlatforms(
         href,
         candidates,
         {
            source:"rel_me"
         }
      );

   });


}
function extractIframes($,candidates){

  $('iframe[src]').each((_,el)=>{

     const src=$(el).attr('src');

     matchAgainstPlatforms(
        src,
        candidates,
        {
           source:"iframe"
        }
     );

  });


}
function runAllStaticPasses(html) {
  const candidates = {};
  const $ = cheerio.load(html, { decodeEntities: false });

  extractFromJsonLd($, candidates);
  extractRelMe($, candidates);
  extractShopifyConfig(html, candidates);
  extractIframes($, candidates);
  extractScriptContent($, candidates);
  extractFromAnchors($, candidates);
  extractFromDataNetwork($, candidates);
  extractFromAllText(html, candidates);          // NO slice — scan the full doc
  extractWhatsAppFromConfigs(html, candidates);

  return candidates;
}

function hasStrongSignal(candidates) {
  // "Strong" = at least 2 platforms with a candidate scoring ≥8 from a high-trust source
  const strongPlatforms = Object.entries(candidates).filter(([_, list]) =>
    list.some((c) => c.score >= 8)
  );
  return strongPlatforms.length >= 2;
}

function looksLikeJsApp(html) {
  if (!html) return true;
  // Heuristics: very short HTML, or only a root div with no content
  if (html.length < 5000) return true;
  if (/<div id=["']?(root|app|__next|__nuxt)["']?>\s*<\/div>/i.test(html)) return true;
  // Shopify theme bundle loaded but no rendered social section
  if (/cdn\.shopify\.com.*\.js/.test(html) && !/facebook\.com|instagram\.com/i.test(html)) {
    return true;
  }
  return false;
}

// Update sourceWeights to include new sources
// (in addCandidate, extend the sourceWeights map)
const NEW_SOURCE_WEIGHTS = {
  json_ld: 15,
  rel_me: 14,
  shopify_runtime: 13,    // NEW — Shopify.theme.settings is authoritative
  hydrated_dom: 12,        // NEW — rendered <a> after JS execution
  shopify_config: 12,
  data_network: 10,
  anchor_href: 8,
  og_meta: 7,
  js_config: 6,
  text_match: 3,
  tel_link: 1,
};

function addCandidate(platform, rawHandle, candidates, meta) {
  const config = PLATFORM_PATTERNS[platform];
  if (!config && platform !== 'phone') return;

  let handle = rawHandle;
  if (config?.normalize) handle = config.normalize(handle);

  // Strip path-noise tokens
  if (config?.excludePaths?.has(handle.toLowerCase())) return;

  // Validate
  if (config?.handleValidator && !config.handleValidator(handle)) return;

  candidates[platform] = candidates[platform] || [];

  // Score: data_network > anchor_href > text_match > js_config > tel_link
  const sourceWeights = {
    json_ld:15,

    rel_me:14,
 
    shopify_config:12,
 
    data_network:10,
 
    anchor_href:8,
 
    og_meta:7,
 
    js_config:6,
 
    text_match:3,
 
    tel_link:1
  };
  const score = sourceWeights[meta.source] ?? 0;

  // De-dupe within the platform: same handle, keep highest-score source
  const existing = candidates[platform].find((c) => c.handle === handle);
  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.source = meta.source;
      existing.rawUrl = meta.rawUrl || existing.rawUrl;
    }
    existing.timesSeen = (existing.timesSeen || 1) + 1;
    return;
  }

  candidates[platform].push({
    handle,
    source: meta.source,
    score,
    rawUrl: meta.rawUrl || null,
    context: meta.context || null,
    timesSeen: 1,
  });
}

// ---------- Final selection ----------

function pickBestCandidate(platformCandidates) {
  if (!platformCandidates || platformCandidates.length === 0) return null;

  // Sort by: score desc, then timesSeen desc, then handle length asc
  // (shorter handles are usually canonical, e.g. "ecityuae" not "ecityuae123")
  const sorted = [...platformCandidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.timesSeen !== a.timesSeen) return b.timesSeen - a.timesSeen;
    return a.handle.length - b.handle.length;
  });

  return sorted[0];
}

function buildHandlesObject(candidates) {
  const handles = {};

  for (const platform of Object.keys(PLATFORM_PATTERNS)) {
    const best = pickBestCandidate(candidates[platform]);
    if (!best) {
      handles[`${platform}Handle`] = null;
      handles[`${platform}Url`] = null;
      handles[`${platform}Source`] = null;
      continue;
    }
    handles[`${platform}Handle`] = best.handle;
    handles[`${platform}Url`] = canonicalUrl(platform, best.handle, best.rawUrl);
    handles[`${platform}Source`] = best.source;
  }

  // Rename for clarity in the schema
  if (handles.facebookHandle) {
    handles.facebookPageUrl = handles.facebookUrl;
  }
  if (handles.linkedinHandle) {
    handles.linkedinCompany = handles.linkedinHandle;
  }
  if (handles.whatsappHandle) {
    handles.whatsappNumber = handles.whatsappHandle;
  } else {
    // Promote a tel:-derived phone to WhatsApp candidate ONLY if no real WA found.
    const phoneCandidate = pickBestCandidate(candidates.phone);
    if (phoneCandidate) {
      handles.whatsappNumber = phoneCandidate.handle;
      handles.whatsappUrl = `https://wa.me/${phoneCandidate.handle.replace(/[^\d]/g, '')}`;
      handles.whatsappSource = 'tel_link_promoted';
    }
  }

  // Phone is its own field, even when we don't promote to WA
  const phoneCandidate = pickBestCandidate(candidates.phone);
  if (phoneCandidate) {
    handles.phoneNumber = phoneCandidate.handle;
  }

  return handles;
}

function canonicalUrl(platform, handle, rawUrl) {
  // If the raw URL we found is well-formed, keep it
  if (rawUrl && /^https?:\/\//.test(rawUrl)) {
    // Repair common mistakes: doubled domain (the Malabar HTML had this)
    // e.g. "https://www.facebook.com/MalabarDentalClinics/https://www.facebook.com/..."
    const doubled = rawUrl.match(/^(https?:\/\/[^/]+\/[^/]+)\/(https?:\/\/.*)$/i);
    if (doubled) return doubled[1];
    return rawUrl.replace(/\?.*$/, '').replace(/\/+$/, '');
  }

  // Otherwise build canonical URL from handle
  switch (platform) {
    case 'facebook':
      return `https://www.facebook.com/${handle}`;
    case 'instagram':
      return `https://www.instagram.com/${handle}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`;
    case 'youtube':
      return handle.startsWith('@')
        ? `https://www.youtube.com/${handle}`
        : `https://www.youtube.com/@${handle}`;
    case 'twitter':
      return `https://twitter.com/${handle}`;
    case 'linkedin':
      return `https://www.linkedin.com/company/${handle}`;
    case 'whatsapp':
      const digits = handle.replace(/[^\d]/g, '');
      return `https://wa.me/${digits}`;
    default:
      return null;
  }
}



// services/scraper/scopedExtractor.js

function scopeToHeaderFooter($) {
  // Real-world sites have inconsistent header/footer markup. Build a layered scope.
  const scopes = {
    header: [],
    footer: [],
    body: [], // fallback only
  };

  // Header: explicit semantic tags + common class patterns
  const headerSelectors = [
    'header',
    '.site-header', '#site-header',
    '.main-header', '#main-header',
    '.page-header', '#page-header',
    '.top-bar', '.topbar',
    'nav[aria-label*="primary"]',
    '[role="banner"]',
  ];

  // Footer: same approach
  const footerSelectors = [
    'footer',
    '.site-footer', '#site-footer',
    '.main-footer', '#main-footer',
    '.page-footer', '#page-footer',
    '.bottom-bar', '.bottombar',
    '[role="contentinfo"]',
  ];

  headerSelectors.forEach(sel => {
    $(sel).each((_, el) => scopes.header.push(el));
  });
  footerSelectors.forEach(sel => {
    $(sel).each((_, el) => scopes.footer.push(el));
  });

  // If no semantic header/footer found, fall back to first/last 20% of body
  if (scopes.header.length === 0) {
    const allElements = $('body > *').toArray();
    const headerCount = Math.max(3, Math.floor(allElements.length * 0.2));
    scopes.header = allElements.slice(0, headerCount);
  }
  if (scopes.footer.length === 0) {
    const allElements = $('body > *').toArray();
    const footerCount = Math.max(3, Math.floor(allElements.length * 0.2));
    scopes.footer = allElements.slice(-footerCount);
  }

  return scopes;
}

// Extract HTML strings for each scope (much smaller than full doc)
function extractScopeHtml($, scopes) {
  const headerHtml = scopes.header.map(el => $.html(el)).join('\n');
  const footerHtml = scopes.footer.map(el => $.html(el)).join('\n');
  return { headerHtml, footerHtml };
}
function extractShopifyConfig(html, candidates) {
  const patterns = [
    // Old theme keys
    /"social_facebook_link"\s*:\s*"([^"]+)"/gi,
    /"social_instagram_link"\s*:\s*"([^"]+)"/gi,
    /"social_youtube_link"\s*:\s*"([^"]+)"/gi,
    /"social_tiktok_link"\s*:\s*"([^"]+)"/gi,
    /"social_twitter_link"\s*:\s*"([^"]+)"/gi,
    /"social_linkedin_link"\s*:\s*"([^"]+)"/gi,
    
    // Modern theme keys (Dawn, Sense, Refresh, Studio)
    /"facebook"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"instagram"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"twitter"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"youtube"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"tiktok"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"linkedin"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"snapchat"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /"pinterest"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    
    // Section/block settings nested
    /"social_[a-z]+_link"\s*:\s*"(https?:\/\/[^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(html))) {
      if (match[1]) {
        matchAgainstPlatforms(match[1], candidates, { source: 'shopify_config' });
      }
    }
  }
}
// ---------- Main entrypoint ----------

/**
 * Extract social handles from one or more HTML strings (concatenated rawHtml
 * from multiPageCrawler is fine).
 *
 * @param {object} opts
 * @param {string} opts.html - merged HTML to scan
 * @param {string} [opts.url] - the brand's URL (for canonicalization context)
 * @returns {{
 *   handles: object,
 *   candidates: object,    // raw candidates per platform (debugging)
 *   sources: object,       // which extraction passes contributed
 * }}
 */


function extractFromJsonLd($, candidates) {
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).html() || '';
    if (!raw.trim()) return;
    
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    
    // sameAs can be at root, in @graph[], or nested in Organization
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      
      if (Array.isArray(node.sameAs)) {
        node.sameAs.forEach(url => {
          if (typeof url === 'string') {
            matchAgainstPlatforms(url, candidates, { source: 'json_ld' });
          }
        });
      }
      
      Object.values(node).forEach(walk);
    };
    
    walk(parsed);
  });
}

const sourceWeights = {
  json_ld: 5,        // ← new top tier
  data_network: 4,
  anchor_href: 3,
  text_match: 2,
  js_config: 1,
  tel_link: 0,
};

function extractScriptContent($, candidates){

  $('script').each((_,el)=>{

     const content=$(el).html();

     if(!content) return;

     extractFromAllText(
        content,
        candidates
     );
  });

}
//  async function extractSocialHandles({ html, url,brand,forceHydrated=false } = {}) {
//   if (!html || typeof html !== 'string') {
//     return { handles: emptyHandles(), candidates: {}, sources: {} };
//   }

//   let runtime = null;
//   let fetchSource = 'provided';
//   let networkText = null;
//   if (!html && url) {
//     if (!forceHydrated) {
//       const fast = await fetchHtmlFast(url);
//       if (fast) {
//         html = fast.html;
//         fetchSource = 'axios';
//       }
//     }
//   }
//   const $ = cheerio.load(html, { decodeEntities: false });
//   const scopes = scopeToHeaderFooter($);
//   const { headerHtml, footerHtml } = extractScopeHtml($, scopes);
//   const $header = cheerio.load(headerHtml);
//   const $footer = cheerio.load(footerHtml);
  
//   const candidates = {};


//   extractFromJsonLd($, candidates);
//   extractRelMe($, candidates);
//   extractShopifyConfig(html, candidates);
//   extractIframes($, candidates);
//   extractScriptContent($, candidates);

//   extractFromAnchors($footer, candidates, { scopeBoost: 'footer' });
//   extractFromDataNetwork($footer, candidates, { scopeBoost: 'footer' });
//   extractFromAllText(html.slice(0,200000), candidates);
//   extractWhatsAppFromConfigs(html, candidates);
// // Step 3: apply brand-similarity scoring if brand context provided

//  // Step 2: decide if we need Playwright
//  const needsHydration =
//  forceHydrated ||
//  !html ||
//  !hasStrongSignal(candidates) ||
//  looksLikeJsApp(html);

// if (needsHydration && url) {
//  try {
//    const hydrated = await fetchHtmlHydrated(url);
//    html = hydrated.html;
//    networkText = hydrated.networkText;
//    runtime = hydrated.runtime;
//    fetchSource = 'playwright';

//    // Re-run static passes on hydrated HTML
//    candidates = runAllStaticPasses(html);

//    // Pull from Shopify/theme runtime globals
//    harvestShopifyRuntime(runtime, candidates);

//    // Scan captured network bodies for social URLs and WA configs
//    if (networkText) {
//      extractFromAllText(networkText, candidates);
//      extractWhatsAppFromConfigs(networkText, candidates);
//    }
//  } catch (err) {
//    // Playwright failed — fall back to whatever axios gave us
//  }
// }

// if (brand) {
//   for (const platform of Object.keys(candidates)) {
//     for (const c of candidates[platform]) {
//       c.score = scoreCandidate({ ...c, platform }, brand);
//     }
//     // Drop candidates below threshold
//     candidates[platform] = candidates[platform].filter((c) => c.score >= ACCEPT_THRESHOLD);
//   }
// }

// const handles = buildHandlesObject(candidates);

// const sources = {};
// for (const platform of Object.keys(PLATFORM_PATTERNS)) {
//   sources[platform] = candidates[platform]?.length || 0;
// }

// return { handles, candidates, sources, fetchSource };

// }

// async function extractSocialHandles({ html, url, brand, forceHydrated = false } = {}) {
//   let candidates = {};   // ← let, NOT const
//   let fetchSource = 'provided';
//   let networkText = '';
//   let runtime = null;

//   // Step 1: If no HTML provided, fetch via axios first (unless forceHydrated)
//   if (!html && url && !forceHydrated) {
//     const fast = await fetchHtmlFast(url);
//     if (fast) {
//       html = fast.html;
//       fetchSource = 'axios';
//     }
//   }

//   // Step 2: Run static passes on whatever HTML we have
//   if (html) {
//     try {
//       candidates = runAllStaticPasses(html);
//     } catch (err) {
//       console.warn('[extractSocialHandles] static pass error:', err.message);
//       candidates = {};
//     }
//   }

//   // Step 3: Decide if we need Playwright
//   const needsHydration =
//     forceHydrated ||
//     !html ||
//     !hasStrongSignal(candidates) ||
//     looksLikeJsApp(html);

//   if (needsHydration && url) {
//     try {
//       const hydrated = await fetchHtmlHydrated(url);
//       html = hydrated.html;
//       networkText = hydrated.networkText || '';
//       runtime = hydrated.runtime;
//       fetchSource = 'playwright';

//       // MERGE with existing candidates (don't overwrite)
//       const hydratedCandidates = runAllStaticPasses(html);
//       candidates = mergeCandidates(candidates, hydratedCandidates);

//       // Pull from Shopify/theme runtime globals
//       try {
//         harvestShopifyRuntime(runtime, candidates);
//       } catch (e) {
//         console.warn('[extractSocialHandles] harvestShopifyRuntime error:', e.message);
//       }

//       // Scan captured network bodies
//       if (networkText) {
//         try {
//           extractFromAllText(networkText, candidates);
//           extractWhatsAppFromConfigs(networkText, candidates);
//         } catch (e) {
//           console.warn('[extractSocialHandles] network text scan error:', e.message);
//         }
//       }
//     } catch (err) {
//       console.warn('[extractSocialHandles] Playwright failed:', err.message);
//       // Continue with whatever axios gave us
//     }
//   }

//   // Step 4: Brand-similarity scoring (now safe — levenshtein is defined)
//   if (brand) {
//     for (const platform of Object.keys(candidates)) {
//       for (const c of candidates[platform]) {
//         try {
//           c.score = scoreCandidate({ ...c, platform }, brand);
//         } catch (e) {
//           // Don't drop candidates if scoring throws — keep original score
//           console.warn('[extractSocialHandles] scoreCandidate error:', e.message);
//         }
//       }
//       // Filter below threshold — but ONLY if brand context was given
//       // Otherwise keep everything
//       candidates[platform] = candidates[platform].filter((c) => c.score >= ACCEPT_THRESHOLD);
//     }
//   }

//   const handles = buildHandlesObject(candidates);
//   const sources = {};
//   for (const platform of Object.keys(PLATFORM_PATTERNS)) {
//     sources[platform] = candidates[platform]?.length || 0;
//   }

//   return { handles, candidates, sources, fetchSource };
// }

async function extractSocialHandles({ 
  html, 
  url, 
  brand, 
  runtime,        // ← NEW: pre-extracted Shopify data from urlScraper
  networkText,    // ← NEW: captured XHR bodies
  forceHydrated = false 
} = {}) {
  let candidates = {};
  let fetchSource = 'provided';
  
  // If runtime + html were passed from the scraper, skip Playwright entirely
  if (html) {
    try {
      candidates = runAllStaticPasses(html);
    } catch (err) {
      console.warn('[extractSocialHandles] static pass error:', err.message);
    }
  }
  
  // Harvest pre-extracted runtime (no browser launch needed)
  if (runtime) {
    try {
      harvestShopifyRuntime(runtime, candidates);
    } catch (e) {
      console.warn('[extractSocialHandles] harvest error:', e.message);
    }
  }
  
  // Scan captured network bodies
  if (networkText) {
    try {
      extractFromAllText(networkText, candidates);
      extractWhatsAppFromConfigs(networkText, candidates);
    } catch (e) {
      console.warn('[extractSocialHandles] network text error:', e.message);
    }
  }
  
  // ONLY launch Playwright if nobody hydrated for us AND we got nothing useful
  const needsHydration =
    forceHydrated ||
    !html ||
    (!runtime && !hasStrongSignal(candidates) && url);
  
  if (needsHydration && url) {
    try {
      const hydrated = await fetchHtmlHydrated(url);
      const hydratedCandidates = runAllStaticPasses(hydrated.html);
      candidates = mergeCandidates(candidates, hydratedCandidates);
      harvestShopifyRuntime(hydrated.runtime, candidates);
      if (hydrated.networkText) {
        extractFromAllText(hydrated.networkText, candidates);
        extractWhatsAppFromConfigs(hydrated.networkText, candidates);
      }
      fetchSource = 'playwright';
    } catch (err) {
      console.warn('[extractSocialHandles] hydration failed:', err.message);
    }
  } else if (runtime) {
    fetchSource = 'hydrated_by_caller';
  }
  
  if (brand) {
    for (const platform of Object.keys(candidates)) {
      for (const c of candidates[platform]) {
        try {
          c.score = scoreCandidate({ ...c, platform }, brand);
        } catch {}
      }
      candidates[platform] = candidates[platform].filter((c) => c.score >= ACCEPT_THRESHOLD);
    }
  }
  
  const handles = buildHandlesObject(candidates);
  const sources = {};
  for (const platform of Object.keys(PLATFORM_PATTERNS)) {
    sources[platform] = candidates[platform]?.length || 0;
  }
  
  return { handles, candidates, sources, fetchSource };
}
function mergeCandidates(a, b) {
  const out = { ...a };
  for (const [platform, list] of Object.entries(b || {})) {
    if (!out[platform]) {
      out[platform] = [...list];
      continue;
    }
    for (const newCand of list) {
      const existing = out[platform].find((c) => c.handle === newCand.handle);
      if (existing) {
        existing.timesSeen = (existing.timesSeen || 1) + (newCand.timesSeen || 1);
        if (newCand.score > existing.score) {
          existing.score = newCand.score;
          existing.source = newCand.source;
          existing.rawUrl = newCand.rawUrl || existing.rawUrl;
        }
      } else {
        out[platform].push(newCand);
      }
    }
  }
  return out;
}
module.exports = {
  extractSocialHandles,
  // Exposed for testing
  _internal: {
    PLATFORM_PATTERNS,
    extractFromAnchors,
    extractFromDataNetwork,
    extractFromAllText,
    extractWhatsAppFromConfigs,
    canonicalUrl,
    pickBestCandidate,
  },
};
