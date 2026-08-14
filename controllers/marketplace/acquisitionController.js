/**
 * Acquisition Flow Controller
 * Handles: deposit payment (Stripe + USDC), due diligence period,
 * agreement signing, final payment, and business transfer.
 */
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ethers } = require('ethers');
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const AcquisitionFlow = require('../../model/schema/acquisitionFlow');
const BusinessListing = require('../../model/schema/businessListing');
const MarketplaceBid = require('../../model/schema/marketplaceBid');
const AuctionDocument = require('../../model/schema/auctionDocument');

const DEPOSIT_PCT = Number(process.env.ACQUISITION_DEPOSIT_PERCENT) || 10;
const DEPOSIT_DUE_HOURS = Number(process.env.DEPOSIT_DUE_HOURS) || 24;
const DD_DAYS = Number(process.env.DD_PERIOD_DAYS) || 21;

/* ─── Minimal ERC-20 ABI for balance/transfer checking ─── */
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

/* ══════════════════════════════════════════════════════════
   ACQUISITION FLOW — CRUD
══════════════════════════════════════════════════════════ */

/**
 * POST /api/v1/marketplace/acquisition
 * Called when auction ends — creates the acquisition flow for the winner.
 * Can also be called manually by admin.
 */
exports.createAcquisitionFlow = catchAsync(async (req, res, next) => {
  const { listingId, winningBidId } = req.body;

  const listing = await BusinessListing.findById(listingId);
  if (!listing) return next(new AppError('Listing not found', 404));

  const winningBid = await MarketplaceBid.findById(winningBidId).populate('bidder');
  if (!winningBid) return next(new AppError('Winning bid not found', 404));

  // Check if flow already exists
  const existing = await AcquisitionFlow.findOne({ listing: listingId });
  if (existing) {
    return res.status(200).json({ status: 'success', data: { acquisition: existing } });
  }

  const depositAmount = Math.round(winningBid.amount * (DEPOSIT_PCT / 100));
  const depositDue = new Date(Date.now() + DEPOSIT_DUE_HOURS * 3_600_000);

  const acquisition = await AcquisitionFlow.create({
    listing: listing._id,
    winningBid: winningBid._id,
    buyer: winningBid.bidder._id,
    winningAmount: winningBid.amount,
    depositAmount,
    finalPaymentAmount: winningBid.amount - depositAmount,
    stage: 'deposit_pending',
    stages: {
      deposit: { dueAt: depositDue, amount: depositAmount },
    },
  });

  // Update listing status
  await BusinessListing.findByIdAndUpdate(listingId, {
    listingStatus: 'under_offer',
  });

  // Broadcast via WebSocket
  const wsServer = req.app.get('wsServer');
  if (wsServer) {
    wsServer.broadcastToRoom(`auction_${listingId}`, {
      type: 'auction_won',
      acquisitionId: acquisition._id,
      buyerId: winningBid.bidder._id,
      winningAmount: winningBid.amount,
      depositAmount,
      depositDueAt: depositDue,
    });
  }

  res.status(201).json({ status: 'success', data: { acquisition } });
});

/**
 * GET /api/v1/marketplace/acquisition/:id
 * Buyer or admin fetches their acquisition flow.
 */
exports.getAcquisitionFlow = catchAsync(async (req, res, next) => {
  const query = AcquisitionFlow.findById(req.params.id)
    .populate('listing', 'name industry financials location images auction')
    .populate('buyer', 'name email phone')
    .populate('winningBid', 'amount bidType');

  const acquisition = await query;
  if (!acquisition) return next(new AppError('Acquisition not found', 404));

  // Security: only buyer or admin can see
  if (
    req.user._id.toString() !== acquisition.buyer._id.toString() &&
    req.user.role !== 'admin' && req.user.role !== 'amer'
  ) {
    return next(new AppError('Access denied', 403));
  }

  res.status(200).json({ status: 'success', data: { acquisition } });
});

/**
 * GET /api/v1/marketplace/acquisition/my
 * Returns all acquisition flows for the authenticated buyer.
 */
exports.getMyAcquisitions = catchAsync(async (req, res, next) => {
  const acquisitions = await AcquisitionFlow.find({ buyer: req.user._id })
    .populate('listing', 'name industry financials location images')
    .sort('-createdAt')
    .lean();

  res.status(200).json({ status: 'success', data: { acquisitions } });
});

/* ══════════════════════════════════════════════════════════
   PAYMENTS — STRIPE DEPOSIT
══════════════════════════════════════════════════════════ */

/**
 * POST /api/v1/marketplace/acquisition/:id/deposit/stripe
 * Creates a Stripe PaymentIntent for the deposit.
 */
exports.createStripeDepositIntent = catchAsync(async (req, res, next) => {
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }
  if (acquisition.stage !== 'deposit_pending') {
    return next(new AppError('Deposit already processed or not in deposit stage', 400));
  }

  const amountInFils = acquisition.depositAmount * 100; // AED fils (smallest unit)

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInFils,
    currency: 'aed',
    metadata: {
      acquisitionId: acquisition._id.toString(),
      listingId: acquisition.listing.toString(),
      buyerId: req.user._id.toString(),
      type: 'acquisition_deposit',
    },
    description: `Acquisition deposit — ${acquisition._id}`,
  });

  res.status(200).json({
    status: 'success',
    data: {
      clientSecret: paymentIntent.client_secret,
      amount: acquisition.depositAmount,
      currency: 'AED',
      paymentIntentId: paymentIntent.id,
    },
  });
});

/**
 * POST /api/v1/marketplace/acquisition/:id/deposit/confirm
 * Confirms deposit payment (called after Stripe client-side confirmation).
 */
exports.confirmStripeDeposit = catchAsync(async (req, res, next) => {
  const { paymentIntentId } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }

  // Verify with Stripe
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (pi.status !== 'succeeded') {
    return next(new AppError(`Payment not succeeded — status: ${pi.status}`, 400));
  }

  await _advanceToDD(acquisition, 'stripe', paymentIntentId);

  res.status(200).json({ status: 'success', data: { acquisition } });
});

/* ══════════════════════════════════════════════════════════
   PAYMENTS — STRIPE FINAL
══════════════════════════════════════════════════════════ */

exports.createStripeFinalPaymentIntent = catchAsync(async (req, res, next) => {
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }
  if (acquisition.stage !== 'final_payment') {
    return next(new AppError('Not in final payment stage', 400));
  }

  const amountInFils = acquisition.finalPaymentAmount * 100;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInFils,
    currency: 'aed',
    metadata: {
      acquisitionId: acquisition._id.toString(),
      type: 'acquisition_final_payment',
    },
    description: `Final acquisition payment — ${acquisition._id}`,
  });

  res.status(200).json({
    status: 'success',
    data: {
      clientSecret: paymentIntent.client_secret,
      amount: acquisition.finalPaymentAmount,
      currency: 'AED',
      paymentIntentId: paymentIntent.id,
    },
  });
});

exports.confirmStripeFinalPayment = catchAsync(async (req, res, next) => {
  const { paymentIntentId } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (pi.status !== 'succeeded') {
    return next(new AppError(`Payment not succeeded — status: ${pi.status}`, 400));
  }

  acquisition.stages.finalPayment = {
    ...acquisition.stages.finalPayment,
    paidAt: new Date(),
    paymentMethod: 'stripe',
    stripePaymentIntentId: paymentIntentId,
  };
  acquisition.stage = 'transfer';
  acquisition.stages.transfer = { startedAt: new Date() };
  await acquisition.save();

  _broadcastStageUpdate(req.app, acquisition, 'transfer');

  res.status(200).json({ status: 'success', data: { acquisition } });
});

/* ══════════════════════════════════════════════════════════
   PAYMENTS — CRYPTO (USDC / USDT)
══════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/acquisition/:id/deposit/crypto-address
 * Returns the escrow wallet + expected USDC amount for deposit.
 */
exports.getCryptoDepositAddress = catchAsync(async (req, res, next) => {
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }

  const escrowWallet = process.env.CRYPTO_ESCROW_WALLET;
  if (!escrowWallet) return next(new AppError('Crypto payments not configured', 503));

  // Convert AED → USD approx (use 3.67 AED/USD peg)
  const AED_TO_USD = 3.67;
  const usdcAmount = (acquisition.depositAmount / AED_TO_USD).toFixed(2);

  res.status(200).json({
    status: 'success',
    data: {
      escrowWallet,
      usdcAmount: Number(usdcAmount),
      aedAmount: acquisition.depositAmount,
      networks: [
        { name: 'Ethereum', chainId: 1, contractAddress: process.env.USDC_CONTRACT_ETHEREUM || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        { name: 'Polygon', chainId: 137, contractAddress: process.env.USDC_CONTRACT_POLYGON || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
      ],
      memo: `ACQ-${acquisition._id.toString().slice(-8).toUpperCase()}`,
      expiresAt: new Date(Date.now() + 2 * 3_600_000), // 2 hour window
    },
  });
});

/**
 * POST /api/v1/marketplace/acquisition/:id/deposit/crypto-confirm
 * Buyer submits the transaction hash. Backend verifies on-chain.
 */
exports.confirmCryptoDeposit = catchAsync(async (req, res, next) => {
  const { txHash, network = 'ethereum' } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }
  if (!txHash) return next(new AppError('Transaction hash is required', 400));

  // Attempt on-chain verification
  let verified = false;
  let verificationNote = 'pending_manual_review';

  try {
    const rpcUrl = network === 'polygon'
      ? process.env.POLYGON_RPC_URL
      : process.env.ETHEREUM_RPC_URL;

    if (rpcUrl) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt && receipt.status === 1) {
        const escrowWallet = process.env.CRYPTO_ESCROW_WALLET?.toLowerCase();
        const AED_TO_USD = 3.67;
        const expectedUSDC = Math.floor((acquisition.depositAmount / AED_TO_USD) * 1e6); // USDC has 6 decimals
        const tolerance = expectedUSDC * 0.02; // 2% tolerance

        // Parse Transfer events from the receipt
        const contractAddress = network === 'polygon'
          ? process.env.USDC_CONTRACT_POLYGON
          : process.env.USDC_CONTRACT_ETHEREUM;

        const iface = new ethers.Interface(ERC20_ABI);
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== contractAddress?.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(log);
            if (
              parsed.name === 'Transfer' &&
              parsed.args.to.toLowerCase() === escrowWallet &&
              Number(parsed.args.value) >= expectedUSDC - tolerance
            ) {
              verified = true;
              verificationNote = 'verified_on_chain';
              break;
            }
          } catch { /* log not a Transfer event */ }
        }
      }
    }
  } catch (err) {
    console.error('On-chain verification error:', err.message);
    // Fall through — mark as pending manual review
  }

  // Record crypto tx
  acquisition.stages.deposit = {
    ...acquisition.stages.deposit,
    paymentMethod: 'usdc',
    cryptoTxHash: txHash,
  };

  if (verified) {
    await _advanceToDD(acquisition, 'usdc', txHash);
  } else {
    // Mark for manual admin review
    acquisition.stages.deposit.paymentRef = `CRYPTO_PENDING_${txHash.slice(0, 10)}`;
    await acquisition.save();
  }

  res.status(200).json({
    status: 'success',
    data: {
      verified,
      message: verified
        ? 'Crypto deposit verified. Advancing to due diligence.'
        : 'Transaction submitted. Our team will verify and advance your application within 2 hours.',
      acquisition,
    },
  });
});

/**
 * POST /api/v1/marketplace/acquisition/:id/crypto-final-confirm
 * Same as above but for the final payment.
 */
exports.confirmCryptoFinalPayment = catchAsync(async (req, res, next) => {
  const { txHash, network = 'ethereum' } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }

  acquisition.stages.finalPayment = {
    ...acquisition.stages.finalPayment,
    paidAt: new Date(),
    paymentMethod: 'usdc',
    cryptoTxHash: txHash,
  };
  acquisition.stage = 'transfer';
  acquisition.stages.transfer = { startedAt: new Date() };
  await acquisition.save();

  _broadcastStageUpdate(req.app, acquisition, 'transfer');

  res.status(200).json({ status: 'success', data: { acquisition } });
});

/* ══════════════════════════════════════════════════════════
   STRIPE WEBHOOK
══════════════════════════════════════════════════════════ */

exports.stripeWebhook = catchAsync(async (req, res, next) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { acquisitionId, type } = pi.metadata || {};
    if (!acquisitionId) return res.json({ received: true });

    const acquisition = await AcquisitionFlow.findById(acquisitionId);
    if (!acquisition) return res.json({ received: true });

    if (type === 'acquisition_deposit' && acquisition.stage === 'deposit_pending') {
      await _advanceToDD(acquisition, 'stripe', pi.id);
    } else if (type === 'acquisition_final_payment' && acquisition.stage === 'final_payment') {
      acquisition.stages.finalPayment.paidAt = new Date();
      acquisition.stages.finalPayment.stripePaymentIntentId = pi.id;
      acquisition.stage = 'transfer';
      acquisition.stages.transfer = { startedAt: new Date() };
      await acquisition.save();
    }
  }

  res.json({ received: true });
});

/* ══════════════════════════════════════════════════════════
   STAGE TRANSITIONS
══════════════════════════════════════════════════════════ */

/**
 * PATCH /api/v1/marketplace/acquisition/:id/dd-complete
 * Admin marks DD period as complete.
 */
exports.completeDueDiligence = catchAsync(async (req, res, next) => {
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.stage !== 'dd_period') return next(new AppError('Not in DD period', 400));

  acquisition.stages.dueDiligence.completedAt = new Date();
  acquisition.stage = 'agreement';
  acquisition.stages.agreement = { sentAt: new Date() };
  await acquisition.save();

  _broadcastStageUpdate(req.app, acquisition, 'agreement');
  res.status(200).json({ status: 'success', data: { acquisition } });
});

/**
 * PATCH /api/v1/marketplace/acquisition/:id/agreement-signed
 * Buyer confirms agreement signed.
 */
exports.confirmAgreementSigned = catchAsync(async (req, res, next) => {
  const { docusignEnvelopeId } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));
  if (acquisition.buyer.toString() !== req.user._id.toString()) {
    return next(new AppError('Access denied', 403));
  }

  acquisition.stages.agreement.signedByBuyerAt = new Date();
  if (docusignEnvelopeId) acquisition.stages.agreement.docusignEnvelopeId = docusignEnvelopeId;
  acquisition.stage = 'final_payment';
  acquisition.stages.finalPayment = {
    dueAt: new Date(Date.now() + 7 * 24 * 3_600_000), // 7 days
    amount: acquisition.finalPaymentAmount,
  };
  await acquisition.save();

  _broadcastStageUpdate(req.app, acquisition, 'final_payment');
  res.status(200).json({ status: 'success', data: { acquisition } });
});

/**
 * PATCH /api/v1/marketplace/acquisition/:id/transfer-update
 * Admin updates transfer checklist.
 */
exports.updateTransferChecklist = catchAsync(async (req, res, next) => {
  const { tradeLicenseTransferred, visasTransferred, bankAccountTransferred, digitalAssetsTransferred } = req.body;
  const acquisition = await AcquisitionFlow.findById(req.params.id);
  if (!acquisition) return next(new AppError('Acquisition not found', 404));

  const t = acquisition.stages.transfer;
  if (tradeLicenseTransferred !== undefined) t.tradeLicenseTransferred = tradeLicenseTransferred;
  if (visasTransferred !== undefined) t.visasTransferred = visasTransferred;
  if (bankAccountTransferred !== undefined) t.bankAccountTransferred = bankAccountTransferred;
  if (digitalAssetsTransferred !== undefined) t.digitalAssetsTransferred = digitalAssetsTransferred;

  const allDone = t.tradeLicenseTransferred && t.visasTransferred && t.bankAccountTransferred && t.digitalAssetsTransferred;
  if (allDone) {
    t.completedAt = new Date();
    acquisition.stage = 'completed';
    await BusinessListing.findByIdAndUpdate(acquisition.listing, { listingStatus: 'sold' });
  }
  await acquisition.save();

  _broadcastStageUpdate(req.app, acquisition, acquisition.stage);
  res.status(200).json({ status: 'success', data: { acquisition } });
});

/* ══════════════════════════════════════════════════════════
   DOCUMENTS
══════════════════════════════════════════════════════════ */

exports.getListingDocuments = catchAsync(async (req, res, next) => {
  const docs = await AuctionDocument.find({ listing: req.params.listingId })
    .sort('category sortOrder')
    .lean();
  res.status(200).json({ status: 'success', data: { documents: docs } });
});

exports.uploadListingDocument = catchAsync(async (req, res, next) => {
  const { listingId } = req.params;
  const { category, documentType, label, description, isConfidential, ndaRequired, fileUrl, fileName, fileSize, mimeType } = req.body;

  const doc = await AuctionDocument.create({
    listing: listingId,
    uploadedBy: req.user._id,
    uploaderRole: ['admin', 'amer'].includes(req.user.role) ? 'admin' : 'seller',
    category,
    documentType,
    label,
    description,
    isConfidential: !!isConfidential,
    ndaRequired: !!ndaRequired,
    fileUrl,
    fileName,
    fileSize,
    mimeType,
    verificationStatus: 'self_submitted',
  });

  res.status(201).json({ status: 'success', data: { document: doc } });
});

exports.verifyDocument = catchAsync(async (req, res, next) => {
  const { status, note } = req.body;
  const doc = await AuctionDocument.findByIdAndUpdate(req.params.docId, {
    verificationStatus: status,
    verifiedBy: req.user._id,
    verifiedAt: new Date(),
    verificationNote: note,
  }, { new: true });
  if (!doc) return next(new AppError('Document not found', 404));
  res.status(200).json({ status: 'success', data: { document: doc } });
});

/* ══════════════════════════════════════════════════════════
   AI ENDPOINTS
══════════════════════════════════════════════════════════ */

/**
 * POST /api/v1/marketplace/listings/:id/ai-analysis
 * Returns AI-generated business summary, investment thesis, red flags, and valuation.
 */
exports.getAIAnalysis = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.findOne({
    $or: [{ slug: req.params.id }, { _id: /^[a-f0-9]{24}$/.test(req.params.id) ? req.params.id : undefined }],
    isPublished: true,
  });
  if (!listing) return next(new AppError('Listing not found', 404));

  let openaiService;
  try {
    openaiService = require('../../services/openaiService');
  } catch {
    return next(new AppError('AI service not configured', 503));
  }
  if (!openaiService.isAvailable()) {
    return next(new AppError('AI service not available', 503));
  }

  const f = listing.financials || {};
  const prompt = `You are an expert M&A analyst specializing in UAE business acquisitions. Analyze this business for sale and provide a structured JSON response.

Business: ${listing.name}
Industry: ${listing.industry}
Location: ${listing.location?.emirate}, UAE (${listing.location?.setupType})
Years in Operation: ${listing.yearsInOperation}
Employees: ${listing.employees}
Asking Price: AED ${f.askingPrice?.toLocaleString()}
Monthly Revenue: AED ${f.monthlyRevenue?.toLocaleString()}
Monthly Profit: AED ${f.monthlyProfit?.toLocaleString()}
Profit Margin: ${f.profitMargin}%
Description: ${listing.description}
Assets: ${listing.assetsIncluded?.join(', ')}
Reason for Sale: ${listing.reasonForSale || 'Not disclosed'}

Respond with ONLY valid JSON in this exact format:
{
  "summary": "3 paragraph plain-English acquisition brief",
  "investmentScore": 74,
  "scoreBreakdown": {
    "revenueQuality": 78,
    "growthTrajectory": 61,
    "riskProfile": 87,
    "valuation": 68,
    "marketPosition": 85
  },
  "bullCase": "2-3 sentences on upside potential",
  "bearCase": "2-3 sentences on risks",
  "redFlags": ["flag1", "flag2", "flag3"],
  "suggestedBidRange": { "low": 950000, "high": 1200000 },
  "valuationMethods": {
    "revenueMultiple": { "value": 2.1, "fairValue": 1500000, "basis": "2.1x LTM revenue, UAE e-commerce avg 3.1x" },
    "ebitdaMultiple": { "value": 4.2, "fairValue": 1350000, "basis": "4.2x EBITDA" },
    "dcf": { "fairValue": 1180000, "basis": "DCF at 15% discount rate, 5yr horizon" }
  },
  "confidenceScore": "MEDIUM",
  "marketIntelligence": "2-3 sentences on UAE market context for this industry",
  "keyQuestions": ["question1", "question2", "question3"]
}`;

  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const analysis = JSON.parse(response.choices[0].message.content);
    res.status(200).json({ status: 'success', data: { analysis } });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return next(new AppError('AI analysis failed', 500));
  }
});

/**
 * POST /api/v1/marketplace/listings/:id/ai-ask
 * Investor asks a specific question about the business.
 */
exports.askAIQuestion = catchAsync(async (req, res, next) => {
  const { question } = req.body;
  if (!question) return next(new AppError('Question is required', 400));

  const listing = await BusinessListing.findOne({
    $or: [{ slug: req.params.id }, { _id: /^[a-f0-9]{24}$/.test(req.params.id) ? req.params.id : undefined }],
    isPublished: true,
  });
  if (!listing) return next(new AppError('Listing not found', 404));

  const f = listing.financials || {};
  const systemPrompt = `You are an expert M&A analyst. Answer investor questions about this UAE business for sale.
Business: ${listing.name} | ${listing.industry} | AED ${f.askingPrice?.toLocaleString()} asking price
Revenue: AED ${f.monthlyRevenue?.toLocaleString()}/mo | Profit: AED ${f.monthlyProfit?.toLocaleString()}/mo | Margin: ${f.profitMargin}%
Location: ${listing.location?.emirate} | Setup: ${listing.location?.setupType} | Years: ${listing.yearsInOperation} | Staff: ${listing.employees}
${listing.description}
Be concise, factual, and highlight risks when relevant. If data is insufficient, say so.`;

  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    const answer = response.choices[0].message.content;
    res.status(200).json({ status: 'success', data: { answer } });
  } catch (err) {
    console.error('OpenAI Q&A error:', err.message);
    return next(new AppError('AI Q&A failed', 500));
  }
});

/* ══════════════════════════════════════════════════════════
   ADMIN — Acquisition Management
══════════════════════════════════════════════════════════ */

exports.adminGetAllAcquisitions = catchAsync(async (req, res, next) => {
  const { stage, page = 1, limit = 20 } = req.query;
  const filter = stage ? { stage } : {};
  const skip = (Number(page) - 1) * Number(limit);
  const total = await AcquisitionFlow.countDocuments(filter);
  const acquisitions = await AcquisitionFlow.find(filter)
    .populate('listing', 'name industry financials')
    .populate('buyer', 'name email phone')
    .sort('-createdAt')
    .skip(skip)
    .limit(Number(limit))
    .lean();

  res.status(200).json({ status: 'success', total, data: { acquisitions } });
});

/* ══════════════════════════════════════════════════════════
   PRIVATE HELPERS
══════════════════════════════════════════════════════════ */

async function _advanceToDD(acquisition, method, ref) {
  const ddDue = new Date(Date.now() + DD_DAYS * 24 * 3_600_000);
  acquisition.stages.deposit = {
    ...acquisition.stages.deposit,
    paidAt: new Date(),
    paymentMethod: method,
    [method === 'stripe' ? 'stripePaymentIntentId' : 'cryptoTxHash']: ref,
  };
  acquisition.stage = 'dd_period';
  acquisition.stages.dueDiligence = { startedAt: new Date(), dueAt: ddDue };
  await acquisition.save();
  return acquisition;
}

function _broadcastStageUpdate(app, acquisition, stage) {
  const wsServer = app.get('wsServer');
  if (!wsServer) return;
  wsServer.broadcastToRoom(`acquisition_${acquisition._id}`, {
    type: 'acquisition_stage_update',
    acquisitionId: acquisition._id,
    stage,
    updatedAt: new Date(),
  });
}
