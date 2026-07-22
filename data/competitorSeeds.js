'use strict';

/**
 * competitorSeeds — REMOVED in 2026-04 rewrite.
 *
 * We no longer ship a hardcoded Gulf competitor seed list. Competitors
 * are now inferred per-URL by Anthropic via `services/aiResearch.js` and
 * persisted on the `UrlToAdsScan.competitors` field. This keeps the
 * architecture scalable (every scan gets researched competitors specific
 * to the scanned brand) and removes stale data risk.
 *
 * This module is kept as a stub that returns an empty array so any
 * straggling `require` keeps booting, but new code MUST NOT depend on it.
 */

const DEPRECATION =
  '[competitorSeeds] DEPRECATED: this module is a no-op stub. ' +
  'Use services/aiResearch.js → researchBrand() for per-URL competitors.';

function getCompetitors(/* category, limit */) {
  // Log once — avoid spamming when a retry loop hits this.
  if (!getCompetitors._warned) {
    getCompetitors._warned = true;
    console.warn(DEPRECATION);
  }
  return [];
}

module.exports = { COMPETITORS: {}, getCompetitors };
