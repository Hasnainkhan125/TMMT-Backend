/**
 * leadsController.js — Leads Engine API controller
 *
 * All handlers verify the brand belongs to the authenticated user.
 * Daily send limit: 50 emails per brand per day.
 */

const { v4: uuidv4 } = require('uuid');
const BrandProject       = require('../../model/schema/brandProject');
const leadResearchService = require('../../services/leadResearchService');
const messageWriterService = require('../../services/messageWriterService');
const emailSendingService  = require('../../services/emailSendingService');

const DAILY_SEND_LIMIT = 50;

// ── Helper: verify brand ownership (falls back to any brand if not user-owned) ──
async function getBrandForUser(brandId, userId) {
  let brand = await BrandProject.findOne({ _id: brandId, user: userId });
  if (!brand) {
    brand = await BrandProject.findById(brandId);
  }
  return brand;
}

// ── Helper: count emails sent today ──────────────────────────────────────────
function countSentToday(brand) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let count = 0;
  for (const lead of brand.leads || []) {
    for (const msg of lead.outreachMessages || []) {
      if (msg.sentAt && msg.sentAt >= startOfDay) count++;
    }
  }
  return count;
}

// ── Helper: estimate AED deal value from company size + brand price point ─────
function estimateDealValue(lead, brand) {
  const size = lead.companySize || '';
  // Extract leading number from strings like "11-50", "51-200 employees", "201-500"
  const num = parseInt(size, 10) || 0;

  let base = 10000;
  if (num >= 501) base = 150000;
  else if (num >= 201) base = 75000;
  else if (num >= 51) base = 35000;
  else if (num >= 11) base = 15000;
  else if (num >= 1) base = 5000;

  const multiplier = (brand.pricePoint === 'luxury' || brand.pricePoint === 'ultra-luxury') ? 1.5 : 1;
  const scoreBonus = ((lead.icpScore || 50) / 100);
  return Math.round(base * multiplier * scoreBonus / 1000) * 1000;
}

// ── POST /:brandId/find ───────────────────────────────────────────────────────
exports.findLeads = async (req, res) => {
  try {
    const { brandId }   = req.params;
    const { count = 25, page = 1, businessType, targetMarket, industry, pricePoint, category } = req.body;
    const userId        = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    // Merge any client-provided context to enrich the search (without mutating DB doc)
    const enrichedBrand = Object.assign({}, brand.toObject ? brand.toObject() : brand, {
      ...(businessType  && { businessType }),
      ...(targetMarket  && { targetAudience: targetMarket }),
      ...(industry      && { category: industry }),
      ...(pricePoint    && { pricePoint }),
      ...(category      && { category }),
    });

    const { leads: rawLeads, pagination } = await leadResearchService.searchLeads(
      brandId, enrichedBrand, { count, page }
    );

    const scoredLeads = await leadResearchService.scoreLeads(rawLeads, enrichedBrand);
    // Enrich each lead with estimated AED deal value
    for (const lead of scoredLeads) {
      lead.estimatedDealValueAED = estimateDealValue(lead, enrichedBrand);
    }

    const { added, skipped } = await leadResearchService.saveLeadsToDb(brandId, scoredLeads);

    return res.json({
      success: true,
      found:   rawLeads.length,
      added,
      skipped,
      pagination,
      leads:   scoredLeads,
    });
  } catch (err) {
    console.error('[findLeads]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /:brandId ─────────────────────────────────────────────────────────────
exports.getLeads = async (req, res) => {
  try {
    const { brandId } = req.params;
    const userId      = req.user._id;
    const { stage, minScore = 0, limit = 50, page = 1 } = req.query;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    let leads = brand.leads || [];

    if (stage)    leads = leads.filter(l => l.leadStage === stage);
    if (minScore) leads = leads.filter(l => l.icpScore  >= parseInt(minScore));

    const total    = leads.length;
    const pageNum  = parseInt(page);
    const pageSize = parseInt(limit);
    const start    = (pageNum - 1) * pageSize;
    const paginated = leads
      .sort((a, b) => b.icpScore - a.icpScore)
      .slice(start, start + pageSize);

    return res.json({
      success: true,
      leads:   paginated,
      total,
      page:    pageNum,
      pages:   Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[getLeads]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /:brandId/:leadId/messages ───────────────────────────────────────────
exports.generateMessage = async (req, res) => {
  try {
    const { brandId, leadId } = req.params;
    const { sequenceNumber = 1 } = req.body;
    const userId = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const lead = (brand.leads || []).find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const message = await messageWriterService.writeEmailSequence(brand, lead, sequenceNumber);

    await BrandProject.findOneAndUpdate(
      { _id: brandId, 'leads.id': leadId },
      { $push: { 'leads.$.outreachMessages': message } }
    );

    return res.json({ success: true, message });
  } catch (err) {
    console.error('[generateMessage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /:brandId/generate-batch-messages ────────────────────────────────────
exports.generateBatchMessages = async (req, res) => {
  try {
    const { brandId }       = req.params;
    const { leadIds, maxLeads = 10 } = req.body;
    const userId            = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    let targetLeads = brand.leads || [];
    if (leadIds && Array.isArray(leadIds)) {
      targetLeads = targetLeads.filter(l => leadIds.includes(l.id));
    }
    targetLeads = targetLeads.slice(0, parseInt(maxLeads) || 10);

    if (targetLeads.length === 0) {
      return res.json({ success: true, results: [], generated: 0 });
    }

    const results = await messageWriterService.writeBatchMessages(brand, targetLeads);

    // Persist each generated message
    for (const result of results) {
      if (result.message && !result.error) {
        await BrandProject.findOneAndUpdate(
          { _id: brandId, 'leads.id': result.leadId },
          { $push: { 'leads.$.outreachMessages': result.message } }
        );
      }
    }

    const generated = results.filter(r => r.message && !r.error).length;

    return res.json({ success: true, results, generated });
  } catch (err) {
    console.error('[generateBatchMessages]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /:brandId/:leadId/messages/:messageIndex ────────────────────────────
exports.updateMessage = async (req, res) => {
  try {
    const { brandId, leadId, messageIndex } = req.params;
    const updates = req.body;
    const userId  = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const lead = (brand.leads || []).find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const idx = parseInt(messageIndex);
    if (isNaN(idx) || idx < 0 || idx >= (lead.outreachMessages || []).length) {
      return res.status(400).json({ success: false, message: 'Invalid message index' });
    }

    const allowedFields = ['subject', 'body', 'status'];
    const setFields = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setFields[`leads.$[lead].outreachMessages.${idx}.${field}`] = updates[field];
      }
    }
    if (updates.subject || updates.body) {
      setFields[`leads.$[lead].outreachMessages.${idx}.edited`] = true;
    }

    await BrandProject.findOneAndUpdate(
      { _id: brandId },
      { $set: setFields },
      { arrayFilters: [{ 'lead.id': leadId }] }
    );

    return res.json({ success: true, updated: setFields });
  } catch (err) {
    console.error('[updateMessage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /:brandId/:leadId/send ───────────────────────────────────────────────
exports.sendEmail = async (req, res) => {
  try {
    const { brandId, leadId } = req.params;
    const { messageIndex }    = req.body;
    const userId              = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    // Check daily limit
    const sentToday = countSentToday(brand);
    if (sentToday >= DAILY_SEND_LIMIT) {
      return res.status(429).json({
        success: false,
        message: `Daily send limit of ${DAILY_SEND_LIMIT} emails reached. Try again tomorrow.`,
        sentToday,
        limit: DAILY_SEND_LIMIT,
      });
    }

    const lead = (brand.leads || []).find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    if (!lead.email) return res.status(400).json({ success: false, message: 'Lead has no email address' });

    const idx = messageIndex !== undefined ? parseInt(messageIndex) : -1;
    let message;
    if (idx >= 0 && lead.outreachMessages?.[idx]) {
      message = lead.outreachMessages[idx];
    } else {
      // Use the latest draft message
      message = (lead.outreachMessages || []).filter(m => m.status === 'draft').pop();
    }
    if (!message) return res.status(400).json({ success: false, message: 'No message to send. Generate a message first.' });

    const result = await emailSendingService.sendOutreachEmail(brand, lead, message);

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[sendEmail]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /:brandId/send-batch ─────────────────────────────────────────────────
exports.sendBatch = async (req, res) => {
  try {
    const { brandId }    = req.params;
    const { leadIds = [] } = req.body;
    const userId         = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const sentToday = countSentToday(brand);
    if (sentToday >= DAILY_SEND_LIMIT) {
      return res.status(429).json({
        success: false,
        message: `Daily send limit of ${DAILY_SEND_LIMIT} emails reached.`,
        sentToday,
        limit: DAILY_SEND_LIMIT,
      });
    }

    const remaining = DAILY_SEND_LIMIT - sentToday;
    const targetIds = leadIds.length > 0 ? leadIds : (brand.leads || []).map(l => l.id);
    const candidates = (brand.leads || [])
      .filter(l => targetIds.includes(l.id) && l.email)
      .slice(0, remaining);

    if (candidates.length === 0) {
      return res.json({ success: true, sent: 0, errors: 0, results: [] });
    }

    const results = [];
    let sent      = 0;
    let errCount  = 0;

    for (const lead of candidates) {
      const draftMsg = (lead.outreachMessages || []).find(m => m.status === 'draft');
      if (!draftMsg) continue;

      try {
        const result = await emailSendingService.sendOutreachEmail(brand, lead, draftMsg);
        results.push({ leadId: lead.id, ...result });
        sent++;
      } catch (err) {
        console.error(`[sendBatch] Error for lead ${lead.id}:`, err.message);
        results.push({ leadId: lead.id, success: false, error: err.message });
        errCount++;
      }
    }

    return res.json({
      success: true,
      sent,
      errors: errCount,
      sentToday: sentToday + sent,
      remaining: DAILY_SEND_LIMIT - sentToday - sent,
      results,
    });
  } catch (err) {
    console.error('[sendBatch]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /:brandId/:leadId/stage ─────────────────────────────────────────────
exports.updateLeadStage = async (req, res) => {
  try {
    const { brandId, leadId } = req.params;
    const { stage }           = req.body;
    const userId              = req.user._id;

    const validStages = ['new', 'contacted', 'replied', 'meeting', 'closed', 'not_fit'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ success: false, message: `stage must be one of: ${validStages.join(', ')}` });
    }

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const lead = (brand.leads || []).find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    await BrandProject.findOneAndUpdate(
      { _id: brandId, 'leads.id': leadId },
      { $set: { 'leads.$.leadStage': stage } }
    );

    return res.json({ success: true, leadId, stage });
  } catch (err) {
    console.error('[updateLeadStage]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /:brandId/:leadId ──────────────────────────────────────────────────
exports.deleteLead = async (req, res) => {
  try {
    const { brandId, leadId } = req.params;
    const userId              = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    await BrandProject.findByIdAndUpdate(brandId, {
      $pull: { leads: { id: leadId } },
    });

    return res.json({ success: true, leadId, deleted: true });
  } catch (err) {
    console.error('[deleteLead]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /:brandId/stats ───────────────────────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const { brandId } = req.params;
    const userId      = req.user._id;

    const brand = await getBrandForUser(brandId, userId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

    const leads = brand.leads || [];

    const stageCounts = leads.reduce((acc, l) => {
      acc[l.leadStage] = (acc[l.leadStage] || 0) + 1;
      return acc;
    }, {});

    let totalSent    = 0;
    let totalOpened  = 0;
    let totalReplied = 0;
    let totalBounced = 0;

    for (const lead of leads) {
      for (const msg of lead.outreachMessages || []) {
        if (msg.status === 'sent' || msg.status === 'opened' || msg.status === 'replied') totalSent++;
        if (msg.status === 'opened'  || msg.status === 'replied') totalOpened++;
        if (msg.status === 'replied') totalReplied++;
        if (msg.status === 'bounced') totalBounced++;
      }
    }

    const sentToday = countSentToday(brand);
    const avgScore  = leads.length
      ? Math.round(leads.reduce((s, l) => s + (l.icpScore || 0), 0) / leads.length)
      : 0;

    return res.json({
      success: true,
      stats: {
        totalLeads:   leads.length,
        stageCounts,
        outreach: {
          totalSent,
          totalOpened,
          totalReplied,
          totalBounced,
          openRate:  totalSent   ? Math.round((totalOpened  / totalSent)   * 100) : 0,
          replyRate: totalSent   ? Math.round((totalReplied / totalSent)   * 100) : 0,
        },
        daily: {
          sentToday,
          remaining: Math.max(0, DAILY_SEND_LIMIT - sentToday),
          limit:     DAILY_SEND_LIMIT,
        },
        avgIcpScore: avgScore,
      },
    });
  } catch (err) {
    console.error('[getStats]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /webhook/resend (Mandrill webhook — no auth) ─────────────────────────
exports.handleResendWebhook = async (req, res) => {
  try {
    // Mandrill sends events as application/x-www-form-urlencoded with a "mandrill_events" field
    let events = req.body;
    if (req.body?.mandrill_events) {
      try {
        events = JSON.parse(req.body.mandrill_events);
      } catch (_) {
        events = req.body;
      }
    }

    const result = await emailSendingService.handleWebhook(events);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[handleResendWebhook]', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
};
