'use strict';

/**
 * roastEngine.js — AI-driven "brutal truth" generator for the URL→Ads scan.
 *
 * Why this exists:
 *   The scan record carries dozens of signals — competitor ratings vs. own
 *   ratings, missing social handles, dormant ad accounts, low review counts,
 *   overlapping competitor positioning. None of those signals individually
 *   sells the AED 999 / month plan. Surfacing them as a brutally honest
 *   2–4-insight panel ("Your Deira outlet is at 1.6★ with 113 reviews —
 *   public reputation problem costing you ~AED 14k/mo in lost orders") is
 *   what turns the report into something a founder forwards to their
 *   ops lead.
 *
 * Pipeline:
 *   1. extractRoastSignals(scan)        — deterministic feature pull
 *   2. generateRoastWithAI(signals)     — Claude returns 2-4 insights
 *   3. fallback                         — heuristic insights if AI fails
 *
 * Cost: ~$0.01 per scan (Claude Haiku, ~2k input + 1k output tokens).
 * Cached per (scan id, content hash) for 24h so re-opens are free.
 */

const crypto = require('crypto');
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
// Stage 1 — Pull the structured signals Claude needs (deterministic)
// ──────────────────────────────────────────────────────────────────────────

/**
 * brandIdentity.handles uses *Handle / *Url / *PageUrl field names
 * (instagramHandle, facebookPageUrl, youtubeChannel, …).
 * Older tests and some callers used shorthand keys (instagram, facebook).
 * Roast "channel gaps" must treat either shape as "present".
 */
function hasSocialChannelPresence(platform, handles) {
  const h = handles && typeof handles === 'object' ? handles : {};
  switch (platform) {
    case 'instagram':
      return !!(
        h.instagram ||
        h.instagramHandle ||
        (typeof h.instagramUrl === 'string' && h.instagramUrl.length > 4)
      );
    case 'facebook':
      return !!(
        h.facebook ||
        h.facebookHandle ||
        (typeof h.facebookPageUrl === 'string' && h.facebookPageUrl.length > 4) ||
        h.facebookPageId
      );
    case 'youtube':
      return !!(
        h.youtube ||
        h.youtubeChannel ||
        (typeof h.youtubeUrl === 'string' && h.youtubeUrl.length > 4)
      );
    case 'twitter':
      return !!(
        h.twitter ||
        h.twitterHandle ||
        (typeof h.twitterUrl === 'string' && h.twitterUrl.length > 4)
      );
    case 'tiktok':
      return !!(
        h.tiktok ||
        h.tiktokHandle ||
        (typeof h.tiktokUrl === 'string' && h.tiktokUrl.length > 4)
      );
    default:
      return false;
  }
}

function extractRoastSignals(scan) {
  const ownDomain = (scan?.host || '').toLowerCase().replace(/^www\./, '');
  const ownBrandSlug = (scan?.brand?.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  // Walk the Google Maps results and split them into:
  //   ownOutlets    — listings that ARE this brand (own reputation signal)
  //   competitors   — listings that are NOT this brand (rival benchmark)
  const places = Array.isArray(scan?.apifyData?.googleMapsPlaces)
    ? scan.apifyData.googleMapsPlaces
    : [];

  const ownOutlets = [];
  const placeCompetitors = [];
  for (const p of places) {
    if (!p || !p.name) continue;
    const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    let leadDomain = '';
    if (p.website) {
      try { leadDomain = new URL(p.website).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* noop */ }
    }
    const isOwn =
      (ownBrandSlug.length >= 3 && slug.includes(ownBrandSlug)) ||
      (ownDomain.length >= 3 && leadDomain && leadDomain.includes(ownDomain));
    if (isOwn) ownOutlets.push(p);
    else placeCompetitors.push(p);
  }

  const ownOutletStats = ownOutlets.length
    ? {
        count: ownOutlets.length,
        avgRating: avg(ownOutlets.map((o) => o.rating).filter(Number.isFinite)),
        worstOutlet: minBy(ownOutlets.filter((o) => Number.isFinite(o.rating)), (o) => o.rating),
        bestOutlet:  maxBy(ownOutlets.filter((o) => Number.isFinite(o.rating)), (o) => o.rating),
        totalReviews: sum(ownOutlets.map((o) => o.reviewsCount || 0)),
        outletsBelow3Stars: ownOutlets.filter((o) => Number.isFinite(o.rating) && o.rating < 3).length,
      }
    : null;

  // Top 3 strongest place-competitors (by review count) for benchmark.
  const topPlaceCompetitors = placeCompetitors
    .filter((p) => Number.isFinite(p.rating) && (p.reviewsCount || 0) >= 20)
    .sort((a, b) => (b.reviewsCount || 0) - (a.reviewsCount || 0))
    .slice(0, 3)
    .map((p) => ({
      name: p.name,
      rating: p.rating,
      reviews: p.reviewsCount || 0,
      address: p.address || null,
    }));

  // Competitor ad spend signal (post-AI shape: per-competitor result objects)
  const competitorAds = scan?.apifyData?.competitorAds;
  const summary = scan?.apifyData?.competitorAdsSummary || null;
  const competitorAdActivity = Array.isArray(competitorAds)
    ? competitorAds.map((row) => ({
        competitor: row.competitor || row.competitorName || 'Competitor',
        adCount: Array.isArray(row.ads) ? row.ads.length : 0,
        winners: Array.isArray(row.ads) ? row.ads.filter((a) => a?.intelligence?.isWinner).length : 0,
        successfulStrategy: row.successfulStrategy || null,
        error: row.error || null,
      }))
    : [];

  // Brand-identity / handles / social-presence gaps
  // const handles = scan?.intelligence?.brandIdentity?.handles || {};
  const handles = {
    ...(scan?.brand?.socialHandles || {}),
    ...(scan?.intelligence?.brandIdentity?.handles || {}),
  };
  const handleGaps = ['instagram', 'tiktok', 'youtube', 'twitter', 'facebook'].filter(
    (k) => !hasSocialChannelPresence(k, handles),
  );

  // Money-math signal
  const moneyMath = scan?.moneyMath
    ? {
        vertical: scan.moneyMath.vertical,
        cpl: scan.moneyMath.benchmarks?.avgCPL,
        ltv: scan.moneyMath.benchmarks?.avgLTV,
        confidence: scan.moneyMath.confidenceLevel,
        warnings: scan.moneyMath.warnings || [],
      }
    : null;

  // Battlefield report (Layer 5) — competitor counter-strategy if available
  const battlefield = scan?.intelligence?.battlefieldReport
    ? {
        topGaps:        (scan.intelligence.battlefieldReport.gaps || []).slice(0, 4),
        winningAngles:  (scan.intelligence.battlefieldReport.winningAngles || []).slice(0, 4),
      }
    : null;

  return {
    brandName: scan?.brand?.name || scan?.host || 'this brand',
    domain: ownDomain || null,
    vertical: scan?.businessProfile?.type || scan?.brand?.category || 'unknown',
    audience: scan?.audience?.primary || scan?.brand?.audience || null,

    ownOutletStats,
    topPlaceCompetitors,
    competitorAdActivity,
    handleGaps,
    moneyMath,
    battlefield,

    competitors: (scan?.competitors || [])
      .slice(0, 6)
      .map((c) => ({
        name: c.name,
        rating: c.rating || null,
        reviews: c.reviewsCount || null,
        differentiator: c.differentiator || null,
      })),
  };
}

function avg(arr) {
  if (!arr || !arr.length) return null;
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10;
}
function sum(arr) { return arr.reduce((s, x) => s + (Number(x) || 0), 0); }
function minBy(arr, f) { return arr.length ? arr.reduce((a, b) => (f(b) < f(a) ? b : a)) : null; }
function maxBy(arr, f) { return arr.length ? arr.reduce((a, b) => (f(b) > f(a) ? b : a)) : null; }

// ──────────────────────────────────────────────────────────────────────────
// Stage 2 — Claude generates 2-4 brutal-truth insights
// ──────────────────────────────────────────────────────────────────────────

// Extracts the first complete {...} block from a Claude response,
// ignoring any prose that Claude appends after the closing brace.
// This is the canonical fix for "Unexpected non-whitespace character after JSON".
function extractFirstJsonObject(text) {
  if (!text) return '';
  // Strip markdown fences first
  const stripped = text.replace(/```json\s*/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return stripped.slice(start); // partial — will fail JSON.parse, caught upstream
}

function signalsHash(signals) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(signals))
    .digest('hex')
    .slice(0, 16);
}

async function generateRoastWithAI(signals) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const cacheKey = `roast:${signals.domain || 'unknown'}:${signalsHash(signals)}`;
  let redis = null;
  try {
    redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      parsed._source = 'cache';
      return parsed;
    }
  } catch (_e) { /* best-effort cache */ }

  const systemPrompt = `You are a brutally honest growth consultant reviewing a brand's marketing scan. You produce 2-4 sharp, specific, evidence-backed insights that the user paying AED 999/month deserves to hear — not generic "improve your branding" platitudes.

Output ONLY valid JSON in this exact shape:
{
  "insights": [
    {
      "severity": "critical" | "high" | "opportunity",
      "category": "short label, e.g. 'Reputation', 'Competitor moat', 'Channel gap', 'Spend leak', 'Positioning'",
      "headline": "1-sentence punchline. Quote real numbers from the data. Be specific.",
      "body": "2-3 sentences explaining what the data says, why it matters, and the consequence. Reference specific competitors, outlet names, ratings, etc. that the user can verify.",
      "metrics": [
        { "label": "short label", "value": "string with units, e.g. '1.6★ (113 reviews)' or 'AED 14k/mo'" }
      ],
      "estimatedCost": "optional — '~AED 14,000/mo in lost orders' style. Omit if you can't estimate.",
      "fixPrompt": "A copy-paste-ready prompt the user can hand to a copywriter / agency / Claude to produce the fix. 1-3 sentences max.",
      "fixLabel": "Short button text, e.g. 'Generate apology + recovery email'"
    }
  ]
}

Rules:
Competitive insights are directional observations based on visible ad activity and supporting signals, not measured performance metrics. These insights describe patterns that may indicate what a brand is prioritizing, but they do not confirm results such as CTR, CAC, conversions, or spend.

- Insights should focus on:
  - Repetition signals: creatives, hooks, offers, or messages that appear repeatedly may indicate continued usage or testing emphasis.
  - Creative strategy patterns: mix of video, testimonials, offers, education, UGC, or product-led messaging.
  - Operational intensity: number of live ads can suggest breadth of testing or segmentation activity, but not effectiveness.
  - Cross-signal alignment: when messaging themes align with strong review volume, ratings, or broader market positioning, they may represent themes worth investigating further.

- Avoid statements such as: "Winning ads", "top-performing creatives", "highest converting campaign", "AED X spend", or any implied measured outcome unless supported by actual performance data.
- 2-4 insights total. Quality over quantity.
- "critical" = revenue leak or reputation damage happening RIGHT NOW.
- "high" = visible competitive disadvantage that will compound.
- "opportunity" = positive signal with an obvious unlock.
- Every headline MUST quote a real number from the input data — no vague claims.
- Never accuse the user of laziness. Be candid, not condescending.
- If the scan has the user's OWN outlets with bad ratings, that's almost always the #1 critical insight.
- If competitors have visibly more / longer-running ads, that's a high-severity insight.
- If the user is missing an obvious channel (TikTok for QSR, Instagram for beauty, LinkedIn for B2B), call it out.
- Skip insights you don't have evidence for. Don't pad to hit 4.
- NEVER generate insights about data that is missing or unavailable (e.g. "competitors not found in Ad Library", "no Meta ads detected"). Missing data is not a finding — skip it.
- The fixPrompt should be specific enough that pasting it into Claude produces a usable first draft.`;

  const userMessage = `Generate brutal-truth insights for this brand scan.

BRAND: ${signals.brandName} (${signals.domain || 'unknown domain'})
VERTICAL: ${signals.vertical}
AUDIENCE: ${(signals.audience || 'unknown').toString().slice(0, 200)}

OWN OUTLETS (Google Maps reputation signal):
${signals.ownOutletStats
  ? `- ${signals.ownOutletStats.count} outlets, avg rating ${signals.ownOutletStats.avgRating}★, ${signals.ownOutletStats.totalReviews} total reviews
- Outlets below 3★: ${signals.ownOutletStats.outletsBelow3Stars}
${signals.ownOutletStats.worstOutlet ? `- WORST outlet: "${signals.ownOutletStats.worstOutlet.name}" — ${signals.ownOutletStats.worstOutlet.rating}★ (${signals.ownOutletStats.worstOutlet.reviewsCount || 0} reviews) at ${signals.ownOutletStats.worstOutlet.address || 'unknown location'}` : ''}
${signals.ownOutletStats.bestOutlet ? `- BEST outlet: "${signals.ownOutletStats.bestOutlet.name}" — ${signals.ownOutletStats.bestOutlet.rating}★ (${signals.ownOutletStats.bestOutlet.reviewsCount || 0} reviews)` : ''}`
  : 'No own-outlet data found in the scan.'}

TOP LOCAL COMPETITORS (Google Maps benchmarks):
${signals.topPlaceCompetitors.length
  ? signals.topPlaceCompetitors
      .map((c) => `- "${c.name}" — ${c.rating}★ (${c.reviews} reviews) at ${c.address || 'unknown location'}`)
      .join('\n')
  : 'No local-competitor data found.'}

COMPETITOR AD ACTIVITY (Meta Ad Library):
${signals.competitorAdActivity.length
  ? signals.competitorAdActivity
      .map((c) => `- ${c.competitor}: ${c.adCount} live ads${c.winners ? ` (${c.winners} AI-flagged winners)` : ''}${c.error ? ` — failed to resolve: ${c.error}` : ''}`)
      .join('\n')
  : 'No competitor ad data found.'}

CHANNEL GAPS (no public handle detected):
${signals.handleGaps.length ? signals.handleGaps.join(', ') : 'None — all major channels covered.'}

MONEY MATH:
${signals.moneyMath
  ? `- Vertical: ${signals.moneyMath.vertical} (confidence: ${signals.moneyMath.confidence})
- Modeled CPL: AED ${signals.moneyMath.cpl}, modeled LTV: AED ${signals.moneyMath.ltv}
- Caveats: ${signals.moneyMath.warnings.join(' | ') || 'none'}`
  : 'No money math computed.'}

BATTLEFIELD INTELLIGENCE:
${signals.battlefield
  ? `- Identified gaps: ${signals.battlefield.topGaps.join(' | ') || 'none'}
- Winning angles in market: ${signals.battlefield.winningAngles.join(' | ') || 'none'}`
  : 'No battlefield report.'}

ANTHROPIC-RESEARCHED COMPETITORS:
${signals.competitors.length
  ? signals.competitors.map((c) => `- ${c.name}${c.rating ? ` (${c.rating}★, ${c.reviews} reviews)` : ''}${c.differentiator ? ` — ${c.differentiator.slice(0, 100)}` : ''}`).join('\n')
  : 'None.'}

Generate 2-4 brutal-truth insights. Quote real numbers. No fluff.`;

  try {
    const response = await getClaude().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 3500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content?.[0]?.text || '';
    const parsed = JSON.parse(extractFirstJsonObject(text));

    if (!parsed || !Array.isArray(parsed.insights)) {
      throw new Error('Invalid roast shape from AI');
    }

    // Validate + sanitize each insight; drop malformed ones rather than fail.
    const cleanInsights = parsed.insights
      .filter((i) => i && typeof i.headline === 'string' && i.headline.length > 5)
      .slice(0, 4)
      .map((i) => ({
        severity: ['critical', 'high', 'opportunity'].includes(i.severity) ? i.severity : 'high',
        category: typeof i.category === 'string' ? i.category.slice(0, 80) : 'Insight',
        headline: i.headline.slice(0, 240),
        body: typeof i.body === 'string' ? i.body.slice(0, 800) : '',
        metrics: Array.isArray(i.metrics)
          ? i.metrics
              .filter((m) => m && typeof m.label === 'string' && m.value != null)
              .slice(0, 3)
              .map((m) => ({ label: m.label.slice(0, 40), value: String(m.value).slice(0, 60) }))
          : [],
        estimatedCost: typeof i.estimatedCost === 'string' && i.estimatedCost.length
          ? i.estimatedCost.slice(0, 200)
          : null,
        fixPrompt: typeof i.fixPrompt === 'string' ? i.fixPrompt.slice(0, 1200) : '',
        fixLabel: typeof i.fixLabel === 'string' && i.fixLabel.length
          ? i.fixLabel.slice(0, 60)
          : 'Generate the fix',
      }));

    if (cleanInsights.length === 0) throw new Error('No valid insights from AI');

    const result = {
      insights: cleanInsights,
      _source: 'ai',
      _generatedAt: new Date().toISOString(),
    };

    if (redis) {
      await redis.setex(cacheKey, 86400, JSON.stringify(result)).catch(() => {});
    }
    return result;
  } catch (err) {
    console.warn('[roastEngine] AI generation failed, using fallback:', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3 — Heuristic fallback (deterministic, never throws)
// ──────────────────────────────────────────────────────────────────────────

function fallbackInsights(signals) {
  const out = [];

  if (signals.ownOutletStats?.outletsBelow3Stars > 0 && signals.ownOutletStats.worstOutlet) {
    const w = signals.ownOutletStats.worstOutlet;
    out.push({
      severity: 'critical',
      category: 'Reputation',
      headline: `${w.name} is sitting at ${w.rating}★ on Google with ${w.reviewsCount || 0} public reviews.`,
      body: `Across your ${signals.ownOutletStats.count} outlets the average rating is ${signals.ownOutletStats.avgRating}★. Every paid click that lands on this location loses trust before the visit even happens.`,
      metrics: [
        { label: 'Worst outlet', value: `${w.rating}★ (${w.reviewsCount || 0})` },
        { label: 'Avg across outlets', value: `${signals.ownOutletStats.avgRating}★` },
      ],
      estimatedCost: null,
      fixPrompt: `Write a 5-step Google reviews recovery plan for "${w.name}" currently at ${w.rating}★ with ${w.reviewsCount || 0} reviews. Cover: reply templates for the worst 5 reviews, an in-store QR card driving happy customers to leave reviews, and a 30-day target rating.`,
      fixLabel: 'Generate recovery plan',
    });
  }

  if (signals.topPlaceCompetitors.length && signals.ownOutletStats) {
    const best = signals.topPlaceCompetitors[0];
    if (best.rating >= 4 && (signals.ownOutletStats.avgRating || 0) < best.rating - 0.4) {
      out.push({
        severity: 'high',
        category: 'Competitive moat',
        headline: `${best.name} is at ${best.rating}★ with ${best.reviews} reviews — you're at ${signals.ownOutletStats.avgRating}★.`,
        body: `Your closest local rival has more reputation moat than you do. Customers comparing on Google Maps will pick them by default.`,
        metrics: [
          { label: 'Their rating', value: `${best.rating}★ (${best.reviews})` },
          { label: 'Your avg', value: `${signals.ownOutletStats.avgRating}★` },
        ],
        estimatedCost: null,
        fixPrompt: `My local competitor "${best.name}" is at ${best.rating}★ with ${best.reviews} reviews. My average is ${signals.ownOutletStats.avgRating}★. Write me 3 angles I can use in Meta ads that turn this gap into a strength rather than ignore it.`,
        fixLabel: 'Generate counter-positioning',
      });
    }
  }

  if (signals.handleGaps.length >= 2) {
    out.push({
      severity: 'opportunity',
      category: 'Channel gap',
      headline: `No public presence on ${signals.handleGaps.join(', ')}.`,
      body: `Your competitors index on these channels. Even a single weekly post would give Meta and Google more brand-anchor signal to lift your ad relevance scores.`,
      metrics: [{ label: 'Missing channels', value: String(signals.handleGaps.length) }],
      estimatedCost: null,
      fixPrompt: `Build me a 14-day content plan for ${signals.handleGaps.join(' and ')} for ${signals.brandName} (${signals.vertical}). 3 posts per channel, each with hook, body, and CTA.`,
      fixLabel: 'Generate channel plan',
    });
  }

  // Note: "Spend invisibility" (all competitors have 0 ads) is NOT a brutal truth —
  // it's a data gap. Removed so the panel isn't shown when competitor ad data is simply
  // unavailable. The competitor ads section already surfaces this with its own error state.

  return { insights: out.slice(0, 4), _source: 'fallback', _generatedAt: new Date().toISOString() };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 4 — Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} scan — UrlToAdsScan doc (lean or hydrated)
 * @returns {Promise<{insights: Array, source: string, generatedAt: Date}>}
 */
async function generateRoast(scan) {
  const signals = extractRoastSignals(scan);

  let aiResult = null;
  try {
    aiResult = await generateRoastWithAI(signals);
  } catch (err) {
    console.warn('[roastEngine] AI path threw:', err.message);
  }

  const result = aiResult || fallbackInsights(signals);

  return {
    insights: result.insights,
    source: result._source || 'fallback',
    generatedAt: new Date(),
  };
}

module.exports = {
  generateRoast,

  // Lower-level pieces, exposed for testing
  extractRoastSignals,
  generateRoastWithAI,
  fallbackInsights,
  extractFirstJsonObject,
};
