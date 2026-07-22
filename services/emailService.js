/**
 * emailService.js — Nodemailer email queue for brand follow-ups
 * Uses SMTP (Resend recommended, or Gmail for dev)
 */
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || process.env.SENDGRID_FROM_EMAIL,
    pass: process.env.SMTP_PASS || process.env.SENDGRID_API_KEY,
  },
});

const FROM = `Qumak Brand Engine <${process.env.SENDGRID_FROM_EMAIL || 'brands@qumak.ae'}>`;

function brandReadyTemplate(data) {
  return {
    subject: `Your brand "${data.brandName}" is ready — save it before it expires`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:0;background:#f7fafc;font-family:'Helvetica Neue',Arial,sans-serif;}
      .wrap{max-width:600px;margin:0 auto;background:#fff;}
      .hero{background:linear-gradient(135deg,#944a00,#fc8f34);padding:48px 40px;text-align:center;}
      .hero h1{color:#fff;font-size:32px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em;}
      .hero p{color:rgba(255,255,255,0.8);font-size:15px;margin:0;}
      .body{padding:40px;}
      .brand-name{font-size:28px;font-weight:800;color:#944a00;letter-spacing:-0.03em;margin:0 0 6px;}
      .cta{display:block;background:linear-gradient(135deg,#944a00,#fc8f34);color:#fff;text-decoration:none;text-align:center;padding:16px 32px;border-radius:9999px;font-size:16px;font-weight:700;margin:24px 0;}
      .timer{background:#0f0f0f;color:#fc8f34;text-align:center;padding:16px;border-radius:12px;font-size:13px;margin:16px 0;}
      .footer{padding:24px 40px;background:#f7fafc;text-align:center;}
      .footer p{font-size:11px;color:#9ca3af;margin:0;}
    </style></head><body>
    <div class="wrap">
      <div class="hero"><h1>Your brand is alive.</h1><p>Everything is ready — you just need to save it.</p></div>
      <div class="body">
        <div class="brand-name">${data.brandName}</div>
        <p style="font-size:14px;color:#6b7280;font-style:italic;margin:0 0 20px;">${data.tagline || ''}</p>
        <p style="font-size:14px;color:#374151;line-height:1.7;">You've done the hard part — brand identity, marketing kit, and supplier brief are all generated. Don't let it expire.</p>
        <a href="${process.env.FRONTEND_URL}/brand-builder?project=${data.projectId}" class="cta">Open My Brand →</a>
        <div class="timer">⏱ Your brand kit auto-deletes in <strong>23 hours</strong> — save it free with a Qumak account</div>
        <p style="font-size:13px;color:#6b7280;line-height:1.7;margin-top:24px;">Next step: <strong>Trade License from AED 9,999</strong> — operational in 3–5 business days.</p>
      </div>
      <div class="footer"><p>Qumak · Dubai, UAE · <a href="${process.env.FRONTEND_URL}/unsubscribe?token=${data.unsubToken}" style="color:#9ca3af;">Unsubscribe</a></p></div>
    </div></body></html>`,
  };
}

function followUp1Template(data) {
  return {
    subject: `3 brands like "${data.brandName}" launched on Qumak today`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:0;background:#f7fafc;font-family:'Helvetica Neue',Arial,sans-serif;}
      .wrap{max-width:600px;margin:0 auto;background:#fff;}
      .hero{background:#0f0f0f;padding:40px;text-align:center;}
      .hero h1{color:#fff;font-size:26px;font-weight:800;margin:0 0 8px;}
      .hero p{color:rgba(255,255,255,0.5);font-size:13px;margin:0;}
      .body{padding:36px 40px;}
      .proof-item{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #f1f4f6;align-items:center;}
      .dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#944a00,#fc8f34);flex-shrink:0;margin-top:3px;}
      .cta{display:block;background:linear-gradient(135deg,#944a00,#fc8f34);color:#fff;text-decoration:none;text-align:center;padding:15px 28px;border-radius:9999px;font-size:15px;font-weight:700;margin:28px 0;}
      .footer{padding:20px 40px;background:#f7fafc;text-align:center;}
      .footer p{font-size:11px;color:#9ca3af;margin:0;}
    </style></head><body>
    <div class="wrap">
      <div class="hero"><h1>While your brand waits, others are launching.</h1><p>Here's what happened in the last 24 hours on Qumak.</p></div>
      <div class="body">
        <div class="proof-item"><div class="dot"></div><div style="font-size:13px;color:#374151;">A perfume brand <strong>"Malik Noir"</strong> got their RAKEZ trade license — AED 9,999</div></div>
        <div class="proof-item"><div class="dot"></div><div style="font-size:13px;color:#374151;">A skincare dropship store launched with 3 products, first order in 72 hours</div></div>
        <div class="proof-item"><div class="dot"></div><div style="font-size:13px;color:#374151;"><strong>"Lumina Glow"</strong> connected Instagram + TikTok, automated posting live</div></div>
        <p style="font-size:14px;color:#374151;line-height:1.7;margin-top:24px;">Your brand <strong style="color:#944a00;">${data.brandName}</strong> is still saved. The only thing missing is you clicking the button below.</p>
        <a href="${process.env.FRONTEND_URL}/brand-builder?project=${data.projectId}" class="cta">Continue Building ${data.brandName} →</a>
      </div>
      <div class="footer"><p>Qumak · Dubai, UAE · <a href="${process.env.FRONTEND_URL}/unsubscribe?token=${data.unsubToken}" style="color:#9ca3af;">Unsubscribe</a></p></div>
    </div></body></html>`,
  };
}

function followUp2Template(data) {
  return {
    subject: `Last chance — "${data.brandName}" deletes in 6 hours`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:0;background:#f7fafc;font-family:'Helvetica Neue',Arial,sans-serif;}
      .wrap{max-width:600px;margin:0 auto;background:#fff;}
      .hero{background:linear-gradient(135deg,#7f1d1d,#dc2626);padding:40px;text-align:center;}
      .hero h1{color:#fff;font-size:24px;font-weight:800;margin:0 0 8px;}
      .hero .timer{color:rgba(255,255,255,0.9);font-size:36px;font-weight:800;font-family:monospace;letter-spacing:0.05em;}
      .body{padding:36px 40px;}
      .cta{display:block;background:linear-gradient(135deg,#944a00,#fc8f34);color:#fff;text-decoration:none;text-align:center;padding:16px 28px;border-radius:9999px;font-size:16px;font-weight:800;margin:24px 0;}
      .footer{padding:20px 40px;background:#f7fafc;text-align:center;}
      .footer p{font-size:11px;color:#9ca3af;margin:0;}
    </style></head><body>
    <div class="wrap">
      <div class="hero"><h1>"${data.brandName}" expires soon</h1><div class="timer">06:00:00</div></div>
      <div class="body">
        <p style="font-size:15px;color:#374151;line-height:1.75;margin:0 0 20px;">We built your brand, color palette, fragrance pyramid, supplier brief, and full marketing kit. It took the AI 18 seconds. It would cost an agency AED 8,000–15,000 and 3 weeks.</p>
        <p style="font-size:15px;color:#374151;line-height:1.75;">All of it gets deleted in 6 hours unless you save it. It's free.</p>
        <a href="${process.env.FRONTEND_URL}/brand-builder?project=${data.projectId}&utm_source=expiry_email" class="cta">Save ${data.brandName} Now — It's Free →</a>
      </div>
      <div class="footer"><p>Qumak · Dubai, UAE · <a href="${process.env.FRONTEND_URL}/unsubscribe?token=${data.unsubToken}" style="color:#9ca3af;">Unsubscribe</a></p></div>
    </div></body></html>`,
  };
}

function getTemplate(templateId, data) {
  switch (templateId) {
    case 'brand_ready':  return brandReadyTemplate(data);
    case 'follow_up_1':  return followUp1Template(data);
    case 'follow_up_2':  return followUp2Template(data);
    default: throw new Error(`Unknown template: ${templateId}`);
  }
}

async function queueEmail(submissionId, userId, to, templateId, templateData) {
  const template = getTemplate(templateId, templateData);
  try {
    const info = await transporter.sendMail({
      from: FROM,
      to,
      subject: template.subject,
      html: template.html,
    });
    console.log(`[EmailService] Sent ${templateId} to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EmailService] Failed to send ${templateId} to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { queueEmail, getTemplate };
