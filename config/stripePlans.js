'use strict';

/**
 * stripePlans.js — internal plan ID → Stripe price ID + credit grant.
 *
 * Frontend sends a planId like 'plus_monthly'. Server resolves it here.
 * Never trust the frontend to send price IDs directly — they could pick
 * a $0 price you created for testing.
 */

const PLANS = {
  // Subscriptions
  starter_monthly:  { priceEnvVar: 'STRIPE_PRICE_STARTER_MONTHLY',  credits: 200,  kind: 'subscription', interval: 'month', tier: 'starter' },
  plus_monthly:     { priceEnvVar: 'STRIPE_PRICE_PLUS_MONTHLY',     credits: 1000, kind: 'subscription', interval: 'month', tier: 'plus' },
  plus_annual:      { priceEnvVar: 'STRIPE_PRICE_PLUS_ANNUAL',      credits: 1000, kind: 'subscription', interval: 'year',  tier: 'plus' },
  ultra_3k_monthly: { priceEnvVar: 'STRIPE_PRICE_ULTRA_3K_MONTHLY', credits: 3000, kind: 'subscription', interval: 'month', tier: 'ultra' },
  ultra_3k_annual:  { priceEnvVar: 'STRIPE_PRICE_ULTRA_3K_ANNUAL',  credits: 3000, kind: 'subscription', interval: 'year',  tier: 'ultra' },
  ultra_6k_monthly: { priceEnvVar: 'STRIPE_PRICE_ULTRA_6K_MONTHLY', credits: 6000, kind: 'subscription', interval: 'month', tier: 'ultra' },
  ultra_6k_annual:  { priceEnvVar: 'STRIPE_PRICE_ULTRA_6K_ANNUAL',  credits: 6000, kind: 'subscription', interval: 'year',  tier: 'ultra' },
  ultra_9k_monthly: { priceEnvVar: 'STRIPE_PRICE_ULTRA_9K_MONTHLY', credits: 9000, kind: 'subscription', interval: 'month', tier: 'ultra' },
  ultra_9k_annual:  { priceEnvVar: 'STRIPE_PRICE_ULTRA_9K_ANNUAL',  credits: 9000, kind: 'subscription', interval: 'year',  tier: 'ultra' },

  // One-time top-ups
  topup_500:  { priceEnvVar: 'STRIPE_PRICE_TOPUP_500',  credits: 500,  kind: 'topup' },
  topup_1500: { priceEnvVar: 'STRIPE_PRICE_TOPUP_1500', credits: 1500, kind: 'topup' },
  topup_5000: { priceEnvVar: 'STRIPE_PRICE_TOPUP_5000', credits: 5000, kind: 'topup' },
};

function resolvePlan(planId) {
  const plan = PLANS[planId];
  if (!plan) {
    const err = new Error(`Unknown planId: ${planId}`);
    err.code = 'unknown_plan';
    throw err;
  }
  const priceId = process.env[plan.priceEnvVar];
  if (!priceId) {
    const err = new Error(`Price not configured: ${plan.priceEnvVar} missing from env. Run scripts/stripe-bootstrap.js.`);
    err.code = 'price_not_configured';
    throw err;
  }
  return { ...plan, planId, priceId };
}

function listPlans() {
  // For GET /api/billing/plans — returns what frontend can sell
  return Object.entries(PLANS).map(([planId, p]) => ({
    planId,
    kind: p.kind,
    credits: p.credits,
    tier: p.tier || null,
    interval: p.interval || null,
    // priceId omitted — frontend never needs it; they send planId
  }));
}

module.exports = { PLANS, resolvePlan, listPlans };