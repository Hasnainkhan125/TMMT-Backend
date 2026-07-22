/**
 * n8n Webhook Integration
 * 
 * This utility triggers n8n workflows for various events.
 * Configure your n8n webhook URL in the .env file.
 * 
 * n8n can then:
 * - Send WhatsApp messages (via Twilio, WhatsApp Business API, or Meta Cloud API)
 * - Create Google Calendar events
 * - Add data to Google Sheets
 * - Send Slack/Discord notifications
 * - Trigger OpenAI for auto-responses
 * - And much more...
 */

const axios = require('axios');

// Environment variables for n8n webhooks
const N8N_WEBHOOK_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL || 'https://your-n8n-instance.com';
const N8N_WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN || '';

// Webhook endpoints (you'll create these in n8n)
const WEBHOOKS = {
  NEW_BUSINESS_LEAD: '/webhook/business-lead/new',
  LEAD_STATUS_CHANGE: '/webhook/business-lead/status-change',
  NEW_VISA_APPLICATION: '/webhook/visa-application/new',
  APPLICATION_STATUS_CHANGE: '/webhook/visa-application/status-change',
  NEW_CHAT_MESSAGE: '/webhook/chat/new-message',
  ADMIN_ALERT: '/webhook/admin/alert',
};

/**
 * Trigger an n8n webhook
 * @param {string} webhookPath - The webhook endpoint path
 * @param {object} data - The payload to send
 * @param {object} options - Additional options
 * @returns {Promise<object>} - The response from n8n
 */
async function triggerWebhook(webhookPath, data, options = {}) {
  // Skip if n8n is not configured
  if (!process.env.N8N_WEBHOOK_BASE_URL || process.env.N8N_WEBHOOK_BASE_URL === 'https://your-n8n-instance.com') {
    console.log('[n8n] Webhook not configured, skipping:', webhookPath);
    return { success: false, skipped: true, reason: 'n8n not configured' };
  }

  const url = `${N8N_WEBHOOK_BASE_URL}${webhookPath}`;
  
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    
    // Add auth token if configured
    if (N8N_WEBHOOK_TOKEN) {
      headers['X-N8N-API-KEY'] = N8N_WEBHOOK_TOKEN;
    }

    console.log(`[n8n] Triggering webhook: ${webhookPath}`);
    
    const response = await axios.post(url, {
      timestamp: new Date().toISOString(),
      source: 'qumak-backend',
      event: webhookPath.replace('/webhook/', '').replace(/\//g, '.'),
      ...data,
    }, {
      headers,
      timeout: options.timeout || 10000, // 10 second timeout
    });

    console.log(`[n8n] Webhook triggered successfully: ${webhookPath}`);
    
    return {
      success: true,
      statusCode: response.status,
      data: response.data,
    };
  } catch (error) {
    console.error(`[n8n] Webhook failed: ${webhookPath}`, error.message);
    
    return {
      success: false,
      error: error.message,
      statusCode: error.response?.status,
    };
  }
}

/**
 * Trigger webhook for new business setup lead
 * This can be used to send WhatsApp notifications, add to Google Sheets, etc.
 */
async function triggerNewBusinessLead(lead) {
  const payload = {
    lead: {
      id: lead._id?.toString(),
      leadNumber: lead.leadNumber,
      fullName: lead.fullName,
      email: lead.email,
      phone: `${lead.countryCode || '+971'}${lead.phoneNumber}`,
      nationality: lead.nationality,
      
      // Business details
      setupType: lead.setupType,
      freezone: lead.freezone,
      businessActivity: lead.businessActivity,
      businessActivityCategory: lead.businessActivityCategory,
      visaCount: lead.visaCount,
      budgetRange: lead.budgetRange,
      urgency: lead.urgency,
      
      // Cost estimate
      estimatedCost: lead.estimatedCost,
      
      // Tracking
      source: lead.source,
      utmSource: lead.utmSource,
      utmMedium: lead.utmMedium,
      utmCampaign: lead.utmCampaign,
      deviceType: lead.deviceType,
      
      // Timestamps
      createdAt: lead.createdAt,
    },
    
    // Pre-formatted messages for WhatsApp/Slack
    messages: {
      // Admin notification message
      adminWhatsApp: formatAdminWhatsAppMessage(lead),
      
      // Customer confirmation message
      customerWhatsApp: formatCustomerWhatsAppMessage(lead),
    },
  };

  return triggerWebhook(WEBHOOKS.NEW_BUSINESS_LEAD, payload);
}

/**
 * Trigger webhook for lead status change
 */
async function triggerLeadStatusChange(lead, oldStatus, newStatus, updatedBy) {
  const payload = {
    lead: {
      id: lead._id?.toString(),
      leadNumber: lead.leadNumber,
      fullName: lead.fullName,
      email: lead.email,
      phone: `${lead.countryCode || '+971'}${lead.phoneNumber}`,
    },
    statusChange: {
      from: oldStatus,
      to: newStatus,
      updatedBy,
      timestamp: new Date().toISOString(),
    },
  };

  return triggerWebhook(WEBHOOKS.LEAD_STATUS_CHANGE, payload);
}

/**
 * Trigger webhook for admin alerts
 */
async function triggerAdminAlert(alertType, data) {
  const payload = {
    alertType,
    data,
    priority: data.priority || 'normal',
  };

  return triggerWebhook(WEBHOOKS.ADMIN_ALERT, payload);
}

/**
 * Format admin WhatsApp notification message
 */
function formatAdminWhatsAppMessage(lead) {
  const budgetMap = {
    '4999_13000': 'AED 4,999 - 13,000',
    '13999_18999': 'AED 13,999 - 18,999',
    '25000_30000': 'AED 25,000 - 30,000',
    '30000_plus': 'AED 30,000+',
  };

  const urgencyEmoji = {
    'immediate': '🔴',
    'within_week': '🟡',
    'within_month': '🟢',
    'exploring': '⚪',
  };

  return `🔥 *NEW BUSINESS LEAD*

📋 *${lead.leadNumber}*
👤 ${lead.fullName}
📧 ${lead.email}
📱 ${lead.countryCode || '+971'}${lead.phoneNumber}
🌍 ${lead.nationality}

*Business Details*
━━━━━━━━━━━━━━━
📍 ${lead.setupType === 'mainland' ? 'UAE Mainland' : `Free Zone (${lead.freezone})`}
🏢 ${lead.businessActivity}
👥 Visas: ${lead.visaCount}
💰 Budget: ${budgetMap[lead.budgetRange] || lead.budgetRange}
${urgencyEmoji[lead.urgency] || '⚪'} Urgency: ${lead.urgency}

*Estimated Cost*
━━━━━━━━━━━━━━━
💵 Total: AED ${lead.estimatedCost?.totalEstimate?.toLocaleString() || 'TBD'}

📊 Source: ${lead.source || 'direct'}
${lead.utmCampaign ? `📢 Campaign: ${lead.utmCampaign}` : ''}

⏰ ${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}`;
}

/**
 * Format customer WhatsApp confirmation message
 */
function formatCustomerWhatsAppMessage(lead) {
  const firstName = lead.fullName?.split(' ')[0] || 'there';
  
  return `Hello ${firstName}! 👋

Thank you for your interest in setting up a business in the UAE.

*Your Request Details*
📋 Reference: ${lead.leadNumber}
🏢 ${lead.setupType === 'mainland' ? 'UAE Mainland' : `Free Zone`} License
💼 ${lead.businessActivity}

*Estimated Investment*
💰 AED ${lead.estimatedCost?.totalEstimate?.toLocaleString() || 'TBD'}
_(This is an estimate. Final quote will be provided by our consultant.)_

*What's Next?*
✅ Our business setup specialist will call you within 24 hours
✅ We'll send you a detailed quotation
✅ Free consultation to discuss your requirements

Have questions? Reply to this message or call us!

Best regards,
*Qumak Business Setup Team*
🌐 www.qumak.io`;
}

module.exports = {
  triggerWebhook,
  triggerNewBusinessLead,
  triggerLeadStatusChange,
  triggerAdminAlert,
  formatAdminWhatsAppMessage,
  formatCustomerWhatsAppMessage,
  WEBHOOKS,
};

