const PopupLead = require('../../model/schema/popupLead');

/**
 * Submit a new popup lead
 * POST /api/v1/popup-leads
 */
exports.submitLead = async (req, res) => {
  try {
    const { name, phone, email, source, page, service, message } = req.body;

    // Validation
    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name and phone are required',
      });
    }

    // Check for existing lead with same phone (last 24 hours)
    const existingLead = await PopupLead.findOne({
      phone,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    if (existingLead) {
      // Update existing lead with new info if provided
      if (email) existingLead.email = email;
      if (service) existingLead.service = service;
      if (message) existingLead.message = message;
      await existingLead.save();

      return res.status(200).json({
        success: true,
        message: 'Lead already exists',
        data: existingLead,
      });
    }

    // Create new lead
    const lead = await PopupLead.create({
      name,
      phone,
      email: email || '',
      source: source || 'welcome_popup',
      page: page || '/',
      service: service || null,
      message: message || '',
    });

    res.status(201).json({
      success: true,
      message: 'Lead captured successfully',
      data: lead,
    });
  } catch (error) {
    console.error('Popup lead error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save lead',
      error: error.message,
    });
  }
};

/**
 * Update lead with selected service
 * POST /api/v1/popup-leads/update-service
 */
exports.updateService = async (req, res) => {
  try {
    const { phone, service } = req.body;

    if (!phone || !service) {
      return res.status(400).json({
        success: false,
        message: 'Phone and service are required',
      });
    }

    const lead = await PopupLead.findOneAndUpdate(
      { phone },
      { service },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Service updated',
      data: lead,
    });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update service',
      error: error.message,
    });
  }
};

/**
 * Get all popup leads (admin)
 * GET /api/v1/popup-leads
 */
exports.getLeads = async (req, res) => {
  try {
    const { status, service, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (service) filter.service = service;

    const leads = await PopupLead.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('assignedTo', 'name email');

    const total = await PopupLead.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leads',
      error: error.message,
    });
  }
};

/**
 * Get popup leads stats
 * GET /api/v1/popup-leads/stats
 */
exports.getStats = async (req, res) => {
  try {
    const [total, newLeads, businessSetup, visaInquiry] = await Promise.all([
      PopupLead.countDocuments(),
      PopupLead.countDocuments({ status: 'new' }),
      PopupLead.countDocuments({ service: 'business-setup' }),
      PopupLead.countDocuments({ service: 'visa-inquiry' }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total,
        new: newLeads,
        businessSetup,
        visaInquiry,
      },
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stats',
      error: error.message,
    });
  }
};

/**
 * Update lead status
 * PUT /api/v1/popup-leads/:id
 */
exports.updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, assignedTo } = req.body;

    const lead = await PopupLead.findByIdAndUpdate(
      id,
      { status, notes, assignedTo },
      { new: true }
    ).populate('assignedTo', 'name email');

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found',
      });
    }

    res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update lead',
      error: error.message,
    });
  }
};

/**
 * Delete lead
 * DELETE /api/v1/popup-leads/:id
 */
exports.deleteLead = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await PopupLead.findByIdAndDelete(id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Lead deleted',
    });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete lead',
      error: error.message,
    });
  }
};

