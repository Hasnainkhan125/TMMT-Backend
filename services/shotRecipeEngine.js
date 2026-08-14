
/**
 * shotRecipeEngine.fixed.js — fixes the three drops:
 *   A. All 12 templates have recipes; keys normalized (news-report === news_report).
 *   B. shotCount + per-shot durationSec flow through (no more hard 3×3).
 *   C. i2v shots anchor on brand.productImageUrl (user-supplied), NEVER the
 *      competitor poster. Competitor only shapes the recipe (structure).
 */

function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
const TEMPLATE_RECIPES = {
  creator_review: { label: 'Creator Review', aspect: '9:16', presenter: true, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `A relatable creator holding and reviewing ${b.brandName}'s product to camera, handheld, natural light, authentic. ${b.angle || ''}` },
    { role: 'demo',    method: 'i2v', overlay: null,       p: (b) => `Close demonstration of ${b.brandName}'s product in the creator's hands, clear and trustworthy.` },
    { role: 'result',  method: 'i2v', overlay: 'cta',      p: (b) => `Creator's satisfied verdict on ${b.brandName}'s product, confident close, clean space for CTA.` },
  ]},
  cinematic_trailer: { label: 'Cinematic Trailer', aspect: '16:9', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Cinematic dramatic establishing shot featuring ${b.brandName}'s product, shallow depth of field, premium grade. ${b.angle || ''}` },
    { role: 'reveal',  method: 'i2v', overlay: null,       p: (b) => `Slow cinematic hero reveal of ${b.brandName}'s product, premium lighting.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Final aspirational hold on ${b.brandName}'s product, room for logo and CTA.` },
  ]},
  baby_reacts: { label: 'Baby Reacts', aspect: '9:16', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Funny, charming scene reacting to ${b.brandName}'s product, playful and light. ${b.angle || ''}` },
    { role: 'demo',    method: 'i2v', overlay: null,       p: (b) => `${b.brandName}'s product shown clearly in the playful scene.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Warm closing beat on ${b.brandName}'s product, space for CTA.` },
  ]},
  street_interview: { label: 'Street Interview', aspect: '9:16', presenter: true, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Candid street interview moment about ${b.brandName}, spontaneous and real, urban daylight. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `Natural reveal of ${b.brandName}'s product during the interview, believable social proof.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Closing reaction holding ${b.brandName}'s product, space for CTA.` },
  ]},
  white_studio: { label: 'White Studio', aspect: '9:16', presenter: false, shots: [
    { role: 'reveal',  method: 'i2v', overlay: 'headline', p: (b) => `Premium floating studio reveal of ${b.brandName}'s product on clean white, slow rotation, soft shadows. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `Detail push-in on ${b.brandName}'s product features, white studio, crisp.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Final clean studio hold of ${b.brandName}'s product, space for logo and CTA.` },
  ]},
  news_report: { label: 'News Report', aspect: '9:16', presenter: true, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `News-anchor style report presenting ${b.brandName} as a trending story, broadcast framing. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `Cutaway to ${b.brandName}'s product as the story's subject, clean and clear.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Anchor sign-off with ${b.brandName}'s product on screen, space for CTA.` },
  ]},
  user_demo: { label: 'User Demo', aspect: '9:16', presenter: false, shots: [
    { role: 'problem', method: 'i2v', overlay: 'headline', p: (b) => `Relatable person facing the problem ${b.brandName} solves, handheld, authentic, natural light. ${b.angle || ''}` },
    { role: 'demo',    method: 'i2v', overlay: null,       p: (b) => `Close, clear demonstration of ${b.brandName}'s product in use, product is the hero.` },
    { role: 'result',  method: 'i2v', overlay: 'cta',      p: (b) => `Satisfied result after using ${b.brandName}'s product, confident close, clean space for CTA.` },
  ]},
  studio_elements: { label: 'Studio Elements', aspect: '9:16', presenter: false, shots: [
    { role: 'reveal',  method: 'i2v', overlay: 'headline', p: (b) => `${b.brandName}'s packaged product with premium floating category elements, studio lit. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `Dynamic arrangement of ${b.brandName}'s product with floating accents.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Clean hold on ${b.brandName}'s packaged product, space for CTA.` },
  ]},
  viral_story: { label: 'Viral Story', aspect: '9:16', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Bold scroll-stopping hook moment featuring ${b.brandName}'s product. ${b.angle || ''}` },
    { role: 'reveal',  method: 'i2v', overlay: null,       p: (b) => `Emotional shift centered on ${b.brandName}'s product.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Memorable closing beat with ${b.brandName}'s product, space for CTA.` },
  ]},
  testimonial: { label: 'Testimonial', aspect: '9:16', presenter: true, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Honest customer sharing their experience with ${b.brandName}'s product to camera, casual, sincere. ${b.angle || ''}` },
    { role: 'demo',    method: 'i2v', overlay: null,       p: (b) => `${b.brandName}'s product shown as the customer describes the benefit.` },
    { role: 'result',  method: 'i2v', overlay: 'cta',      p: (b) => `Customer's positive conclusion with ${b.brandName}'s product, space for CTA.` },
  ]},
  nature_shoot: { label: 'Nature Shoot', aspect: '9:16', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `${b.brandName}'s product in a clean natural environment, organic light. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `Detail of ${b.brandName}'s product amid natural textures.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Serene closing hold on ${b.brandName}'s product, space for CTA.` },
  ]},
  event_recap: { label: 'Event Recap', aspect: '16:9', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Energetic recap-style opening featuring ${b.brandName}. ${b.angle || ''}` },
    { role: 'product', method: 'i2v', overlay: null,       p: (b) => `${b.brandName}'s product highlighted in the recap montage.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Closing recap beat on ${b.brandName}'s product, space for CTA.` },
  ]},
  animated_story: { label: 'Animated Story', aspect: '9:16', presenter: false, shots: [
    { role: 'hook',    method: 'i2v', overlay: 'headline', p: (b) => `Playful 3D-animated-style scene introducing ${b.brandName}'s product. ${b.angle || ''}` },
    { role: 'reveal',  method: 'i2v', overlay: null,       p: (b) => `Magical reveal of ${b.brandName}'s product as the hero.` },
    { role: 'cta',     method: 'i2v', overlay: 'cta',      p: (b) => `Heartwarming close on ${b.brandName}'s product, space for CTA.` },
  ]},
};


function scaleShots(base, shotCount) {
  const n = Math.max(2, Math.min(7, shotCount || base.length));
  if (n <= base.length) return base.slice(0, n);
  const first = base[0];
  const last = base[base.length - 1];
  const middle = base.slice(1, -1);
  const body = middle.length ? middle : [base[Math.floor(base.length / 2)]];
  const fill = [];
  for (let i = 0; i < n - 2; i += 1) fill.push({ ...body[i % body.length] });
  return [first, ...fill, last];
}




/**
 * buildBeatDirectorPrompt — generates a production-grade per-beat director prompt.
 *
 * Priority: user-typed beatPrompt (most specific) → role-based visual description.
 * The userCopy becomes the VO line anchored into the prompt so the model "knows"
 * what the speaker is saying/showing, which improves visual coherence.
 */
function buildBeatDirectorPrompt({ beat, brand, headline, tpl, isPresenter }) {
  const { role, hookType, userCopy, beatPrompt } = beat;
  const brandName = brand.brandName || 'the brand';
  const palette = (brand.palette || []).slice(0, 3).join(', ');
  const paletteLine = palette ? `Subtle brand palette accents (${palette}) in lighting and environment.` : '';

  const technicals = `Photoreal commercial advertising footage, 4K sharpness, natural motion blur. No on-screen text, no captions, no watermark, no logos rendered by the model.`;

  console.log('beatPrompt', beatPrompt);
  // If user typed a director-level prompt for this beat, use it directly.
  if (beatPrompt && beatPrompt.trim().length > 10) {
    return [
      // `${brandName}'s product as the hero subject.`,
      beatPrompt.trim(),
      `VO line for this beat: "${userCopy.trim()}".`
      // paletteLine,
      // technicals,
    ].filter(Boolean).join(' ');
  }

  // Otherwise build from role + hookType + userCopy
  const voiceLine = userCopy ? `VO line for this beat: "${userCopy.trim()}".` : '';

  const ROLE_VISUALS = {
    hook:      (ht) => ht === 'question'    ? `Subject poses a direct question to camera — inviting, slightly puzzled expression, minimal movement.`
                     : ht === 'pain'        ? `Subject reacts to a relatable frustration, authentic body language.`
                     : ht === 'curiosity_gap' ? `Close push-in on the product — withheld reveal, slow drift, building tension.`
                     :                        `Bold, scroll-stopping first moment — fast cut energy, product or subject fills frame.`,
    problem:   () => `Subject demonstrates or acknowledges the pain point — honest, empathetic framing, handheld feel.`,
    agitation: () => `Intensified problem shot — tight crop, slightly desaturated, restless camera energy.`,
    solution:  () => `Product enters frame as the answer — clean reveal, satisfied subject interaction, warm lighting shift.`,
    demo:      () => `Close, deliberate demonstration of ${brandName}'s product in use — hands + product fill frame, clear action.`,
    proof:     () => `Tangible evidence moment — before/after visual or measurable result displayed clearly, confident framing.`,
    benefit:   () => `Subject enjoys the outcome — positive, aspirational energy, soft flattering light, calm confident hold.`,
    result:    () => `Satisfied reveal after using ${brandName}'s product — confident close, glowing result, space for CTA.`,
    reveal:    () => `Slow cinematic product reveal — hero object emerges from darkness or background, premium lighting.`,
    cta:       () => `Final authoritative hold — product and subject together, clean space for text overlay, inviting energy.`,
  };

  const visualDesc = (ROLE_VISUALS[role] || (() => `${brandName}'s product as hero.`))(hookType);

  const presenterLine = isPresenter
    ? `Subject is a credible, relatable spokesperson — natural wardrobe, good lighting, authentic expression.`
    : `${brandName}'s product is the hero subject.`;

  return [
    // presenterLine,
    // visualDesc,
    voiceLine,
    paletteLine,
    technicals,
  ].filter(Boolean).join(' ');
}


async function buildShotRecipe(brand, opts = {}, deps = {}) {
  const { templateKey, headline, cta, shotCount, durationSec, competitorPosterUrl, avatarBrief, audio, startImageUrl } = opts;
  const productImageUrl = opts.productImageUrl || brand.productImageUrl || null;
  const specBeats = Array.isArray(opts.__specBeats) && opts.__specBeats.length > 0 ? opts.__specBeats : null;

  const tpl = TEMPLATE_RECIPES[normKey(templateKey)] || TEMPLATE_RECIPES.user_demo;
  const aspect = opts.aspectRatio || tpl.aspect;

  // When __specBeats is present (from adSpecToRecipeOpts), honour the exact beat list
  // the user approved — skip scaleShots and use per-beat duration + per-beat prompts.
  const beats = specBeats
    ? specBeats
    : scaleShots(tpl.shots, shotCount || tpl.shots.length).map((s) => ({
        role: s.role,
        hookType: null,
        durationSec: (() => {
          const total = Number(durationSec) || tpl.shots.length * 4;
          const n = shotCount || tpl.shots.length;
          return Math.max(3, Math.min(5, Math.round(total / n)));
        })(),
        overlay: s.overlay ? { kind: s.overlay } : null,
        userCopy: '',
        beatPrompt: null,
        beatAssetUrls: [],
      }));

  const shots = await Promise.all(beats.map(async (beat, i) => {
    // Overlay text from the beat's explicit overlay field
    const overlayKind = beat.overlay?.kind || (specBeats ? null : tpl.shots[i]?.overlay) || null;
    const overlayText =
      overlayKind === 'headline' ? (beat.overlay?.text || headline || brand.angle || brand.brandName) :
      overlayKind === 'cta'      ? (beat.overlay?.text || cta || 'Learn more') : null;

    // Build director-level prompt — per-beat, NOT generic
    const prompt = buildBeatDirectorPrompt({
      beat,
      brand,
      headline,
      tpl,
      isPresenter: !!tpl.presenter,
    });

    console.log('prompt', prompt);

    return {
      index: i,
      role: beat.role,
      durationSec: beat.durationSec || 4,
      method: 'i2v',
      aspectRatio: aspect,
      prompt,
      userCopy: beat.userCopy || '',
      beatAssetUrls: beat.beatAssetUrls || [],   // per-beat edited frames + reference images
      sourceRef: productImageUrl,
      presenterImageUrl: avatarBrief?.preset?.previewCoverUrl || startImageUrl,
      competitorPosterUrl,
      avatarBrief,
      audio,
      startImageUrl,
      overlay: overlayKind ? { kind: overlayKind, text: overlayText, logoUrl: brand.logoUrl || null } : null,
      modelId: process.env.URL_TO_ADS_VIDEO_I2V_MODEL,
      status: 'pending',
    };
  }));

  return {
    label: tpl.label,
    aspect,
    presenter: !!tpl.presenter,
    shots,
    totalDurationSec: shots.reduce((s, x) => s + x.durationSec, 0),
    overlayPlan: shots.filter((s) => s.overlay).map((s) => ({ shotIndex: s.index, ...s.overlay })),
  };
}
 
module.exports = { buildShotRecipe, buildBeatDirectorPrompt, TEMPLATE_RECIPES, normKey, scaleShots };