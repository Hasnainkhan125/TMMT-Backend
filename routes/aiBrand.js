/**
 * aiBrand.js — AI Brand Engine Routes
 * Mounted at: /api/v1/brand-ai
 *
 * Public endpoints (no auth required for lead generation):
 *   POST /generate     — full wizard brand generation
 *   POST /auto         — quick auto-generate (name + category)
 *   POST /inquiry      — custom business inquiry
 *
 * Protected endpoints (auth required):
 *   POST /save         — save brand to user account
 *   POST /social/post  — schedule social media post
 */

const express = require('express');
const router = express.Router();
const ctrl         = require('../controllers/brandProject/aiBrandController');
const agentCtrl    = require('../controllers/brandProject/brandAgentController');
const outreachCtrl = require('../controllers/brandProject/outreachController');

// Optional auth middleware — truly non-blocking (passes through if no token)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers['x-access-token'];
  if (!authHeader) return next(); // No token present — skip auth entirely
  try {
    const auth = require('../middelwares/auth');
    // Intercept the response to prevent 401 from blocking the request
    const origJson = res.json.bind(res);
    let intercepted = false;
    res.json = function(body) {
      if (res.statusCode === 401) {
        intercepted = true;
        res.statusCode = 200;
        res.json = origJson;
        return next();
      }
      res.json = origJson;
      return origJson(body);
    };
    auth(req, res, () => {
      res.json = origJson;
      next();
    });
  } catch (_) {
    next();
  }
};

const requireAuth = require('../middelwares/auth');

// Public — no login needed (for lead gen funnel)
router.post('/generate',        ctrl.generateBrandConcept);
router.post('/auto',            ctrl.autoGenerateBrand);
router.post('/inquiry',         ctrl.submitInquiry);
router.post('/generate-image',  ctrl.generateMockupImage);
router.post('/edit-image',      ctrl.editImage);

// AI Cofounder + Dashboard (public for funnel, auth-enhanced)
router.post('/cofounder/chat',      ctrl.cofounderChat);
router.post('/templates',           ctrl.generateTemplates);
router.post('/detect-activity',     ctrl.detectActivity);

// Protected — requires login
router.post('/save',         requireAuth, ctrl.saveBrand);
router.post('/social/post',  requireAuth, ctrl.scheduleSocialPost);
router.get('/user/brands',   requireAuth, ctrl.getUserBrands);
router.post('/license/apply',        optionalAuth, ctrl.submitLicenseApplication);
router.get('/license/applications',  requireAuth, ctrl.getLicenseApplications);

// AI Research Pipeline + Content Calendar
router.post('/research-business',     optionalAuth, ctrl.researchBusiness);
router.post('/generate-calendar',     optionalAuth, ctrl.generateContentCalendar);
router.patch('/calendar-item',        optionalAuth, ctrl.updateCalendarItem);
router.post('/zapier-webhook',        optionalAuth, ctrl.saveZapierWebhook);

// Competitors + Dashboard Intelligence
router.post('/research-competitors',  optionalAuth, ctrl.researchCompetitors);

// Visual Studio — image storage
router.post('/save-image',            optionalAuth, ctrl.saveGeneratedImage);
router.get('/images/:id',             ctrl.getGeneratedImages);

// Email capture + brand kit download
router.post('/kit-download',          optionalAuth, ctrl.emailAndDownloadKit);

// Social content strategy
router.post('/social-strategy',       optionalAuth, ctrl.generateSocialStrategy);

// Suppliers Research
router.post('/research-suppliers',    optionalAuth, ctrl.researchSuppliers);

// Marketing Cofounder — Competitive Intelligence
router.post('/competitive-intel',     optionalAuth, ctrl.getCompetitiveIntelligence);

// ── Brand Agent (Cofounder Marketing AI) ─────────────────────────────────────
router.post('/agent/insights',          optionalAuth, agentCtrl.getAgentInsights);
router.post('/agent/content-ideas',     optionalAuth, agentCtrl.generateContentIdeas);
router.post('/agent/content-strategy',  optionalAuth, agentCtrl.generateContentStrategy);
router.post('/agent/video-request',     optionalAuth, agentCtrl.submitVideoRequest);
router.post('/agent/schedule-post',     optionalAuth, agentCtrl.schedulePost);

// ── Sales Cofounder — Lead Outreach (Apollo + Email) ─────────────────────────
router.post('/outreach/find-leads',        optionalAuth, outreachCtrl.findLeads);
router.get( '/outreach/leads/:brandProjectId', optionalAuth, outreachCtrl.getLeads);
router.post('/outreach/generate-message',  optionalAuth, outreachCtrl.generateMessage);
router.post('/outreach/send-email',        optionalAuth, outreachCtrl.sendEmail);
router.post('/outreach/approve-message',   optionalAuth, outreachCtrl.approveMessage);
router.post('/outreach/update-stage',      optionalAuth, outreachCtrl.updateLeadStage);
router.post('/outreach/mailchimp-subscribe', optionalAuth, outreachCtrl.mailchimpSubscribe);

// Admin — all submissions + saved brands
router.get('/admin/submissions',  requireAuth, ctrl.adminGetSubmissions);
router.get('/admin/brands',       requireAuth, ctrl.adminGetBrands);

// Public — fetch saved brand project by ID (for shareable brand-builder URLs)
router.get('/project/:id',   ctrl.getBrandProject);

// Lead capture & PDF download (public for funnel)
router.post('/capture-email',         ctrl.captureEmail);
router.post('/track',                 ctrl.trackEvent);
router.get('/download-pdf/:submissionId',  ctrl.downloadPdf);
router.post('/download-pdf/:submissionId', ctrl.downloadPdf);
router.get('/unsubscribe',            ctrl.unsubscribe);

module.exports = router;
