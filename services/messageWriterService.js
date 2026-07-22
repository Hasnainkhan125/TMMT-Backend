/**
 * messageWriterService.js — AI-powered personalized cold email writer
 *
 * Uses Anthropic claude-haiku-4-5-20251001 to write email sequences.
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const BrandProject = require('../model/schema/brandProject');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
const MODEL     = 'claude-haiku-4-5-20251001';

// ── Sequence instructions ─────────────────────────────────────────────────────
const SEQUENCE_RULES = {
  1: {
    label:       'First touch',
    instruction: 'Write a first-touch cold email. Lead with a specific pain point relevant to their role. Connect it to one concrete thing the brand does differently. End with exactly ONE low-friction question. Value-first tone. Under 120 words total.',
    maxWords:    120,
  },
  2: {
    label:       '3-day follow-up',
    instruction: 'Write a 3-day follow-up email. Use a completely different angle from the first email. Add one specific social proof point (a result, case study, or data point). Briefly acknowledge the previous email in one sentence. Under 80 words total.',
    maxWords:    80,
  },
  3: {
    label:       '7-day final',
    instruction: 'Write a 7-day final follow-up email. Offer one genuinely useful tip or insight relevant to their role — not a pitch. Soft CTA only (no pressure). Under 60 words total.',
    maxWords:    60,
  },
};

/**
 * writeEmailSequence — generates a single email for the given sequence number.
 * @param {object} brand
 * @param {object} lead
 * @param {number} sequenceNumber - 1, 2, or 3
 * @returns {{ subject, body, previewText, sequenceNumber, angle }}
 */
async function writeEmailSequence(brand, lead, sequenceNumber = 1) {
  const seq = SEQUENCE_RULES[sequenceNumber] || SEQUENCE_RULES[1];

  const cfg       = brand.config?.brand || {};
  const brandName = brand.projectName   || cfg.brandName   || 'Our Brand';
  const category  = brand.businessType  || 'General';
  const usp       = brand.agentMemory?.usp?.current || cfg.tagline || '';
  const painPoint = brand.agentMemory?.usp?.customerPainPoints?.[0] || '';
  const socialProof = (brand.agentMemory?.audience?.b2bTargets || [])
    .map(t => t.coldEmailTemplate)
    .filter(Boolean)[0] || '';

  const leadContext = [
    `Name: ${lead.firstName || lead.fullName || 'there'}`,
    `Title: ${lead.title || 'unknown title'}`,
    `Company: ${lead.company || 'unknown company'}`,
    `Industry: ${lead.industry || 'unknown industry'}`,
    `Location: ${lead.location || 'UAE/GCC'}`,
    lead.painPointMatched ? `Known pain point: ${lead.painPointMatched}` : '',
    lead.uspAngle         ? `Recommended angle: ${lead.uspAngle}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `You are a B2B sales copywriter. Write an outreach email for the following scenario.

BRAND:
Name: ${brandName}
Category: ${category}
USP: ${usp}
Key pain point solved: ${painPoint}
${socialProof ? `Social proof: ${socialProof}` : ''}

LEAD:
${leadContext}

TASK:
${seq.instruction}

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "subject": "email subject line",
  "body": "plain text email body — no HTML tags",
  "previewText": "preview snippet (max 90 chars)",
  "sequenceNumber": ${sequenceNumber},
  "angle": "one-sentence description of the angle used"
}`;

  const response = await getAnthropic().messages.create({
    model:      MODEL,
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(text);

  return {
    id:             uuidv4(),
    subject:        parsed.subject     || '',
    body:           parsed.body        || '',
    previewText:    parsed.previewText || '',
    sequenceNumber: parsed.sequenceNumber || sequenceNumber,
    angle:          parsed.angle       || '',
    aiGenerated:    true,
    edited:         false,
    status:         'draft',
    channel:        'email',
  };
}

/**
 * writeBatchMessages — generates sequence 1 emails for up to 10 leads.
 * @param {object} brand
 * @param {Array}  leads
 * @returns {Array} array of { leadId, message } objects
 */
async function writeBatchMessages(brand, leads) {
  const batch = leads.slice(0, 10);

  const results = [];
  for (const lead of batch) {
    try {
      const message = await writeEmailSequence(brand, lead, 1);
      results.push({ leadId: lead.id, message });
    } catch (err) {
      console.error(`[writeBatchMessages] Failed for lead ${lead.id}:`, err.message);
      results.push({ leadId: lead.id, error: err.message });
    }
  }

  return results;
}

/**
 * learnFromReply — extracts learnings from a lead reply and saves to agentMemory.
 * @param {object} brand
 * @param {object} lead
 * @param {string} replyText
 * @param {string} outcome - 'positive' | 'negative' | 'neutral' | 'meeting'
 * @returns {object} updated brand agentMemory fragment
 */
async function learnFromReply(brand, lead, replyText, outcome = 'neutral') {
  const cfg       = brand.config?.brand || {};
  const brandName = brand.projectName   || cfg.brandName || 'Our Brand';

  const prompt = `You are a sales intelligence analyst. A lead replied to a cold email.

Brand: ${brandName}
Lead: ${lead.title || ''} at ${lead.company || ''} (${lead.industry || ''})
Outcome: ${outcome}
Reply: "${replyText}"

Extract:
1. What worked (if positive/meeting outcome)
2. What objection or concern emerged (if negative)
3. One concrete learning to improve future emails to this segment

Return ONLY valid JSON:
{
  "learning": "one sentence learning",
  "whatWorked": "what resonated (or null)",
  "objection": "objection raised (or null)",
  "suggestedAdjustment": "tweak for future emails to this segment"
}`;

  try {
    const response = await getAnthropic().messages.create({
      model:      MODEL,
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text   = response.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    // Persist learning into brand agentMemory contentInsights
    const insight = {
      topic:           parsed.learning || '',
      platform:        'email',
      postedAt:        new Date(),
      performanceNote: `${outcome} reply from ${lead.title || ''} at ${lead.company || ''}`,
      agentLearning:   parsed.suggestedAdjustment || '',
    };

    await BrandProject.findByIdAndUpdate(brand._id, {
      $push: { 'agentMemory.contentInsights': { $each: [insight], $slice: -50 } },
    });

    return parsed;
  } catch (err) {
    console.error('[learnFromReply] Failed to extract learning:', err.message);
    return { learning: '', whatWorked: null, objection: null, suggestedAdjustment: '' };
  }
}

module.exports = {
  writeEmailSequence,
  writeBatchMessages,
  learnFromReply,
};
