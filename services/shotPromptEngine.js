/**
 * shotPromptEngine.js — director-grade prompts for Kling O3 i2v.
 *
 * Two layers (hybrid):
 *   1. TEMPLATED (always on): deterministic, detailed, motion-and-camera-first
 *      prompts. Kling i2v ANIMATES a still — so the prompt must describe how the
 *      camera and subject MOVE, plus lens/grade/lighting, not just "what's in frame".
 *   2. LLM POLISH (behind URL_TO_ADS_LLM_PROMPT_POLISH=true): a single cheap
 *      Haiku call that rewrites the templated prompt into a bespoke cinematic
 *      brief using the brand + product + angle. Falls back to the templated
 *      prompt on any error so generation never blocks on the LLM.
 *
 * Kling O3 i2v prompt grammar that actually moves the needle:
 *   [SUBJECT ACTION] + [CAMERA MOVE] + [LENS/FRAMING] + [LIGHTING] + [GRADE/MOOD]
 *   Negative space for overlays is requested explicitly so the post step has room.
 */

// ── Cinematic vocabulary per role. These are DIRECTION, not scene labels. ────
// Each returns the motion+camera spine; brand specifics get appended.
const ROLE_DIRECTION = {
    hook: {
      camera: 'slow push-in, subtle handheld energy',
      lens: 'wide-to-medium, shallow depth of field',
      motion: 'subject turns toward camera, micro-movement, alive not static',
      grade: 'punchy contrast, scroll-stopping first frame',
    },
    problem: {
      camera: 'static-to-slow-drift, observational',
      lens: 'medium, natural compression',
      motion: 'subject reacts to a relatable frustration, authentic body language',
      grade: 'naturalistic, slightly desaturated, real-world',
    },
    demo: {
      camera: 'locked-off with a slow 10% push, product-centric',
      lens: 'macro-leaning, crisp on product surface',
      motion: 'hands interact with the product, smooth controlled motion',
      grade: 'clean, true-to-life color, high micro-contrast on the product',
    },
    product: {
      camera: 'slow orbit or dolly across the product',
      lens: 'medium-macro, premium product framing',
      motion: 'product holds as hero, minimal background motion for fidelity',
      grade: 'premium, controlled highlights, brand-color accents',
    },
    reveal: {
      camera: 'slow rise / pull-focus reveal',
      lens: 'cinematic medium, shallow depth of field',
      motion: 'product emerges into focus as the hero, light sweep across it',
      grade: 'premium cinematic grade, soft falloff',
    },
    result: {
      camera: 'gentle push to a confident hold',
      lens: 'medium close, flattering',
      motion: 'satisfied positive reaction, calm confident energy',
      grade: 'warm, optimistic, clean',
    },
    cta: {
      camera: 'settle to a steady, composed hold',
      lens: 'medium, centered product with breathing room',
      motion: 'minimal motion, product steady, clean negative space top and bottom',
      grade: 'brand-forward, clean, poster-ready',
    },
  };
  
  // Build the deterministic, detailed prompt for one shot.
  function templatedPrompt({ role, brand, angle, isPresenter, competitorPosterUrl, avatarBrief, audio, startImageUrl }) {
    const d = ROLE_DIRECTION[role] || ROLE_DIRECTION.product;
    const previewCoverUrl = avatarBrief?.preset?.previewCoverUrl || startImageUrl;

    const subject = isPresenter
    ? `a believable on-camera presenter naturally featuring ${brand.brandName}`
      : `${brand.brandName}'s product as the hero subject`;
  
    const palette = brand.palette?.length
      ? `Subtle brand palette accents (${brand.palette.slice(0, 3).join(', ')}) in lighting and environment.`
      : '';
  
    // Order matters for Kling: action → camera → lens → lighting → grade → constraints
    return [
      // ${subject}.
      `${d.motion}.`,
      angle ? `Angle: ${angle}.` : '',
      `Camera: ${d.camera}. Lens: ${d.lens}.`,
      `Lighting: soft key with gentle rim separation, advertising-grade.`,
      `Grade: ${d.grade}.`,
      palette,
      `Photoreal commercial advertising footage, 4K sharpness, natural motion blur.`,
      role === 'cta' || role === 'hook'
        ? 'Leave clean negative space for a text overlay (top third for headline, lower third for CTA).'
        : '',
      'No on-screen text, no captions, no watermark, no logos rendered by the model.',
    ].filter(Boolean).join(' ');
  }
  
  // ── Optional LLM polish pass (Haiku). Behind a flag; fails safe. ─────────────
  async function polishWithLLM({ basePrompt, role, brand, angle, isPresenter }, deps) {
    // deps.callHaiku(messages) → string. Inject your existing copy/LLM client.
    const sys = [
      'You are a commercial director writing a single image-to-video shot prompt for Kling O3.',
      'The prompt must describe MOTION and CAMERA (the model animates a still image), plus lens, lighting, and color grade.',
      'Keep it under 90 words. Photoreal advertising. No on-screen text instructions to the model.',
      'Do NOT mention any competitor. Center the brand\'s own product. Return ONLY the prompt text, no preamble.',
    ].join(' ');
  
    const user = [
      `Brand: ${brand.brandName}${brand.category ? ` (${brand.category})` : ''}.`,
      angle ? `Selling angle: ${angle}.` : '',
      `Shot role: ${role}${isPresenter ? ' (on-camera presenter style)' : ''}.`,
      brand.palette?.length ? `Brand colors: ${brand.palette.slice(0, 3).join(', ')}.` : '',
      `Here is a baseline prompt to elevate to director quality:`,
      basePrompt,
    ].filter(Boolean).join('\n');
  
    try {
      const out = await deps.callHaiku([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ]);
      const cleaned = String(out || '').trim();
      return cleaned.length > 30 ? cleaned : basePrompt;   // guard against junk
    } catch (err) {
      console.warn('[shotPromptEngine] LLM polish failed, using templated:', err?.message);
      return basePrompt;                                    // fail safe
    }
  }
  
  /**
   * buildShotPrompt — the entry point the recipe engine calls per shot.
   * deps: { callHaiku } only needed when polish flag is on.
   */
  async function buildShotPrompt({ role, brand, angle, isPresenter, competitorPosterUrl, avatarBrief, audio, startImageUrl }, deps = {}) {
    const base = templatedPrompt({ role, brand, angle, isPresenter, competitorPosterUrl, avatarBrief, audio, startImageUrl });
  
    const polishOn = String(process.env.URL_TO_ADS_LLM_PROMPT_POLISH || '').toLowerCase() === 'true';
    if (polishOn && deps.callHaiku) {
      return polishWithLLM({ basePrompt: base, role, brand, angle, isPresenter }, deps);
    }
    return base;
  }
  
  module.exports = { buildShotPrompt, templatedPrompt, ROLE_DIRECTION };