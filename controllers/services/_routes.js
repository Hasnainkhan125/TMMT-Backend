const express = require('express');
const router = express.Router();
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;
const servicesController = require('./servicesController');
const auth = require('../../middelwares/auth');
const { requireRole } = require('../../middelwares/auth');

// Public routes - no authentication required
router.get('/categories', servicesController.getCategories);
router.get('/subcategories', servicesController.getSubcategories);
router.get('/services', servicesController.getServices);
router.get('/services/:id', servicesController.getServiceById);
router.get('/search', servicesController.searchServices);
router.get('/stats', servicesController.getStats);

// Protected routes - require authentication
router.post('/services', auth, requireRole('admin', 'amer'), servicesController.createService);
router.put('/services/:id', auth, requireRole('admin', 'amer'), servicesController.updateService);
router.delete('/services/:id', auth, requireRole('admin'), servicesController.deleteService);

// Admin-only routes
router.post('/reload', auth, requireRole('admin'), servicesController.reloadServices);
router.post('/backup', auth, requireRole('admin'), servicesController.backupServices);
router.post('/restore', auth, requireRole('admin'), servicesController.restoreServices);

// Payments: create Stripe PaymentIntent (optional configuration)
router.post('/payments/create-intent', auth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, message: 'Stripe not configured' });
    const { amount, currency = 'aed', metadata = {} } = req.body || {};
    if (!amount || Number.isNaN(Number(amount))) {
      return res.status(400).json({ success: false, message: 'Amount is required' });
    }
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount)),
      currency,
      metadata,
      description: 'QUMAK application payment'
    });
    res.status(200).json({ success: true, data: { clientSecret: intent.client_secret } });
  } catch (e) {
    console.error('Stripe create-intent error', e);
    res.status(500).json({ success: false, message: 'Failed to create payment intent' });
  }
});

module.exports = router; 