'use strict';

/**
 * bnplService.js — Tabby + Tamara checkout (Buy Now, Pay Later for MENA)
 *
 * Both Tabby and Tamara are dominant BNPL in UAE/KSA. Adding them next to
 * Stripe AED gives Gulf SMEs three checkout options for the same credit
 * packages. Tabby lifts checkout completion ~25% in our segment per their
 * published case studies; Tamara is the equivalent in KSA.
 *
 * Required env (per provider). Each is independently optional — if a
 * provider's keys are missing, that provider's `createCheckout` returns
 * { configured: false } and the controller returns 503 to the client.
 *
 *   TABBY_API_KEY                 Bearer secret key (test_sk_... / sk_...)
 *   TABBY_PUBLIC_KEY              Optional, for client-side JS SDK
 *   TABBY_BASE_URL                default https://api.tabby.ai
 *   TABBY_MERCHANT_CODE           e.g. 'qumak-uae'
 *
 *   TAMARA_API_TOKEN              Bearer
 *   TAMARA_BASE_URL               default https://api.tamara.co
 *   TAMARA_NOTIFICATION_TOKEN     for HMAC verification on webhook
 *   TAMARA_PUBLIC_KEY             Optional
 *
 *   FRONTEND_URL                  used for success / failure redirects
 */

const axios = require('axios');

const TABBY_BASE  = process.env.TABBY_BASE_URL  || 'https://api.tabby.ai';
const TAMARA_BASE = process.env.TAMARA_BASE_URL || 'https://api.tamara.co';

function frontend() { return process.env.FRONTEND_URL || 'https://qumak.ae'; }

function tabbyConfigured()  { return !!process.env.TABBY_API_KEY; }
function tamaraConfigured() { return !!process.env.TAMARA_API_TOKEN; }

// ─── Tabby ──────────────────────────────────────────────────────────────────
//
// Docs: https://docs.tabby.ai/#tag/Checkout-Session
// Create checkout session → user redirected → webhook on capture.
async function createTabbyCheckout({ pkg, user, topUpId, packageId }) {
  if (!tabbyConfigured()) return { configured: false };

  const reference_id = `qumak_credits_${topUpId}`;
  const payload = {
    payment: {
      amount: pkg.amountAED.toFixed(2),
      currency: 'AED',
      buyer: {
        email: user.email,
        phone: user.phone || '+971500000000',
        name:  user.name  || (user.email?.split('@')[0] || 'Qumak Customer'),
      },
      order: {
        reference_id,
        items: [{
          title: pkg.label,
          description: `${pkg.credits} Qumak credits`,
          quantity: 1,
          unit_price: pkg.amountAED.toFixed(2),
          category: 'Software',
          reference_id: packageId,
        }],
      },
      buyer_history: { registered_since: new Date(user.createdAt || Date.now()).toISOString(), loyalty_level: 0 },
      shipping_address: { city: 'Dubai', address: 'N/A', zip: '00000' },
      meta: {
        order_id:  String(topUpId),
        customer:  String(user._id),
      },
    },
    lang: 'en',
    merchant_code: process.env.TABBY_MERCHANT_CODE || 'qumak-uae',
    merchant_urls: {
      success: `${frontend()}/billing/success?provider=tabby&topup=${topUpId}`,
      cancel:  `${frontend()}/billing/cancel?provider=tabby`,
      failure: `${frontend()}/billing/failure?provider=tabby`,
    },
  };

  const res = await axios.post(`${TABBY_BASE}/api/v2/checkout`, payload, {
    headers: { Authorization: `Bearer ${process.env.TABBY_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const session = res.data;
  // Tabby returns `configuration.available_products` with an installments URL,
  // OR rejects with `status: 'rejected'` if the buyer is not pre-scored.
  const url = session?.configuration?.available_products?.installments?.[0]?.web_url
    || session?.web_url
    || null;

  return {
    configured: true,
    available: session.status === 'created' && !!url,
    sessionId: session.id,
    url,
    rejectionReason: session.rejection_reason || null,
    raw: session,
  };
}

// ─── Tamara ─────────────────────────────────────────────────────────────────
//
// Docs: https://docs.tamara.co/reference/create-checkout-session
async function createTamaraCheckout({ pkg, user, topUpId, packageId }) {
  if (!tamaraConfigured()) return { configured: false };

  const order_reference_id = `qumak_credits_${topUpId}`;
  const payload = {
    order_reference_id,
    total_amount:   { amount: pkg.amountAED.toFixed(2), currency: 'AED' },
    description:    pkg.label,
    country_code:   'AE',
    payment_type:   'PAY_BY_INSTALMENTS',
    instalments:    3,
    locale:         'en_US',
    items: [{
      reference_id: packageId,
      type: 'Digital',
      name: pkg.label,
      sku: `QUMAK-${packageId.toUpperCase()}`,
      quantity: 1,
      total_amount: { amount: pkg.amountAED.toFixed(2), currency: 'AED' },
      unit_price:   { amount: pkg.amountAED.toFixed(2), currency: 'AED' },
    }],
    consumer: {
      first_name:   (user.name || 'Qumak').split(' ')[0],
      last_name:    (user.name || 'Customer').split(' ').slice(1).join(' ') || 'Customer',
      phone_number: user.phone || '+971500000000',
      email:        user.email,
    },
    billing_address:  { city: 'Dubai', country_code: 'AE', first_name: user.name || 'Qumak', last_name: 'Customer', line1: 'N/A', phone_number: user.phone || '+971500000000' },
    shipping_address: { city: 'Dubai', country_code: 'AE', first_name: user.name || 'Qumak', last_name: 'Customer', line1: 'N/A', phone_number: user.phone || '+971500000000' },
    merchant_url: {
      success: `${frontend()}/billing/success?provider=tamara&topup=${topUpId}`,
      failure: `${frontend()}/billing/failure?provider=tamara`,
      cancel:  `${frontend()}/billing/cancel?provider=tamara`,
      notification: `${process.env.API_BASE_URL || 'https://api.qumak.ae'}/api/v1/brand-projects/credits/tamara/webhook`,
    },
  };

  const res = await axios.post(`${TAMARA_BASE}/checkout`, payload, {
    headers: { Authorization: `Bearer ${process.env.TAMARA_API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  return {
    configured: true,
    available:  !!res.data.checkout_url,
    sessionId:  res.data.checkout_id,
    orderId:    res.data.order_id,
    url:        res.data.checkout_url,
    raw:        res.data,
  };
}

// ─── Status fetchers (used by webhook + confirm endpoints) ──────────────────
async function getTabbyPayment(paymentId) {
  if (!tabbyConfigured()) return null;
  const res = await axios.get(`${TABBY_BASE}/api/v2/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${process.env.TABBY_API_KEY}` },
    timeout: 10000,
  });
  return res.data;
}

async function getTamaraOrder(orderId) {
  if (!tamaraConfigured()) return null;
  const res = await axios.get(`${TAMARA_BASE}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${process.env.TAMARA_API_TOKEN}` },
    timeout: 10000,
  });
  return res.data;
}

module.exports = {
  tabbyConfigured,
  tamaraConfigured,
  createTabbyCheckout,
  createTamaraCheckout,
  getTabbyPayment,
  getTamaraOrder,
};
