/**
 * outreachController.js — Sales Cofounder API endpoints
 * Coordinates Apollo lead discovery, AI message generation, and email sending
 */

const outreachService = require('../../services/outreachService');

// POST /outreach/find-leads — Search Apollo for ICP-matched leads
exports.findLeads = async (req, res) => {
  try {
    const { brandProjectId, count = 25, page = 1 } = req.body;
    if (!brandProjectId) return res.status(400).json({ success: false, message: 'brandProjectId required' });

    const result = await outreachService.findLeads(brandProjectId, { count, page });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[findLeads]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /outreach/leads/:brandProjectId — Get existing leads
exports.getLeads = async (req, res) => {
  try {
    const { brandProjectId } = req.params;
    const { stage, minScore, limit } = req.query;

    const leads = await outreachService.getLeads(brandProjectId, {
      stage,
      minScore: minScore ? parseInt(minScore) : 0,
      limit: limit ? parseInt(limit) : 50,
    });

    return res.json({ success: true, leads, count: leads.length });
  } catch (err) {
    console.error('[getLeads]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /outreach/generate-message — Generate AI outreach email for a lead
exports.generateMessage = async (req, res) => {
  try {
    const { brandProjectId, leadId, sequenceNumber = 1 } = req.body;
    if (!brandProjectId || !leadId) {
      return res.status(400).json({ success: false, message: 'brandProjectId and leadId required' });
    }

    const BrandProject = require('../../model/schema/brandProject');
    const brand = await BrandProject.findById(brandProjectId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const lead = (brand.leads || []).find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const message = await outreachService.generateMessage(brand, lead, sequenceNumber);
    return res.json({ success: true, message });
  } catch (err) {
    console.error('[generateMessage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /outreach/send-email — Send an approved email to a lead
exports.sendEmail = async (req, res) => {
  try {
    const { brandProjectId, leadId, messageId } = req.body;
    if (!brandProjectId || !leadId || !messageId) {
      return res.status(400).json({ success: false, message: 'brandProjectId, leadId, messageId required' });
    }

    const result = await outreachService.sendEmail(brandProjectId, leadId, messageId);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[sendEmail]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /outreach/approve-message — Mark a draft message as approved
exports.approveMessage = async (req, res) => {
  try {
    const { brandProjectId, leadId, messageId, editedBody, editedSubject } = req.body;
    if (!brandProjectId || !leadId || !messageId) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const BrandProject = require('../../model/schema/brandProject');
    const updates = { 'leads.$[lead].outreachMessages.$[msg].status': 'approved' };
    if (editedBody) {
      updates['leads.$[lead].outreachMessages.$[msg].body'] = editedBody;
      updates['leads.$[lead].outreachMessages.$[msg].edited'] = true;
    }
    if (editedSubject) {
      updates['leads.$[lead].outreachMessages.$[msg].subject'] = editedSubject;
      updates['leads.$[lead].outreachMessages.$[msg].edited'] = true;
    }

    await BrandProject.findOneAndUpdate(
      { _id: brandProjectId, 'leads.id': leadId, 'leads.outreachMessages.id': messageId },
      { $set: updates },
      { arrayFilters: [{ 'lead.id': leadId }, { 'msg.id': messageId }] }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[approveMessage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /outreach/update-stage — Update lead stage
exports.updateLeadStage = async (req, res) => {
  try {
    const { brandProjectId, leadId, stage } = req.body;
    if (!brandProjectId || !leadId || !stage) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const BrandProject = require('../../model/schema/brandProject');
    await BrandProject.findOneAndUpdate(
      { _id: brandProjectId, 'leads.id': leadId },
      { $set: { 'leads.$.leadStage': stage } }
    );

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /outreach/mailchimp-subscribe — Add to Mailchimp welcome list
exports.mailchimpSubscribe = async (req, res) => {
  try {
    const { email, brandName, firstName } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'email required' });

    const result = await outreachService.addToMailchimpWelcome(email, brandName, firstName);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[mailchimpSubscribe]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
