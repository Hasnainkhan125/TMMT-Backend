// services/resolver/steps/extractColorPalette.js
const { Vibrant } = require('node-vibrant/node');
const sharp = require('sharp');
const axios = require('axios');
const cheerio = require('cheerio');
const { isSafeUrl } = require('../utils/ssrfGuard');
const logger = require('../../../utils/logger');




// WordPress Gutenberg default palette — these are NOT brand colors,
// they're the out-of-the-box theme colors. Filter them out when we detect them.
const WP_DEFAULT_PALETTE = new Set([
    '#000000', '#abb8c3', '#ffffff', '#f78da7', '#cf2e2e',
    '#ff6900', '#fcb900', '#7bdcb5', '#8ed1fc', '#0693e3', '#9b51e0'
  ]);
  
  function isWordPressDefaultPalette(palette) {
    if (palette.length < 5) return false;
    const matches = palette.filter(c => WP_DEFAULT_PALETTE.has(c.hex.toLowerCase())).length;
    return matches >= 4;  // 4+ defaults = it's the boilerplate
  }
/**
 * Assemble the brand palette from 4 sources, ranked by reliability:
 * 1. theme-color meta tag (brand-declared)
 * 2. CSS custom properties (--brand-primary, etc.)
 * 3. Inline/computed styles of header/buttons
 * 4. Vibrant.js extraction from logo/hero images
 * 
 * Returns a deduped palette with role labels.
 */
async function extractColorPalette(html, brandAssets, metaSignals,businessType) {
  const $ = cheerio.load(html);
  
  const palette = [];
  const seen = new Set();
  
  // ─── Source 1: Meta theme-color (highest confidence) ──────
  const themeColor = metaSignals.seo?.themeColor;
  if (themeColor && isValidHex(themeColor)) {
    pushColor(palette, seen, {
      hex: normalizeHex(themeColor),
      role: 'primary',
      source: 'theme-color',
      coverage: 0.9,
    });
  }
  
  const msTile = metaSignals.seo?.msApplicationColor;
  if (msTile && isValidHex(msTile) && msTile !== themeColor) {
    pushColor(palette, seen, {
      hex: normalizeHex(msTile),
      role: 'accent',
      source: 'mstile-color',
      coverage: 0.5,
    });
  }
  

  const isCreativeBusinessType = ['marketing_agency', 'creative_agency', 'events_wedding']
  .includes(businessType);

// If this is a creative business OR logo extraction yielded nothing,
// prioritize hero images early (not just as fallback)
if (isCreativeBusinessType && brandAssets?.heroImages?.length > 0) {
  logger.info('Creative business — prioritizing hero image palette');
  
  // Sample top 3 hero images, extract colors, weight by image order
  for (let i = 0; i < Math.min(3, brandAssets?.heroImages?.length); i++) {
    try {
      const heroColors = await extractVibrantColors(brandAssets?.heroImages[i]);
      const weight = 1 - (i * 0.2);  // 1.0, 0.8, 0.6
      for (const { hex, role, population } of heroColors) {
        pushColor(palette, seen, {
          hex: normalizeHex(hex),
          role: i === 0 ? role : 'secondary',
          source: `vibrant:hero_${i}`,
          coverage: population * weight,
        });
      }
    } catch (err) {
      logger.debug({ err: err.message, hero: i }, 'hero extraction failed');
    }
  }
}
  // ─── Source 2: CSS custom properties from inline styles ───
//   const cssVars = extractCssVariables(html);
//   for (const { name, value } of cssVars) {
//     if (!isValidHex(value)) continue;
//     const role = inferRoleFromVarName(name);
//     pushColor(palette, seen, {
//       hex: normalizeHex(value),
//       role,
//       source: `css-var:${name}`,
//       coverage: 0.7,
//     });
//   }
function extractCssVariables(html) {
    const vars = new Map();  // Dedupe by name
    
    // Strategy: scan the whole HTML for any `--foo: value;` pattern
    // inside ANY CSS block (not just :root). WordPress scatters them.
    
    // Find all <style> blocks AND inline styles
    const styleBlocks = [];
    
    // <style>...</style> blocks
    const styleTagMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    for (const m of styleTagMatches) {
      styleBlocks.push(m[1]);
    }
    
    // style="..." inline attributes
    const inlineStyleMatches = html.matchAll(/style=["']([^"']+)["']/gi);
    for (const m of inlineStyleMatches) {
      styleBlocks.push(m[1]);
    }
    
    // Scan every block for --var: value pairs
    for (const block of styleBlocks) {
      const varMatches = block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}\n]+)/gi);
      for (const m of varMatches) {
        const name = m[1].toLowerCase().trim();
        const value = m[2].trim().replace(/[!important\s]+$/i, '').trim();
        
        if (!looksLikeColor(name, value)) continue;
        
        // Dedupe by name — first occurrence wins
        if (!vars.has(name)) {
          vars.set(name, { name, value });
        }
      }
    }
    
    return Array.from(vars.values());
  }
  
  function looksLikeColor(name, value) {
    // Exclude obvious non-colors by NAME
    const NON_COLOR_NAMES = /(?:font|weight|size|family|line-height|spacing|radius|width|height|duration|easing|z-index|opacity|scale|gap|padding|margin|border-width)/i;
    if (NON_COLOR_NAMES.test(name)) return false;
    
    // Strip wrappers like "var(...)" — we can't resolve those here
    if (/^var\(/i.test(value)) return false;
    
    // Value must be a recognizable color format
    const isColorValue = 
         isValidHex(value)
      || /^rgba?\(/i.test(value)
      || /^hsla?\(/i.test(value)
      || /^oklch\(/i.test(value)
      || /^oklab\(/i.test(value)
      || /^color\(/i.test(value);
    
    if (!isColorValue) return false;
    
    // Prefer names that sound like colors; otherwise accept if hex
    const COLOR_NAMES = /(?:color|fill|stroke|background|bg|border|shadow|primary|secondary|accent|brand|tint|hue|palette|theme|preset)/i;
    return COLOR_NAMES.test(name) || isValidHex(value);
  }
  

  // ─── Source 3: Inline background-color / color styles ─────
  // Scan for the most common colors used in buttons/header/CTAs
  const styleColors = extractInlineStyleColors($);
  for (const { hex, count, context } of styleColors.slice(0, 10)) {
    pushColor(palette, seen, {
      hex: normalizeHex(hex),
      role: inferRoleFromContext(context),
      source: `inline-style:${context}`,
      coverage: Math.min(count / 20, 0.6),
    });
  }
  
  // ─── Source 4: Vibrant extraction from logo ───────────────
  if (brandAssets.logo && !brandAssets.logo.startsWith('data:')) {
    try {
      const vibrantColors = await extractVibrantColors(brandAssets.logo);
      
      if (vibrantColors.length > 0) {
        logger.info({ 
          logo: brandAssets.logo, 
          colorCount: vibrantColors.length,
          colors: vibrantColors.map(c => c.hex),
        }, 'Vibrant logo extraction succeeded');
      }
      
      for (const { hex, role, population } of vibrantColors) {
        pushColor(palette, seen, {
          hex: normalizeHex(hex),
          role,
          source: 'vibrant:logo',
          coverage: population,
        });
      }
    } catch (err) {
      logger.warn({ 
        err: err.message, 
        logo: brandAssets.logo 
      }, 'Vibrant logo extraction failed');
    }
  }
  
  // ─── Source 5: Vibrant from OG image (fallback) ───────────
  if (palette.length < 3 && brandAssets.ogImage) {
    try {
      const vibrantColors = await extractVibrantColors(brandAssets.ogImage);
      for (const { hex, role, population } of vibrantColors) {
        pushColor(palette, seen, {
          hex: normalizeHex(hex),
          role: role === 'primary' ? 'secondary' : role,  // Don't override primary
          source: 'vibrant:og',
          coverage: population * 0.7,
        });
      }
    } catch (err) {
      logger.debug({ err: err.code }, 'vibrant og extraction failed');
    }
  }
  
   // ─── Compute per-color brightness/saturation ──────────────
   let enriched = palette.map(c => {
    const { r, g, b } = hexToRgb(c.hex);
    return {
      ...c,
      brightness: (r * 299 + g * 587 + b * 114) / 1000,
      saturation: rgbToHsl(r, g, b).s,
    };
  });
    
  
   // ─── NOW pick primary/accent/background from enriched ─────
   const colorful = enriched.filter(c => {
    const isNeutral = c.saturation < 0.1;
    const isExtreme = c.brightness < 10 || c.brightness > 250;
    return !isNeutral && !isExtreme;
  });
  
  // If no colorful (all fallbacks are neutral), use enriched directly
  const pickPool = colorful.length > 0 ? colorful : enriched;
  
  const primaryCandidate = 
       enriched.find(c => c.role === 'primary' && c.saturation > 0.3)
    || enriched.find(c => c.role === 'primary')
    || pickPool.sort((a, b) => {
         const scoreA = (a.coverage || 0) * 0.6 + (a.saturation || 0) * 0.4;
         const scoreB = (b.coverage || 0) * 0.6 + (b.saturation || 0) * 0.4;
         return scoreB - scoreA;
       })[0]
    || enriched[0];
  
  const accentCandidate = 
       enriched.find(c => c.role === 'accent' && c.hex !== primaryCandidate?.hex)
    || pickPool.find(c => 
         c.hex !== primaryCandidate?.hex 
         && colorDistance(c.hex, primaryCandidate?.hex) > 60
       )
    || pickPool[1]
    || enriched[1];
  
  const bgCandidate = 
       enriched.find(c => c.role === 'background')
    || enriched.find(c => c.brightness > 240)
    || enriched.find(c => c.brightness < 20)
    || enriched[enriched.length - 1];
  

    // If we only found WP defaults, demote them so Vibrant/logo takes priority
const isWpDefault = isWordPressDefaultPalette(palette);
if (isWpDefault) {
  logger.debug('WordPress default Gutenberg palette detected — downweighting');
  palette.forEach(c => {
    if (WP_DEFAULT_PALETTE.has(c.hex.toLowerCase())) {
      c.coverage = 0.05;  // Basically ignore for primary selection
      c.source = 'wp-default:' + c.source;
    }
  });
}


if (enriched.length === 0 && brandAssets.heroImages?.length > 0) {
    logger.warn('No palette from primary sources — falling back to hero image');
    try {
      const heroColors = await extractVibrantColors(brandAssets.heroImages[0]);
      for (const { hex, role, population } of heroColors) {
        const normalized = normalizeHex(hex);
        if (seen.has(normalized.toLowerCase())) continue;
        seen.add(normalized.toLowerCase());
        const { r, g, b } = hexToRgb(normalized);
        enriched.push({
          hex: normalized,
          role,
          source: 'vibrant:hero_fallback',
          coverage: population,
          brightness: (r * 299 + g * 587 + b * 114) / 1000,
          saturation: rgbToHsl(r, g, b).s,
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Hero image fallback failed');
    }
  }
  
  // Fallback 2: try OG image if still empty
  if (enriched.length === 0 && brandAssets.ogImage) {
    logger.warn('Hero fallback failed — trying OG image');
    try {
      const ogColors = await extractVibrantColors(brandAssets.ogImage);
      for (const { hex, role, population } of ogColors) {
        const normalized = normalizeHex(hex);
        if (seen.has(normalized.toLowerCase())) continue;
        seen.add(normalized.toLowerCase());
        const { r, g, b } = hexToRgb(normalized);
        enriched.push({
          hex: normalized,
          role,
          source: 'vibrant:og_fallback',
          coverage: population,
          brightness: (r * 299 + g * 587 + b * 114) / 1000,
          saturation: rgbToHsl(r, g, b).s,
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'OG fallback failed');
    }
  }
  
  // Fallback 3: neutral defaults (absolute last resort)
  if (enriched.length === 0) {
    logger.warn('All extraction methods failed — using neutral defaults');
    enriched.push(
      { hex: '#1a1a1a', role: 'primary',    brightness: 26,  saturation: 0, coverage: 0.5, source: 'default_fallback' },
      { hex: '#f5f5f5', role: 'background', brightness: 245, saturation: 0, coverage: 0.5, source: 'default_fallback' },
      { hex: '#666666', role: 'neutral',    brightness: 102, saturation: 0, coverage: 0.5, source: 'default_fallback' },
    );
  }
  



  return {
    palette: enriched.slice(0, 8),
    primary:    primaryCandidate?.hex || '#1a1a1a',
    accent:     accentCandidate?.hex  || '#666666',
    background: bgCandidate?.hex      || '#f5f5f5',
    cssVariables: {
      '--brand-primary': primaryCandidate?.hex || '#1a1a1a',
      '--brand-accent':  accentCandidate?.hex  || '#666666',
      '--brand-bg':      bgCandidate?.hex      || '#f5f5f5',
    },
  };
}

// ── Helpers ────────────────────────────────────────────────

function isValidHex(s) {
  return typeof s === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.trim());
}

function normalizeHex(s) {
  s = s.trim().toLowerCase();
  if (!s.startsWith('#')) s = '#' + s;
  // Expand shorthand
  if (s.length === 4) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  // Strip alpha
  if (s.length === 9) s = s.slice(0, 7);
  return s;
}

function pushColor(palette, seen, color) {
  const key = color.hex.toLowerCase();
  if (seen.has(key)) {
    // Boost coverage if same color found again
    const existing = palette.find(c => c.hex.toLowerCase() === key);
    if (existing) existing.coverage = Math.min(existing.coverage + 0.1, 1);
    return;
  }
  seen.add(key);
  palette.push(color);
}

function extractCssVariables(html) {
  // Match `:root { --foo: #123; --bar: #456 }`
  const vars = [];
  const rootBlocks = html.match(/:root\s*\{([^}]+)\}/g) || [];
  for (const block of rootBlocks) {
    const matches = block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi);
    for (const m of matches) {
      vars.push({ name: m[1].toLowerCase(), value: m[2].trim() });
    }
  }
  return vars;
}

function inferRoleFromVarName(name) {
  if (/primary|brand|main/.test(name)) return 'primary';
  if (/accent|secondary|highlight/.test(name)) return 'accent';
  if (/bg|background|surface/.test(name)) return 'background';
  if (/text|foreground|fg/.test(name)) return 'neutral';
  return 'other';
}

function extractInlineStyleColors($) {
  const colorCounts = new Map();
  
  const noteColor = (hex, context) => {
    if (!isValidHex(hex)) return;
    const normalized = normalizeHex(hex);
    // Skip pure white/black/gray
    if (['#ffffff', '#000000'].includes(normalized)) return;
    const entry = colorCounts.get(normalized) || { count: 0, contexts: new Set() };
    entry.count++;
    entry.contexts.add(context);
    colorCounts.set(normalized, entry);
  };
  
  // Parse inline styles
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    const tag = el.name?.toLowerCase();
    const cls = ($(el).attr('class') || '').toLowerCase();
    
    const context = inferContextFromElement(tag, cls);
    
    // Match all hex colors
    const colors = style.match(/#[0-9a-f]{3,8}/gi) || [];
    for (const c of colors) {
      noteColor(c, context);
    }
  });
  
  return Array.from(colorCounts.entries())
    .map(([hex, { count, contexts }]) => ({ 
      hex, 
      count, 
      context: Array.from(contexts)[0] || 'generic' 
    }))
    .sort((a, b) => b.count - a.count);
}

function inferContextFromElement(tag, cls) {
  if (/button|btn|cta/.test(cls)) return 'button';
  if (/header|nav/.test(cls) || tag === 'header' || tag === 'nav') return 'header';
  if (/hero|banner/.test(cls)) return 'hero';
  if (/footer/.test(cls) || tag === 'footer') return 'footer';
  return 'generic';
}

function inferRoleFromContext(context) {
  if (context === 'button') return 'primary';
  if (context === 'hero' || context === 'header') return 'primary';
  return 'other';
}

async function extractVibrantColors(imageUrl) {
    const safe = await isSafeUrl(imageUrl);
    if (!safe.safe) throw new Error('URL blocked by SSRF guard');
    
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: 3 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrandResolver/1.0)' },
    });
    
    const buffer = Buffer.from(response.data);
    
    // ALWAYS pre-process through Sharp into a clean PNG.
    // Reasons:
    //   1. Vibrant rejects WebP, AVIF, HEIC — Sharp reads them all
    //   2. Vibrant gets confused by alpha channels on transparent logos —
    //      flatten onto white gives it real pixels to quantize
    //   3. Resizing to 256px speeds things up ~10x and produces better
    //      palettes (less photographic noise, more structural color)
    
    let pngBuffer;
    try {
      pngBuffer = await sharp(buffer)
        .flatten({ background: { r: 255, g: 255, b: 255 } })   // composite transparent over white
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .png({ quality: 90 })
        .toBuffer();
    } catch (sharpErr) {
      throw new Error(`Sharp preprocessing failed: ${sharpErr.message}`);
    }
    
    // Now hand Vibrant a clean PNG buffer
    const v = Vibrant.from(pngBuffer);
    const swatches = await v.getPalette();
    
    const ROLES = {
      Vibrant:      'primary',
      DarkVibrant:  'accent',
      LightVibrant: 'secondary',
      Muted:        'neutral',
      DarkMuted:    'neutral',
      LightMuted:   'background',
    };
    
    const result = [];
    for (const [name, swatch] of Object.entries(swatches)) {
      if (!swatch) continue;
      result.push({
        hex: swatch.hex,
        role: ROLES[name] || 'other',
        population: Math.min(swatch.population / 1000, 1),
      });
    }
    
    // If Sharp preprocessing produced a pure-white image (transparent logo
    // with no visible pixels), Vibrant returns empty. Detect that and throw
    // so the fallback chain continues.
    if (result.length === 0) {
      throw new Error('Vibrant returned empty palette — likely transparent image');
    }
    
    return result;
  }

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  }
  return { s };
}


function colorDistance(hexA, hexB) {
    if (!hexA || !hexB) return 0;
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
  }

module.exports = { extractColorPalette };