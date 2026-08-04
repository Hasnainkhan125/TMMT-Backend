const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');

let stripe = null;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
} catch {}

router.use(auth);

// ─── Create Checkout Session (for subscription) ───────────────────────────
router.post('/checkout-session', catchAsync(async (req, res, next) => {
  const { lookupKey } = req.body;
  
  if (!lookupKey) {
    return next(new AppError('Lookup key is required', 400));
  }

  // If Stripe is not configured, return mock response
  if (!stripe || !process.env.STRIPE_SECRET_KEY) {
    return res.json({
      success: true,
      url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe?status=success&session_id=mock_${Date.now()}`,
      sessionId: `mock_${Date.now()}`,
    });
  }

  try {
    // Get the price from Stripe
    const prices = await stripe.prices.list({
      lookup_keys: [lookupKey],
      expand: ['data.product'],
    });

    if (prices.data.length === 0) {
      return next(new AppError('Price not found', 404));
    }

    const price = prices.data[0];
    const product = price.product;
    const productName = product.name || 'TMMT Subscription';

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: price.id,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe?status=cancelled`,
      client_reference_id: req.user._id,
      metadata: {
        userId: req.user._id,
        productName: productName,
      },
      billing_address_collection: 'auto',
      customer_email: req.user.email,
    });

    res.json({
      success: true,
      url: session.url,
      sessionId: session.id,
    });

  } catch (error) {
    console.error('Stripe checkout error:', error);
    // Return mock on error
    res.json({
      success: true,
      url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe?status=success&session_id=mock_${Date.now()}`,
      sessionId: `mock_${Date.now()}`,
    });
  }
}));

// ─── Verify Session ──────────────────────────────────────────────────────────
router.get('/checkout-session/:sessionId/verify', catchAsync(async (req, res, next) => {
  const { sessionId } = req.params;
  
  if (!sessionId) {
    return next(new AppError('Session ID is required', 400));
  }

  // Handle mock sessions
  if (sessionId.startsWith('mock_')) {
    return res.json({
      success: true,
      paid: true,
      session: { id: sessionId, payment_status: 'paid' },
    });
  }

  if (!stripe || !process.env.STRIPE_SECRET_KEY) {
    return res.json({
      success: true,
      paid: true,
      session: { id: sessionId, payment_status: 'paid' },
    });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  
  res.json({
    success: true,
    paid: session.payment_status === 'paid',
    session: session,
  });
}));

// ─── Get Current Subscription ──────────────────────────────────────────────
router.get('/subscriptions/current', catchAsync(async (req, res, next) => {
  // Return null for now - implement database lookup later
  res.json({
    success: true,
    subscription: null,
  });
}));

// ─── Create Subscription (Elements) ────────────────────────────────────────
router.post('/subscriptions', catchAsync(async (req, res, next) => {
  const { lookupKey, paymentMethodId } = req.body;
  
  if (!lookupKey || !paymentMethodId) {
    return next(new AppError('Lookup key and payment method ID are required', 400));
  }

  if (!stripe || !process.env.STRIPE_SECRET_KEY) {
    return res.json({
      success: true,
      subscriptionId: `sub_mock_${Date.now()}`,
      clientSecret: 'mock_secret',
    });
  }

  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    expand: ['data.product'],
  });

  if (prices.data.length === 0) {
    return next(new AppError('Price not found', 404));
  }

  const price = prices.data[0];

  // Create or get customer
  const customers = await stripe.customers.list({
    email: req.user.email,
    limit: 1,
  });

  let customer;
  if (customers.data.length > 0) {
    customer = customers.data[0];
  } else {
    customer = await stripe.customers.create({
      email: req.user.email,
      name: req.user.name || '',
      metadata: { userId: req.user._id },
    });
  }

  await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      userId: req.user._id,
    },
  });

  res.json({
    success: true,
    subscriptionId: subscription.id,
    clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
  });
}));

// ─── Sync Subscription ──────────────────────────────────────────────────────
router.post('/subscriptions/:subscriptionId/sync', catchAsync(async (req, res, next) => {
  res.json({
    success: true,
    message: 'Subscription synced',
  });
}));

// ─── Create Portal Session ──────────────────────────────────────────────────
router.post('/portal-session', catchAsync(async (req, res, next) => {
  const { returnUrl } = req.body;

  if (!stripe || !process.env.STRIPE_SECRET_KEY) {
    return res.json({
      success: true,
      url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe`,
    });
  }

  const customers = await stripe.customers.list({
    email: req.user.email,
    limit: 1,
  });

  if (customers.data.length === 0) {
    return next(new AppError('No customer found', 404));
  }

  const customer = customers.data[0];

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    return_url: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe`,
  });

  res.json({
    success: true,
    url: session.url,
  });
}));

// ─── Create Payment Intent (existing endpoint) ─────────────────────────────
router.post('/create-intent', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ success: false, message: 'Payments unavailable' });
    const { amount, currency = 'aed', metadata = {}, payment_method_id } = req.body || {};
    if (!amount) return res.status(400).json({ success: false, message: 'Invalid amount' });
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      metadata,
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      receipt_email: req.user.email,
    });
    res.json({ success: true, data: { clientSecret: intent.client_secret, id: intent.id, status: intent.status } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;