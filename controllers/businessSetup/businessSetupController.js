const BusinessSetupLead = require("../../model/schema/businessSetupLead");
const { sendMail } = require("../../utills/sendGridEmail");
const { triggerNewBusinessLead, triggerLeadStatusChange } = require("../../utills/n8nWebhook");

// Business activity categories with descriptions
const BUSINESS_ACTIVITIES = {
  GENERAL_TRADING: {
    name: "General Trading",
    description: "Import, export, and trade of various goods",
    popularIn: ["mainland", "freezone"],
    minBudget: 15000,
  },
  CONSULTANCY: {
    name: "Consultancy",
    description: "Business, management, and professional consulting services",
    popularIn: ["freezone", "mainland"],
    minBudget: 8000,
  },
  IT_SERVICES: {
    name: "IT & Technology Services",
    description: "Software development, IT support, and tech solutions",
    popularIn: ["freezone", "mainland"],
    minBudget: 10000,
  },
  E_COMMERCE: {
    name: "E-Commerce",
    description: "Online retail and digital marketplace businesses",
    popularIn: ["freezone"],
    minBudget: 7500,
  },
  FOOD_BEVERAGE: {
    name: "Food & Beverage",
    description: "Restaurants, cafes, catering, and food trading",
    popularIn: ["mainland"],
    minBudget: 25000,
  },
  HEALTHCARE: {
    name: "Healthcare Services",
    description: "Medical clinics, wellness centers, and healthcare consulting",
    popularIn: ["mainland", "freezone"],
    minBudget: 50000,
  },
  EDUCATION: {
    name: "Education & Training",
    description: "Training centers, educational consulting, and tutoring",
    popularIn: ["mainland", "freezone"],
    minBudget: 20000,
  },
  REAL_ESTATE: {
    name: "Real Estate",
    description: "Property management, brokerage, and development",
    popularIn: ["mainland"],
    minBudget: 30000,
  },
  CONSTRUCTION: {
    name: "Construction",
    description: "Building, contracting, and construction services",
    popularIn: ["mainland"],
    minBudget: 50000,
  },
  MANUFACTURING: {
    name: "Manufacturing",
    description: "Production and manufacturing of goods",
    popularIn: ["freezone", "mainland"],
    minBudget: 75000,
  },
  LOGISTICS: {
    name: "Logistics & Transportation",
    description: "Freight, shipping, and logistics services",
    popularIn: ["freezone", "mainland"],
    minBudget: 30000,
  },
  MEDIA_MARKETING: {
    name: "Media & Marketing",
    description: "Advertising, digital marketing, and media production",
    popularIn: ["freezone", "mainland"],
    minBudget: 10000,
  },
  TOURISM_HOSPITALITY: {
    name: "Tourism & Hospitality",
    description: "Travel agencies, hotels, and tourism services",
    popularIn: ["mainland"],
    minBudget: 25000,
  },
  PROFESSIONAL_SERVICES: {
    name: "Professional Services",
    description: "Legal, accounting, and professional consulting",
    popularIn: ["freezone", "mainland"],
    minBudget: 15000,
  },
  RETAIL: {
    name: "Retail",
    description: "Shops, stores, and retail trading",
    popularIn: ["mainland"],
    minBudget: 20000,
  },
};

// Freezone information
const FREEZONES = {
  RAKEZ: {
    name: "Ras Al Khaimah Economic Zone",
    shortName: "RAKEZ",
    emirate: "Ras Al Khaimah",
    startingFrom: 5750,
    benefits: ["100% ownership", "No corporate tax", "Easy setup", "Low cost"],
    visaCost: 3000,
    processingTime: "3-5 days",
  },
  AJMAN_FREEZONE: {
    name: "Ajman Free Zone",
    shortName: "AFZ",
    emirate: "Ajman",
    startingFrom: 6500,
    benefits: ["100% ownership", "Strategic location", "Cost effective"],
    visaCost: 3200,
    processingTime: "3-5 days",
  },
  MEYDAN_FREEZONE: {
    name: "Meydan Free Zone",
    shortName: "MFZ",
    emirate: "Dubai",
    startingFrom: 12000,
    benefits: ["Dubai address", "Premium facilities", "Fast processing"],
    visaCost: 3500,
    processingTime: "2-3 days",
  },
  IFZA: {
    name: "International Free Zone Authority",
    shortName: "IFZA",
    emirate: "Dubai",
    startingFrom: 11750,
    benefits: ["Multiple activities", "Flexible packages", "Dubai location"],
    visaCost: 3500,
    processingTime: "2-3 days",
  },
  JAFZA: {
    name: "Jebel Ali Free Zone",
    shortName: "JAFZA",
    emirate: "Dubai",
    startingFrom: 15000,
    benefits: [
      "World-class infrastructure",
      "Port access",
      "Manufacturing hub",
    ],
    visaCost: 4000,
    processingTime: "5-7 days",
  },
  DIFC: {
    name: "Dubai International Financial Centre",
    shortName: "DIFC",
    emirate: "Dubai",
    startingFrom: 50000,
    benefits: ["Financial hub", "Common law", "Premium address"],
    visaCost: 5000,
    processingTime: "7-10 days",
  },
  DMCC: {
    name: "Dubai Multi Commodities Centre",
    shortName: "DMCC",
    emirate: "Dubai",
    startingFrom: 18000,
    benefits: ["JLT location", "Trading hub", "Networking"],
    visaCost: 4500,
    processingTime: "5-7 days",
  },
  ADGM: {
    name: "Abu Dhabi Global Market",
    shortName: "ADGM",
    emirate: "Abu Dhabi",
    startingFrom: 45000,
    benefits: ["International hub", "Common law", "Financial services"],
    visaCost: 5000,
    processingTime: "7-10 days",
  },
  SHAMS: {
    name: "Sharjah Media City",
    shortName: "SHAMS",
    emirate: "Sharjah",
    startingFrom: 5750,
    benefits: ["Media focus", "Low cost", "Quick setup"],
    visaCost: 3000,
    processingTime: "3-5 days",
  },
  DAFZA: {
    name: "Dubai Airport Free Zone",
    shortName: "DAFZA",
    emirate: "Dubai",
    startingFrom: 12000,
    benefits: ["Airport access", "Logistics hub", "Trade facilitation"],
    visaCost: 3500,
    processingTime: "5-7 days",
  },
  SAIF_ZONE: {
    name: "Sharjah Airport International Free Zone",
    shortName: "SAIF Zone",
    emirate: "Sharjah",
    startingFrom: 7500,
    benefits: ["Cost effective", "Airport proximity", "Industrial options"],
    visaCost: 3200,
    processingTime: "3-5 days",
  },
};

// Get business activities list
exports.getBusinessActivities = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: BUSINESS_ACTIVITIES,
    });
  } catch (error) {
    console.error("Get business activities error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch business activities",
    });
  }
};

// Get freezones list
exports.getFreezones = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: FREEZONES,
    });
  } catch (error) {
    console.error("Get freezones error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch freezones",
    });
  }
};

// Calculate cost estimate
exports.calculateCost = async (req, res) => {
  try {
    const {
      setupType,
      freezone,
      visaCount,
      officeRequired,
      businessActivityCategory,
    } = req.body;

    if (!setupType) {
      return res.status(400).json({
        success: false,
        message: "Setup type is required",
      });
    }

    const estimatedCost = BusinessSetupLead.calculateEstimatedCost({
      setupType,
      freezone,
      visaCount: visaCount || 0,
      officeRequired: officeRequired || "none",
    });

    // Get freezone details if applicable
    let freezoneDetails = null;
    if (setupType === "freezone" && freezone && FREEZONES[freezone]) {
      freezoneDetails = FREEZONES[freezone];
    }

    res.status(200).json({
      success: true,
      data: {
        estimatedCost,
        freezoneDetails,
        breakdown: {
          licenseFee: {
            amount: estimatedCost.licenseFee,
            description: "Trade license fee",
          },
          visaCost: {
            amount: estimatedCost.visaCost,
            description: `Visa cost for ${visaCount || 0} visa(s)`,
            perVisa: estimatedCost.visaCost / (visaCount || 1),
          },
          officeCost: {
            amount: estimatedCost.officeCost,
            description: `Office/workspace (${officeRequired || "none"})`,
          },
          governmentFees: {
            amount: estimatedCost.governmentFees,
            description: "Government and registration fees",
          },
        },
        note: "This is an estimate. Actual costs may vary based on specific requirements.",
      },
    });
  } catch (error) {
    console.error("Calculate cost error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to calculate cost estimate",
    });
  }
};

// Submit lite lead (minimal data from landing page)
exports.submitLiteLead = async (req, res) => {
  try {
    const {
      firstName,
      phoneNumber,
      countryCode,
      businessActivity,
      setupType,
      source,
      landingPage,
      utmSource,
      utmMedium,
      utmCampaign,
    } = req.body;

    // Minimal validation
    if (!firstName || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Name and phone number are required",
      });
    }

    // Detect device type
    const userAgent = req.headers["user-agent"] || "";
    let deviceType = "desktop";
    if (/mobile/i.test(userAgent)) {
      deviceType = "mobile";
    } else if (/tablet|ipad/i.test(userAgent)) {
      deviceType = "tablet";
    }

    // Create lite lead with minimal required fields
    const lead = await BusinessSetupLead.create({
      fullName: firstName,
      email: `pending_${Date.now()}@lite-lead.temp`, // Placeholder - will be updated later
      phoneNumber,
      countryCode: countryCode || "+971",
      setupType: setupType || "freezone",
      businessActivity: businessActivity || "General",
      budgetRange: "4999_13000", // Default starter range for lite leads
      priority: "high", // Lite leads from landing page are hot
      source: source || "landing_page_lite",
      landingPage,
      utmSource,
      utmMedium,
      utmCampaign,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent,
      deviceType,
      termsAccepted: true, // Implied by submission
      privacyAccepted: true, // Implied by submission
      isLiteLead: true, // Flag for lite leads
    });

    // Send WhatsApp notification to admin (async)
    sendLiteLeadNotification(lead).catch((err) => {
      console.error("Lite lead notification error:", err);
    });

    console.log("[Lite Lead] Captured:", lead.leadNumber, firstName, phoneNumber);

    res.status(201).json({
      success: true,
      message: "We'll WhatsApp you shortly with your personalized quote!",
      data: {
        leadNumber: lead.leadNumber,
        estimatedCallback: "2 hours",
      },
    });
  } catch (error) {
    console.error("Submit lite lead error:", error);

    // Handle duplicate phone
    if (error.code === 11000) {
      return res.status(200).json({
        success: true,
        message: "We already have your details. Our team will contact you shortly.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};

// Send lite lead notification helper
async function sendLiteLeadNotification(lead) {
  const adminWhatsApp = process.env.ADMIN_WHATSAPP || "+971569048493";
  
  // Format the activity nicely
  const activityMap = {
    trading: "Trading & E-commerce",
    consulting: "Consulting & Services",
    tech: "Tech & Software",
    media: "Media & Marketing",
    other: "Other",
  };

  console.log(`[Lite Lead Notification] New lead from landing page:
    Lead #: ${lead.leadNumber}
    Name: ${lead.fullName}
    Phone: ${lead.countryCode}${lead.phoneNumber}
    Activity: ${activityMap[lead.businessActivity] || lead.businessActivity}
    Setup: ${lead.setupType === "mainland" ? "Mainland" : "Free Zone"}
    Source: ${lead.source}
  `);

  // Mark notification sent
  lead.notifications = lead.notifications || {};
  lead.notifications.adminNotified = true;
  lead.notifications.adminNotifiedAt = new Date();
  await lead.save();
}

// Submit lead
exports.submitLead = async (req, res) => {
  try {
    const {
      fullName,
      email,
      phoneNumber,
      countryCode,
      nationality,
      setupType,
      freezone,
      businessActivity,
      businessActivityCategory,
      businessDescription,
      visaCount,
      budgetRange,
      officeRequired,
      urgency,
      additionalServices,
      marketingConsent,
      termsAccepted,
      privacyAccepted,
      source,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      landingPage,
      referrer,
    } = req.body;

    // Validation
    if (!fullName || !setupType || !businessActivity || !budgetRange) {
      return res.status(400).json({
        success: false,
        message: "Please fill in all required fields",
      });
    }

    if (!termsAccepted || !privacyAccepted) {
      return res.status(400).json({
        success: false,
        message: "Please accept terms and privacy policy",
      });
    }

    // Calculate estimated cost
    const estimatedCost = BusinessSetupLead.calculateEstimatedCost({
      setupType,
      freezone,
      visaCount: visaCount || 0,
      officeRequired: officeRequired || "none",
    });

    // Determine priority based on budget and urgency
    let priority = "medium";
    if (budgetRange === "30000_plus" || urgency === "immediate") {
      priority = "high";
    } else if (urgency === "within_week") {
      priority = "medium";
    }

    // Detect device type from user agent
    const userAgent = req.headers["user-agent"] || "";
    let deviceType = "desktop";
    if (/mobile/i.test(userAgent)) {
      deviceType = "mobile";
    } else if (/tablet|ipad/i.test(userAgent)) {
      deviceType = "tablet";
    }

    // Create lead
    const lead = await BusinessSetupLead.create({
      fullName,
      email: email.toLowerCase(),
      phoneNumber,
      countryCode: countryCode || "+971",
      nationality,
      setupType,
      freezone: setupType === "freezone" ? freezone : undefined,
      businessActivity,
      businessActivityCategory,
      businessDescription,
      visaCount: visaCount || 0,
      budgetRange,
      officeRequired: officeRequired || "none",
      urgency: urgency || "exploring",
      additionalServices: additionalServices || [],
      estimatedCost,
      priority,
      marketingConsent: marketingConsent || false,
      termsAccepted,
      privacyAccepted,
      source: source || "direct",
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      landingPage,
      referrer,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent,
      deviceType,
    });

    // Send notifications (async - don't wait)
    sendNotifications(lead).catch((err) => {
      console.error("Notification error:", err);
    });

    console.log("lead: ", lead);
    res.status(201).json({
      success: true,
      message: "Thank you! Our team will contact you shortly.",
      data: {
        leadNumber: lead.leadNumber,
        estimatedCost: lead.estimatedCost,
        expectedCallback: "24 hours",
      },
    });
  } catch (error) {
    console.error("Submit lead error:", error);

    // Handle duplicate email
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          "This email has already been submitted. Our team will contact you soon.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to submit your request. Please try again.",
    });
  }
};

// Send notifications helper
async function sendNotifications(lead) {
  const adminEmail = process.env.ADMIN_EMAIL || "sales@qumak.ae";
  const adminWhatsApp = process.env.ADMIN_WHATSAPP || "+971569048493";

  // Format budget range for display
  const budgetRangeMap = {
    "4999_13000": "AED 4,999 - 13,000",
    "13999_18999": "AED 13,999 - 18,999",
    "25000_30000": "AED 25,000 - 30,000",
    "30000_plus": "AED 30,000+",
  };

  const freezoneNames = {
    RAKEZ: "RAKEZ (Ras Al Khaimah)",
    AJMAN_FREEZONE: "Ajman Free Zone",
    MEYDAN_FREEZONE: "Meydan Free Zone",
    IFZA: "IFZA Dubai",
    JAFZA: "Jebel Ali Free Zone",
    DIFC: "DIFC",
    DMCC: "DMCC",
    ADGM: "ADGM Abu Dhabi",
    SHAMS: "Sharjah Media City",
    DAFZA: "Dubai Airport Free Zone",
    SAIF_ZONE: "SAIF Zone",
  };

  // 1. Send email to admin (internal notification)
  try {
    // await sendMail({
    //   to: adminEmail,
    //   subject: `🔥 New Business Setup Lead - ${lead.leadNumber}`,
    //   template_id: process.env.SENDGRID_ADMIN_LEAD_TEMPLATE_ID,
    //   dynamic_data: {
    //     leadNumber: lead.leadNumber,
    //     fullName: lead.fullName,
    //     email: lead.email,
    //     phone: `${lead.countryCode}${lead.phoneNumber}`,
    //     nationality: lead.nationality,
    //     setupType: lead.setupType === "mainland" ? "UAE Mainland" : "Free Zone",
    //     freezone: lead.freezone
    //       ? freezoneNames[lead.freezone] || lead.freezone
    //       : "N/A",
    //     businessActivity: lead.businessActivity,
    //     visaCount: lead.visaCount,
    //     budgetRange: budgetRangeMap[lead.budgetRange] || lead.budgetRange,
    //     urgency: lead.urgency,
    //     estimatedTotal: `AED ${lead.estimatedCost.totalEstimate.toLocaleString()}`,
    //     source: lead.source,
    //     submittedAt: new Date().toLocaleString("en-AE", {
    //       timeZone: "Asia/Dubai",
    //     }),
    //   },
    // });

    lead.notifications.adminNotified = true;
    lead.notifications.adminNotifiedAt = new Date();
  } catch (err) {
    console.error("Admin email notification failed:", err);
  }

  // 2. Send confirmation email to customer
  try {
    // await sendMail({
    //   to: lead.email,
    //   subject: `Your Business Setup Quote Request - ${lead.leadNumber}`,
    //   template_id: process.env.SENDGRID_CUSTOMER_LEAD_TEMPLATE_ID,
    //   dynamic_data: {
    //     firstName: lead.fullName.split(" ")[0],
    //     leadNumber: lead.leadNumber,
    //     setupType:
    //       lead.setupType === "mainland"
    //         ? "UAE Mainland License"
    //         : "Free Zone License",
    //     freezone: lead.freezone
    //       ? freezoneNames[lead.freezone] || lead.freezone
    //       : null,
    //     businessActivity: lead.businessActivity,
    //     estimatedCost: {
    //       license: `AED ${lead.estimatedCost.licenseFee.toLocaleString()}`,
    //       visa: `AED ${lead.estimatedCost.visaCost.toLocaleString()}`,
    //       office: `AED ${lead.estimatedCost.officeCost.toLocaleString()}`,
    //       govFees: `AED ${lead.estimatedCost.governmentFees.toLocaleString()}`,
    //       total: `AED ${lead.estimatedCost.totalEstimate.toLocaleString()}`,
    //     },
    //     visaCount: lead.visaCount,
    //     nextSteps: [
    //       "Our business setup specialist will call you within 24 hours",
    //       "We'll send you a detailed quotation via email",
    //       "Schedule a free consultation to discuss your requirements",
    //     ],
    //     supportEmail: "support@qumak.ae",
    //     supportPhone: "+971 4 XXX XXXX",
    //     currentYear: new Date().getFullYear(),
    //   },
    // });

    lead.notifications.emailSent = true;
    lead.notifications.emailSentAt = new Date();

    // Log communication
    lead.communications.push({
      type: "email",
      direction: "outbound",
      subject: "Business Setup Quote Confirmation",
      content: `Confirmation email sent for lead ${lead.leadNumber}`,
      status: "sent",
    });
  } catch (err) {
    console.error("Customer email notification failed:", err);
  }

  // 3. Send WhatsApp to admin (if configured)
//   if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
//     try {
//       const twilioClient = require("twilio")(
//         process.env.TWILIO_ACCOUNT_SID,
//         process.env.TWILIO_AUTH_TOKEN
//       );

//       const whatsappMessage = `🔔 *New Business Setup Lead*

// 📋 *Lead #:* ${lead.leadNumber}
// 👤 *Name:* ${lead.fullName}
// 📧 *Email:* ${lead.email}
// 📱 *Phone:* ${lead.countryCode}${lead.phoneNumber}
// 🌍 *Nationality:* ${lead.nationality}

// 🏢 *Setup Type:* ${lead.setupType === "mainland" ? "Mainland" : "Free Zone"}
// ${
//   lead.freezone
//     ? `📍 *Free Zone:* ${freezoneNames[lead.freezone] || lead.freezone}`
//     : ""
// }
// 💼 *Activity:* ${lead.businessActivity}
// 👥 *Visas:* ${lead.visaCount}
// 💰 *Budget:* ${budgetRangeMap[lead.budgetRange]}

// 📊 *Estimated Total:* AED ${lead.estimatedCost.totalEstimate.toLocaleString()}
// ⏰ *Urgency:* ${lead.urgency}

// 🔗 *Source:* ${lead.source}`;

//       await twilioClient.messages.create({
//         body: whatsappMessage,
//         from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
//         to: `whatsapp:${adminWhatsApp}`,
//       });

//       lead.notifications.whatsappSent = true;
//       lead.notifications.whatsappSentAt = new Date();
//     } catch (err) {
//       console.error("WhatsApp notification failed:", err);
//     }
//   }

  // 4. Trigger n8n webhook for additional automations
  // n8n can handle: WhatsApp via Meta Cloud API, Google Sheets, Slack, Calendar, OpenAI, etc.
//   try {
//     const n8nResult = await triggerNewBusinessLead(lead);
//     if (n8nResult.success) {
//       console.log("[n8n] Webhook triggered successfully for lead:", lead.leadNumber);
//       lead.notifications.n8nTriggered = true;
//       lead.notifications.n8nTriggeredAt = new Date();
//     } else if (!n8nResult.skipped) {
//       console.warn("[n8n] Webhook failed:", n8nResult.error);
//     }
//   } catch (err) {
//     console.error("[n8n] Webhook error:", err.message);
//   }

  // Save notification status
  await lead.save();
}

// Get lead by ID (for admin)
exports.getLead = async (req, res) => {
  try {
    const lead = await BusinessSetupLead.findById(req.params.id)
      .populate("assignedTo", "firstName lastName email")
      .populate("communications.sentBy", "firstName lastName");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    console.error("Get lead error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lead",
    });
  }
};

// Get all leads (for admin)
exports.getLeads = async (req, res) => {
  try {
    const {
      status,
      setupType,
      source,
      priority,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      sort = "-createdAt",
    } = req.query;

    // Build query
    const query = {};
    if (status) query.status = status;
    if (setupType) query.setupType = setupType;
    if (source) query.source = source;
    if (priority) query.priority = priority;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    const leads = await BusinessSetupLead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await BusinessSetupLead.countDocuments(query);

    res.status(200).json({
      success: true,
      data: leads,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get leads error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leads",
    });
  }
};

// Update lead status (for admin)
exports.updateLead = async (req, res) => {
  try {
    const { status, priority, assignedTo, internalNotes } = req.body;

    const lead = await BusinessSetupLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Track status change for n8n webhook
    const oldStatus = lead.status;
    const statusChanged = status && status !== oldStatus;

    if (status) lead.status = status;
    if (priority) lead.priority = priority;
    if (assignedTo) lead.assignedTo = assignedTo;
    if (internalNotes) lead.internalNotes = internalNotes;

    await lead.save();

    // Trigger n8n webhook on status change
    if (statusChanged) {
      try {
        await triggerLeadStatusChange(lead, oldStatus, status, req.user?.email || 'system');
      } catch (err) {
        console.error("[n8n] Status change webhook error:", err.message);
      }
    }

    res.status(200).json({
      success: true,
      message: "Lead updated successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Update lead error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update lead",
    });
  }
};

// Get statistics (for admin dashboard)
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
      statusCounts,
      sourceCounts,
      setupTypeCounts,
      avgEstimate,
    ] = await Promise.all([
      BusinessSetupLead.countDocuments(),
      BusinessSetupLead.countDocuments({ createdAt: { $gte: today } }),
      BusinessSetupLead.countDocuments({ createdAt: { $gte: thisWeek } }),
      BusinessSetupLead.countDocuments({ createdAt: { $gte: thisMonth } }),
      BusinessSetupLead.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      BusinessSetupLead.aggregate([
        { $group: { _id: "$source", count: { $sum: 1 } } },
      ]),
      BusinessSetupLead.aggregate([
        { $group: { _id: "$setupType", count: { $sum: 1 } } },
      ]),
      BusinessSetupLead.aggregate([
        {
          $group: { _id: null, avg: { $avg: "$estimatedCost.totalEstimate" } },
        },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        overview: {
          total: totalLeads,
          today: todayLeads,
          thisWeek: weekLeads,
          thisMonth: monthLeads,
        },
        byStatus: statusCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        bySource: sourceCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        bySetupType: setupTypeCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        averageEstimate: avgEstimate[0]?.avg || 0,
      },
    });
  } catch (error) {
    console.error("Get statistics error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics",
    });
  }
};
