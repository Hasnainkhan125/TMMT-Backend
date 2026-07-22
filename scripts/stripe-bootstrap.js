#!/usr/bin/env node
'use strict';

/**
 * stripe-bootstrap.js
 *
 * One-time script. Creates Products + Prices in your Stripe account via API
 * since you don't have dashboard access. Idempotent — safe to re-run; it
 * uses `lookup_key` to deduplicate.
 *
 * Run: node scripts/stripe-bootstrap.js
 * Output: prints env vars to copy into .env
 *
 * Also optionally registers a webhook endpoint if you pass --webhook-url.
 */

require('dotenv').config();
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ─── Plan catalog — single source of truth ────────────────────────────────
// `lookup_key` is what makes this script idempotent. Stripe lets you look
// up a Price by an arbitrary key you assign — if it exists we reuse it,
// otherwise we create it. This means re-running the script never makes
// duplicate Prices.

const PLANS = [
  // ── Subscriptions ──
  { lookupKey: 'starter_monthly',   productName: 'Qumak Starter',    description: 'For first-time AI content creators',     amountUsd: 15,  interval: 'month', credits: 200,   metadata: { tier: 'starter', creditsPerCycle: '200' } },

  { lookupKey: 'plus_monthly',      productName: 'Qumak Plus',       description: 'For consistent AI content creation',     amountUsd: 49,  interval: 'month', credits: 1000,  metadata: { tier: 'plus',    creditsPerCycle: '1000' } },
  { lookupKey: 'plus_annual',       productName: 'Qumak Plus',       description: 'For consistent AI content creation',     amountUsd: 300, interval: 'year',  credits: 1000,  metadata: { tier: 'plus',    creditsPerCycle: '1000', billedAnnually: 'true' } }, // $25/mo × 12 = $300 yearly

  { lookupKey: 'ultra_3k_monthly',  productName: 'Qumak Ultra 3K',   description: 'For creators building AI projects',      amountUsd: 129, interval: 'month', credits: 3000,  metadata: { tier: 'ultra', creditsPerCycle: '3000' } },
  { lookupKey: 'ultra_3k_annual',   productName: 'Qumak Ultra 3K',   description: 'For creators building AI projects',      amountUsd: 624, interval: 'year',  credits: 3000,  metadata: { tier: 'ultra', creditsPerCycle: '3000', billedAnnually: 'true' } }, // $52/mo × 12

  { lookupKey: 'ultra_6k_monthly',  productName: 'Qumak Ultra 6K',   description: 'For creators building AI projects',      amountUsd: 249, interval: 'month', credits: 6000,  metadata: { tier: 'ultra', creditsPerCycle: '6000' } },
  { lookupKey: 'ultra_6k_annual',   productName: 'Qumak Ultra 6K',   description: 'For creators building AI projects',      amountUsd: 1188,interval: 'year',  credits: 6000,  metadata: { tier: 'ultra', creditsPerCycle: '6000', billedAnnually: 'true' } }, // $99/mo × 12

  { lookupKey: 'ultra_9k_monthly',  productName: 'Qumak Ultra 9K',   description: 'For creators building AI projects',      amountUsd: 349, interval: 'month', credits: 9000,  metadata: { tier: 'ultra', creditsPerCycle: '9000' } },
  { lookupKey: 'ultra_9k_annual',   productName: 'Qumak Ultra 9K',   description: 'For creators building AI projects',      amountUsd: 1668,interval: 'year',  credits: 9000,  metadata: { tier: 'ultra', creditsPerCycle: '9000', billedAnnually: 'true' } }, // $139/mo × 12

  // ── One-time top-up packs ──
  { lookupKey: 'topup_500',         productName: 'Qumak Top-Up 500', description: 'One-time 500 credits',                   amountUsd: 9,   oneTime: true,     credits: 500,   metadata: { type: 'topup', credits: '500' } },
  { lookupKey: 'topup_1500',        productName: 'Qumak Top-Up 1500',description: 'One-time 1500 credits',                  amountUsd: 24,  oneTime: true,     credits: 1500,  metadata: { type: 'topup', credits: '1500' } },
  { lookupKey: 'topup_5000',        productName: 'Qumak Top-Up 5000',description: 'One-time 5000 credits',                  amountUsd: 69,  oneTime: true,     credits: 5000,  metadata: { type: 'topup', credits: '5000' } },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

async function findOrCreateProduct(name, description, metadata) {
  // Stripe doesn't have a "find by name" for products — search uses metadata
  const search = await stripe.products.search({
    query: `name:"${name}" AND active:"true"`,
    limit: 1,
  }).catch(() => ({ data: [] }));

  if (search.data[0]) return search.data[0];

  return stripe.products.create({
    name,
    description,
    metadata: metadata || {},
  });
}

async function findOrCreatePrice(plan, product) {
  // lookup_key dedupes Prices across reruns
  const existing = await stripe.prices.list({
    lookup_keys: [plan.lookupKey],
    limit: 1,
  });

  if (existing.data[0]) {
    console.log(`  ↪ Reusing existing Price for ${plan.lookupKey}: ${existing.data[0].id}`);
    return existing.data[0];
  }

  const params = {
    product: product.id,
    unit_amount: plan.amountUsd * 100, // Stripe wants cents
    currency: 'usd',
    lookup_key: plan.lookupKey,
    metadata: plan.metadata || {},
    nickname: plan.lookupKey,
  };

  if (!plan.oneTime) {
    params.recurring = { interval: plan.interval };
  }

  const price = await stripe.prices.create(params);
  console.log(`  ✓ Created Price ${plan.lookupKey}: ${price.id}`);
  return price;
}

// ─── Webhook endpoint registration (optional) ─────────────────────────────

async function registerWebhook(url) {
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = existing.data.find((w) => w.url === url);
  if (found) {
    console.log(`\n↪ Webhook already registered for ${url}`);
    console.log(`  Endpoint ID: ${found.id}`);
    console.log(`  ⚠ Existing secret cannot be retrieved via API. If you lost it, delete and recreate:`);
    console.log(`    stripe.webhookEndpoints.del('${found.id}')`);
    return null;
  }

  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [
      'checkout.session.completed',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ],
    description: 'Qumak credits webhook',
  });

  console.log(`\n✓ Webhook registered: ${endpoint.id}`);
  console.log(`  STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
  console.log(`  ⚠ COPY THIS NOW — Stripe will not show it again.`);
  return endpoint;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY not set in .env');
    process.exit(1);
  }

  console.log(`Bootstrapping Stripe (${process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST'} mode)...\n`);

  const envLines = [];

  // Group plans by product name so we only create each Product once
  const byProduct = {};
  for (const plan of PLANS) {
    if (!byProduct[plan.productName]) byProduct[plan.productName] = [];
    byProduct[plan.productName].push(plan);
  }

  for (const [productName, plans] of Object.entries(byProduct)) {
    console.log(`\nProduct: ${productName}`);
    const product = await findOrCreateProduct(
      productName,
      plans[0].description,
      { managedBy: 'qumak-bootstrap' },
    );
    console.log(`  Product ID: ${product.id}`);

    for (const plan of plans) {
      const price = await findOrCreatePrice(plan, product);
      const envKey = `STRIPE_PRICE_${plan.lookupKey.toUpperCase()}`;
      envLines.push(`${envKey}=${price.id}`);
    }
  }

  // Webhook (optional)
  const webhookUrl = process.argv.find((a) => a.startsWith('--webhook-url='))?.split('=')[1];
  if (webhookUrl) {
    await registerWebhook(webhookUrl);
  } else {
    console.log(`\nℹ️  Skipping webhook registration. Two options for dev:`);
    console.log(`    1. Local dev via Stripe CLI:`);
    console.log(`       stripe listen --forward-to localhost:5001/api/billing/webhook`);
    console.log(`       (prints whsec_... — paste into STRIPE_WEBHOOK_SECRET in .env)`);
    console.log(`    2. Register a live webhook URL when deploying:`);
    console.log(`       node scripts/stripe-bootstrap.js --webhook-url=https://api.qumak.io/api/billing/webhook`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Paste these into your .env file:\n');
  console.log(envLines.join('\n'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch((err) => {
  console.error('❌ Bootstrap failed:', err.message);
  if (err.raw) console.error(err.raw);
  process.exit(1);
});