
const crypto = require('crypto');
const { guardUrl } = require('./security/ssrfGuard');
const { fetchBrandPalette } = require('./scraper/brandPalette');
const { extractBrandPalette: extractCssPalette } = require('./scraper/extractBrandPalette');
const { extractSocialHandles } = require('./scraper/extractSocialHandles');
const { fetchProductCatalog } = require('./scraper/productCatalog');
const { fetchCompetitorAds } = require('./scraper/metaAdLibrary');
const { getRedis } = require('./redis');
const UrlScrapeCache = require('../model/schema/urlScrapeCache'); // see A.5
const {chromium} = require('playwright')
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_BYTES = 1.2 * 1024 * 1024; // 1.2MB — tight enough to block 50MB OOM attacks
const HOT_CACHE_TTL_SEC = 300;        // 5 min (allows rapid re-scans without cost)
const WARM_CACHE_TTL_DAYS = 7;        // 7 days (brand content changes rarely)

// UA rotation pool — real browser strings from recent Chrome/Safari/Firefox
// NO "QumakStudioBot" signature — that gets classified as bot by Cloudflare.
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];




let _browser = null;
let _browserPromise = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserPromise) return _browserPromise;
  
  _browserPromise = chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  }).then((b) => {
    _browser = b;
    b.on('disconnected', () => { _browser = null; });
    return b;
  }).finally(() => { _browserPromise = null; });
  
  return _browserPromise;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ─── Hydrated fetch — does what the bare fetch() never could ────────

async function fetchHydrated(url, opts = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: pickUA(),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Asia/Dubai',
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
    },
    // Bypass cookie/consent walls on first paint
    bypassCSP: true,
  });
  
  // Block heavy resources we don't need — speeds hydration ~3x
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });
  
  const page = await context.newPage();
  
  // Capture XHR/fetch responses — Shopify socials sometimes arrive via /api/...
  const networkBodies = [];
  const networkUrls = [];
  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || '';
      const u = response.url();
      // Skip the page document itself (we get that via page.content())
      if (u === url) return;
      // Only capture JSON, JS, and small text bodies
      if (!/json|javascript|text/.test(ct)) return;
      const body = await response.text();
      if (body && body.length > 0 && body.length < 500_000) {
        networkBodies.push(body);
        networkUrls.push(u);
      }
    } catch {}
  });
  
  let status = 0;
  try {
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    status = resp?.status() || 0;
  } catch (err) {
    await context.close().catch(() => {});
    const e = new Error(err.message);
    e.code = err.message.includes('Timeout') ? 'fetch_timeout' : 'fetch_failed';
    throw e;
  }
  
  // Wait for hydration — bounded so we don't hang on flaky sites
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 });
  } catch {
    // Networkidle may never fire on sites with long-polling, that's OK
  }
  
  // Force lazy-loaded footer to render (where socials usually live)
  try {
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 1500));
      window.scrollTo(0, 0);
    });
  } catch {}
  
  // Wait for ANY social link to appear (up to 6s) — short-circuits if hydrated fast
  try {
    await page.waitForFunction(() => {
      const re = /facebook\.com|instagram\.com|tiktok\.com|youtube\.com|wa\.me|linkedin\.com|twitter\.com|x\.com/i;
      return Array.from(document.querySelectorAll('a[href]')).some((a) => re.test(a.href || ''));
    }, { timeout: 6000 });
  } catch {
    // Site genuinely has no socials, or they're not in <a> tags. OK.
  }
  
  // Grace period for chat widgets (Chaty, Tidio, Tawk) to inject their configs
  await page.waitForTimeout(1500);
  
  // Extract Shopify/theme runtime BEFORE getting HTML
  const runtime = await page.evaluate(() => {
    const result = {
      shopifySettings: null,
      themeSettings: null,
      st: null,
      socialLinks: [],
      structuredData: [],
    };
    
    try {
      if (typeof window.Shopify !== 'undefined') {
        result.shopifySettings = {
          shop: window.Shopify.shop || null,
          theme: window.Shopify.theme ? {
            id: window.Shopify.theme.id,
            name: window.Shopify.theme.name,
            settings: window.Shopify.theme.settings || null,
          } : null,
        };
      }
    } catch {}
    
    try {
      if (typeof window.__st !== 'undefined') {
        result.st = JSON.parse(JSON.stringify(window.__st));
      }
    } catch {}
    
    // Inline theme variables (var theme = {...}, window.theme = {...})
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const txt = s.textContent || '';
        const themeMatch = txt.match(/(?:window\.)?theme\s*=\s*(\{[\s\S]*?\});/);
        if (themeMatch) {
          try {
            const parsed = Function(`"use strict"; return (${themeMatch[1]})`)();
            if (parsed && typeof parsed === 'object') {
              result.themeSettings = parsed;
              break;
            }
          } catch {}
        }
      }
    } catch {}
    
    // Harvest ALL post-hydration anchors that look social
    try {
      const anchors = document.querySelectorAll('a[href]');
      const socialRe = /facebook\.com|instagram\.com|tiktok\.com|youtube\.com|twitter\.com|x\.com|linkedin\.com|wa\.me|whatsapp\.com|pinterest\.com|snapchat\.com|t\.me|telegram/i;
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (href && socialRe.test(href)) {
          result.socialLinks.push({
            href,
            ariaLabel: a.getAttribute('aria-label') || '',
            containerClass: a.closest('[class]')?.className?.toString().slice(0, 200) || '',
            text: (a.textContent || '').trim().slice(0, 50),
          });
        }
      }
    } catch {}
    
    // JSON-LD structured data (rendered or hydrated)
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          result.structuredData.push(JSON.parse(s.textContent || ''));
        } catch {}
      }
    } catch {}
    
    return result;
  });
  
  // NOW grab the hydrated HTML — this is what every extractor will use
  const html = await page.content();
  
  await context.close().catch(() => {});
  
  return {
    html,
    status,
    runtime,
    networkBodies,
    networkUrls,
  };
}


function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashSha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    // Strip tracking params that bust cache hits
    const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 
      'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'ref_'];
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.hash = '';
    return u.toString().replace(/\/$/, ''); // strip trailing slash
  } catch (_e) {
    return raw;
  }
}

// ─── HTML parsing helpers ────────────────────────────────────────────

function safeText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMeta(html, names) {
  for (const name of names) {
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i'
    );
    const m1 = html.match(re1);
    if (m1?.[1]) return safeText(m1[1]);

    const re2 = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
      'i'
    );
    const m2 = html.match(re2);
    if (m2?.[1]) return safeText(m2[1]);
  }
  return null;
}

function pickAllImages(html, baseUrl, limit = 15) {
  const out = [];
  const seen = new Set();
  const re = /<(?:img|source)[^>]+(?:src|srcset|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const raw = m[1].split(',')[0].split(' ')[0].trim();
    if (!raw || raw.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch (_) {
      continue;
    }
    if (seen.has(abs)) continue;
    // Skip tiny icons, trackers, pixels
    if (/\b(pixel|tracker|1x1|spacer|blank)\.(png|gif|jpg)/i.test(abs)) continue;
    if (/\.(svg)(\?|$)/i.test(abs)) continue; // SVGs often are icons
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function extractFontStack(html) {
  // Look for font-family declarations in <style> blocks and linked stylesheets
  const fonts = new Set();
  const fontFamilyRe = /font-family\s*:\s*["']?([^;"'\n}]+)["']?/gi;
  let m;
  while ((m = fontFamilyRe.exec(html)) && fonts.size < 10) {
    const stack = m[1].trim();
    // Split stack, take first font (the primary choice)
    const first = stack.split(',')[0].replace(/["']/g, '').trim();
    if (first && !['inherit', 'initial', 'unset'].includes(first.toLowerCase())) {
      fonts.add(first);
    }
  }
  
  // Also look for Google Fonts imports
  const googleFontsRe = /fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi;
  while ((m = googleFontsRe.exec(html)) && fonts.size < 10) {
    const name = decodeURIComponent(m[1].split(':')[0].replace(/\+/g, ' '));
    if (name) fonts.add(name);
  }
  
  return Array.from(fonts).slice(0, 5);
}

function deriveBrandName(host, title, ogSiteName) {
  // Prefer OG site name (most deliberate signal)
  if (ogSiteName && ogSiteName.length <= 40) return ogSiteName;
  
  if (title) {
    // "Acme — Buy fitness gear | Official Store" → "Acme"
    const sliced = title.split(/[—\-|·•:]/)[0].trim();
    if (sliced && sliced.length <= 40 && sliced.length >= 2) return sliced;
  }
  
  // Fallback: derive from host
  return host
    .replace(/^www\./, '')
    .split('.')[0]
    .split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function absUrl(href, base) {
  try {
    return new URL(href.trim(), base).toString();
  } catch (_) {
    return null;
  }
}

function iconScoreFromSizes(sizesStr) {
  if (!sizesStr || typeof sizesStr !== 'string') return 0;
  let max = 0;
  for (const p of sizesStr.split(/\s+/)) {
    const m = p.match(/(\d+)\s*x\s*(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10), parseInt(m[2], 10));
  }
  return max;
}

/**
 * Best-effort brand mark URL: apple-touch-icon, favicons, mask-icon,
 * JSON-LD Organization.logo, msapplication-TileImage. Returns absolute URL or null.
 */
function extractBestBrandIconUrl(html, urlObj) {
  if (!html || !urlObj) return null;
  const base = urlObj.toString();
  const candidates = [];

  const linkRe = /<link\b([^>]*?)>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[1];
    const relM = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    const hrefM = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!relM || !hrefM) continue;
    const href = hrefM[1].trim();
    if (!href || href.startsWith('data:')) continue;
    const rels = relM[1].toLowerCase().split(/\s+/).filter(Boolean);
    const sizesStr = (tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const dimBonus = iconScoreFromSizes(sizesStr);

    let score = 0;
    if (rels.some((r) => r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) {
      score = 100 + dimBonus;
    } else if (rels.includes('icon') || rels.includes('shortcut')) {
      score = 72 + dimBonus;
      if (/\.png(\?|$)/i.test(href)) score += 4;
      if (/\.webp(\?|$)/i.test(href)) score += 3;
    } else if (rels.includes('mask-icon')) {
      score = 48 + dimBonus;
    }

    if (score > 0) {
      const abs = absUrl(href, base);
      if (abs) candidates.push({ url: abs, score });
    }
  }

  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch (_) {
      continue;
    }
    const entities = [];
    const collect = (obj) => {
      if (!obj) return;
      if (Array.isArray(obj)) obj.forEach(collect);
      else if (typeof obj === 'object') {
        if (obj['@graph']) collect(obj['@graph']);
        entities.push(obj);
      }
    };
    collect(data);

    for (const ent of entities) {
      const types = [].concat(ent['@type'] || []).map((t) => String(t).toLowerCase());
      const isOrg = types.some((t) =>
        /organization|corporation|brand|localbusiness|store|restaurant|webpage|website|newsmediaorganization/.test(t),
      );
      if (!isOrg) continue;
      const logo = ent.logo;
      const pick = (l) => {
        if (typeof l === 'string') return l;
        if (l && typeof l.url === 'string') return l.url;
        return null;
      };
      const raw = Array.isArray(logo) ? pick(logo[0]) : pick(logo);
      if (raw) {
        const abs = absUrl(raw, base);
        if (abs) candidates.push({ url: abs, score: 88 });
      }
    }
  }

  const tileImg = pickMeta(html, ['msapplication-TileImage']);
  if (tileImg) {
    const abs = absUrl(tileImg, base);
    if (abs) candidates.push({ url: abs, score: 62 });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.url.length - a.url.length);
  return candidates[0].url;
}

function guessCategory(text) {
  const t = (text || '').toLowerCase();
  const buckets = [
    ['gym',         /gym|fitness|workout|crossfit|pilates|yoga|personal trainer|bodybuilding/],
    ['restaurant',  /restaurant|cafe|menu|dining|chef|cuisine|food delivery|shawarma|kunafa/],
    ['perfume',     /perfume|fragrance|oud|attar|cologne|scent/],
    ['skincare',    /skincare|skin care|cream|serum|moisturizer|sunscreen|spf/],
    ['fashion',     /fashion|clothing|apparel|abaya|kaftan|streetwear|dress|shoes/],
    ['realestate',  /property|real estate|apartment|villa|listing|broker|off-plan/],
    ['saas',        /software|platform|api|dashboard|automation|saas|crm/],
    ['jewelry',     /jewelry|jewellery|gold|diamond|ring|earring|bracelet/],
    ['beauty',      /beauty|makeup|cosmetic|lipstick|foundation|mascara/],
    ['tech',        /electronics|gadget|smart device|laptop|phone|tablet/],
    ['auto',        /car|vehicle|automobile|dealership|showroom|sedan|suv/],
    ['travel',      /travel|tour|hotel|flight|booking|vacation|resort/],
    ['education',   /course|training|certification|academy|learn|student/],
    ['ecommerce',   /shop|store|cart|checkout|product|order/],
  ];
  for (const [name, re] of buckets) {
    if (re.test(t)) return name;
  }
  return 'general';
}

// ─── HTTP fetch with retry + UA rotation ────────────────────────────

async function fetchHtmlWithRetries(url, { maxAttempts = 3 } = {}) {
  let lastErr;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': pickUA(),
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
          'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          'cache-control': 'no-cache',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      
      clearTimeout(timer);
      
      // 403 / 429 often signals Cloudflare challenge — retry with different UA
      if ((resp.status === 403 || resp.status === 429) && attempt < maxAttempts) {
        await sleep(650 * attempt); // backoff — give edge caches time to settle
        continue;
      }
      
      if (!resp.ok && resp.status >= 500 && attempt < maxAttempts) {
        await sleep(650 * attempt);
        continue;
      }
      
      if (!resp.ok) {
        const e = new Error(`HTTP ${resp.status} from ${url}`);
        e.code = resp.status === 403 || resp.status === 429 
          ? 'cloudflare_blocked' 
          : 'fetch_failed';
        e.status = resp.status;
        throw e;
      }
      
      // Stream with byte cap
      const reader = resp.body?.getReader();
      if (!reader) {
        return { html: await resp.text(), status: resp.status };
      }
      
      const chunks = [];
      let total = 0;
      let truncated = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) {
          truncated = true;
          break;
        }
        chunks.push(value);
      }
      
      const html = Buffer.concat(chunks).toString('utf8');
      return { html, status: resp.status, truncated };
      
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      
      if (err.name === 'AbortError') {
        lastErr = Object.assign(new Error('Timed out fetching URL'), { code: 'fetch_timeout' });
      }
      
      if (attempt < maxAttempts) {
        await sleep(650 * attempt);
      }
    }
  }
  
  if (lastErr.code) throw lastErr;
  throw Object.assign(new Error(lastErr?.message || 'Fetch failed'), { code: 'fetch_failed' });
}

// ─── Parse HTML into structured brand data ──────────────────────────

function parseHtmlData(html, urlObj) {
  const title = safeText((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '');
  const description = pickMeta(html, ['og:description', 'twitter:description', 'description']) || '';
  const ogImage = pickMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image']) || null;
  const ogSiteName = pickMeta(html, ['og:site_name', 'application-name']) || null;
  const themeColor = pickMeta(html, ['theme-color', 'msapplication-TileColor']) || null;
  
  const images = pickAllImages(html, urlObj.toString());
  if (ogImage && !images.includes(ogImage)) images.unshift(ogImage);
  
  // Strip script/style/noscript for clean text extraction
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  
  const paragraphs = (stripped.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map((p) =>
      safeText(p)
        .replace(/%3C[^%]*%3E/g, '')
        .replace(/url\(['"]?data:image[^'"]*['"]?\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((t) => t.length > 20 && t.length < 400)
    .slice(0, 8);
  
  const headlines = (stripped.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [])
    .map((h) => safeText(h))
    .filter((t) => t && t.length < 160)
    .slice(0, 10);
  
  // Extract CTAs from buttons and prominent links
  const ctas = (stripped.match(/<(?:button|a)[^>]*class\s*=\s*["'][^"']*(?:btn|cta|button)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|a)>/gi) || [])
    .map((c) => safeText(c))
    .filter((t) => t.length > 2 && t.length < 30)
    .slice(0, 6);
  
  const fonts = extractFontStack(html);
  
  const brandName = deriveBrandName(urlObj.host, title, ogSiteName);
  const sampleText = [title, description, ...headlines, ...paragraphs].join(' ');
  const category = guessCategory(sampleText);
  const brandIconUrl = extractBestBrandIconUrl(html, urlObj);

  return {
    title: title || brandName,
    description,
    ogImage,
    ogSiteName,
    themeColor,
    images,
    headlines,
    paragraphs,
    ctas,
    fonts,
    brandName,
    category,
    brandIconUrl,
  };
}

// ─── Cache layer ─────────────────────────────────────────────────────

async function checkHotCache(urlHash) {
  try {
    const cached = await getRedis().get(`scrape:${urlHash}`);
    return cached ? JSON.parse(cached) : null;
  } catch (_e) {
    return null;
  }
}

async function writeHotCache(urlHash, data) {
  try {
    await getRedis().setex(`scrape:${urlHash}`, HOT_CACHE_TTL_SEC, JSON.stringify(data));
  } catch (_e) { /* non-fatal */ }
}

async function checkWarmCache(urlHash) {
  try {
    const cutoff = new Date(Date.now() - WARM_CACHE_TTL_DAYS * 86400000);
    const doc = await UrlScrapeCache.findOne({
      urlHash,
      scrapedAt: { $gte: cutoff },
    }).lean();
    return doc?.data || null;
  } catch (_e) {
    return null;
  }
}

async function writeWarmCache(urlHash, url, data) {
  try {
    await UrlScrapeCache.findOneAndUpdate(
      { urlHash },
      { urlHash, url, data, scrapedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (_e) { /* non-fatal */ }
}

// ─── Main entry ──────────────────────────────────────────────────────

/**
 * Scrape a URL into rich brand intelligence.
 *
 * @param {string} rawUrl - User-provided URL (may lack protocol)
 * @param {object} opts
 * @param {boolean} opts.skipCache - Force fresh scrape (admin debug)
 * @param {boolean} opts.skipEnrichment - Skip palette/products/ads (fast mode)
 * @param {string[]} opts.only - Limit enrichment to specific modules
 * @returns {Promise<ScrapeResult>}
 */
// async function scrapeUrl(rawUrl, opts = {}) {
//   // ─── 1. SSRF guard ─────────────────────────────────────────────
//   const { url: urlObj } = await guardUrl(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  
//   const normalized = normalizeUrl(urlObj.toString());
//   const urlHash = hashSha256(normalized);
  
//   // ─── 2. Cache lookup ───────────────────────────────────────────
//   if (!opts.skipCache) {
//     const hot = await checkHotCache(urlHash);
//     if (hot) return { ...hot, _cacheLayer: 'hot' };
    
//     const warm = await checkWarmCache(urlHash);
//     if (warm) {
//       // Promote to hot cache
//       await writeHotCache(urlHash, warm);
//       return { ...warm, _cacheLayer: 'warm' };
//     }
//   }
  
//   // ─── 3. Fetch HTML ─────────────────────────────────────────────
//   const { html, status, truncated } = await fetchHtmlWithRetries(urlObj.toString());
  
//   // ─── 4. Parse core data (synchronous, fast) ────────────────────
//   const parsed = parseHtmlData(html, urlObj);
  
//   // ─── 5. Parallel enrichment (fan out, wait for all) ────────────
//   const only = opts.only || ['palette', 'products', 'ads'];
//   const enrichPromises = [];
  
//   // CSS-based palette (primary — reads color from stylesheets, not logo pixels)
//   enrichPromises.push(
//     Promise.resolve(extractCssPalette({ html }))
//       .then((cssP) => ({ key: 'cssPalette', value: cssP }))
//       .catch(() => ({ key: 'cssPalette', value: null }))
//   );

//   // Social handles extraction (runs against raw HTML, zero latency)
//   enrichPromises.push(
//     Promise.resolve(extractSocialHandles({ html, url: urlObj.toString() }))
//       .then((r) => ({ key: 'socialHandles', value: r.handles }))
//       .catch(() => ({ key: 'socialHandles', value: {} }))
//   );

//   // Image-based palette from OG image (kept as fallback)
//   if (only.includes('palette') && parsed.images.length) {
//     enrichPromises.push(
//       fetchBrandPalette({
//         primaryImageUrl: parsed.images[0],
//         fallbackImages: parsed.images.slice(1, 9),
//         themeColor: parsed.themeColor,
//         maxSourcesToMerge: 6,
//       })
//       .then((palette) => ({ key: 'palette', value: palette }))
//       .catch((err) => ({ key: 'palette', error: err.message }))
//     );
//   } else {
//     enrichPromises.push(Promise.resolve({ key: 'palette', value: null }));
//   }
  
//   // Product catalog (Shopify / WC / Magento)
//   if (only.includes('products')) {
//     enrichPromises.push(
//       fetchProductCatalog(urlObj.origin)
//       .then((catalog) => ({ key: 'products', value: catalog }))
//       .catch((err) => ({ key: 'products', error: err.message }))
//     );
//   } else {
//     enrichPromises.push(Promise.resolve({ key: 'products', value: null }));
//   }
  
//   // Competitor ads from Meta Ad Library
//   if (only.includes('ads') ) {
//     enrichPromises.push(
//       fetchCompetitorAds({
//         brandName: parsed.brandName,
//         category: parsed.category,
//         countries: ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'],
//         pageId: parsed.facebookPageId,
//         competitorBrands: parsed?.competitorBrands || [],
//       })
//       .then((ads) => ({ key: 'ads', value: ads }))
//       .catch((err) => ({ key: 'ads', error: err.message }))
//     );
//   } else {
//     enrichPromises.push(Promise.resolve({ key: 'ads', value: null }));
//   }
  
//   const enrichments = await Promise.all(enrichPromises);
//   const byKey = Object.fromEntries(enrichments.map((e) => [e.key, e]));
  
//   // ─── 6. Assemble result ────────────────────────────────────────
//   const result = {
//     // URL metadata
//     url: normalized,
//     host: urlObj.host,
//     origin: urlObj.origin,
//     status,
//     truncated: !!truncated,
//     scrapedAt: new Date().toISOString(),
    
//     // Core brand data
//     brandName: parsed.brandName,
//     siteName: parsed.ogSiteName || parsed.brandName,
//     title: parsed.title,
//     description: parsed.description,
//     category: parsed.category,
//     favicon: parsed.brandIconUrl || `${urlObj.origin}/favicon.ico`,
    
//     // Content samples
//     headlines: parsed.headlines,
//     paragraphs: parsed.paragraphs,
//     ctas: parsed.ctas,
//     images: parsed.images.slice(0, 12),
//     fonts: parsed.fonts,
    
//     // Enrichment (nullable — graceful degradation)
//     // CSS palette is more accurate than image-based; fall back when CSS yields nothing
//     brandPalette: (() => {
//       const css = byKey.cssPalette?.value;
//       const img = byKey.palette?.value;
//       if (css?.palette?.length >= 2) return { ...img, ...css, _source: 'css' };
//       if (img) return { ...img, _source: 'image' };
//       return null;
//     })(),
//     socialHandles: byKey.socialHandles?.value || {},
//     productCatalog: byKey.products?.value || null,
//     // competitorAds: byKey.ads?.value || null,
    
//     // Enrichment errors (for observability)
//     _enrichmentErrors: Object.fromEntries(
//       Object.entries(byKey)
//         .filter(([_, v]) => v.error)
//         .map(([k, v]) => [k, v.error])
//     ),
    
//     // For downstream services (intentEngine, adBrain) — optional
//     rawHtml: opts.includeHtml ? html : undefined,
//     _cacheLayer: 'fresh',
//   };
  
//   // ─── 7. Cache writes (parallel, non-blocking) ──────────────────
//   Promise.all([
//     writeHotCache(urlHash, result),
//     writeWarmCache(urlHash, normalized, result),
//   ]).catch((err) => {
//     console.warn('[urlScraper] cache write failed:', err.message);
//   });
  
//   return result;
// }


async function scrapeUrl(rawUrl, opts = {}) {
  const { url: urlObj } = await guardUrl(
    rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
  );
  
  const normalized = normalizeUrl(urlObj.toString());
  const urlHash = hashSha256(normalized);
  
  // Cache check (unchanged)
  if (!opts.skipCache) {
    const hot = await checkHotCache(urlHash);
    if (hot) return { ...hot, _cacheLayer: 'hot' };
    const warm = await checkWarmCache(urlHash);
    if (warm) {
      await writeHotCache(urlHash, warm);
      return { ...warm, _cacheLayer: 'warm' };
    }
  }
  console.log('fetching hydrated html');
  // ── Single hydrated fetch — replaces fetchHtmlWithRetries ────────
  const { html, status, runtime, networkBodies } = await fetchHydrated(urlObj.toString());
  const truncated = false;
  console.log('fetched hydrated html');
  
  // Concatenate network bodies into a single searchable string
  // for extractors that work on raw text (social handles, WA configs)
  const networkText = networkBodies.join('\n');
  
  // Parse core data from HYDRATED HTML — now socials, products, palette
  // all see the real rendered page
  const parsed = parseHtmlData(html, urlObj);
  
  const only = opts.only || ['palette', 'products', 'ads'];
  const enrichPromises = [];
  
  enrichPromises.push(
    Promise.resolve(extractCssPalette({ html }))
      .then((cssP) => ({ key: 'cssPalette', value: cssP }))
      .catch(() => ({ key: 'cssPalette', value: null }))
  );
  
  // Pass the hydrated HTML AND runtime data AND networkText to the social extractor
  // It no longer needs to launch its own browser
  enrichPromises.push(
    Promise.resolve(extractSocialHandles({
      html,
      url: urlObj.toString(),
      runtime,          // ← pre-extracted Shopify/theme data
      networkText,      // ← captured XHR bodies
      forceHydrated: false,  // ← we already hydrated, don't relaunch
    }))
      .then((r) => ({ key: 'socialHandles', value: r.handles, debug: r }))
      .catch((err) => ({ key: 'socialHandles', value: {}, error: err.message }))
  );
  
  if (only.includes('palette') && parsed.images.length) {
    enrichPromises.push(
      fetchBrandPalette({
        primaryImageUrl: parsed.images[0],
        fallbackImages: parsed.images.slice(1, 9),
        themeColor: parsed.themeColor,
        maxSourcesToMerge: 6,
      })
        .then((palette) => ({ key: 'palette', value: palette }))
        .catch((err) => ({ key: 'palette', error: err.message }))
    );
  } else {
    enrichPromises.push(Promise.resolve({ key: 'palette', value: null }));
  }
  
  if (only.includes('products')) {
    enrichPromises.push(
      fetchProductCatalog(urlObj.origin)
        .then((catalog) => ({ key: 'products', value: catalog }))
        .catch((err) => ({ key: 'products', error: err.message }))
    );
  } else {
    enrichPromises.push(Promise.resolve({ key: 'products', value: null }));
  }
  
  if (only.includes('ads')) {
    enrichPromises.push(
      fetchCompetitorAds({
        brandName: parsed.brandName,
        category: parsed.category,
        countries: ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'],
        pageId: parsed.facebookPageId,
        competitorBrands: parsed?.competitorBrands || [],
      })
        .then((ads) => ({ key: 'ads', value: ads }))
        .catch((err) => ({ key: 'ads', error: err.message }))
    );
  } else {
    enrichPromises.push(Promise.resolve({ key: 'ads', value: null }));
  }
  
  const enrichments = await Promise.all(enrichPromises);
  const byKey = Object.fromEntries(enrichments.map((e) => [e.key, e]));
  
  const result = {
    url: normalized,
    host: urlObj.host,
    origin: urlObj.origin,
    status,
    truncated,
    scrapedAt: new Date().toISOString(),
    
    brandName: parsed.brandName,
    siteName: parsed.ogSiteName || parsed.brandName,
    title: parsed.title,
    description: parsed.description,
    category: parsed.category,
    favicon: parsed.brandIconUrl || `${urlObj.origin}/favicon.ico`,
    
    headlines: parsed.headlines,
    paragraphs: parsed.paragraphs,
    ctas: parsed.ctas,
    images: parsed.images.slice(0, 12),
    fonts: parsed.fonts,
    
    brandPalette: (() => {
      const css = byKey.cssPalette?.value;
      const img = byKey.palette?.value;
      if (css?.palette?.length >= 2) return { ...img, ...css, _source: 'css' };
      if (img) return { ...img, _source: 'image' };
      return null;
    })(),
    socialHandles: byKey.socialHandles?.value || {},
    productCatalog: byKey.products?.value || null,
    
    _enrichmentErrors: Object.fromEntries(
      Object.entries(byKey)
        .filter(([_, v]) => v.error)
        .map(([k, v]) => [k, v.error])
    ),
    _socialHandlesDebug: byKey.socialHandles?.debug || null,
    
    rawHtml: opts.includeHtml ? html : undefined,
    _cacheLayer: 'fresh',
  };
  
  Promise.all([
    writeHotCache(urlHash, result),
    writeWarmCache(urlHash, normalized, result),
  ]).catch((err) => {
    console.warn('[urlScraper] cache write failed:', err.message);
  });
  
  return result;
}

/**
 * Lightweight URL validation — for preview/estimate endpoints that
 * don't need full scrape. Returns { valid, host, error? }.
 */
async function validateUrl(rawUrl) {
  try {
    const { url: urlObj } = await guardUrl(
      rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
    );
    return { valid: true, host: urlObj.host, normalizedUrl: normalizeUrl(urlObj.toString()) };
  } catch (err) {
    return { valid: false, error: err.message, code: err.code };
  }
}

module.exports = {
  scrapeUrl,
  validateUrl,
  // Exposed for tests + granular use
  normalizeUrl,
  closeBrowser,
  fetchHydrated,
  parseHtmlData,
  extractFontStack,
  extractBestBrandIconUrl,
  deriveBrandName,
  guessCategory,
};