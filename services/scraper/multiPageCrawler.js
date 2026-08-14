'use strict';

/**
 * multiPageCrawler — fetches a brand's site across multiple pages so downstream
 * extractors (handles, palette, team, services) have rich context to work with.
 *
 * Why: scraping only the URL the user pasted misses 80% of brand signal.
 * Social links live in the homepage header. Doctor names live on /about or
 * /team pages. Service descriptions live on /services. The pasted URL might
 * be a deep product page with none of this.
 *
 * Strategy:
 *   1. Always fetch the user's URL (raw HTML, no markdown transform)
 *   2. If user's URL is a deep-link, also fetch homepage
 *   3. Try to fetch /sitemap.xml and /sitemap_index.xml
 *   4. From sitemap (or fallback: parsed homepage menus), pick up to 10
 *      high-value URLs (about, services, team, contact, doctors, etc.)
 *   5. Fetch those in bounded concurrency
 *   6. Return { rawHtml (concatenated), pages[], sitemapUrls[], failures[] }
 *
 * Caching:
 *   - Per-domain Redis cache, 24h TTL
 *   - Key: `crawler:v1:${domain}:${sha256(pasteUrl)}`
 *
 * Cost: 1 paste fetch + 1 homepage fetch + 1 sitemap fetch + up to 10 deep
 * fetches = ~13 HTTP requests. With 24h cache and 1KB-50KB pages, this is
 * ~$0.00 marginal cost (no Apify, just axios).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const xml2js = require('xml2js');

// ---------- Configuration ----------

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB per page
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_DEEP_PAGES = 10;
const DEFAULT_CACHE_TTL_SECONDS = 86400; // 24h

const USER_AGENT =
  'Mozilla/5.0 (compatible; QumakBot/1.0; +https://qumak.io/bot)';

// Pages worth fetching deeply. Ordered by signal density.
// We rank candidate URLs by how many of these tokens appear in the path.
const HIGH_VALUE_PATH_TOKENS = [
  'about',
  'about-us',
  'team',
  'doctors',
  'staff',
  'practitioners',
  'services',
  'departments',
  'specialties',
  'menu',
  'products',
  'pricing',
  'contact',
  'contact-us',
  'locations',
  'branches',
];

// We exclude these patterns even if they show up in sitemap — they're noise.
const EXCLUDE_PATH_TOKENS = [
  '/wp-admin',
  '/wp-login',
  '/wp-json',
  '/feed',
  '/comments',
  '/tag/',
  '/category/',
  '/author/',
  '/?',
  '/cart',
  '/checkout',
  '/my-account',
  '.xml',
  '.pdf',
  '.zip',
  '/page/',
];

// ---------- HTTP helpers ----------

async function fetchHtml(url, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  try {
    const response = await axios.get(url, {
      timeout,
      maxContentLength: maxBytes,
      maxRedirects: 5,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
      validateStatus: (s) => s >= 200 && s < 400,
      responseType: 'text',
      decompress: true,
    });

    return {
      ok: true,
      url: response.request?.res?.responseUrl || url, // post-redirect URL
      status: response.status,
      html: typeof response.data === 'string' ? response.data : '',
      contentType: response.headers?.['content-type'] || '',
      bytes: Buffer.byteLength(response.data || '', 'utf8'),
    };
  } catch (err) {
    return {
      ok: false,
      url,
      status: err.response?.status || 0,
      html: '',
      error: err.message || 'fetch_failed',
      code: err.code || null,
    };
  }
}

// Bounded-concurrency parallel map. No external deps so this stays portable.
async function pMapBounded(items, mapper, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await mapper(items[i], i);
      } catch (err) {
        results[i] = { ok: false, error: err.message, item: items[i] };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------- URL utilities ----------

function safeParseUrl(input) {
  try {
    const u = new URL(input);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function isDeepLink(parsedUrl) {
  if (!parsedUrl) return false;
  const p = parsedUrl.pathname || '/';
  return p !== '/' && p.length > 1 && !p.match(/^\/+$/);
}

function homepageOf(parsedUrl) {
  return `${parsedUrl.protocol}//${parsedUrl.host}/`;
}

function isSameOrigin(a, b) {
  if (!a || !b) return false;
  return a.host === b.host;
}

function pathTokens(urlObj) {
  return (urlObj.pathname || '/')
    .toLowerCase()
    .split(/[/_-]+/)
    .filter(Boolean);
}

// Score a candidate URL by how "valuable" its path looks. Higher = better.
function scoreCandidate(urlObj) {
  const path = (urlObj.pathname || '/').toLowerCase();

  if (EXCLUDE_PATH_TOKENS.some((tok) => path.includes(tok))) return -1;

  const tokens = pathTokens(urlObj);
  let score = 0;

  for (const valuable of HIGH_VALUE_PATH_TOKENS) {
    if (tokens.includes(valuable)) score += 10;
    else if (path.includes(valuable)) score += 5;
  }

  // Shorter paths usually mean top-level pages we want.
  const depth = tokens.length;
  if (depth === 1) score += 4;
  else if (depth === 2) score += 2;
  else if (depth >= 5) score -= 2;

  return score;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const key = u.replace(/#.*$/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

// ---------- Sitemap parsing ----------

async function fetchSitemapUrls(originUrl) {
  const candidates = [
    `${originUrl}sitemap.xml`,
    `${originUrl}sitemap_index.xml`,
    `${originUrl}sitemap-index.xml`,
    `${originUrl}wp-sitemap.xml`,
  ];

  for (const candidate of candidates) {
    const res = await fetchHtml(candidate, { timeout: 8000 });
    if (!res.ok || !res.html) continue;
    if (!/<\s*(urlset|sitemapindex)/i.test(res.html)) continue;

    try {
      const parsed = await xml2js.parseStringPromise(res.html, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      // Top-level urlset case
      if (parsed.urlset?.url) {
        const entries = Array.isArray(parsed.urlset.url)
          ? parsed.urlset.url
          : [parsed.urlset.url];
        return entries.map((e) => e.loc).filter(Boolean);
      }

      // Sitemap index case — fetch first few child sitemaps
      if (parsed.sitemapindex?.sitemap) {
        const childSitemaps = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];

        const childUrls = [];
        for (const child of childSitemaps.slice(0, 3)) {
          if (!child.loc) continue;
          const childRes = await fetchHtml(child.loc, { timeout: 8000 });
          if (!childRes.ok) continue;
          try {
            const childParsed = await xml2js.parseStringPromise(childRes.html, {
              explicitArray: false,
              ignoreAttrs: true,
            });
            const entries = childParsed.urlset?.url
              ? Array.isArray(childParsed.urlset.url)
                ? childParsed.urlset.url
                : [childParsed.urlset.url]
              : [];
            for (const e of entries) {
              if (e.loc) childUrls.push(e.loc);
            }
          } catch {
            // Skip malformed child sitemap
          }
        }
        return childUrls;
      }
    } catch {
      // Try next candidate
    }
  }

  return [];
}

// ---------- Fallback: discover pages from homepage menus ----------

function discoverPagesFromMenu(homepageHtml, baseUrl) {
  if (!homepageHtml) return [];
  const $ = cheerio.load(homepageHtml);
  const found = new Set();

  // Anchor sources, in priority order
  const selectors = [
    'nav a[href]',
    'header a[href]',
    '.menu a[href]',
    '.navigation a[href]',
    'footer a[href]',
    'a[href]', // last resort
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('mailto:') ||
          href.startsWith('tel:') || href.startsWith('javascript:')) {
        return;
      }

      let absolute;
      try {
        absolute = new URL(href, baseUrl.toString()).toString();
      } catch {
        return;
      }

      const parsed = safeParseUrl(absolute);
      if (!parsed) return;
      if (!isSameOrigin(parsed, baseUrl)) return;

      found.add(absolute.replace(/#.*$/, ''));
    });
    if (found.size >= 50) break;
  }

  return Array.from(found);
}

// ---------- Cache helpers ----------

function makeCacheKey(pasteUrl) {
  const parsed = safeParseUrl(pasteUrl);
  const domain = parsed?.host || 'unknown';
  const hash = crypto
    .createHash('sha256')
    .update(pasteUrl)
    .digest('hex')
    .slice(0, 16);
  return `crawler:v1:${domain}:${hash}`;
}

async function readFromCache(redis, key) {
  if (!redis) return null;
  try {
    const cached = await redis.get(key);
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    parsed._cacheHit = true;
    return parsed;
  } catch {
    return null;
  }
}

async function writeToCache(redis, key, value, ttl) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {
    // Cache failures are non-fatal
  }
}

// ---------- Main entrypoint ----------

/**
 * Crawl a brand site across paste URL + homepage + sitemap pages.
 *
 * @param {object} opts
 * @param {string} opts.url - URL the user pasted
 * @param {object} [opts.redis] - ioredis client (optional, for caching)
 * @param {number} [opts.maxDeepPages] - cap on deep pages fetched
 * @param {number} [opts.concurrency]
 * @param {number} [opts.cacheTTL] - seconds
 * @param {boolean} [opts.bypassCache]
 *
 * @returns {Promise<{
 *   pasteUrl: string,
 *   homepage: string,
 *   pages: Array<{url: string, html: string, status: number, role: string}>,
 *   rawHtml: string,
 *   sitemapUrls: string[],
 *   failures: Array<{url: string, error: string}>,
 *   _cacheHit?: boolean
 * }>}
 */
async function crawl(opts) {
  const {
    url,
    redis = null,
    maxDeepPages = DEFAULT_MAX_DEEP_PAGES,
    concurrency = DEFAULT_CONCURRENCY,
    cacheTTL = DEFAULT_CACHE_TTL_SECONDS,
    bypassCache = false,
  } = opts;

  const parsed = safeParseUrl(url);
  if (!parsed) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const cacheKey = makeCacheKey(url);
  if (!bypassCache) {
    const cached = await readFromCache(redis, cacheKey);
    if (cached) return cached;
  }

  const failures = [];
  const pages = [];

  // 1. Fetch the pasted URL
  const pasteRes = await fetchHtml(url);
  if (pasteRes.ok) {
    pages.push({
      url: pasteRes.url,
      html: pasteRes.html,
      status: pasteRes.status,
      role: 'paste',
    });
  } else {
    failures.push({ url, error: pasteRes.error, role: 'paste' });
  }

  // 2. Fetch homepage if paste URL is a deep link
  const homepageUrl = homepageOf(parsed);
  let homepageHtml = '';
  if (isDeepLink(parsed)) {
    const homeRes = await fetchHtml(homepageUrl);
    if (homeRes.ok) {
      pages.push({
        url: homeRes.url,
        html: homeRes.html,
        status: homeRes.status,
        role: 'homepage',
      });
      homepageHtml = homeRes.html;
    } else {
      failures.push({ url: homepageUrl, error: homeRes.error, role: 'homepage' });
    }
  } else {
    // Paste URL IS the homepage
    homepageHtml = pasteRes.ok ? pasteRes.html : '';
  }

  // 3. Discover deep pages: sitemap first, then menu fallback
  let candidateUrls = [];
  try {
    candidateUrls = await fetchSitemapUrls(homepageUrl);
  } catch {
    candidateUrls = [];
  }

  const sitemapUrls = [...candidateUrls];

  if (candidateUrls.length === 0 && homepageHtml) {
    candidateUrls = discoverPagesFromMenu(homepageHtml, parsed);
  }

  // Filter to same-origin only and exclude noisy paths
  candidateUrls = candidateUrls
    .map((u) => safeParseUrl(u))
    .filter(Boolean)
    .filter((u) => isSameOrigin(u, parsed))
    .filter((u) => {
      const path = (u.pathname || '/').toLowerCase();
      return !EXCLUDE_PATH_TOKENS.some((tok) => path.includes(tok));
    });

  // Drop URLs already fetched (paste, homepage)
  const alreadyFetched = new Set(pages.map((p) => p.url.replace(/\/+$/, '')));
  candidateUrls = candidateUrls.filter(
    (u) => !alreadyFetched.has(u.toString().replace(/\/+$/, ''))
  );

  // Score and rank
  const ranked = candidateUrls
    .map((u) => ({ u, score: scoreCandidate(u) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDeepPages)
    .map((x) => x.u.toString());

  const deepUrls = dedupeUrls(ranked);

  // 4. Fetch deep pages in parallel
  const deepResults = await pMapBounded(
    deepUrls,
    async (deepUrl) => {
      const r = await fetchHtml(deepUrl);
      return { url: deepUrl, ...r };
    },
    concurrency
  );

  for (const r of deepResults) {
    if (r.ok) {
      pages.push({
        url: r.url,
        html: r.html,
        status: r.status,
        role: 'deep',
      });
    } else {
      failures.push({ url: r.url, error: r.error, role: 'deep' });
    }
  }

  // 5. Build merged rawHtml. Wrap each page so downstream extractors know
  //    where each chunk came from if they care to inspect.
  const rawHtml = pages
    .map(
      (p) =>
        `\n<!-- QUMAK_PAGE_START url="${p.url}" role="${p.role}" -->\n${p.html}\n<!-- QUMAK_PAGE_END -->\n`
    )
    .join('\n');

  const result = {
    pasteUrl: url,
    homepage: homepageUrl,
    pages,
    rawHtml,
    sitemapUrls,
    failures,
    pagesFetched: pages.length,
    failuresCount: failures.length,
  };

  await writeToCache(redis, cacheKey, result, cacheTTL);

  return result;
}

module.exports = {
  crawl,
  // Exposed for testing
  _internal: {
    fetchHtml,
    safeParseUrl,
    isDeepLink,
    homepageOf,
    scoreCandidate,
    discoverPagesFromMenu,
    pMapBounded,
    EXCLUDE_PATH_TOKENS,
    HIGH_VALUE_PATH_TOKENS,
  },
};
