const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { fal } = require('@fal-ai/client');
const tokenMeter = require('./tokenMeter');

let _anthropic, _openai, _falConfigured = false;

function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function ensureFal() {
  if (!_falConfigured) {
    fal.config({ credentials: process.env.QUMAK_FLUX_API_KEY || process.env.FAL_KEY || '' });
    _falConfigured = true;
  }
}

// ── Step 1: Raw Prompt Builder ──────────────────────────────────────────────

function buildRawPrompt(brandContext, imageType) {
  const {
    brandName, category, tone, colorPalette,
    fragranceFamily, bottleShape, bottleMaterial, capStyle,
    labelFinish, outerBox, boxExterior,
    skinConcerns, packagingStyle, keyIngredients,
    targetPersona, positioning, pricePoint,
    inputs = {},
  } = brandContext;

  const primary = colorPalette?.primaryName || colorPalette?.primary || 'warm amber';
  const accent = colorPalette?.accentName || colorPalette?.accent || 'burnished gold';
  const isLuxury = tone === 'luxury' || pricePoint?.includes('ultra') || pricePoint?.includes('700');

  const PHOTO_TECH = `Captured on Phase One IQ4 150MP, Schneider 120mm f/3.5 LS at f/8, ISO 50. Profoto D2 three-point lighting: 3x4ft softbox key at 45° camera-left, fill card at 2:1 ratio, rim light for edge separation. 16-bit color depth, 5200K white balance, Capture One processing. Photorealistic commercial photography, indistinguishable from a real photograph.`;

  const NEVER = `NEVER: cartoon, illustration, 3D render, CGI look, plastic textures, oversaturation, AI artifacts, text overlays, watermarks, logos, stock photo composition, symmetrical boring layout, fake bokeh.`;

  const RAW_PROMPTS = {
    perfume: {
      heroBottle: () => {
        const bottle = `${bottleShape || 'angular faceted'} ${bottleMaterial || 'frosted glass'} bottle with ${capStyle || 'heavy magnetic zamac cap'} and ${labelFinish || 'debossed matte label'}`;
        const surface = isLuxury ? 'polished obsidian surface with razor-thin shadow' : 'brushed concrete with organic shadow';
        const notes = (inputs.topNotes || []).join(', ') || 'saffron, bergamot';
        const base = (inputs.baseNotes || []).join(', ') || 'sandalwood, musk';
        const props = fragranceFamily?.includes('Oud') || fragranceFamily === 'Oriental'
          ? 'raw oud wood chips, saffron threads in brass dish, frankincense resin, dried damask rose'
          : fragranceFamily?.includes('Floral')
          ? 'fresh rosa damascena petals, jasmine sambac buds, tuberose sprig'
          : fragranceFamily?.includes('Fresh') || fragranceFamily?.includes('Citrus')
          ? 'Meyer lemon slice, bergamot peel curl, green cardamom pods, mint leaves'
          : 'vetiver roots, tonka beans, cedarwood bark, amber resin';

        return `Ultra-realistic luxury perfume bottle photography for Vogue Arabia full-page advertisement.
Subject: single ${bottle}. Primary color: ${primary}. Accent: ${accent}.
The glass has visible weight and thickness. Liquid level visible with natural ${primary} tint and meniscus.
Cap has machined metal precision. Label texture is tactile.
Setting: ${surface}. Off-center rule-of-thirds left position.
Key light creates single crisp specular highlight tracing left glass edge.
Caustic light pattern on surface from light refracting through glass and liquid.
Cap edge catches rim light with metallic glow.
Precise soft-edged shadow to lower-right.
Background fades to pure black at corners.
Ingredient props: ${props} — arranged naturally at bottle base.
Notes concept: ${notes} opening into ${base} base.
${PHOTO_TECH}
${NEVER}`;
      },

      lifestyle: () => {
        const gender = inputs.gender || 'Unisex';
        const hand = gender === 'For Her' || gender === 'Women'
          ? "UAE woman's hand with French manicure, thin gold ring, delicate chain bracelet, warm skin tone with visible natural pores"
          : gender === 'For Him' || gender === 'Men'
          ? "well-groomed man's hand with clean short nails, premium watch visible at wrist, natural masculine skin texture"
          : "elegant hand with thin band ring, natural skin texture, warm-toned";
        const setting = isLuxury
          ? 'luxury Dubai hotel lobby — warm amber chandelier bokeh, dark architectural elements, f/1.8 shallow depth'
          : 'golden hour rooftop terrace — Dubai skyline at dusk, warm ambient light bokeh';

        return `Ultra-realistic luxury fragrance lifestyle photograph. Instagram campaign quality.
A ${bottleShape || 'angular'} ${bottleMaterial || 'frosted glass'} ${brandName} perfume bottle
held in a ${hand} at a natural 30-degree wrist angle.
Background: ${setting}.
Only hand and bottle in sharp focus. Everything else is creamy bokeh.
Color grade: warm shadows, cool highlights, lifted blacks.
${PHOTO_TECH}
${NEVER}`;
      },

      socialSquare: () => `Luxury Instagram 1:1 campaign for ${brandName} perfume.
${bottleShape || 'Angular'} ${bottleMaterial || 'frosted glass'} bottle positioned at rule-of-thirds lower-left.
Low 15-degree angle creating monumental perspective.
Background: continuous gradient from deep ${primary} at base to near-black at top.
Single overhead spot creates dramatic light pool around bottle.
Visible glass refractions and caustic light on surface.
Subtle mist/smoke drifts behind bottle suggesting released fragrance — not overdone.
Heavy negative space in upper portion for potential text.
Mood: Net-a-Porter, Farfetch, exclusive editorial.
${PHOTO_TECH}
${NEVER}`,

      flatlay: () => {
        const props = fragranceFamily?.includes('Oud')
          ? 'raw oud chips, saffron threads, frankincense resin, dried damask rose, Arabic calligraphy card'
          : 'dried botanicals, crystals, raw ingredient reference, silk ribbon';
        return `Professional overhead flat-lay photography for ${brandName} luxury perfume.
Hero: ${bottleShape || 'angular'} ${bottleMaterial || 'frosted glass'} ${brandName} bottle at golden ratio point.
Surrounding asymmetric but balanced composition: ${props}.
${accent}-colored raw silk fabric swatch, small brass tray.
Surface: Italian Calacatta marble with gold veining diagonal.
Large overhead octabox: even diffused illumination, every ingredient sharp.
Deliberate negative space upper-right.
Muted earthy color palette: ${primary} and ${accent} dominant.
Harrods window display lookbook quality.
${PHOTO_TECH}
${NEVER}`;
      },

      unboxing: () => `Hyper-realistic luxury perfume unboxing moment.
${bottleShape || 'Angular'} ${bottleMaterial || 'frosted glass'} ${brandName} bottle
emerging from ${boxExterior || 'matte black'} ${outerBox || 'rigid luxury magnetic box'}.
Box lid at 40-degree angle.
Inside: ${primary}-colored suede foam insert, black acid-free tissue,
sealed certificate envelope, ${accent} satin ribbon pull-tab.
Box exterior: brand mark as debossed or foil-stamped element.
Surface: weathered dark walnut with visible grain.
Warm directional light from camera-right creating anticipation.
Small branded fragrance sample vial beside box.
${PHOTO_TECH}
${NEVER}`,
    },

    skincare: {
      heroBottle: () => {
        const product = (inputs.productTypes || ['Serum'])[0];
        const concern = (skinConcerns || ['Hydration'])[0];
        const ing = (inputs.keyIngredients || keyIngredients || ['Hyaluronic Acid'])[0];
        return `Ultra-realistic skincare product photography for Sephora hero image.
Single ${packagingStyle || 'minimal clinical white'} ${product} bottle.
Clean label with ${primary} accent stripe, precise typography, tactile packaging texture.
${ing} droplet visible on dropper tip catching light.
One fresh prop: eucalyptus or monstera leaf at base, slightly soft-focus.
Surface: pure white acrylic with razor-thin shadow line.
Background: seamless white-to-warm-cream gradient.
Beauty dish overhead: even diffused illumination, circular catchlight on bottle.
Aesthetic: Drunk Elephant or Aesop campaign quality.
${PHOTO_TECH}
${NEVER}`;
      },

      lifestyle: () => {
        const concern = (skinConcerns || ['Hydration'])[0];
        return `Photorealistic skincare lifestyle editorial. UAE market focus.
Woman, 28-32, Middle Eastern or South Asian features.
Genuine skin: visible pores on nose, slight undereye texture, natural grain — NOT airbrushed.
She holds ${packagingStyle || 'minimal white'} ${brandName} bottle against lower cheek.
Relaxed, confident half-smile. Looking off-camera right.
Setting: bright white bathroom, morning sunlight through frosted glass window camera-left.
White waffle-knit robe, hair wrapped in white towel.
Mirror, small succulent, ambient warmth behind her.
Skin reads as "${concern} result" without being fake.
Shot f/2.0 for gentle background separation.
Color grade: lifted shadows, clean whites, warm skin tones.
${PHOTO_TECH}
${NEVER}`;
      },

      socialSquare: () => {
        const concern = (skinConcerns || ['Hydration'])[0];
        return `Instagram 1:1 skincare campaign for ${brandName}.
Extreme close-up: model's face nose to chin, eyes closed, warm golden-hour window light from left.
Skin is stunning but real: visible pores, natural sheen suggesting product just applied.
Fingers gently touching jawline showing ${concern} result.
Lower-right: hero product bottle, slightly soft-focus but identifiable, leaning against mirror.
Background: diffused warm white.
Color grade: golden warmth in shadows, clean highlights, skin-true accuracy.
Result sells the product, not the bottle.
${PHOTO_TECH}
${NEVER}`;
      },

      flatlay: () => {
        const products = (inputs.productTypes || ['Serum', 'Moisturizer']).slice(0, 3).join(', ');
        return `Professional skincare flat-lay for ${brandName}. Into The Gloss editorial quality.
${packagingStyle || 'Minimal white'} products in flowing S-curve: ${products}.
Props: fresh eucalyptus stems, ceramic mortar with raw ingredient,
cotton pad, brass spoon.
Carrara marble with subtle grey veining.
Soft diffused window light upper-left.
Everything edge-to-edge sharp. Each product with tiny shadow for dimensionality.
Color story: whites, creams, soft sage, ${primary} accent on labels.
${PHOTO_TECH}
${NEVER}`;
      },
    },

    food: {
      heroBottle: () => `Ultra-realistic commercial food product photography.
Hero: ${brandName} signature dish or flagship product.
Handmade ceramic plate with ${primary} glaze.
Visible steam, glistening sauce, precise garnish.
Raw-edge dark walnut board on linen cloth.
Warm 3800K lighting creating appetizing golden tones.
Sharp hero element, bokeh background.
${PHOTO_TECH}
${NEVER}`,
      lifestyle: () => `Food lifestyle editorial for ${brandName}.
Chef's hands (flour-dusted, authentic) plating with tweezers.
Professional kitchen, stainless steel, warm amber task lighting.
Steam and natural motion. Tight focus on hands and plate.
${PHOTO_TECH}
${NEVER}`,
      socialSquare: () => `Instagram 1:1 food campaign for ${brandName}.
Extreme close-up: signature dish. Sauce dripping from lifted fork.
Steam curling. Every ingredient texture visible and sharp.
Dramatic side lighting, long shadows. ${primary} ceramic on dark background.
Image triggers immediate hunger.
${PHOTO_TECH}
${NEVER}`,
      flatlay: () => `Professional overhead food photography for ${brandName}.
Multiple dishes and raw ingredients in deconstructed composition.
Dark slate surface with natural texture.
Fresh herbs with visible moisture, spices in brass bowls.
${primary} linen napkin at edge. Phase One overhead, everything razor-sharp.
${PHOTO_TECH}
${NEVER}`,
    },

    default: {
      heroBottle: () => `Professional commercial product photography for ${brandName}.
${isLuxury ? 'Ultra-premium' : 'Clean professional'} aesthetic.
${primary} and ${accent} color story. Polished ${isLuxury ? 'obsidian' : 'acrylic'} surface.
${PHOTO_TECH}
${NEVER}`,
      lifestyle: () => `Lifestyle editorial for ${brandName}. Authentic human moment.
${primary} and ${accent} environmental tones. Real person, natural expression.
Shot f/2.0, environmental bokeh.
${PHOTO_TECH}
${NEVER}`,
      socialSquare: () => `Instagram 1:1 campaign for ${brandName}.
Hero product dramatic lighting. ${primary}-to-dark gradient background.
Strong shadow, premium composition, generous negative space.
${PHOTO_TECH}
${NEVER}`,
      flatlay: () => `Flat-lay for ${brandName}. Overhead hero product with lifestyle props.
${primary} and ${accent} accents. Precise but organic arrangement.
${PHOTO_TECH}
${NEVER}`,
    },
  };

  const catPrompts = RAW_PROMPTS[category] || RAW_PROMPTS.default;
  const promptFn = catPrompts[imageType] || catPrompts.heroBottle || RAW_PROMPTS.default.heroBottle;
  return promptFn();
}

// ── Step 2: Claude Purification Agent ───────────────────────────────────────

async function purifyPrompt(rawPrompt, brandContext, imageType, userId) {
  const system = `You are an expert commercial photography art director and AI prompt engineer.
You work for Qumak, a UAE brand building platform.
Your job: take a raw image generation prompt and make it produce ultra-realistic,
award-winning commercial photography that looks indistinguishable from real studio photography.

Rules:
1. Keep ALL specific brand details (colors, materials, bottle descriptions, brand name)
2. Add cinematic lighting language that works with gpt-image-1
3. Add tactile material descriptions — glass weight, fabric texture, metal finish
4. Remove vague words like "beautiful", "stunning", "amazing"
5. Add specific camera settings that signal photorealism
6. Add negative guidance inline (not as separate parameter)
7. Keep the prompt under 900 words
8. For perfume: always mention light refraction through glass, caustic light patterns
9. For skincare: always mention skin texture visibility, not airbrushed
10. For food: always mention steam, sauce glistening, moisture on fresh ingredients
11. For lifestyle shots: always specify the exact position of the product in frame
12. End with: "This image is indistinguishable from a real commercial photograph."

UAE market specifics to add when relevant:
- Arabic luxury aesthetics: arabesque patterns, brass detailing, oud wood references
- UAE consumer: appreciates quality signifiers (heavy glass, precise machining)
- Dubai settings: golden hour on modern architecture, marble interiors
- Skin tones: warm neutral to olive tones for lifestyle shots

Output ONLY the purified prompt. No explanation. No preamble. Just the prompt.`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system,
    messages: [{
      role: 'user',
      content: `Purify this prompt for ${imageType} image of ${brandContext.brandName} (${brandContext.category}):\n\n${rawPrompt}`,
    }],
  });

  if (userId) {
    await tokenMeter.log({
      userId,
      feature: 'prompt_purification',
      model: 'claude-sonnet-4-20250514',
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      brandId: brandContext.brandId,
    });
  }

  return response.content[0].text;
}

// ── Step 3: Image API Router ────────────────────────────────────────────────

const IMAGE_ROUTING = {
  gpt_image_1: ['heroBottle', 'flatlay', 'unboxing', 'socialSquare', 'store', 'logo'],
  flux_pro: ['lifestyle', 'ugc', 'portrait'],
};

async function callGptImage1(purifiedPrompt, userId, brandId) {
  const response = await getOpenAI().images.generate({
    model: 'gpt-image-1',
    prompt: purifiedPrompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
    output_format: 'webp',
    output_compression: 85,
  });

  const base64 = response.data[0].b64_json;

  if (userId) {
    await tokenMeter.log({
      userId,
      feature: 'image_generation',
      model: 'gpt-image-1',
      tokensIn: 0,
      tokensOut: 0,
      imageCostUSD: 0.19,
      brandId,
    });
  }

  return { base64, model: 'gpt-image-1' };
}

async function callFluxPro(purifiedPrompt, userId, brandId) {
  ensureFal();
  const result = await fal.subscribe('fal-ai/flux-pro/kontext/text-to-image', {
    input: {
      prompt: purifiedPrompt,
      guidance_scale: 3.5,
      num_images: 1,
      output_format: 'jpeg',
      aspect_ratio: '3:4',
      safety_tolerance: '3',
    },
    logs: false,
  });

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error('Flux Pro generation failed — no image returned');

  if (userId) {
    await tokenMeter.log({
      userId,
      feature: 'image_generation',
      model: 'flux-pro',
      tokensIn: 0,
      tokensOut: 0,
      imageCostUSD: 0.05,
      brandId,
    });
  }

  return { url: imageUrl, model: 'flux-pro' };
}

// ── Main Export ─────────────────────────────────────────────────────────────

async function generateBrandImage(brandContext, imageType, userId) {
  const rawPrompt = buildRawPrompt(brandContext, imageType);
  const purifiedPrompt = await purifyPrompt(rawPrompt, brandContext, imageType, userId);
  const useFlux = IMAGE_ROUTING.flux_pro.includes(imageType);

  let result;
  if (useFlux) {
    try {
      result = await callFluxPro(purifiedPrompt, userId, brandContext.brandId);
    } catch (fluxErr) {
      console.warn(`[ImageGen] Flux failed for ${imageType}, falling back to GPT-image-1:`, fluxErr.message);
      result = await callGptImage1(purifiedPrompt, userId, brandContext.brandId);
    }
  } else {
    result = await callGptImage1(purifiedPrompt, userId, brandContext.brandId);
  }

  return {
    ...result,
    rawPrompt,
    purifiedPrompt,
    imageType,
    model: result.model,
  };
}

async function generateMockupSet(brandContext, userId) {
  const types = ['heroBottle', 'lifestyle', 'flatlay', 'socialSquare'];
  const results = {};

  for (const type of types) {
    try {
      results[type] = await generateBrandImage(brandContext, type, userId);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[ImageGen] Failed ${type}:`, err.message);
      results[type] = { error: err.message, imageType: type };
    }
  }

  return results;
}

async function generateLogoImage(brandContext, userId) {
  const { brandName, category, colorPalette } = brandContext;
  const primary = colorPalette?.primaryName || colorPalette?.primary || 'gold';
  const accent = colorPalette?.accentName || colorPalette?.accent || 'black';

  const rawPrompt = `Minimalist luxury logo icon for ${brandName}, a ${category} brand.
Single abstract monogram or symbol derived from the letter "${(brandName || 'Q')[0]}".
Color: ${primary} on transparent background. No text. No wordmark.
Clean geometric or organic flowing form. Suitable for embossing on glass, foil stamping on packaging, and favicon.
Style: Chanel, Tom Ford, Aesop level of logo simplicity.
Vector-quality crisp edges, single color, scalable from 16px favicon to 600px print.
Absolutely no gradients, no shadows, no 3D effects, no photorealism.
Pure logo mark icon only.`;

  const purifiedPrompt = await purifyPrompt(rawPrompt, brandContext, 'logo', userId);
  const result = await callGptImage1(purifiedPrompt, userId, brandContext.brandId);

  return {
    ...result,
    rawPrompt,
    purifiedPrompt,
    imageType: 'logo',
  };
}

module.exports = {
  generateBrandImage,
  generateMockupSet,
  generateLogoImage,
  buildRawPrompt,
  purifyPrompt,
};
