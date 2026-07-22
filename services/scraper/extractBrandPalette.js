'use strict';

/**
 * extractBrandPalette — extracts a brand's primary colors from rendered HTML + CSS.
 *
 * Why: the previous palette extraction took colors from the logo image only,
 * which produced wildly inaccurate results when the logo had off-brand pixels
 * (background, borders, decorative elements). Meanwhile the CSS — which is
 * literally the source-of-truth for the brand's color decisions — was being
 * ignored.
 *
 * Strategy:
 *   1. Walk every <style> tag, every linked stylesheet that's been inlined,
 *      every inline style="..." attribute, every Tailwind class, every CSS var.
 *   2. Extract every hex / rgb / hsl color reference.
 *   3. Score each color by:
 *        - frequency (how many times it appears across CSS)
 *        - prominence (was it on a button/CTA/header? boost)
 *        - position (CSS variables / :root definitions get extra weight —
 *          they're explicit brand decisions)
 *        - palette role (background vs text vs accent — we score each)
 *   4. Filter out neutrals (#fff, #000, near-grays) unless we have nothing else.
 *   5. Cluster perceptually-similar colors so #228B22 and #1F8B1F both vote
 *      for "the green primary."
 *   6. Return ranked palette with role hints.
 *
 * The Malabar HTML you pasted contains:
 *   - #228B22 in 14 places (border, button bg, hover, link color)
 *   - #196F19 in 4 places (button:hover)
 *   - Instagram gradient: #f09433, #e6683c, #dc2743, #cc2366, #bc1888
 *   - #1877F2 (Facebook brand)
 *   - #FF0000 (YouTube brand)
 *
 * Correct extraction should rank #228B22 as #1 brand color (green primary),
 * #196F19 as the secondary/hover, and exclude social-network brand colors
 * because they're third-party brand colors not the user's.
 */

// ---------- Color parsing ----------

const HEX_PATTERN = /#([0-9a-fA-F]{3,8})\b/g;
const RGB_PATTERN = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/gi;
const HSL_PATTERN = /hsla?\(\s*(\d+)(?:deg)?\s*,?\s*(\d+(?:\.\d+)?)%\s*,?\s*(\d+(?:\.\d+)?)%(?:\s*,\s*([\d.]+))?\s*\)/gi;

// Third-party social brand colors we want to exclude unless they appear
// outside of social-icon context (rare, but possible if user IS a social brand).
const SOCIAL_BRAND_COLORS = new Set([
  '#1877f2', // Facebook
  '#1da1f2', // Twitter (legacy)
  '#0a66c2', // LinkedIn
  '#ff0000', // YouTube
  '#25d366', // WhatsApp
  '#37aa66', // WhatsApp variant
  '#1e88e5', // Generic blue link
  '#000000', // X / TikTok (also common neutral)
  '#f09433', // Instagram gradient
  '#e6683c',
  '#dc2743',
  '#cc2366',
  '#bc1888',
  '#49e670', // Chaty whatsapp
  '#03e78b', // Chaty phone
  '#86cd91',
]);

function expandShortHex(hex) {
  // #abc -> #aabbcc, #abcd -> #aabbccdd
  if (hex.length === 3) {
    return hex.split('').map((c) => c + c).join('');
  }
  if (hex.length === 4) {
    return hex.split('').map((c) => c + c).join('');
  }
  return hex;
}

function hexToRgb(hex) {
  const cleaned = expandShortHex(hex.replace('#', '').toLowerCase());
  if (cleaned.length < 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(255 * f(0)),
    g: Math.round(255 * f(8)),
    b: Math.round(255 * f(4)),
  };
}

// Relative luminance per WCAG formula
function luminance({ r, g, b }) {
  const linearize = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

// HSL saturation (for filtering grays)
function saturation({ r, g, b }) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

// Perceptual distance between two colors (simplified Lab-like)
function colorDistance(a, b) {
  return Math.sqrt(
    Math.pow(a.r - b.r, 2) +
    Math.pow(a.g - b.g, 2) +
    Math.pow(a.b - b.b, 2)
  );
}

// ---------- Filters ----------

function isNeutral(rgb) {
  // Pure white / pure black / very low saturation = neutral
  const lum = luminance(rgb);
  if (lum > 0.95 || lum < 0.02) return true;
  if (saturation(rgb) < 0.08) return true;
  return false;
}

function isSocialBrandColor(hex) {
  return SOCIAL_BRAND_COLORS.has(hex.toLowerCase());
}

// ---------- Context scoring ----------

// Boost colors found in CTA / button / brand-relevant CSS rules
const HIGH_VALUE_SELECTORS_RX = new RegExp(
  [
    '\\.btn(\\s|:|,|\\.|\\[)',
    'button',
    '\\.cta',
    '--brand',
    '--primary',
    '--accent',
    'theme-color',
    '\\.logo',
    '\\.header',
    'nav',
    '\\.menu',
    '\\.appointment',
    '\\.book',
    'submit',
    'primary',
  ].join('|'),
  'i'
);

// Penalize colors that only appear in noisy contexts
const LOW_VALUE_SELECTORS_RX = new RegExp(
  [
    '\\.shadow',
    'rgba?\\([^)]*0\\.0?\\d',  // very transparent
    'border-color',
    'placeholder',
  ].join('|'),
  'i'
);

// ---------- CSS extraction ----------

/**
 * Extract every CSS color reference along with its surrounding context (the
 * CSS rule it belongs to, roughly).
 *
 * We're not parsing CSS strictly — that's too brittle. We split on { and ; and
 * scan each chunk for color references, attaching the chunk as context.
 */
function extractColorReferences(cssText) {
  if (!cssText) return [];
  const refs = [];

  // Split on rule boundaries. Each chunk is roughly: "selector { property: value;"
  // or "property: value;" in nested contexts.
  const chunks = cssText.split(/[{};]/);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Context = current chunk + previous chunk (selector lives in prev)
    const context = (chunks[i - 1] || '') + ' ' + chunk;

    // Hex
    let m;
    HEX_PATTERN.lastIndex = 0;
    while ((m = HEX_PATTERN.exec(chunk)) !== null) {
      const hex = m[0].toLowerCase();
      const expanded = expandShortHex(hex.slice(1));
      if (expanded.length < 6) continue;
      const rgb = hexToRgb(hex);
      if (!rgb) continue;
      refs.push({
        hex: `#${expanded.slice(0, 6)}`,
        rgb,
        context,
      });
      if (m.index === HEX_PATTERN.lastIndex) HEX_PATTERN.lastIndex++;
    }

    // RGB
    RGB_PATTERN.lastIndex = 0;
    while ((m = RGB_PATTERN.exec(chunk)) !== null) {
      const r = parseInt(m[1], 10);
      const g = parseInt(m[2], 10);
      const b = parseInt(m[3], 10);
      const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (a < 0.5) continue; // skip very transparent
      const rgb = { r, g, b };
      refs.push({
        hex: rgbToHex(rgb),
        rgb,
        context,
      });
      if (m.index === RGB_PATTERN.lastIndex) RGB_PATTERN.lastIndex++;
    }

    // HSL
    HSL_PATTERN.lastIndex = 0;
    while ((m = HSL_PATTERN.exec(chunk)) !== null) {
      const h = parseInt(m[1], 10);
      const s = parseFloat(m[2]);
      const l = parseFloat(m[3]);
      const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (a < 0.5) continue;
      const rgb = hslToRgb(h, s, l);
      refs.push({
        hex: rgbToHex(rgb),
        rgb,
        context,
      });
      if (m.index === HSL_PATTERN.lastIndex) HSL_PATTERN.lastIndex++;
    }
  }

  return refs;
}

// Walk an HTML document, pull every CSS-bearing region into one big string
function harvestCssText(html) {
  if (!html) return '';
  const sources = [];

  // <style>...</style> blocks
  const styleBlocks = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styleBlocks) {
    sources.push(block.replace(/^<style[^>]*>|<\/style>$/gi, ''));
  }

  // style="..." attributes
  const inlineStyles = html.match(/\bstyle\s*=\s*["']([^"']+)["']/gi) || [];
  for (const inline of inlineStyles) {
    sources.push(inline);
  }

  // <meta name="theme-color" content="#xxx">
  const themeColors = html.match(/<meta[^>]*theme-color[^>]*content=["']([^"']+)["']/gi) || [];
  for (const meta of themeColors) {
    sources.push(meta);
  }

  // Tailwind / utility classes that encode colors. We treat class names like
  // "bg-emerald-600" or "text-[#228b22]" as evidence.
  const arbitraryClasses = html.match(/\[#([0-9a-fA-F]{3,8})\]/g) || [];
  for (const cls of arbitraryClasses) {
    sources.push(cls.replace(/[\[\]]/g, ''));
  }

  return sources.join('\n');
}

// ---------- Clustering ----------

/**
 * Merge perceptually-similar colors into clusters. Each cluster votes with
 * the sum of its members' weights and is represented by its highest-weight
 * member.
 *
 * Threshold: ~24 in RGB Euclidean distance ≈ "looks like the same color
 * to a human at a glance."
 */
function clusterColors(weightedColors, threshold = 24) {
  const clusters = [];

  for (const c of weightedColors) {
    let assigned = false;
    for (const cluster of clusters) {
      if (colorDistance(c.rgb, cluster.representative.rgb) <= threshold) {
        cluster.totalWeight += c.weight;
        cluster.members.push(c);
        if (c.weight > cluster.representative.weight) {
          cluster.representative = c;
        }
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        representative: c,
        totalWeight: c.weight,
        members: [c],
      });
    }
  }

  return clusters.sort((a, b) => b.totalWeight - a.totalWeight);
}

// ---------- Role classification ----------

function classifyRole(rgb) {
  const lum = luminance(rgb);
  const sat = saturation(rgb);

  if (lum > 0.85) return 'background';
  if (lum < 0.15) return 'text_or_dark';
  if (sat > 0.5 && lum > 0.3 && lum < 0.65) return 'primary';
  if (sat > 0.3) return 'accent';
  return 'neutral';
}

// ---------- Main entrypoint ----------

/**
 * Extract a brand palette from raw HTML.
 *
 * @param {object} opts
 * @param {string} opts.html - rendered HTML (concatenated multi-page is fine)
 * @param {number} [opts.maxColors] - max colors in returned palette (default 5)
 * @returns {{
 *   palette: Array<{hex, role, weight, sources}>,
 *   primary: string|null,
 *   secondary: string|null,
 *   accent: string|null,
 *   raw: { totalReferences, uniqueColors, clusters }
 * }}
 */
function extractBrandPalette({ html, maxColors = 5 } = {}) {
  const cssText = harvestCssText(html);
  if (!cssText) {
    return emptyResult();
  }

  const refs = extractColorReferences(cssText);
  if (refs.length === 0) {
    return emptyResult();
  }

  // Score each reference
  const weightedRefs = [];
  for (const ref of refs) {
    if (isNeutral(ref.rgb)) continue;
    if (isSocialBrandColor(ref.hex)) continue;

    let weight = 1;
    if (HIGH_VALUE_SELECTORS_RX.test(ref.context)) weight += 4;
    if (LOW_VALUE_SELECTORS_RX.test(ref.context)) weight -= 0.5;

    // CSS variable definitions are explicit brand decisions
    if (/--[a-z-]*(?:brand|primary|accent|color)/i.test(ref.context)) weight += 6;

    if (weight <= 0) continue;

    weightedRefs.push({
      hex: ref.hex,
      rgb: ref.rgb,
      weight,
      context: ref.context.slice(0, 200),
    });
  }

  if (weightedRefs.length === 0) {
    // Last resort: use neutrals if absolutely nothing else
    for (const ref of refs) {
      if (!isSocialBrandColor(ref.hex)) {
        weightedRefs.push({ hex: ref.hex, rgb: ref.rgb, weight: 1, context: '' });
      }
    }
  }

  const clusters = clusterColors(weightedRefs);

  const palette = clusters.slice(0, maxColors).map((cluster) => ({
    hex: cluster.representative.hex,
    rgb: cluster.representative.rgb,
    role: classifyRole(cluster.representative.rgb),
    weight: Math.round(cluster.totalWeight),
    sourceCount: cluster.members.length,
  }));

  const primary = palette.find((p) => p.role === 'primary')?.hex
    || palette[0]?.hex
    || null;
  const secondary = palette.find((p) => p.hex !== primary && (p.role === 'primary' || p.role === 'accent'))?.hex
    || palette[1]?.hex
    || null;
  const accent = palette.find((p) => p.role === 'accent' && p.hex !== primary && p.hex !== secondary)?.hex
    || palette[2]?.hex
    || null;

  return {
    palette,
    primary,
    secondary,
    accent,
    raw: {
      totalReferences: refs.length,
      uniqueColors: new Set(refs.map((r) => r.hex)).size,
      clusterCount: clusters.length,
    },
  };
}

function emptyResult() {
  return {
    palette: [],
    primary: null,
    secondary: null,
    accent: null,
    raw: { totalReferences: 0, uniqueColors: 0, clusterCount: 0 },
  };
}

module.exports = {
  extractBrandPalette,
  _internal: {
    extractColorReferences,
    harvestCssText,
    clusterColors,
    classifyRole,
    isNeutral,
    isSocialBrandColor,
    hexToRgb,
    rgbToHex,
    colorDistance,
  },
};
