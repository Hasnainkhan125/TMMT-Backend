'use strict';

/**
 * brandPalette tests: pure helpers, merge/dedupe, theme fallback,
 * and fetchBrandPalette with mocked network + Vibrant + sharp.
 */

jest.mock(
  'sharp',
  () =>
    jest.fn(() => ({
      resize: () => ({
        jpeg: () => ({
          toBuffer: jest.fn(async () => Buffer.from('jpeg-bytes')),
        }),
      }),
    })),
);

jest.mock('node-vibrant/node', () => ({
  Vibrant: { from: jest.fn() },
}));

const mockGetPalette = jest.fn();
const { Vibrant } = require('node-vibrant/node');
Vibrant.from.mockImplementation(() => ({
  maxColorCount: jest.fn(() => ({
    getPalette: () => mockGetPalette(),
  })),
}));

const {
  fetchBrandPalette,
  _test: {
    normalizeThemeColorHex,
    totalVibrantPopulation,
    swatchesFromVibrantPalette,
    mergeSwatchesFromImages,
    injectThemeColor,
    paletteFromThemeOnly,
    buildPaletteReturn,
    colorDistance,
  },
} = require('../services/scraper/brandPalette');

function mockSwatch(r, g, b, pop) {
  return {
    _rgb: [r, g, b],
    getPopulation: () => pop,
  };
}

describe('brandPalette helpers', () => {
  it('normalizeThemeColorHex accepts #RGB, #RRGGBB, bare hex', () => {
    expect(normalizeThemeColorHex('#228B22')).toBe('#228b22');
    expect(normalizeThemeColorHex('#ABC')).toBe('#aabbcc');
    expect(normalizeThemeColorHex('00FF00')).toBe('#00ff00');
    expect(normalizeThemeColorHex('not-a-color')).toBeNull();
    expect(normalizeThemeColorHex(null)).toBeNull();
  });

  it('totalVibrantPopulation sums swatch populations', () => {
    const palette = {
      Vibrant: mockSwatch(255, 0, 0, 100),
      Muted: mockSwatch(100, 100, 100, 50),
      DarkVibrant: null,
    };
    expect(totalVibrantPopulation(palette)).toBe(150);
  });

  it('swatchesFromVibrantPalette uses population share for coverage', () => {
    const palette = {
      Vibrant: mockSwatch(255, 0, 0, 100),
      Muted: mockSwatch(128, 128, 128, 300),
    };
    const sw = swatchesFromVibrantPalette(palette, 'https://ex/img1.png');
    const muted = sw.find((s) => s.source === 'Muted');
    const vibrant = sw.find((s) => s.source === 'Vibrant');
    expect(muted.coverage).toBeCloseTo(300 / 400, 5);
    expect(vibrant.coverage).toBeCloseTo(100 / 400, 5);
    expect(muted.sourceImageUrl).toBe('https://ex/img1.png');
  });

  it('mergeSwatchesFromImages dedupes visually similar colors', () => {
    const rows = [
      { hex: '#00ff00', rgb: { r: 0, g: 255, b: 0 }, saturation: 1, coverage: 0.4, source: 'A' },
      { hex: '#01fe01', rgb: { r: 1, g: 254, b: 1 }, saturation: 0.99, coverage: 0.2, source: 'B' },
      { hex: '#000080', rgb: { r: 0, g: 0, b: 128 }, saturation: 1, coverage: 0.3, source: 'C' },
    ];
    const merged = mergeSwatchesFromImages(rows, { dedupeMinDistance: 30 });
    expect(merged.length).toBe(2);
    expect(merged.some((m) => m.hex === '#000080')).toBe(true);
  });

  it('injectThemeColor skips when too close to existing swatch', () => {
    const rgb = hexToRgbLocal('#228b22');
    const base = [
      {
        hex: '#228b22',
        rgb,
        saturation: 0.5,
        coverage: 0.5,
        source: 'Vibrant',
        brightness: 120,
      },
    ];
    const out = injectThemeColor(base, '#228b22');
    expect(out.length).toBe(1);
  });

  it('paletteFromThemeOnly returns minimal palette', () => {
    const p = paletteFromThemeOnly('#336699');
    expect(p).not.toBeNull();
    expect(p.primary).toBe('#336699');
    expect(p.swatches).toHaveLength(1);
    expect(p.swatches[0].source).toBe('theme-color-only');
  });

  it('buildPaletteReturn exposes cssVariables', () => {
    const top = [
      { hex: '#111111', rgb: { r: 17, g: 17, b: 17 }, role: 'primary', brightness: 17, saturation: 0, coverage: 0.5, source: 'Vibrant' },
      { hex: '#00ff00', rgb: { r: 0, g: 255, b: 0 }, role: 'accent', brightness: 150, saturation: 1, coverage: 0.3, source: 'DarkVibrant' },
    ];
    const r = buildPaletteReturn(top, ['https://a.png']);
    expect(r.cssVariables['--brand-primary']).toBe('#111111');
    expect(r.sourceImageUrls).toEqual(['https://a.png']);
  });
});

function hexToRgbLocal(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

describe('brandPalette.fetchBrandPalette (mocked sharp + vibrant)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetPalette.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('merges palettes from two successful image URLs', async () => {
    const pal1 = {
      Vibrant: mockSwatch(0, 200, 0, 500),
      Muted: mockSwatch(240, 240, 240, 100),
      DarkVibrant: null,
      LightVibrant: null,
      DarkMuted: null,
      LightMuted: null,
    };
    const pal2 = {
      Vibrant: mockSwatch(0, 0, 200, 400),
      Muted: mockSwatch(50, 50, 50, 200),
      DarkVibrant: null,
      LightVibrant: null,
      DarkMuted: null,
      LightMuted: null,
    };
    mockGetPalette.mockResolvedValueOnce(pal1).mockResolvedValueOnce(pal2);

    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => '1000' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    }));

    const result = await fetchBrandPalette({
      primaryImageUrl: 'https://cdn/a.png',
      fallbackImages: ['https://cdn/b.png'],
      maxSourcesToMerge: 2,
    });

    expect(result).not.toBeNull();
    expect(result.mergedFromImages).toBe(true);
    expect(result.sourceImageUrls.length).toBe(2);
    expect(result.swatches.length).toBeGreaterThanOrEqual(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockGetPalette).toHaveBeenCalledTimes(2);
  });

  it('falls back to theme-color when all image fetches fail', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network');
    });

    const result = await fetchBrandPalette({
      primaryImageUrl: 'https://bad/img.png',
      themeColor: '#ff00aa',
    });

    expect(result).not.toBeNull();
    expect(result.primary).toBe('#ff00aa');
    expect(result.swatches[0].source).toBe('theme-color-only');
    expect(mockGetPalette).not.toHaveBeenCalled();
  });

  it('returns null when everything fails and no valid theme', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('e');
    });

    const result = await fetchBrandPalette({
      primaryImageUrl: 'https://x/y.png',
      themeColor: 'garbage',
    });
    expect(result).toBeNull();
  });

  it('uses theme fallback when fetch succeeds but Vibrant yields no swatches', async () => {
    mockGetPalette.mockResolvedValue({});
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => '500' },
      arrayBuffer: async () => new Uint8Array([9]),
    }));

    const result = await fetchBrandPalette({
      primaryImageUrl: 'https://ok/empty.png',
      themeColor: '#112233',
    });

    expect(result).not.toBeNull();
    expect(result.primary).toBe('#112233');
    expect(result.swatches[0].source).toBe('theme-color-only');
  });
});

describe('brandPalette colorDistance', () => {
  it('is 0 for identical RGB', () => {
    const a = { r: 10, g: 20, b: 30 };
    expect(colorDistance(a, a)).toBe(0);
  });
});
