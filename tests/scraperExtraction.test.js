'use strict';

/**
 * Phase 1 scrape extraction test suite.
 *
 * These tests use real HTML fixtures (the actual HTML you scraped from
 * malabardentalclinics.com, plus realistic patterns from afghanpalace.ae,
 * hotshay.com, and ecityuae.ae). They verify that the four extractors:
 *
 *   - extractSocialHandles
 *   - extractBrandPalette
 *   - extractTeamAndServices
 *
 * ...produce correct results for each fixture. If any of these break, the
 * change that broke them must not ship.
 *
 * Run: npx jest tests/scraper/scraperExtraction.test.js
 *
 * IMPORTANT: keep these fixtures small but representative. Don't add a 5MB
 * full-page dump — pull out the section that exercises the bug you're
 * adding a regression test for.
 */

const fs = require('fs');
const path = require('path');
const {
  extractSocialHandles,
  _internal: socialInternals,
} = require('../services/scraper/extractSocialHandles');
const {
  extractBrandPalette,
  _internal: paletteInternals,
} = require('../services/scraper/extractBrandPalette');
const {
  extractTeamAndServices,
  _internal: teamInternals,
} = require('../services/scraper/extractTeamAndServices');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// =============================================================================
// SOCIAL HANDLES
// =============================================================================

describe('extractSocialHandles', () => {
  describe('Malabar Dental Clinic', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('malabar.html');
      result = extractSocialHandles({ html, url: 'https://malabardentalclinics.com/' });
    });

    it('extracts Facebook handle from data-network anchor', () => {
      expect(result.handles.facebookHandle).toBe('MalabarDentalClinics');
    });

    it('extracts Instagram handle (the one the previous extractor missed)', () => {
      expect(result.handles.instagramHandle).toBe('malabardentalclinics');
    });

    it('extracts YouTube @handle from footer', () => {
      // Should preserve @-prefix or strip — accept both
      expect(['@malabardentalclinic', 'malabardentalclinic']).toContain(
        result.handles.youtubeHandle
      );
    });

    it('extracts WhatsApp number from chaty_settings JS config blob', () => {
      expect(result.handles.whatsappNumber).toMatch(/^\+?971521514300$/);
    });

    it('returns canonical Facebook URL without doubled-domain bug', () => {
      // The original Malabar HTML had href doubled like
      // "facebook.com/MalabarDentalClinics/https://www.facebook.com/..."
      // Canonical URL must not have the doubled portion.
      expect(result.handles.facebookPageUrl).toBe(
        'https://www.facebook.com/MalabarDentalClinics'
      );
      expect(result.handles.facebookPageUrl).not.toMatch(/https.*https/i);
    });
  });

  describe('Afghan Palace (icon-only Font Awesome links)', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('afghanpalace.html');
      result = extractSocialHandles({ html, url: 'https://afghanpalace.ae/' });
    });

    it('extracts Facebook handle from icon-only anchor', () => {
      expect(result.handles.facebookHandle).toBe('AfghanPalaceRestaurant');
    });

    it('extracts Instagram handle from icon-only anchor', () => {
      expect(result.handles.instagramHandle).toBe('AfghanPalaceRestaurant');
    });

    it('does NOT match facebook.com/sharer/ as a handle', () => {
      // The fixture includes <a href="...sharer/sharer.php"> which must be ignored.
      // The real Facebook handle should win.
      expect(result.handles.facebookHandle).not.toBe('sharer');
      expect(result.handles.facebookHandle).not.toBe('share');
    });

    it('extracts phone number from tel: link', () => {
      expect(result.handles.phoneNumber).toMatch(/045484004|\+9714548?4004/);
    });
  });

  describe('Hot Shay (multi-platform)', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('hotshay.html');
      result = extractSocialHandles({ html, url: 'https://hotshay.com/' });
    });

    it('extracts Facebook, Instagram, AND TikTok handles', () => {
      expect(result.handles.facebookHandle).toBe('hotshayuae');
      expect(result.handles.instagramHandle).toBe('hotshay');
      expect(result.handles.tiktokHandle).toBe('hotshay');
    });

    it('extracts WhatsApp from wa.me link', () => {
      expect(result.handles.whatsappNumber).toMatch(/97142345678/);
    });
  });

  describe('Ecity Electronics (Shopify + complex YouTube channel ID)', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('ecity.html');
      result = extractSocialHandles({ html, url: 'https://ecityuae.ae/' });
    });

    it('extracts Facebook, Instagram, Twitter handles', () => {
      expect(result.handles.facebookHandle).toBe('ecityuae');
      expect(result.handles.instagramHandle).toBe('ecityuae');
      expect(result.handles.twitterHandle).toBe('ecityuae');
    });

    it('extracts YouTube channel ID format (not just @handle)', () => {
      expect(result.handles.youtubeHandle).toBe('UCrA7LDumjhKYxI-YbLV_mkA');
    });

    it('extracts WhatsApp from shopifyConfig blob', () => {
      expect(result.handles.whatsappNumber).toMatch(/971501234567/);
    });
  });

  describe('edge cases', () => {
    it('returns empty handles for empty HTML', () => {
      const result = extractSocialHandles({ html: '' });
      expect(result.handles.facebookHandle).toBeNull();
      expect(result.handles.instagramHandle).toBeNull();
    });

    it('does not crash on malformed HTML', () => {
      expect(() => {
        extractSocialHandles({ html: '<div><a href=' });
      }).not.toThrow();
    });

    it('rejects share/intent URLs', () => {
      const html = `
        <a href="https://twitter.com/intent/tweet?text=hello">Tweet</a>
        <a href="https://twitter.com/realbrand">Brand</a>
      `;
      const result = extractSocialHandles({ html });
      expect(result.handles.twitterHandle).toBe('realbrand');
    });

    it('does not match Instagram /p/ post URLs as handles', () => {
      const html = `<a href="https://www.instagram.com/p/ABC123/">Post</a>`;
      const result = extractSocialHandles({ html });
      expect(result.handles.instagramHandle).toBeNull();
    });

    it('extracts canonical handle when same brand appears multiple times', () => {
      const html = `
        <a href="https://facebook.com/brand">FB</a>
        <a href="https://www.facebook.com/brand/">FB</a>
        <a href="https://m.facebook.com/brand">FB Mobile</a>
      `;
      const result = extractSocialHandles({ html });
      expect(result.handles.facebookHandle).toBe('brand');
    });
  });
});

// =============================================================================
// BRAND PALETTE
// =============================================================================

describe('extractBrandPalette', () => {
  describe('Malabar Dental — green primary', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('malabar.html');
      result = extractBrandPalette({ html });
    });

    it('returns at least one palette color', () => {
      expect(result.palette.length).toBeGreaterThan(0);
    });

    it('identifies green family (#228B22) as primary brand color', () => {
      // Top color should be in the green family
      const top = result.palette[0];
      const rgb = paletteInternals.hexToRgb(top.hex);
      // Green dominant: g > r AND g > b AND distance from #228B22 is small
      expect(rgb.g).toBeGreaterThan(rgb.r);
      expect(rgb.g).toBeGreaterThan(rgb.b);

      const target = paletteInternals.hexToRgb('#228B22');
      const distance = paletteInternals.colorDistance(rgb, target);
      expect(distance).toBeLessThan(40);
    });

    it('does NOT pick Facebook blue (#1877F2) as a brand color', () => {
      const hexes = result.palette.map((p) => p.hex.toLowerCase());
      expect(hexes).not.toContain('#1877f2');
    });

    it('does NOT pick YouTube red (#FF0000) as a brand color', () => {
      const hexes = result.palette.map((p) => p.hex.toLowerCase());
      expect(hexes).not.toContain('#ff0000');
    });

    it('does NOT pick Instagram gradient stops as brand colors', () => {
      const hexes = result.palette.map((p) => p.hex.toLowerCase());
      const igGradient = ['#f09433', '#e6683c', '#dc2743', '#cc2366', '#bc1888'];
      for (const ig of igGradient) {
        expect(hexes).not.toContain(ig);
      }
    });

    it('exposes primary, secondary, accent', () => {
      expect(result.primary).toBeTruthy();
      // secondary may or may not exist; both are acceptable
      expect(typeof result.secondary === 'string' || result.secondary === null).toBe(true);
    });
  });

  describe('Afghan Palace — gold/brown', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('afghanpalace.html');
      result = extractBrandPalette({ html });
    });

    it('extracts gold/brown family color', () => {
      const top = result.palette[0];
      const rgb = paletteInternals.hexToRgb(top.hex);
      // Gold (#B8860B) and brown (#8B4513) both have r > g > b
      expect(rgb.r).toBeGreaterThan(rgb.b);
    });
  });

  describe('Ecity Electronics — blue', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('ecity.html');
      result = extractBrandPalette({ html });
    });

    it('extracts blue (#0066CC) family as primary', () => {
      const top = result.palette[0];
      const rgb = paletteInternals.hexToRgb(top.hex);
      // Blue dominant
      expect(rgb.b).toBeGreaterThan(rgb.r);
    });
  });

  describe('edge cases', () => {
    it('returns empty palette for HTML with no CSS', () => {
      const result = extractBrandPalette({ html: '<div>hello</div>' });
      expect(result.palette).toEqual([]);
      expect(result.primary).toBeNull();
    });

    it('does not crash on undefined input', () => {
      expect(() => extractBrandPalette({})).not.toThrow();
    });

    it('clusters near-duplicate colors', () => {
      // #228B22 and #228B23 should merge
      const colors = [
        { hex: '#228b22', rgb: { r: 34, g: 139, b: 34 }, weight: 5 },
        { hex: '#228b23', rgb: { r: 34, g: 139, b: 35 }, weight: 3 },
        { hex: '#196f19', rgb: { r: 25, g: 111, b: 25 }, weight: 4 },
      ];
      const clusters = paletteInternals.clusterColors(colors);
      // First two should merge, third stays separate (distance ~30)
      expect(clusters.length).toBeLessThanOrEqual(2);
    });
  });
});

// =============================================================================
// TEAM + SERVICES
// =============================================================================

describe('extractTeamAndServices', () => {
  describe('Malabar Dental — 12 doctors + 6+ specialties', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('malabar.html');
      result = extractTeamAndServices({
        html,
        baseUrl: 'https://malabardentalclinics.com/',
      });
    });

    it('extracts at least 4 doctors with names', () => {
      // The fixture has 4 in cards + 12 in menu, dedup expected.
      // We require at least 4 with high confidence.
      expect(result.team.length).toBeGreaterThanOrEqual(4);
    });

    it('extracts Dr. Sumayya Babu with title', () => {
      const sumayya = result.team.find((t) => /Sumayya/i.test(t.name));
      expect(sumayya).toBeTruthy();
      expect(sumayya.name).toMatch(/Dr\.?\s+Sumayya/i);
    });

    it('extracts profile URLs for at least one doctor', () => {
      const withProfile = result.team.filter((t) => t.profileUrl);
      expect(withProfile.length).toBeGreaterThan(0);
      expect(withProfile[0].profileUrl).toMatch(/^https?:\/\/.+/);
    });

    it('extracts at least 5 services/specialties', () => {
      expect(result.services.length).toBeGreaterThanOrEqual(5);
    });

    it('extracts ORTHODONTICS as a service', () => {
      const ortho = result.services.find((s) => /orthodontics/i.test(s.name));
      expect(ortho).toBeTruthy();
    });

    it('extracts IMPLANTOLOGY as a service', () => {
      const impl = result.services.find((s) => /implantology/i.test(s.name));
      expect(impl).toBeTruthy();
    });

    it('does not include doctors as services', () => {
      const drInServices = result.services.find((s) => /^dr\.?\s/i.test(s.name));
      expect(drInServices).toBeUndefined();
    });

    it('returns useful stats', () => {
      expect(result.stats.teamCount).toBe(result.team.length);
      expect(result.stats.servicesCount).toBe(result.services.length);
    });
  });

  describe('Afghan Palace — service categories', () => {
    let result;
    beforeAll(() => {
      const html = loadFixture('afghanpalace.html');
      result = extractTeamAndServices({
        html,
        baseUrl: 'https://afghanpalace.ae/',
      });
    });

    it('extracts menu sub-categories as services', () => {
      const names = result.services.map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('appetizer'))).toBe(true);
      expect(names.some((n) => n.includes('main'))).toBe(true);
    });

    it('returns no team for a restaurant', () => {
      // Restaurants typically have no team listed publicly.
      // We tolerate 0-2 false positives but expect low count.
      expect(result.team.length).toBeLessThanOrEqual(2);
    });
  });

  describe('name extraction edge cases', () => {
    it('extracts "Dr. Sumayya Babu" cleanly', () => {
      const name = teamInternals.extractNameFrom('Dr. Sumayya Babu');
      expect(name).toMatch(/Dr\.?\s+Sumayya\s+Babu/);
    });

    it('extracts triple-name "Dr. Anju Elizabeth Raju"', () => {
      const name = teamInternals.extractNameFrom('Dr. Anju Elizabeth Raju');
      expect(name).toMatch(/Anju\s+Elizabeth\s+Raju/);
    });

    it('returns null for non-name text', () => {
      const name = teamInternals.extractNameFrom('Click here to learn more');
      expect(name).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(teamInternals.extractNameFrom('')).toBeNull();
      expect(teamInternals.extractNameFrom(null)).toBeNull();
    });
  });
});

// =============================================================================
// INTEGRATION: full Malabar scan must produce ALL expected outputs
// =============================================================================

describe('Phase 1 integration — Malabar end-to-end', () => {
  let html;
  beforeAll(() => {
    html = loadFixture('malabar.html');
  });

  it('produces a complete scan result with all 4 extractors', () => {
    const social = extractSocialHandles({ html, url: 'https://malabardentalclinics.com/' });
    const palette = extractBrandPalette({ html });
    const teamAndServices = extractTeamAndServices({
      html,
      baseUrl: 'https://malabardentalclinics.com/',
    });

    // The end-to-end assertion that the previous scan failed:
    expect(social.handles.facebookHandle).toBeTruthy();
    expect(social.handles.instagramHandle).toBeTruthy();
    expect(social.handles.youtubeHandle).toBeTruthy();
    expect(palette.primary).toBeTruthy();
    expect(teamAndServices.team.length).toBeGreaterThan(3);
    expect(teamAndServices.services.length).toBeGreaterThan(4);

    // The Brutal Truth panel for this scan should NOT fire "no public presence"
    const hasPresence =
      !!social.handles.facebookHandle &&
      !!social.handles.instagramHandle;
    expect(hasPresence).toBe(true);
  });
});
