const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const crypto = require('crypto');
const User = require('../../model/schema/user');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('../../utills/smsJs');
require("dotenv").config();
const { sendMail } = require('../../utills/sendGridEmail');
// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Initialize Google OAuth2 Client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.API_BASE_URL || 'http://localhost:5001'}/api/v1/auth/google/callback`;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Google OAuth scopes
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
];

class AuthController {
  // User Registration
  async signup(req, res) {
    try {
      const {
        firstName,
        lastName,
        email,
        password,
        phoneNumber,
        role,
        emiratesId,
        passportNumber,
        company,
        referralCode  // Referral code from the person who referred them
      } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Check if user already exists
      const existingUser = await User.findOne({ email, deleted: { $ne: true } });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists'
        });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user object
      const userData = {
        firstName,
        lastName,
        email,
        password: hashedPassword,
        phoneNumber,
        role: role || 'user',
        deleted: false,
      };

      // Add role-specific fields
      if (role === 'amer') {
        userData.emiratesId = emiratesId;
        userData.passportNumber = passportNumber;
        userData.company = company;
      }

      // Handle referral code - link new user to referrer
      if (referralCode && referralCode.trim()) {
        const referrer = await User.findOne({ referralCode: referralCode.trim(), deleted: { $ne: true } });
        if (referrer) {
          userData.referredBy = referrer._id;
          userData.referredByCode = referralCode.trim();
          // Increment referrer's referral count
          referrer.referralCount = (referrer.referralCount || 0) + 1;
          referrer.referralHistory.push({
            referredUserId: null, // Will update after user is created
            referredUserName: `${firstName} ${lastName}`,
            referredUserEmail: email,
            commission: 0,
            status: 'pending',
            createdAt: new Date()
          });
          await referrer.save();
        }
      }

      // Create user in MongoDB
      const user = new User(userData);
      await user.save();

      // Update referrer's history with the new user's ID
      if (userData.referredBy) {
        await User.updateOne(
          { _id: userData.referredBy, 'referralHistory.referredUserEmail': email },
          { $set: { 'referralHistory.$.referredUserId': user._id } }
        );
      }

      // Eagerly grant the signup bonus so the ledger has a row from t=0 and
      // the new user has spending power without a separate read-triggered
      // grant. Never block signup on this — fall back to the lazy path in
      // getBalance() if the grant fails for any reason.
      try {
        const creditsService = require('../../services/creditsService');
        if (creditsService.SIGNUP_BONUS > 0) {
          await creditsService.topUp({
            userId: user._id,
            amount: creditsService.SIGNUP_BONUS,
            reason: 'topup_signup_bonus',
            meta: { source: 'signup', email: user.email },
          });
        }
      } catch (grantErr) {
        console.warn('[signup] signup-bonus grant failed (non-fatal):', grantErr?.message);
      }

      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user._id, 
          email: user.email, 
          role: user.role 
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Set HttpOnly cookie (same as Google OAuth flow)
      const isProduction = process.env.NODE_ENV === 'production';
      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';
      res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? frontendDomain : undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });

      // Return success response (token also in body for backward compatibility)
      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          user: {
            id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            phoneNumber: user.phoneNumber,
            country: user.country
          },
          token
        }
      });

     return;
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // User Login
  async signin(req, res) {
    try {
      const { email, password } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required'
        });
      }

      // Find user
      const user = await User.findOne({ email, deleted: { $ne: true } });
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Check password
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Update last login
      user.lastLogin = new Date();
      await user.save();

      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user._id, 
          email: user.email, 
          role: user.role 
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Set HttpOnly cookie (same as Google OAuth flow)
      const isProduction = process.env.NODE_ENV === 'production';
      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';
      res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? frontendDomain : undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });

      // Return success response (token also in body for backward compatibility)
      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            phoneNumber: user.phoneNumber,
            country: user.country,
            lastLogin: user.lastLogin
          },
          token
        }
      });

    } catch (error) {
      console.error('Signin error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Forgot Password
  async forgotPassword(req, res) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      // Check if user exists
      const user = await User.findOne({ email, deleted: { $ne: true } });
      if (!user) {
        // Don't reveal if user exists or not for security
        return res.status(200).json({
          success: true,
          message: 'If an account with that email exists, a password reset link has been sent'
        });
      }

      // Generate reset token
      const resetToken = jwt.sign(
        { userId: user._id, type: 'password_reset' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      // Store reset token in user document (you might want to add a resetToken field to your schema)
      user.resetToken = resetToken;
      user.resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour
      await user.save();
      console.log("sendMail: ", user);
      // TODO: Send email with reset link
      // For now, just return success
      // In production, you would integrate with an email service like SendGrid, Nodemailer, etc.
      await sendMail({
        to: email,
        subject: 'Password Reset Link',
        template_id: process.env.SENDGRID_TEMPLATE_ID_FORGOT_PASSWORD,
        dynamic_data: {
          preheader: 'Reset your password link expires in 1 hour',
          company_name: 'TMMET Technologies',
          user_name: user.firstName + ' ' + user.lastName || 'User',
          user_email: user.email,
          reset_link: process.env.FRONTEND_URL + '/reset-password?token=' + resetToken,
          support_email: 'support@tmmet.com',
          year: new Date().getFullYear()
        }
      });
      res.status(200).json({
        success: true,
        message: 'Password reset link sent to your email'
      });

    } catch (error) {
      console.error('Forgot password error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Reset Password
  async resetPassword(req, res) {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Token and new password are required'
        });
      }

      // Verify reset token
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'password_reset') {
        return res.status(400).json({
          success: false,
          message: 'Invalid reset token'
        });
      }

      // Find user
      const user = await User.findById(decoded.userId);
      if (!user || user.deleted) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Check if reset token is valid and not expired
      if (user.resetToken !== token || user.resetTokenExpires < new Date()) {
        return res.status(400).json({
          success: false,
          message: 'Reset token is invalid or expired'
        });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;
      user.resetToken = undefined;
      user.resetTokenExpires = undefined;
      await user.save();

      res.status(200).json({
        success: true,
        message: 'Password reset successfully'
      });

    } catch (error) {
      console.error('Reset password error:', error);
      if (error.name === 'JsonWebTokenError') {
        return res.status(400).json({
          success: false,
          message: 'Invalid reset token'
        });
      }
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Request OTP (via SMS)
  async requestOtp(req, res) {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
      }

      const user = await User.findOne({ phoneNumber, deleted: { $ne: true } });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      // Allow custom expiry (1-10 minutes)
      const minsReq = parseInt(req.body?.expiresInMinutes, 10);
      const safeMins = isNaN(minsReq) ? 5 : Math.min(10, Math.max(1, minsReq));
      const expires = new Date(Date.now() + safeMins * 60 * 1000);
      user.otpCode = otp;
      user.otpExpires = expires;
      await user.save();

      // Send SMS
      try {
        await sendSMS({
          to: phoneNumber,
          template: 'otp',
          data: { code: otp }
        });
      } catch (e) {
        // continue even if SMS provider not configured
        console.warn('SMS provider error:', e.message);
      }

      // Notify via WebSocket if connected
      try {
        const app = require('../../index');
        const wsServer = app.get('wsServer');
        wsServer?.sendToUser(user._id.toString(), 'notification', {
          type: 'otp',
          message: `Your OTP has been sent. It expires in ${safeMins} minute(s).`,
          userId: user._id.toString(),
          timestamp: new Date()
        });
      } catch {}

      return res.status(200).json({ success: true, message: 'OTP sent' });
    } catch (error) {
      console.error('Request OTP error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  // Verify OTP
  async verifyOtp(req, res) {
    try {
      const { phoneNumber, code } = req.body;
      if (!phoneNumber || !code) {
        return res.status(400).json({ success: false, message: 'Phone and code are required' });
      }

      const user = await User.findOne({ phoneNumber, deleted: { $ne: true } });
      if (!user || !user.otpCode || !user.otpExpires) {
        return res.status(400).json({ success: false, message: 'OTP not requested' });
      }

      if (user.otpExpires < new Date()) {
        return res.status(400).json({ success: false, message: 'OTP expired' });
      }

      if (user.otpCode !== code) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
      }

      // Clear OTP and issue short-lived token for verification-step
      user.otpCode = undefined;
      user.otpExpires = undefined;
      await user.save();

      const token = jwt.sign({ userId: user._id, phoneVerified: true }, JWT_SECRET, { expiresIn: '15m' });

      // WS notify
      try {
        const app = require('../../index');
        const wsServer = app.get('wsServer');
        wsServer?.sendToUser(user._id.toString(), 'notification', {
          type: 'success',
          message: 'OTP verified successfully.',
          userId: user._id.toString(),
          timestamp: new Date()
        });
      } catch {}

      return res.status(200).json({ success: true, message: 'OTP verified', data: { token } });
    } catch (error) {
      console.error('Verify OTP error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  // Get current user profile
  async getProfile(req, res) {
    try {
      const userId = req.user.userId;

      const user = await User.findById(userId).select('-password');
      if (!user || user.deleted) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      res.status(200).json({
        success: true,
        data: {user:user}
        });

    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Update user profile
  async updateProfile(req, res) {
    try {
      const userId = req.user.userId;
      const updateData = req.body;

      // Remove sensitive fields from update
      delete updateData.password;
      delete updateData.role;
      delete updateData.deleted;

      const user = await User.findByIdAndUpdate(
        userId,
        updateData,
        { new: true, runValidators: true }
      ).select('-password');

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: { user }
      });

    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Change password
  async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password and new password are required'
        });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect'
        });
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedNewPassword;
      await user.save();

      res.status(200).json({
        success: true,
        message: 'Password changed successfully'
      });

    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Upload file to Supabase and save reference to MongoDB
  async uploadFile(req, res) {
    try {
      const userId = req.user.userId;
      const { file, fileType, remarks } = req.body;

      if (!file || !fileType) {
        return res.status(400).json({
          success: false,
          message: 'File and file type are required'
        });
      }

      // Upload file to Supabase Storage
      const fileName = `${userId}_${Date.now()}_${file.name}`;
      const { data, error } = await supabase.storage
        .from('user-documents')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600'
        });

      if (error) {
        console.error('Supabase upload error:', error);
        return res.status(500).json({
          success: false,
          message: 'File upload failed'
        });
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('user-documents')
        .getPublicUrl(fileName);

      // Save file reference to MongoDB
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const documentData = {
        type: fileType,
        path: urlData.publicUrl,
        remarks: remarks || '',
        uploadDate: new Date()
      };

      user.documents.push(documentData);
      await user.save();

      res.status(200).json({
        success: true,
        message: 'File uploaded successfully',
        data: {
          document: documentData,
          url: urlData.publicUrl
        }
      });

    } catch (error) {
      console.error('File upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Get user documents
  async getUserDocuments(req, res) {
    try {
      const userId = req.user.userId;

      const user = await User.findById(userId).select('documents');
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          documents: user.documents || []
        }
      });

    } catch (error) {
      console.error('Get documents error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
      }
    }

  // Logout — clears HttpOnly cookie and session
  async logout(req, res) {
    try {
      const isProduction = process.env.NODE_ENV === 'production';
      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';

      // Clear the HttpOnly JWT cookie
      res.clearCookie('token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? frontendDomain : undefined,
        path: '/'
      });

      // Destroy session if it exists
      if (req.session) {
        req.session.destroy(() => {});
      }

      res.status(200).json({
        success: true,
        message: 'Logout successful'
      });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }

  // Generate Google OAuth Authorization URL
  async getGoogleAuthUrl(req, res) {
    try {
      // Validate OAuth configuration
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        console.error('Google OAuth credentials not configured');
        return res.status(500).json({
          success: false,
          message: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment variables.',
          error: 'Missing OAuth credentials'
        });
      }

      // Log redirect URI for debugging (no secrets)
      console.log(`🔐 Google OAuth → Redirect URI: ${GOOGLE_REDIRECT_URI}`);

      // Generate a secure random state value for CSRF protection
      const state = crypto.randomBytes(32).toString('hex');
      
      // Store state in session
      req.session.oauthState = state;

      // Generate authorization URL
      const authorizationUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Gets refresh token
        scope: GOOGLE_SCOPES,
        include_granted_scopes: true, // Enable incremental authorization
        state: state, // CSRF protection
        prompt: 'consent' // Force consent screen to get refresh token
      });

      res.status(200).json({
        success: true,
        data: {
          authUrl: authorizationUrl,
          // Include redirect URI in response for debugging (only in development)
          ...(process.env.NODE_ENV !== 'production' && {
            debug: {
              redirectUri: GOOGLE_REDIRECT_URI,
              message: 'Add this exact redirect URI to Google Cloud Console'
            }
          })
        }
      });
    } catch (error) {
      console.error('Error generating Google auth URL:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to generate authorization URL',
        error: error.message
      });
    }
  }

  // Google OAuth Callback Handler
  async googleOAuthCallback(req, res) {
    try {
      const { code, error, state } = req.query;

      // Step 4: Handle the OAuth 2.0 server response
      // Check for OAuth errors from Google
      if (error) {
        console.error('Google OAuth error:', error);
        // Handle specific error types
        let errorMessage = 'oauth_failed';
        if (error === 'access_denied') {
          errorMessage = 'access_denied';
        } else if (error === 'invalid_request') {
          errorMessage = 'invalid_request';
        }
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=${errorMessage}`);
      }

      // Validate authorization code
      if (!code) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=missing_code`);
      }

      // Verify state parameter (CSRF protection) - CRITICAL SECURITY CHECK
      if (!req.session.oauthState || req.session.oauthState !== state) {
        console.error('State mismatch. Possible CSRF attack. Expected:', req.session.oauthState, 'Received:', state);
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=invalid_state`);
      }

      // Clear the state from session after verification
      delete req.session.oauthState;

      // Step 5: Exchange authorization code for refresh and access tokens
      let tokens;
      try {
        const tokenResponse = await oauth2Client.getToken(code);
        tokens = tokenResponse.tokens;
        oauth2Client.setCredentials(tokens);
      } catch (tokenError) {
        console.error('Token exchange error:', tokenError);
        // Handle invalid_grant error specifically
        if (tokenError.message && tokenError.message.includes('invalid_grant')) {
          return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=invalid_grant`);
        }
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=token_exchange_failed`);
      }

      if (!tokens.access_token) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=token_exchange_failed`);
      }

      // Step 6: Check which scopes users granted
      const grantedScopes = tokens.scope ? tokens.scope.split(' ') : [];
      const requiredScopes = [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'openid'
      ];
      
      // Check if all required scopes were granted
      const hasEmailScope = grantedScopes.some(scope => 
        scope.includes('userinfo.email') || scope === 'openid'
      );
      const hasProfileScope = grantedScopes.some(scope => 
        scope.includes('userinfo.profile') || scope === 'openid'
      );

      if (!hasEmailScope || !hasProfileScope) {
        console.warn('User did not grant all required scopes. Granted:', grantedScopes);
        // For sign-in, we can proceed with what we have, but log the warning
      }

      // Get user info from Google using OAuth2 client
      const oauth2 = google.oauth2({
        auth: oauth2Client,
        version: 'v2'
      });

      let userInfoResponse;
      try {
        userInfoResponse = await oauth2.userinfo.get();
      } catch (apiError) {
        console.error('Error fetching user info:', apiError);
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=api_error`);
      }

      const googleUser = userInfoResponse.data;
      const { email, given_name, family_name, picture, verified_email } = googleUser;

      // Validate email
      if (!email) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=no_email`);
      }

      // Check if user exists in database
      let user = await User.findOne({ email, deleted: { $ne: true } });

      if (user) {
        // User exists - update lastLogin
        user.lastLogin = new Date();
        // Update profile picture if available and not set
        if (picture && !user.profilePicture) {
          user.profilePicture = { path: picture };
        }
        await user.save();
      } else {
        // New user - create account
        const userData = {
          firstName: given_name || 'User',
          lastName: family_name || '',
          email: email,
          role: 'user',
          deleted: false,
          lastLogin: new Date()
        };

        // Add profile picture if available
        if (picture) {
          userData.profilePicture = { path: picture };
        }

        user = new User(userData);
        await user.save();
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          userId: user._id,
          email: user.email,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Set HttpOnly cookie with token
      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';
      const isProduction = process.env.NODE_ENV === 'production';

      res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction, // Only send over HTTPS in production
        sameSite: isProduction ? 'none' : 'lax', // Required for cross-site in production
        domain: isProduction ? frontendDomain : undefined, // Only set domain in production
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/'
      });

      // Redirect to frontend /auth page with token in URL
      // /auth is a public route — AuthContext reads ?token=, stores in localStorage,
      // then AuthPage detects the authenticated user and redirects to the role-based dashboard
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const redirectUrl = `${frontendUrl}/auth?token=${encodeURIComponent(token)}`;
      console.log(`✅ Google OAuth success: ${email} (${user._id}) → redirecting`);
      return res.redirect(redirectUrl);

    } catch (error) {
      console.error('Google OAuth callback error:', error);
      
      // More detailed error logging
      if (error.response) {
        console.error('OAuth API Error:', error.response.data);
      }

      // Handle specific error types
      let errorMessage = 'oauth_error';
      if (error.message && error.message.includes('invalid_grant')) {
        errorMessage = 'invalid_grant';
      } else if (error.message && error.message.includes('access_denied')) {
        errorMessage = 'access_denied';
      }

      // Redirect to login with error
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=${errorMessage}`);
    }
  }

  // Verify token (middleware helper)
  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return { valid: true, decoded };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }



  async updateOnboarding(req, res) {
    try {
      const userId = req.user?._id || req.user?.id;
      if (!userId) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
   
      const incoming = req.body?.onboardingProfile || {};
   
      // Whitelist fields — never trust the client to set arbitrary keys.
      const allowed = [
        "creativeIdentity",
        "experienceLevel",
        "primaryGoal",
        "capabilities",
        "monthlyVolume",
        "videosPerMonth",
        "aiAdvantageScore",
        "referralSource",
        "creatorLevel",
      ];
   
      const update = { "onboardingProfile.completed": true, "onboardingProfile.completedAt": new Date() };
      for (const key of allowed) {
        if (incoming[key] !== undefined) update[`onboardingProfile.${key}`] = incoming[key];
      }
      // Keep the raw map too, for any newly-added question without a schema change.
      update["onboardingProfile.answers"] = incoming;
   
      const user = await User.findByIdAndUpdate(
        userId,
        { $set: update },
        { new: true, runValidators: true }
      ).select("-password");
   
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
   
      return res.json({ success: true, data: { user } });
    } catch (err) {
      console.error("updateOnboarding error:", err);
      return res.status(500).json({ success: false, message: "Failed to save onboarding" });
    }
  }
}

module.exports = new AuthController();
