// services/urlToAds/adBlueprintGenerator.js
// Generates 3 ad blueprint variants from a resolved brand identity.
// These are PENDING ads — the user clicks "Generate" to actually render.

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../lib/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BLUEPRINT_TEMPLATES = [
  {
    label:       'Hero launch',
    vibe:        'confident-minimal',
    aspectRatio: '1:1',
    category:    'hero_shot',
    modelId:     'flux-pro',
  },
  {
    label:       'Social vertical',
    vibe:        'editorial',
    aspectRatio: '9:16',
    category:    'story_format',
    modelId:     'flux-pro',
  },
  {
    label:       'Urgency + stock',
    vibe:        'urgent',
    aspectRatio: '4:5',
    category:    'conversion',
    modelId:     'flux-schnell',
  },
];

async function generateAdBlueprints(brand) {
  const variantPrompts = await Promise.all(
    BLUEPRINT_TEMPLATES.map(template => generateVariant(brand, template))
  );
  
  return variantPrompts.map((variant, idx) => ({
    ...BLUEPRINT_TEMPLATES[idx],
    headline:    variant.headline,
    hookLine:    variant.hookLine,
    body:        variant.body,
    cta:         variant.cta,
    prompt:      variant.prompt,
    negativePrompt: 'low quality, blurry, distorted, watermark, text artifacts',
    referenceImageUrl: brand.assets?.heroImages?.[idx] || null,
    status:      'pending',
  }));
}

async function generateVariant(brand, template) {
  const primary = brand.assets?.brandColors?.primary || '#1a1a1a';
  const businessType = brand.businessType || 'general_business';
  const brandName = brand.brandName || brand.canonicalDomain;
  
  const prompt = `You're creating an ad blueprint for a Gulf SME.

Brand: ${brandName}
Type: ${businessType} (${brand.subtype || 'general'})
Description: ${brand.description?.slice(0, 200)}
Real headlines from their site: ${(brand.content?.headlines || []).slice(0, 6).join(' | ')}
Markets: ${(brand.markets || ['AE']).join(', ')}

Create a "${template.label}" ad variant in "${template.vibe}" vibe, aspect ${template.aspectRatio}.

Constraints:
- Headline MUST be under 8 words, punchy
- Hook line is 1 short sentence setting context
- Body is 1-2 sentences of value prop
- CTA is 2-4 words, action-oriented
- Image prompt should be PHOTOREALISTIC, cinematic, with brand color ${primary}
- No stock photography tropes, no cheesy language
- If Arabic audience, respect cultural norms (no alcohol, modest aesthetics)

Return JSON only:
{
  "headline": "...",
  "hookLine": "...",
  "body": "...",
  "cta": "...",
  "prompt": "Photorealistic ad image: ..."
}`;
  
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no_json');
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn({ err: err.message, template: template.label }, 'ad blueprint generation failed');
    // Deterministic fallback
    return {
      headline: `${brandName} — ${template.label}`,
      hookLine: brand.tagline?.slice(0, 80) || 'Premium, curated for you.',
      body:     brand.description?.slice(0, 150) || 'Discover what sets us apart.',
      cta:      'Learn more',
      prompt:   `Cinematic product photo for ${brandName}, ${template.vibe} aesthetic, brand color ${primary}`,
    };
  }
}

module.exports = { generateAdBlueprints };