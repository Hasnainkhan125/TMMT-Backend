'use strict';

/**
 * whatsappCopyVariants — deterministic ad-copy variants tuned for
 * WhatsApp-first commerce shoppers.
 *
 * Companion to services/scraper/detectWhatsAppCommerce.js. Once we know
 * the brand actually sells through WhatsApp (high/medium confidence on
 * `scan.whatsappCommerce.detected`), we surface 5 ready-to-paste copy
 * variants whose call-to-action matches how the buyer already shops:
 *
 *   1. "DM for prices"        — discovery hook, brand-name aware
 *   2. "Reply HELLO"          — catalog tease, low-friction first reply
 *   3. "Live photos · same-day reply"
 *                             — trust beat, rebuts WA-as-spam concern
 *   4. "VIP WhatsApp list"    — membership / loyalty angle for repeat buyers
 *   5. One-liner ad pair      — short headline + body for paid placement
 *
 * Pure function — no async, no LLM, no I/O. We stay deterministic so:
 *   - the panel is reproducible across reloads,
 *   - tests don't need network mocks,
 *   - the variants are safe to render even before the background enrich
 *     job finishes (no upstream LLM dependency).
 *
 * The helper is forgiving: a scan with no brand name, no product catalog,
 * or a missing whatsappCommerce block still returns 5 variants — they
 * just lean on neutral phrasing ("our line", "the team") instead of
 * brand-specific anchors.
 */

function safeBrandName(scan) {
  const candidates = [
    scan?.brand?.name,
    scan?.brand?.siteName,
    scan?.research?.brand?.name,
    scan?.host,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim().slice(0, 60);
    }
  }
  return 'our shop';
}

function pickFeaturedProduct(scan) {
  const products = scan?.productCatalog?.products;
  if (!Array.isArray(products) || products.length === 0) return null;
  // Prefer the first product with a non-empty title; fall back to any.
  const named = products.find((p) => p && typeof p.title === 'string' && p.title.trim().length > 1);
  const choice = named || products[0];
  if (!choice) return null;
  const title = typeof choice.title === 'string'
    ? choice.title.replace(/\s+/g, ' ').trim().slice(0, 60)
    : null;
  return title || null;
}

function pickWaNumber(scan) {
  const wa = scan?.whatsappCommerce;
  if (wa && Array.isArray(wa.waNumbers) && wa.waNumbers.length > 0) {
    return wa.waNumbers[0];
  }
  const fallback =
    scan?.brand?.socialHandles?.whatsappNumber
    || scan?.intelligence?.brandIdentity?.handles?.whatsappNumber
    || null;
  if (typeof fallback !== 'string') return null;
  const digits = fallback.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/**
 * Generate 5 WhatsApp-first ad copy variants for a hydrated scan document.
 *
 * @param {object} scan  hydrated UrlToAdsScan (or its serialized snapshot)
 * @returns {Array<{
 *   id: string,
 *   label: string,
 *   headline: string,
 *   body: string,
 *   cta: string,
 * }>}
 */
function whatsappCopyVariants(scan) {
  const brand = safeBrandName(scan);
  const product = pickFeaturedProduct(scan);
  const waNumber = pickWaNumber(scan);
  const productClause = product ? ` (start with the ${product})` : '';
  const productLineNoun = product ? `the ${product}` : 'the new line';

  // 1. Hook — "DM for prices"
  const v1 = {
    id: 'wa-hook-dm-for-prices',
    label: 'DM for prices',
    headline: `${brand}: DM for prices.`,
    body: `Pricing on request — drop us a WhatsApp${productClause} and we'll send the latest list, photos, and stock the same day.`,
    cta: waNumber ? `WhatsApp ${waNumber}` : 'Message us on WhatsApp',
  };

  // 2. Catalog tease — "Reply HELLO"
  const v2 = {
    id: 'wa-catalog-reply-hello',
    label: 'Reply HELLO for catalog',
    headline: `Reply HELLO on WhatsApp — get the full ${brand} catalog.`,
    body: `One word, full catalog. Send "HELLO" to our WhatsApp and we'll reply with every piece in stock${product ? `, including ${product}` : ''}, plus this week's prices.`,
    cta: 'Reply HELLO on WhatsApp',
  };

  // 3. Trust — "live photos, same-day reply"
  const v3 = {
    id: 'wa-trust-same-day',
    label: 'Live photos · same-day reply',
    headline: `Order ${brand} on WhatsApp — live photos, same-day reply.`,
    body: `Real photos from real stock. Tap WhatsApp, ask for ${productLineNoun}, and we reply within hours — never bots, never "we'll get back to you next week".`,
    cta: 'Chat on WhatsApp',
  };

  // 4. VIP — first-dibs membership
  const v4 = {
    id: 'wa-vip-list',
    label: 'VIP WhatsApp list',
    headline: `Join the ${brand} VIP WhatsApp list.`,
    body: `New pieces drop on WhatsApp first${product ? ` — the ${product} sold out in 48h last time` : ''}. Reply VIP to get on the list and see new arrivals before the website.`,
    cta: 'Reply VIP on WhatsApp',
  };

  // 5. One-liner ad headline + body — short, paid-placement shaped
  const v5 = {
    id: 'wa-one-liner-paid',
    label: 'One-liner ad headline + body',
    headline: `${brand} is on WhatsApp.`,
    body: `Tap, message, done. Photos, prices, pickup or delivery — all on WhatsApp${product ? `. Ask for ${product}.` : '.'}`,
    cta: waNumber ? `WhatsApp ${waNumber}` : 'Message on WhatsApp',
  };

  return [v1, v2, v3, v4, v5];
}

module.exports = {
  whatsappCopyVariants,
  // Exposed for unit tests
  _internal: { safeBrandName, pickFeaturedProduct, pickWaNumber },
};
