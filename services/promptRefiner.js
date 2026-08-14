'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─── Video: motion / camera / continuity ─────────────────────────────────────

const MUTATION_GUIDE_VIDEO = `When the instruction says:
- "make it darker" → replace lighting descriptors with deep shadows, crushed blacks, low-key grade, dramatic contrast
- "more minimal" → reduce atmospheric detail, add "negative space", "clean composition", remove decorative elements
- "add more energy" → add "dynamic camera movement", "fast cuts", "handheld energy", "motion blur", remove static descriptors
- "more luxury" → add "opulent", "premium materials", "bespoke", "world-class", elevate every material reference
- "different angle" → change the CAMERA section: replace current angle with drone/low-angle/extreme close-up/overhead
- "less people" → append "no people, no faces" to negative prompt, shift focus to product/space/environment
- "Gulf style" → inject "Dubai", "UAE", "Arabic aesthetic", relevant Gulf cultural markers into VISUAL WORLD
- "more product focused" → move product to VISUAL WORLD foreground, add "product hero shot", "detail macro"
- "brighter" → change lighting to "high-key", "bright fill light", "airy", "sun-drenched"
- "more cinematic" → add "anamorphic lens", "film grain", "letterbox ratio", "cinematic color grade"
- "corporate feel" → add "clean professional", "boardroom aesthetic", "confident executive", remove playful elements
- "warmer" → change color descriptors to "warm amber", "golden tones", "warm whites", adjust grade to luxury_warm`;

// ─── Image: composition / lighting / still detail ────────────────────────────

const MUTATION_GUIDE_IMAGE = `When the instruction says:
- "make it darker" → deepen shadows, low-key lighting, richer blacks, moodier atmosphere (still image, no camera movement)
- "more minimal" → simplify background, negative space, fewer props, cleaner horizon
- "add more energy" → stronger diagonal composition, bolder contrast, more saturated focal accent, dynamic pose or product angle (not video motion)
- "more luxury" → premium materials, subtle reflections, editorial polish, restrained palette
- "different angle" → change viewpoint: overhead, three-quarter, macro detail, worm's-eye, etc.
- "less people" → remove or de-emphasize people; focus on product, interior, or landscape
- "Gulf style" → Dubai/UAE cues, regional architecture or lifestyle markers where appropriate
- "more product focused" → hero product framing, sharper product edge, softer background bokeh
- "brighter" → high-key lighting, airy fill, lifted shadows
- "more cinematic" → filmic color grade, anamorphic-flare hints, dramatic single-frame composition (not cuts or motion)
- "corporate feel" → clean layout, confident typography space, professional palette
- "warmer" → golden hour warmth, amber highlights, warm white balance`;

/**
 * refinePrompt — mutates an existing generation prompt based on user instruction.
 * @param {object} params
 * @param {string} params.originalPrompt
 * @param {string} params.instruction
 * @param {string} params.category
 * @param {string} params.locale
 * @param {'image'|'video'} [params.mediaKind='video']
 * @returns {{ refinedPrompt: string, changes: string }}
 */
async function refinePrompt({ originalPrompt, instruction, category, locale, mediaKind = 'video' }) {
  const kind = mediaKind === 'image' ? 'image' : 'video';
  const market = locale === 'gulf' ? 'UAE/Gulf' : 'global';

  const systemPrompt =
    kind === 'video'
      ? `You are a prompt engineering expert for AI **video** generation for ${category} ads in the ${market} market.

Your job is to modify an existing **video** generation prompt based on a user's instruction.
Keep all the marketing and brand intelligence intact. Only modify what the instruction asks.
Preserve the labeled structure when present (VISUAL WORLD:, CAMERA:, LIGHTING:, BRAND:, etc.).

${MUTATION_GUIDE_VIDEO}

Return ONLY two lines:
Line 1: The full updated prompt (everything on one line)
Line 2: CHANGES: [one sentence describing what you changed]`
      : `You are a prompt engineering expert for AI **image** generation (still ads, hero shots, social statics) for ${category} in the ${market} market.

Your job is to modify an existing **image** generation prompt based on a user's instruction.
Keep all the marketing and brand intelligence intact. Only modify what the instruction asks.
Preserve composition and structure labels when present (SUBJECT:, SETTING:, LIGHTING:, STYLE:, NEGATIVE:, etc.). Do **not** add video-only concepts (cuts, timeline, camera moves across time) unless the user explicitly asks for a storyboard-style description — prefer a single strong frame.

${MUTATION_GUIDE_IMAGE}

Return ONLY two lines:
Line 1: The full updated prompt (everything on one line)
Line 2: CHANGES: [one sentence describing what you changed]`;

  const userMessage = `Original prompt:\n${originalPrompt}\n\nUser instruction: ${instruction}\n\nReturn the updated prompt:`;

  const response = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = (response.content[0]?.text || '').trim();
  const lines = text.split('\n').filter(l => l.trim());

  const changesIdx = lines.findIndex(l => l.startsWith('CHANGES:'));
  const refinedPrompt = changesIdx > 0
    ? lines.slice(0, changesIdx).join(' ').trim()
    : lines[0] || originalPrompt;

  const changes = changesIdx >= 0
    ? lines[changesIdx].replace('CHANGES:', '').trim()
    : 'Prompt updated per instruction';

  if (!refinedPrompt || refinedPrompt.length < 20) {
    throw new Error('promptRefiner: response too short, likely a model error');
  }

  return { refinedPrompt, changes };
}

module.exports = { refinePrompt };
