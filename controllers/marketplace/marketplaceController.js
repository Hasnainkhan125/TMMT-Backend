const mongoose = require('mongoose');
const crypto = require('crypto');
const BusinessListing = require('../../model/schema/businessListing');
const User = require('../../model/schema/user');
const SellerSubmission = require('../../model/schema/sellerSubmission');
const MarketplaceBid = require('../../model/schema/marketplaceBid');
const AuctionRegistration = require('../../model/schema/auctionRegistration');
const BankDeposit = require('../../model/schema/bankDeposit');
const SystemSettings = require('../../model/schema/systemSettings');
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const { listTypesArray, inferListingType } = require('../../config/listingTypeDefinitions');

/** Generate a short referral code for a user+listing combo */
function generateReferralCode(userId, listingId) {
  const hash = crypto.createHash('sha256')
    .update(`${userId}-${listingId}-${Date.now()}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `REF-${hash}`;
}

/** Resolve listing by id (ObjectId) or slug — avoids CastError for slug values like "1" */
/** Fallback UAE bank details when SystemSettings has no `bank_details` (deposit instructions). */
const DEFAULT_UAE_BANK_DETAILS = {
  bankName: 'Emirates NBD',
  accountName: 'Qumak FZ-LLC — Client Escrow (Marketplace)',
  iban: 'AE07 0331 2345 6789 0123 456',
  swiftBic: 'EBILAEAD',
  branch: 'Dubai International Financial Centre',
  currency: 'AED',
  referenceNote: 'Include the listing reference / slug in the transfer narration.',
};

function getListingFilter(idOrSlug) {
  if (typeof idOrSlug === 'string' && idOrSlug.length === 24 && /^[a-f0-9]{24}$/i.test(idOrSlug)) {
    try {
      return { $or: [{ _id: new mongoose.Types.ObjectId(idOrSlug) }, { slug: idOrSlug }] };
    } catch {
      return { slug: idOrSlug };
    }
  }
  return { slug: idOrSlug };
}

/* ════════════════════════════════════════════════════════════
   PUBLIC — Business Listings
════════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/listings
 * Returns all active, published listings with optional filters.
 */
exports.getListings = catchAsync(async (req, res, next) => {
  const {
    industry,
    location,
    listingType,
    minPrice,
    maxPrice,
    minRevenue,
    maxRevenue,
    page = 1,
    limit = 12,
    sort = '-publishedAt',
  } = req.query;

  const filter = { isPublished: true, listingStatus: 'active' };

  if (industry && industry !== 'All') filter.industry = industry;
  if (listingType) {
    filter.listingType = listingType;
  } else {
    filter.$nor = [{ listingType: 'off_market_reserved' }];
  }
  if (location) filter['location.emirate'] = location;
  if (minPrice || maxPrice) {
    filter['financials.askingPrice'] = {};
    if (minPrice) filter['financials.askingPrice'].$gte = Number(minPrice);
    if (maxPrice) filter['financials.askingPrice'].$lte = Number(maxPrice);
  }
  if (minRevenue || maxRevenue) {
    filter['financials.monthlyRevenue'] = {};
    if (minRevenue) filter['financials.monthlyRevenue'].$gte = Number(minRevenue);
    if (maxRevenue) filter['financials.monthlyRevenue'].$lte = Number(maxRevenue);
  }

  const skip = (Number(page) - 1) * Number(limit);
  const total = await BusinessListing.countDocuments(filter);
  const docs = await BusinessListing.find(filter)
    .sort(sort)
    .skip(skip)
    .limit(Number(limit))
    .select('-verificationDetails.notes -seller -commission')
    .lean();

  const listings = docs.map((d) => {
    const f = d.financials || {};
    const m = d.metrics || {};
    const loc = d.location || {};
    return {
      ...d,
      id: d.slug || d._id.toString(),
      price: f.askingPrice,
      monthlyRevenue: f.monthlyRevenue,
      profitMargin: f.profitMargin ?? 0,
      location: loc.emirate || loc.area || 'UAE',
      zoneType: loc.setupType === 'mainland' ? 'Mainland' : 'Free Zone',
      assets: d.assetsIncluded || [],
      verified: d.verificationStatus === 'verified',
      bidsPlaced: m.bids ?? 0,
      viewsToday: m.viewsToday ?? 0,
      highestBid: m.highestBid ?? null,
      endsAt: d.auction?.endsAt || d.expiresAt,
      image: (d.images && d.images[0]?.url) || null,
      listingType: inferListingType(d),
      listingTypeConfig: d.listingTypeConfig || {},
    };
  });

  res.status(200).json({
    status: 'success',
    results: listings.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    data: { listings },
  });
});

/**
 * GET /api/v1/marketplace/listing-types
 * Public catalog — four Qumak listing models (strategy).
 */
exports.getListingTypes = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      types: listTypesArray(),
      version: '1.0.0',
    },
  });
});

/**
 * GET /api/v1/marketplace/listings/:idOrSlug
 * Returns a single listing by slug or ObjectId, with bids and frontend-friendly shape.
 */
exports.getListingBySlug = catchAsync(async (req, res, next) => {
  const idOrSlug = req.params.slug;
  const listing = await BusinessListing.findOne({
    ...getListingFilter(idOrSlug),
    isPublished: true,
    listingStatus: 'active',
  }).select('-verificationDetails.notes -seller -commission');

  if (!listing) {
    return next(new AppError('Listing not found', 404));
  }

  const _ltCheck = inferListingType(listing.toObject ? listing.toObject() : listing);
  if (_ltCheck === 'off_market_reserved') {
    return next(new AppError('Listing not found', 404));
  }

  // Increment view count
  await BusinessListing.findByIdAndUpdate(listing._id, { $inc: { 'metrics.views': 1, 'metrics.viewsToday': 1 } });

  // Fetch recent bids for activity feed
  const bids = await MarketplaceBid.find({ listing: listing._id, status: 'pending' })
    .sort('-createdAt')
    .limit(20)
    .select('amount bidType createdAt')
    .lean();

  const listingObj = listing.toObject();
  const financials = listingObj.financials || {};
  const metrics = listingObj.metrics || {};
  const loc = listingObj.location || {};
  const lt = inferListingType(listingObj);
  const showBidAmounts = lt === 'public_auction';
  const reserveMet =
    (listingObj.auction?.reservePrice != null && metrics.highestBid >= listingObj.auction.reservePrice) ||
    false;

  let bidsOut = bids;
  if (!showBidAmounts) {
    bidsOut = bids.map((b) => ({
      ...b,
      amount: undefined,
      isSealed: true,
    }));
  }

  const listingTypeConfig = listingObj.listingTypeConfig || {};
  const depositToUnlockAED = listingTypeConfig.depositToUnlockAED ?? 500;
  const financialsLocked = listingTypeConfig.financialsLocked !== false;

  res.status(200).json({
    status: 'success',
    data: {
      listing: {
        ...listingObj,
        id: listingObj.slug || listingObj._id.toString(),
        price: financials.askingPrice,
        monthlyRevenue: financials.monthlyRevenue,
        profitMargin: financials.profitMargin ?? 0,
        location: loc.emirate || loc.area || 'UAE',
        zoneType: loc.setupType === 'mainland' ? 'Mainland' : 'Free Zone',
        assets: listingObj.assetsIncluded || [],
        verified: listingObj.verificationStatus === 'verified',
        bidsPlaced: metrics.bids ?? 0,
        viewsToday: metrics.viewsToday ?? 0,
        highestBid: showBidAmounts ? (metrics.highestBid ?? null) : null,
        endsAt: listingObj.auction?.endsAt || listingObj.expiresAt,
        image: (listingObj.images && listingObj.images[0]?.url) || null,
        listingType: lt,
        listingTypeConfig,
        ui: {
          showBidAmounts,
          showLiveBidFeed: showBidAmounts,
          reserveHiddenUntilMet: listingTypeConfig.reserveHiddenUntilMet !== false,
          reserveMet,
          financialsLocked,
          depositToUnlockAED,
          sealedBidCount: !showBidAmounts ? metrics.bids ?? 0 : undefined,
        },
      },
      bids: bidsOut,
    },
  });
});

/**
 * GET /api/v1/marketplace/listings/:id/inquiry
 * Track inquiry intent (no auth required — just increments counter).
 */
exports.trackInquiry = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.findOne(getListingFilter(req.params.id));
  if (!listing) return next(new AppError('Listing not found', 404));
  await BusinessListing.findByIdAndUpdate(listing._id, { $inc: { 'metrics.inquiries': 1 } });
  res.status(200).json({ status: 'success' });
});

/**
 * POST /api/v1/marketplace/listings/:id/bid
 * Place a bid on a listing (auth required).
 * Supports referral tracking via `referralCode` in body.
 */
exports.placeBid = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { amount, bidType = 'full', timeline, message, referralCode, maxAutoBid, isPreBid } = req.body;
  const bidderId = req.user._id;

  if (!amount || Number(amount) <= 0) {
    return next(new AppError('Valid bid amount is required', 400));
  }

  const listing = await BusinessListing.findOne({
    ...getListingFilter(id),
    isPublished: true,
    listingStatus: 'active',
  });

  if (!listing) return next(new AppError('Listing not found', 404));

  const bidder = await User.findById(bidderId).select('emiratesId passportNumber').lean();
  const eid = bidder?.emiratesId ? String(bidder.emiratesId).replace(/\s/g, '') : '';
  const pass = bidder?.passportNumber ? String(bidder.passportNumber).trim() : '';
  const hasIdentity = (eid.length >= 10) || (pass.length >= 5);
  if (!hasIdentity) {
    return next(
      new AppError(
        'Add your Emirates ID or passport number in your profile before placing a bid.',
        403
      )
    );
  }

  const listingObjForType = listing.toObject ? listing.toObject() : listing;
  const lt = inferListingType(listingObjForType);

  if (lt === 'buy_now') {
    return next(new AppError('Buy Now listings use deposit / acquisition — not competitive bidding.', 400));
  }
  if (lt === 'off_market_reserved') {
    return next(new AppError('Off-market listing — access restricted to approved buyers.', 403));
  }

  const bidAmount = Number(String(amount).replace(/,/g, ''));
  const currentHighest = listing.metrics?.highestBid || 0;

  /* ─── Private sealed: amounts hidden; no public high-bid race ─── */
  if (lt === 'private_sealed') {
    const minSealed = listing.auction?.startingBid || Math.round((listing.financials?.askingPrice || 0) * 0.3) || 1000;
    if (bidAmount < minSealed) {
      return next(new AppError(`Sealed bid must be at least AED ${minSealed.toLocaleString()}`, 400));
    }

    let referrerUserId = null;
    let commissionRate = 0;
    if (referralCode) {
      const reg = await AuctionRegistration.findOne({ referralCode });
      if (reg && reg.user && reg.user.toString() !== bidderId.toString()) {
        referrerUserId = reg.user;
        commissionRate = 2.5;
      }
    }
    const COMMISSION_RATE = 2.5;

    const bid = await MarketplaceBid.create({
      listing: listing._id,
      bidder: bidderId,
      amount: bidAmount,
      bidType: ['full', 'equity', 'installment'].includes(bidType) ? bidType : 'full',
      timeline: timeline || undefined,
      message: message || undefined,
      status: 'pending',
      isPreBid: !!isPreBid,
      isSealed: true,
      maxAutoBid: 0,
      referredBy: referralCode || undefined,
      referrerUserId: referrerUserId || undefined,
      referralCommissionRate: referrerUserId ? COMMISSION_RATE : 0,
      referralCommissionAmount: referrerUserId ? Math.round(bidAmount * (COMMISSION_RATE / 100)) : 0,
    });

    await BusinessListing.findByIdAndUpdate(listing._id, { $inc: { 'metrics.bids': 1 } });

    const wsServer = req.app?.get('wsServer');
    if (wsServer && !isPreBid) {
      const roomId = `auction_${listing.slug || listing._id}`;
      const nextCount = (listing.metrics?.bids || 0) + 1;
      wsServer.broadcastToRoom(roomId, {
        type: 'auction:sealed_received',
        listingId: listing.slug || listing._id.toString(),
        bidCount: nextCount,
        timestamp: new Date(),
      });
    }

    return res.status(201).json({
      status: 'success',
      message: 'Sealed bid received — amount hidden until window closes.',
      data: {
        bid: {
          id: bid._id,
          listingId: listing._id,
          amount: bid.amount,
          bidType: bid.bidType,
          status: bid.status,
          isSealed: true,
          createdAt: bid.createdAt,
        },
      },
    });
  }

  if (bidAmount <= currentHighest && !isPreBid) {
    return next(new AppError(`Bid must be higher than current highest bid (AED ${currentHighest.toLocaleString()})`, 400));
  }

  /* ─── Resolve referral ─── */
  let referrerUserId = null;
  let commissionRate = 0;

  if (referralCode) {
    // Find the registration that generated this referral code
    const reg = await AuctionRegistration.findOne({ referralCode });
    if (reg && reg.user && reg.user.toString() !== bidderId.toString()) {
      referrerUserId = reg.user;
      commissionRate = 2.5; // 2.5% commission for referrers
    }
  }

  const COMMISSION_RATE = 2.5;

  const bid = await MarketplaceBid.create({
    listing: listing._id,
    bidder: bidderId,
    amount: bidAmount,
    bidType: ['full', 'equity', 'installment'].includes(bidType) ? bidType : 'full',
    timeline: timeline || undefined,
    message: message || undefined,
    status: isPreBid ? 'pending' : 'pending',
    isPreBid: !!isPreBid,
    maxAutoBid: Number(maxAutoBid) || 0,
    referredBy: referralCode || undefined,
    referrerUserId: referrerUserId || undefined,
    referralCommissionRate: referrerUserId ? COMMISSION_RATE : 0,
    referralCommissionAmount: referrerUserId ? Math.round(bidAmount * (COMMISSION_RATE / 100)) : 0,
  });

  /* ─── Mark previous bids as outbid ─── */
  if (!isPreBid && bidAmount > currentHighest) {
    await MarketplaceBid.updateMany(
      { listing: listing._id, _id: { $ne: bid._id }, status: { $in: ['pending', 'winning'] } },
      { $set: { status: 'outbid' } }
    );
    await MarketplaceBid.findByIdAndUpdate(bid._id, { status: 'winning' });
  }

  const update = { $inc: { 'metrics.bids': 1 } };
  if (!isPreBid && bidAmount > currentHighest) {
    update.$set = { 'metrics.highestBid': bidAmount };
  }
  await BusinessListing.findByIdAndUpdate(listing._id, update);

  /* ─── Auto-bid engine ─── */
  // If this bid outbid someone who had a maxAutoBid ceiling still valid, trigger their auto-bid
  if (!isPreBid && bidAmount > currentHighest) {
    const outbidWithAutoBid = await MarketplaceBid.find({
      listing: listing._id,
      _id: { $ne: bid._id },
      status: 'outbid',
      maxAutoBid: { $gt: bidAmount },
    }).sort('-maxAutoBid').limit(1);

    if (outbidWithAutoBid.length > 0) {
      const autoBidder = outbidWithAutoBid[0];
      const nextAutoBidAmount = bidAmount + (listing.auction?.bidIncrement || 5000);
      if (nextAutoBidAmount <= autoBidder.maxAutoBid) {
        // Place auto-bid asynchronously
        setImmediate(() => _placeAutoBid(req.app, listing, autoBidder, nextAutoBidAmount));
      }
    }
  }

  /* ─── WebSocket broadcast ─── */
  const wsServer = req.app?.get('wsServer');
  if (wsServer && !isPreBid && bidAmount > currentHighest) {
    const roomId = `auction_${listing.slug || listing._id}`;

    // Broadcast new high bid to everyone watching
    wsServer.broadcastToRoom(roomId, {
      type: 'auction:new_bid',
      listingId: listing.slug || listing._id.toString(),
      amount: bidAmount,
      bidType: bid.bidType,
      totalBids: (listing.metrics?.bids || 0) + 1,
      timestamp: new Date(),
    });

    // Send outbid notification to previous leader's room (if connected)
    const prevWinners = await MarketplaceBid.find({
      listing: listing._id,
      status: 'outbid',
      bidder: { $ne: bidderId },
    }).select('bidder').limit(5).lean();

    for (const prev of prevWinners) {
      wsServer.sendToClient(prev.bidder.toString(), {
        type: 'auction:outbid',
        listingId: listing.slug || listing._id.toString(),
        newHighBid: bidAmount,
        timestamp: new Date(),
      });
    }
  }

  res.status(201).json({
    status: 'success',
    message: isPreBid ? 'Pre-bid registered successfully' : 'Bid placed successfully',
    data: {
      bid: {
        id: bid._id,
        listingId: listing._id,
        amount: bid.amount,
        bidType: bid.bidType,
        status: bid.status,
        isPreBid: bid.isPreBid,
        createdAt: bid.createdAt,
      },
    },
  });
});

/* ─── Auto-bid helper ─── */
async function _placeAutoBid(app, listing, autoBidRecord, amount) {
  try {
    const newBid = await MarketplaceBid.create({
      listing: listing._id,
      bidder: autoBidRecord.bidder,
      amount,
      bidType: autoBidRecord.bidType || 'full',
      status: 'winning',
      maxAutoBid: autoBidRecord.maxAutoBid,
      isPreBid: false,
    });

    await MarketplaceBid.updateMany(
      { listing: listing._id, _id: { $ne: newBid._id }, status: { $in: ['pending', 'winning'] } },
      { $set: { status: 'outbid' } }
    );

    await BusinessListing.findByIdAndUpdate(listing._id, {
      $inc: { 'metrics.bids': 1 },
      $set: { 'metrics.highestBid': amount },
    });

    const wsServer = app?.get('wsServer');
    if (wsServer) {
      const roomId = `auction_${listing.slug || listing._id}`;
      wsServer.broadcastToRoom(roomId, {
        type: 'auction:new_bid',
        listingId: listing.slug || listing._id.toString(),
        amount,
        bidType: newBid.bidType,
        isAutoBid: true,
        timestamp: new Date(),
      });
    }
    console.log(`🤖 Auto-bid placed: ${amount} for bidder ${autoBidRecord.bidder}`);
  } catch (err) {
    console.error('Auto-bid error:', err.message);
  }
}

/**
 * POST /api/v1/marketplace/listings/:id/auto-bid
 * Set or update the auto-bid ceiling for the authenticated user.
 */
exports.setAutoBid = catchAsync(async (req, res, next) => {
  const { maxAutoBid } = req.body;
  const listing = await BusinessListing.findOne({ ...getListingFilter(req.params.id), isPublished: true });
  if (!listing) return next(new AppError('Listing not found', 404));

  await MarketplaceBid.updateMany(
    { listing: listing._id, bidder: req.user._id },
    { $set: { maxAutoBid: Number(maxAutoBid) || 0 } }
  );

  res.status(200).json({
    status: 'success',
    message: maxAutoBid ? `Auto-bid ceiling set to AED ${Number(maxAutoBid).toLocaleString()}` : 'Auto-bid cancelled',
  });
});

/**
 * GET /api/v1/marketplace/listings/:id/bids
 * Returns all bids for a listing (leaderboard).
 */
exports.getListingBids = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.findOne({ ...getListingFilter(req.params.id), isPublished: true });
  if (!listing) return next(new AppError('Listing not found', 404));

  const bids = await MarketplaceBid.find({ listing: listing._id, isPreBid: false })
    .sort('-amount')
    .limit(20)
    .select('amount bidType status createdAt bidderId')
    .lean();

  // Anonymize bidder info
  const anonymized = bids.map((b, i) => ({
    rank: i + 1,
    amount: b.amount,
    bidType: b.bidType,
    status: b.status,
    createdAt: b.createdAt,
    isYou: req.user ? b.bidder?.toString() === req.user._id.toString() : false,
  }));

  res.status(200).json({ status: 'success', data: { bids: anonymized } });
});

/**
 * GET /api/v1/marketplace/user/bids
 * Returns all bids the authenticated user has placed.
 */
exports.getMyBids = catchAsync(async (req, res, next) => {
  const bids = await MarketplaceBid.find({ bidder: req.user._id })
    .populate('listing', 'name slug industry financials metrics auction images')
    .sort('-createdAt')
    .lean();

  res.status(200).json({ status: 'success', data: { bids } });
});

/**
 * PATCH /api/v1/marketplace/me/identity
 * Set Emirates ID and/or passport for marketplace bidding eligibility.
 */
exports.updateMarketplaceIdentity = catchAsync(async (req, res, next) => {
  const { emiratesId, passportNumber } = req.body;
  const $set = {};
  if (emiratesId !== undefined) {
    $set.emiratesId = String(emiratesId).trim() || undefined;
  }
  if (passportNumber !== undefined) {
    $set.passportNumber = String(passportNumber).trim() || undefined;
  }
  if (Object.keys($set).length === 0) {
    return next(new AppError('Provide emiratesId and/or passportNumber', 400));
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set }, { new: true, runValidators: true }).select(
    'emiratesId passportNumber name email phone'
  );
  res.status(200).json({ status: 'success', data: { user } });
});

/**
 * POST /api/v1/marketplace/listings/:id/register
 * Pre-auction registration — no auth required, captures lead + referral.
 */
exports.registerForAuction = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, email, phone, investmentBudget, message, referredBy } = req.body;

  if (!name) return next(new AppError('Name is required', 400));

  const listing = await BusinessListing.findOne({ ...getListingFilter(id), isPublished: true });
  if (!listing) return next(new AppError('Listing not found', 404));

  // Check for duplicate
  const existing = await AuctionRegistration.findOne({ listing: listing._id, email: email?.toLowerCase() });
  if (existing) {
    return res.status(200).json({ status: 'success', message: 'Already registered', data: { referralCode: existing.referralCode } });
  }

  const userId = req.user?._id || null;
  const referralCode = generateReferralCode(userId || name, listing._id);

  const reg = await AuctionRegistration.create({
    listing: listing._id,
    user: userId,
    name,
    email,
    phone,
    investmentBudget: Number(investmentBudget) || 0,
    message,
    referralCode,
    referredBy: referredBy || undefined,
    status: 'registered',
  });

  // Increment watchers
  await BusinessListing.findByIdAndUpdate(listing._id, { $inc: { 'metrics.watchers': 1 } });

  res.status(201).json({
    status: 'success',
    message: 'Registered for auction',
    data: {
      referralCode: reg.referralCode,
      registrationId: reg._id,
    },
  });
});

/**
 * GET /api/v1/marketplace/listings/:id/referral
 * Get or create a personal referral link for the authenticated user.
 */
exports.getMyReferralCode = catchAsync(async (req, res, next) => {
  if (!req.user) return next(new AppError('Authentication required', 401));

  const listing = await BusinessListing.findOne({ ...getListingFilter(req.params.id), isPublished: true });
  if (!listing) return next(new AppError('Listing not found', 404));

  let reg = await AuctionRegistration.findOne({ listing: listing._id, user: req.user._id });
  if (!reg) {
    reg = await AuctionRegistration.create({
      listing: listing._id,
      user: req.user._id,
      name: req.user.name || 'Investor',
      email: req.user.email,
      referralCode: generateReferralCode(req.user._id, listing._id),
      status: 'registered',
    });
    await BusinessListing.findByIdAndUpdate(listing._id, { $inc: { 'metrics.watchers': 1 } });
  }

  res.status(200).json({
    status: 'success',
    data: { referralCode: reg.referralCode },
  });
});

/* ════════════════════════════════════════════════════════════
   PUBLIC — Seller Submissions
════════════════════════════════════════════════════════════ */

/**
 * POST /api/v1/marketplace/seller-submission
 * Accepts a seller's intent to list their business.
 */
exports.createSellerSubmission = catchAsync(async (req, res, next) => {
  const {
    businessName, industry, location, yearsOperating,
    monthlyRevenue, monthlyProfit, askingPrice, vatRegistered,
    ownerName, ownerPhone, ownerEmail, reasonForSale,
    tradeLicenseUploaded, vatReturnsUploaded, bankStatementsUploaded,
    preferredListingType,
  } = req.body;

  if (!businessName || !industry || !location || !monthlyRevenue || !askingPrice || !ownerName || !ownerPhone) {
    return next(new AppError('Missing required fields', 400));
  }

  const submission = await SellerSubmission.create({
    businessName,
    industry,
    location,
    yearsOperating,
    monthlyRevenue: Number(monthlyRevenue),
    monthlyProfit: Number(monthlyProfit) || 0,
    askingPrice: Number(askingPrice),
    vatRegistered: vatRegistered === 'yes' || vatRegistered === true,
    ownerName,
    ownerPhone,
    ownerEmail,
    reasonForSale,
    documents: {
      tradeLicenseReady: !!tradeLicenseUploaded,
      vatReturnsReady: !!vatReturnsUploaded,
      bankStatementsReady: !!bankStatementsUploaded,
    },
    source: 'website',
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    ...(preferredListingType
      ? {
          preferredListingType: [
            'public_auction',
            'private_sealed',
            'off_market_reserved',
            'buy_now',
            'undecided',
          ].includes(preferredListingType)
            ? preferredListingType
            : 'undecided',
        }
      : {}),
  });

  // TODO: Send WhatsApp/email notification to team
  // await whatsAppMessage.sendToTeam({ type: 'new_seller_submission', data: submission });

  res.status(201).json({
    status: 'success',
    message: 'Submission received. Our team will contact you within 24–48 hours.',
    data: {
      submissionNumber: submission.submissionNumber,
    },
  });
});

/* ════════════════════════════════════════════════════════════
   ADMIN — Listing Management (protected routes)
════════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/admin/listings
 */
exports.adminGetListings = catchAsync(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = status ? { listingStatus: status } : {};
  const skip = (Number(page) - 1) * Number(limit);
  const total = await BusinessListing.countDocuments(filter);
  const listings = await BusinessListing.find(filter).sort('-createdAt').skip(skip).limit(Number(limit));

  res.status(200).json({ status: 'success', total, data: { listings } });
});

/**
 * POST /api/v1/marketplace/admin/listings
 */
exports.adminCreateListing = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.create(req.body);
  res.status(201).json({ status: 'success', data: { listing } });
});

/**
 * PATCH /api/v1/marketplace/admin/listings/:id
 */
exports.adminUpdateListing = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!listing) return next(new AppError('Listing not found', 404));
  res.status(200).json({ status: 'success', data: { listing } });
});

/**
 * PATCH /api/v1/marketplace/admin/listings/:id/publish
 */
exports.adminPublishListing = catchAsync(async (req, res, next) => {
  const listing = await BusinessListing.findByIdAndUpdate(
    req.params.id,
    { isPublished: true, listingStatus: 'active', publishedAt: new Date() },
    { new: true }
  );
  if (!listing) return next(new AppError('Listing not found', 404));
  res.status(200).json({ status: 'success', data: { listing } });
});

/**
 * DELETE /api/v1/marketplace/admin/listings/:id
 */
exports.adminDeleteListing = catchAsync(async (req, res, next) => {
  await BusinessListing.findByIdAndUpdate(req.params.id, { listingStatus: 'withdrawn', isPublished: false });
  res.status(204).json({ status: 'success', data: null });
});

/* ════════════════════════════════════════════════════════════
   ADMIN — Seller Submissions
════════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/admin/seller-submissions
 */
exports.adminGetSubmissions = catchAsync(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = status ? { verificationStatus: status } : {};
  const skip = (Number(page) - 1) * Number(limit);
  const total = await SellerSubmission.countDocuments(filter);
  const submissions = await SellerSubmission.find(filter).sort('-createdAt').skip(skip).limit(Number(limit));

  res.status(200).json({ status: 'success', total, data: { submissions } });
});

/**
 * PATCH /api/v1/marketplace/admin/seller-submissions/:id/approve
 */
exports.adminApproveSubmission = catchAsync(async (req, res, next) => {
  const submission = await SellerSubmission.findById(req.params.id);
  if (!submission) return next(new AppError('Submission not found', 404));

  await submission.approve();

  // Optionally create a draft listing from the submission
  const listing = await BusinessListing.create({
    name: submission.businessName,
    industry: submission.industry,
    location: { emirate: submission.location },
    financials: {
      askingPrice: submission.askingPrice,
      monthlyRevenue: submission.monthlyRevenue,
      monthlyProfit: submission.monthlyProfit,
      vatRegistered: submission.vatRegistered,
    },
    yearsInOperation: 0,
    description: `Business submitted via Qumak Seller Portal. Ref: ${submission.submissionNumber}`,
    seller: submission._id,
    listingStatus: 'draft',
    isPublished: false,
  });

  submission.businessListingId = listing._id;
  await submission.save();

  res.status(200).json({ status: 'success', data: { submission, listing } });
});

/**
 * PATCH /api/v1/marketplace/admin/seller-submissions/:id/reject
 */
exports.adminRejectSubmission = catchAsync(async (req, res, next) => {
  const submission = await SellerSubmission.findById(req.params.id);
  if (!submission) return next(new AppError('Submission not found', 404));
  await submission.reject(req.body.reason || 'Does not meet listing criteria');
  res.status(200).json({ status: 'success', data: { submission } });
});

/**
 * PATCH /api/v1/marketplace/admin/seller-submissions/:id
 * Update submission fields, internal notes, and verification status (catalog / ops).
 */
exports.adminPatchSubmission = catchAsync(async (req, res, next) => {
  const allowed = new Set([
    'internalNotes',
    'verificationStatus',
    'rejectionReason',
    'assignedTo',
    'businessName',
    'industry',
    'location',
    'yearsOperating',
    'monthlyRevenue',
    'monthlyProfit',
    'askingPrice',
    'vatRegistered',
    'ownerName',
    'ownerPhone',
    'ownerEmail',
    'reasonForSale',
    'preferredListingType',
    'documents',
    'verificationChecks',
  ]);
  const patch = {};
  Object.keys(req.body || {}).forEach((k) => {
    if (allowed.has(k)) patch[k] = req.body[k];
  });
  if (req.body.verificationStatus != null) {
    const ok = [
      'submitted',
      'contacted',
      'documents_requested',
      'under_review',
      'approved',
      'rejected',
      'on_hold',
    ];
    if (!ok.includes(req.body.verificationStatus)) {
      return next(new AppError('Invalid verificationStatus', 400));
    }
  }
  if (Object.keys(patch).length === 0) {
    return next(new AppError('No valid fields to update', 400));
  }
  const submission = await SellerSubmission.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });
  if (!submission) return next(new AppError('Submission not found', 404));
  res.status(200).json({ status: 'success', data: { submission } });
});

/* ════════════════════════════════════════════════════════════
   ADMIN — Marketplace Activity (for Amer Dashboard)
════════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/admin/activity
 * Returns overview stats + recent bids + registrations for Amer Dashboard.
 */
exports.adminGetMarketplaceActivity = catchAsync(async (req, res, next) => {
  const [
    totalListings,
    activeListings,
    totalBids,
    recentBids,
    registrations,
    winningBids,
    topListings,
  ] = await Promise.all([
    BusinessListing.countDocuments(),
    BusinessListing.countDocuments({ isPublished: true, listingStatus: 'active' }),
    MarketplaceBid.countDocuments(),
    MarketplaceBid.find()
      .populate('listing', 'name slug financials metrics')
      .populate('bidder', 'name email')
      .sort('-createdAt')
      .limit(30)
      .lean(),
    AuctionRegistration.find()
      .populate('listing', 'name slug')
      .sort('-createdAt')
      .limit(30)
      .lean(),
    MarketplaceBid.find({ status: 'winning' })
      .populate('listing', 'name slug financials metrics')
      .populate('bidder', 'name email')
      .sort('-amount')
      .limit(20)
      .lean(),
    BusinessListing.find({ isPublished: true, listingStatus: 'active' })
      .sort('-metrics.bids')
      .limit(6)
      .select('name slug industry financials metrics auction listingMode')
      .lean(),
  ]);

  const totalBidVolume = await MarketplaceBid.aggregate([
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const referralEarnings = await MarketplaceBid.aggregate([
    { $match: { referrerUserId: { $exists: true, $ne: null } } },
    { $group: { _id: '$referrerUserId', totalCommission: { $sum: '$referralCommissionAmount' }, count: { $sum: 1 } } },
    { $sort: { totalCommission: -1 } },
    { $limit: 10 },
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalListings,
        activeListings,
        totalBids,
        totalBidVolume: totalBidVolume[0]?.total || 0,
        totalRegistrations: await AuctionRegistration.countDocuments(),
        winningBidsCount: winningBids.length,
      },
      recentBids: recentBids.map(b => ({
        id: b._id,
        listingName: b.listing?.name || 'Unknown',
        listingSlug: b.listing?.slug,
        bidderName: b.bidder?.name || 'Anonymous',
        bidderEmail: b.bidder?.email,
        amount: b.amount,
        bidType: b.bidType,
        status: b.status,
        isPreBid: b.isPreBid,
        referralCode: b.referredBy,
        createdAt: b.createdAt,
      })),
      winningBids: winningBids.map(b => ({
        id: b._id,
        listingName: b.listing?.name || 'Unknown',
        listingSlug: b.listing?.slug,
        askingPrice: b.listing?.financials?.askingPrice,
        bidderName: b.bidder?.name || 'Anonymous',
        bidderEmail: b.bidder?.email,
        amount: b.amount,
        status: b.status,
        createdAt: b.createdAt,
      })),
      registrations: registrations.map(r => ({
        id: r._id,
        listingName: r.listing?.name || 'Unknown',
        listingSlug: r.listing?.slug,
        name: r.name,
        email: r.email,
        phone: r.phone,
        investmentBudget: r.investmentBudget,
        referralCode: r.referralCode,
        referredBy: r.referredBy,
        status: r.status,
        createdAt: r.createdAt,
      })),
      topListings: topListings.map(l => ({
        id: l.slug || l._id,
        name: l.name,
        industry: l.industry,
        askingPrice: l.financials?.askingPrice,
        monthlyRevenue: l.financials?.monthlyRevenue,
        bids: l.metrics?.bids || 0,
        highestBid: l.metrics?.highestBid || 0,
        watchers: l.metrics?.watchers || 0,
        viewsToday: l.metrics?.viewsToday || 0,
        endsAt: l.auction?.endsAt,
      })),
      referralEarnings,
    },
  });
});

/**
 * GET /api/v1/marketplace/admin/registrations
 * All auction registrations with referral tracking.
 */
exports.adminGetRegistrations = catchAsync(async (req, res, next) => {
  const { listing, status, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (listing) filter.listing = listing;
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const total = await AuctionRegistration.countDocuments(filter);
  const regs = await AuctionRegistration.find(filter)
    .populate('listing', 'name slug')
    .populate('user', 'name email')
    .sort('-createdAt')
    .skip(skip)
    .limit(Number(limit))
    .lean();

  res.status(200).json({ status: 'success', total, data: { registrations: regs } });
});

/**
 * PATCH /api/v1/marketplace/admin/registrations/:id/approve
 */
exports.adminApproveRegistration = catchAsync(async (req, res, next) => {
  const reg = await AuctionRegistration.findByIdAndUpdate(
    req.params.id,
    { status: 'approved', approvedAt: new Date() },
    { new: true }
  );
  if (!reg) return next(new AppError('Registration not found', 404));
  res.status(200).json({ status: 'success', data: { registration: reg } });
});

/* ════════════════════════════════════════════════════════════
   BANK TRANSFER DEPOSITS
════════════════════════════════════════════════════════════ */

/**
 * GET /api/v1/marketplace/bank-details
 * Returns platform bank account details for manual transfers.
 */
exports.getBankDetails = catchAsync(async (req, res) => {
  let details = await SystemSettings.get('bank_details');
  if (!details || (typeof details === 'object' && Object.keys(details).length === 0)) {
    details = { ...DEFAULT_UAE_BANK_DETAILS, _source: 'default_uae_mock' };
  }
  res.status(200).json({ status: 'success', data: { bankDetails: details } });
});

/**
 * POST /api/v1/marketplace/listings/:id/deposit/bank
 * User submits bank transfer proof for a listing deposit.
 * Body: { senderName, senderBank, transferRef, transferDate, proofUrl, amount }
 */
exports.submitBankDeposit = catchAsync(async (req, res, next) => {
  const filter = getListingFilter(req.params.id);
  const listing = await BusinessListing.findOne(filter);
  if (!listing) return next(new AppError('Listing not found', 404));
  if (!listing.isPublished || listing.listingStatus !== 'active') {
    return next(new AppError('Listing is not accepting deposits', 400));
  }

  const { senderName, senderBank, transferRef, transferDate, proofUrl, amount } = req.body;
  if (!senderName) return next(new AppError('Sender name is required', 400));

  // Check for existing pending/confirmed deposit by this user
  const existing = await BankDeposit.findOne({
    listingId: listing._id,
    userId: req.user._id,
    status: { $in: ['pending', 'confirmed'] },
  });
  if (existing) {
    return res.status(200).json({
      status: 'success',
      message: 'Deposit already submitted',
      data: { deposit: existing },
    });
  }

  const deposit = await BankDeposit.create({
    listingId: listing._id,
    userId: req.user._id,
    amount: amount || 500,
    senderName,
    senderBank,
    transferRef,
    transferDate: transferDate ? new Date(transferDate) : undefined,
    proofUrl,
  });

  // Increment listing deposit count
  await BusinessListing.updateOne({ _id: listing._id }, { $inc: { 'metrics.inquiries': 1 } });

  res.status(201).json({ status: 'success', data: { deposit } });
});

/**
 * GET /api/v1/marketplace/listings/:id/my-deposit
 * Returns the current user's deposit status for a listing.
 */
exports.getMyDeposit = catchAsync(async (req, res, next) => {
  const filter = getListingFilter(req.params.id);
  const listing = await BusinessListing.findOne(filter);
  if (!listing) return next(new AppError('Listing not found', 404));

  const deposit = await BankDeposit.findOne({
    listingId: listing._id,
    userId: req.user._id,
  }).sort({ createdAt: -1 });

  res.status(200).json({ status: 'success', data: { deposit: deposit || null } });
});

/* ════════════════════════════════════════════════════════════
   ADMIN — BANK DEPOSITS
════════════════════════════════════════════════════════════ */

exports.adminGetDeposits = catchAsync(async (req, res) => {
  const { status, listingId } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (listingId) filter.listingId = listingId;

  const deposits = await BankDeposit.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('userId', 'name email phone')
    .populate('listingId', 'name slug listingNumber');

  res.status(200).json({ status: 'success', results: deposits.length, data: { deposits } });
});

exports.adminConfirmDeposit = catchAsync(async (req, res, next) => {
  const deposit = await BankDeposit.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'confirmed', confirmedBy: req.user?._id, confirmedAt: new Date(), adminNote: req.body.note } },
    { new: true }
  ).populate('userId', 'name email').populate('listingId', 'name');
  if (!deposit) return next(new AppError('Deposit not found', 404));
  res.status(200).json({ status: 'success', data: { deposit } });
});

exports.adminRejectDeposit = catchAsync(async (req, res, next) => {
  const deposit = await BankDeposit.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'rejected', adminNote: req.body.note || 'Rejected by admin' } },
    { new: true }
  );
  if (!deposit) return next(new AppError('Deposit not found', 404));
  res.status(200).json({ status: 'success', data: { deposit } });
});

exports.adminRefundDeposit = catchAsync(async (req, res, next) => {
  const deposit = await BankDeposit.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'refunded', refundedAt: new Date(), adminNote: req.body.note } },
    { new: true }
  );
  if (!deposit) return next(new AppError('Deposit not found', 404));
  res.status(200).json({ status: 'success', data: { deposit } });
});

/* ════════════════════════════════════════════════════════════
   ADMIN — BANK / SYSTEM SETTINGS
════════════════════════════════════════════════════════════ */

exports.adminGetSettings = catchAsync(async (req, res) => {
  const SystemSettings = require('../../model/schema/systemSettings');
  const settings = await SystemSettings.find({ group: req.query.group || 'bank' });
  const map = {};
  settings.forEach(s => { map[s.key] = s.value; });
  res.status(200).json({ status: 'success', data: { settings: map } });
});

exports.adminUpdateSettings = catchAsync(async (req, res) => {
  const SystemSettings = require('../../model/schema/systemSettings');
  const { settings } = req.body; // { key: value, ... }
  const group = req.body.group || 'bank';
  const ops = Object.entries(settings || {}).map(([key, value]) =>
    SystemSettings.set(key, value, { group, updatedBy: req.user?._id, label: key })
  );
  await Promise.all(ops);
  res.status(200).json({ status: 'success', message: 'Settings updated' });
});


