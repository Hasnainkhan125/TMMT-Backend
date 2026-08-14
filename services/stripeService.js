'use strict';

/**
 * stripeService.js — Stripe SDK wrapper + webhook handlers.
 *
 * Responsibilities:
 *   - Create/find a Stripe Customer per user (one customer = one user, ever)
 *   - Build Checkout Sessions (one per pay click)
 *   - Verify webhook signatures (NEVER trust unsigned events)
 *   - On payment success → grant credits via creditsService (idempotent)
 *
 * What this file does NOT do:
 *   - Handle the raw request body (the route does that — webhook signature
 *     verification needs the RAW body, not the parsed one)
 *   - Talk to the frontend (the route does that)
 */

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const UserSubscription = require('../model/schema/userSubscription');
const creditsService = require('./creditsService');
const { resolvePlan } = require('../config/stripePlans');

// ─── Customer management ──────────────────────────────────────────────────

async function getOrCreateCustomer(user) {
  let sub = await UserSubscription.findOne({ userId: user._id });

  if (sub?.stripeCustomerId) {
    // Verify the customer still exists Stripe-side (in case test mode reset)
    try {
      const c = await stripe.customers.retrieve(sub.stripeCustomerId);
      if (!c.deleted) return sub.stripeCustomerId;
    } catch (_e) {
      // Customer was deleted on Stripe side — create a new one below
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || user.email,
    metadata: { userId: String(user._id) },
  });

  if (!sub) {
    sub = await UserSubscription.create({
      userId: user._id,
      stripeCustomerId: customer.id,
    });
  } else {
    sub.stripeCustomerId = customer.id;
    await sub.save();
  }

  return customer.id;
}


async function getCheckoutSession(sessionId) {
  if (!sessionId) return null;
  try {
    // Expand the subscription so we can confirm it activated, not just that
    // the session was created. payment_status is the field that flips to
    // 'paid' once Stripe captures funds.
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'payment_intent'],
    });
    if (!session) return null;
 
    return {
      id: session.id,
      payment_status: session.payment_status,      // 'paid' | 'unpaid' | 'no_payment_required'
      status: session.status,                      // 'open' | 'complete' | 'expired'
      userId: session.metadata?.userId || session.client_reference_id || null,
      planId: session.metadata?.planId || null,
      credits: session.metadata?.credits ? Number(session.metadata.credits) : null,
      kind: session.metadata?.kind || null,
      customer: session.customer || null,
    };
  } catch (err) {
    // Unknown/expired session id → treat as not found, let route 404 cleanly
    if (err?.statusCode === 404 || err?.code === 'resource_missing') return null;
    throw err; // genuine Stripe/network error → let route 500 + log
  }
}
// ─── Checkout session ─────────────────────────────────────────────────────

async function createCheckoutSession({ user, planId, successUrl, cancelUrl }) {
  const plan = resolvePlan(planId); // throws if unknown/misconfigured
  const customerId = await getOrCreateCustomer(user);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: plan.kind === 'subscription' ? 'subscription' : 'payment',
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // client_reference_id and metadata travel back via webhook — that's how
    // we know which user + plan this purchase was for, without trusting the
    // frontend's success-page query params.
    client_reference_id: String(user._id),
    metadata: {
      userId: String(user._id),
      planId,
      credits: String(plan.credits),
      kind: plan.kind,
    },
    // For subscriptions, replicate the metadata onto the subscription itself
    ...(plan.kind === 'subscription' ? {
      subscription_data: {
        metadata: {
          userId: String(user._id),
          planId,
          creditsPerCycle: String(plan.credits),
        },
      },
    } : {}),
    // Auto-collect tax if you ever enable it in Stripe — safe default off
    allow_promotion_codes: true,
  });

  return { url: session.url, sessionId: session.id };
}

// ─── Customer portal (cancel, update card, view invoices) ─────────────────

async function createPortalSession({ user, returnUrl }) {
  const customerId = await getOrCreateCustomer(user);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// ─── Webhook signature verification ───────────────────────────────────────

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  // constructEvent throws if signature invalid — let it bubble up to the route
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// ─── Idempotency: have we processed this event before? ────────────────────
//
// Stripe retries webhooks aggressively. Without idempotency, a single
// invoice.payment_succeeded event delivered twice would credit the user
// twice. We log every event.id we process onto the user's subscription
// row and refuse to act on duplicates.

async function isEventAlreadyProcessed(userId, eventId) {
  const sub = await UserSubscription.findOne({
    userId,
    processedEventIds: eventId,
  }).lean();
  return !!sub;
}

async function markEventProcessed(userId, eventId) {
  await UserSubscription.updateOne(
    { userId },
    { $addToSet: { processedEventIds: eventId } },
  );
}

// ─── Event handlers ───────────────────────────────────────────────────────

/**
 * checkout.session.completed
 *
 * Fires once when the user finishes paying at checkout.stripe.com.
 * For subscriptions: do NOT grant credits here — wait for
 * invoice.payment_succeeded so renewals use the same path. We DO grant for
 * one-time top-ups here, because top-ups don't generate invoices.
 */
async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  const userId  = session.metadata?.userId || session.client_reference_id;
  const planId  = session.metadata?.planId;
  const kind    = session.metadata?.kind;
  const credits = Number(session.metadata?.credits || 0);
 
  if (!userId) {
    console.warn('[stripe] checkout.session.completed without userId:', session.id);
    return;
  }
 
  if (await isEventAlreadyProcessed(userId, event.id)) {
    console.log('[stripe] event already processed:', event.id);
    return;
  }
 
  // ── TOP-UP: grant immediately (no invoice is generated for one-time) ──
  if (kind === 'topup' && session.payment_status === 'paid') {
    await creditsService.topUp({
      userId,
      amount: credits,
      reason: 'topup_stripe_purchase',
      meta: { stripeSessionId: session.id, planId, eventId: event.id },
    });
    await markEventProcessed(userId, event.id);
    console.log(`[stripe] granted ${credits} top-up credits to ${userId}`);
    return;
  }
 
  // ── SUBSCRIPTION: update the row only. Credits land in invoice.payment_succeeded. ──
  if (kind === 'subscription') {
    if (!session.subscription) {
      console.warn('[stripe] subscription checkout without subscription id:', session.id);
      return;
    }
 
    // Declare FIRST, then read from it. (This was the crash.)
    const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
    const item = stripeSub.items?.data?.[0];
    const resolved = (typeof resolvePlan === 'function' && resolvePlan(planId)) || {};
 
    await UserSubscription.updateOne(
      { userId },
      {
        $set: {
          stripeSubscriptionId: stripeSub.id,
          stripeCustomerId: session.customer,
          planId,
          tier: stripeSub.metadata?.tier || resolved.tier || (planId ? planId.split('_')[0] : 'unknown'),
          status: stripeSub.status,
          interval: item?.price?.recurring?.interval || null,
          creditsPerCycle: resolved.credits || credits || 0,
          currentPeriodStart: item?.current_period_start
            ? new Date(item.current_period_start * 1000)
            : (stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : null),
          currentPeriodEnd: item?.current_period_end
            ? new Date(item.current_period_end * 1000)
            : (stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null),
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        },
      },
    );
    await markEventProcessed(userId, event.id);
    console.log(`[stripe] subscription row updated for ${userId} (credits via invoice event)`);
    return;
  }
 
  console.warn('[stripe] checkout.session.completed with unknown kind:', kind, session.id);
}
 

/**
 * invoice.payment_succeeded
 *
 * Fires every time a subscription invoice is paid — initial purchase AND
 * every monthly/yearly renewal. This is the canonical "grant credits" event
 * for subscriptions. Top-ups skip this path entirely.
 */
async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;
  if (!invoice.subscription) return; // one-time invoices (top-ups) handled in checkout.session.completed

  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId  = sub.metadata?.userId;
  const planId  = sub.metadata?.planId;
  const credits = Number(sub.metadata?.creditsPerCycle || 0);

  if (!userId || !credits) {
    console.warn('[stripe] invoice.payment_succeeded missing metadata:', invoice.id);
    return;
  }

  if (await isEventAlreadyProcessed(userId, event.id)) {
    console.log('[stripe] event already processed:', event.id);
    return;
  }

  await creditsService.topUp({
    userId,
    amount: credits,
    reason: 'topup_subscription_cycle',
    meta: {
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: sub.id,
      planId,
      eventId: event.id,
      billingReason: invoice.billing_reason, // 'subscription_create' | 'subscription_cycle' | etc
      currentPeriodStart:
        sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
      currentPeriodEnd:
        sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null,
    },
  });

  await UserSubscription.updateOne(
    { userId },
    {
      $set: {
        status: 'active',
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
        currentPeriodEnd:   sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null,
        cancelAtPeriodEnd:  sub.cancel_at_period_end,
      },
    },
  );

  await markEventProcessed(userId, event.id);
  console.log(`[stripe] granted ${credits} cycle credits to ${userId} (${invoice.billing_reason})`);
}

async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;
  if (!invoice.subscription) return;
  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId = sub.metadata?.userId;
  if (!userId) return;

  await UserSubscription.updateOne(
    { userId },
    { $set: { status: 'past_due' } },
  );
  console.warn(`[stripe] payment failed for user ${userId}, sub ${sub.id}`);
}

async function handleSubscriptionUpdated(event) {
  const sub = event.data.object;
  const userId = sub.metadata?.userId;
  if (!userId) return;

  await UserSubscription.updateOne(
    { userId },
    {
      $set: {
        status: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null,
      },
    },
  );
}

async function handleSubscriptionDeleted(event) {
  const sub = event.data.object;
  const userId = sub.metadata?.userId;
  if (!userId) return;

  await UserSubscription.updateOne(
    { userId },
    { $set: { status: 'canceled', cancelAtPeriodEnd: false } },
  );
  console.log(`[stripe] subscription canceled for user ${userId}`);
}

// ─── Dispatcher ───────────────────────────────────────────────────────────

async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':       return handleCheckoutSessionCompleted(event);
    case 'invoice.payment_succeeded':        return handleInvoicePaymentSucceeded(event);
    case 'invoice.payment_failed':           return handleInvoicePaymentFailed(event);
    case 'customer.subscription.updated':    return handleSubscriptionUpdated(event);
    case 'customer.subscription.deleted':    return handleSubscriptionDeleted(event);
    default:
      // Unhandled events are fine — Stripe sends many we don't care about
      return;
  }
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  handleWebhookEvent,
  getOrCreateCustomer,
  getCheckoutSession
};