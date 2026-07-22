const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');

let stripe = null;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
} catch {}

router.use(auth);

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
      // automatic_payment_methods: { enabled: true },
      receipt_email: req.user.email,
    });
    res.json({ success: true, data: { clientSecret: intent.client_secret, id: intent.id, status: intent.status } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;


