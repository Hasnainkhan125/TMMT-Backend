const BrandProject = require('../../model/schema/brandProject');
const User = require('../../model/schema/user');
// creditsService.recordTopUp is used to mirror every paid top-up into
// CreditLedger so finance can reconcile sold vs burned credits. We keep
// the atomic $inc on User for hot-path balance reads.
const creditsService = require('../../services/creditsService');

// Lazy stripe instance — must not crash if STRIPE_SECRET_KEY is unset (dev/test).
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = require('stripe')(key);
  return _stripe;
}

// Credit packages — single source of truth for pricing.
// AED is settled by Stripe in fils (1 AED = 100 fils).
const CREDIT_PACKAGES = {
  starter: { credits: 100, amountAED: 99,  label: 'Starter — 100 credits' },
  pro:     { credits: 250, amountAED: 199, label: 'Pro — 250 credits' },
  agency:  { credits: 600, amountAED: 399, label: 'Agency — 600 credits' },
};

// ─── Credit costs ─────────────────────────────────────────────────────────────
const CREDIT_COSTS = {
  mockup:   2,
  label:    1,
  bottle:   2,
  packaging:2,
  logo:     3,
  ad_video: 5,
};

const DEFAULT_CREDITS = 20;

// ─── Ensure user has credits on first touch ───────────────────────────────────
async function ensureCredits(userId) {
  const user = await User.findById(userId).select('platformCredits');
  if (!user) return null;
  if ((user.platformCredits || 0) === 0) {
    await User.findByIdAndUpdate(userId, { $set: { platformCredits: DEFAULT_CREDITS } });
    return DEFAULT_CREDITS;
  }
  return user.platformCredits;
}

// ─── Upsell generator ─────────────────────────────────────────────────────────
function generateUpsells(project) {
  const suggestions = [];
  const pkg = project.packaging || {};
  if (!pkg.nfcEnabled)      suggestions.push('Enable NFC smart tags to let customers reorder with a tap');
  if (!pkg.qrCodeEnabled)   suggestions.push('Add a QR code on packaging linking to your brand story');
  if (!project.adVideo?.url) suggestions.push('Create a 15-second ad video — brands with video see 3x more engagement');
  if ((project.generatedAssets || []).length < 3) suggestions.push('Generate a full mockup set to share with investors and buyers');
  if (!project.targetCountries?.length) suggestions.push('Define your target markets to receive optimised supplier quotations');
  if (project.pricePoint !== 'luxury' && project.pricePoint !== 'ultra-luxury')
    suggestions.push('Upgrade to premium packaging — luxury positioning increases margins by 40–60%');
  return suggestions.slice(0, 3);
}

// ─── Completion score ─────────────────────────────────────────────────────────
function calcCompletionScore(project) {
  let score = 0;
  if (project.projectName)        score += 10;
  if (project.businessType)       score += 10;
  if (project.fragranceConfig?.brandName || project.skincareConfig?.brandName || project.customFields?.length) score += 20;
  if (project.packaging?.bottleShape || project.packaging?.productLine) score += 15;
  if (project.selectedSupplierId) score += 15;
  if (project.quantity)           score += 10;
  if (project.targetMarket)       score += 10;
  if ((project.generatedAssets || []).length) score += 5;
  if (project.adVideo?.status === 'ready') score += 5;
  return Math.min(score, 100);
}

// ─── Funnel stage (demand creation pipeline) ─────────────────────────────────
// 1=Dream, 2=Brand Built, 3=Identity Lock, 4=Next Step, 5=Conversion, 6=Ascension
function calcFunnelStage(project) {
  if (project.status === 'launched') return 6;
  if (project.selectedSupplierId && project.quotation) return 5;
  if (project.wizardCompleted || project.config?.brand) return 4;
  if ((project.generatedAssets || []).length > 0 || project.config?.brand) return 3;
  if (project.businessType) return 2;
  return 1;
}

// ─── POST /api/v1/brand-projects ─────────────────────────────────────────────
exports.createProject = async (req, res) => {
  try {
    const userId = req.user._id;
    await ensureCredits(userId);

    const { businessType, projectName, customBusinessType } = req.body;
    if (!businessType || !projectName) {
      return res.status(400).json({ success: false, message: 'businessType and projectName are required.' });
    }

    const project = await BrandProject.create({
      user: userId,
      businessType,
      projectName,
      customBusinessType: customBusinessType || null,
      wizardStep: 1,
      status: 'draft',
    });

    res.status(201).json({ success: true, project });
  } catch (err) {
    console.error('[BrandProject] createProject:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── GET /api/v1/brand-projects ───────────────────────────────────────────────
exports.listProjects = async (req, res) => {
  try {
    const userId = req.user._id;
    const credits = await ensureCredits(userId);
    const projects = await BrandProject.find({ user: userId, isArchived: false }).sort({ updatedAt: -1 });
    const projectsWithStage = projects.map(p => ({
      ...p.toObject(),
      funnelStage: calcFunnelStage(p),
    }));
    res.json({ success: true, projects: projectsWithStage, credits });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── GET /api/v1/brand-projects/:id ─────────────────────────────────────────
exports.getProject = async (req, res) => {
  try {
    const project = await BrandProject.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
    const user = await User.findById(req.user._id).select('platformCredits');
    res.json({ success: true, project, credits: user?.platformCredits || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── PUT /api/v1/brand-projects/:id ─────────────────────────────────────────
exports.updateProject = async (req, res) => {
  try {
    const project = await BrandProject.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

    const allowed = [
      'projectName', 'wizardStep', 'wizardCompleted', 'status',
      'fragranceConfig', 'skincareConfig', 'customFields', 'customBusinessType',
      'packaging', 'quantity', 'targetMarket', 'targetCountries', 'pricePoint',
      'selectedSupplierId', 'quotation',
    ];

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) project[key] = req.body[key];
    });

    // Recalculate derived fields
    project.completionScore = calcCompletionScore(project);
    project.upsellSuggestions = generateUpsells(project);
    if (project.wizardCompleted && project.status === 'draft') project.status = 'configured';

    await project.save();
    res.json({ success: true, project });
  } catch (err) {
    console.error('[BrandProject] updateProject:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── POST /api/v1/brand-projects/:id/generate-asset ────────────────────────
exports.generateAsset = async (req, res) => {
  try {
    const { type, prompt, style } = req.body;
    if (!type || !CREDIT_COSTS[type]) {
      return res.status(400).json({ success: false, message: 'Invalid asset type.' });
    }

    const user = await User.findById(req.user._id).select('platformCredits');
    const cost = CREDIT_COSTS[type];
    if ((user.platformCredits || 0) < cost) {
      return res.status(402).json({
        success: false,
        message: `Insufficient credits. This action requires ${cost} credits.`,
        required: cost,
        available: user.platformCredits || 0,
      });
    }

    const project = await BrandProject.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

    // Deduct credits
    await User.findByIdAndUpdate(req.user._id, { $inc: { platformCredits: -cost } });

    // Add asset placeholder (in production, trigger AI generation service)
    const asset = {
      type,
      prompt: prompt || `Generate a ${type} for brand: ${project.projectName}`,
      style: style || 'photorealistic',
      creditsCost: cost,
      status: 'generating',
      generatedAt: new Date(),
      // Placeholder URL — in production, replace with AI generation callback
      url: null,
      thumbnail: null,
    };

    project.generatedAssets.push(asset);
    project.completionScore = calcCompletionScore(project);
    project.upsellSuggestions = generateUpsells(project);
    await project.save();

    const updatedUser = await User.findById(req.user._id).select('platformCredits');
    res.json({
      success: true,
      asset: project.generatedAssets[project.generatedAssets.length - 1],
      creditsRemaining: updatedUser.platformCredits,
      project,
    });
  } catch (err) {
    console.error('[BrandProject] generateAsset:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── POST /api/v1/brand-projects/:id/generate-video ─────────────────────────
exports.generateAdVideo = async (req, res) => {
  try {
    const { script, style } = req.body;
    const user = await User.findById(req.user._id).select('platformCredits');
    const cost = CREDIT_COSTS.ad_video;

    if ((user.platformCredits || 0) < cost) {
      return res.status(402).json({
        success: false,
        message: `Insufficient credits. Ad video generation requires ${cost} credits.`,
        required: cost,
        available: user.platformCredits || 0,
      });
    }

    const project = await BrandProject.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

    await User.findByIdAndUpdate(req.user._id, { $inc: { platformCredits: -cost } });

    project.adVideo = {
      status: 'generating',
      script: script || null,
      style:  style  || 'cinematic',
      creditsCost: cost,
      generatedAt: new Date(),
      url: null,
    };

    await project.save();
    const updatedUser = await User.findById(req.user._id).select('platformCredits');

    res.json({
      success: true,
      adVideo: project.adVideo,
      creditsRemaining: updatedUser.platformCredits,
    });
  } catch (err) {
    console.error('[BrandProject] generateAdVideo:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── POST /api/v1/brand-projects/:id/send-quotation ─────────────────────────
exports.sendQuotation = async (req, res) => {
  try {
    const { supplierId, supplierName, quantity, pricePerUnit, leadTimeDays, currency = 'USD' } = req.body;
    const project = await BrandProject.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

    const totalCost = (quantity || project.quantity || 0) * (pricePerUnit || 0);
    project.selectedSupplierId = supplierId;
    project.quotation = { supplierId, supplierName, quantity, pricePerUnit, totalCost, currency, leadTimeDays, status: 'sent', sentAt: new Date() };
    project.status = 'quotation_sent';
    await project.save();

    res.json({ success: true, project });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── POST /api/v1/brand-projects/credits/buy ────────────────────────────────
// Creates a Stripe Checkout Session for one of the predefined credit packages.
// Body: { packageId: 'starter'|'pro'|'agency', successUrl?, cancelUrl? }
// Returns: { url } — frontend redirects to Stripe-hosted checkout.
exports.buyCredits = async (req, res) => {
  try {
    const { packageId, successUrl, cancelUrl } = req.body;
    const pkg = CREDIT_PACKAGES[packageId];
    if (!pkg) {
      return res.status(400).json({
        success: false,
        message: 'Unknown packageId. Use starter | pro | agency.',
        packages: CREDIT_PACKAGES,
      });
    }

    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({
        success: false,
        message: 'Billing is not configured (STRIPE_SECRET_KEY missing).',
      });
    }

    // Pre-record a pending top-up so we have something to reconcile against.
    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          topUpHistory: {
            amount: pkg.credits,
            method: 'card',
            reference: `pending_${Date.now()}`,
            status: 'pending',
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).select('email platformCredits topUpHistory');

    const topUp = user.topUpHistory[user.topUpHistory.length - 1];

    const baseUrl = process.env.FRONTEND_URL || 'https://qumak.ae';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'aed',
          product_data: { name: pkg.label, description: `${pkg.credits} Qumak credits` },
          unit_amount: pkg.amountAED * 100, // fils
        },
        quantity: 1,
      }],
      customer_email: user.email,
      metadata: {
        type: 'qumak_credits',
        userId: req.user._id.toString(),
        packageId,
        credits: String(pkg.credits),
        topUpId: topUp._id.toString(),
      },
      success_url: successUrl || `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${baseUrl}/billing/cancel`,
    });

    return res.json({
      success: true,
      url: session.url,
      sessionId: session.id,
      packageId,
      credits: pkg.credits,
      amountAED: pkg.amountAED,
    });
  } catch (err) {
    console.error('[BrandProject] buyCredits:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── POST /api/v1/brand-projects/credits/confirm ─────────────────────────────
// Confirms a Stripe Checkout Session — credits are only granted after Stripe
// reports the session is `complete` AND `payment_status === 'paid'`.
// Idempotent: a topUp marked `credited` will not be credited again.
exports.confirmCredits = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId required.' });
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ success: false, message: 'Billing not configured.' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status !== 'complete' || session.payment_status !== 'paid') {
      return res.status(400).json({
        success: false,
        message: `Stripe session not paid — status=${session.status}, payment_status=${session.payment_status}`,
      });
    }
    if (session.metadata?.userId !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Session does not belong to caller.' });
    }
    const credits = Number(session.metadata?.credits) || 0;
    const topUpId = session.metadata?.topUpId;
    if (!credits || !topUpId) {
      return res.status(400).json({ success: false, message: 'Session metadata incomplete.' });
    }

    // Atomic: only credit if topUp is still pending. Prevents replay double-credit.
    const updated = await User.findOneAndUpdate(
      { _id: req.user._id, 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      {
        $inc: { platformCredits: credits },
        $set: {
          'topUpHistory.$.status': 'credited',
          'topUpHistory.$.reference': session.payment_intent || session.id,
          'topUpHistory.$.creditedAt': new Date(),
        },
      },
      { new: true }
    ).select('platformCredits');

    if (!updated) {
      // Already credited — return current balance, idempotent.
      const u = await User.findById(req.user._id).select('platformCredits');
      return res.json({ success: true, alreadyCredited: true, creditsRemaining: u?.platformCredits ?? 0 });
    }

    // Ledger mirror. Fire-and-forget — a missing ledger row is recoverable
    // from topUpHistory; a failed response isn't.
    creditsService.recordTopUp({
      userId: req.user._id,
      amount: credits,
      reason: 'topup_stripe',
      balanceAfter: updated.platformCredits,
      meta: {
        topUpId,
        stripeSessionId: session.id,
        paymentIntent: session.payment_intent,
        amountAED: session.amount_total ? session.amount_total / 100 : null,
      },
    }).catch((err) => req.log?.warn({ err, topUpId }, 'ledger_mirror_failed'));

    return res.json({ success: true, creditsRemaining: updated.platformCredits });
  } catch (err) {
    console.error('[BrandProject] confirmCredits:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── Internal: webhook handler for Stripe checkout.session.completed ─────────
// Wired by index.js. Same idempotent crediting as confirmCredits, but covers
// the case where the buyer never returns to /billing/success.
exports.handleStripeWebhookEvent = async (event) => {
  try {
    if (event.type !== 'checkout.session.completed') return;
    const session = event.data.object;
    if (session.metadata?.type !== 'qumak_credits') return;
    if (session.payment_status !== 'paid') return;

    const userId = session.metadata.userId;
    const credits = Number(session.metadata.credits) || 0;
    const topUpId = session.metadata.topUpId;
    if (!userId || !credits || !topUpId) return;

    const updated = await User.findOneAndUpdate(
      { _id: userId, 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      {
        $inc: { platformCredits: credits },
        $set: {
          'topUpHistory.$.status': 'credited',
          'topUpHistory.$.reference': session.payment_intent || session.id,
          'topUpHistory.$.creditedAt': new Date(),
        },
      },
      { new: true, projection: { platformCredits: 1 } }
    );

    // If we actually credited (i.e. not a replay), mirror into the ledger.
    if (updated) {
      await creditsService.recordTopUp({
        userId,
        amount: credits,
        reason: 'topup_stripe',
        balanceAfter: updated.platformCredits,
        meta: {
          topUpId,
          stripeSessionId: session.id,
          paymentIntent: session.payment_intent,
          source: 'webhook',
        },
      }).catch((err) => console.warn('[BrandProject] ledger mirror failed:', err.message));
    }
  } catch (err) {
    console.error('[BrandProject] handleStripeWebhookEvent:', err);
  }
};

// ─── POST /api/v1/brand-projects/credits/buy/tabby ──────────────────────────
// Same packages, paid via Tabby (BNPL — UAE/KSA/Kuwait/Bahrain).
exports.buyCreditsTabby = async (req, res) => {
  try {
    const bnpl = require('../../services/bnplService');
    const { packageId } = req.body || {};
    const pkg = CREDIT_PACKAGES[packageId];
    if (!pkg) {
      return res.status(400).json({ success: false, message: 'Unknown packageId.', packages: CREDIT_PACKAGES });
    }
    if (!bnpl.tabbyConfigured()) {
      return res.status(503).json({ success: false, message: 'Tabby is not configured.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          topUpHistory: {
            amount: pkg.credits,
            method: 'tabby',
            reference: `pending_tabby_${Date.now()}`,
            status: 'pending',
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).select('email name phone platformCredits topUpHistory createdAt');

    const topUp = user.topUpHistory[user.topUpHistory.length - 1];
    const result = await bnpl.createTabbyCheckout({ pkg, user, topUpId: topUp._id, packageId });

    if (!result.available) {
      return res.status(409).json({
        success: false,
        message: result.rejectionReason
          ? `Tabby declined: ${result.rejectionReason}`
          : 'Tabby is unavailable for this customer; try card or Tamara.',
      });
    }

    await User.updateOne(
      { _id: req.user._id, 'topUpHistory._id': topUp._id },
      { $set: { 'topUpHistory.$.reference': `tabby_${result.sessionId}` } }
    );

    res.json({ success: true, provider: 'tabby', url: result.url, sessionId: result.sessionId });
  } catch (err) {
    console.error('[BrandProject] buyCreditsTabby:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/v1/brand-projects/credits/buy/tamara ──────────────────────────
// Same packages, paid via Tamara (BNPL — KSA-leading, also UAE/Kuwait).
exports.buyCreditsTamara = async (req, res) => {
  try {
    const bnpl = require('../../services/bnplService');
    const { packageId } = req.body || {};
    const pkg = CREDIT_PACKAGES[packageId];
    if (!pkg) {
      return res.status(400).json({ success: false, message: 'Unknown packageId.', packages: CREDIT_PACKAGES });
    }
    if (!bnpl.tamaraConfigured()) {
      return res.status(503).json({ success: false, message: 'Tamara is not configured.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          topUpHistory: {
            amount: pkg.credits,
            method: 'tamara',
            reference: `pending_tamara_${Date.now()}`,
            status: 'pending',
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).select('email name phone platformCredits topUpHistory createdAt');

    const topUp = user.topUpHistory[user.topUpHistory.length - 1];
    const result = await bnpl.createTamaraCheckout({ pkg, user, topUpId: topUp._id, packageId });

    if (!result.available) {
      return res.status(409).json({ success: false, message: 'Tamara checkout unavailable.' });
    }

    await User.updateOne(
      { _id: req.user._id, 'topUpHistory._id': topUp._id },
      { $set: { 'topUpHistory.$.reference': `tamara_${result.orderId}` } }
    );

    res.json({ success: true, provider: 'tamara', url: result.url, orderId: result.orderId });
  } catch (err) {
    console.error('[BrandProject] buyCreditsTamara:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Webhooks ────────────────────────────────────────────────────────────────
// Both Tabby and Tamara post a webhook when payment captures. We only credit
// when the upstream API confirms the payment is captured/authorised — we never
// trust webhook body alone (mirrors the Stripe flow).
exports.handleTabbyWebhook = async (req, res) => {
  try {
    const bnpl = require('../../services/bnplService');
    const event = req.body || {};
    const paymentId = event.id || event.payment_id;
    if (!paymentId) return res.status(400).send('missing id');

    const payment = await bnpl.getTabbyPayment(paymentId);
    const status  = payment?.status;
    const reference = payment?.order?.reference_id || '';
    const topUpId  = reference.startsWith('qumak_credits_') ? reference.replace('qumak_credits_', '') : null;

    if (status !== 'AUTHORIZED' && status !== 'CLOSED') return res.json({ ok: true, ignored: status });
    if (!topUpId) return res.json({ ok: true, ignored: 'no_topup_id' });

    // Find-before-update so we can (a) mirror the ledger and (b) know the
    // amount to credit. We could do it atomically with an aggregation
    // pipeline, but we also need the amount + userId for ledger provenance.
    const pending = await User.findOne(
      { 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      { _id: 1, platformCredits: 1, 'topUpHistory.$': 1 }
    ).lean();
    if (!pending) return res.json({ ok: true, ignored: 'not_pending' });
    const topUp = pending.topUpHistory?.[0];
    const amount = Number(topUp?.amount) || 0;
    if (!amount) return res.json({ ok: true, ignored: 'zero_amount' });

    const updated = await User.findOneAndUpdate(
      { _id: pending._id, 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      {
        $inc: { platformCredits: amount },
        $set: {
          'topUpHistory.$.status': 'credited',
          'topUpHistory.$.reference': `tabby_payment_${paymentId}`,
          'topUpHistory.$.creditedAt': new Date(),
        },
      },
      { new: true, projection: { platformCredits: 1 } }
    );

    if (updated) {
      await creditsService.recordTopUp({
        userId: pending._id,
        amount,
        reason: 'topup_tabby',
        balanceAfter: updated.platformCredits,
        meta: { topUpId, paymentId, source: 'webhook' },
      }).catch((err) => console.warn('[BrandProject] ledger mirror failed (tabby):', err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[BrandProject] handleTabbyWebhook:', err.message);
    res.status(500).send('error');
  }
};

exports.handleTamaraWebhook = async (req, res) => {
  try {
    const bnpl = require('../../services/bnplService');
    const event = req.body || {};
    const orderId = event.order_id;
    if (!orderId) return res.status(400).send('missing order_id');

    const order = await bnpl.getTamaraOrder(orderId);
    const status = order?.status;
    const orderRef = order?.order_reference_id || '';
    const topUpId = orderRef.startsWith('qumak_credits_') ? orderRef.replace('qumak_credits_', '') : null;

    if (status !== 'approved' && status !== 'authorised' && status !== 'fully_captured') {
      return res.json({ ok: true, ignored: status });
    }
    if (!topUpId) return res.json({ ok: true, ignored: 'no_topup_id' });

    const pending = await User.findOne(
      { 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      { _id: 1, platformCredits: 1, 'topUpHistory.$': 1 }
    ).lean();
    if (!pending) return res.json({ ok: true, ignored: 'not_pending' });
    const topUp = pending.topUpHistory?.[0];
    const amount = Number(topUp?.amount) || 0;
    if (!amount) return res.json({ ok: true, ignored: 'zero_amount' });

    const updated = await User.findOneAndUpdate(
      { _id: pending._id, 'topUpHistory._id': topUpId, 'topUpHistory.status': 'pending' },
      {
        $inc: { platformCredits: amount },
        $set: {
          'topUpHistory.$.status': 'credited',
          'topUpHistory.$.reference': `tamara_order_${orderId}`,
          'topUpHistory.$.creditedAt': new Date(),
        },
      },
      { new: true, projection: { platformCredits: 1 } }
    );

    if (updated) {
      await creditsService.recordTopUp({
        userId: pending._id,
        amount,
        reason: 'topup_tamara',
        balanceAfter: updated.platformCredits,
        meta: { topUpId, orderId, source: 'webhook' },
      }).catch((err) => console.warn('[BrandProject] ledger mirror failed (tamara):', err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[BrandProject] handleTamaraWebhook:', err.message);
    res.status(500).send('error');
  }
};

// ─── POST /api/v1/brand-projects/credits/grant (admin) ───────────────────────
// Manual credit grant for support / promotions. Admin-only.
exports.adminGrantCredits = async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'userId and positive amount required.' });
    }
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $inc: { platformCredits: amount },
        $push: {
          topUpHistory: {
            amount,
            method: 'institutional_credit',
            reference: note || `admin_grant_by_${req.user._id}`,
            status: 'credited',
            creditedAt: new Date(),
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).select('platformCredits email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await creditsService.recordTopUp({
      userId,
      amount,
      reason: 'topup_admin',
      balanceAfter: user.platformCredits,
      meta: { note: note || null, grantedBy: String(req.user._id) },
    }).catch((err) => req.log?.warn({ err }, 'admin_grant_ledger_failed'));

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── GET /api/v1/brand-projects/credits/packages ─────────────────────────────
exports.getCreditPackages = (_req, res) => {
  res.json({ success: true, packages: CREDIT_PACKAGES });
};

// ─── GET /api/v1/brand-projects/credits ─────────────────────────────────────
exports.getCredits = async (req, res) => {
  try {
    const credits = await ensureCredits(req.user._id);
    res.json({ success: true, credits });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── GET /api/v1/brand-projects/credits/balance (no auto top-up — for gating AI) ─
exports.getCreditsBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('platformCredits');
    res.json({ success: true, credits: user?.platformCredits ?? 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── DELETE /api/v1/brand-projects/:id ──────────────────────────────────────
exports.archiveProject = async (req, res) => {
  try {
    await BrandProject.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { isArchived: true });
    res.json({ success: true, message: 'Project archived.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── GET /api/v1/brand-projects/admin/all (admin only) ─────────────────────
exports.adminGetAll = async (req, res) => {
  try {
    const projects = await BrandProject.find({ isArchived: { $ne: true } })
      .populate('user', 'name email phone createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const enriched = projects.map(p => ({
      ...p,
      completionScore: calcCompletionScore(p),
      brandName: p.fragranceConfig?.brandName || p.skincareConfig?.brandName || p.customFields?.find(f => f.key === 'brandName')?.value || p.config?.brand?.brandName || p.projectName || '—',
      tagline: p.fragranceConfig?.tagline || p.skincareConfig?.tagline || p.customFields?.find(f => f.key === 'tagline')?.value || p.config?.brand?.tagline || '—',
      category: p.businessType || 'custom',
      email: p.user?.email || '—',
      phone: p.user?.phone || '—',
      ownerName: p.user?.name || '—',
    }));

    res.json({ success: true, projects: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ─── PATCH /api/v1/brand-projects/admin/:id (admin edit) ───────────────────
exports.adminUpdateProject = async (req, res) => {
  try {
    const allowed = ['projectName', 'status', 'fragranceConfig', 'skincareConfig', 'customFields', 'notes'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const project = await BrandProject.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .populate('user', 'name email phone');

    if (!project) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, project });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

