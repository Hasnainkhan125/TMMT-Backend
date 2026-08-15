const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const crypto = require('crypto');
const User = require('../../model/schema/user');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('../../utills/smsJs');
require("dotenv").config();
const { sendMail } = require('../../utills/sendGridEmail');

// --- Initialize Supabase client safely ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase credentials missing. File uploads will fail.");
}
const supabase = createClient(supabaseUrl || '', supabaseKey || '');

// --- JWT & OAuth Config ---
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.API_BASE_URL || 'http://localhost:5001'}/api/v1/auth/google/callback`;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
];

class AuthController {
  // --- User Registration ---
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
        referralCode
      } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Check if user already exists
      const existingUser = await User.findOne({ email: normalizedEmail, deleted: { $ne: true } });
      if (existingUser) {
        return res.status(400).json({ success: false, message: 'User with this email already exists' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user object
      const userData = {
        firstName: firstName?.trim(),
        lastName: lastName?.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        phoneNumber: phoneNumber?.trim(),
        role: role || 'user',
        deleted: false,
      };

      // Add role-specific fields
      if (role === 'amer') {
        userData.emiratesId = emiratesId?.trim();
        userData.passportNumber = passportNumber?.trim();
        userData.company = company?.trim();
      }

      // Handle referral code
      if (referralCode && referralCode.trim()) {
        const referrer = await User.findOne({ referralCode: referralCode.trim(), deleted: { $ne: true } });
        if (referrer) {
          userData.referredBy = referrer._id;
          userData.referredByCode = referralCode.trim();
          referrer.referralCount = (referrer.referralCount || 0) + 1;
          referrer.referralHistory.push({
            referredUserId: null,
            referredUserName: `${firstName} ${lastName}`,
            referredUserEmail: normalizedEmail,
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
          { _id: userData.referredBy, 'referralHistory.referredUserEmail': normalizedEmail },
          { $set: { 'referralHistory.$.referredUserId': user._id } }
        );
      }

      // Grant signup bonus (non-blocking)
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
        { userId: user._id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Set HttpOnly cookie
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

      // Return success response
      return res.status(201).json({
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

    } catch (error) {
      console.error('Signup error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- User Login ---
  async signin(req, res) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const user = await User.findOne({ email: normalizedEmail, deleted: { $ne: true } });

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      user.lastLogin = new Date();
      await user.save();

      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

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

      return res.status(200).json({
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
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Forgot Password ---
  async forgotPassword(req, res) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const user = await User.findOne({ email: normalizedEmail, deleted: { $ne: true } });

      if (!user) {
        // Don't reveal if user exists for security
        return res.status(200).json({ success: true, message: 'If an account with that email exists, a password reset link has been sent' });
      }

      const resetToken = jwt.sign(
        { userId: user._id, type: 'password_reset' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      user.resetToken = resetToken;
      user.resetTokenExpires = new Date(Date.now() + 3600000);
      await user.save();

      await sendMail({
        to: normalizedEmail,
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

      return res.status(200).json({ success: true, message: 'Password reset link sent to your email' });

    } catch (error) {
      console.error('Forgot password error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Reset Password ---
  async resetPassword(req, res) {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({ success: false, message: 'Token and new password are required' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
      }

      // SECURITY: Ensure token type is correct
      if (decoded.type !== 'password_reset') {
        return res.status(400).json({ success: false, message: 'Invalid reset token type' });
      }

      const user = await User.findById(decoded.userId);
      if (!user || user.deleted) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      if (user.resetToken !== token || user.resetTokenExpires < new Date()) {
        return res.status(400).json({ success: false, message: 'Reset token is invalid or expired' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;
      user.resetToken = undefined;
      user.resetTokenExpires = undefined;
      await user.save();

      return res.status(200).json({ success: true, message: 'Password reset successfully' });

    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Request OTP ---
  async requestOtp(req, res) {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
      }

      const user = await User.findOne({ phoneNumber: phoneNumber.trim(), deleted: { $ne: true } });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const minsReq = parseInt(req.body?.expiresInMinutes, 10);
      const safeMins = isNaN(minsReq) ? 5 : Math.min(10, Math.max(1, minsReq));
      const expires = new Date(Date.now() + safeMins * 60 * 1000);

      user.otpCode = otp;
      user.otpExpires = expires;
      await user.save();

      try {
        await sendSMS({ to: phoneNumber, template: 'otp', data: { code: otp } });
      } catch (e) {
        console.warn('SMS provider error:', e.message);
      }

      return res.status(200).json({ success: true, message: 'OTP sent' });

    } catch (error) {
      console.error('Request OTP error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  // --- Verify OTP ---
  async verifyOtp(req, res) {
    try {
      const { phoneNumber, code } = req.body;
      if (!phoneNumber || !code) {
        return res.status(400).json({ success: false, message: 'Phone and code are required' });
      }

      const user = await User.findOne({ phoneNumber: phoneNumber.trim(), deleted: { $ne: true } });
      if (!user || !user.otpCode || !user.otpExpires) {
        return res.status(400).json({ success: false, message: 'OTP not requested' });
      }

      if (user.otpExpires < new Date()) {
        return res.status(400).json({ success: false, message: 'OTP expired' });
      }

      if (user.otpCode !== code) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
      }

      user.otpCode = undefined;
      user.otpExpires = undefined;
      await user.save();

      const token = jwt.sign({ userId: user._id, phoneVerified: true }, JWT_SECRET, { expiresIn: '15m' });

      return res.status(200).json({ success: true, message: 'OTP verified', data: { token } });

    } catch (error) {
      console.error('Verify OTP error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  // --- Get Profile ---
  async getProfile(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId).select('-password');

      if (!user || user.deleted) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      return res.status(200).json({ success: true, data: { user } });

    } catch (error) {
      console.error('Get profile error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Update Profile ---
  async updateProfile(req, res) {
    try {
      const userId = req.user.userId;
      const updateData = req.body;

      delete updateData.password;
      delete updateData.role;
      delete updateData.deleted;

      const user = await User.findByIdAndUpdate(
        userId,
        updateData,
        { new: true, runValidators: true }
      ).select('-password');

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      return res.status(200).json({ success: true, message: 'Profile updated successfully', data: { user } });

    } catch (error) {
      console.error('Update profile error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Change Password ---
  async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Current password and new password are required' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();

      return res.status(200).json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Upload File to Supabase ---
  async uploadFile(req, res) {
    try {
      const userId = req.user.userId;
      const { file, fileType, remarks } = req.body;

      if (!file || !fileType) {
        return res.status(400).json({ success: false, message: 'File and file type are required' });
      }

      const fileName = `${userId}_${Date.now()}_${file.name}`;
      const { error } = await supabase.storage
        .from('user-documents')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600'
        });

      if (error) {
        console.error('Supabase upload error:', error);
        return res.status(500).json({ success: false, message: 'File upload failed' });
      }

      const { data: urlData } = supabase.storage.from('user-documents').getPublicUrl(fileName);

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const documentData = {
        type: fileType,
        path: urlData.publicUrl,
        remarks: remarks || '',
        uploadDate: new Date()
      };

      user.documents.push(documentData);
      await user.save();

      return res.status(200).json({
        success: true,
        message: 'File uploaded successfully',
        data: { document: documentData, url: urlData.publicUrl }
      });

    } catch (error) {
      console.error('File upload error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Get User Documents ---
  async getUserDocuments(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId).select('documents');

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      return res.status(200).json({ success: true, data: { documents: user.documents || [] } });

    } catch (error) {
      console.error('Get documents error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Logout ---
  async logout(req, res) {
    try {
      const isProduction = process.env.NODE_ENV === 'production';
      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';

      res.clearCookie('token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? frontendDomain : undefined,
        path: '/'
      });

      if (req.session) {
        req.session.destroy(() => {});
      }

      return res.status(200).json({ success: true, message: 'Logout successful' });

    } catch (error) {
      console.error('Logout error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
  }

  // --- Google OAuth URL ---
  async getGoogleAuthUrl(req, res) {
    try {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        console.error('Google OAuth credentials not configured');
        return res.status(500).json({
          success: false,
          message: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment variables.',
          error: 'Missing OAuth credentials'
        });
      }

      const state = crypto.randomBytes(32).toString('hex');
      req.session.oauthState = state;

      const authorizationUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        include_granted_scopes: true,
        state: state,
        prompt: 'consent'
      });

      const response = {
        success: true,
        data: { authUrl: authorizationUrl }
      };

      // Only include debug info in development
      if (process.env.NODE_ENV !== 'production') {
        response.data.debug = {
          redirectUri: GOOGLE_REDIRECT_URI,
          message: 'Add this exact redirect URI to Google Cloud Console'
        };
      }

      return res.status(200).json(response);

    } catch (error) {
      console.error('Error generating Google auth URL:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate authorization URL', error: error.message });
    }
  }

  // --- Google OAuth Callback ---
  async googleOAuthCallback(req, res) {
    try {
      const { code, error, state } = req.query;

      if (error) {
        console.error('Google OAuth error:', error);
        let errorMessage = 'oauth_failed';
        if (error === 'access_denied') errorMessage = 'access_denied';
        else if (error === 'invalid_request') errorMessage = 'invalid_request';
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=${errorMessage}`);
      }

      if (!code) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=missing_code`);
      }

      if (!req.session.oauthState || req.session.oauthState !== state) {
        console.error('State mismatch. Possible CSRF attack.');
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=invalid_state`);
      }

      delete req.session.oauthState;

      let tokens;
      try {
        const tokenResponse = await oauth2Client.getToken(code);
        tokens = tokenResponse.tokens;
        oauth2Client.setCredentials(tokens);
      } catch (tokenError) {
        console.error('Token exchange error:', tokenError);
        if (tokenError.message?.includes('invalid_grant')) {
          return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=invalid_grant`);
        }
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=token_exchange_failed`);
      }

      if (!tokens.access_token) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=token_exchange_failed`);
      }

      const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
      let userInfoResponse;
      try {
        userInfoResponse = await oauth2.userinfo.get();
      } catch (apiError) {
        console.error('Error fetching user info:', apiError);
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=api_error`);
      }

      const googleUser = userInfoResponse.data;
      const { email, given_name, family_name, picture } = googleUser;

      if (!email) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=no_email`);
      }

      let user = await User.findOne({ email: email.toLowerCase(), deleted: { $ne: true } });

      if (user) {
        user.lastLogin = new Date();
        if (picture && !user.profilePicture) {
          user.profilePicture = { path: picture };
        }
        await user.save();
      } else {
        const userData = {
          firstName: given_name || 'User',
          lastName: family_name || '',
          email: email.toLowerCase(),
          role: 'user',
          deleted: false,
          lastLogin: new Date()
        };
        if (picture) userData.profilePicture = { path: picture };
        user = new User(userData);
        await user.save();
      }

      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      const frontendDomain = process.env.FRONTEND_DOMAIN || '.qumak.io';
      const isProduction = process.env.NODE_ENV === 'production';

      res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? frontendDomain : undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/auth?token=${encodeURIComponent(token)}`);

    } catch (error) {
      console.error('Google OAuth callback error:', error);
      let errorMessage = 'oauth_error';
      if (error.message?.includes('invalid_grant')) errorMessage = 'invalid_grant';
      else if (error.message?.includes('access_denied')) errorMessage = 'access_denied';
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=${errorMessage}`);
    }
  }

  // --- Verify Token Helper ---
  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return { valid: true, decoded };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // --- Update Onboarding ---
  async updateOnboarding(req, res) {
    try {
      const userId = req.user?._id || req.user?.id;
      if (!userId) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }

      const incoming = req.body?.onboardingProfile || {};
      const allowed = [
        "creativeIdentity", "experienceLevel", "primaryGoal", "capabilities",
        "monthlyVolume", "videosPerMonth", "aiAdvantageScore", "referralSource", "creatorLevel"
      ];

      const update = { "onboardingProfile.completed": true, "onboardingProfile.completedAt": new Date() };
      for (const key of allowed) {
        if (incoming[key] !== undefined) update[`onboardingProfile.${key}`] = incoming[key];
      }
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