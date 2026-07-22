const express = require('express');
const router = express.Router();
const ctrl = require('./marketplaceController');
const acqCtrl = require('./acquisitionController');
const auth = require('../../middelwares/auth');
const { requireRole } = require('../../middelwares/auth');
const requireAdmin = [auth, requireRole('admin', 'superadmin')];

/* ─── Public Routes ─── */

// Bank details (public so unauthenticated users can see how to pay)
router.get('/bank-details', ctrl.getBankDetails);

// Listing type catalog (strategy — four models)
router.get('/listing-types', ctrl.getListingTypes);

// Listings
router.get('/listings', ctrl.getListings);
router.get('/listings/:slug', ctrl.getListingBySlug);
router.post('/listings/:id/inquiry', ctrl.trackInquiry);

// Auction registration (pre-bid) — public, optional auth
router.post('/listings/:id/register', ctrl.registerForAuction);

// Marketplace buyer identity (Emirates ID / passport) — auth required
router.patch('/me/identity', auth, ctrl.updateMarketplaceIdentity);

// Referral code — auth required
router.get('/listings/:id/referral', auth, ctrl.getMyReferralCode);

// Place bid (auth required)
router.post('/listings/:id/bid', auth, ctrl.placeBid);

// Auto-bid ceiling
router.post('/listings/:id/auto-bid', auth, ctrl.setAutoBid);

// Bids / leaderboard
router.get('/listings/:id/bids', auth, ctrl.getListingBids);

// Bank transfer deposit (auth required)
router.post('/listings/:id/deposit/bank', auth, ctrl.submitBankDeposit);
router.get('/listings/:id/my-deposit', auth, ctrl.getMyDeposit);

// Documents
router.get('/listings/:listingId/documents', auth, acqCtrl.getListingDocuments);
router.post('/listings/:listingId/documents', auth, acqCtrl.uploadListingDocument);
router.patch('/listings/:listingId/documents/:docId/verify', auth, acqCtrl.verifyDocument);

// AI analysis
router.post('/listings/:id/ai-analysis', auth, acqCtrl.getAIAnalysis);
router.post('/listings/:id/ai-ask', auth, acqCtrl.askAIQuestion);

// Seller submission (user lists their business)
router.post('/seller-submission', ctrl.createSellerSubmission);

// User's own bids
router.get('/user/bids', auth, ctrl.getMyBids);

/* ─── Acquisition Flow Routes ─── */
router.get('/acquisition/my', auth, acqCtrl.getMyAcquisitions);
router.get('/acquisition/:id', auth, acqCtrl.getAcquisitionFlow);

// Stripe payments
router.post('/acquisition/:id/deposit/stripe', auth, acqCtrl.createStripeDepositIntent);
router.post('/acquisition/:id/deposit/stripe/confirm', auth, acqCtrl.confirmStripeDeposit);
router.post('/acquisition/:id/final-payment/stripe', auth, acqCtrl.createStripeFinalPaymentIntent);
router.post('/acquisition/:id/final-payment/stripe/confirm', auth, acqCtrl.confirmStripeFinalPayment);

// Crypto payments
router.get('/acquisition/:id/deposit/crypto-address', auth, acqCtrl.getCryptoDepositAddress);
router.post('/acquisition/:id/deposit/crypto-confirm', auth, acqCtrl.confirmCryptoDeposit);
router.post('/acquisition/:id/final-payment/crypto-confirm', auth, acqCtrl.confirmCryptoFinalPayment);

// Stage transitions
router.patch('/acquisition/:id/agreement-signed', auth, acqCtrl.confirmAgreementSigned);

// Stripe webhook (raw body needed)
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), acqCtrl.stripeWebhook);

/* ─── Admin Routes ─── (auth + admin role required) */

// Listings management
router.get('/admin/listings', requireAdmin, ctrl.adminGetListings);
router.post('/admin/listings', requireAdmin, ctrl.adminCreateListing);
router.patch('/admin/listings/:id', requireAdmin, ctrl.adminUpdateListing);
router.patch('/admin/listings/:id/publish', requireAdmin, ctrl.adminPublishListing);
router.delete('/admin/listings/:id', requireAdmin, ctrl.adminDeleteListing);

// Seller submissions
router.get('/admin/seller-submissions', requireAdmin, ctrl.adminGetSubmissions);
router.patch('/admin/seller-submissions/:id/approve', requireAdmin, ctrl.adminApproveSubmission);
router.patch('/admin/seller-submissions/:id/reject', requireAdmin, ctrl.adminRejectSubmission);
router.patch('/admin/seller-submissions/:id', requireAdmin, ctrl.adminPatchSubmission);

// Bank deposits management
router.get('/admin/deposits', requireAdmin, ctrl.adminGetDeposits);
router.patch('/admin/deposits/:id/confirm', requireAdmin, ctrl.adminConfirmDeposit);
router.patch('/admin/deposits/:id/reject', requireAdmin, ctrl.adminRejectDeposit);
router.patch('/admin/deposits/:id/refund', requireAdmin, ctrl.adminRefundDeposit);

// Platform settings (bank details etc)
router.get('/admin/settings', requireAdmin, ctrl.adminGetSettings);
router.put('/admin/settings', requireAdmin, ctrl.adminUpdateSettings);

// Marketplace activity dashboard
router.get('/admin/activity', requireAdmin, ctrl.adminGetMarketplaceActivity);
router.get('/admin/registrations', requireAdmin, ctrl.adminGetRegistrations);
router.patch('/admin/registrations/:id/approve', requireAdmin, ctrl.adminApproveRegistration);

// Admin acquisition management
router.get('/admin/acquisitions', requireAdmin, acqCtrl.adminGetAllAcquisitions);
router.post('/admin/acquisitions', requireAdmin, acqCtrl.createAcquisitionFlow);
router.patch('/admin/acquisitions/:id/dd-complete', requireAdmin, acqCtrl.completeDueDiligence);
router.patch('/admin/acquisitions/:id/transfer-update', requireAdmin, acqCtrl.updateTransferChecklist);

module.exports = router;
