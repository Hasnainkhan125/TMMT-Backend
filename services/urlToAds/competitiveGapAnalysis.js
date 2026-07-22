'use strict';

/**
 * Lightweight pattern summary over competitor Meta ad copy already collected
 * in `apifyData.competitorAds`. No LLM — deterministic string ops so it always
 * returns something actionable when ≥3 ad texts exist.
 */

function flattenAdTexts(scan) {
  const texts = [];
  const buckets = scan?.apifyData?.competitorAds || [];
  for (const b of buckets) {
    const ads = b?.ads || [];
    for (const ad of ads) {
      const parts = [
        ad.adText,
        ad.headline,
        ad.cta,
        ad.description,
        Array.isArray(ad.cards)
          ? ad.cards.map((c) => [c.title, c.description].filter(Boolean).join(' ')).join(' ')
          : '',
      ].filter(Boolean);
      const t = parts.join(' ').trim();
      if (t.length > 8) texts.push(t);
    }
  }
  return texts;
}

function countMatches(texts, re) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags.replace('g', '') : re.flags);
  let n = 0;
  for (const t of texts) {
    if (rx.test(t)) n += 1;
  }
  return n;
}

/**
 * @returns {object|null}
 */
function buildCompetitiveGap(scan) {
  const texts = flattenAdTexts(scan);
  if (texts.length < 3) return null;

  const n = texts.length;

  const giftFraming = countMatches(
    texts,
    /\b(gift|gifting|for\s+her|for\s+him|anniversary|engagement|valentine|bridal)\b/i,
  );
  const aedPrice = countMatches(texts, /\b(aed|د\.إ|dirham)\b.*\d|\d[\d,]*\s*aed\b/i);
  const macroOrProduct = countMatches(
    texts,
    /\b(macro|close[-\s]?up|detail|product\s+shot|studio\s+shot|packshot|on\s+white)\b/i,
  );
  const modelLifestyle = countMatches(
    texts,
    /\b(model|lifestyle|wearing|on\s+model|faces?|portrait)\b/i,
  );

  const bullets = [
    `${giftFraming}/${n} ads mention gift / “for her” / engagement-style framing.`,
    `${aedPrice}/${n} ads show AED (or local currency) pricing in copy.`,
    `${macroOrProduct}/${n} lean on product macro or detail shots; ${modelLifestyle}/${n} read as model- or lifestyle-led.`,
  ];

  const stealableParts = [];
  if (giftFraming / n < 0.15) {
    stealableParts.push('own the “gift for her/him” occasion frame competitors skip');
  }
  if (aedPrice / n < 0.1) {
    stealableParts.push('add clear local price anchoring where peers stay vague');
  }
  if (macroOrProduct / n < modelLifestyle / n && macroOrProduct / n < 0.35) {
    stealableParts.push('swap some model shots for tight product macros + craftsmanship');
  }
  const stealableAngle =
    stealableParts.length > 0
      ? stealableParts.join('; ') + '.'
      : 'Double down on the hooks that already correlate with strongest stills in your crawl — test 2 creatives per hypothesis.';

  return {
    analyzedCount: n,
    headline: `What competitors are NOT doing (${n} recent Meta ads sampled)`,
    bullets,
    stealableAngle,
    flags: {
      giftFraming,
      aedPricing: aedPrice,
      macroLean: macroOrProduct,
      modelLean: modelLifestyle,
    },
    source: 'pattern_engine_v1',
  };
}

module.exports = { buildCompetitiveGap, flattenAdTexts };
