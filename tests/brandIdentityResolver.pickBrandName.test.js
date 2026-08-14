'use strict';

/**
 * pickBrandName — unit tests.
 *
 * Locks down the schema-product-hijack bug:
 *   Zigwheels.ae has Tesla product pages where Schema.org embeds a
 *   Product node with brand.name="Tesla". Title parsing also broke:
 *   "Tesla cars in UAE — Prices, Reviews — Zigwheels" used to collapse
 *   to "Tesla cars in UAE" because cleanupTitle dropped everything
 *   right of the dash.
 *
 * The fix: pickBrandName(metaSignals, canonical) penalizes any
 * candidate that doesn't echo the canonical domain root, prefers the
 * side of the title that contains the domain, and walks every
 * Organization-shaped schema.org node instead of grabbing the first.
 */

const { extractMetaSignals } = require('../services/resolver/steps/extractMetaSignals');
const { _pickBrandName: pickBrandName } = require('../services/resolver/brandIdentityResolver');
const {
  domainToken,
  brandMatchesDomain,
  pickBestOrganizationNode,
  cleanCandidate,
} = require('../services/resolver/utils/brandNameGuard');

describe('brandNameGuard.domainToken', () => {
  it('strips TLD and returns root', () => {
    expect(domainToken('zigwheels.ae')).toBe('zigwheels');
    expect(domainToken('hotshay.com')).toBe('hotshay');
    expect(domainToken('coca-cola.com')).toBe('cocacola');
  });
  it('skips generic subdomains', () => {
    expect(domainToken('shop.tesla.com')).toBe('tesla');
    expect(domainToken('www.afghanpalace.ae')).toBe('afghanpalace');
  });
  it('returns empty for invalid input', () => {
    expect(domainToken('')).toBe('');
    expect(domainToken(null)).toBe('');
  });
});

describe('brandNameGuard.brandMatchesDomain', () => {
  it('substring match counts', () => {
    expect(brandMatchesDomain('Zigwheels', 'zigwheels.ae').matches).toBe(true);
    expect(brandMatchesDomain('Hot Shay Karak', 'hotshay.com').matches).toBe(true);
  });
  it('rejects unrelated brand', () => {
    expect(brandMatchesDomain('Tesla', 'zigwheels.ae').matches).toBe(false);
    expect(brandMatchesDomain('Tesla cars in UAE', 'zigwheels.ae').matches).toBe(false);
  });
  it('first-word match counts even with suffix', () => {
    expect(brandMatchesDomain('AfghanPalace Restaurant LLC', 'afghanpalace.ae').matches).toBe(true);
  });
  it('fuzzy match catches small typos', () => {
    expect(brandMatchesDomain('Zigweels', 'zigwheels.ae').matches).toBe(true);
  });
});

describe('brandNameGuard.cleanCandidate', () => {
  it('strips legal suffixes and TM marks', () => {
    expect(cleanCandidate('Acme Corp.®')).toBe('Acme');
    expect(cleanCandidate('Foo LLC')).toBe('Foo');
    expect(cleanCandidate('"Reign Estates"')).toBe('Reign Estates');
  });
});

describe('pickBrandName — Zigwheels fixture (Tesla product hijack)', () => {
  // Mimics what cheerio extracts off zigwheels.ae/new-cars/tesla:
  //   - og:site_name absent (aggregator page)
  //   - JSON-LD has both Tesla (Product.brand) AND Zigwheels (Organization)
  //   - title puts brand on the right of separator
  const html = `
    <html lang="en">
      <head>
        <title>Tesla cars in UAE — Prices, Reviews — Zigwheels</title>
        <meta name="description" content="Browse Tesla cars in the UAE." />
        <meta property="og:title" content="Tesla cars in UAE - Zigwheels" />
        <meta property="og:url" content="https://www.zigwheels.ae/new-cars/tesla" />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Zigwheels",
            "url": "https://www.zigwheels.ae/"
          }
        </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Tesla Model 3",
            "brand": { "@type": "Brand", "name": "Tesla" }
          }
        </script>
      </head>
      <body><h1>Tesla cars in UAE</h1></body>
    </html>
  `;

  it('picks Zigwheels (matches domain), not Tesla', () => {
    const meta = extractMetaSignals(html);
    const picked = pickBrandName(meta, 'zigwheels.ae');
    expect(picked.name).toBe('Zigwheels');
    expect(picked.matchesDomain).toBe(true);
    expect(picked.source).toMatch(/schema\.|^title\.right$/);
  });

  it('falls back to capitalized domain when no candidate echoes the domain', () => {
    // Both the Organization and the title only mention Tesla. The guard
    // should refuse Tesla (doesn't match zigwheels) and fall back to the
    // domain root capitalized — never leaks Tesla as a brand name.
    const teslaOnly = `
      <html lang="en">
        <head>
          <title>Tesla Model 3 Specs</title>
          <meta property="og:title" content="Tesla Model 3 Specs" />
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Product","name":"Tesla Model 3","brand":{"@type":"Brand","name":"Tesla"}}
          </script>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Organization","name":"Tesla Inc"}
          </script>
        </head>
      </html>`;
    const meta = extractMetaSignals(teslaOnly);
    const picked = pickBrandName(meta, 'zigwheels.ae');
    expect(picked.name).toBe('Zigwheels');
    expect(picked.source).toBe('fallback.domain');
    expect(picked.matchesDomain).toBe(true);
  });
});

describe('pickBrandName — happy paths', () => {
  it('uses og:site_name when available and matching', () => {
    const html = `
      <html><head>
        <meta property="og:site_name" content="Hot Shay" />
        <title>Hot Shay — Authentic UAE Karak</title>
      </head></html>
    `;
    const meta = extractMetaSignals(html);
    const picked = pickBrandName(meta, 'hotshay.com');
    expect(picked.name).toBe('Hot Shay');
    expect(picked.source).toBe('og:site_name');
    expect(picked.matchesDomain).toBe(true);
    expect(picked.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('falls through to schema.LocalBusiness when og:site_name is missing', () => {
    const html = `
      <html><head>
        <title>Welcome to AfghanPalace</title>
        <script type="application/ld+json">{
          "@context":"https://schema.org",
          "@type":"Restaurant",
          "name":"Afghan Palace Restaurant"
        }</script>
      </head></html>
    `;
    const meta = extractMetaSignals(html);
    const picked = pickBrandName(meta, 'afghanpalace.ae');
    expect(picked.name).toMatch(/Afghan/);
    expect(picked.matchesDomain).toBe(true);
  });

  it('returns title cleanup when schema.org is empty but title matches domain', () => {
    const html = `
      <html><head>
        <title>EcityUAE | Best Electronics in UAE</title>
      </head></html>
    `;
    const meta = extractMetaSignals(html);
    const picked = pickBrandName(meta, 'ecityuae.ae');
    expect(picked.name).toBe('EcityUAE');
    expect(picked.matchesDomain).toBe(true);
  });

  it('prefers right side of title when it contains the domain token', () => {
    const html = `
      <html><head>
        <title>Real Estate Listings — Reign Estates</title>
      </head></html>
    `;
    const meta = extractMetaSignals(html);
    const picked = pickBrandName(meta, 'reignestates.com');
    expect(picked.name).toBe('Reign Estates');
    expect(picked.source).toBe('title.right');
  });
});

describe('pickBestOrganizationNode', () => {
  it('walks every Organization candidate and picks the domain-matching one', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">[
          {"@context":"https://schema.org","@type":"Organization","name":"Tesla"},
          {"@context":"https://schema.org","@type":"Organization","name":"Zigwheels"}
        ]</script>
      </head></html>
    `;
    const meta = extractMetaSignals(html);
    const picked = pickBestOrganizationNode(meta.schemaOrg, 'zigwheels.ae');
    expect(picked.node?.name).toBe('Zigwheels');
    expect(picked.matchScore).toBe(1);
  });
});
