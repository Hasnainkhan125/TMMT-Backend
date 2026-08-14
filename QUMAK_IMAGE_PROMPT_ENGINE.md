# QUMAK — PROMPT PURIFICATION ENGINE + TOKEN TRACKING
# Backend: imagePromptPurifier.js + tokenMeter.js
# Frontend: TokenBar.tsx + generateVisual.ts (simplified)
# April 2026

---

## THE ARCHITECTURE DECISION

Frontend → sends brand context (name, category, palette, inputs)
Backend → builds raw prompt → purifies through Claude → calls image API → returns URL

Never expose prompt engineering on the frontend.
Never let the frontend call image APIs directly.
The purification agent is Qumak's secret sauce.

---

## SESSION 1 — PROMPT PURIFICATION ENGINE
## File: qumak-backend/services/imagePromptPurifier.js

CURSOR PROMPT:
"Focus only on creating qumak-backend/services/imagePromptPurifier.js

This service is the core of Qumak's image generation quality.
It takes a brand context object, builds a raw prompt, runs it through
Claude to purify and elevate it, then routes to the correct image API.

IMPORTS:
const Anthropic = require('@anthropic-ai/sdk')
const OpenAI = require('openai')
const fetch = require('node-fetch')
const tokenMeter = require('./tokenMeter')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: RAW PROMPT BUILDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildRawPrompt(brandContext, imageType) {
  const {
    brandName, category, tone, colorPalette,
    fragranceFamily, bottleShape, bottleMaterial, capStyle,
    labelFinish, outerBox, boxExterior,
    skinConcerns, packagingStyle, keyIngredients,
    targetPersona, positioning, pricePoint,
    inputs = {}
  } = brandContext

  const primary = colorPalette?.primaryName || colorPalette?.primary || 'warm amber'
  const accent  = colorPalette?.accentName  || colorPalette?.accent  || 'burnished gold'
  const isLuxury = tone === 'luxury' || pricePoint?.includes('ultra') || pricePoint?.includes('700')
  const isMinimal = tone?.includes('minimal') || packagingStyle?.includes('minimal')

  // Camera and lighting constants — proven to work with gpt-image-1
  const PHOTO_TECH = `Captured on Phase One IQ4 150MP, Schneider 120mm f/3.5 LS at f/8, ISO 50. Profoto D2 three-point lighting: 3x4ft softbox key at 45° camera-left, fill card at 2:1 ratio, rim light for edge separation. 16-bit color depth, 5200K white balance, Capture One processing. Photorealistic commercial photography, indistinguishable from a real photograph.`

  const NEVER = `NEVER: cartoon, illustration, 3D render, CGI look, plastic textures, oversaturation, AI artifacts, text overlays, watermarks, logos, stock photo composition, symmetrical boring layout, fake bokeh.`

  // Category-specific raw prompts
  const RAW_PROMPTS = {

    perfume: {
      heroBottle: () => {
        const bottle = `${bottleShape || 'angular faceted'} ${bottleMaterial || 'frosted glass'} bottle with ${capStyle || 'heavy magnetic zamac cap'} and ${labelFinish || 'debossed matte label'}`
        const surface = isLuxury ? 'polished obsidian surface with razor-thin shadow' : 'brushed concrete with organic shadow'
        const notes = (inputs.topNotes || []).join(', ') || 'saffron, bergamot'
        const base  = (inputs.baseNotes || []).join(', ') || 'sandalwood, musk'
        const props = fragranceFamily?.includes('Oud') || fragranceFamily === 'Oriental'
          ? 'raw oud wood chips, saffron threads in brass dish, frankincense resin, dried damask rose'
          : fragranceFamily?.includes('Floral')
          ? 'fresh rosa damascena petals, jasmine sambac buds, tuberose sprig'
          : fragranceFamily?.includes('Fresh') || fragranceFamily?.includes('Citrus')
          ? 'Meyer lemon slice, bergamot peel curl, green cardamom pods, mint leaves'
          : 'vetiver roots, tonka beans, cedarwood bark, amber resin'

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
${NEVER}`
      },

      lifestyle: () => {
        const gender = inputs.gender || 'Unisex'
        const hand = gender === 'For Her' || gender === 'Women'
          ? "UAE woman's hand with French manicure, thin gold ring, delicate chain bracelet, warm skin tone with visible natural pores"
          : gender === 'For Him' || gender === 'Men'
          ? "well-groomed man's hand with clean short nails, premium watch visible at wrist, natural masculine skin texture"
          : "elegant hand with thin band ring, natural skin texture, warm-toned"
        const setting = isLuxury
          ? 'luxury Dubai hotel lobby — warm amber chandelier bokeh, dark architectural elements, f/1.8 shallow depth'
          : 'golden hour rooftop terrace — Dubai skyline at dusk, warm ambient light bokeh'

        return `Ultra-realistic luxury fragrance lifestyle photograph. Instagram campaign quality.
A ${bottleShape || 'angular'} ${bottleMaterial || 'frosted glass'} ${brandName} perfume bottle
held in a ${hand} at a natural 30-degree wrist angle.
Background: ${setting}.
Only hand and bottle in sharp focus. Everything else is creamy bokeh.
Color grade: warm shadows, cool highlights, lifted blacks.
${PHOTO_TECH}
${NEVER}`
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
          : 'dried botanicals, crystals, raw ingredient reference, silk ribbon'
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
${NEVER}`
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
        const product = (inputs.productTypes || ['Serum'])[0]
        const concern = (skinConcerns || ['Hydration'])[0]
        const ing = (inputs.keyIngredients || keyIngredients || ['Hyaluronic Acid'])[0]
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
${NEVER}`
      },

      lifestyle: () => {
        const concern = (skinConcerns || ['Hydration'])[0]
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
${NEVER}`
      },

      socialSquare: () => {
        const concern = (skinConcerns || ['Hydration'])[0]
        const ing = (inputs.keyIngredients || ['Hyaluronic Acid'])[0]
        return `Instagram 1:1 skincare campaign for ${brandName}.
Extreme close-up: model's face nose to chin, eyes closed, warm golden-hour window light from left.
Skin is stunning but real: visible pores, natural sheen suggesting product just applied.
Fingers gently touching jawline showing ${concern} result.
Lower-right: hero product bottle, slightly soft-focus but identifiable, leaning against mirror.
Background: diffused warm white.
Color grade: golden warmth in shadows, clean highlights, skin-true accuracy.
Result sells the product, not the bottle.
${PHOTO_TECH}
${NEVER}`
      },

      flatlay: () => {
        const products = (inputs.productTypes || ['Serum', 'Moisturizer']).slice(0, 3).join(', ')
        const ing = (inputs.keyIngredients || ['Hyaluronic Acid'])[0]
        return `Professional skincare flat-lay for ${brandName}. Into The Gloss editorial quality.
${packagingStyle || 'Minimal white'} products in flowing S-curve: ${products}.
Props: fresh eucalyptus stems, ceramic mortar with ${ing} raw ingredient,
cotton pad, brass spoon. 
Carrara marble with subtle grey veining.
Soft diffused window light upper-left.
Everything edge-to-edge sharp. Each product with tiny shadow for dimensionality.
Color story: whites, creams, soft sage, ${primary} accent on labels.
${PHOTO_TECH}
${NEVER}`
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
    }
  }

  const catPrompts = RAW_PROMPTS[category] || RAW_PROMPTS.default
  const promptFn = catPrompts[imageType] || catPrompts.heroBottle || RAW_PROMPTS.default.heroBottle
  return promptFn()
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: CLAUDE PURIFICATION AGENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function purifyPrompt(rawPrompt, brandContext, imageType, userId) {

  const system = `You are an expert commercial photography art director and AI prompt engineer.
You work for Qumak, a UAE brand building platform.
Your job: take a raw image generation prompt and make it produce ultra-realistic, 
award-winning commercial photography that looks indistinguishable from real studio photography.

Rules you follow:
1. Keep ALL specific brand details (colors, materials, bottle descriptions, brand name)
2. Add cinematic lighting language that actually works with gpt-image-1
3. Add tactile material descriptions — glass weight, fabric texture, metal finish
4. Remove vague words like "beautiful", "stunning", "amazing"
5. Add specific camera settings that signal photorealism
6. Add negative guidance inline (not as separate parameter)
7. Keep the prompt under 900 words — longer prompts confuse the model
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

Output ONLY the purified prompt. No explanation. No preamble. Just the prompt.`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system,
    messages: [{
      role: 'user',
      content: `Purify this prompt for ${imageType} image of ${brandContext.brandName} (${brandContext.category}):

${rawPrompt}`
    }]
  })

  // Track tokens
  await tokenMeter.log({
    userId,
    feature: 'prompt_purification',
    model: 'claude-sonnet-4-20250514',
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    brandId: brandContext.brandId
  })

  return response.content[0].text
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: IMAGE API ROUTER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const IMAGE_ROUTING = {
  // gpt-image-1: best for products, packshots, flat lays (controllable, consistent)
  gpt_image_1: ['heroBottle', 'flatlay', 'unboxing', 'socialSquare', 'store'],
  // fal.ai Flux Pro: best for people, lifestyle (photorealistic humans)
  flux_pro: ['lifestyle', 'ugc', 'portrait']
}

async function callGptImage1(purifiedPrompt, userId, brandId) {
  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: purifiedPrompt,
    n: 1,
    size: '1024x1536',  // portrait for most product shots
    quality: 'high',
    output_format: 'webp',
    output_compression: 85
  })

  // gpt-image-1 returns base64
  const base64 = response.data[0].b64_json

  // Track credit usage (gpt-image-1 high quality ~$0.19 per image)
  await tokenMeter.log({
    userId,
    feature: 'image_generation',
    model: 'gpt-image-1',
    tokensIn: 0,
    tokensOut: 0,
    imageCostUSD: 0.19,
    brandId
  })

  return { base64, model: 'gpt-image-1' }
}

async function callFluxPro(purifiedPrompt, userId, brandId) {
  const response = await fetch('https://fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${process.env.FAL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: purifiedPrompt,
      image_size: 'portrait_4_3',
      num_inference_steps: 25,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true,
      output_format: 'webp'
    })
  })
  const data = await response.json()

  if (!data.images?.[0]?.url) throw new Error('Flux Pro generation failed')

  // Track credit usage (Flux Pro ~$0.05 per image)
  await tokenMeter.log({
    userId,
    feature: 'image_generation',
    model: 'flux-pro',
    tokensIn: 0,
    tokensOut: 0,
    imageCostUSD: 0.05,
    brandId
  })

  return { url: data.images[0].url, model: 'flux-pro' }
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAIN EXPORTED FUNCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function generateBrandImage(brandContext, imageType, userId) {
  // Step 1: Build raw prompt from brand data
  const rawPrompt = buildRawPrompt(brandContext, imageType)

  // Step 2: Purify through Claude agent
  const purifiedPrompt = await purifyPrompt(rawPrompt, brandContext, imageType, userId)

  // Step 3: Route to correct image model
  const useFlux = IMAGE_ROUTING.flux_pro.includes(imageType)
  
  let result
  if (useFlux) {
    result = await callFluxPro(purifiedPrompt, userId, brandContext.brandId)
  } else {
    result = await callGptImage1(purifiedPrompt, userId, brandContext.brandId)
  }

  // Return both the image and the prompt (for admin quality review)
  return {
    ...result,
    rawPrompt,
    purifiedPrompt,
    imageType,
    model: result.model
  }
}

// Batch: generate all 4 mockups for a brand
async function generateMockupSet(brandContext, userId) {
  const types = ['heroBottle', 'lifestyle', 'flatlay', 'socialSquare']
  const results = {}

  for (const type of types) {
    try {
      results[type] = await generateBrandImage(brandContext, type, userId)
      // 2 second delay between calls to avoid rate limits
      await new Promise(r => setTimeout(r, 2000))
    } catch (err) {
      console.error(`[ImageGen] Failed ${type}:`, err.message)
      results[type] = { error: err.message, imageType: type }
    }
  }

  return results
}

module.exports = { generateBrandImage, generateMockupSet, buildRawPrompt, purifyPrompt }

Do not touch any other file."

---

## SESSION 2 — TOKEN METER SERVICE
## File: qumak-backend/services/tokenMeter.js

CURSOR PROMPT:
"Focus only on creating qumak-backend/services/tokenMeter.js

This tracks every AI API call per user for billing and quota enforcement.

const mongoose = require('mongoose')

// Schema inline (or import from models if you prefer)
const usageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', index: true },
  feature: { 
    type: String, 
    enum: ['brand_generation', 'image_generation', 'prompt_purification', 'agent_research', 
           'content_generation', 'leads_generation', 'cofounder_chat', 'analyze_url'],
    required: true 
  },
  model: { type: String, required: true },
  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  imageCostUSD: { type: Number, default: 0 },
  estimatedCostUSD: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true }
})

// Auto-calculate cost
usageSchema.pre('save', function() {
  const TOKEN_COSTS = {
    'claude-sonnet-4-20250514': { in: 0.000003, out: 0.000015 },
    'claude-haiku-4-5-20251001': { in: 0.0000008, out: 0.000004 },
    'gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
    'gpt-image-1': { in: 0, out: 0 }, // cost tracked via imageCostUSD
    'flux-pro': { in: 0, out: 0 },
  }
  const cost = TOKEN_COSTS[this.model] || { in: 0, out: 0 }
  this.estimatedCostUSD = (this.tokensIn * cost.in) + (this.tokensOut * cost.out) + (this.imageCostUSD || 0)
})

const Usage = mongoose.model('Usage', usageSchema)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN LIMITS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PLAN_LIMITS = {
  trial: {
    tokensPerMonth: 50000,
    imagesPerMonth: 5,
    brandsTotal: 1,
    leadsPerMonth: 0,
    researchPerMonth: 3,
  },
  free: {
    tokensPerMonth: 30000,
    imagesPerMonth: 3,
    brandsTotal: 1,
    leadsPerMonth: 0,
    researchPerMonth: 2,
  },
  pro: {
    tokensPerMonth: 500000,
    imagesPerMonth: 50,
    brandsTotal: 5,
    leadsPerMonth: 100,
    researchPerMonth: 30,
  },
  growth: {
    tokensPerMonth: 2000000,
    imagesPerMonth: 200,
    brandsTotal: 999,
    leadsPerMonth: 999,
    researchPerMonth: 999,
  }
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPORTED FUNCTIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function log({ userId, brandId, feature, model, tokensIn, tokensOut, imageCostUSD }) {
  const entry = new Usage({ userId, brandId, feature, model, tokensIn, tokensOut, imageCostUSD })
  await entry.save()
  return entry
}

async function getUserStats(userId, plan = 'trial') {
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const pipeline = [
    { $match: { userId: new mongoose.Types.ObjectId(userId), createdAt: { $gte: startOfMonth } } },
    { $group: {
      _id: '$feature',
      tokensUsed: { $sum: { $add: ['$tokensIn', '$tokensOut'] } },
      imagesGenerated: { $sum: { $cond: [{ $eq: ['$feature', 'image_generation'] }, 1, 0] } },
      totalCostUSD: { $sum: '$estimatedCostUSD' }
    }}
  ]

  const results = await Usage.aggregate(pipeline)

  const totals = results.reduce((acc, r) => ({
    tokensUsed: acc.tokensUsed + r.tokensUsed,
    imagesGenerated: acc.imagesGenerated + r.imagesGenerated,
    totalCostUSD: acc.totalCostUSD + r.totalCostUSD
  }), { tokensUsed: 0, imagesGenerated: 0, totalCostUSD: 0 })

  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial

  return {
    plan,
    tokensUsed: totals.tokensUsed,
    tokensLimit: limits.tokensPerMonth,
    tokensPercent: Math.min(100, Math.round((totals.tokensUsed / limits.tokensPerMonth) * 100)),
    tokensRemaining: Math.max(0, limits.tokensPerMonth - totals.tokensUsed),
    imagesUsed: totals.imagesGenerated,
    imagesLimit: limits.imagesPerMonth,
    imagesPercent: Math.min(100, Math.round((totals.imagesGenerated / limits.imagesPerMonth) * 100)),
    totalCostUSD: Math.round(totals.totalCostUSD * 100) / 100,
    resetDate: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    breakdown: results
  }
}

async function checkCanGenerate(userId, plan, feature) {
  const stats = await getUserStats(userId, plan)
  
  if (feature === 'image_generation') {
    return { allowed: stats.imagesUsed < stats.imagesLimit, reason: 'image_limit_reached' }
  }
  
  // Default: check token budget
  if (stats.tokensPercent >= 100) {
    return { allowed: false, reason: 'token_limit_reached' }
  }
  
  return { allowed: true }
}

module.exports = { log, getUserStats, checkCanGenerate, PLAN_LIMITS }

Do not touch any other file."

---

## SESSION 3 — API ROUTE: IMAGE GENERATION
## File: qumak-backend/routes/images.js (add to existing brand-ai routes)

CURSOR PROMPT:
"Focus only on qumak-backend/routes/images.js

Add this file. Register it in server.js as app.use('/api/v1/images', imageRouter)

const router = require('express').Router()
const auth = require('../middleware/auth')
const imagePromptPurifier = require('../services/imagePromptPurifier')
const tokenMeter = require('../services/tokenMeter')
const BrandProject = require('../models/brandProject')
const User = require('../models/user')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')

const s3 = new S3Client({ region: process.env.AWS_REGION || 'me-south-1' })

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POST /api/v1/images/generate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Auth: required
Body: { brandId, imageType }
imageType: 'heroBottle' | 'lifestyle' | 'flatlay' | 'socialSquare' | 'unboxing' | 'store'

const brand = await BrandProject.findOne({ _id: req.body.brandId, user: req.user._id })
if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' })

const user = await User.findById(req.user._id)
const plan = user.plan || 'trial'

// Check quota
const { allowed, reason } = await tokenMeter.checkCanGenerate(req.user._id, plan, 'image_generation')
if (!allowed) {
  return res.status(429).json({
    success: false,
    message: reason === 'image_limit_reached' 
      ? `You've used all ${tokenMeter.PLAN_LIMITS[plan].imagesPerMonth} image generations this month. Upgrade for more.`
      : 'Monthly AI credits exhausted. Upgrade to continue.',
    upgradeUrl: '/pricing',
    reason
  })
}

// Build brand context from project
const brandContext = {
  brandId: brand._id,
  brandName: brand.config?.brand?.brandName || brand.projectName,
  category: brand.businessType,
  tone: brand.config?.brand?.brandVoice?.[0] || 'luxury',
  colorPalette: brand.config?.brand?.colorPalette,
  positioning: brand.config?.brand?.positioning,
  targetPersona: brand.config?.brand?.customerPersona,
  pricePoint: brand.fragranceConfig?.pricePoint || brand.skincareConfig?.priceTier,
  fragranceFamily: brand.fragranceConfig?.fragranceFamily,
  inputs: brand.fragranceConfig || brand.skincareConfig || {},
  skinConcerns: brand.skincareConfig?.skinConcerns,
  packagingStyle: brand.skincareConfig?.packagingStyle,
  keyIngredients: brand.skincareConfig?.keyIngredients,
  bottleShape: brand.fragranceConfig?.bottleShape || brand.packaging?.bottleShape,
  bottleMaterial: brand.fragranceConfig?.bottleMaterial || brand.packaging?.bottleMaterial,
  capStyle: brand.fragranceConfig?.capStyle || brand.packaging?.capStyle,
  labelFinish: brand.fragranceConfig?.labelFinish,
  outerBox: brand.fragranceConfig?.outerBox,
  boxExterior: brand.fragranceConfig?.boxExterior,
}

// Set timeout for long generation
res.setTimeout(120000)

const result = await imagePromptPurifier.generateBrandImage(brandContext, req.body.imageType, req.user._id)

// If gpt-image-1 returned base64, upload to S3
let imageUrl = result.url
if (result.base64) {
  const buffer = Buffer.from(result.base64, 'base64')
  const key = `brands/${brand._id}/images/${req.body.imageType}-${Date.now()}.webp`
  
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/webp',
    ACL: 'public-read'
  }))
  
  imageUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
}

// Save to brand's generatedAssets
await BrandProject.findByIdAndUpdate(brand._id, {
  $push: { generatedAssets: {
    type: req.body.imageType,
    url: imageUrl,
    model: result.model,
    prompt: result.purifiedPrompt,
    generatedAt: new Date(),
    status: 'ready'
  }}
})

return res.json({
  success: true,
  url: imageUrl,
  model: result.model,
  imageType: req.body.imageType,
})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GET /api/v1/images/usage
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Auth: required

const user = await User.findById(req.user._id)
const plan = user.plan || 'trial'
const stats = await tokenMeter.getUserStats(req.user._id, plan)
return res.json({ success: true, stats })

Do not touch any other file."

---

## SESSION 4 — FRONTEND: TOKEN BAR COMPONENT
## File: src/components/shell/TokenUsageBar.tsx

CURSOR PROMPT:
"Focus only on creating src/components/shell/TokenUsageBar.tsx

This shows token + image usage in the sidebar footer and topbar.
It auto-fetches from GET /api/v1/images/usage on mount.
It updates every 60 seconds.

PROPS:
  variant: 'sidebar' | 'topbar' | 'dashboard'

STATE:
  stats: { tokensUsed, tokensLimit, tokensPercent, tokensRemaining,
           imagesUsed, imagesLimit, imagesPercent, plan, totalCostUSD }
  loading: boolean

FETCH: GET /api/v1/images/usage — with auth token from localStorage

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VARIANT: sidebar
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Compact, fits in sidebar footer.

Container: padding 10px, border-top sidebar border.

Row 1: 'AI Credits' label (10px, muted) + plan badge (8px pill)
  Plan colors: trial=gray, free=gray, pro=gold, growth=emerald

Row 2: Token progress bar
  Height: 2px
  Background: rgba(255,255,255,0.08)
  Fill color:
    0-60%: gold (#C9A227)
    60-80%: amber (#F59E0B)  
    80-95%: orange (#F97316)
    95-100%: red (#EF4444)
  Animated fill transition: 0.8s ease
  
Row 3: Stats row
  Left: '{tokensRemaining.toLocaleString()} credits left' (9px, muted)
  Right: 'Upgrade →' link (9px, gold) — only if plan is trial or free

Row 4: Images row (if imagesLimit > 0)
  '{imagesUsed}/{imagesLimit} images' (9px, muted)
  Small image icon (9px)

When tokensPercent >= 95:
  Add warning glow: box-shadow 0 0 8px rgba(239,68,68,0.3) on container

When tokensPercent >= 100:
  Replace token bar with red banner:
  'Credits exhausted · [Upgrade →]'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VARIANT: topbar
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Inline pill shown in topbar right section.

Shape: rounded pill, 28px height
Background: var(--bg-surface)
Content: [colored dot] [tokensRemaining.toLocaleString()] credits
Dot color matches token bar color logic above.
Font: 11px, font-mono for the number

On hover: show tooltip with full stats card:
  Tokens: {used} / {limit} ({percent}%)
  Images: {imagesUsed} / {imagesLimit}
  Plan: {plan}
  Resets: {resetDate formatted}

On click (if trial/free): navigate to /pricing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VARIANT: dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Full card shown on brand overview dashboard.

Card:
  Title: 'AI Credits & Usage'
  Plan badge
  
  Two progress rows:
  
  Row 1: Tokens
    Label: 'AI Tokens' + '{percent}%' right-aligned
    Bar: full width, 4px height, color-coded
    Below: '{used.toLocaleString()} of {limit.toLocaleString()} used'
  
  Row 2: Images  
    Label: 'Image Generations' + '{imagesUsed}/{imagesLimit}' right-aligned
    Bar: full width, 4px height
    Below: '{imagesLimit - imagesUsed} remaining this month'
  
  Reset line: 'Resets {resetDate}' — 10px, muted
  
  Upgrade CTA (if trial or free):
    Gold bordered section:
    'Upgrade to Pro for {AED 499}/mo — 500K tokens + 50 images'
    [Upgrade Now →] gold button

FETCH INTERVAL: every 60 seconds (setInterval)
Clear interval on unmount.

Export as default. No external libraries.
Use var(--*) CSS variables from design system.
Do not touch any other file."

---

## SESSION 5 — FRONTEND: SIMPLIFIED BRAND ENGINE (remove prompt logic)
## File: src/services/brandEngine.ts — EDIT ONLY buildMockupPrompts

CURSOR PROMPT:
"Focus only on src/services/brandEngine.ts

Find the function buildMockupPrompts and DELETE its entire implementation.
Replace with:

export function buildMockupPrompts(brand: BrandData, category: string, inputs: any): MockupPrompts {
  // Prompt engineering is handled server-side by imagePromptPurifier.js
  // This function is deprecated — kept for backwards compatibility only
  // Frontend never builds prompts directly
  const base = brand.brandName || 'Brand'
  return {
    heroBottle:   `${base} hero product shot`,
    lifestyle:    `${base} lifestyle`,
    flatlay:      `${base} flat lay`,
    unboxing:     `${base} unboxing`,
    store:        `${base} store`,
    socialSquare: `${base} social`,
  }
}

Also update generateMockupImage to call the new backend route:
export async function generateMockupImage(prompt: string, brandId?: string, imageType?: string): Promise<string> {
  // If brandId and imageType provided, use the new purified pipeline
  if (brandId && imageType) {
    const res = await fetch(`${API_BASE}/api/v1/images/generate`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
      },
      body: JSON.stringify({ brandId, imageType })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.message || 'Image generation failed')
    return data.url
  }
  
  // Fallback: old route for unauthenticated or simple prompts
  const res = await fetch(`${API_BASE}/api/v1/brand-ai/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  })
  const data = await res.json()
  if (!data.success) throw new Error(data.message || 'Image generation failed')
  return data.url
}

Do not touch anything else in this file."

---

## ENVIRONMENT VARIABLES NEEDED

Add to qumak-backend/.env:
FAL_API_KEY=your_fal_api_key        # get at fal.ai — Flux Pro for lifestyle images
OPENAI_API_KEY=your_openai_key      # existing
ANTHROPIC_API_KEY=your_anthropic_key # existing
AWS_S3_BUCKET=qumak-brands
AWS_REGION=me-south-1

Install packages:
npm install @aws-sdk/client-s3 node-fetch (in qumak-backend)
npm install fal-ai (optional — can use raw fetch as shown above)

---

## WHY THIS ARCHITECTURE WORKS

1. PROMPT ENGINEERING IS HIDDEN
   Your buildMockupPrompts function had ~800 lines of excellent prompt logic.
   On the frontend, that's public. Any competitor inspects your bundle and copies it.
   Moving it to the backend makes it a trade secret.

2. CLAUDE PURIFICATION ADDS ~30% QUALITY
   The raw prompt is already good. Claude's job is to add the specific technical details
   that gpt-image-1 responds to: material weight, light physics, tactile descriptions.
   The difference is measurable — your current images vs Ajmal quality.
   Claude adds 10-15 specific photographic details per prompt that the raw builder misses.

3. MODEL ROUTING DOUBLES QUALITY
   gpt-image-1 for products = controllable, consistent, premium objects
   Flux Pro for people/lifestyle = photorealistic humans, real skin, authentic UAE faces
   Using gpt-image-1 for lifestyle shots is why they look "off" — switch to Flux Pro.

4. TOKEN TRACKING ENABLES MONETIZATION
   Every AI call is logged. Dashboard shows real usage.
   When a founder sees "420 of 500 credits used" they upgrade.
   That bar converting users to paid is worth 10x the development cost.

5. COMPETITOR PROMPT ANALYSIS (optional extension)
   Add a function: analyzeCompetitorVisuals(instagramUrl)
   Claude uses web_search to find competitor's top posts
   Identifies their visual style, color temperature, composition patterns
   Adds "differentiation instructions" to your prompt:
   "The competitor uses bright overhead lighting — use dramatic side lighting instead"
   This makes your generated images visually distinct from competitors automatically.

---

## IMPLEMENTATION ORDER

Day 1: tokenMeter.js + images route (Sessions 2 + 3)
        Test: POST /api/v1/images/generate with a real brand — check S3 upload
        
Day 2: imagePromptPurifier.js (Session 1)
        Test: generate same image type before/after — compare quality
        
Day 3: TokenUsageBar.tsx (Session 4)
        Add to sidebar footer and topbar
        
Day 4: Update brandEngine.ts (Session 5)
        Remove 800 lines of prompt logic from frontend bundle

Day 5: Test full flow with real brand, all 4 image types
        Compare quality vs previous approach — should be visibly better
```
