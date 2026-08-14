/**
 * emailSendingService.js — Mailchimp Transactional (Mandrill) email sending
 *
 * Mandrill API base: https://mandrillapp.com/api/1.0
 * API key env var:   QUMAK_MAILCHIMP_API_KEY
 * From email:        outreach@qumak.io
 */

const axios        = require('axios');
const BrandProject = require('../model/schema/brandProject');

const MANDRILL_BASE  = 'https://mandrillapp.com/api/1.0';
const FROM_EMAIL     = 'outreach@qumak.io';
function getMandrillKey() { return process.env.QUMAK_MAILCHIMP_API_KEY || ''; }

// ── Helper: plain-text to minimal HTML ───────────────────────────────────────
function textToHtml(text, brandName) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:600px;margin:0 auto;padding:24px;">
<p>${escaped}</p>
<br>
<p style="color:#666;font-size:13px;">--<br>${brandName}<br><a href="https://qumak.io" style="color:#666;">qumak.io</a></p>
</body>
</html>`;
}

/**
 * sendOutreachEmail — sends one email via Mandrill.
 * @param {object} brand
 * @param {object} lead
 * @param {object} message - { subject, body, sequenceNumber, id }
 * @returns {{ success: boolean, messageId: string }}
 */
async function sendOutreachEmail(brand, lead, message) {
  if (!getMandrillKey()) throw new Error('Mailchimp API key not configured (QUMAK_MAILCHIMP_API_KEY)');
  if (!lead.email)   throw new Error('Lead has no email address');

  const cfg       = brand.config?.brand || {};
  const brandName = brand.projectName   || cfg.brandName || 'Qumak';
  const fromName  = brandName;
  const htmlBody  = textToHtml(message.body, brandName);

  const payload = {
    key: getMandrillKey(),
    message: {
      html:       htmlBody,
      text:       message.body,
      subject:    message.subject,
      from_email: FROM_EMAIL,
      from_name:  fromName,
      to: [{
        email: lead.email,
        name:  lead.fullName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || lead.email,
        type:  'to',
      }],
      metadata: {
        brandId: String(brand._id),
        leadId:  lead.id,
      },
      track_opens:  true,
      track_clicks: false,
    },
  };

  const response = await axios.post(`${MANDRILL_BASE}/messages/send`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const result    = response.data?.[0] || {};
  const mandrillId = result._id || result.id || null;
  const status    = result.status || 'sent';

  if (status === 'rejected' || status === 'invalid') {
    throw new Error(`Mandrill rejected message: ${result.reject_reason || status}`);
  }

  // Update lead in DB: mark message as sent
  const now = new Date();
  await BrandProject.findOneAndUpdate(
    { _id: brand._id, 'leads.id': lead.id },
    {
      $set: {
        'leads.$.lastContactedAt': now,
        'leads.$.leadStage':       lead.leadStage === 'new' ? 'contacted' : lead.leadStage,
      },
    }
  );

  // Update the specific outreach message if it exists, otherwise push
  const msgIndex = (lead.outreachMessages || []).findIndex(m => m.id === message.id);
  if (msgIndex >= 0) {
    await BrandProject.findOneAndUpdate(
      { _id: brand._id, 'leads.id': lead.id },
      {
        $set: {
          [`leads.$[lead].outreachMessages.${msgIndex}.status`]:          'sent',
          [`leads.$[lead].outreachMessages.${msgIndex}.sentAt`]:          now,
          [`leads.$[lead].outreachMessages.${msgIndex}.resendMessageId`]: mandrillId,
        },
      },
      { arrayFilters: [{ 'lead.id': lead.id }] }
    );
  }

  return {
    success:    true,
    mandrillId,
    status,
    sentAt:     now,
  };
}

/**
 * scheduleFollowUps — finds leads with nextFollowUpAt <= now and sends follow-up emails.
 * @returns {{ processed: number, sent: number, errors: number }}
 */
async function scheduleFollowUps() {
  const now = new Date();
  let processed = 0;
  let sent      = 0;
  let errors    = 0;

  try {
    // Find brands with leads needing follow-up
    const brands = await BrandProject.find({
      isArchived: { $ne: true },
      'leads.nextFollowUpAt': { $lte: now },
      'leads.leadStage':      { $in: ['contacted'] },
    }).limit(100);

    for (const brand of brands) {
      const dueLeads = (brand.leads || []).filter(l => {
        return l.nextFollowUpAt &&
               l.nextFollowUpAt <= now &&
               l.leadStage === 'contacted' &&
               l.email;
      });

      for (const lead of dueLeads) {
        processed++;
        try {
          const sentCount = (lead.outreachMessages || []).filter(m => m.status === 'sent').length;
          const nextSeq   = Math.min(sentCount + 1, 3);

          // Find a drafted follow-up message for this sequence
          const draftMsg = (lead.outreachMessages || []).find(
            m => m.status === 'draft' && m.sequenceNumber === nextSeq
          );

          if (!draftMsg) continue;

          await sendOutreachEmail(brand, lead, draftMsg);

          // Clear nextFollowUpAt after sending
          await BrandProject.findOneAndUpdate(
            { _id: brand._id, 'leads.id': lead.id },
            { $unset: { 'leads.$.nextFollowUpAt': '' } }
          );

          sent++;
        } catch (err) {
          console.error(`[scheduleFollowUps] Error sending to lead ${lead.id}:`, err.message);
          errors++;
        }
      }
    }
  } catch (err) {
    console.error('[scheduleFollowUps] Fatal error:', err.message);
  }

  return { processed, sent, errors };
}

/**
 * handleWebhook — processes Mandrill webhook events.
 * @param {object|Array} event - Mandrill event payload
 * @returns {{ processed: number }}
 */
async function handleWebhook(event) {
  // Mandrill sends events as a JSON array (or single object)
  const events = Array.isArray(event) ? event : [event];
  let processed = 0;

  for (const ev of events) {
    const type       = ev.event || ev.type;
    const mandrillId = ev._id || ev.msg?._id || ev.id;
    const metadata   = ev.msg?.metadata || ev.metadata || {};
    const brandId    = metadata.brandId;
    const leadId     = metadata.leadId;

    if (!brandId || !leadId || !mandrillId) continue;

    try {
      let updateFields = {};

      switch (type) {
        case 'open':
          updateFields = {
            'leads.$[lead].outreachMessages.$[msg].status':   'opened',
            'leads.$[lead].outreachMessages.$[msg].openedAt': new Date(),
          };
          break;

        case 'hard_bounce':
        case 'soft_bounce':
        case 'bounce':
          updateFields = {
            'leads.$[lead].outreachMessages.$[msg].status': 'bounced',
          };
          // Also mark lead as not fit on hard bounce
          if (type === 'hard_bounce') {
            await BrandProject.findOneAndUpdate(
              { _id: brandId, 'leads.id': leadId },
              { $set: { 'leads.$.leadStage': 'not_fit' } }
            );
          }
          break;

        case 'spam':
        case 'reject':
          updateFields = {
            'leads.$[lead].outreachMessages.$[msg].status': 'bounced',
          };
          break;

        default:
          // unhandled event type — skip
          continue;
      }

      if (Object.keys(updateFields).length > 0) {
        await BrandProject.findOneAndUpdate(
          { _id: brandId },
          { $set: updateFields },
          {
            arrayFilters: [
              { 'lead.id': leadId },
              { 'msg.resendMessageId': mandrillId },
            ],
          }
        );
      }

      processed++;
    } catch (err) {
      console.error(`[handleWebhook] Error processing event ${type} for ${mandrillId}:`, err.message);
    }
  }

  return { processed };
}

module.exports = {
  sendOutreachEmail,
  scheduleFollowUps,
  handleWebhook,
};
