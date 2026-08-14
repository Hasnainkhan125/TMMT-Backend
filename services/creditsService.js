'use strict';

/**
 * creditsService — single entry point for every credit movement.
 *
 * Anonymous trial users (no userId, just sessionId) get a per-session free
 * grant. Signed-in users get a `User.platformCredits` running balance kept
 * in sync with the CreditLedger (ledger is source of truth).
 *
 * The hot path:
 *   1. quote(modelId, kind, durationSec)  → integer credit cost
 *   2. canAfford(owner, cost)              → boolean
 *   3. chargeForJob({owner, job, model})   → writes ledger row + decrements balance
 *      (atomic via findOneAndUpdate w/ $inc; throws on insufficient_credits)
 *   4. refundForJob(job)                   → mirrors charge if job ended in 'failed'
 */

const mongoose = require('mongoose');
const CreditLedger = require('../model/schema/creditLedger');
const User = require('../model/schema/user');
const AiModel = require('../model/schema/aiModel');

// Observability — best-effort. Never block the hot path on a metrics import.
let _metrics;
function _bumpMetric(args) {
  try {
    _metrics = _metrics || require('../utils/metrics');
    _metrics.incCredits(args);
  } catch (_e) { /* metrics optional */ }
}

// Free grants (configurable via env so we can A/B without a deploy).
const ANON_FREE_CREDITS = Number(process.env.ANON_FREE_CREDITS || 5);     // per session
const SIGNUP_BONUS      = Number(process.env.SIGNUP_BONUS_CREDITS || 25); // one-time

// In-memory anonymous balance fallback. Mongo ledger is still the source of
// truth — this just avoids a round trip on the hot read path.
async function _ledgerBalance({ userId, sessionId }) {
  const filter = userId ? { userId } : { sessionId };
  const last = await CreditLedger.findOne(filter).sort({ createdAt: -1 }).lean();
  return last ? last.balanceAfter : 0;
}

/**
 * getBalance — current credit balance for either a user or an anonymous session.
 * Materialises the free signup/anon grant on first read (so the user actually
 * has spending power without a separate "claim my free credits" step).
 */
async function getBalance({ userId = null, sessionId = null } = {}) {
  if (!userId && !sessionId) return 0;

  if (userId) {
    const user = await User.findById(userId).select('platformCredits').lean();
    if (!user) return 0;
    // If this user has never had a ledger row, seed the signup bonus once.
    const hasRow = await CreditLedger.exists({ userId });
    if (!hasRow && SIGNUP_BONUS > 0) {
      await _grant({ userId, amount: SIGNUP_BONUS, reason: 'topup_signup_bonus', meta: {} });
      return SIGNUP_BONUS;
    }
    return user.platformCredits || 0;
  }

  // anonymous
  const hasRow = await CreditLedger.exists({ sessionId });
  if (!hasRow && ANON_FREE_CREDITS > 0) {
    await _grant({ sessionId, amount: ANON_FREE_CREDITS, reason: 'topup_signup_bonus', meta: { anonymous: true } });
    return ANON_FREE_CREDITS;
  }
  return _ledgerBalance({ sessionId });
}

/**
 * quote — how many credits a single generation would cost.
 *
 * For images: model.creditsPerImage.
 * For video: baseCreditsForVideo + creditsPerSecondVideo * duration.
 * Variants multiply linearly.
 */
async function quote({ modelId, kind = 'image', durationSec = 5, variants = 1, audio = null }) {
  const model = await AiModel.findOne({ id: modelId, isActive: true }).lean();
  if (!model) throw new Error(`unknown_model:${modelId}`);

  let perItem;
  if (kind === 'image') {
    perItem = Math.max(1, Math.ceil(model.creditsPerImage || 1));
  } else {
    const base = model.baseCreditsForVideo || 0;
    const perSec = model.creditsPerSecondVideo || 1;
    perItem = Math.max(1, Math.ceil(base + perSec * durationSec));
  }
  if (kind === 'video' && audio?.enabled) {
    const bump = Number(process.env.STUDIO_AUDIO_SURCHARGE_CREDITS || 1);
    perItem += Math.max(0, Math.ceil(bump));
  }

  const mult = Math.max(1, variants);
  let total = perItem * mult;

  
        const usd = model.providerCostUsdEstimate; // worst-case real cost per item
      if (usd != null && Number.isFinite(usd) && usd > 0) {
        const PRICE_PER_CREDIT_USD = Number(process.env.PRICE_PER_CREDIT_USD || 0.03);
        const MARKUP = Number(process.env.MARGIN_MARKUP || 2.5); // 2.5 = 60% margin
        const floorCredits = Math.ceil((usd * MARKUP / PRICE_PER_CREDIT_USD) * mult);
        if (total < floorCredits) {
          total = Math.max(total, floorCredits)
          const err = new Error(`Quoted ${total}cr below margin floor ${floorCredits}cr for ${modelId}`);
          err.code = 'quote_below_margin_floor';
          if (process.env.ENFORCE_MARGIN_QUOTE === 'true') throw err;
          console.warn('[quote]', err.message);
        }
      }

  return total;
}

async function canAfford(owner, cost) {
  const balance = await getBalance(owner);
  return balance >= cost;
}


// creditsService.js
async function atomicChargeForJob({ owner, cost, jobId }) {
  const filter = owner.userId 
    ? { userId: owner.userId, credits: { $gte: cost } }
    : { sessionId: owner.sessionId, credits: { $gte: cost } };
  
  const result = await CreditLedger.findOneAndUpdate(
    filter,
    { 
      $inc: { credits: -cost },
      $push: { transactions: { jobId, cost, at: new Date(), type: 'charge' } }
    },
    { new: true }
  );
  
  if (!result) {
    const err = new Error('Insufficient credits');
    err.code = 'insufficient_credits';
    throw err;
  }
  
  return result;
}
/**
 * chargeForJob — atomically deducts credits and creates a ledger row tied to
 * the StudioJob. Throws { code: 'insufficient_credits' } if the balance is
 * too low; nothing is written in that case.
 */
async function chargeForJob({ owner, job, cost, modelId, templateId }) {
  if (!cost || cost <= 0) return null;

  let reason = job.kind === 'video' ? 'charge_studio_video' : 'charge_studio_image';
  if (job.kind === 'video' && job.userInputs?.audio?.enabled) {
    const m = String(job.userInputs.audio.mode || 'native').toLowerCase();
    if (m === 'tts') reason = 'charge_studio_audio_tts';
    else if (m === 'upload') reason = 'charge_studio_audio_upload';
    else reason = 'charge_studio_video_native_audio';
  }

  let balanceAfter;
  if (owner.userId) {
    // Atomic decrement: only succeeds when there's enough.
    const updated = await User.findOneAndUpdate(
      { _id: owner.userId, platformCredits: { $gte: cost } },
      { $inc: { platformCredits: -cost } },
      { new: true, projection: { platformCredits: 1 } },
    );
    if (!updated) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      throw err;
    }
    balanceAfter = updated.platformCredits;
  } else {
    // Anonymous: balance lives in the ledger only.
    const current = await _ledgerBalance({ sessionId: owner.sessionId });
    if (current < cost) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      throw err;
    }
    balanceAfter = current - cost;
  }

  const entry = await CreditLedger.create({
    userId: owner.userId || null,
    sessionId: owner.sessionId || null,
    delta: -cost,
    balanceAfter,
    reason,
    jobId: job._id,
    modelId,
    templateId: templateId || null,
    meta: { kind: job.kind, tier: job.tier },
  });

  job.creditsCharged = cost;
  job.ledgerEntryId  = entry._id;
  // best-effort persist; caller may also save() shortly
  await job.save().catch(() => {});

  _bumpMetric({ reason, sign: 'out', amount: cost });
  return entry;
}

async function refundForJob(job) {
  if (!job?.creditsCharged || job.creditsRefunded > 0) return null;
  const cost = job.creditsCharged;

  let balanceAfter;
  if (job.userId) {
    const updated = await User.findByIdAndUpdate(
      job.userId,
      { $inc: { platformCredits: cost } },
      { new: true, projection: { platformCredits: 1 } },
    );
    balanceAfter = updated?.platformCredits ?? cost;
  } else {
    const current = await _ledgerBalance({ sessionId: job.sessionId });
    balanceAfter = current + cost;
  }

  const entry = await CreditLedger.create({
    userId: job.userId || null,
    sessionId: job.sessionId || null,
    delta: cost,
    balanceAfter,
    reason: 'refund_studio_failure',
    jobId: job._id,
    modelId: job.modelId || null,
    templateId: job.templateId || null,
    meta: { reason: job.error?.message || 'unknown' },
  });

  job.creditsRefunded = cost;
  await job.save().catch(() => {});
  _bumpMetric({ reason: 'refund_studio_failure', sign: 'in', amount: cost });
  return entry;
}

/**
 * topUp — admin/Stripe webhook entry point. Caller is trusted to have
 * verified the underlying payment.
 */
async function topUp({ userId, amount, reason = 'topup_admin', meta = {} }) {
  if (!userId || !amount || amount <= 0) throw new Error('invalid_topup');
  return _grant({ userId, amount, reason, meta });
}

async function _grant({ userId = null, sessionId = null, amount, reason, meta = {} }) {
  let balanceAfter;
  if (userId) {
    const updated = await User.findByIdAndUpdate(
      userId,
      { $inc: { platformCredits: amount } },
      { new: true, upsert: false, projection: { platformCredits: 1 } },
    );
    balanceAfter = updated?.platformCredits ?? amount;
  } else {
    const current = await _ledgerBalance({ sessionId });
    balanceAfter = current + amount;
  }
  const entry = await CreditLedger.create({
    userId, sessionId,
    delta: amount,
    balanceAfter,
    reason,
    meta,
  });
  _bumpMetric({ reason, sign: amount >= 0 ? 'in' : 'out', amount });
  return entry;
}

/**
 * recordTopUp — used by payment webhooks and controllers that have ALREADY
 * incremented User.platformCredits directly (legacy flow) and now need a
 * matching ledger entry for finance / reconciliation.
 *
 * Why this exists: confirmCredits / handleStripeWebhookEvent / BNPL webhooks
 * use `$set` on topUpHistory alongside the `$inc` on platformCredits so the
 * operation is atomic. We don't want to unwind that and re-do it; we just
 * want the ledger row to exist.
 */
async function recordTopUp({ userId, sessionId = null, amount, reason, meta = {}, balanceAfter = null }) {
  if (!amount || amount === 0) return null;
  let actualBalance = balanceAfter;
  if (actualBalance === null || actualBalance === undefined) {
    if (userId) {
      const u = await User.findById(userId).select('platformCredits').lean();
      actualBalance = u?.platformCredits ?? amount;
    } else {
      actualBalance = (await _ledgerBalance({ sessionId })) + amount;
    }
  }
  const entry = await CreditLedger.create({
    userId: userId || null,
    sessionId: sessionId || null,
    delta: amount,
    balanceAfter: actualBalance,
    reason,
    meta,
  });
  _bumpMetric({ reason, sign: 'in', amount });
  return entry;
}

async function listLedger({ userId, sessionId, limit = 50 } = {}) {
  const filter = userId ? { userId } : { sessionId };
  return CreditLedger.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
}



// pricingEngine.js
function computeUsdCost(costSpec, params) {
  const { unit, usd } = costSpec;

  if (unit === 'per_image') {
    let cost = usd.base;
    if (usd.byResolution && params.resolution) {
      cost *= (usd.byResolution[params.resolution] ?? 1);
    }
    // quality tiers for gpt-image-2 etc.
    if (usd.byQuality && params.quality) {
      cost = usd.byQuality[params.quality] ?? cost;
    }
    return cost;
  }

  if (unit === 'per_second') {
    const dur = params.duration || 5;
    let perSec = usd.base;
    if (usd.byResolution) perSec *= (usd.byResolution[params.resolution] ?? 1);

    // reference image handling
    const refCount = countReferenceInputs(params); // counts image_urls, elements, start frame
    if (usd.referenceImage) {
      const r = usd.referenceImage;
      if (r.mode === 'discount' && refCount > 0) perSec *= r.value;
      if (r.mode === 'surcharge' && refCount > 0) perSec *= r.value;
    }

    let cost = perSec * dur;

    // per-item reference cost (the Kling O3 $8 case)
    if (usd.referenceImage?.mode === 'per_item') {
      const billable = Math.max(0, refCount - (usd.referenceImage.freeCount || 0));
      cost += billable * usd.referenceImage.perItemUsd;
    }

    // audio
    if (params.audioEnabled && usd.audio) {
      if (usd.audio.mode === 'multiplier') cost *= usd.audio.value;
      if (usd.audio.mode === 'flat') cost += usd.audio.value;
    }

    return cost;
  }

  if (unit === 'token_based') {
    const tokens = computeTokens(params, usd.tokenFormula); // h×w×dur×24/1024 etc.
    return (tokens / 1000) * usd.tokenRateUsd;
  }

  throw new Error(`Unknown cost unit: ${unit}`);
}

function computeCost(model, params) {
  const usdCost = computeUsdCost(model.costSpec, params);
  const PRICE_PER_CREDIT_USD = Number(process.env.PRICE_PER_CREDIT_USD || 0.03);
  const markup = model.costSpec.markup || 2.5;
  const credits = Math.ceil((usdCost * markup) / PRICE_PER_CREDIT_USD);
  const variants = Math.max(1, params.variants || 1);

  return {
    usdCost: +(usdCost * variants).toFixed(4),   // your real cost
    credits: credits * variants,                  // what you charge
    breakdown: { perUnitUsd: usdCost, markup, pricePerCredit: PRICE_PER_CREDIT_USD, variants },
  };
}

function countReferenceInputs(params) {
  let n = 0;
  if (params.startFrame || params.image_url || params.start_image_url) n += 1;
  if (Array.isArray(params.image_urls)) n += params.image_urls.length;
  if (Array.isArray(params.elements)) {
    for (const el of params.elements) {
      if (el?.frontal_image_url) n += 1;
      if (Array.isArray(el?.reference_image_urls)) n += el.reference_image_urls.length;
    }
  }
  return n;
}

module.exports = {
  ANON_FREE_CREDITS,
  SIGNUP_BONUS,
  getBalance,
  quote,
  canAfford,
  chargeForJob,
  refundForJob,
  topUp,
  recordTopUp,
  listLedger,
};
