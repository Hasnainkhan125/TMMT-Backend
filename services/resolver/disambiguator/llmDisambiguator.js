// services/resolver/disambiguator/llmDisambiguator.js
// Claude Haiku-based disambiguation when signals conflict.
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Disambiguate conflicting social handle candidates.
 * Use only when cross-verification is inconclusive (conf < 0.7).
 */
async function disambiguateSocialHandle({
  platform,                // 'facebook' | 'instagram' | ...
  candidates,              // [{ handle, url, evidence }]
  brand: { name, description, canonicalDomain },
}) {
  if (!candidates || candidates.length === 0) {
    return { match: null, confidence: 0 };
  }
  
  if (candidates.length === 1 && candidates[0].confidence > 0.8) {
    return { match: candidates[0], confidence: candidates[0].confidence };
  }
  
  const prompt = `You are verifying which ${platform} handle belongs to the brand "${name}".

Brand context:
- Website: ${canonicalDomain}
- Description: ${description || 'N/A'}

Candidates:
${candidates.map((c, i) => `
[${i + 1}] Handle: ${c.handle}
    URL: ${c.url}
    Evidence: ${JSON.stringify(c.evidence || {})}
`).join('\n')}

Task: Pick the candidate most likely to be the official ${platform} presence of this brand.
Respond with JSON only, no preamble:
{
  "pickIndex": <1-based index or null if none>,
  "confidence": <0-1>,
  "reasoning": "<one sentence>"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no_json_in_response');
    
    const parsed = JSON.parse(jsonMatch[0]);
    const picked = parsed.pickIndex ? candidates[parsed.pickIndex - 1] : null;
    
    return {
      match: picked,
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning,
      source: 'llm_disambiguation',
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'LLM disambiguation failed');
    return { match: candidates[0], confidence: candidates[0].confidence || 0.5, reasoning: 'fallback_first' };
  }
}

/**
 * Classify business type from homepage content.
 * Returns one of the BrandIdentity.businessType enum values.
 */
async function classifyBusinessType({ brandName, description, headlines, title, metaDescription }) {
  const prompt = `Classify this business from its homepage:

Brand name: ${brandName || 'Unknown'}
Title: ${title || ''}
Description: ${description || metaDescription || ''}
Top headlines: ${(headlines || []).slice(0, 8).join(' | ')}

Classify into EXACTLY ONE of these categories (use the code):
- product_brand (DTC/ecommerce products like clothing, food, gadgets)
- restaurant
- cafe
- clinic_medical
- clinic_dental
- clinic_cosmetic
- real_estate
- fitness_gym
- law_firm
- beauty_salon
- automotive
- saas_b2b (B2B software as a service)
- saas_b2c (B2C software/apps)
- education
- hospitality (hotels, resorts)
- events_wedding
- marketing_agency (digital marketing, SEO, ads)
- creative_agency (branding, design, video production)
- consulting (management, strategy, advisory)
- professional_services (accounting, legal services outside law firms)
- general_business (last resort)


Return JSON only:
{
  "businessType": "<code>",
  "subtype": "<specific niche, e.g. 'luxury skincare' or 'wedding photography'>",
  "confidence": <0-1>,
  "reasoning": "<one sentence>"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no_json_in_response');
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn({ err: err.message }, 'business type classification failed');
    return { businessType: 'general_business', confidence: 0.2, reasoning: 'fallback' };
  }
}

module.exports = { disambiguateSocialHandle, classifyBusinessType };