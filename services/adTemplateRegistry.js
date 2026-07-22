/**
 * adTemplateRegistry.js — the single source of truth for ad "templates".
 *
 * A template is NOT a code path. It's creative direction + sensible defaults.
 * Your blueprint builder reads a template and shapes the prompt; the pipeline
 * (enqueueAdSet) is identical regardless of which template was chosen.
 *
 * Each template declares:
 *   kind:         'image' | 'video'
 *   defaultModel: which fal.ai model fits this style best (overridable)
 *   aspect:       default aspect ratio for this style
 *   direction(b): given a brand/angle context, returns prompt direction text
 *   negative:     style-specific negative prompt additions
 *
 * Add a template = add one object here. No new functions, no new routes.
 */

const IMAGE_TEMPLATES = {
    product_solution: {
      label: 'Product Solution',
      kind: 'image',
      defaultModel: 'nano_banana_pro',
      aspect: '4:5',
      direction: (b) =>
        `Problem-to-solution message for ${b.brandName}. Show the pain state resolving into a clear outcome. ` +
        `Confident, benefit-led composition. ${b.angle || ''}`,
      negative: 'clutter, confusing layout, multiple competing messages',
    },
    product_showcase: {
      label: 'Product Showcase',
      kind: 'image',
      defaultModel: 'nano_banana_pro',
      aspect: '1:1',
      direction: (b) =>
        `Hero product shot for ${b.brandName} with features, benefit, and price emphasis. ` +
        `Crisp, commercial, the product is unmistakably the star. ${b.angle || ''}`,
      negative: 'busy background, hidden product, low detail',
    },
    before_after: {
      label: 'Before After',
      kind: 'image',
      defaultModel: 'seedream_5_0',
      aspect: '1:1',
      direction: (b) =>
        `Clear before/after transformation for ${b.brandName}. Left = problem state, right = improved outcome. ` +
        `Honest, legible contrast. ${b.angle || ''}`,
      negative: 'ambiguous comparison, exaggerated/fake results',
    },
    witty_minimal: {
      label: 'Witty Minimal',
      kind: 'image',
      defaultModel: 'nano_banana_pro',
      aspect: '1:1',
      direction: (b) =>
        `Bold one-line ad for ${b.brandName}. A single relatable, witty statement on a clean field. ` +
        `Strong type hierarchy, lots of negative space. ${b.angle || ''}`,
      negative: 'paragraphs of text, cluttered, more than one idea',
    },
    renaissance: {
      label: 'Renaissance',
      kind: 'image',
      defaultModel: 'flux_pro',
      aspect: '4:5',
      direction: (b) =>
        `Strong-identity creative for ${b.brandName} with humor, luxury, or cultural contrast. ` +
        `Editorial, art-directed, memorable. ${b.angle || ''}`,
      negative: 'generic stock look, flat lighting',
    },
    testimonial: {
      label: 'Testimonial',
      kind: 'image',
      defaultModel: 'nano_banana_pro',
      aspect: '4:5',
      direction: (b) =>
        `Trust-led ad for ${b.brandName} built around a review or social proof. ` +
        `Credible, premium, quote-forward. ${b.angle || ''}`,
      negative: 'fake-looking testimonial, stocky faces',
    },
    retro: {
      label: 'Retro',
      kind: 'image',
      defaultModel: 'flux_pro',
      aspect: '1:1',
      direction: (b) =>
        `Retro vintage-commercial aesthetic for ${b.brandName}. Period color, grain, nostalgic energy. ${b.angle || ''}`,
      negative: 'modern UI, clean digital gradients',
    },
    model_shoot: {
      label: 'Model Shoot',
      kind: 'image',
      defaultModel: 'seedream_5_0',
      aspect: '4:5',
      direction: (b) =>
        `Premium model campaign for ${b.brandName} apparel/accessories. Styled, editorial fashion lighting. ${b.angle || ''}`,
      negative: 'amateur pose, harsh flat light, distracting background',
    },
    white_studio: {
      label: 'White Studio',
      kind: 'image',
      defaultModel: 'nano_banana_pro',
      aspect: '1:1',
      direction: (b) =>
        `Clean white-studio hero shot for ${b.brandName}. No distraction, premium product isolation, soft shadows. ${b.angle || ''}`,
      negative: 'colored background, props, clutter',
    },
    nature_shoot: {
      label: 'Nature Shoot',
      kind: 'image',
      defaultModel: 'seedream_5_0',
      aspect: '4:5',
      direction: (b) =>
        `Natural/wellness/outdoor scene for ${b.brandName}. Organic environment, clean daylight, earthy palette. ${b.angle || ''}`,
      negative: 'studio look, artificial lighting, plastic feel',
    },
  };
  
  const VIDEO_TEMPLATES = {
    creator_review: {
      label: 'Creator Review',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Human-led creator review for ${b.brandName}. Trust, real usage, lifestyle fit. Handheld, authentic, captions. ${b.angle || ''}`,
      negative: 'over-produced, fake enthusiasm, studio sterility',
    },
    cinematic_trailer: {
      label: 'Cinematic Trailer',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '16:9',
      direction: (b) =>
        `Emotional cinematic product film for ${b.brandName}. Drama, movement, aspiration, shallow depth of field. ${b.angle || ''}`,
      negative: 'flat handheld, amateur grade',
    },
    street_interview: {
      label: 'Street Interview',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Casual street-interview video for ${b.brandName}. Spontaneous Q&A, natural product reveal, believable social proof. ${b.angle || ''}`,
      negative: 'scripted feel, studio backdrop',
    },
    white_studio_video: {
      label: 'White Studio',
      kind: 'video',
      defaultModel: 'kling_o3_4k_i2v',
      aspect: '9:16',
      direction: (b) =>
        `Premium floating studio showcase for ${b.brandName}. Clean physical product reveal, slow rotation, soft light. ${b.angle || ''}`,
      negative: 'cluttered set, harsh shadows',
    },
    news_report: {
      label: 'News Report',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '16:9',
      direction: (b) =>
        `Live news-style report for ${b.brandName}. Reporter covers the offer as a trending story, lower-third energy. ${b.angle || ''}`,
      negative: 'casual vlog look, shaky footage',
    },
    user_demo: {
      label: 'User Demo',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Handheld creator demo for ${b.brandName}. Relatable problem → quick demo → visible result → natural reaction → casual CTA. ${b.angle || ''}`,
      negative: 'over-edited, unrealistic result',
    },
    studio_elements: {
      label: 'Studio Elements',
      kind: 'video',
      defaultModel: 'kling_o3_4k_i2v',
      aspect: '9:16',
      direction: (b) =>
        `Packaged-product studio ad for ${b.brandName} with premium category-based floating elements around the product. ${b.angle || ''}`,
      negative: 'empty frame, no product context',
    },
    viral_story: {
      label: 'Viral Story',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Cinematic social story for ${b.brandName}. Bold hook → emotional shift → memorable human moment. ${b.angle || ''}`,
      negative: 'slow open, no hook in first 2 seconds',
    },
    testimonial_video: {
      label: 'Testimonial',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Casual creator testimonial for ${b.brandName}. Honest product experience, conversational, believable. ${b.angle || ''}`,
      negative: 'scripted ad-read, fake delivery',
    },
    nature_shoot_video: {
      label: 'Nature Shoot',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Product film for ${b.brandName} using nature, clean light, organic environments. ${b.angle || ''}`,
      negative: 'studio set, artificial light',
    },
    event_recap: {
      label: 'Event Recap',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '16:9',
      direction: (b) =>
        `Cinematic recap for ${b.brandName} events/courses/communities. Energy, highlights, momentum. ${b.angle || ''}`,
      negative: 'static talking head, no b-roll',
    },
    animated_story: {
      label: 'Animated Story',
      kind: 'video',
      defaultModel: 'seedance_2_0',
      aspect: '9:16',
      direction: (b) =>
        `Heartwarming 3D animated story for ${b.brandName}. Character-led, warm, narrative arc. ${b.angle || ''}`,
      negative: 'photoreal, live action',
    },
  };
  
  const TEMPLATES = { ...IMAGE_TEMPLATES, ...VIDEO_TEMPLATES };
  
  // Normalize a label or key ("Product Solution", "product_solution") to a key.
  function templateKey(input) {
    if (!input) return null;
    const slug = String(input).trim().toLowerCase().replace(/[\s/]+/g, '_');
    if (TEMPLATES[slug]) return slug;
    // try matching by label
    const byLabel = Object.entries(TEMPLATES).find(
      ([, t]) => t.label.toLowerCase() === String(input).trim().toLowerCase(),
    );
    return byLabel ? byLabel[0] : null;
  }
  
  function resolveTemplate(input, kind = 'image') {
    const key = templateKey(input);
    if (key && TEMPLATES[key]) return { key, ...TEMPLATES[key] };
    // sensible fallback per kind
    return kind === 'video'
      ? { key: 'user_demo', ...VIDEO_TEMPLATES.user_demo }
      : { key: 'product_showcase', ...IMAGE_TEMPLATES.product_showcase };
  }
  
  /**
   * The function your blueprint builder calls. Given a template choice + brand
   * context, returns the fields a blueprint needs. The pipeline stays identical.
   */
  function applyTemplate({ templateInput, kind, brandName, angle, palette, styleHint, modelOverride }) {
    const t = resolveTemplate(templateInput, kind);
    const paletteLine = palette?.length ? ` Brand palette ONLY: ${palette.join(', ')}.` : '';
    const prompt = [
      t.direction({ brandName, angle }),
      styleHint || '',
      paletteLine,
      'Professional advertising quality, sharp focus.',
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  
    return {
      templateKey: t.key,
      templateLabel: t.label,
      kind: t.kind,
      modelId: modelOverride || t.defaultModel,
      aspectRatio: t.aspect,
      prompt,
      negativePrompt: t.negative,
    };
  }
  
  module.exports = {
    IMAGE_TEMPLATES, VIDEO_TEMPLATES, TEMPLATES,
    templateKey, resolveTemplate, applyTemplate,
  };