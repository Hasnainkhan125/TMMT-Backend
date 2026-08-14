// services/urlToAds/copyBankGenerator.js
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../lib/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateCopyBank(brand) {
  const prompt = `Generate an ad copy bank for this brand. Every output must be specific to THIS brand — no generic placeholders, no category drift.

Brand: ${brand.brandName || brand.canonicalDomain}
Category: ${brand.category || brand.businessType || 'unknown'}
Description: ${brand.description?.slice(0, 300)}
Real site headlines: ${(brand.content?.headlines || []).slice(0, 8).join(' | ')}
Markets: ${(brand.markets || ['AE']).join(', ')}

Generate:
- 5 punchy ad headlines (under 10 words each, specific to this brand's actual product/service)
- 3 Instagram captions (2-4 sentences, with line breaks, reference this brand's actual category)
- 5 CTAs (action verbs, 2-4 words, relevant to this category)
- 10 hashtags with # — must match this brand's actual category (e.g. if it's a pharmacy, use pharmacy/health/wellness hashtags NOT #gym or #fashion)
- 3 opening lines (curiosity hooks, <15 words)

Return JSON only:
{
  "headlines": ["...", ...],
  "captions": ["...", ...],
  "ctas": ["...", ...],
  "hashtags": ["#...", ...],
  "openingLines": ["...", ...]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no_json');
    
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      headlines:    parsed.headlines || [],
      captions:     parsed.captions || [],
      ctas:         parsed.ctas || [],
      hashtags:     parsed.hashtags || [],
      openingLines: parsed.openingLines || [],
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'copy bank generation failed');
    return {
      headlines: [], captions: [], ctas: [], hashtags: [], openingLines: [],
    };
  }
}

module.exports = { generateCopyBank };