'use strict';

/**
 * promptEnhancer — the missing intelligence layer that runs at GENERATION
 * time (not just on /refine).
 *
 * Why this exists:
 *   The studioController used to take the user's raw prompt and either
 *     (a) drop it into adBrain.buildAdPrompt as a tiny SCENE field that
 *         the model promptly ignored in favor of the DNA boilerplate, or
 *     (b) append "Ultra-high production value, no text overlays" — which
 *         actively fights against prompts like "an image with the word
 *         OPEN written on the door".
 *
 *   Result: the user's words got diluted, intentions got reversed, and the
 *   "intelligence layer" wasn't doing any intelligence work.
 *
 * What this does:
 *   Calls Claude Haiku to rewrite the user's raw prompt into a richer
 *   cinematic prompt that:
 *     - keeps every concrete noun the user wrote
 *     - layers in the cinematic vocabulary Claude knows (lens, lighting,
 *       grade, mood, depth, framing) appropriate to the chosen mode
 *     - returns a matching negative prompt that ONLY adds anti-patterns
 *       which don't conflict with the user's stated intent
 *
 * Resilience:
 *   Anthropic outages must NOT block image generation. If the API is
 *   missing/slow/erroring, we fall back to deterministic enrichment that
 *   wraps the user's prompt with a vocabulary-rich cinematic shell.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 6500; // Hard ceiling; we'd rather fall back than make
                          // the user wait 20s before queuing the job.

let _anthropic;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─── Mode-specific direction the LLM follows ──────────────────────────────
//
// We want Claude to ENRICH the prompt, never invent product names, never
// replace the subject the user described, and never add corporate framing
// when none was asked for. These instructions are tuned by mode so the
// "creative" branch doesn't suddenly start writing ad copy.

const MODE_DIRECTIONS = {
  normal: `
You are a senior cinematographer translating a creator's free-form idea
into a production-ready image generation prompt. Your goal is to keep
EVERY concrete noun, character, action, and location the user wrote, and
add only the cinematic vocabulary that elevates it: lens choice (35mm,
85mm, anamorphic), lighting (golden hour, hard side, low-key, soft key),
camera direction (low angle, slow push-in, overhead), color grade, depth
of field, atmospheric detail. No marketing language. No invented brands.
`.trim(),

  business: `
You are a senior creative director writing a production-ready ad image
prompt. Take the user's intent and the brand context provided, and craft
a cinematic prompt suited for paid advertising. Keep the user's subject
intact — never replace it. Layer in: lens, lighting, grade, framing, and
mood that match the audience and category. Do not invent fake product
features. Do not add headline text instructions to the image (those are
applied in post). Keep the BRAND name as-is if provided.
`.trim(),

  template: `
You are a senior cinematographer expanding a template-based prompt with
the user's specific intent. The template provides the visual framework
(scene, era, lighting, materials). The user prompt provides the SUBJECT
or modification. Merge them so the user's words remain dominant while
the template's atmosphere is preserved. Output a single cohesive prompt.
`.trim(),
};

// Mid-shelf cinematic vocabulary used by the deterministic fallback so a
// raw prompt like "a girl on a beach" still becomes magazine-grade.
const FALLBACK_LENS_BANK = [
  '85mm portrait lens, shallow depth of field, creamy bokeh',
  '35mm cinematic prime, gentle vignette, organic film grain',
  'anamorphic 2.39:1, oval bokeh highlights',
];
const FALLBACK_LIGHT_BANK = {
  warm: 'soft golden-hour key light, long honeyed shadows, ambient bounce fill',
  cool: 'cool blue-hour ambient light, gentle teal/cyan grade, subtle silver highlights',
  studio: 'controlled studio key with soft octabox, sculpted rim from camera-right',
  natural: 'naturalistic ambient lighting, motivated by visible practicals',
};

function timeoutSignal() {
  if (typeof AbortSignal === 'undefined') return undefined;
  // AbortSignal.timeout exists on Node 18+. If not, no signal — Anthropic
  // SDK has its own internal timeout we can lean on.
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(TIMEOUT_MS);
  return undefined;
}

function pickLight(category) {
  if (!category) return FALLBACK_LIGHT_BANK.natural;
  const c = String(category).toLowerCase();
  if (c.includes('perfume') || c.includes('jewel') || c.includes('luxury') || c.includes('realestate')) {
    return FALLBACK_LIGHT_BANK.warm;
  }
  if (c.includes('saas') || c.includes('tech') || c.includes('service')) {
    return FALLBACK_LIGHT_BANK.studio;
  }
  if (c.includes('gym') || c.includes('fashion')) {
    return FALLBACK_LIGHT_BANK.cool;
  }
  return FALLBACK_LIGHT_BANK.natural;
}

function deterministicEnrich({ rawPrompt, mode, category, vibe }) {
  const lens = FALLBACK_LENS_BANK[Math.floor(Math.random() * FALLBACK_LENS_BANK.length)];
  const light = pickLight(category);
  const vibePart = vibe ? ` ${vibe} mood,` : '';

  // Keep the user's prompt as the FIRST clause — that's what the model
  // pays the most attention to. Everything else is direction tacked on.
  const finalPrompt = `${rawPrompt.trim()}. ${lens}, ${light},${vibePart} photoreal commercial finish, sharp critical focus on the subject, magazine-grade composition.`;

  const negativePrompt = mode === 'normal'
    ? 'lowres, blurry, deformed anatomy, extra fingers, distorted faces, watermark'
    : 'lowres, blurry, deformed anatomy, extra fingers, distorted faces, watermark, on-image text overlays, fake brand logos';

  return { finalPrompt, negativePrompt, source: 'fallback' };
}

/**
 * Enhance a raw user prompt using Claude. Always resolves — falls back to
 * the deterministic enricher when Claude isn't reachable.
 *
 * @param {object} args
 * @param {string} args.rawPrompt        the user's free-form input (REQUIRED)
 * @param {'normal'|'business'|'template'} args.mode
 * @param {string} [args.category]       e.g. 'gym', 'perfume', 'general'
 * @param {string} [args.brandName]
 * @param {string} [args.targetAudience]
 * @param {string} [args.vibe]
 * @param {string} [args.locale]         'gulf' | 'global'
 * @param {'image'|'video'} [args.kind]
 * @returns {Promise<{ finalPrompt: string, negativePrompt: string, source: 'claude'|'fallback' }>}
 */
async function enhancePrompt(args) {
  const {
    rawPrompt,
    mode = 'normal',
    category,
    brandName,
    targetAudience,
    vibe,
    locale = 'gulf',
    kind = 'image',
  } = args || {};

  const trimmed = (rawPrompt || '').trim();
  if (!trimmed) {
    // The controller decides what to do with an empty prompt. We don't
    // hallucinate a default subject here — that's a decision, not a fallback.
    return { finalPrompt: '', negativePrompt: '', source: 'fallback' };
  }

  const client = getAnthropic();
  if (!client) {
    return deterministicEnrich({ rawPrompt: trimmed, mode, category, vibe });
  }

  const direction = MODE_DIRECTIONS[mode] || MODE_DIRECTIONS.normal;

  const contextLines = [
    `OUTPUT KIND: ${kind}`,
    `LOCALE: ${locale}`,
    category && category !== 'general' ? `CATEGORY: ${category}` : null,
    brandName ? `BRAND: ${brandName}` : null,
    targetAudience ? `AUDIENCE: ${targetAudience}` : null,
    vibe ? `VIBE: ${vibe}` : null,
  ].filter(Boolean).join('\n');

  const systemPrompt = `${direction}

Output STRICTLY in this format, nothing else:
PROMPT: <one paragraph, the enriched prompt>
NEGATIVE: <comma-separated anti-patterns that do NOT contradict the user's prompt>`;

  const userMessage = [
    `Raw user prompt: "${trimmed}"`,
    contextLines && '',
    contextLines,
  ].filter(Boolean).join('\n');

  try {
    const resp = await Promise.race([
      client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }, { signal: timeoutSignal() }),
      // Belt-and-braces timeout — if the SDK didn't honor the signal, this
      // racing promise still kicks us into the fallback path.
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('enhancer_timeout')), TIMEOUT_MS + 500)),
    ]);

    const text = (resp.content?.[0]?.text || '').trim();
    const promptMatch = text.match(/PROMPT:\s*([\s\S]*?)(?=\nNEGATIVE:|$)/i);
    const negMatch = text.match(/NEGATIVE:\s*([\s\S]*)$/i);

    const finalPrompt = (promptMatch?.[1] || '').trim();
    const negativePrompt = (negMatch?.[1] || '').trim();

    // Sanity-check: if Claude returned junk (too short, doesn't mention the
    // user's prompt at all), drop back to deterministic enrichment.
    const containsUserNoun = trimmed
      .split(/\s+/)
      .some((w) => w.length > 3 && finalPrompt.toLowerCase().includes(w.toLowerCase()));
    if (!finalPrompt || finalPrompt.length < 30 || !containsUserNoun) {
      return deterministicEnrich({ rawPrompt: trimmed, mode, category, vibe });
    }

    return {
      finalPrompt,
      negativePrompt: negativePrompt || deterministicEnrich({ rawPrompt: trimmed, mode, category, vibe }).negativePrompt,
      source: 'claude',
    };
  } catch (_err) {
    // Network failure, rate limit, timeout, parser miss — never bubble up.
    // The user just wants their image; falling back to deterministic
    // enrichment keeps the pipeline flowing.
    return deterministicEnrich({ rawPrompt: trimmed, mode, category, vibe });
  }
}

module.exports = {
  enhancePrompt,
  // Exported for the test suite + the studioController fallback path.
  deterministicEnrich,
};
