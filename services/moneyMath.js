'use strict';

/**
 * moneyMath.js — AI-generated CPL/LTV/conversion benchmarks per scan.
 *
 * Replaces the hardcoded GULF_BENCHMARKS table. Claude looks at the brand's
 * actual context (vertical, sub-vertical, country, business model, audience,
 * average ticket signals from the scrape) and generates calibrated benchmarks
 * specific to THIS brand — not a generic "restaurant" or "real_estate" row.
 *
 * Why AI over a static table:
 *   - "Restaurant" benchmarks differ wildly between a karak QSR (LTV ~280 AED)
 *     and a fine dining destination (LTV ~3,200 AED). One static row can't
 *     model both.
 *   - LTV depends on observable signals: average ticket, repeat purchase
 *     frequency, B2B vs B2C mix. Claude reads these from the scrape.
 *   - New verticals appear constantly — automotive_marketplace,
 *     wellness_subscription, ai_saas — and Claude tags them on the fly.
 *
 * Pipeline:
 *   1. extractFinancialSignals(scan) — deterministic features from scrape
 *   2. generateBenchmarksWithAI(signals) — Claude returns calibrated numbers
 *   3. projectAtSpend(daily, benchmarks) — pure math, no AI
 *   4. fallback if AI fails — static table by businessProfile.type
 *
 * Cost: ~$0.005 per scan in Claude Haiku, cached 7 days per (domain, vertical).
 * The fallback path is fully deterministic so a Claude outage never blocks
 * the report.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getRedis } = require('./redis');

let _claude;
function getClaude() {
  if (!_claude) {
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _claude;
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001';

// ──────────────────────────────────────────────────────────────────────────
// Fallback table — used ONLY when AI fails or env var missing.
// Kept intentionally short. Real intelligence comes from Claude.
// ──────────────────────────────────────────────────────────────────────────

const FALLBACK_BENCHMARKS = {
  // Service / lead-gen verticals
  restaurant:               { avgCPC: 1.8, avgCPL: 18,  avgCTR: 0.022, avgConversionRate: 0.25, avgLTV: 280,   avgCAC: 72   },
  cafe:                     { avgCPC: 1.6, avgCPL: 15,  avgCTR: 0.024, avgConversionRate: 0.28, avgLTV: 360,   avgCAC: 54   },
  dental:                   { avgCPC: 3.2, avgCPL: 45,  avgCTR: 0.018, avgConversionRate: 0.15, avgLTV: 4800,  avgCAC: 300  },
  beauty_clinic:            { avgCPC: 3.8, avgCPL: 55,  avgCTR: 0.017, avgConversionRate: 0.12, avgLTV: 3200,  avgCAC: 458  },
  beauty_salon:             { avgCPC: 3.0, avgCPL: 42,  avgCTR: 0.018, avgConversionRate: 0.18, avgLTV: 1600,  avgCAC: 233  },
  real_estate:              { avgCPC: 8.5, avgCPL: 75,  avgCTR: 0.012, avgConversionRate: 0.04, avgLTV: 45000, avgCAC: 1875 },
  fitness:                  { avgCPC: 2.8, avgCPL: 38,  avgCTR: 0.020, avgConversionRate: 0.18, avgLTV: 1800,  avgCAC: 211  },
  automotive:               { avgCPC: 4.5, avgCPL: 95,  avgCTR: 0.015, avgConversionRate: 0.08, avgLTV: 12000, avgCAC: 1188 },
  automotive_marketplace:   { avgCPC: 1.6, avgCPL: 28,  avgCTR: 0.024, avgConversionRate: 0.18, avgLTV: 380,   avgCAC: 156  },
  saas_b2b:                 { avgCPC: 6.2, avgCPL: 145, avgCTR: 0.011, avgConversionRate: 0.06, avgLTV: 6500,  avgCAC: 2417 },
  marketing_agency:         { avgCPC: 5.5, avgCPL: 110, avgCTR: 0.012, avgConversionRate: 0.10, avgLTV: 18000, avgCAC: 1100 },

  // Health / pharmacy
  health_retail:            { avgCPC: 2.2, avgCPL: 28,  avgCTR: 0.019, avgConversionRate: 0.22, avgLTV: 1800,  avgCAC: 127  },

  // E-commerce verticals
  ecommerce_general:        { avgCPC: 2.4, avgCPL: 22,  avgCTR: 0.020, avgConversionRate: 0.10, avgLTV: 380,   avgCAC: 220  },
  ecommerce_electronics:    { avgCPC: 4.2, avgCPL: 32,  avgCTR: 0.018, avgConversionRate: 0.04, avgLTV: 5500,  avgCAC: 800  },
  ecommerce_fashion:        { avgCPC: 2.1, avgCPL: 24,  avgCTR: 0.019, avgConversionRate: 0.09, avgLTV: 520,   avgCAC: 267  },
  ecommerce_beauty:         { avgCPC: 2.6, avgCPL: 28,  avgCTR: 0.020, avgConversionRate: 0.08, avgLTV: 460,   avgCAC: 350  },
  ecommerce_grocery:        { avgCPC: 1.5, avgCPL: 14,  avgCTR: 0.024, avgConversionRate: 0.18, avgLTV: 1800,  avgCAC: 78   },
  ecommerce_home:           { avgCPC: 2.8, avgCPL: 38,  avgCTR: 0.016, avgConversionRate: 0.06, avgLTV: 1400,  avgCAC: 633  },

  default:                  { avgCPC: 3.0, avgCPL: 50,  avgCTR: 0.017, avgConversionRate: 0.10, avgLTV: 1200,  avgCAC: 500  },

  // Legacy alias kept for back-compat with older consumers.
  fashion:                  { avgCPC: 2.1, avgCPL: 24,  avgCTR: 0.019, avgConversionRate: 0.09, avgLTV: 520,   avgCAC: 267  },
};

const TYPE_MAP = {
  clinic_dental:    'dental',
  clinic_medical:   'beauty_clinic',
  clinic_cosmetic:  'beauty_clinic',
  clinic_wellness:  'fitness',
  cafe:             'cafe',
  restaurant:       'restaurant',
  real_estate:      'real_estate',
  fitness_gym:      'fitness',
  fitness_coach:    'fitness',
  beauty_salon:     'beauty_salon',
  health_retail:    'health_retail',
  automotive:       'automotive',
  saas_b2b:         'saas_b2b',
  saas_b2c:         'ecommerce_general',
  marketing_agency: 'marketing_agency',
  product_brand:    'ecommerce_general',
  general_business: 'default',
};

const SPEND_TIERS_AED = [150, 300, 1000];
const VARIANCE = 0.20; // ±20 % envelope around each AI-anchored benchmark.

// ──────────────────────────────────────────────────────────────────────────
// Stage 1 — Deterministic feature extraction from the scrape
// ──────────────────────────────────────────────────────────────────────────

function extractFinancialSignals(scan) {
  const signals = {
    domain: scan?.host || null,
    brandName: scan?.brand?.name || null,
    category: scan?.brand?.category || null,
    subcategory: scan?.research?.brand?.subcategory || null,
    vertical: scan?.businessProfile?.type || null,
    subtype: scan?.businessProfile?.subtype || null,

    audience: scan?.audience?.primary || scan?.brand?.audience || null,

    pricingSignals: extractPricingSignals(scan),

    productCount: scan?.productCatalog?.products?.length || 0,
    avgProductPrice: null,
    minProductPrice: null,
    maxProductPrice: null,

    country: 'AE',

    isB2B: /enterprise|api|developer|saas|platform|b2b/i.test(String(scan?.brand?.category || '')),
    isService: /clinic|salon|consulting|agency|firm|hospital|service/i.test(String(scan?.brand?.category || '')),

    primaryActions: (scan?.businessProfile?.primaryActions || []).map((a) => a.intent).filter(Boolean),
    funnelShape: scan?.businessProfile?.adStrategy?.funnelShape || null,

    outletMentions: extractOutletCount(scan),
  };

  if (scan?.productCatalog?.products?.length) {
    const prices = scan.productCatalog.products
      .map((p) => Number(p?.price))
      .filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length) {
      signals.avgProductPrice = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
      signals.minProductPrice = Math.min(...prices);
      signals.maxProductPrice = Math.max(...prices);
    }
  }

  return signals;
}

function extractPricingSignals(scan) {
  // Pull from intelligence collector first (richest source), then fall back
  // to anything the scraper surfaced on the brand object.
  const fromIntel = scan?.intelligence?.collection?.sources?.[0]?.data?.pricingSignals;
  if (Array.isArray(fromIntel) && fromIntel.length) return fromIntel.slice(0, 24);
  const fromBrand = scan?.brand?.pricingSignals;
  if (Array.isArray(fromBrand) && fromBrand.length) return fromBrand.slice(0, 24);
  return [];
}

function extractOutletCount(scan) {
  const text = [
    scan?.brand?.description,
    ...(scan?.brand?.paragraphs || []),
    ...(scan?.brand?.headlines || []),
  ].filter(Boolean).join(' ');
  const match = text.match(/(\d{1,3})\+?\s*(?:outlets?|branches?|locations?|stores?|clinics?|showrooms?)/i);
  return match ? parseInt(match[1], 10) : null;
}

function resolveFallbackVertical(scan) {
  const t = scan?.businessProfile?.type;
  if (t && FALLBACK_BENCHMARKS[t]) return t;
  if (t && TYPE_MAP[t]) return TYPE_MAP[t];

  const cat = String(scan?.brand?.category || scan?.research?.brand?.category || '').toLowerCase();
  if (/electronic|tech|gadget|laptop|smartphone|computer|apple/.test(cat)) return 'ecommerce_electronics';
  if (/fashion|clothing|apparel|shoe|sneaker/.test(cat)) return 'ecommerce_fashion';
  if (/beauty|skincare|cosmetic|makeup/.test(cat)) return 'ecommerce_beauty';
  if (/grocery|supermarket|fresh\s*produce/.test(cat)) return 'ecommerce_grocery';
  if (/furniture|home\s*decor|home\s*goods/.test(cat)) return 'ecommerce_home';
  if (/pharmacy|pharmacare|drugstore|chemist|otc\s*medicine|prescription/.test(cat)) return 'health_retail';
  if (/dent|dental/.test(cat)) return 'dental';
  if (/restaurant|cafe|food|karak|qsr|dining/.test(cat)) return 'restaurant';
  if (/real|property|estate/.test(cat)) return 'real_estate';
  if (/gym|fitness/.test(cat)) return 'fitness';
  if (/saas|software|b2b/.test(cat)) return 'saas_b2b';
  if (/(marketing|creative|advertising|branding)\s*(agency|studio|firm)?/.test(cat)) return 'marketing_agency';
  if (/automotive|car|vehicle/.test(cat)) return 'automotive';
  if (/shop|store|ecommerce|commerce|online\s*retail/.test(cat)) return 'ecommerce_general';
  return 'default';
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2 — Claude generates calibrated benchmarks per brand
// ──────────────────────────────────────────────────────────────────────────

async function generateBenchmarksWithAI(signals) {
  const cacheKey = `money-math:${signals.domain || 'unknown'}:${signals.vertical || 'unknown'}:v2`;
  let redis = null;
  try {
    redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      parsed._source = 'cache';
      return parsed;
    }
  } catch (_e) { /* swallow — cache best-effort only */ }

  const systemPrompt = `You are a senior performance marketing analyst specialising in MENA / Gulf advertising economics. Given a brand's observable context, you generate calibrated CPL / LTV / conversion benchmarks specific to THAT brand — not a generic vertical average.

Output ONLY valid JSON in this exact shape:
{
  "vertical": "auto-detected specific vertical, e.g. 'qsr_karak_chain' not just 'restaurant'",
  "verticalReasoning": "1-sentence why you classified this way",
  "benchmarks": {
    "avgCPC": 1.8,
    "avgCPL": 18,
    "avgCTR": 0.022,
    "avgConversionRate": 0.25,
    "avgLTV": 280,
    "avgCAC": 72
  },
  "calibrationNotes": [
    "1-2 sentences explaining how you calibrated each major number from the brand's observable signals"
  ],
  "modelingAssumptions": {
    "ltvBasis": "e.g. 'avg ticket AED 25 × 4 visits/month × 12 months × 30% retention'",
    "conversionBasis": "e.g. 'Visit-to-order conversion typical for QSR'",
    "cplBasis": "e.g. 'UAE Meta CPL for cafe lead-gen ads benchmarked against Talabat/Careem partners'"
  },
  "confidenceLevel": "high" | "medium" | "low",
  "warnings": ["any critical caveats — e.g. 'LTV depends heavily on retention which we couldn't observe'"]
}

Rules:
- All numbers MUST be in the brand's currency (AED for UAE, SAR for Saudi, etc).
- avgCPL = realistic cost-per-lead in their market and country in 2026, NOT a wishful target.
- avgConversionRate = lead-to-customer (not click-to-lead). For booking businesses use form-to-booking. For e-commerce use cart-to-purchase.
- avgLTV = realistic customer lifetime value in their market. Use observable price signals when present. For multi-location brands, factor in repeat visits.
- For QSR / coffee / karak chains: LTV is small per visit but high frequency — model 6–18 months retention.
- For luxury / HNI verticals: LTV is large but conversion is low.
- For B2B SaaS: LTV depends on contract length, weight against MRR signals.
- If you don't have enough signal, lean toward CONSERVATIVE benchmarks and flag in warnings.
- The brand and country dictate the numbers. Same vertical in different countries = different CPL, CPC, LTV.`;

  const userMessage = `Generate calibrated economics for this brand:

BRAND: ${signals.brandName || 'unknown'} (${signals.domain || 'unknown'})
CATEGORY: ${signals.category || 'unknown'}
SUBCATEGORY: ${signals.subcategory || 'unknown'}
INFERRED VERTICAL: ${signals.vertical || 'unknown'} / ${signals.subtype || 'unknown'}
COUNTRY: ${signals.country}
AUDIENCE: ${(signals.audience || 'unknown').toString().slice(0, 250)}

OBSERVABLE PRICING SIGNALS (from website scrape):
${signals.pricingSignals?.length ? signals.pricingSignals.slice(0, 12).join(', ') : 'No prices observed on landing page'}

${signals.avgProductPrice ? `AVG PRODUCT PRICE: ${signals.avgProductPrice} AED (range ${signals.minProductPrice}-${signals.maxProductPrice}, n=${signals.productCount})` : ''}

${signals.outletMentions ? `OUTLET COUNT: ${signals.outletMentions}+ locations (multi-location brand)` : ''}

PRIMARY ACTIONS: ${signals.primaryActions?.join(', ') || 'unknown'}
FUNNEL SHAPE: ${signals.funnelShape || 'unknown'}
B2B SIGNAL: ${signals.isB2B}
SERVICE BUSINESS: ${signals.isService}

Generate calibrated benchmarks for this specific brand.`;

  try {
    const response = await getClaude().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    // ✅ FIX — extract the first complete JSON object, ignore anything after }
function extractFirstJson(text) {
  // Strip markdown fences
  let s = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // Find the first { and match its closing }
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  
  if (end === -1) throw new Error('Unclosed JSON object in response');
  return JSON.parse(s.slice(start, end + 1));
}

// Then replace:
const parsed = extractFirstJson(text);  // ← safe even with trailing prose
    // const parsed = JSON.parse(cleaned);

    const b = parsed.benchmarks;
    if (!b || typeof b.avgCPL !== 'number' || typeof b.avgLTV !== 'number') {
      throw new Error('Invalid benchmarks shape from AI');
    }
    if (b.avgCPL < 1 || b.avgCPL > 5000) throw new Error(`CPL out of sanity range: ${b.avgCPL}`);
    if (b.avgLTV < 10 || b.avgLTV > 1_000_000) throw new Error(`LTV out of sanity range: ${b.avgLTV}`);
    if (b.avgConversionRate < 0.001 || b.avgConversionRate > 0.95) {
      throw new Error(`Conversion out of range: ${b.avgConversionRate}`);
    }

    parsed._source = 'ai';
    parsed._generatedAt = new Date().toISOString();

    if (redis) {
      await redis.setex(cacheKey, 604800, JSON.stringify(parsed)).catch(() => {});
    }

    return parsed;
  } catch (err) {
    console.warn('[moneyMath] AI generation failed, using fallback:', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3 — Pure math: turn benchmarks into spend-tier projections
// ──────────────────────────────────────────────────────────────────────────

function projectAtSpend(dailyBudgetAED, benchmarks) {
  const monthlySpendAED = dailyBudgetAED * 30;

  // Use CPL directly when we have it; back-compute from CPC×CTR otherwise.
  const cplAnchor = Number.isFinite(benchmarks.avgCPL) && benchmarks.avgCPL > 0
    ? benchmarks.avgCPL
    : (benchmarks.avgCPC || 1) / Math.max(0.0001, benchmarks.avgCTR || 0.02);

  const cplLow  = cplAnchor * (1 - VARIANCE);
  const cplHigh = cplAnchor * (1 + VARIANCE);

  // Inverse relation: tighter (low) CPL → MORE leads.
  const leadsLow  = monthlySpendAED / cplHigh;
  const leadsHigh = monthlySpendAED / cplLow;

  const convLow  = (benchmarks.avgConversionRate || 0) * (1 - VARIANCE);
  const convHigh = (benchmarks.avgConversionRate || 0) * (1 + VARIANCE);

  const customersLow  = leadsLow  * convLow;
  const customersHigh = leadsHigh * convHigh;

  const ltvLow  = (benchmarks.avgLTV || 0) * (1 - VARIANCE);
  const ltvHigh = (benchmarks.avgLTV || 0) * (1 + VARIANCE);

  const revenueLow  = customersLow  * ltvLow;
  const revenueHigh = customersHigh * ltvHigh;

  return {
    dailySpendAED: dailyBudgetAED,
    monthlySpendAED,
    expectedLeads: {
      low:  Math.max(0, Math.round(leadsLow)),
      high: Math.max(0, Math.round(leadsHigh)),
    },
    expectedCustomers: {
      // Keep one decimal under 10 so a "0.4 customers/mo" tier still tells the truth.
      low:  Math.max(0, Math.round(customersLow  * 10) / 10),
      high: Math.max(0, Math.round(customersHigh * 10) / 10),
    },
    expectedRevenue: {
      low:  Math.max(0, Math.round(revenueLow)),
      high: Math.max(0, Math.round(revenueHigh)),
    },
    expectedROAS: {
      low:  monthlySpendAED > 0 ? Math.round((revenueLow  / monthlySpendAED) * 100) / 100 : 0,
      high: monthlySpendAED > 0 ? Math.round((revenueHigh / monthlySpendAED) * 100) / 100 : 0,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 4 — Public API: computeMoneyMath
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} scan — UrlToAdsScan doc (lean or hydrated)
 * @returns {Promise<object>}
 */
async function computeMoneyMath(scan) {
  const signals = extractFinancialSignals(scan);
  const fallbackVertical = resolveFallbackVertical(scan);
  const fallbackBenchmarks = FALLBACK_BENCHMARKS[fallbackVertical] || FALLBACK_BENCHMARKS.default;

  // Try AI first (cheap + cached). Falls back silently on any failure.
  let aiResult = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      aiResult = await generateBenchmarksWithAI(signals);
    } catch (err) {
      console.warn('[moneyMath] AI path threw:', err.message);
    }
  }

  const benchmarks = (aiResult && aiResult.benchmarks) || fallbackBenchmarks;
  const vertical = aiResult?.vertical || fallbackVertical;

  const projections = SPEND_TIERS_AED.map((tier) => projectAtSpend(tier, benchmarks));

  return {
    vertical,
    verticalReasoning: aiResult?.verticalReasoning
      || `Hardcoded fallback for ${fallbackVertical} (AI calibration unavailable)`,
    benchmarks,
    projections,
    calibrationNotes: aiResult?.calibrationNotes || [
      `Using static ${fallbackVertical} benchmarks. Run a 14-day test campaign to calibrate against your own numbers.`,
    ],
    modelingAssumptions: aiResult?.modelingAssumptions || {
      ltvBasis: 'Industry average for vertical',
      conversionBasis: 'Industry average lead-to-customer rate',
      cplBasis: 'UAE Meta benchmark for vertical',
    },
    confidenceLevel: aiResult?.confidenceLevel || 'low',
    warnings: aiResult?.warnings || [
      'These are generic Gulf benchmarks. Real numbers diverge ±50% based on creative quality, audience targeting, and offer.',
    ],
    source: aiResult?._source || 'fallback',
    generatedAt: new Date(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────

module.exports = {
  computeMoneyMath,

  // Lower-level pieces, exposed for testing + reuse
  extractFinancialSignals,
  generateBenchmarksWithAI,
  projectAtSpend,
  resolveFallbackVertical,

  // Constants
  FALLBACK_BENCHMARKS,
  SPEND_TIERS_AED,

  // Legacy alias kept so any older callers still resolve.
  GULF_BENCHMARKS: FALLBACK_BENCHMARKS,
  TYPE_MAP,
  resolveVertical: resolveFallbackVertical,
};
