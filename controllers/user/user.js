const User = require("../../model/schema/user");
// const ServiceEntryData = require('../../model/schema/serviceEntryData'); // TODO: Create this schema
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { upload: s3Upload, getFileUrl } = require("../../middleware/s3Upload");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");


// Admin register
const adminRegister = async (req, res) => {
  try {
    const { username, password, firstName, lastName, phoneNumber } = req.body;
    const user = await User.findOne({ username: username });
    if (user) {
      return res
        .status(400)
        .json({ message: "Admin already exist please try another email" });
    } else {
      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);
      // Create a new user
      const user = new User({
        username,
        password: hashedPassword,
        firstName,
        lastName,
        phoneNumber,
        role: "admin",
      });
      // Save the user to the database
      await user.save();
      res.status(200).json({ message: "Admin created successfully" });
    }
  } catch (error) {
    res.status(500).json({ error: error });
  }
};

// Set upload folder for user documents — used by s3Upload middleware
const withUserFolder = (req, _res, next) => { req.uploadFolder = 'user-documents'; next(); };
const upload = {
  single: (field) => [withUserFolder, ...s3Upload.single(field)],
  array:  (field, max) => [withUserFolder, ...s3Upload.array(field, max)],
  fields: (fields) => [withUserFolder, ...s3Upload.fields(fields)],
};

// User Registration
const register = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      password,
      role = 'user',
    } = req.body;

    // Check if user exists


    const existingUser = await User.findOne({ 
      $or: [{ email }] 
    });


    if (existingUser) {
      return res.status(400).json({ 
        error: existingUser.email === email 
          ? 'Email already in use' 
          : 'Email already exists' 
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      firstName,
      lastName,
      email,
      phoneNumber,
      password: hashedPassword,
      role,
      platformCredits: 10000,
      marketplaceOnboardingBonus: true,
    });

    await user.save();

    // Create JWT token
    const token = jwt.sign(
      { 
        userId: user._id,
        role: user.role 
      },
      process.env.JWT_SECRET || 'secret_key',
      { expiresIn: '24h' }
    );

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      user: userResponse,
      token,
      message: "Registration successful"
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      error: error.message || "Registration failed" 
    });
  }
};


const index = async (req, res) => {
  try {
    let user = await User.find(); // { deleted: false }
    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ error });
  }
};

const view = async (req, res) => {
  try {
    let user = await User.findOne({ _id: req.params.id });
    if (!user) return res.status(404).json({ message: "no Data Found." });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error });
  }
};

let deleteData = async (req, res) => {
  try {
    const userId = req.params.id;

    // Assuming you have retrieved the user document using userId
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.role !== "admin") {
      // Update the user's 'deleted' field to true
      await User.deleteOne({ _id: userId });
      res.send({ message: "Record deleted Successfully" });
    } else {
      res.status(404).json({ message: "admin can not delete" });
    }
  } catch (error) {
    res.status(500).json({ error });
  }
};

const deleteMany = async (req, res) => {
  try {
    const updatedUsers = await User.updateMany(
      { _id: { $in: req.body }, role: { $ne: "admin" } },
      { $set: { deleted: true } }
    );
    res.status(200).json({ message: "done", updatedUsers });
  } catch (err) {
    res.status(404).json({ message: "error", err });
  }
};



const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find the user by email
    const user = await User.findOne({ 
      email, 
      deleted: false 
    })

    if (!user) {
      return res.status(401).json({ 
        error: "Invalid email or password" 
      });
    }

    // Compare the provided password with the hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        error: "Invalid email or password" 
      });
    }

    // Create JWT token
    const token = jwt.sign(
      { 
        userId: user._id,
        role: user.role 
      }, 
      process.env.JWT_SECRET || 'secret_key',
      { expiresIn: '24h' }
    );


    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(200).json({
      user: userResponse,
      token,
      message: "Login successful"
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: "An error occurred during login" 
    });
  }
};

// Get user stats
const getUserStats = async (req, res) => {
  try {
    const { id } = req.params;
    // TODO: Re-enable once ServiceEntryData schema is created
    // const stats = await ServiceEntryData.aggregate([
    //   { $match: { customerId: mongoose.Types.ObjectId(id) } },
    //   {
    //     $group: {
    //       _id: null,
    //       totalEntries: { $sum: 1 },
    //       completedEntries: {
    //         $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
    //       },
    //       pendingEntries: {
    //         $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] }
    //       }
    //     }
    //   }
    // ]);
    
    const stats = [{ totalEntries: 0, completedEntries: 0, pendingEntries: 0 }];

    res.json(stats[0] || {
      totalEntries: 0,
      completedEntries: 0,
      pendingEntries: 0
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update user documents
const updateDocuments = async (req, res) => {
  try {
    const { id } = req.params;
    const files = req.files;
    const remarks = req.body;

    const updateData = {};

    // Handle profile picture
    if (files.profilePicture) {
      updateData.profilePicture = {
        path: getFileUrl(req, files.profilePicture[0]),
        remarks: remarks.profilePictureRemarks || ''
      };
    }

    // Handle documents array
    const documents = [];
    const documentTypes = ['offerLetter', 'passportCopy', 'emiratesId', 'labourCard', 'visaPage'];

    documentTypes.forEach(type => {
      if (files[type]) {
        documents.push({
          type,
          path: getFileUrl(req, files[type][0]),
          remarks: remarks[`${type}Remarks`] || '',
          uploadDate: new Date()
        });
      }
    });

    if (documents.length > 0) {
      updateData.documents = documents;
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Update documents error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Create new user
const createUser = async (req, res) => {
  try {
    const { 
      firstName, 
      lastName, 
      email, 
      phoneNumber, 
      password, 
      role, 
    } = req.body;

    const existingUser = await User.findOne({ 
      $or: [{ email }] 
    });


    if (existingUser) {
      return res.status(400).json({ 
        error: existingUser.email === email 
          ? 'Email already in use' 
          : 'Employee ID already exists' 
      });
    }



    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      firstName,
      lastName,
      email,
      phoneNumber,
      password: hashedPassword,
      role,
    });

    await user.save();
    
    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      user: userResponse,
      message: "User created successfully"
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ 
      error: error.message || "Failed to create user" 
    });
  }
};

// Get user with entries
const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate({
        path: 'entries',
        select: 'serviceId serviceName data status createdAt',
        options: { sort: { createdAt: -1 } }
      });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get all users with entry counts
const getUsers = async (req, res) => {
  try {
    const users = await User.find()
      // .select('-password')
      // .lean();
    // TODO: Re-enable once ServiceEntryData schema is created
    // Get entry counts for each user
    const usersWithStats = await Promise.all(users.map(async (user) => {
      // const entryCount = await ServiceEntryData.countDocuments({ customerId: user._id });
      // const lastEntry = await ServiceEntryData.findOne({ customerId: user._id })
      //   .sort({ createdAt: -1 })
      //   .select('createdAt');

      return {
        ...user._doc,
        entryCount: 0,
        lastEntryDate: null
      };
    }));

    res.json(usersWithStats);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update user
const updateUser = async (req, res) => {
  try {
    const { firstName, lastName, email, phoneNumber, password, role } = req.body;
    const updateData = {
      firstName,
      lastName,
      email,
      phoneNumber,
      role,

    };

    // Only hash and update password if provided
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete user
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // TODO: Re-enable once ServiceEntryData schema is created
    // Also update or delete related entries
    // await ServiceEntryData.updateMany(
    //   { customerId: user._id },
    //   { $set: { status: 'archived' } }
    // );

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get user entries
const getUserEntries = async (req, res) => {
  try {
    // TODO: Re-enable once ServiceEntryData schema is created
    // const entries = await ServiceEntryData.find({ customerId: req.params.id })
    //   .sort({ createdAt: -1 })
    //   .populate('serviceId', 'name');
    
    const entries = [];

    res.json(entries);
  } catch (error) {
    console.error('Get user entries error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get user profile with documents and compliance
const getUserProfile = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate document expiry status
    if (user.documents && user.documents.length > 0) {
      user.documents.forEach(doc => {
        if (doc.expiryDate) {
          const today = new Date();
          const expiryDate = new Date(doc.expiryDate);
          const daysRemaining = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
          
          if (daysRemaining < 0) {
            doc.status = 'expired';
          } else if (daysRemaining <= 30) {
            doc.status = 'expiring_soon';
          } else {
            doc.status = 'valid';
          }
        }
      });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update user profile
const updateUserProfile = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const { firstName, lastName, email, phoneNumber, country, company } = req.body;
    
    const updateData = {
      firstName,
      lastName,
      email,
      phoneNumber,
      country,
      company
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => 
      updateData[key] === undefined && delete updateData[key]
    );

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Update user profile error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update user documents with expiry tracking
const updateUserDocuments = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const { type, expiryDate, documentNumber, issuedBy, issuedDate } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const document = {
      type,
      path: getFileUrl(req, file),
      uploadDate: new Date(),
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
      documentNumber,
      issuedBy,
      issuedDate: issuedDate ? new Date(issuedDate) : undefined,
      status: 'valid'
    };

    // Calculate status if expiry date is provided
    if (expiryDate) {
      const daysRemaining = Math.ceil((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining < 0) {
        document.status = 'expired';
      } else if (daysRemaining <= 30) {
        document.status = 'expiring_soon';
      }
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $push: { documents: document } },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user, message: 'Document uploaded successfully' });
  } catch (error) {
    console.error('Update user documents error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get compliance status
const getComplianceStatus = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const user = await User.findById(userId).select('documents compliance business');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate expiring documents
    const expiringDocuments = [];
    const today = new Date();
    
    if (user.documents) {
      user.documents.forEach(doc => {
        if (doc.expiryDate) {
          const expiryDate = new Date(doc.expiryDate);
          const daysRemaining = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
          
          if (daysRemaining <= 30) {
            expiringDocuments.push({
              documentId: doc._id,
              documentType: doc.type,
              expiryDate: doc.expiryDate,
              daysRemaining,
              status: daysRemaining < 0 ? 'expired' : 'expiring_soon'
            });
          }
        }
      });
    }

    // Calculate compliance score
    let complianceScore = 100;
    const expiredDocs = expiringDocuments.filter(d => d.daysRemaining < 0).length;
    const expiringSoon = expiringDocuments.filter(d => d.daysRemaining >= 0 && d.daysRemaining <= 30).length;
    
    complianceScore -= (expiredDocs * 20);
    complianceScore -= (expiringSoon * 10);
    complianceScore = Math.max(0, complianceScore);

    // Update compliance data
    await User.findByIdAndUpdate(userId, {
      'compliance.score': complianceScore,
      'compliance.lastChecked': today,
      'compliance.expiringDocuments': expiringDocuments
    });

    res.json({
      complianceScore,
      expiringDocuments,
      totalDocuments: user.documents?.length || 0,
      expiredCount: expiredDocs,
      expiringSoonCount: expiringSoon,
      business: user.business || {}
    });
  } catch (error) {
    console.error('Get compliance status error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update business information
const updateBusinessInfo = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const { hasCompany, companyName, establishmentType, businessActivity, tradeLicense, establishmentCard } = req.body;
    
    const businessData = {
      hasCompany,
      companyName,
      establishmentType,
      businessActivity
    };

    if (tradeLicense) {
      businessData.tradeLicense = tradeLicense;
    }

    if (establishmentCard) {
      businessData.establishmentCard = establishmentCard;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { business: businessData } },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user, message: 'Business information updated successfully' });
  } catch (error) {
    console.error('Update business info error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete user document
const deleteUserDocument = async (req, res) => {
  try {
    const userId = req.user?.userId || req.params.id;
    const { documentId } = req.params;
    
    const user = await User.findByIdAndUpdate(
      userId,
      { $pull: { documents: { _id: documentId } } },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete user document error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// REFERRAL SYSTEM
// ═══════════════════════════════════════════════════════════════════════

// Get referral dashboard data for current user
const getReferralDashboard = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    const user = await User.findById(userId)
      .select('referralCode referralEarnings referralCount referralHistory platformCredits totalSpent')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get referred users details
    const referredUsers = await User.find({ referredBy: userId })
      .select('firstName lastName email createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        totalEarnings: user.referralEarnings || 0,
        totalReferrals: user.referralCount || 0,
        platformCredits: user.platformCredits || 0,
        totalSpent: user.totalSpent || 0,
        referralHistory: user.referralHistory || [],
        referredUsers,
      }
    });
  } catch (error) {
    console.error('Get referral dashboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Validate a referral code (public - used during signup)
const validateReferralCode = async (req, res) => {
  try {
    const { code } = req.params;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Referral code is required' });
    }

    const referrer = await User.findOne({ referralCode: code.trim(), deleted: { $ne: true } })
      .select('firstName lastName referralCode');

    if (!referrer) {
      return res.json({ success: true, data: { valid: false } });
    }

    res.json({
      success: true,
      data: {
        valid: true,
        referrerName: `${referrer.firstName} ${referrer.lastName?.[0] || ''}.`
      }
    });
  } catch (error) {
    console.error('Validate referral code error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// VIDEO REVIEW & DISCOUNT SYSTEM
// ═══════════════════════════════════════════════════════════════════════

// Submit a video review
const submitVideoReview = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    const { videoUrl, duration } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'Video URL is required' });
    }

    // Duration must be between 120-180 seconds (2-3 min)
    if (duration && (duration < 60 || duration > 300)) {
      return res.status(400).json({ success: false, message: 'Video must be between 1-5 minutes long' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if user already has a pending review
    const pendingReview = user.videoReviews?.find(r => r.status === 'pending');
    if (pendingReview) {
      return res.status(400).json({ success: false, message: 'You already have a pending video review. Please wait for it to be reviewed.' });
    }

    user.videoReviews.push({
      videoUrl,
      duration: duration || 0,
      status: 'pending',
      submittedAt: new Date()
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'Video review submitted successfully. You will receive credits once approved.',
      data: { videoReview: user.videoReviews[user.videoReviews.length - 1] }
    });
  } catch (error) {
    console.error('Submit video review error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get user's video reviews
const getVideoReviews = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    const user = await User.findById(userId).select('videoReviews platformCredits').lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      data: {
        videoReviews: user.videoReviews || [],
        platformCredits: user.platformCredits || 0
      }
    });
  } catch (error) {
    console.error('Get video reviews error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Approve video review (admin/amer only)
const approveVideoReview = async (req, res) => {
  try {
    const { userId, reviewId } = req.params;
    const { discountAmount } = req.body;
    const approverRole = req.user?.role;

    if (approverRole !== 'amer' && approverRole !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only amer officers or admins can approve reviews' });
    }

    const discount = discountAmount || 25; // Default 25 AED discount

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const review = user.videoReviews.id(reviewId);
    if (!review) {
      return res.status(404).json({ success: false, message: 'Video review not found' });
    }

    review.status = 'approved';
    review.discountAmount = discount;
    review.reviewedBy = req.user.userId || req.user._id;
    review.reviewedAt = new Date();

    // Add platform credits
    user.platformCredits = (user.platformCredits || 0) + discount;

    await user.save();

    res.json({
      success: true,
      message: `Video review approved. ${discount} AED credit added.`,
      data: { review, platformCredits: user.platformCredits }
    });
  } catch (error) {
    console.error('Approve video review error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// COMMISSION PROCESSING (called when a visa application fee is paid)
// ═══════════════════════════════════════════════════════════════════════

const processReferralCommission = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const VisaApplication = require('../../model/schema/visaApplication');

    const application = await VisaApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    const applicantUserId = application.sponsor?.userId;
    if (!applicantUserId) {
      return res.status(400).json({ success: false, message: 'No sponsor user found for this application' });
    }

    const applicant = await User.findById(applicantUserId);
    if (!applicant || !applicant.referredBy) {
      return res.json({ success: true, message: 'No referral to process', data: { commissioned: false } });
    }

    // Check if commission already paid for this application
    const referrer = await User.findById(applicant.referredBy);
    if (!referrer) {
      return res.json({ success: true, message: 'Referrer not found', data: { commissioned: false } });
    }

    const alreadyPaid = referrer.referralHistory?.some(
      h => h.applicationId?.toString() === applicationId && h.status === 'credited'
    );
    if (alreadyPaid) {
      return res.json({ success: true, message: 'Commission already paid', data: { commissioned: false } });
    }

    // 10 AED commission per application
    const commission = 10;

    // Credit referrer
    referrer.referralEarnings = (referrer.referralEarnings || 0) + commission;
    referrer.platformCredits = (referrer.platformCredits || 0) + commission;

    // Update or add referral history entry
    const historyEntry = referrer.referralHistory?.find(
      h => h.referredUserId?.toString() === applicantUserId.toString() && (!h.applicationId || h.applicationId?.toString() === applicationId)
    );

    if (historyEntry) {
      historyEntry.applicationId = applicationId;
      historyEntry.commission = commission;
      historyEntry.status = 'credited';
      historyEntry.creditedAt = new Date();
    } else {
      referrer.referralHistory.push({
        referredUserId: applicantUserId,
        referredUserName: `${applicant.firstName} ${applicant.lastName}`,
        referredUserEmail: applicant.email,
        applicationId: applicationId,
        commission: commission,
        status: 'credited',
        creditedAt: new Date(),
        createdAt: new Date()
      });
    }

    await referrer.save();

    // Update applicant's total spent
    const totalPayments = application.payments
      ?.filter(p => p.status === 'completed')
      .reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

    applicant.totalSpent = (applicant.totalSpent || 0) + totalPayments;
    await applicant.save();

    res.json({
      success: true,
      message: `${commission} AED commission credited to referrer ${referrer.firstName} ${referrer.lastName}`,
      data: { commissioned: true, commission, referrerId: referrer._id }
    });
  } catch (error) {
    console.error('Process referral commission error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};


const topUpCredits = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id || req.params.id;
    const { amount, method, reference } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.platformCredits = (user.platformCredits || 0) + Number(amount);

    if (!user.topUpHistory) user.topUpHistory = [];
    user.topUpHistory.push({
      amount: Number(amount),
      method: method || 'bank_wire',
      reference: reference || '',
      status: 'credited',
      creditedAt: new Date(),
    });

    await user.save();

    res.status(200).json({
      success: true,
      message: `AED ${amount.toLocaleString()} credited successfully`,
      data: {
        platformCredits: user.platformCredits,
        topUp: user.topUpHistory[user.topUpHistory.length - 1],
      },
    });
  } catch (error) {
    console.error('Top-up error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const ONBOARDING_BONUS_AED = 10000;
const MAX_BONUS_BACKED_ACQUISITION_AED = 500000;

const getBiddingLimit = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id || req.params.id;
    const user = await User.findById(userId).select(
      'platformCredits totalSpent topUpHistory marketplaceOnboardingBonus'
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.marketplaceOnboardingBonus) {
      user.platformCredits = (user.platformCredits || 0) + ONBOARDING_BONUS_AED;
      user.marketplaceOnboardingBonus = true;
      await user.save();
    }

    const availableLimit = (user.platformCredits || 0) - (user.totalSpent || 0);

    res.status(200).json({
      success: true,
      data: {
        platformCredits: user.platformCredits || 0,
        totalSpent: user.totalSpent || 0,
        availableLimit,
        onboardingBonusAED: ONBOARDING_BONUS_AED,
        maxAcquisitionBidAED: MAX_BONUS_BACKED_ACQUISITION_AED,
        bonusPolicyNote:
          'Qumak Cashback Bonus may be used toward qualifying acquisitions up to AED 500,000. Winning bidders may receive additional cashback per current promotion terms.',
        topUpHistory: (user.topUpHistory || []).slice(-10).reverse(),
      },
    });
  } catch (error) {
    console.error('Get bidding limit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  register,
  login,
  adminRegister,
  index,
  deleteMany,
  view,
  deleteData,
  upload,
 
  createUser,
  getUser,
  getUsers,
  updateUser,
  deleteUser,
  getUserEntries,
  getUserStats,
  updateDocuments,
  getUserProfile,
  updateUserProfile,
  updateUserDocuments,
  getComplianceStatus,
  updateBusinessInfo,
  deleteUserDocument,

  // Referral system
  getReferralDashboard,
  validateReferralCode,
  processReferralCommission,

  // Video review system
  submitVideoReview,
  getVideoReviews,
  approveVideoReview,

  // Bidding credits
  topUpCredits,
  getBiddingLimit,
};