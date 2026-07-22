// 'use strict';

// const express = require('express');
// const router = express.Router();

// const stripeService = require('../services/stripeService');
// const { listPlans } = require('../config/stripePlans');

// // ─── Plan catalog (public, no auth) ───────────────────────────────────────
// router.get('/plans', (req, res) => {
//   res.json({ success: true, plans: listPlans() });
// });
// // router.post('/success', requireAuth, async (req, res) => {
// //   const { sessionId, signature } = req.body || {};
// //   if (!sessionId) {
// //     return res.status(400).json({ success: false, error: 'sessionId required' });
// //   }
// //   const paid = await stripeService.verifyCheckoutSession(sessionId, signature);
// //   if (!paid) {
// //     return res.status(400).json({ success: false, error: 'invalid session' });
// //   }
// //   res.json({ success: true, paid: true });
// // });

// // ─── Create checkout session (auth required) ──────────────────────────────
// // Adjust the auth middleware import to whatever your app uses
// const requireAuth = require('../middelwares/auth'); // <-- change if path differs

// router.post('/checkout', requireAuth, async (req, res) => {
//   try {
//     const { planId, successUrl, cancelUrl } = req.body || {};
//     if (!planId) {
//       return res.status(400).json({ success: false, error: 'planId required' });
//     }

//     const user = req.user;
//     if (!user?._id) {
//       return res.status(401).json({ success: false, error: 'unauthenticated' });
//     }

//     const { url, sessionId } = await stripeService.createCheckoutSession({
//       user,
//       planId,
//       successUrl: successUrl || `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
//       cancelUrl:  cancelUrl  || `${process.env.APP_URL}/billing/cancel`,
//     });

//     res.json({ success: true, url, sessionId });
//   } catch (err) {
//     const status = err.code === 'unknown_plan' || err.code === 'price_not_configured' ? 400 : 500;
//     console.error('[billing] checkout error:', err.message);
//     res.status(status).json({ success: false, error: err.code || 'server_error', message: err.message });
//   }
// });

// // ─── Customer portal (manage/cancel subscription) ─────────────────────────
// router.get('/portal', requireAuth, async (req, res) => {
//   try {
//     const user = req.user;
//     if (!user?._id) {
//       return res.status(401).json({ success: false, error: 'unauthenticated' });
//     }
//     const { url } = await stripeService.createPortalSession({
//       user,
//       returnUrl: `${process.env.APP_URL}/settings/billing`,
//     });
//     res.json({ success: true, url });
//   } catch (err) {
//     console.error('[billing] portal error:', err.message);
//     res.status(500).json({ success: false, error: 'portal_failed', message: err.message });
//   }
// });

// // ─── Webhook (NO auth, signature-verified) ────────────────────────────────
// // CRITICAL: this route must receive the RAW body (Buffer), not parsed JSON.
// // Stripe's signature is computed over the raw bytes — express.json() would
// // corrupt it. Mount this route BEFORE app.use(express.json()) in app.js, OR
// // use express.raw() inline as below.
// router.post('/webhook',
//   express.raw({ type: 'application/json' }),
//   async (req, res) => {
//     const signature = req.headers['stripe-signature'];
//     if (!signature) {
//       return res.status(400).send('Missing stripe-signature header');
//     }

//     let event;
//     try {
//       event = stripeService.verifyWebhookSignature(req.body, signature);
//     } catch (err) {
//       console.warn('[billing] webhook signature verification failed:', err.message);
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     // ACK fast (Stripe expects 2xx within 30s) then process async-ish.
//     // We still await here because dispatcher is in-process — if it throws we
//     // want to 500 so Stripe retries. The cost is <1s for normal events.
//     try {
//       await stripeService.handleWebhookEvent(event);
//       res.json({ received: true });
//     } catch (err) {
//       console.error('[billing] webhook handler failed:', err.message, err.stack);
//       // 500 → Stripe retries with exponential backoff. Idempotency log prevents
//       // double-grants when the retry eventually succeeds.
//       res.status(500).send('Handler failed');
//     }
//   }
// );

// module.exports = router;




'use strict';

const express = require('express');
const router = express.Router();

const stripeService = require('../services/stripeService');
const { listPlans } = require('../config/stripePlans');

// IMPORTANT: import auth ONCE, at the top. In your original file `requireAuth`
// was require()'d *after* the /success route already used it. Because `const`
// is not hoisted in the temporal-dead-zone sense, calling /success before the
// require ran would throw "Cannot access 'requireAuth' before initialization".
// Hoisting it here removes that landmine. (Fix the path if yours differs.)
const requireAuth = require('../middelwares/auth'); // note: your repo spells it "middelwares"

// ─── Plan catalog (public, no auth) ───────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ success: true, plans: listPlans() });
});

// ─── Verify a completed checkout (auth required) ──────────────────────────
// The FRONTEND /billing/success page calls this to confirm payment, then
// shows a receipt. This is NOT where credits are granted — the webhook is the
// source of truth. This endpoint only reads session state for UI purposes.
router.post('/success', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'sessionId required' });
  }
  try {
    const session = await stripeService.getCheckoutSession(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'session not found' });
    }
    // Ensure the session belongs to the requesting user (no peeking at others')
    if (session.userId && String(session.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    res.json({
      success: true,
      paid: session.payment_status === 'paid',
      planId: session.planId || null,
      credits: session.credits || null,
    });
  } catch (err) {
    console.error('[billing] success verify error:', err.message);
    res.status(500).json({ success: false, error: 'verify_failed' });
  }
});

// ─── Create checkout session (auth required) ──────────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { planId, successUrl, cancelUrl } = req.body || {};
    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId required' });
    }

    const user = req.user;
    if (!user?._id) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }

    // APP_URL must be the FRONTEND origin (e.g. https://app.qumak.io), NOT the
    // API origin. The path below must match a real route in your SPA router.
    const base = process.env.APP_URL?.replace(/\/$/, '') || '';
    const { url, sessionId } = await stripeService.createCheckoutSession({
      user,
      planId,
      successUrl:  `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:   `${base}/billing/cancel`,
    });

    res.json({ success: true, url, sessionId });
  } catch (err) {
    const status = err.code === 'unknown_plan' || err.code === 'price_not_configured' ? 400 : 500;
    console.error('[billing] checkout error:', err.message);
    res.status(status).json({ success: false, error: err.code || 'server_error', message: err.message });
  }
});

// ─── Customer portal (manage/cancel subscription) ─────────────────────────
router.get('/portal', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?._id) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }
    const base = process.env.APP_URL?.replace(/\/$/, '') || '';
    const { url } = await stripeService.createPortalSession({
      user,
      returnUrl: `${base}/settings/billing`,
    });
    res.json({ success: true, url });
  } catch (err) {
    console.error('[billing] portal error:', err.message);
    res.status(500).json({ success: false, error: 'portal_failed', message: err.message });
  }
});

// ─── Webhook (NO auth, signature-verified, RAW body) ──────────────────────
// CRITICAL: must receive the RAW body (Buffer). Mount BEFORE app.use(express.json())
// in app.js, OR rely on the inline express.raw() below. The webhook — not the
// /success endpoint — is the source of truth for granting credits.
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).send('Missing stripe-signature header');
    }

    let event;
    try {
      event = stripeService.verifyWebhookSignature(req.body, signature);
    } catch (err) {
      console.warn('[billing] webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await stripeService.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('[billing] webhook handler failed:', err.message, err.stack);
      res.status(500).send('Handler failed'); // 500 → Stripe retries w/ backoff
    }
  }
);

module.exports = router;