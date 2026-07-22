const twilio = require('twilio');
require("dotenv").config();
// Initialize Twilio client (disabled unless valid env provided)
let client = null;
try {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (sid && token && from && sid.startsWith('AC')) {
    client = twilio(sid, token);
  } else {
    console.warn('Twilio disabled: missing or invalid credentials');
  }
} catch (e) {
  console.warn('Twilio init failed; SMS disabled:', e.message);
}

/**
 * Send SMS using Twilio
 * @param {Object} options - SMS options
 * @param {string} options.to - Recipient phone number
 * @param {string} options.template - Template name for the message
 * @param {Object} options.data - Data to populate the template
 * @returns {Promise} - Twilio message response
 */
exports.sendSMS = async ({ to, template, data }) => {
  try {
    if (!client) {
      console.warn('SMS skipped (Twilio disabled):', template);
      return { sid: 'disabled', to, status: 'skipped' };
    }
    // Get message content based on template
    const content = getMessageContent(template, data);

    // Send SMS via Twilio
    const message = await client.messages.create({
      body: content,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    return message;
  } catch (error) {
    console.error('SMS sending failed:', error);
    throw new Error('Failed to send SMS');
  }
};

/**
 * Get message content based on template and data
 * @param {string} template - Template name
 * @param {Object} data - Data to populate the template
 * @returns {string} - Formatted message content
 */
const getMessageContent = (template, data) => {
  const templates = {
    quotation: `Your quotation #${data.quotationNumber} for ${data.serviceType} has been created. Total amount: $${data.totalAmount}. Valid until: ${new Date(data.expiryDate).toLocaleDateString()}`,
    quotation_update: `Your quotation #${data.quotationNumber} has been updated. New total amount: $${data.totalAmount}`,
    quotation_approved: `Your quotation #${data.quotationNumber} has been approved. We'll contact you shortly to proceed.`,
    quotation_rejected: `Your quotation #${data.quotationNumber} has been rejected. Please contact us for more information.`,
    otp: `Your QUMAK verification code is ${data.code}. It expires in 5 minutes.`
  };  

  return templates[template] || 'No template content available';
}; 