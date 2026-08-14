'use strict';

/**
 * pipeline — the top-level orchestration of the 5-layer intelligence stack.
 *
 * Public API (this is what callers — urlToAdsService, workers, admin tools —
 * consume):
 *
 *   runIntelligenceRun({ url, brandIdentity?, userBrandIdentity?, userId?,
 *                        triggeredBy?, useLlm?, persist? })
 *
 *   buildDefaultOrchestrator({ cache? })
 *     → returns a CollectionOrchestrator with Qumak's default set of
 *       collectors. Exported so callers can override for tests.
 *
 * The pipeline is idempotent and safe to call concurrently: each run gets
 * its own CollectionRun document (when `persist !== false`), and all cache
 * reads/writes are keyed by collector+brand+day.
 *
 * When `persist === false` (tests, dry-runs), nothing is written to Mongo
 * and the function returns the in-memory report only.
 */

const { resolveBrandIdentity } = require('./brandIdentity');
const { CollectionOrchestrator } = require('./orchestrator');
const { extractHookPatterns } = require('./extractors/hookPattern');
const { extractOfferStructure } = require('./extractors/offerStructure');
const { rankSignals } = require('./scoring');
const { composeBattlefieldReport } = require('./composer');

const { PublicFacebookPageCollector } = require('./collectors/publicFacebookPage');
const { GoogleSerpCollector } = require('./collectors/googleSerp');
const { LandingPageCollector } = require('./collectors/landingPageCrawler');
const { MetaAdLibraryCollector } = require('./collectors/metaAdLibrary');
const { TikTokCreativeCenterCollector } = require('./collectors/tiktokCreativeCenter');

let _defaultOrchestrator = null;

/**
 * Build (or reuse) the default orchestrator wired with all 5 Phase-1/2/3
 * collectors. The orchestrator is a singleton per process because opossum
 * circuit breakers are stateful and we want that state to survive across
 * requests on the same node.
 */
function buildDefaultOrchestrator({ cache = null, logger = console } = {}) {
  if (_defaultOrchestrator) return _defaultOrchestrator;
  const collectors = [
    new LandingPageCollector({ cache }),
    new GoogleSerpCollector({ cache }),
    new PublicFacebookPageCollector({ cache }),
    new MetaAdLibraryCollector({ cache }),
    new TikTokCreativeCenterCollector({ cache }),
  ];
  _defaultOrchestrator = new CollectionOrchestrator(collectors, {
    logger,
    breakerTimeoutMs: 25_000,
  });
  return _defaultOrchestrator;
}

function _resetOrchestratorForTests() {
  _defaultOrchestrator = null;
}

/**
 * @param {object} opts
 *   url                — input URL (required unless brandIdentity provided)
 *   brandIdentity      — precomputed identity (skips resolver; used by workers)
 *   userBrandIdentity  — the calling user's own brand (for relevance scoring)
 *   userId             — for CollectionRun ownership
 *   triggeredBy        — 'scan' | 'refresh' | 'background' | 'manual'
 *   useLlm             — defaults true; set false for tests/offline
 *   persist            — defaults true; set false to skip Mongo writes
 *   orchestrator       — override for tests
 *   cache              — optional cache adapter passed to collectors
 *
 * Returns:
 *   {
 *     brandIdentity,       — resolved or reused
 *     collectionReport,    — orchestrator output
 *     signals: [Signal],   — raw extracted signals
 *     scoredInsights,      — ranked ScoredInsight[]
 *     battlefieldReport,   — the user-facing report
 *     persisted: { brandId, collectionRunId, signalIds }  — when persist:true
 *   }
 */
async function runIntelligenceRun(opts = {}) {
  const {
    url,
    userBrandIdentity = null,
    userId = null,
    triggeredBy = 'scan',
    useLlm = true,
    persist = true,
    orchestrator: injectedOrchestrator,
    cache = null,
  } = opts;

  // ── Layer 1 ──────────────────────────────────────────────────────────────
  let brandIdentity = opts.brandIdentity;
  if (!brandIdentity) {
    if (!url) throw new Error('runIntelligenceRun: url or brandIdentity required');
    brandIdentity = await resolveBrandIdentity(url, {
      fetchVerify: useLlm !== false,
      llmDisambiguate: useLlm !== false,
    });
  }

  // Persist / reuse the dedup Brand record.
  let brandDoc = null;
  if (persist) {
    brandDoc = await upsertBrandFromIdentity(brandIdentity);
  }

  // ── Layer 2 ──────────────────────────────────────────────────────────────
  const orchestrator = injectedOrchestrator || buildDefaultOrchestrator({ cache });
  const collectionReport = await orchestrator.collectAll(brandIdentity);

  let collectionRunDoc = null;
  if (persist && brandDoc) {
    collectionRunDoc = await persistCollectionRun({
      brandDoc,
      collectionReport,
      userId,
      triggeredBy,
    });
  }

  // ── Layer 3 ──────────────────────────────────────────────────────────────
  const signalCandidates = await Promise.all([
    extractHookPatterns(collectionReport.mergedData, { useLlm }).catch(() => null),
    Promise.resolve(extractOfferStructure(collectionReport.mergedData)),
  ]);
  const signals = signalCandidates.filter(Boolean);

  let signalDocs = [];
  if (persist && brandDoc && signals.length) {
    signalDocs = await persistSignals(brandDoc._id, signals);
  }

  // ── Layer 4 ──────────────────────────────────────────────────────────────
  const scoredInsights = rankSignals(signals, {
    userBrandIdentity,
    collectionReport,
  });

  // ── Layer 5 ──────────────────────────────────────────────────────────────
  const battlefieldReport = await composeBattlefieldReport(
    {
      brandIdentity,
      scoredInsights,
      collectionReport,
      userBrandIdentity,
    },
    { useLlm },
  );

  // Cache the latest strategy on the Brand doc so re-opens don't re-run.
  if (persist && brandDoc) {
    brandDoc.lastStrategy = battlefieldReport.counterStrategy;
    brandDoc.lastStrategyAt = new Date();
    brandDoc.lastCollection = {
      sourcesHealthy: collectionReport.sourcesHealthy,
      sourcesTotal: collectionReport.sourcesTotal,
      coverageScore: collectionReport.coverageScore,
      at: collectionReport.completedAt,
    };
    brandDoc.lastEnrichedAt = new Date();
    brandDoc.nextEnrichAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await brandDoc.save();
  }

  if (persist && collectionRunDoc && signalDocs.length) {
    collectionRunDoc.signalsGenerated = signalDocs.map((d) => d._id);
    collectionRunDoc.status = 'complete';
    collectionRunDoc.completedAt = new Date();
    collectionRunDoc.durationMs =
      collectionRunDoc.completedAt.getTime() - collectionRunDoc.startedAt.getTime();
    await collectionRunDoc.save();
  }

  return {
    brandIdentity,
    collectionReport,
    signals,
    scoredInsights,
    battlefieldReport,
    persisted: persist
      ? {
          brandId: brandDoc?._id || null,
          collectionRunId: collectionRunDoc?._id || null,
          signalIds: signalDocs.map((d) => d._id),
        }
      : null,
  };
}

// ─── Persistence helpers ──────────────────────────────────────────────────

async function upsertBrandFromIdentity(identity) {
  const Brand = require('../../model/schema/brand');
  const canonicalDomain = identity.canonicalDomain;
  if (!canonicalDomain) return null;

  let brand = await Brand.findOne({ canonicalDomain });
  if (!brand) {
    brand = new Brand({
      canonicalDomain,
      brandName: identity.brandName,
      aliases: identity.aliases || [],
      markets: identity.markets || [],
      languages: identity.languages || [],
      handles: identity.handles || {},
      knownLandingDomains: identity.knownLandingDomains || [],
      identity,
      resolvedAt: identity.resolvedAt || new Date(),
      nextEnrichAt: identity.nextRefreshAt,
    });
  } else {
    // Only mutate fields that have fresh/better evidence. Preserve prior
    // identity graph otherwise (so background enrichment is additive).
    brand.brandName = identity.brandName || brand.brandName;
    brand.aliases = mergeUnique(brand.aliases, identity.aliases);
    brand.markets = mergeUnique(brand.markets, identity.markets);
    brand.languages = mergeUnique(brand.languages, identity.languages);
    brand.handles = { ...(brand.handles || {}), ...(identity.handles || {}) };
    brand.knownLandingDomains = mergeUnique(
      brand.knownLandingDomains,
      identity.knownLandingDomains,
    );
    brand.identity = identity;
    brand.resolvedAt = identity.resolvedAt || brand.resolvedAt;
  }
  await brand.save();
  return brand;
}

async function persistCollectionRun({ brandDoc, collectionReport, userId, triggeredBy }) {
  const CollectionRun = require('../../model/schema/collectionRun');
  const doc = new CollectionRun({
    brandId: brandDoc._id,
    userId: userId || null,
    triggeredBy,
    startedAt: collectionReport.startedAt,
    durationMs: collectionReport.durationMs,
    // Strip raw `data` blobs — they can be tens of MB for a TikTok response.
    // Raw scraped payloads belong in rawCollectionData (compressed + TTL'd),
    // not here. This collection is for ops dashboards; keep it small.
    sources: collectionReport.sources.map((s) => ({
      source: s.source,
      status: s.status,
      durationMs: s.durationMs || 0,
      fromCache: !!s.fromCache,
      reason: s.reason || null,
      recordsCollected: s.recordsCollected || 0,
    })),
    sourcesAttempted: collectionReport.sources.map((s) => s.source),
    sourcesSucceeded: collectionReport.sources.filter((s) => s.status === 'ok').map((s) => s.source),
    coverageScore: collectionReport.coverageScore,
    status: 'running',
  });
  await doc.save();
  return doc;
}

async function persistSignals(brandId, signals) {
  const BrandSignal = require('../../model/schema/brandSignal');
  const docs = await BrandSignal.insertMany(
    signals.map((s) => ({
      brandId,
      kind: s.kind,
      extractorVersion: s.extractorVersion || '1.0.0',
      confidence: s.confidence || 0,
      compositeScore: 0, // Layer-4 composite is applied on read — we don't persist it here
      tier: 'supporting',
      sourceTypes: s.sourceTypes || [],
      payload: s,
      extractedAt: s.extractedAt || new Date(),
    })),
  );
  return docs;
}

function mergeUnique(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const v of [...a, ...b]) {
    if (v == null || v === '') continue;
    const key = String(v).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// Refresh policy — used by the worker to decide whether a refresh request
// should actually re-run the pipeline or return the cached report.
const REFRESH_POLICIES = {
  free:    { maxAgeDays: 30, allowRefresh: false, refreshCooldownHours: 0 },
  starter: { maxAgeDays: 30, allowRefresh: false, refreshCooldownHours: 0 },
  pro:     { maxAgeDays: 14, allowRefresh: true,  refreshCooldownHours: 168 },
  growth:  { maxAgeDays: 7,  allowRefresh: true,  refreshCooldownHours: 48,  autoRefresh: true },
  agency:  { maxAgeDays: 1,  allowRefresh: true,  refreshCooldownHours: 12,  autoRefresh: true },
};

function shouldRefresh(brandDoc, tier = 'free') {
  const policy = REFRESH_POLICIES[tier] || REFRESH_POLICIES.free;
  if (!brandDoc?.lastStrategyAt) return { should: true, reason: 'no_strategy' };
  const ageDays = (Date.now() - new Date(brandDoc.lastStrategyAt).getTime()) / (24 * 3600 * 1000);
  if (ageDays > policy.maxAgeDays) return { should: true, reason: 'stale' };
  if (!policy.allowRefresh) return { should: false, reason: 'policy_blocks_refresh' };
  const hoursSince = ageDays * 24;
  if (hoursSince < policy.refreshCooldownHours) {
    return {
      should: false,
      reason: 'cooldown',
      cooldownRemainingHours: Math.ceil(policy.refreshCooldownHours - hoursSince),
    };
  }
  return { should: true, reason: 'cooldown_passed' };
}

module.exports = {
  runIntelligenceRun,
  buildDefaultOrchestrator,
  REFRESH_POLICIES,
  shouldRefresh,
  _resetOrchestratorForTests,
};
