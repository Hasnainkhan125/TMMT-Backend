const express = require('express');
const router = express.Router();
const authController = require('./authController');
const auth = require('../../middelwares/auth');

// Public routes (no authentication required)
router.post('/signup', authController.signup);
router.post('/signin', authController.signin);
router.post('/onboarding', authController.updateOnboarding);

router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/otp/request', authController.requestOtp);
router.post('/otp/verify', authController.verifyOtp);

// Google OAuth routes
router.get('/google/auth-url', authController.getGoogleAuthUrl);
router.get('/google/callback', authController.googleOAuthCallback);

// Logout — public so expired tokens can still clear cookies
router.post('/logout', authController.logout);

// Protected routes (authentication required)
router.get('/profile', auth, authController.getProfile);
router.put('/profile', auth, authController.updateProfile);
router.post('/change-password', auth, authController.changePassword);
router.post('/upload-file', auth, authController.uploadFile);
router.get('/documents', auth, authController.getUserDocuments);

// Legacy routes (keeping for backward compatibility)
const clerkController = require('./clerkController');
router.post('/clerk/sync', clerkController.syncClerkUser);
router.get('/me', auth, clerkController.getMe);

module.exports = router; 