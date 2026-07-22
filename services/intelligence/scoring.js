'use strict';

/**
 * Scoring — Layer 4 of the intelligence stack.
 *
 * Takes raw Signals from Layer 3 extractors and turns them into
 * ScoredInsight objects the UI can rank. Composite score is out of 100,
 * split across five weighted dimensions:
 *
 *   confidence     30%  — how sure the extractor is
 *   freshness      15%  — how recent the underlying data is
 *   relevance      20%  — how on-topic for the *user's* business
 *   actionability  25%  — how easy it is to act on
 *   conflictRisk   -10% — subtracted if source signals disagree
 *
 * Not all five dimensions can be computed from the signal alone:
 *   - `relevance` depends on the user's own brand identity
 *   - `conflictRisk` depends on cross-source disagreement, which the
 *     orchestrator tracks as `sources` in its report
 *
 * Output tier thresholds are deliberately generous on the top end —
 * we'd rather show two good signals than eight mediocre ones.
 */

const WEIGHTS = {
  confidence: 0.30,
  freshness: 0.15,
  relevance: 0.20,
  actionability: 0.25,
  conflictRisk: -0.10,
};

const TIER_THRESHOLDS = { hero: 80, strong: 65, supporting: 45 };

/**
 * @param {Signal} signal
 * @param {object} context
 *   userBrandIdentity — the user's own brand (for relevance)
 *   collectionReport  — the orchestrator's per-source report (for conflictRisk)
 *   now               — Date (defaults to now)
 */
function scoreSignal(signal, context = {}) {
  if (!signal || !signal.kind) {
    throw new Error('scoreSignal: signal with `kind` required');
  }

  const now = context.now || new Date();

  const scores = {
    confidence: clamp01(signal.confidence ?? 0.5),
    freshness: freshnessScore(signal.extractedAt, now),
    relevance: relevanceScore(signal, context.userBrandIdentity),
    actionability: actionabilityScore(signal),
    conflictRisk: conflictRiskScore(signal, context.collectionReport),
  };

  const composite = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 *
          (scores.confidence * WEIGHTS.confidence +
            scores.freshness * WEIGHTS.freshness +
            scores.relevance * WEIGHTS.relevance +
            scores.actionability * WEIGHTS.actionability +
            scores.conflictRisk * WEIGHTS.conflictRisk),
      ),
    ),
  );

  const tier =
    composite >= TIER_THRESHOLDS.hero
      ? 'hero'
      : composite >= TIER_THRESHOLDS.strong
        ? 'strong'
        : composite >= TIER_THRESHOLDS.supporting
          ? 'supporting'
          : 'noise';

  return {
    signal,
    scores: {
      confidence: Number(scores.confidence.toFixed(3)),
      freshness: Number(scores.freshness.toFixed(3)),
      relevance: Number(scores.relevance.toFixed(3)),
      actionability: Number(scores.actionability.toFixed(3)),
      conflictRisk: Number(scores.conflictRisk.toFixed(3)),
    },
    compositeScore: composite,
    tier,
  };
}

function rankSignals(signals, context = {}) {
  return signals
    .filter(Boolean)
    .map((s) => scoreSignal(s, context))
    .filter((s) => s.tier !== 'noise')
    .sort((a, b) => b.compositeScore - a.compositeScore);
}

// ─── Individual dimension scorers ────────────────────────────────────────

function freshnessScore(extractedAt, now) {
  const t = extractedAt ? new Date(extractedAt).getTime() : 0;
  if (!t) return 0.5;
  const ageHours = Math.max(0, (now.getTime() - t) / 3600_000);
  // 1.0 for < 6h, linear decay to 0.2 by 30 days, floor at 0.1 after that.
  if (ageHours < 6) return 1;
  if (ageHours < 24 * 30) return Math.max(0.2, 1 - (ageHours - 6) / (24 * 30 - 6));
  return 0.1;
}

function relevanceScore(signal, userBrandIdentity) {
  // If we don't have the user's own brand context, treat every signal as
  // "somewhat relevant" (0.6). When we DO have it, we reward signals that
  // mention similar markets / language / business vertical.
  if (!userBrandIdentity) return 0.6;

  let score = 0.55;

  // Overlap in markets — Gulf brands scoring a Gulf competitor is more
  // relevant than a global-only competitor's insights.
  const userMarkets = new Set(userBrandIdentity.markets || []);
  const signalMarkets = new Set(signal.sourceTypes || []); // crude proxy
  if (userMarkets.size && signalMarkets.size) {
    const overlap = [...userMarkets].filter((m) => signalMarkets.has(m)).length;
    if (overlap) score += 0.1;
  }

  // Kind-specific boosts — offer_structure is always highly relevant,
  // visual_motif slightly less so (depends on creative maturity).
  const kindBoost = {
    hook_pattern: 0.12,
    offer_structure: 0.2,
    audience_angle: 0.18,
    visual_motif: 0.1,
    competitive_gap: 0.25,
    funnel_stage: 0.15,
    timing_pattern: 0.08,
  };
  score += kindBoost[signal.kind] ?? 0.1;

  return clamp01(score);
}

function actionabilityScore(signal) {
  // An actionable signal has a concrete `exampleAd` and a non-generic recommendation.
  const a = signal.actionable || {};
  let score = 0.4;
  if (a.recommendation && a.recommendation.length > 40) score += 0.2;
  if (a.exampleAd && a.exampleAd.length > 20) score += 0.2;
  if (a.estimatedImpact === 'high') score += 0.15;
  else if (a.estimatedImpact === 'medium') score += 0.08;
  if ((signal.supportingEvidence || []).length >= 3) score += 0.1;
  return clamp01(score);
}

function conflictRiskScore(signal, report) {
  if (!report) return 0;
  // Conflict risk goes UP when most sources we attempted FAILED — a signal
  // drawn from 1 source out of 5 attempted is much shakier than one drawn
  // from 4 of 5, even with the same "confidence".
  const ratio = (report.sourcesHealthy || 0) / Math.max(1, report.sourcesTotal || 1);
  if (ratio >= 0.8) return 0;         // confident multi-source agreement
  if (ratio >= 0.5) return 0.2;       // mixed — light penalty
  if (ratio >= 0.3) return 0.5;       // thin — moderate penalty
  return 0.8;                         // very thin — near-max penalty
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

module.exports = { scoreSignal, rankSignals, WEIGHTS, TIER_THRESHOLDS };
