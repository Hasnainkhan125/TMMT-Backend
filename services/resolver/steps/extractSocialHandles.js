// services/resolver/steps/extractSocialHandles.js
//
// Robust social handle resolver.
//
// Why this file matters: every downstream collector (Apify FB Ads, Meta Ad
// Library, Instagram profile scraper, TikTok crawler, intelligence collectors,
// the ROAST panel) keys off the handles we resolve here. A missed Instagram
// handle silently kills five collectors and the user blames "Qumak's AI".
//
// Two functions are exported:
//   1. extractSocialHandles(html, schemaOrg)
//      Pure, sync. Same signature this file has always exported. Iterates
//      every <a href> on the supplied HTML plus any schema.org sameAs URLs,
//      returns { facebook: { urls: [], handles: [] }, instagram: {...}, ... }.
//      Existing call sites (brandIdentityResolver.js:97) keep working.
//
//   2. extractSocialHandlesFromUrl({ url, html, schemaOrg })
//      Async wrapper. If `url` is a deep link (path !== '/') AND the sync
//      extractor missed BOTH facebook and instagram, fetches the homepage
//      (single axios GET, 8s timeout, 5 MB cap) and re-runs the extractor
//      against it. Merges results — homepage wins on conflict because brands
//      put their canonical socials in the header/footer, not on every
//      product page.
//
//      This is the fix for the Afghan Palace bug: user pasted a deep link,
//      the homepage had `<a href="https://www.facebook.com/AfghanPalaceRestaurant">`
//      in a Font Awesome `<ul class="fa-ul">`, and the deep-link page didn't.
//
// We deliberately DO NOT replace the existing pattern dictionary with the
// looser regex from the spec — the existing patterns already handle every
// case the spec's regexes do (they iterate the same `a[href]` set), but
// they ALSO exclude Facebook share/sharer/dialog endpoints and Instagram
// /p/ /reel/ /tv/ post URLs which the loose regex would mistakenly tag as
// brand handles. The actual bug was the missing homepage fallback.

const cheerio = require('cheerio');
const axios   = require('axios');
const { URL } = require('url');

const SOCIAL_PATTERNS = {
  facebook: {
    domains: ['facebook.com', 'fb.com', 'm.facebook.com'],
    // `/tr` and `/sharer.php` have NO trailing slash (the pixel uses
    // `?id=...`, sharer.php is bare). Match both `/tr/` and `/tr` (end
    // or `?`/`#`) by ending the alternation with (?:\/|$).
    excludePaths: /^\/(sharer|share|dialog|plugins|intent|tr|ads|business|groups|events)(?:\/|$|\?)/i,
    extractHandle: (url) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/+|\/+$/g, '');
      const parts = path.split('/');
      if (parts.length === 0 || !parts[0]) return null;
      if (/^(pages|profile\.php|people)$/.test(parts[0])) {
        return parts[1] || null;
      }
      return parts[0];
    },
  },
  instagram: {
    domains: ['instagram.com'],
    excludePaths: /^\/(p|reel|stories|explore|direct|tv|reels|accounts|about|legal)(?:\/|$|\?)/i,
    extractHandle: (url) => {
      const u = new URL(url);
      const handle = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
      return /^[a-z0-9._]{1,30}$/i.test(handle) ? handle.toLowerCase() : null;
    },
  },
  tiktok: {
    domains: ['tiktok.com'],
    extractHandle: (url) => {
      const u = new URL(url);
      const match = u.pathname.match(/^\/@([a-z0-9_.]+)/i);
      return match ? match[1].toLowerCase() : null;
    },
  },
  youtube: {
    domains: ['youtube.com', 'youtu.be'],
    extractHandle: (url) => {
      const u = new URL(url);
      const atMatch = u.pathname.match(/^\/@([a-z0-9_.-]+)/i);
      if (atMatch) return '@' + atMatch[1];
      const cMatch = u.pathname.match(/^\/c\/([^/]+)/);
      if (cMatch) return cMatch[1];
      const channelMatch = u.pathname.match(/^\/channel\/([^/]+)/);
      if (channelMatch) return channelMatch[1];
      const userMatch = u.pathname.match(/^\/user\/([^/]+)/);
      if (userMatch) return userMatch[1];
      return null;
    },
  },
  twitter: {
    domains: ['twitter.com', 'x.com'],
    excludePaths: /^\/(intent|share|search|home|compose|hashtag|i)(?:\/|$|\?)/i,
    extractHandle: (url) => {
      const u = new URL(url);
      const handle = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
      return /^[a-z0-9_]{1,15}$/i.test(handle) ? handle.toLowerCase() : null;
    },
  },
  linkedin: {
    domains: ['linkedin.com'],
    extractHandle: (url) => {
      const u = new URL(url);
      const match = u.pathname.match(/^\/(company|in|school)\/([^/]+)/);
      if (match) return { type: match[1], handle: match[2] };
      return null;
    },
  },
  snapchat: {
    domains: ['snapchat.com'],
    extractHandle: (url) => {
      const u = new URL(url);
      const match = u.pathname.match(/^\/add\/([a-z0-9._-]+)/i);
      return match ? match[1] : null;
    },
  },
  pinterest: {
    domains: ['pinterest.com', 'pinterest.ae'],
    extractHandle: (url) => {
      const u = new URL(url);
      return u.pathname.split('/').filter(Boolean)[0] || null;
    },
  },
  threads: {
    domains: ['threads.net'],
    extractHandle: (url) => {
      const u = new URL(url);
      const match = u.pathname.match(/^\/@([a-z0-9._]+)/i);
      return match ? match[1].toLowerCase() : null;
    },
  },
  whatsapp: {
    // wa.me/971501234567, api.whatsapp.com/send?phone=971501234567,
    // chat.whatsapp.com/<group-id>
    domains: ['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com'],
    extractHandle: (url) => {
      const u = new URL(url);
      if (u.hostname.endsWith('chat.whatsapp.com')) {
        const id = u.pathname.replace(/^\/+|\/+$/g, '');
        return id || null;
      }
      const phoneFromQuery = u.searchParams.get('phone');
      if (phoneFromQuery && /^\+?\d{6,15}$/.test(phoneFromQuery.replace(/\s/g, ''))) {
        return phoneFromQuery.replace(/\D/g, '');
      }
      const m = u.pathname.match(/\/(\d{6,15})/);
      return m ? m[1] : null;
    },
  },
};

const PLATFORMS = Object.keys(SOCIAL_PATTERNS);

function emptyResult() {
  const out = {};
  for (const platform of PLATFORMS) {
    out[platform] = { urls: new Set(), handles: new Set() };
  }
  return out;
}

function processLink(rawLink, handles) {
  let link = rawLink;
  let u;
  try {
    if (link.startsWith('//')) link = 'https:' + link;
    if (!/^https?:\/\//.test(link)) return;
    u = new URL(link);
  } catch {
    return;
  }

  const hostname = u.hostname.replace(/^www\./, '').toLowerCase();

  for (const [platform, spec] of Object.entries(SOCIAL_PATTERNS)) {
    if (!spec.domains.some((d) => hostname === d || hostname.endsWith('.' + d))) continue;
    if (spec.excludePaths && spec.excludePaths.test(u.pathname)) continue;

    let extracted;
    try {
      extracted = spec.extractHandle(link);
    } catch {
      continue;
    }
    if (!extracted) continue;

    handles[platform].urls.add(link);

    if (typeof extracted === 'string') {
      handles[platform].handles.add(extracted);
    } else if (extracted.handle) {
      handles[platform].handles.add(`${extracted.type}/${extracted.handle}`);
    }
  }
}

/**
 * Find all social handles referenced in the HTML.
 * Sources: <a> hrefs and Schema.org sameAs.
 *
 * @param {string} html
 * @param {object} [schemaOrg] — { organization: { sameAs: [...] } }
 * @returns {Record<string, { urls: string[], handles: string[] }>}
 */
function extractSocialHandles(html, schemaOrg = null) {
  const handles = emptyResult();
  if (!html || typeof html !== 'string') {
    return serializeHandles(handles);
  }

  const $ = cheerio.load(html);
  const allLinks = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) allLinks.add(href);
  });

  if (schemaOrg?.organization?.sameAs) {
    const sameAs = Array.isArray(schemaOrg.organization.sameAs)
      ? schemaOrg.organization.sameAs
      : [schemaOrg.organization.sameAs];
    sameAs.forEach((u) => allLinks.add(u));
  }

  for (const link of allLinks) {
    processLink(link, handles);
  }

  return serializeHandles(handles);
}

function serializeHandles(handles) {
  const out = {};
  for (const [platform, { urls, handles: hdls }] of Object.entries(handles)) {
    out[platform] = {
      urls: Array.from(urls),
      handles: Array.from(hdls),
    };
  }
  return out;
}

function mergeResults(primary, secondary) {
  const out = {};
  for (const platform of PLATFORMS) {
    const a = primary[platform] || { urls: [], handles: [] };
    const b = secondary[platform] || { urls: [], handles: [] };
    out[platform] = {
      urls:    Array.from(new Set([...a.urls, ...b.urls])),
      handles: Array.from(new Set([...a.handles, ...b.handles])),
    };
  }
  return out;
}

function isDeepLink(url) {
  try {
    const u = new URL(url);
    const path = u.pathname || '/';
    if (path === '/' || path === '') return false;
    if (path.length <= 1) return false;
    return true;
  } catch {
    return false;
  }
}

function homepageOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

const HOMEPAGE_FETCH_TIMEOUT_MS = Number(process.env.SOCIAL_HOMEPAGE_TIMEOUT_MS || 8000);
const HOMEPAGE_FETCH_MAX_BYTES  = 5 * 1024 * 1024;

/**
 * Async wrapper around extractSocialHandles that adds a homepage-fallback
 * fetch when the user pasted a deep link and we missed primary handles.
 *
 * Returns the same shape as extractSocialHandles, plus a `_meta` field with
 * provenance information so callers (and the eval harness) can tell where
 * each handle came from.
 *
 * @param {object} args
 * @param {string} args.url        — the URL the user pasted
 * @param {string} args.html       — already-fetched HTML for that URL
 * @param {object} [args.schemaOrg]
 * @param {Function} [args.fetcher] — override for tests; default uses axios
 * @returns {Promise<object & { _meta: { sources: { pasteUrl: boolean, homepage: boolean }, homepageError?: string } }>}
 */
async function extractSocialHandlesFromUrl({ url, html, schemaOrg = null, fetcher } = {}) {
  if (!url || typeof url !== 'string') {
    return { ...extractSocialHandles(html || '', schemaOrg), _meta: { sources: { pasteUrl: !!html, homepage: false } } };
  }

  const fromPaste = extractSocialHandles(html || '', schemaOrg);

  const meta = {
    sources: {
      pasteUrl: hasAnyHandles(fromPaste),
      homepage: false,
    },
  };

  const missingPrimary =
    fromPaste.facebook.handles.length === 0 &&
    fromPaste.instagram.handles.length === 0;
  const deepLink = isDeepLink(url);

  if (!deepLink || !missingPrimary) {
    return { ...fromPaste, _meta: meta };
  }

  const home = homepageOf(url);
  if (!home || home === url) {
    return { ...fromPaste, _meta: meta };
  }

  let homeHtml = '';
  try {
    if (fetcher) {
      homeHtml = await fetcher(home);
    } else {
      const { data } = await axios.get(home, {
        timeout: HOMEPAGE_FETCH_TIMEOUT_MS,
        maxContentLength: HOMEPAGE_FETCH_MAX_BYTES,
        maxBodyLength:    HOMEPAGE_FETCH_MAX_BYTES,
        responseType:     'text',
        transformResponse: [(d) => d],
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; QumakScanner/1.0; +https://qumak.io)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en,ar;q=0.9',
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      homeHtml = typeof data === 'string' ? data : '';
    }
  } catch (err) {
    meta.homepageError = err && err.message ? String(err.message).slice(0, 240) : 'unknown';
    return { ...fromPaste, _meta: meta };
  }

  if (!homeHtml) return { ...fromPaste, _meta: meta };

  const fromHome = await extractSocialHandles(homeHtml, null);
  meta.sources.homepage = hasAnyHandles(fromHome);

  // Homepage wins on conflict (canonical), but we keep both URL sets.
  const merged = mergeResults(fromPaste, fromHome);

  return { ...merged, _meta: meta };
}

function hasAnyHandles(result) {
  for (const platform of PLATFORMS) {
    if (result[platform] && result[platform].handles.length > 0) return true;
  }
  return false;
}

module.exports = {
  extractSocialHandles,
  extractSocialHandlesFromUrl,
  // exposed for tests
  isDeepLink,
  homepageOf,
  mergeResults,
  PLATFORMS,
};
