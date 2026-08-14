const FamilyVisaLead = require("../../model/schema/familyVisaLead");

// Salary requirements by dependent type
const SALARY_REQUIREMENTS = {
  spouse: 4000,
  child: 4000,
  parent: 20000
};

// Check eligibility and create lead
exports.checkEligibility = async (req, res) => {
  try {
    const {
      fullName,
      contactMethod,
      contactValue,
      sponsorSalary,
      visaStatus,
      nationality,
      dependentType,
      numberOfDependents,
      eligibilityResult: clientResult
    } = req.body;

    // Validation
    if (!fullName || !contactValue || !sponsorSalary || !visaStatus || !dependentType) {
      return res.status(400).json({
        success: false,
        message: "Please fill in all required fields"
      });
    }

    // Server-side eligibility check
    const eligibilityResult = FamilyVisaLead.checkEligibility({
      sponsorSalary,
      visaStatus,
      nationality,
      dependentType
    });

    // Detect device type
    const userAgent = req.headers["user-agent"] || "";

    // Create lead
    const lead = await FamilyVisaLead.create({
      fullName,
      contactMethod: contactMethod || 'whatsapp',
      contactValue,
      sponsorSalary: parseInt(sponsorSalary),
      visaStatus,
      nationality,
      dependentType,
      numberOfDependents: numberOfDependents || 1,
      eligibilityResult,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent,
      source: req.body.source || 'direct'
    });

    res.status(201).json({
      success: true,
      message: eligibilityResult.eligible 
        ? "Great news! You appear eligible for family visa sponsorship." 
        : "We've recorded your inquiry. A specialist will review your case.",
      data: {
        referenceNumber: lead.referenceNumber,
        eligible: eligibilityResult.eligible,
        reasons: eligibilityResult.reasons,
        requirements: {
          minimumSalary: SALARY_REQUIREMENTS[dependentType] || 4000,
          yourSalary: parseInt(sponsorSalary),
          meetsRequirement: parseInt(sponsorSalary) >= (SALARY_REQUIREMENTS[dependentType] || 4000)
        },
        nextSteps: eligibilityResult.eligible 
          ? [
              "Prepare required documents (passport, salary certificate, tenancy contract)",
              "Our team will contact you within 24 hours",
              "Start your application process"
            ]
          : [
              "A visa specialist will review your case",
              "We'll contact you to discuss alternative options",
              "Some cases may still be eligible with additional documentation"
            ]
      }
    });
  } catch (error) {
    console.error("Check eligibility error:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "This contact has already been submitted. Our team will contact you soon."
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to check eligibility. Please try again."
    });
  }
};

// Get all leads (admin)
exports.getLeads = async (req, res) => {
  try {
    const {
      status,
      eligible,
      dependentType,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      sort = "-createdAt"
    } = req.query;

    // Build query
    const query = {};
    if (status) query.status = status;
    if (eligible !== undefined) query['eligibilityResult.eligible'] = eligible === 'true';
    if (dependentType) query.dependentType = dependentType;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    const leads = await FamilyVisaLead.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await FamilyVisaLead.countDocuments(query);

    res.status(200).json({
      success: true,
      data: leads,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Get leads error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leads"
    });
  }
};

// Get lead by ID (admin)
exports.getLead = async (req, res) => {
  try {
    const lead = await FamilyVisaLead.findById(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found"
      });
    }

    res.status(200).json({
      success: true,
      data: lead
    });
  } catch (error) {
    console.error("Get lead error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lead"
    });
  }
};

// Update lead status (admin)
exports.updateLead = async (req, res) => {
  try {
    const { status, notes } = req.body;

    const lead = await FamilyVisaLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found"
      });
    }

    if (status) lead.status = status;
    
    if (notes) {
      lead.communications.push({
        type: 'note',
        direction: 'outbound',
        content: notes,
        sentAt: new Date()
      });
    }

    await lead.save();

    res.status(200).json({
      success: true,
      message: "Lead updated successfully",
      data: lead
    });
  } catch (error) {
    console.error("Update lead error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update lead"
    });
  }
};

// Get statistics (admin)
exports.getStatistics = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);

    const thisMonth = new Date();
    thisMonth.setDate(1);

    const [
      totalLeads,
      todayLeads,
      weekLeads,
      monthLeads,
      eligibleCount,
      notEligibleCount,
      dependentTypeCounts,
      statusCounts
    ] = await Promise.all([
      FamilyVisaLead.countDocuments(),
      FamilyVisaLead.countDocuments({ createdAt: { $gte: today } }),
      FamilyVisaLead.countDocuments({ createdAt: { $gte: thisWeek } }),
      FamilyVisaLead.countDocuments({ createdAt: { $gte: thisMonth } }),
      FamilyVisaLead.countDocuments({ 'eligibilityResult.eligible': true }),
      FamilyVisaLead.countDocuments({ 'eligibilityResult.eligible': false }),
      FamilyVisaLead.aggregate([
        { $group: { _id: "$dependentType", count: { $sum: 1 } } }
      ]),
      FamilyVisaLead.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ])
    ]);

    res.status(200).json({
      success: true,
      data: {
        overview: {
          total: totalLeads,
          today: todayLeads,
          thisWeek: weekLeads,
          thisMonth: monthLeads
        },
        eligibility: {
          eligible: eligibleCount,
          notEligible: notEligibleCount,
          eligibilityRate: totalLeads > 0 ? ((eligibleCount / totalLeads) * 100).toFixed(1) : 0
        },
        byDependentType: dependentTypeCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        byStatus: statusCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error("Get statistics error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics"
    });
  }
};

// Delete lead (admin)
exports.deleteLead = async (req, res) => {
  try {
    const lead = await FamilyVisaLead.findByIdAndDelete(req.params.id);
    
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Lead deleted successfully"
    });
  } catch (error) {
    console.error("Delete lead error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete lead"
    });
  }
};

// Get salary requirements (public)
exports.getSalaryRequirements = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        requirements: SALARY_REQUIREMENTS,
        notes: {
          spouse: "Salary must be on salary certificate",
          child: "Children under 18 automatically eligible if parent qualifies",
          parent: "Additional accommodation and health insurance requirements apply"
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch requirements"
    });
  }
};

