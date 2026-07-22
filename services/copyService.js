'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const AdCopy = require('../model/schema/adCopy');

const MODEL = 'claude-haiku-4-5-20251001';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─── Hook formulas injected by category ───────────────────────────────────

const HOOK_FORMULAS = {
  gym:        'Hook formula: "[Negative state]. Start [positive transformation]." — address pain first, transformation second.',
  realestate: 'Hook formula: "Every week you wait, [consequence]. [Brand] changes that." — consequence-driven urgency.',
  perfume:    'Hook formula: "The scent that [emotional outcome]." — identity and desire, not product features.',
  restaurant: 'Hook formula: "The [food/experience] Dubai can\'t stop talking about." — social proof and place.',
  skincare:   'Hook formula: "Your skin in 30 days. [Before] → [After]." — concrete transformation timeline.',
  saas:       'Hook formula: "[Pain point] is costing you [specific outcome]. Fix it today." — pain + cost + urgency.',
  service:    'Hook formula: "[Struggle]. [Brand] handles it — so you don\'t have to." — relief and delegation.'
};

// ─── Category area references for Gulf market ─────────────────────────────

const GULF_AREA_HINTS = {
  realestate: 'Reference specific Dubai areas where relevant: JBR, Downtown Dubai, Dubai Marina, Palm Jumeirah, Business Bay, Dubai Hills, DIFC.',
  restaurant:  'Reference UAE hospitality culture, family gatherings, and occasions like Eid and National Day where relevant.',
  gym:         'Reference Dubai fitness culture: morning workouts before the heat, transformation goals, Dubai Marina running track, premium club culture.',
  perfume:     'Reference oud tradition, bakhoor culture, luxury positioning. Never discount framing.',
  saas:        'Reference DIFC and Dubai tech ecosystem, business efficiency in the UAE market.',
  service:     'Reference UAE business environment, Mainland/Freezone context if relevant, professional trust signals.'
};

// ─── Platform rules ────────────────────────────────────────────────────────

const PLATFORM_RULES = {
  instagram: 'Instagram caption format: opening hook (first line before "more" — make it impossible to scroll past) + body + CTA + hashtags. Hook under 125 characters. Full caption 100-150 words sweet spot.',
  facebook:  'Facebook: storytelling works. Longer form ok (100-150 words). Emotional narrative. Lead with a question or bold claim. Audience: slightly older, more decision-ready.',
  tiktok:    'TikTok: FIRST 3 WORDS ARE EVERYTHING. Max 30 words visible. Punchy, lowercase-friendly, native-feeling. No corporate speak. Sound-on assumption: write for someone watching with audio.',
  whatsapp:  'WhatsApp: conversational, NOT ad-speak. Personal tone like a friend recommending something. Max 50 words. No hashtags. Direct and warm.'
};

// ─── Build the system prompt ────────────────────────────────────────────────

function buildSystemPrompt(category, platform, locale) {
  const hookFormula = HOOK_FORMULAS[category] || HOOK_FORMULAS.service;
  const gulfHint = GULF_AREA_HINTS[category] || '';
  const platformRule = PLATFORM_RULES[platform] || PLATFORM_RULES.instagram;

  return `You are an elite performance marketing copywriter with 10 years experience creating high-converting ads for Meta, TikTok, and Instagram. You specialize in the UAE/Gulf market and understand direct response principles, emotional triggers, and platform-specific copy.

PLATFORM RULES:
${platformRule}

${locale === 'gulf' ? `GULF MARKET COPY RULES:
- Never use aggressive scarcity ("LAST CHANCE!!!") — reads cheap in UAE premium market
- Use confident scarcity instead: "Delivery slots this week are filling fast"
- Ramadan context: warmth over urgency, family over individual, reflection themes
- Price mentions: always in AED for local ads, never show discount framing for luxury categories
- Arabic transliteration of key words boosts engagement in bilingual feeds (e.g. "habibi", "yalla")
${gulfHint}` : `GLOBAL MARKET RULES:
- Clear value proposition first
- Universal emotional triggers: status, belonging, transformation, simplicity
- No regional specifics`}

EMOTIONAL TRIGGERS BY CATEGORY:
- realestate: status, security, generational wealth, market timing
- gym: identity transformation (not just physical — who they become)
- perfume: memory, desire, exclusivity, identity
- restaurant: belonging, culture, occasion, shared experience
- saas: time saved, competitive edge, simplicity, control
- service: trust, relief, expertise proof, time reclaimed

CTA HIERARCHY (match to funnel stage):
- Awareness: "Explore" / "Discover" / "See how"
- Consideration: "Learn more" / "Reserve your spot"
- Conversion: "Book now" / "Start today" / "Get yours"

${hookFormula}

OUTPUT FORMAT:
Output ONLY valid JSON — no markdown, no explanation, no preamble. Exactly this structure:
{
  "captions": ["caption1 (80-120 words, full storytelling)", "caption2 (50-70 words, concise)", "caption3 (20-30 words, punchy hook only)"],
  "headlines": ["headline1 (6-10 words)", "headline2 (6-10 words, different angle)"],
  "ctas": ["cta1 (2-4 words, strong)", "cta2 (2-4 words, softer)"],
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8", "#tag9", "#tag10"]
}

Hashtags: mix of niche (specific to category + location) and broad (fitness, luxury, etc). No spaces. UAE-specific tags where locale is gulf.`;
}

// ─── Generate copy ─────────────────────────────────────────────────────────

/**
 * generateCopy — generates platform-optimized ad copy and persists to DB.
 * @param {object} params
 * @param {string} params.assetId
 * @param {string} params.jobId
 * @param {string} params.category
 * @param {string} params.brandName
 * @param {string} params.platform — 'instagram'|'facebook'|'tiktok'|'whatsapp'
 * @param {string} params.locale — 'gulf'|'global'
 * @param {string} [params.adStructure] — e.g. "problem → solution → CTA"
 * @param {string} [params.targetAudience]
 * @returns {object} { captions, headlines, ctas, hashtags }
 */
async function generateCopy({ assetId, jobId, category, brandName, platform = 'instagram', locale = 'gulf', adStructure, targetAudience }) {
  const systemPrompt = buildSystemPrompt(category, platform, locale);

  const categoryLabel = {
    gym: 'gym and fitness brand',
    realestate: 'luxury real estate developer in Dubai',
    perfume: 'luxury perfume and fragrance brand',
    restaurant: 'restaurant and dining experience',
    saas: 'SaaS and technology product',
    service: 'professional service business'
  }[category] || category;

  let userPrompt = `Brand: "${brandName}" — ${categoryLabel}
Platform: ${platform}
Locale: ${locale === 'gulf' ? 'UAE/Gulf market' : 'Global market'}`;

  if (targetAudience) userPrompt += `\nTarget audience: ${targetAudience}`;
  if (adStructure) userPrompt += `\nAd structure to follow: ${adStructure}`;

  userPrompt += `\n\nGenerate high-converting ad copy for this brand. Apply all platform rules and market intelligence from your instructions.`;

  const callClaude = async (stricterInstruction = false) => {
    const messages = [{ role: 'user', content: stricterInstruction
      ? userPrompt + '\n\nIMPORTANT: Output ONLY the raw JSON object. No markdown. No explanation. Start with { and end with }.'
      : userPrompt
    }];

    const response = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages
    });

    const text = response.content[0]?.text || '';
    // Strip any markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  };

  let parsed;
  try {
    parsed = await callClaude(false);
  } catch (err) {
    console.warn('[copyService] First parse failed, retrying with stricter instruction:', err.message);
    try {
      parsed = await callClaude(true);
    } catch (retryErr) {
      throw new Error(`copyService: Failed to parse Claude response after retry: ${retryErr.message}`);
    }
  }

  // Validate structure
  if (!Array.isArray(parsed.captions) || parsed.captions.length < 3) throw new Error('copyService: invalid captions in response');
  if (!Array.isArray(parsed.headlines) || parsed.headlines.length < 2) throw new Error('copyService: invalid headlines in response');
  if (!Array.isArray(parsed.ctas) || parsed.ctas.length < 2) throw new Error('copyService: invalid ctas in response');
  if (!Array.isArray(parsed.hashtags) || parsed.hashtags.length < 5) throw new Error('copyService: insufficient hashtags in response');

  // Persist
  await AdCopy.create({
    assetId,
    jobId,
    category,
    brandName,
    captions: parsed.captions.slice(0, 3),
    headlines: parsed.headlines.slice(0, 2),
    ctas: parsed.ctas.slice(0, 2),
    hashtags: parsed.hashtags.slice(0, 10),
    platform,
    locale,
    modelUsed: MODEL
  });

  return {
    captions: parsed.captions.slice(0, 3),
    headlines: parsed.headlines.slice(0, 2),
    ctas: parsed.ctas.slice(0, 2),
    hashtags: parsed.hashtags.slice(0, 10)
  };
}

module.exports = { generateCopy };
