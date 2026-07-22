const BrandProject = require('../../model/schema/brandProject');

/**
 * POST /api/v1/brand-projects/:brandId/trade-license
 * Saves trade license application form data onto the brand document.
 */
exports.submitApplication = async (req, res) => {
  try {
    const { brandId } = req.params;
    const userId = req.user._id;
    const {
      package: selectedPackage,
      fullName,
      email,
      phone,
      passportNumber,
      companyName,
      visaEligible,
      numberOfVisas,
      officeType,
      freeZone,
      notes,
    } = req.body;

    if (!fullName || !email || !phone || !selectedPackage) {
      return res.status(400).json({
        success: false,
        message: 'fullName, email, phone, and package are required',
      });
    }

    const VALID_PACKAGES = ['starter', 'growth', 'premium'];
    if (!VALID_PACKAGES.includes(selectedPackage)) {
      return res.status(400).json({ success: false, message: 'Package must be one of: starter, growth, premium' });
    }

    const application = {
      package: selectedPackage,
      fullName,
      email,
      phone,
      passportNumber,
      companyName: companyName || brandId, // will be replaced below
      visaEligible: visaEligible === true || visaEligible === 'true',
      numberOfVisas: Math.min(Math.max(parseInt(numberOfVisas) || 1, 1), 6),
      officeType: officeType || 'flexi_desk',
      freeZone: freeZone || 'RAKEZ',
      notes,
      submittedAt: new Date(),
      status: 'submitted',
    };

    // Fetch brand name for companyName default, then update atomically
    const updated = await BrandProject.findOneAndUpdate(
      { _id: brandId, user: userId },
      { $set: { tradeLicenseApplication: { ...application, companyName: companyName || undefined } } },
      { new: true, select: 'tradeLicenseApplication projectName' }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Brand not found' });
    }

    // Fill in companyName default from projectName if not provided
    if (!companyName && updated.projectName) {
      application.companyName = updated.projectName;
    }

    return res.json({
      success: true,
      message: 'Trade license application submitted successfully.',
      application: updated.tradeLicenseApplication,
    });
  } catch (err) {
    console.error('[submitApplication]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/v1/brand-projects/:brandId/trade-license
 * Returns existing application if any.
 */
exports.getApplication = async (req, res) => {
  try {
    const { brandId } = req.params;
    const userId = req.user._id;

    const brand = await BrandProject.findOne(
      { _id: brandId, user: userId },
      { tradeLicenseApplication: 1 }
    );
    if (!brand) {
      return res.status(404).json({ success: false, message: 'Brand not found' });
    }

    return res.json({
      success: true,
      application: brand.tradeLicenseApplication || null,
    });
  } catch (err) {
    console.error('[getApplication]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
