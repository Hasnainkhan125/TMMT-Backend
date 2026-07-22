'use strict';

/**
 * OfferStructureExtractor — Layer 3 signal: how does the competitor
 * *package* value? Discounts, free-tier leverage, bundles, price anchors.
 *
 * Output is a single `offer_structure` Signal that the composer uses to
 * tell the user:
 *   - What price anchors their competitor sets
 *   - Which offer levers (discount / freemium / bundle / guarantee / trial)
 *     dominate
 *   - What offer they should run to *not* price-race the competitor
 */

const EXTRACTOR_VERSION = '1.0.0';

const OFFER_LEVERS = {
  discount: [
    /\b\d{1,3}\s?%\s?off\b/i,
    /\bsave\s+(?:up\s+to\s+)?(?:\$|AED|USD|SAR)?\s?\d+/i,
    /\bflat\s+(?:\$|AED|USD|SAR)?\s?\d+\s+off/i,
    /\b(?:half|quarter)\s*price\b/i,
  ],
  freemium: [
    /\bfree\s+forever\b/i,
    /\bfree\s+plan\b/i,
    /\bfree\s+tier\b/i,
    /\bno credit card required\b/i,
    /\bstart(?:ing)?\s+free\b/i,
  ],
  trial: [
    /\bfree trial\b/i,
    /\b\d{1,2}\s*-?\s*day trial\b/i,
    /\btry\s+(?:it\s+)?free\b/i,
    /\bno commitment\b/i,
  ],
  bundle: [
    /\bbuy\s+\d+\s+get\s+\d+\b/i,
    /\bbogo\b/i,
    /\bbundle\b/i,
    /\bsave\s+\$?\d+\s+when you buy\b/i,
  ],
  guarantee: [
    /\b\d{1,3}\s*-?\s*day money[- ]back/i,
    /\bsatisfaction guarantee\b/i,
    /\bno[- ]questions[- ]asked refund\b/i,
    /\brisk[- ]free\b/i,
  ],
  shipping: [
    /\bfree shipping\b/i,
    /\bsame[- ]day (?:shipping|delivery)\b/i,
    /\bnext[- ]day (?:shipping|delivery)\b/i,
  ],
  urgency: [
    /\blimited time\b/i,
    /\bends\s+(?:today|tonight|soon)\b/i,
    /\bflash sale\b/i,
    /\btoday only\b/i,
  ],
};

function extractOfferStructure(mergedData) {
  const texts = collectOfferText(mergedData);
  if (texts.length < 3) return null;

  const leverHits = {};
  for (const [lever, patterns] of Object.entries(OFFER_LEVERS)) {
    const matches = [];
    for (const t of texts) {
      for (const p of patterns) {
        const m = t.match(p);
        if (m) {
          matches.push({ matched: m[0], context: t.slice(0, 180) });
          break; // one hit per text for this lever
        }
      }
    }
    leverHits[lever] = { count: matches.length, examples: matches.slice(0, 4) };
  }

  const priceTokens = mergeStrings(
    mergedData?.landing_page_crawler?.pricingSignals,
  );
  const explicitOffers = mergedData?.google_serp?.offerLanguage || [];

  const dominantLever = Object.entries(leverHits)
    .sort((a, b) => b[1].count - a[1].count)[0];

  if (!dominantLever || dominantLever[1].count === 0) {
    // We still want to surface pricing anchors even when there's no lever hit.
    if (priceTokens.length === 0 && explicitOffers.length === 0) return null;
  }

  const [dominantKey, dominant] = dominantLever || ['none', { count: 0, examples: [] }];
  const sourceTypes = Object.keys(mergedData).filter((k) => !!mergedData[k]);

  const confidence = confidenceFor(
    dominant.count,
    texts.length,
    priceTokens.length,
  );

  return {
    kind: 'offer_structure',
    confidence,
    sourceTypes,
    supportingEvidence: [
      ...dominant.examples.slice(0, 4).map((e) => `"${e.matched}" — ${e.context}`),
      ...priceTokens.slice(0, 4).map((p) => `price anchor: ${p}`),
    ],
    summary: dominant.count
      ? `"${humanLever(dominantKey)}" is the dominant offer lever (${dominant.count} hits across ${texts.length} messages)${priceTokens.length ? `, anchored to ${priceTokens[0]}` : ''}.`
      : `Price anchors visible (${priceTokens.slice(0, 2).join(', ')}) but no dominant offer lever in messaging.`,
    detail: composeDetail(dominantKey, dominant, priceTokens),
    actionable: {
      recommendation: counterOfferRecommendation(dominantKey, priceTokens),
      exampleAd: counterOfferAd(dominantKey, priceTokens),
      estimatedImpact: dominant.count >= 5 ? 'high' : dominant.count >= 2 ? 'medium' : 'low',
    },
    extractedAt: new Date(),
    extractor: 'offerStructureExtractor',
    extractorVersion: EXTRACTOR_VERSION,
    _raw: {
      leverHits: Object.fromEntries(
        Object.entries(leverHits).map(([k, v]) => [k, v.count]),
      ),
      priceTokens,
      textCount: texts.length,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function collectOfferText(md) {
  const out = [];
  const fb = md?.public_fb_page;
  if (fb?.posts) for (const p of fb.posts) if (p.text) out.push(p.text);
  const serp = md?.google_serp;
  if (serp?.ppcAds) for (const a of serp.ppcAds) {
    if (a.headline) out.push(a.headline);
    if (a.description) out.push(a.description);
  }
  const landing = md?.landing_page_crawler;
  if (landing?.headlinesUsed) out.push(...landing.headlinesUsed);
  if (landing?.ctaPatterns) out.push(...landing.ctaPatterns);
  const ads = md?.meta_ad_library;
  if (ads?.ads) for (const a of ads.ads) {
    if (a.headline) out.push(a.headline);
    if (a.body) out.push(a.body);
  }
  return out.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function mergeStrings(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s).toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function confidenceFor(matchCount, textCount, priceTokenCount) {
  const fromMessaging = Math.min(1, matchCount / Math.max(3, textCount / 4));
  const fromAnchors = Math.min(1, priceTokenCount / 4) * 0.5;
  return Number(Math.min(1, 0.3 + fromMessaging * 0.55 + fromAnchors * 0.2).toFixed(3));
}

function humanLever(key) {
  const map = {
    discount: 'Discount / % off',
    freemium: 'Freemium plan',
    trial: 'Free trial',
    bundle: 'Bundle / BOGO',
    guarantee: 'Money-back guarantee',
    shipping: 'Fast / free shipping',
    urgency: 'Urgency',
    none: 'None',
  };
  return map[key] || key;
}

function composeDetail(key, dominant, priceTokens) {
  const sampleCount = dominant?.count || 0;
  const priceAnchor = priceTokens[0] ? `Public price anchors seen: ${priceTokens.slice(0, 3).join(', ')}.` : '';
  const lever =
    key === 'discount'
      ? 'They rely on percentage-off discounting, which trains the market to wait for a sale.'
      : key === 'freemium'
        ? 'They acquire via a free plan and upsell on feature depth — expect high top-of-funnel but low ACV.'
        : key === 'trial'
          ? 'Free trial is the primary lever — activation rate inside the trial window determines their MRR curve.'
          : key === 'bundle'
            ? 'Bundle/BOGO framing — they are optimising AOV, not new customers. A single-SKU challenger can win on clarity.'
            : key === 'guarantee'
              ? 'They lean on refund guarantees to remove purchase risk; their product confidence is their marketing.'
              : key === 'shipping'
                ? 'Fulfillment speed is the offer — compete on something else or compound with it.'
                : key === 'urgency'
                  ? 'Urgency framing suggests discount-trained buyers; a calm, premium positioning is often more profitable.'
                  : 'No single dominant offer lever across the scanned messaging.';

  return `${lever} ${priceAnchor} ${sampleCount ? `We saw this pattern ${sampleCount} times across their public messaging.` : ''}`.trim();
}

function counterOfferRecommendation(key, priceTokens) {
  const anchor = priceTokens[0] ? ` Reference their "${priceTokens[0]}" anchor explicitly and reframe the value.` : '';
  const map = {
    discount: 'Don\'t match their % off. Win with outcome pricing — bind price to a measurable customer win they can\'t credibly promise.',
    freemium: 'If you offer a free plan, cap it on a value metric (credits / seats) instead of features — it funnels better.',
    trial: 'Shorten their trial. 7 days of aggressive activation beats 30 days of drift. Force the aha inside week one.',
    bundle: 'Unbundle and clarify. A single-price, single-SKU offer reads as more trustworthy than their bundle math.',
    guarantee: 'Match the guarantee and add a "win-or-we-refund" KPI — outcome guarantees compound trust beyond money-back.',
    shipping: 'Compete on promise clarity, not speed — "same-day or it\'s free" converts better than a raw speed claim.',
    urgency: 'Anchor a calm, premium message. Urgency attracts bargain hunters; calm attracts better LTV.',
    none: 'Lead with a specific, number-anchored offer (e.g. "12 Gulf-localised ads, AED 999, done in 48h") — specificity is the offer.',
  };
  return (map[key] || map.none) + anchor;
}

function counterOfferAd(key) {
  const map = {
    discount: 'No sales. Ever. The price is the price — and it\'s what it\'s worth.',
    freemium: 'Free plan, capped at 50 AI-generated ads / month. Upgrade only when you outgrow it.',
    trial: '7-day trial. 12 shipped ads by day 5 or we refund.',
    bundle: 'One price. One product. AED 999, 12 Gulf-native ads, 48h.',
    guarantee: 'Money back if your CTR doesn\'t beat your previous campaign in 30 days.',
    shipping: 'Delivered in 48h or it\'s free — same-day rush available.',
    urgency: 'We\'ll still be here next week. Take your time.',
    none: 'AED 999 → 12 Gulf-native ads delivered in 48 hours. No fine print.',
  };
  return map[key] || map.none;
}

module.exports = {
  extractOfferStructure,
  EXTRACTOR_VERSION,
  _internals: { OFFER_LEVERS, collectOfferText, confidenceFor },
};
