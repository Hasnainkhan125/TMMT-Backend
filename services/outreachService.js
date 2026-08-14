/**
 * outreachService.js — Sales Cofounder: Apollo Lead Research + Email Outreach
 *
 * Apollo: Lead database + search (find B2B leads matching brand ICP)
 * Mailchimp: Opted-in welcome lists + brand kit recipients
 * SendGrid: Cold outreach emails (transactional, one-to-one)
 *
 * Per spec: Mailchimp is ONLY for opted-in users. Cold outreach uses transactional email.
 */

const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const { v4: uuidv4 } = require('uuid');
const BrandProject = require('../model/schema/brandProject');
const apollo = require('./apolloClient');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
// Apollo client is centralized in services/apolloClient.js — single base URL
// (https://api.apollo.io/api/v1) and single env-var lookup. The previous
// `https://api.apollo.io/v1` form was wrong and returned 404.
function getApolloKey() { return apollo.getApolloKey(); }
const APOLLO_BASE = apollo.APOLLO_BASE;

// ── ICP category mapping ─────────────────────────────────────────────────────
const ICP_MAP = {
  automotive:      { titles: ['Fleet Manager', 'Procurement Manager', 'Operations Manager', 'CEO', 'Owner', 'General Manager'], industryIds: [] },
  perfume:         { titles: ['Buyer', 'Category Manager', 'Retail Manager', 'Store Owner', 'CEO', 'Brand Manager'], industryIds: [] },
  skincare:        { titles: ['Buyer', 'Category Manager', 'Brand Manager', 'CEO', 'Founder', 'Marketing Manager'], industryIds: [] },
  food:            { titles: ['F&B Manager', 'Procurement Manager', 'Restaurant Owner', 'Operations Manager', 'CEO'], industryIds: [] },
  food_beverage:   { titles: ['F&B Manager', 'Procurement Manager', 'Restaurant Owner', 'Operations Manager', 'CEO'], industryIds: [] },
  tech:            { titles: ['CTO', 'IT Manager', 'Operations Manager', 'CEO', 'Founder', 'Head of Technology'], industryIds: [] },
  consulting:      { titles: ['CEO', 'Founder', 'Managing Director', 'Director', 'VP', 'Partner'], industryIds: [] },
  services:        { titles: ['CEO', 'Founder', 'Managing Director', 'Owner', 'Director', 'General Manager'], industryIds: [] },
  clothing:        { titles: ['Buyer', 'Category Manager', 'Retail Manager', 'Fashion Director', 'CEO'], industryIds: [] },
  wellness:        { titles: ['Facilities Manager', 'Property Manager', 'CEO', 'Procurement Manager', 'General Manager'], industryIds: [] },
  trading:         { titles: ['Procurement Manager', 'Import Manager', 'CEO', 'Owner', 'General Manager'], industryIds: [] },
  manufacturing:   { titles: ['Production Manager', 'Supply Chain Manager', 'CEO', 'Operations Manager'], industryIds: [] },
  default:         { titles: ['CEO', 'Founder', 'Managing Director', 'Owner', 'Director', 'General Manager'], industryIds: [] },
};

function buildICP(brand) {
  const cat = brand.businessType || brand.category || 'default';
  const agentTitles = (brand.agentMemory?.audience?.b2bTargets || []).map(t => t.decisionMaker).filter(Boolean);
  const base = ICP_MAP[cat] || ICP_MAP.default;
  return {
    titles: [...new Set([...base.titles, ...agentTitles])],
    industryIds: base.industryIds,
  };
}

// ── 1. Find leads via Apollo ─────────────────────────────────────────────────
async function findLeads(brandId, options = {}) {
  const { count = 25, page = 1 } = options;
  const brand = await BrandProject.findById(brandId);
  if (!brand) throw new Error('Brand not found');

  if (!getApolloKey()) throw new Error('Apollo API key not configured');

  const icp = buildICP(brand);

  const response = await axios.post(
    `${APOLLO_BASE}/mixed_people/search`,
    {
      api_key: getApolloKey(),
      q_person_title: icp.titles,
      person_locations: ['United Arab Emirates', 'Dubai', 'Abu Dhabi', 'Saudi Arabia', 'Kuwait', 'Qatar'],
      contact_email_status: ['verified', 'likely_to_engage'],
      per_page: count,
      page,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  const rawLeads = (response.data.people || []).map(p => ({
    id: uuidv4(),
    apolloId: p.id,
    firstName: p.first_name || '',
    lastName: p.last_name || '',
    fullName: p.name || '',
    email: p.email || null,
    emailVerified: p.email_status === 'verified',
    title: p.title || '',
    company: p.organization?.name || '',
    companySize: String(p.organization?.estimated_num_employees || ''),
    industry: p.organization?.industry || '',
    location: [p.city, p.country].filter(Boolean).join(', '),
    linkedinUrl: p.linkedin_url || '',
    website: p.organization?.website_url || '',
    source: 'apollo',
    leadStage: 'new',
    outreachMessages: [],
    addedAt: new Date(),
  }));

  const scoredLeads = await scoreLeads(rawLeads, brand);

  const existingIds = (brand.leads || []).map(l => l.apolloId).filter(Boolean);
  const newLeads = scoredLeads.filter(l => !existingIds.includes(l.apolloId));

  if (newLeads.length > 0) {
    await BrandProject.findByIdAndUpdate(brandId, {
      $push: { leads: { $each: newLeads, $slice: -500 } },
    });
  }

  return {
    found: rawLeads.length,
    added: newLeads.length,
    skipped: rawLeads.length - newLeads.length,
    leads: scoredLeads.sort((a, b) => b.icpScore - a.icpScore),
  };
}

// ── 2. Score leads with AI ───────────────────────────────────────────────────
async function scoreLeads(leads, brand) {
  if (leads.length === 0) return [];

  const cfg = brand.config?.brand || {};
  const usp = brand.agentMemory?.usp?.current || cfg.tagline || '';
  const painPoint = brand.agentMemory?.usp?.competitiveGap || '';
  const audience = brand.agentMemory?.audience?.primary?.description || '';

  const prompt = `Score these ${leads.length} B2B leads for this brand.

Brand: ${brand.projectName || cfg.brandName || 'Unnamed'}
Category: ${brand.businessType || 'General'}
USP: ${usp}
Target customer: ${audience}
Key pain point we solve: ${painPoint}

Score each lead 0-100 for ICP fit. Consider: title match, company relevance, location.
Also identify: what pain point they likely have, which USP angle to use.

Leads:
${leads.map((l, i) => `${i}: ${l.title} at ${l.company} (${l.industry}) — ${l.location}`).join('\n')}

Return ONLY a JSON array:
[{"index":0,"score":85,"rationale":"why good fit","painPoint":"their likely pain","angle":"USP angle to use"}]`;

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const scores = JSON.parse(text);

    return leads.map((lead, i) => {
      const s = scores.find(x => x.index === i) || { score: 50, rationale: '', painPoint: '', angle: '' };
      return { ...lead, icpScore: s.score, icpRationale: s.rationale, painPointMatched: s.painPoint, uspAngle: s.angle };
    });
  } catch (e) {
    console.error('[scoreLeads] AI scoring failed:', e.message);
    return leads.map(l => ({ ...l, icpScore: 50, icpRationale: 'Auto-scored', painPointMatched: '', uspAngle: '' }));
  }
}

// ── 3. Reveal email via Apollo ───────────────────────────────────────────────
async function revealEmail(apolloId) {
  const response = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { api_key: getApolloKey(), id: apolloId, reveal_personal_emails: false },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  const person = response.data.person;
  return {
    email: person?.email || null,
    verified: person?.email_status === 'verified',
  };
}

// ── 4. Generate outreach message ─────────────────────────────────────────────
async function generateMessage(brand, lead, sequenceNum = 1) {
  const cfg = brand.config?.brand || {};
  const usp = brand.agentMemory?.usp?.current || cfg.tagline || '';
  const competitiveAdv = brand.agentMemory?.usp?.competitiveAdvantage || '';
  const brandName = brand.projectName || cfg.brandName || 'Unnamed';

  const SEQUENCE_INSTRUCTIONS = {
    1: `First touch email. Lead with their specific pain point. Connect it to one specific thing ${brandName} does differently. End with ONE low-friction question. Under 100 words.`,
    2: `3-day follow-up. Different angle from email 1. Add one specific proof point. Acknowledge briefly that you reached out before. Under 80 words.`,
    3: `Final touch. 7 days after email 1. Acknowledge this is last message. Give something genuinely useful. Softest CTA. Under 70 words.`,
  };

  const prompt = `Write a cold email for ${brandName} to send to this prospect.

BRAND:
Name: ${brandName}
What we do: ${cfg.tagline || ''}
Our USP: ${usp}
Why choose us: ${competitiveAdv}

PROSPECT:
Name: ${lead.firstName}
Title: ${lead.title}
Company: ${lead.company}
Industry: ${lead.industry}
Location: ${lead.location}

WHY SELECTED: ${lead.icpRationale || ''}
THEIR PAIN POINT: ${lead.painPointMatched || ''}
USP ANGLE TO USE: ${lead.uspAngle || ''}

EMAIL INSTRUCTIONS (sequence ${sequenceNum}):
${SEQUENCE_INSTRUCTIONS[sequenceNum] || SEQUENCE_INSTRUCTIONS[1]}

HARD RULES:
- Use ${lead.firstName}'s name once in opening
- Never say 'I hope this finds you well'
- Never say 'I wanted to reach out'
- Never use [brackets] or placeholders
- Subject line: under 45 chars, specific to their role or company
- Make every sentence earn its place

Return ONLY this JSON:
{"subject":"string","body":"string","previewText":"string","sequenceNumber":${sequenceNum}}`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.replace(/```json|```/g, '').trim();
  const message = JSON.parse(text);

  const msgObject = {
    id: uuidv4(),
    ...message,
    channel: 'email',
    aiGenerated: true,
    edited: false,
    status: 'draft',
  };

  if (brand._id) {
    await BrandProject.findOneAndUpdate(
      { _id: brand._id, 'leads.id': lead.id },
      { $push: { 'leads.$.outreachMessages': msgObject } }
    );
  }

  return msgObject;
}

// ── 5. Send email via SendGrid (transactional cold outreach) ─────────────────
async function sendEmail(brandId, leadId, messageId) {
  const brand = await BrandProject.findById(brandId);
  if (!brand) throw new Error('Brand not found');

  const lead = (brand.leads || []).find(l => l.id === leadId);
  const message = lead?.outreachMessages?.find(m => m.id === messageId);

  if (!lead || !message) throw new Error('Lead or message not found');
  if (message.status !== 'draft' && message.status !== 'approved') {
    throw new Error('Message must be draft or approved to send');
  }

  let emailToSend = lead.email;
  if (!emailToSend && lead.apolloId) {
    const revealed = await revealEmail(lead.apolloId);
    emailToSend = revealed.email;
    if (emailToSend) {
      await BrandProject.findOneAndUpdate(
        { _id: brandId, 'leads.id': leadId },
        { $set: { 'leads.$.email': emailToSend, 'leads.$.emailVerified': revealed.verified } }
      );
    }
  }

  if (!emailToSend) throw new Error('No email found for this lead');

  const cfg = brand.config?.brand || {};
  const brandName = brand.projectName || cfg.brandName || 'Qumak';

  // Send via SendGrid (already in stack)
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const emailHtml = `
<div style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="white-space: pre-wrap; line-height: 1.6;">${message.body.replace(/\n/g, '<br>')}</div>
  <br>
  <div style="color: #666; font-size: 13px;">
    &mdash;<br>
    ${brandName}
  </div>
</div>`;

  await sgMail.send({
    to: emailToSend,
    from: { email: process.env.SENDGRID_FROM_EMAIL || 'outreach@qumak.io', name: brandName },
    subject: message.subject,
    html: emailHtml,
    customArgs: { brandId: brandId.toString(), leadId, messageId },
  });

  await BrandProject.findOneAndUpdate(
    { _id: brandId, 'leads.id': leadId, 'leads.outreachMessages.id': messageId },
    {
      $set: {
        'leads.$[lead].outreachMessages.$[msg].status': 'sent',
        'leads.$[lead].outreachMessages.$[msg].sentAt': new Date(),
        'leads.$[lead].leadStage': 'contacted',
        'leads.$[lead].lastContactedAt': new Date(),
      },
    },
    { arrayFilters: [{ 'lead.id': leadId }, { 'msg.id': messageId }] }
  );

  return { sent: true, to: emailToSend };
}

// ── 6. Add to Mailchimp welcome list (opted-in only) ─────────────────────────
async function addToMailchimpWelcome(email, brandName, firstName) {
  const apiKey = process.env.QUMAK_MAILCHIMP_API_KEY || process.env.MAILCHIMP_API_KEY;
  if (!apiKey) return { added: false, reason: 'no_api_key' };

  const serverPrefix = apiKey.split('-').pop();
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!listId) return { added: false, reason: 'no_list_id' };

  try {
    await axios.post(
      `https://${serverPrefix}.api.mailchimp.com/3.0/lists/${listId}/members`,
      {
        email_address: email,
        status: 'subscribed',
        merge_fields: { FNAME: firstName || '', BRAND: brandName || '' },
      },
      {
        headers: {
          Authorization: `apikey ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    return { added: true };
  } catch (e) {
    if (e.response?.status === 400) return { added: false, reason: 'already_subscribed' };
    console.error('[Mailchimp]', e.response?.data?.title || e.message);
    return { added: false, reason: e.message };
  }
}

// ── 7. Get leads for a brand ─────────────────────────────────────────────────
async function getLeads(brandId, options = {}) {
  const { stage, minScore = 0, limit = 50 } = options;
  const brand = await BrandProject.findById(brandId).select('leads').lean();
  if (!brand) throw new Error('Brand not found');

  let leads = brand.leads || [];
  if (stage) leads = leads.filter(l => l.leadStage === stage);
  if (minScore > 0) leads = leads.filter(l => (l.icpScore || 0) >= minScore);
  return leads.sort((a, b) => (b.icpScore || 0) - (a.icpScore || 0)).slice(0, limit);
}

module.exports = {
  findLeads,
  scoreLeads,
  revealEmail,
  generateMessage,
  sendEmail,
  addToMailchimpWelcome,
  getLeads,
  buildICP,
};
