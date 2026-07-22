const Job = require('../../model/schema/job');
const JobApplication = require('../../model/schema/jobApplication');
const User = require('../../model/schema/user');

// ==================== PUBLIC ENDPOINTS ====================

/**
 * GET /jobs - List all active jobs with filters
 */
const getJobs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 12,
      category,
      emirate,
      type,
      experienceLevel,
      search,
      sort = 'newest',
      visaSponsorship,
      featured
    } = req.query;

    const filter = { isActive: true };

    if (category) filter.category = category;
    if (emirate) filter.emirate = emirate;
    if (type) filter.type = type;
    if (experienceLevel) filter.experienceLevel = experienceLevel;
    if (visaSponsorship === 'true') filter.visaSponsorship = true;
    if (featured === 'true') filter.isFeatured = true;

    // Text search
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } }
      ];
    }

    // Check deadline
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { applicationDeadline: { $exists: false } },
        { applicationDeadline: null },
        { applicationDeadline: { $gte: new Date() } }
      ]
    });

    // Sort options
    let sortOption = {};
    switch (sort) {
      case 'newest': sortOption = { createdAt: -1 }; break;
      case 'oldest': sortOption = { createdAt: 1 }; break;
      case 'salary_high': sortOption = { 'salaryRange.max': -1 }; break;
      case 'salary_low': sortOption = { 'salaryRange.min': 1 }; break;
      case 'most_applied': sortOption = { applicationsCount: -1 }; break;
      default: sortOption = { isFeatured: -1, createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Job.countDocuments(filter);
    const jobs = await Job.find()
    //   .sort(sortOption)
    //   .skip(skip)
    //   .limit(parseInt(limit))
    //       .select('-contactEmail -contactPhone')
    //       .lean();
console.log(jobs);
    res.json({
      success: true,
      data: {
        jobs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch jobs' });
  }
};

/**
 * GET /jobs/:id - Get single job details
 */
const getJobById = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('postedBy', 'firstName lastName')
      .lean();

    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // Increment views
    await Job.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json({ success: true, data: { job } });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch job details' });
  }
};

/**
 * GET /jobs/categories/stats - Get job counts per category
 */
const getCategoryStats = async (req, res) => {
  try {
    const stats = await Job.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const totalActive = await Job.countDocuments({ isActive: true });

    res.json({
      success: true,
      data: { categories: stats, totalActive }
    });
  } catch (error) {
    console.error('Error fetching category stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch category stats' });
  }
};

// ==================== AUTHENTICATED ENDPOINTS ====================

/**
 * POST /jobs/apply - Apply to a job
 */
const applyToJob = async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const {
      jobId,
      coverLetter,
      yearsOfExperience,
      currentSalary,
      expectedSalary,
      noticePeriod,
      visaStatus,
      paymentMethod
    } = req.body;

    // Validate job exists and is active
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    if (!job.isActive) {
      return res.status(400).json({ success: false, message: 'This job is no longer accepting applications' });
    }
    if (job.applicationDeadline && new Date(job.applicationDeadline) < new Date()) {
      return res.status(400).json({ success: false, message: 'Application deadline has passed' });
    }

    // Check for existing application
    const existingApp = await JobApplication.findOne({ job: jobId, applicant: userId });
    if (existingApp) {
      return res.status(400).json({ success: false, message: 'You have already applied to this job' });
    }

    // Fetch user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Build payment info
    let paymentInfo = { status: 'not_required', amount: 0 };
    if (job.applicationFee > 0) {
      if (paymentMethod === 'pay_later') {
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + 7); // 7 days to pay
        paymentInfo = {
          status: 'pay_later',
          amount: job.applicationFee,
          method: 'pay_later',
          payLaterDeadline: deadline
        };
      } else {
        // For now, simulate payment completion (integrate real payment gateway here)
        paymentInfo = {
          status: 'completed',
          amount: job.applicationFee,
          method: paymentMethod || 'card',
          transactionId: `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          paidAt: new Date()
        };
      }
    }

    const application = new JobApplication({
      job: jobId,
      applicant: userId,
      applicantDetails: {
        fullName: `${user.firstName} ${user.lastName || ''}`.trim(),
        email: user.email,
        phone: user.phoneNumber,
        nationality: user.country,
        currentLocation: user.country || 'UAE'
      },
      coverLetter,
      yearsOfExperience,
      currentSalary,
      expectedSalary,
      noticePeriod: noticePeriod || '1_month',
      visaStatus: visaStatus || 'no_visa',
      payment: paymentInfo,
      statusHistory: [{
        status: 'pending',
        changedAt: new Date(),
        reason: 'Application submitted'
      }]
    });

    await application.save();

    // Increment applications count on the job
    await Job.findByIdAndUpdate(jobId, { $inc: { applicationsCount: 1 } });

    res.status(201).json({
      success: true,
      message: 'Application submitted successfully',
      data: {
        application: {
          _id: application._id,
          status: application.status,
          payment: application.payment
        }
      }
    });
  } catch (error) {
    console.error('Error applying to job:', error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'You have already applied to this job' });
    }
    res.status(500).json({ success: false, message: 'Failed to submit application' });
  }
};

/**
 * GET /jobs/my-applications - Get current user's applications
 */
const getMyApplications = async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const { page = 1, limit = 10, status } = req.query;

    const filter = { applicant: userId };
    if (status && status !== 'all') filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await JobApplication.countDocuments(filter);
    const applications = await JobApplication.find(filter)
      .populate('job', 'title company location type salaryRange')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: {
        applications,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications' });
  }
};

/**
 * POST /jobs/pay-later/:applicationId - Complete pay later payment
 */
const completePayLaterPayment = async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const { applicationId } = req.params;
    const { paymentMethod } = req.body;

    const application = await JobApplication.findOne({
      _id: applicationId,
      applicant: userId,
      'payment.status': 'pay_later'
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found or payment not pending' });
    }

    if (application.payment.payLaterDeadline && new Date(application.payment.payLaterDeadline) < new Date()) {
      return res.status(400).json({ success: false, message: 'Pay later deadline has expired' });
    }

    // Simulate payment (integrate real payment gateway here)
    application.payment.status = 'completed';
    application.payment.method = paymentMethod || 'card';
    application.payment.transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    application.payment.paidAt = new Date();
    await application.save();

    res.json({
      success: true,
      message: 'Payment completed successfully',
      data: { payment: application.payment }
    });
  } catch (error) {
    console.error('Error completing payment:', error);
    res.status(500).json({ success: false, message: 'Failed to complete payment' });
  }
};

// ==================== ADMIN/AMER ENDPOINTS ====================

/**
 * POST /jobs/admin/create - Create a new job posting (admin only)
 */
const createJob = async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const {
      title, company, location, emirate, type, category, description,
      requirements, responsibilities, salaryRange, benefits, visaSponsorship,
      experienceLevel, applicationFee, applicationDeadline, isFeatured,
      tags, contactEmail, contactPhone
    } = req.body;

    const job = new Job({
      title,
      company,
      location,
      emirate,
      type,
      category,
      description,
      requirements: requirements || [],
      responsibilities: responsibilities || [],
      salaryRange: salaryRange || {},
      benefits: benefits || [],
      visaSponsorship: visaSponsorship || false,
      experienceLevel,
      applicationFee: applicationFee || 0,
      applicationDeadline: applicationDeadline || null,
      isFeatured: isFeatured || false,
      postedBy: userId,
      tags: tags || [],
      contactEmail,
      contactPhone
    });

    await job.save();

    res.status(201).json({
      success: true,
      message: 'Job posted successfully',
      data: { job }
    });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ success: false, message: 'Failed to create job posting' });
  }
};

/**
 * PATCH /jobs/admin/:id - Update a job posting (admin only)
 */
const updateJob = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Don't allow changing postedBy
    delete updates.postedBy;

    const job = await Job.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    res.json({
      success: true,
      message: 'Job updated successfully',
      data: { job }
    });
  } catch (error) {
    console.error('Error updating job:', error);
    res.status(500).json({ success: false, message: 'Failed to update job' });
  }
};

/**
 * DELETE /jobs/admin/:id - Deactivate a job posting (admin only)
 */
const deactivateJob = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    res.json({
      success: true,
      message: 'Job deactivated successfully',
      data: { job }
    });
  } catch (error) {
    console.error('Error deactivating job:', error);
    res.status(500).json({ success: false, message: 'Failed to deactivate job' });
  }
};

/**
 * DELETE /jobs/admin/:id/delete - Permanently delete a job posting (admin only)
 */
const deleteJob = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findByIdAndDelete(id);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // Also delete all associated applications
    await JobApplication.deleteMany({ job: id });

    res.json({
      success: true,
      message: 'Job deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting job:', error);
    res.status(500).json({ success: false, message: 'Failed to delete job' });
  }
};

/**
 * DELETE /jobs/admin/applications/:applicationId - Delete a job application (admin only)
 */
const deleteJobApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const application = await JobApplication.findByIdAndDelete(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    // Remove application reference from job
    await Job.updateOne(
      { _id: application.job },
      { $pull: { applicants: applicationId } }
    );

    res.json({
      success: true,
      message: 'Application deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting application:', error);
    res.status(500).json({ success: false, message: 'Failed to delete application' });
  }
};

/**
 * GET /jobs/admin/all - Get all jobs including inactive (admin only)
 */
const getAllJobsAdmin = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter = {};
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Job.countDocuments(filter);
    const jobs = await Job.find(filter)
      .populate('postedBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: {
        jobs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching all jobs (admin):', error);
    res.status(500).json({ success: false, message: 'Failed to fetch jobs' });
  }
};

/**
 * GET /jobs/admin/applications/:jobId - Get applications for a specific job (admin only)
 * GET /jobs/applications/all - Get all applications (admin only)
 */
const getJobApplications = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { page = 1, limit = 20, status } = req.query;

    const filter = {};
    if (jobId && jobId !== 'all') {
      filter.job = jobId;
    }
    if (status && status !== 'all') filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await JobApplication.countDocuments(filter);
    const applications = await JobApplication.find(filter)
      .populate('applicant', 'firstName lastName email phoneNumber')
      .populate('job', 'title company location')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: applications || []
    });
  } catch (error) {
    console.error('Error fetching job applications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications' });
  }
};

/**
 * PATCH /jobs/admin/applications/:applicationId/status - Update application status (admin only)
 */
const updateApplicationStatus = async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const { applicationId } = req.params;
    const { status, reason } = req.body;

    const validStatuses = ['pending', 'reviewing', 'shortlisted', 'interview', 'offered', 'hired', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const application = await JobApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    application.status = status;
    application.statusHistory.push({
      status,
      changedBy: userId,
      changedAt: new Date(),
      reason: reason || ''
    });

    await application.save();

    res.json({
      success: true,
      message: 'Application status updated',
      data: { application }
    });
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ success: false, message: 'Failed to update application status' });
  }
};

/**
 * GET /jobs/admin/statistics - Dashboard statistics (admin only)
 */
const getJobStatistics = async (req, res) => {
  try {
    const totalJobs = await Job.countDocuments();
    const activeJobs = await Job.countDocuments({ isActive: true });
    const totalApplications = await JobApplication.countDocuments();
    const pendingApplications = await JobApplication.countDocuments({ status: 'pending' });
    const hiredCount = await JobApplication.countDocuments({ status: 'hired' });

    const applicationsByStatus = await JobApplication.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const jobsByCategory = await Job.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const recentApplications = await JobApplication.find()
      .populate('job', 'title company')
      .populate('applicant', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    res.json({
      success: true,
      data: {
        overview: {
          totalJobs,
          activeJobs,
          totalApplications,
          pendingApplications,
          hiredCount
        },
        applicationsByStatus,
        jobsByCategory,
        recentApplications
      }
    });
  } catch (error) {
    console.error('Error fetching job statistics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
  }
};

module.exports = {
  // Public
  getJobs,
  getJobById,
  getCategoryStats,
  // Authenticated
  applyToJob,
  getMyApplications,
  completePayLaterPayment,
  // Admin
  createJob,
  updateJob,
  deactivateJob,
  deleteJob,
  getAllJobsAdmin,
  getJobApplications,
  updateApplicationStatus,
  deleteJobApplication,
  getJobStatistics
};

