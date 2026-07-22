// services/resolver/steps/extractBrandAssets.js
const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { URL } = require('url');
const { ensureHttps } = require('../utils/normalizeDomain');
const { isSafeUrl } = require('../utils/ssrfGuard');
const logger = require('../../../utils/logger');

const MAX_IMAGE_DOWNLOAD_BYTES = 2 * 1024 * 1024;  // 2MB per image

/**
 * Collect the best brand visual assets from the page.
 * Prioritizes quality: SVG > high-res PNG > Apple touch > favicon.ico
 */
async function extractBrandAssets(html, finalUrl, metaSignals, screenshots = null) {
  const $ = cheerio.load(html);
  const base = new URL(finalUrl);
  
  // ── 1. Logo candidates (ordered by quality) ─────────────────
  const logoCandidates = [];
  
  // A. Apple touch icons (usually 180x180+, high quality)
  for (const icon of metaSignals.appleTouchIcons || []) {
    logoCandidates.push({
      url: resolveUrl(icon.href, base),
      source: 'apple_touch_icon',
      sizes: icon.sizes,
      priority: 10,
    });
  }
  
  // B. All favicons, sorted by size
  for (const fav of metaSignals.favicons || []) {
    logoCandidates.push({
      url: resolveUrl(fav.href, base),
      source: 'favicon',
      sizes: fav.sizes,
      priority: fav.score,
    });
  }
  
  // C. Schema.org Organization.logo (highest-confidence official logo)
  if (metaSignals.schemaOrg?.organization?.logo) {
    const logo = metaSignals.schemaOrg.organization.logo;
    const url = typeof logo === 'string' ? logo : logo.url || logo['@id'];
    if (url) {
      logoCandidates.unshift({  // Front of queue — best source
        url: resolveUrl(url, base),
        source: 'schema_org',
        priority: 100,
      });
    }
  }
  
  // D. Header <img> candidates (often contain logo)
  $('header img, nav img, .header img, .nav img, [class*="logo" i] img, [id*="logo" i] img, img[alt*="logo" i]')
    .each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      const srcset = $(el).attr('srcset');
      const alt = $(el).attr('alt') || '';
      
      if (src) {
        logoCandidates.push({
          url: resolveUrl(src, base),
          source: 'header_img',
          alt,
          priority: /logo/i.test(alt) ? 50 : 20,
        });
      }
      
      // Parse srcset for highest-res
      if (srcset) {
        const best = parseBestFromSrcset(srcset);
        if (best) {
          logoCandidates.push({
            url: resolveUrl(best, base),
            source: 'header_img_srcset',
            priority: /logo/i.test(alt) ? 55 : 25,
          });
        }
      }
    });
  
  // E. SVG inline — sometimes the whole logo is inline SVG
  const inlineSvgLogo = $('[class*="logo" i] svg, header svg').first();
  if (inlineSvgLogo.length) {
    // Wrap it up as a data URL
    const svgHtml = $.html(inlineSvgLogo);
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgHtml).toString('base64')}`;
    logoCandidates.push({
      url: dataUrl,
      source: 'inline_svg',
      priority: 80,
      inline: true,
    });
  }
  
  // Dedupe + sort
  const deduped = dedupeLogoCandidates(logoCandidates);
  
  // ── 2. OG Image (social share image, high quality) ──────────
  const ogImageUrl = metaSignals.og?.image || metaSignals.twitter?.image;
  
  // ── 3. Hero images (above-the-fold big images) ──────────────
  const heroImages = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src) return;
    
    const width = parseInt($(el).attr('width'), 10);
    const height = parseInt($(el).attr('height'), 10);
    
    // Filter: likely hero if width > 600px declared OR class contains "hero"
    const classes = ($(el).attr('class') || '').toLowerCase();
    const isHeroish = /hero|banner|splash|jumbotron/.test(classes)
      || (width > 600 && height > 300);
    
    if (isHeroish) {
      heroImages.push({
        url: resolveUrl(src, base),
        alt: $(el).attr('alt'),
        width,
        height,
      });
    }
  });
  
  // CSS background images (heroes often use background-image)
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style');
    const match = style?.match(/background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i);
    if (match) {
      heroImages.push({
        url: resolveUrl(match[1], base),
        source: 'css_background',
      });
    }
  });
  
  // ── 4. Download + analyze logos ─────────────────────────────
  const logoAnalysis = await tryDownloadAndAnalyzeLogo(deduped.slice(0, 3));
  
  // ── 5. Favicon hash (for brand match dedup) ─────────────────
  const faviconHash = await computeFaviconHash(deduped[0]?.url);
  
  return {
    favicon: deduped[0]?.url || null,
    faviconHash,
    logo: logoAnalysis?.url || deduped[0]?.url || null,
    logoHash: logoAnalysis?.hash || null,
    logoIsLightBg: logoAnalysis?.isLightBg,
    logoDimensions: logoAnalysis?.dimensions,
    ogImage: ogImageUrl ? resolveUrl(ogImageUrl, base) : null,
    heroImages: heroImages.slice(0, 10).map(h => h.url),
    screenshots: screenshots || null,
    logoCandidates: deduped.slice(0, 5),  // For debugging / manual override
  };
}

function resolveUrl(maybeRelative, base) {
  if (!maybeRelative) return null;
  if (maybeRelative.startsWith('data:')) return maybeRelative;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function parseBestFromSrcset(srcset) {
  // srcset format: "url1 1x, url2 2x" or "url1 480w, url2 800w"
  const candidates = srcset.split(',').map(s => {
    const parts = s.trim().split(/\s+/);
    const url = parts[0];
    const descriptor = parts[1] || '';
    let weight = 1;
    if (/(\d+)w/.test(descriptor)) weight = parseInt(RegExp.$1, 10);
    else if (/(\d+)x/.test(descriptor)) weight = parseInt(RegExp.$1, 10) * 100;
    return { url, weight };
  });
  
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]?.url;
}

function dedupeLogoCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  
  // Sort by priority descending
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
  
  for (const cand of sorted) {
    if (!cand.url || seen.has(cand.url)) continue;
    seen.add(cand.url);
    unique.push(cand);
  }
  
  return unique;
}

async function tryDownloadAndAnalyzeLogo(candidates) {
  for (const cand of candidates) {
    try {
      if (cand.inline) {
        // Skip inline SVGs for now — analyze differently
        continue;
      }
      
      const safe = await isSafeUrl(cand.url);
      if (!safe.safe) continue;
      
      const response = await axios.get(cand.url, {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxContentLength: MAX_IMAGE_DOWNLOAD_BYTES,
        validateStatus: s => s === 200,
      });
      
      const buffer = Buffer.from(response.data);
      
      // Use sharp to analyze
      const meta = await sharp(buffer).metadata();
      
      // Skip if tiny
      if ((meta.width || 0) < 16 || (meta.height || 0) < 16) continue;
      
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      
      // Determine if logo is on light or dark background
      // by sampling top-left corner pixel
      let isLightBg = null;
      try {
        const { data } = await sharp(buffer)
          .resize(4, 4)  // Tiny sample
          .raw()
          .toBuffer({ resolveWithObject: true });
        const r = data[0], g = data[1], b = data[2];
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        isLightBg = brightness > 127;
      } catch {
        // sharp might fail on SVG/ICO
      }
      
      return {
        url: cand.url,
        source: cand.source,
        hash,
        dimensions: { width: meta.width, height: meta.height, format: meta.format },
        isLightBg,
      };
    } catch (err) {
      logger.debug({ err: err.code, url: cand.url }, 'logo download failed');
      continue;
    }
  }
  
  return null;
}

async function computeFaviconHash(url) {
  if (!url || url.startsWith('data:')) return null;
  try {
    const safe = await isSafeUrl(url);
    if (!safe.safe) return null;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      maxContentLength: 500 * 1024,
    });
    return crypto.createHash('sha256').update(Buffer.from(response.data)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

module.exports = { extractBrandAssets };