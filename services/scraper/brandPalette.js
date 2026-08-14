'use strict';

/**
 * brandPalette — extract dominant colors from brand imagery.
 *
 * Uses node-vibrant to quantize images into swatches. Supports:
 * - Multi-image merge (OG + hero shots) so palettes reflect the page, not only the logo.
 * - meta theme-color as tie-breaker / last-resort palette when imagery fails.
 * - Correct per-swatch coverage vs total quantized population (not vs Vibrant-only).
 *
 * npm install node-vibrant sharp
 */

// v4: use Node build so `Vibrant.from(buffer)` works server-side. The
// `node-vibrant/browser` entry is for DOM Image/canvas and breaks in Node.
const { Vibrant } = require('node-vibrant/node');
const sharp = require('sharp');

const FETCH_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB cap

const VIBRANT_SWATCH_KEYS = [
  'Vibrant',
  'DarkVibrant',
  'LightVibrant',
  'Muted',
  'DarkMuted',
  'LightMuted',
];

// ─── Color math helpers ──────────────────────────────────────────────

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function brightness({ r, g, b }) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function saturation({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function suggestRole({ rgb, coverage }) {
  const sat = saturation(rgb);
  const bright = brightness(rgb);

  if (bright > 240 || bright < 20) return 'background';
  if (sat < 0.15) return coverage > 0.3 ? 'background' : 'neutral';
  if (sat > 0.5) return coverage > 0.2 ? 'primary' : 'accent';
  return 'secondary';
}

/** Accept #RGB, #RRGGBB, or bare RRGGBB from meta theme-color */
function normalizeThemeColorHex(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!s.startsWith('#')) {
    if (/^[0-9a-fA-F]{6}$/.test(s)) s = `#${s}`;
    else return null;
  }
  if (s.length === 4) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  if (s.length === 7 && /^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return null;
}

function totalVibrantPopulation(palette) {
  let t = 0;
  for (const key of VIBRANT_SWATCH_KEYS) {
    const sw = palette[key];
    if (sw && typeof sw.getPopulation === 'function') {
      t += sw.getPopulation() || 0;
    }
  }
  return t > 0 ? t : 1;
}

/**
 * Build ranked swatches from a Vibrant palette object (coverage = share of total pop).
 */
function swatchesFromVibrantPalette(palette, sourceImageUrl) {
  const totalPop = totalVibrantPopulation(palette);
  const rows = [];

  for (const name of VIBRANT_SWATCH_KEYS) {
    const swatch = palette[name];
    if (!swatch || !swatch._rgb) continue;
    const rgb = { r: swatch._rgb[0], g: swatch._rgb[1], b: swatch._rgb[2] };
    const pop = typeof swatch.getPopulation === 'function' ? swatch.getPopulation() || 0 : 0;
    const coverage = Math.min(1, pop / totalPop);
    rows.push({
      hex: rgbToHex(rgb),
      rgb,
      role: suggestRole({ rgb, coverage }),
      brightness: brightness(rgb),
      saturation: saturation(rgb),
      coverage,
      source: name,
      sourceImageUrl: sourceImageUrl || null,
    });
  }

  rows.sort((a, b) => b.coverage - a.coverage);
  return rows;
}

/**
 * Merge swatches from several images: prefer strong brand hues, drop near-duplicates.
 */
function mergeSwatchesFromImages(allRows, { dedupeMinDistance = 34, maxBeforeTrim = 14 } = {}) {
  const score = (s) => s.saturation * 0.55 + (s.coverage || 0) * 0.35 + (s.brightness > 25 && s.brightness < 235 ? 0.1 : 0);
  const sorted = [...allRows].sort((a, b) => score(b) - score(a));
  const out = [];
  for (const s of sorted) {
    if (out.some((o) => colorDistance(o.rgb, s.rgb) < dedupeMinDistance)) continue;
    out.push(s);
    if (out.length >= maxBeforeTrim) break;
  }
  return out;
}

function injectThemeColor(swatches, themeColor) {
  const hex = normalizeThemeColorHex(themeColor);
  if (!hex) return swatches;
  const themeRgb = hexToRgb(hex);
  const tooClose = swatches.some((s) => colorDistance(s.rgb, themeRgb) < 40);
  if (tooClose) return swatches;
  const themeRow = {
    hex,
    rgb: themeRgb,
    role: 'primary',
    brightness: brightness(themeRgb),
    saturation: saturation(themeRgb),
    coverage: 0.35,
    source: 'theme-color',
    sourceImageUrl: null,
  };
  return [themeRow, ...swatches];
}

function buildPaletteReturn(topFive, sourceImageUrls) {
  const primary =
    topFive.find((s) => s.role === 'primary')?.hex ||
    topFive.find((s) => s.saturation > 0.35)?.hex ||
    topFive[0]?.hex;
  const accent =
    topFive.find((s) => s.role === 'accent')?.hex ||
    topFive.filter((s) => s.hex !== primary)[0]?.hex ||
    null;
  const background =
    topFive.find((s) => s.role === 'background')?.hex ||
    topFive.find((s) => s.brightness > 235 || s.saturation < 0.12)?.hex ||
    null;

  return {
    sourceImageUrl: sourceImageUrls[0] || null,
    sourceImageUrls: [...new Set(sourceImageUrls.filter(Boolean))],
    primary,
    accent,
    background,
    swatches: topFive.map(({ sourceImageUrl: _u, ...rest }) => rest),
    mergedFromImages: sourceImageUrls.filter(Boolean).length > 1,
    cssVariables: {
      '--brand-primary': topFive[0]?.hex,
      '--brand-accent': topFive[1]?.hex || accent,
      '--brand-muted': topFive.find((s) => s.saturation < 0.2)?.hex,
    },
  };
}

function paletteFromThemeOnly(themeColor) {
  const hex = normalizeThemeColorHex(themeColor);
  if (!hex) return null;
  const rgb = hexToRgb(hex);
  const row = {
    hex,
    rgb,
    role: 'primary',
    brightness: brightness(rgb),
    saturation: saturation(rgb),
    coverage: 1,
    source: 'theme-color-only',
  };
  return buildPaletteReturn([row], []);
}

// ─── Image fetching ──────────────────────────────────────────────────

async function fetchImageBuffer(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Qumak/1.0)',
        accept: 'image/jpeg,image/png,image/webp,image/*',
      },
    });

    if (!resp.ok) {
      throw new Error(`Image fetch ${resp.status}`);
    }

    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${contentLength}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error('Image too large after download');
    }

    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function downscaleImage(buf) {
  try {
    return await sharp(buf)
      .resize(200, null, { withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (_err) {
    return buf;
  }
}

async function vibrantFromBuffer(buf) {
  return Vibrant.from(buf).maxColorCount(32).getPalette();
}

/**
 * Extract brand palette from one or more page images (OG + heroes).
 *
 * @param {object} opts
 * @param {string} [opts.primaryImageUrl]
 * @param {string[]} [opts.fallbackImages]
 * @param {string|null} [opts.themeColor] - meta theme-color (hex)
 * @param {number} [opts.maxSourcesToMerge=5] - max distinct URLs to sample and merge
 */
async function fetchBrandPalette({
  primaryImageUrl,
  fallbackImages = [],
  themeColor = null,
  maxSourcesToMerge = 5,
} = {}) {
  const candidates = [primaryImageUrl, ...fallbackImages].filter(Boolean).slice(0, maxSourcesToMerge);

  const collected = [];
  const sourceUrls = [];

  for (const url of candidates) {
    try {
      const buf = await fetchImageBuffer(url);
      const small = await downscaleImage(buf);
      const palette = await vibrantFromBuffer(small);
      const swatches = swatchesFromVibrantPalette(palette, url);
      if (swatches.length) {
        sourceUrls.push(url);
        collected.push(...swatches);
      }
    } catch (err) {
      console.warn(`[brandPalette] failed for ${url}:`, err.message);
    }
  }

  if (!collected.length) {
    return paletteFromThemeOnly(themeColor);
  }

  const merged = mergeSwatchesFromImages(collected);
  const withTheme = injectThemeColor(merged, themeColor);
  const topFive = withTheme.slice(0, 5);

  return buildPaletteReturn(topFive, sourceUrls);
}

module.exports = {
  fetchBrandPalette,
  /** @internal exported for tests only */
  _test: {
    hexToRgb,
    rgbToHex,
    brightness,
    saturation,
    colorDistance,
    normalizeThemeColorHex,
    totalVibrantPopulation,
    swatchesFromVibrantPalette,
    mergeSwatchesFromImages,
    injectThemeColor,
    buildPaletteReturn,
    paletteFromThemeOnly,
    fetchImageBuffer,
    downscaleImage,
    vibrantFromBuffer,
  },
};
