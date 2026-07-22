# Qumak Studio — AI Ad Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete video ad generation system (Qumak Studio) to the existing Express.js backend with BullMQ job queuing, fal.ai video generation, FFmpeg post-processing, Cloudflare R2 storage, and Redis pub/sub for real-time socket updates.

**Architecture:** Anonymous users submit video generation requests via REST → controller validates input, creates a MongoDB job, enqueues to BullMQ; a separate PM2 worker process consumes the queue, calls fal.ai, runs FFmpeg post-processing, uploads to R2, and broadcasts progress via Redis pub/sub → the main server's socket.io relays updates to connected clients.

**Tech Stack:** Express.js (CommonJS), BullMQ + ioredis (queue + pub/sub), @fal-ai/client (video generation), @aws-sdk/client-s3 (R2 upload), FFmpeg via child_process, Mongoose, zod (validation), express-rate-limit (already installed), uuid (already installed).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `model/schema/studioJob.js` | Mongoose schema for video generation jobs |
| Create | `model/schema/dailyStat.js` | Mongoose schema for daily usage stats |
| Create | `services/adBrain.js` | Category DNA + prompt assembly engine |
| Create | `services/falService.js` | fal.ai API wrapper (generate, upscale, image) |
| Create | `services/storageService.js` | Cloudflare R2 upload via @aws-sdk/client-s3 |
| Create | `services/processingService.js` | FFmpeg color grading + watermark pipeline |
| Create | `utils/socketEmitter.js` | Redis pub/sub bridge: worker → socket.io |
| Create | `controllers/studio/studioController.js` | Main HTTP controller (generate, status, list) |
| Create | `controllers/studio/adminStudioController.js` | Admin stats controller |
| Create | `controllers/studio/_routes.js` | Route definitions with rate limiting |
| Create | `workers/videoWorker.js` | BullMQ worker (separate PM2 process) |
| Modify | `index.js` | Register studio routes + socket subscriber |
| Create | `ecosystem.config.cjs` | PM2 config with worker entry |

---

## Task 1: Install zod

**Files:**
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Install zod**

```bash
cd /Users/gaian/Projects/startups/Qumak/qumak-backend
npm install zod
```

Expected output: `added 1 package` (zod has no dependencies).

- [ ] **Step 2: Verify install**

```bash
node -e "const { z } = require('zod'); console.log('zod OK', z.string().parse('test'))"
```

Expected: `zod OK test`

---

## Task 2: Create Mongoose Models

**Files:**
- Create: `model/schema/studioJob.js`
- Create: `model/schema/dailyStat.js`

- [ ] **Step 1: Create `model/schema/studioJob.js`**

```javascript
const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const studioJobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sessionId: { type: String, required: true, index: true },

  category: {
    type: String,
    enum: ['gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service'],
    required: true
  },

  userInputs: {
    brandName: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500, default: '' },
    targetAudience: { type: String, maxlength: 200, default: '' },
    vibe: { type: String, maxlength: 50, default: '' },
    locale: { type: String, enum: ['gulf', 'global'], default: 'gulf' },
    aspectRatio: { type: String, enum: ['16:9', '9:16', '1:1'], default: '16:9' },
    duration: { type: Number, enum: [5, 10], default: 5 },
    extras: { type: mongoose.Schema.Types.Mixed, default: {} }
  },

  promptPipeline: {
    rawUserIntent: { type: String, default: '' },
    enhancedPrompt: { type: String, default: '' },
    finalPrompt: { type: String, default: '' },
    negativePrompt: { type: String, default: '' },
    refinementNotes: { type: String, default: '' }
  },

  stages: { type: [stageSchema], default: [] },

  status: {
    type: String,
    enum: ['queued', 'prompt_building', 'generating', 'upscaling',
           'postprocessing', 'storing', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true
  },

  progress: { type: Number, min: 0, max: 100, default: 0 },
  statusMessage: { type: String, default: 'Initializing...' },

  falJobId: { type: String, default: null },
  falResponse: { type: mongoose.Schema.Types.Mixed, default: null },

  output: {
    rawVideoUrl: { type: String, default: null },
    storedVideoUrl: { type: String, default: null },
    thumbnailUrl: { type: String, default: null },
    watermarkedUrl: { type: String, default: null },
    cleanUrl: { type: String, default: null },
    duration: { type: Number, default: null },
    resolution: { type: String, default: null },
    fileSize: { type: Number, default: null },
    mimeType: { type: String, default: 'video/mp4' }
  },

  tier: {
    type: String,
    enum: ['free', 'starter', 'pro', 'agency'],
    default: 'free'
  },

  isWatermarked: { type: Boolean, default: true },

  generationTimeMs: { type: Number, default: null },
  totalPipelineTimeMs: { type: Number, default: null },
  falCostUsd: { type: Number, default: null },

  error: {
    message: { type: String, default: null },
    code: { type: String, default: null },
    stack: { type: String, default: null }
  },

  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 2 },

  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

// Instance method: push a new stage
studioJobSchema.methods.addStage = function (name, metadata = {}) {
  this.stages.push({ name, startedAt: new Date(), metadata });
};

// Instance method: mark a stage complete
studioJobSchema.methods.completeStage = function (name, metadata = {}) {
  const stage = this.stages.find(s => s.name === name && !s.completedAt);
  if (stage) {
    stage.completedAt = new Date();
    Object.assign(stage.metadata, metadata);
  }
};

module.exports = mongoose.model('StudioJob', studioJobSchema);
```

- [ ] **Step 2: Create `model/schema/dailyStat.js`**

```javascript
const mongoose = require('mongoose');

const dailyStatSchema = new mongoose.Schema({
  date: { type: String, index: true }, // YYYY-MM-DD

  totalJobs:     { type: Number, default: 0 },
  completedJobs: { type: Number, default: 0 },
  failedJobs:    { type: Number, default: 0 },
  totalFalCost:  { type: Number, default: 0 },

  categoryBreakdown: {
    gym:        { type: Number, default: 0 },
    realestate: { type: Number, default: 0 },
    perfume:    { type: Number, default: 0 },
    saas:       { type: Number, default: 0 },
    restaurant: { type: Number, default: 0 },
    service:    { type: Number, default: 0 }
  },

  avgGenerationTimeMs: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('DailyStat', dailyStatSchema);
```

- [ ] **Step 3: Verify syntax**

```bash
node -e "
require('dotenv').config();
const StudioJob = require('./model/schema/studioJob');
const DailyStat = require('./model/schema/dailyStat');
console.log('Models OK:', StudioJob.modelName, DailyStat.modelName);
"
```

Expected: `Models OK: StudioJob DailyStat`

- [ ] **Step 4: Commit**

```bash
git add model/schema/studioJob.js model/schema/dailyStat.js
git commit -m "feat: add StudioJob and DailyStat Mongoose models"
```

---

## Task 3: Ad Brain Service

**Files:**
- Create: `services/adBrain.js`

- [ ] **Step 1: Create `services/adBrain.js`**

```javascript
'use strict';

/**
 * CATEGORY_DNA — Creative intelligence per category and locale.
 * Each entry: { visualWorld, camera, lighting, grade, model, negativePrompt, vibeModifiers, categoryInputs }
 */
const CATEGORY_DNA = {
  gym: {
    gulf: {
      visualWorld: 'Dark industrial gym interior, UAE fitness club aesthetic, polished concrete floors, heavy iron equipment silhouettes, chalk dust floating in beams of light',
      camera: 'Low angle hero shots of athletes, slow-motion weightlifting, handheld intensity tracking movement',
      lighting: 'Dramatic side lighting, teal-orange color grade, chalk dust particles catching rim light, harsh shadows sculpting physique',
      grade: 'cinematic_teal_orange',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'outdoor park, bright white daylight, cartoonish, low quality, shaky footage, text overlays, logos in frame, people smiling casually',
      vibeModifiers: {
        intense: 'explosive raw power, maximum effort, gritted teeth determination, iron will',
        motivational: 'triumph over limits, before-and-after transformation arc, inspirational journey',
        luxury: 'premium equipment, VIP members-only gym, marble locker rooms, exclusive facility',
        community: 'team training energy, group class unity, shared achievement celebration'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'gymType', 'primaryActivity']
    },
    global: {
      visualWorld: 'Modern high-performance fitness center, clean minimalist gym design, versatile athletic space with natural light',
      camera: 'Dynamic tracking shots, close-up muscle engagement detail, wide establishing athletic environment shot',
      lighting: 'Studio-quality lighting, high contrast sports photography feel, clean whites and deep blacks',
      grade: 'cinematic_teal_orange',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'outdoor, cartoonish, low quality, text overlays, logos, cheap equipment, cluttered',
      vibeModifiers: {
        intense: 'peak performance, elite athleticism, maximum output, athlete mindset',
        motivational: 'personal growth, fitness journey, goal achievement, progress',
        luxury: 'premium experience, world-class facilities, concierge fitness service',
        community: 'team spirit, group classes, fitness community, training partners'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'gymType', 'primaryActivity']
    }
  },

  realestate: {
    gulf: {
      visualWorld: 'Dubai glass towers soaring against blue sky, luxury residential development with desert backdrop, infinity pools overlooking the city, marble lobby with chandelier',
      camera: 'Cinematic aerial drone reveal, slow push-in through floor-to-ceiling windows at golden hour, sweeping pan across skyline',
      lighting: 'Golden hour warm sunlight, champagne and warm white interior tones, luxury hospitality lighting ambiance',
      grade: 'luxury_warm',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'cold grey skies, empty unfinished spaces, cheap interiors, cartoon, text overlays, construction mess',
      vibeModifiers: {
        luxury: 'opulent finishes, bespoke designer interiors, world-class amenities, Bulgari-level presentation',
        investment: 'prime location advantage, capital appreciation narrative, ROI-focused communication',
        lifestyle: 'waterfront living, panoramic city views, urban resort lifestyle, concierge services',
        family: 'spacious family home, gated community security, children\'s play areas, top international schools nearby'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'propertyType', 'location']
    },
    global: {
      visualWorld: 'Contemporary architectural masterpiece, light-filled interiors with natural materials, seamless indoor-outdoor living, curated landscaping',
      camera: 'Smooth steady tracking through spaces, architectural reveal shots, material and finish close-ups',
      lighting: 'Abundant natural daylight, warm interior accent lighting, soft shadow play on surfaces',
      grade: 'luxury_warm',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'dark interiors, dated styling, cartoon, text overlays, empty cheap-looking rooms',
      vibeModifiers: {
        luxury: 'premium crafted finishes, exclusive address, bespoke architectural design',
        investment: 'strategic location, strong rental yield, capital growth potential',
        lifestyle: 'modern connected living, community amenities, work-life balance environment',
        family: 'safe welcoming neighborhood, top schools nearby, generous family spaces'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'propertyType', 'location']
    }
  },

  perfume: {
    gulf: {
      visualWorld: 'Oud and amber Arabic perfume atelier, incense smoke rising from burning bakhoor, antique oud wood vessels, deep amber-drenched backgrounds, Arabian Nights luxury',
      camera: 'Extreme macro close-up of product bottle, tendrils of smoke in slow motion, reveal from darkness',
      lighting: 'Deep amber-black low-key grade, single candle source creating golden highlights on glass, rich chiaroscuro',
      grade: 'luxury_warm',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'bright white background, cheap generic packaging, clinical minimalism, text overlays, logos, outdoor',
      vibeModifiers: {
        mystical: 'ancient oud heritage, thousand-year tradition, sacred ritual of scent, mystical Middle East',
        luxury: 'rare endangered oud wood, master perfumer blend, numbered limited edition collector bottle',
        romantic: 'sensual dusk encounter, intimate evening ritual, love story written in scent',
        heritage: 'Bedouin desert tradition, Arabic calligraphy, generational family craft, Al-Khaleej soul'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'scentFamily', 'productType']
    },
    global: {
      visualWorld: 'Luxury fragrance house atelier, pristine Carrara marble surfaces, rare botanical ingredients arranged artfully, elegant modern minimalism',
      camera: 'Product hero rotating in light, ingredient cascade reveal, bottle movement catching light',
      lighting: 'High-key clean whites with dramatic warm accent light, crisp shadows, studio perfection',
      grade: 'luxury_warm',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'cheap plastic packaging, generic design, harsh unflattering shadows, text overlays, crowded',
      vibeModifiers: {
        mystical: 'hidden garden of rare florals, secret alchemical formula, transformative scent journey',
        luxury: 'Parisian couture fragrance house, rare sustainably sourced extracts, museum-worthy bottle',
        romantic: 'intimate sunlit moments, feminine grace and confidence, timeless elegant allure',
        heritage: 'traditional cold-press distillation, three generations of master perfumers, botanical legacy'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'scentFamily', 'productType']
    }
  },

  saas: {
    gulf: {
      visualWorld: 'Dubai DIFC financial district office, open-plan collaborative workspace with UAE skyline, glass-walled executive boardrooms, sleek standing desks',
      camera: 'Over-shoulder laptop and screen shots, pull-focus from interface to smiling team member, clean desk detail close-ups',
      lighting: 'Screen-glow blue-white ambiance, clean office lighting with warm wood accent, golden natural light through floor-to-ceiling glass',
      grade: 'clean_professional',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'cluttered messy office, outdated hardware, dark basement, cartoon, text overlays, empty sad office',
      vibeModifiers: {
        innovation: 'cutting-edge technology leader, first-mover Gulf advantage, breakthrough digital transformation',
        productivity: 'streamlined workflows automating manual work, hours saved daily, team operating at 3x capacity',
        enterprise: 'C-suite decision-maker environment, enterprise-scale deployment, mission-critical reliability',
        growth: 'scaling UAE business rapidly, expanding regional team, Gulf market leadership position'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'productCategory', 'keyFeature']
    },
    global: {
      visualWorld: 'Modern tech startup office space, collaborative open workspace with standing desks, natural light, diverse team in flow state',
      camera: 'Dynamic workplace moments, product interface on large monitor, genuine team collaboration shots',
      lighting: 'Bright inviting natural light, clean minimal office, subtle screen reflection highlights',
      grade: 'clean_professional',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'dark gloomy office, outdated technology, empty unused office, cartoon, text overlays',
      vibeModifiers: {
        innovation: 'disrupting a tired industry, next-generation solution, built for the AI era',
        productivity: 'save 10 hours every week, eliminate all manual work, automate everything that slows you down',
        enterprise: 'trusted by Fortune 500 teams, enterprise-grade security and compliance, 99.99% uptime SLA',
        growth: 'scale from 10 to 10,000 users, grow your team without growing headcount, 10x output'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'productCategory', 'keyFeature']
    }
  },

  restaurant: {
    gulf: {
      visualWorld: 'UAE dining warmth, Arabic mezze spread with hummus and fattoush, freshly baked khoubz, ma\'amoul desserts, candlelit majlis-style dining with traditional lanterns',
      camera: 'Steam rising from plated dishes in extreme close-up, overhead table spread reveal, warm push-in through restaurant entrance',
      lighting: 'Warm amber food grade, flickering candlelight, golden overhead copper pendants, intimate dining glow',
      grade: 'food_warmth',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'cold harsh kitchen lighting, empty plates, fast food aesthetic, plastic trays, text overlays, generic',
      vibeModifiers: {
        luxury: 'fine dining tasting menu experience, michelin-aspirant plating, curated wine and oud pairing, VIP table',
        family: 'generous family-style portions, warm extended family gathering, Eid celebration tradition, hearty hospitality',
        casual: 'neighborhood treasure, everyday comfort food done perfectly, loyal regulars, unpretentious',
        romantic: 'intimate table for two, flowers and candlelight, special anniversary occasion, memories made'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'cuisineType', 'diningStyle']
    },
    global: {
      visualWorld: 'Contemporary restaurant with open kitchen concept, farm-to-table ingredient storytelling, clean modern plating on artisan ceramics, inviting dining room',
      camera: 'Chef\'s point-of-view plating, ingredient origin close-ups, dining room atmosphere with happy guests',
      lighting: 'Warm restaurant ambient lighting, natural daylight for daytime service, intimate evening candlelight',
      grade: 'food_warmth',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'cold sterile kitchen, cheap plastic serveware, fast food, fluorescent lighting, text overlays',
      vibeModifiers: {
        luxury: 'multi-course tasting journey, award-winning sommelier pairings, chef\'s table immersive experience',
        family: 'family-style sharing tradition, generous hospitality, welcoming to all ages, laughter and love',
        casual: 'comfort food elevated, unpretentious and genuine, neighborhood favorite, honest ingredients',
        romantic: 'intimate corner table, curated mood lighting, perfect anniversary destination'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'cuisineType', 'diningStyle']
    }
  },

  service: {
    gulf: {
      visualWorld: 'Polished UAE professional service environment, Dubai corporate tower setting, confident consultant in business attire at modern desk, client handshake in glass boardroom',
      camera: 'Documentary-style authentic interaction, confident professional walkthrough of modern office, client-consultant trust moment',
      lighting: 'Clean professional lighting conveying trust and competence, warm authority tones, daylight through corporate windows',
      grade: 'clean_professional',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'casual unprofessional setting, messy cluttered environment, generic stock photo feel, text overlays, empty office',
      vibeModifiers: {
        trust: 'proven 20-year track record, client roster of Gulf corporates, regulatory authority relationships',
        innovation: 'technology-enabled modern approach, proprietary methodology, forward-thinking solutions partner',
        premium: 'white-glove boutique service, dedicated senior account director, VIP client treatment always',
        results: 'measurable guaranteed outcomes, data-driven ROI reporting, performance accountability commitment'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'serviceType', 'targetIndustry']
    },
    global: {
      visualWorld: 'Professional service business environment, bright modern consultancy office, confident client-facing team, collaborative whiteboard sessions',
      camera: 'Confident professional body language in motion, client success handshake moments, focused teamwork',
      lighting: 'Daylight-filled professional environment, clean corporate lighting, trust-building visual tone',
      grade: 'clean_professional',
      model: 'fal-ai/kling-video/v2/standard/text-to-video',
      negativePrompt: 'unprofessional casual setting, messy office, generic stock photo feel, text overlays',
      vibeModifiers: {
        trust: 'industry expertise recognized by peers, client success stories and case studies, proven methodology',
        innovation: 'cutting-edge approach and toolset, technology advantage for clients, future-ready strategies',
        premium: 'premium service tier with dedicated team, personalized care, concierge-level responsiveness',
        results: 'roi-focused measurable deliverables, accountable outcome reporting, performance-based pricing'
      },
      categoryInputs: ['brandName', 'description', 'targetAudience', 'vibe', 'serviceType', 'targetIndustry']
    }
  }
};

const CATEGORY_LABELS = {
  gym: 'Gym & Fitness',
  realestate: 'Real Estate',
  perfume: 'Perfume & Fragrance',
  saas: 'SaaS & Tech',
  restaurant: 'Restaurant & Food',
  service: 'Professional Services'
};

/**
 * buildAdPrompt — assembles all DNA layers into a cinematic direction string.
 * @param {object} inputs - { category, brandName, description, targetAudience, vibe, locale, extras }
 * @returns {{ finalPrompt: string, negativePrompt: string, promptMetadata: object }}
 */
function buildAdPrompt(inputs) {
  const { category, brandName, description, targetAudience, vibe, locale = 'gulf', extras = {} } = inputs;

  const dna = CATEGORY_DNA[category];
  if (!dna) throw new Error(`Unknown category: ${category}`);

  const variant = dna[locale] || dna.gulf;
  const vibeText = (vibe && variant.vibeModifiers[vibe]) ? variant.vibeModifiers[vibe] : '';

  const brandContext = description
    ? `Brand "${brandName}" — ${description}`
    : `Brand "${brandName}"`;

  const audienceContext = targetAudience
    ? `Target: ${targetAudience}`
    : '';

  const parts = [
    `VISUAL WORLD: ${variant.visualWorld}`,
    `CAMERA: ${variant.camera}`,
    `LIGHTING: ${variant.lighting}`,
    `BRAND: ${brandContext}`,
    audienceContext ? `AUDIENCE: ${audienceContext}` : null,
    vibeText ? `VIBE: ${vibeText}` : null,
    'Ultra-high production value, professional commercial quality, no text overlays, no logos in frame, cinematic 16:9 format, photorealistic.'
  ].filter(Boolean);

  const finalPrompt = parts.join(' | ');

  return {
    finalPrompt,
    negativePrompt: variant.negativePrompt,
    promptMetadata: {
      category,
      locale,
      vibe: vibe || null,
      characterCount: finalPrompt.length,
      variant: locale
    }
  };
}

/**
 * getAllCategories — returns display info for the frontend category picker.
 */
function getAllCategories() {
  return Object.entries(CATEGORY_DNA).map(([id, data]) => ({
    id,
    label: CATEGORY_LABELS[id],
    inputs: data.gulf.categoryInputs,
    vibes: Object.keys(data.gulf.vibeModifiers)
  }));
}

/**
 * getCategoryDNA — returns raw DNA for a given category (both locales).
 */
function getCategoryDNA(category) {
  return CATEGORY_DNA[category] || null;
}

module.exports = { buildAdPrompt, getAllCategories, getCategoryDNA, CATEGORY_DNA };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const { buildAdPrompt, getAllCategories } = require('./services/adBrain');
const result = buildAdPrompt({ category: 'perfume', brandName: 'Oud Noir', locale: 'gulf', vibe: 'mystical' });
console.log('prompt length:', result.finalPrompt.length);
console.log('categories:', getAllCategories().map(c => c.id));
"
```

Expected output: `prompt length: 400+ categories: [ 'gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service' ]`

- [ ] **Step 3: Commit**

```bash
git add services/adBrain.js
git commit -m "feat: add adBrain category DNA and prompt assembly engine"
```

---

## Task 4: fal.ai Service

**Files:**
- Create: `services/falService.js`

- [ ] **Step 1: Create `services/falService.js`**

```javascript
'use strict';

const { fal } = require('@fal-ai/client');

// Configure fal client with API key from env
fal.config({ credentials: process.env.FAL_API_KEY });

const MODELS = {
  VIDEO_STANDARD: 'fal-ai/kling-video/v2/standard/text-to-video',
  VIDEO_PRO: 'fal-ai/kling-video/v2/pro/text-to-video',
  VIDEO_UPSCALER: 'fal-ai/video-upscaler',
  IMAGE_FAST: 'fal-ai/flux/schnell',
  IMAGE_LIFESTYLE: 'fal-ai/flux-pro'
};

const MODEL_COSTS = {
  [MODELS.VIDEO_STANDARD]: { per5s: 0.45, per10s: 0.85 },
  [MODELS.VIDEO_PRO]: { per5s: 0.90, per10s: 1.70 },
  [MODELS.VIDEO_UPSCALER]: { flat: 0.10 },
  [MODELS.IMAGE_FAST]: { perImage: 0.003 },
  [MODELS.IMAGE_LIFESTYLE]: { perImage: 0.05 }
};

class FalGenerationError extends Error {
  constructor(message, code, isRetryable = false) {
    super(message);
    this.name = 'FalGenerationError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

/**
 * generateVideo — submits a text-to-video job to fal.ai and polls until complete.
 * @param {object} params - { prompt, negativePrompt, aspectRatio, duration, tier, onProgress }
 * @returns {object} { videoUrl, thumbnailUrl, seed, requestId, generationTimeMs, estimatedCost, model }
 */
async function generateVideo({ prompt, negativePrompt, aspectRatio = '16:9', duration = 5, tier = 'free', onProgress }) {
  const model = (tier === 'pro' || tier === 'agency') ? MODELS.VIDEO_PRO : MODELS.VIDEO_STANDARD;
  const seed = Math.floor(Math.random() * 2147483647);
  const startTime = Date.now();

  const input = {
    prompt,
    negative_prompt: negativePrompt || '',
    aspect_ratio: aspectRatio,
    duration: String(duration),
    cfg_scale: 0.5,
    seed
  };

  try {
    let lastProgress = 0;

    const result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_PROGRESS' && onProgress) {
          const progress = update.logs?.length
            ? Math.min(95, lastProgress + Math.floor(Math.random() * 10) + 5)
            : lastProgress;
          lastProgress = progress;
          onProgress(progress);
        }
      }
    });

    const generationTimeMs = Date.now() - startTime;
    const costs = MODEL_COSTS[model];
    const estimatedCost = duration === 10 ? costs.per10s : costs.per5s;

    if (!result?.data?.video?.url) {
      throw new FalGenerationError('fal.ai returned no video URL', 'NO_VIDEO_URL', false);
    }

    return {
      videoUrl: result.data.video.url,
      thumbnailUrl: result.data.video.thumbnail_url || null,
      seed: result.data.seed || seed,
      requestId: result.requestId,
      generationTimeMs,
      estimatedCost,
      model
    };
  } catch (err) {
    if (err instanceof FalGenerationError) throw err;

    const isRetryable = err.message?.includes('timeout') || err.message?.includes('503') || err.message?.includes('rate limit');
    throw new FalGenerationError(
      `fal.ai generation failed: ${err.message}`,
      'FAL_API_ERROR',
      isRetryable
    );
  }
}

/**
 * upscaleVideo — upscales a video using fal-ai/video-upscaler.
 * Non-fatal: on failure returns { upscaledUrl: videoUrl, skipped: true }
 */
async function upscaleVideo({ videoUrl, scaleFactor = 2, onProgress }) {
  try {
    if (onProgress) onProgress(10);

    const result = await fal.subscribe(MODELS.VIDEO_UPSCALER, {
      input: { video_url: videoUrl, scale_factor: scaleFactor },
      logs: false,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_PROGRESS' && onProgress) {
          onProgress(50);
        }
      }
    });

    if (onProgress) onProgress(100);

    return {
      upscaledUrl: result?.data?.video?.url || videoUrl,
      skipped: false
    };
  } catch (err) {
    console.warn('[falService] upscaleVideo failed (non-fatal):', err.message);
    return { upscaledUrl: videoUrl, skipped: true };
  }
}

/**
 * generateProductImage — generates a product/lifestyle image.
 * @param {object} params - { prompt, style: 'fast'|'lifestyle' }
 * @returns {{ imageUrl: string, estimatedCost: number }}
 */
async function generateProductImage({ prompt, style = 'fast' }) {
  const model = style === 'lifestyle' ? MODELS.IMAGE_LIFESTYLE : MODELS.IMAGE_FAST;

  try {
    const result = await fal.subscribe(model, {
      input: { prompt, num_images: 1, image_size: 'landscape_16_9' },
      logs: false
    });

    const imageUrl = result?.data?.images?.[0]?.url;
    if (!imageUrl) throw new FalGenerationError('No image URL returned', 'NO_IMAGE_URL', false);

    return {
      imageUrl,
      estimatedCost: MODEL_COSTS[model].perImage
    };
  } catch (err) {
    if (err instanceof FalGenerationError) throw err;
    throw new FalGenerationError(`Image generation failed: ${err.message}`, 'FAL_IMAGE_ERROR', false);
  }
}

module.exports = { generateVideo, upscaleVideo, generateProductImage, FalGenerationError, MODELS, MODEL_COSTS };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const { MODELS, MODEL_COSTS } = require('./services/falService'); console.log('fal OK:', Object.keys(MODELS).length, 'models');"
```

Expected: `fal OK: 5 models`

- [ ] **Step 3: Commit**

```bash
git add services/falService.js
git commit -m "feat: add falService wrapper for fal.ai video/image generation"
```

---

## Task 5: Storage Service

**Files:**
- Create: `services/storageService.js`

- [ ] **Step 1: Create `services/storageService.js`**

```javascript
'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return s3Client;
}

/**
 * uploadToR2 — uploads a local file to Cloudflare R2.
 * @param {object} params - { localPath, key, contentType }
 * @returns {string|null} public URL or null on failure
 */
async function uploadToR2({ localPath, key, contentType = 'video/mp4' }) {
  try {
    const client = getS3Client();
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!bucket || !publicUrl) {
      console.warn('[storageService] R2 env vars not configured, skipping upload');
      return null;
    }

    const fileStream = fs.createReadStream(localPath);
    const stats = fs.statSync(localPath);

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
      ContentLength: stats.size
    }));

    // Strip trailing slash from public URL
    const baseUrl = publicUrl.replace(/\/$/, '');
    return `${baseUrl}/${key}`;
  } catch (err) {
    console.error('[storageService] uploadToR2 failed:', err.message);
    return null;
  }
}

module.exports = { uploadToR2 };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const { uploadToR2 } = require('./services/storageService'); console.log('storageService OK:', typeof uploadToR2);"
```

Expected: `storageService OK: function`

- [ ] **Step 3: Commit**

```bash
git add services/storageService.js
git commit -m "feat: add storageService for Cloudflare R2 upload"
```

---

## Task 6: Processing Service

**Files:**
- Create: `services/processingService.js`

- [ ] **Step 1: Create `services/processingService.js`**

```javascript
'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storageService = require('./storageService');

const execAsync = promisify(exec);

const TMP_DIR = '/tmp/qumak-processing';

// Ensure temp directory exists on module load
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * FFmpeg filter chains for color grading — no LUT files required.
 */
const GRADE_PRESETS = {
  cinematic_teal_orange: [
    'curves=r=\'0/0 0.2/0.15 0.5/0.5 0.8/0.9 1/1\':g=\'0/0 0.2/0.2 0.5/0.5 0.8/0.8 1/1\':b=\'0/0 0.2/0.25 0.5/0.55 0.8/0.75 1/1\'',
    'eq=saturation=1.2:contrast=1.1:brightness=-0.02',
    'unsharp=5:5:0.5:5:5:0.0'
  ].join(','),

  luxury_warm: [
    'curves=r=\'0/0 0.2/0.22 0.5/0.55 0.8/0.85 1/1\':g=\'0/0 0.2/0.18 0.5/0.48 0.8/0.78 1/0.95\':b=\'0/0 0.2/0.12 0.5/0.38 0.8/0.65 1/0.85\'',
    'eq=saturation=0.95:contrast=1.08:brightness=0.01',
    'unsharp=3:3:0.3:3:3:0.0'
  ].join(','),

  clean_professional: [
    'curves=r=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\':g=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\':b=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/1\'',
    'eq=saturation=1.05:contrast=1.05:brightness=0.02',
    'unsharp=3:3:0.2:3:3:0.0'
  ].join(','),

  food_warmth: [
    'curves=r=\'0/0 0.2/0.24 0.5/0.56 0.8/0.88 1/1\':g=\'0/0 0.2/0.21 0.5/0.52 0.8/0.82 1/0.98\':b=\'0/0 0.2/0.14 0.5/0.40 0.8/0.68 1/0.88\'',
    'eq=saturation=1.15:contrast=1.06:brightness=0.01',
    'unsharp=5:5:0.4:5:5:0.0'
  ].join(',')
};

const CATEGORY_GRADE_MAP = {
  gym:        'cinematic_teal_orange',
  realestate: 'luxury_warm',
  perfume:    'luxury_warm',
  saas:       'clean_professional',
  restaurant: 'food_warmth',
  service:    'clean_professional'
};

/**
 * downloadFile — downloads a URL to a local path using axios stream.
 */
async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/**
 * checkFFmpeg — returns true if ffmpeg is available in PATH.
 */
async function checkFFmpeg() {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * processVideo — download → color grade → optional watermark → upload to R2.
 * Non-fatal: on any FFmpeg failure, returns original URL.
 *
 * @param {object} params - { videoUrl, jobId, category, brandName, isWatermarked, aspectRatio, onProgress }
 * @returns {{ storedUrl: string, processedLocally: boolean }}
 */
async function processVideo({ videoUrl, jobId, category, brandName, isWatermarked, aspectRatio = '16:9', onProgress }) {
  const inputPath = path.join(TMP_DIR, `${jobId}_input.mp4`);
  const gradedPath = path.join(TMP_DIR, `${jobId}_graded.mp4`);
  const outputPath = path.join(TMP_DIR, `${jobId}_output.mp4`);

  try {
    // Step 1: Download
    if (onProgress) onProgress(10);
    console.log(`[processingService] Downloading video for job ${jobId}`);
    await downloadFile(videoUrl, inputPath);

    if (onProgress) onProgress(30);

    // Step 2: Apply color grade
    const gradePreset = GRADE_PRESETS[CATEGORY_GRADE_MAP[category] || 'clean_professional'];
    const gradeCmd = [
      'ffmpeg -y',
      `-i "${inputPath}"`,
      `-vf "${gradePreset}"`,
      '-c:v libx264 -crf 18 -preset slow',
      '-pix_fmt yuv420p -movflags +faststart',
      '-c:a copy',
      `"${gradedPath}"`
    ].join(' ');

    console.log(`[processingService] Applying color grade for job ${jobId}`);
    await execAsync(gradeCmd, { timeout: 120000 });

    if (onProgress) onProgress(60);

    // Step 3: Optionally burn watermark
    if (isWatermarked) {
      const watermarkCmd = [
        'ffmpeg -y',
        `-i "${gradedPath}"`,
        `-vf "drawtext=text='QUMAK STUDIO':fontsize=24:fontcolor=white@0.7:x=w-tw-20:y=h-th-20:shadowcolor=black@0.5:shadowx=2:shadowy=2"`,
        '-c:v libx264 -crf 18 -preset slow',
        '-pix_fmt yuv420p -movflags +faststart',
        '-c:a copy',
        `"${outputPath}"`
      ].join(' ');

      console.log(`[processingService] Adding watermark for job ${jobId}`);
      await execAsync(watermarkCmd, { timeout: 120000 });
    } else {
      fs.renameSync(gradedPath, outputPath);
    }

    if (onProgress) onProgress(80);

    // Step 4: Upload to R2
    const r2Key = `studio/videos/${jobId}/output.mp4`;
    console.log(`[processingService] Uploading to R2 for job ${jobId}`);
    const storedUrl = await storageService.uploadToR2({
      localPath: outputPath,
      key: r2Key,
      contentType: 'video/mp4'
    });

    if (onProgress) onProgress(100);

    return {
      storedUrl: storedUrl || videoUrl,
      processedLocally: !!storedUrl
    };
  } catch (err) {
    console.warn(`[processingService] processVideo failed for job ${jobId} (non-fatal):`, err.message);
    return { storedUrl: videoUrl, processedLocally: false };
  } finally {
    // Cleanup temp files
    [inputPath, gradedPath, outputPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

/**
 * extractThumbnail — extract frame at 1s, scale to 1280x720, upload to R2.
 * Returns URL or null on failure.
 */
async function extractThumbnail(videoUrl, jobId) {
  const inputPath = path.join(TMP_DIR, `${jobId}_thumb_input.mp4`);
  const thumbPath = path.join(TMP_DIR, `${jobId}_thumb.jpg`);

  try {
    await downloadFile(videoUrl, inputPath);

    const thumbCmd = [
      'ffmpeg -y',
      `-i "${inputPath}"`,
      '-ss 00:00:01 -vframes 1',
      `-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"`,
      `"${thumbPath}"`
    ].join(' ');

    await execAsync(thumbCmd, { timeout: 30000 });

    const r2Key = `studio/thumbnails/${jobId}/thumb.jpg`;
    const thumbUrl = await storageService.uploadToR2({
      localPath: thumbPath,
      key: r2Key,
      contentType: 'image/jpeg'
    });

    return thumbUrl;
  } catch (err) {
    console.warn(`[processingService] extractThumbnail failed for job ${jobId}:`, err.message);
    return null;
  } finally {
    [inputPath, thumbPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

module.exports = { processVideo, extractThumbnail, checkFFmpeg, GRADE_PRESETS, CATEGORY_GRADE_MAP };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const ps = require('./services/processingService'); console.log('processingService OK:', typeof ps.processVideo, typeof ps.checkFFmpeg);"
```

Expected: `processingService OK: function function`

- [ ] **Step 3: Commit**

```bash
git add services/processingService.js
git commit -m "feat: add processingService FFmpeg color grading and watermark pipeline"
```

---

## Task 7: Socket Emitter (Redis Pub/Sub Bridge)

**Files:**
- Create: `utils/socketEmitter.js`

- [ ] **Step 1: Create `utils/socketEmitter.js`**

```javascript
'use strict';

const Redis = require('ioredis');

const CHANNEL = 'qumak:job-updates';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Singleton publisher (lazy-initialized)
let publisher = null;

function getPublisher() {
  if (!publisher) {
    publisher = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: false
    });
    publisher.on('error', (err) => {
      console.error('[socketEmitter] Redis publisher error:', err.message);
    });
  }
  return publisher;
}

/**
 * emitJobUpdate — publishes a job update to the Redis channel.
 * Non-fatal: catches and logs errors.
 * @param {string} sessionId
 * @param {object} payload - { jobId, status, progress, statusMessage, output? }
 */
async function emitJobUpdate(sessionId, payload) {
  try {
    const pub = getPublisher();
    await pub.publish(CHANNEL, JSON.stringify({ sessionId, payload }));
  } catch (err) {
    console.error('[socketEmitter] emitJobUpdate failed (non-fatal):', err.message);
  }
}

/**
 * setupJobUpdateSubscriber — subscribes to Redis channel and forwards updates via socket.io.
 * Call this once in the main server process after socket.io is initialized.
 * @param {import('socket.io').Server} io
 */
function setupJobUpdateSubscriber(io) {
  const subscriber = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3
  });

  subscriber.on('error', (err) => {
    console.error('[socketEmitter] Redis subscriber error:', err.message);
  });

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('[socketEmitter] Failed to subscribe to channel:', err.message);
      return;
    }
    console.log(`[socketEmitter] Subscribed to Redis channel: ${CHANNEL}`);
  });

  subscriber.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;

    try {
      const { sessionId, payload } = JSON.parse(message);
      // Emit to all sockets in the session room
      io.to(`studio:${sessionId}`).emit('studio:job-update', payload);
    } catch (err) {
      console.error('[socketEmitter] Failed to parse message:', err.message);
    }
  });

  return subscriber;
}

module.exports = { emitJobUpdate, setupJobUpdateSubscriber, CHANNEL };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const se = require('./utils/socketEmitter'); console.log('socketEmitter OK:', typeof se.emitJobUpdate, typeof se.setupJobUpdateSubscriber);"
```

Expected: `socketEmitter OK: function function`

- [ ] **Step 3: Commit**

```bash
git add utils/socketEmitter.js
git commit -m "feat: add socketEmitter Redis pub/sub bridge for worker-to-socket.io updates"
```

---

## Task 8: Studio Controller

**Files:**
- Create: `controllers/studio/studioController.js`

- [ ] **Step 1: Create `controllers/studio/studioController.js`**

```javascript
'use strict';

const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { Queue } = require('bullmq');
const StudioJob = require('../../model/schema/studioJob');
const adBrain = require('../../services/adBrain');

// ─── Queue (lazy singleton) ────────────────────────────────────────────────

let videoQueue = null;

function initQueue() {
  if (!videoQueue) {
    const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
    videoQueue = new Queue('video-generation', {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 }
      }
    });
    console.log('[studioController] BullMQ queue initialized');
  }
  return videoQueue;
}

initQueue();

// ─── Helpers ──────────────────────────────────────────────────────────────

const TIER_PRIORITY = { agency: 1, pro: 2, starter: 5, free: 5 };
const CONTENT_BLOCKLIST = ['nude', 'naked', 'explicit', 'nsfw', 'weapon', 'violence', 'blood', 'drug'];

function checkContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONTENT_BLOCKLIST.some(word => lower.includes(word));
}

function getSessionId(req) {
  return req.cookies?.qumak_session || req.headers['x-session-id'] || null;
}

function sanitizeJob(job) {
  const videoUrl = job.isWatermarked
    ? (job.output?.watermarkedUrl || job.output?.storedVideoUrl)
    : (job.output?.cleanUrl || job.output?.storedVideoUrl);

  return {
    id: job._id,
    category: job.category,
    brandName: job.userInputs?.brandName,
    status: job.status,
    progress: job.progress,
    statusMessage: job.statusMessage,
    tier: job.tier,
    isWatermarked: job.isWatermarked,
    output: {
      videoUrl: videoUrl || null,
      thumbnailUrl: job.output?.thumbnailUrl || null,
      duration: job.output?.duration || job.userInputs?.duration || null
    },
    createdAt: job.createdAt,
    generationTimeMs: job.generationTimeMs
  };
}

// ─── Input schema ─────────────────────────────────────────────────────────

const generateSchema = z.object({
  category: z.enum(['gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service']),
  brandName: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  targetAudience: z.string().max(200).optional().default(''),
  vibe: z.string().max(50).optional().default(''),
  locale: z.enum(['gulf', 'global']).optional().default('gulf'),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional().default('16:9'),
  duration: z.union([z.literal(5), z.literal(10)]).optional().default(5),
  extras: z.record(z.unknown()).optional().default({})
});

// ─── Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/studio/generate
 */
exports.createGeneration = async (req, res) => {
  try {
    // 1. Validate input
    const parseResult = generateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      });
    }
    const inputs = parseResult.data;

    // 2. Resolve sessionId
    let sessionId = getSessionId(req);
    const isNewSession = !sessionId;
    if (!sessionId) sessionId = uuidv4();

    // 3. Determine tier
    const tier = req.user?.plan || 'free';

    // 4. Free tier monthly limit (2 jobs)
    if (tier === 'free') {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const count = await StudioJob.countDocuments({
        sessionId,
        status: { $in: ['completed', 'generating', 'queued'] },
        createdAt: { $gte: monthStart }
      });

      if (count >= 2) {
        return res.status(429).json({
          success: false,
          error: 'free_limit_reached',
          message: 'Free plan allows 2 videos per month. Upgrade to continue.',
          upgradeUrl: '/upgrade'
        });
      }
    }

    // 5. Content moderation
    const textToCheck = [inputs.brandName, inputs.description, inputs.targetAudience].join(' ');
    if (checkContent(textToCheck)) {
      return res.status(400).json({
        success: false,
        error: 'content_policy_violation',
        message: 'Your submission contains content that violates our usage policy.'
      });
    }

    // 6. Determine watermark
    const isWatermarked = tier === 'free';

    // 7. Build prompt
    const { finalPrompt, negativePrompt } = adBrain.buildAdPrompt({ ...inputs });

    // 8. Create job in MongoDB
    const job = await StudioJob.create({
      userId: req.user?._id || null,
      sessionId,
      category: inputs.category,
      userInputs: inputs,
      promptPipeline: {
        rawUserIntent: `${inputs.brandName} - ${inputs.description}`,
        finalPrompt,
        negativePrompt
      },
      tier,
      isWatermarked,
      status: 'queued',
      statusMessage: 'Your video is queued for generation.'
    });

    // 9. Enqueue
    const queue = initQueue();
    const priority = TIER_PRIORITY[tier] || 5;
    await queue.add('generate', { jobId: job._id.toString() }, { priority });

    // 10. Estimate time
    const estimatedTime = tier === 'free' ? '3-5 minutes' : tier === 'pro' ? '2-4 minutes' : '1-3 minutes';

    // Set session cookie if new
    if (isNewSession) {
      res.cookie('qumak_session', sessionId, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'strict'
      });
    }

    return res.status(201).json({
      success: true,
      jobId: job._id,
      sessionId,
      status: 'queued',
      estimatedTime,
      message: 'Your video is queued. Connect via WebSocket room studio:' + sessionId + ' for live updates.'
    });
  } catch (err) {
    console.error('[studioController] createGeneration error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to create generation job.' });
  }
};

/**
 * GET /api/v1/studio/job/:id
 */
exports.getJobStatus = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });
    }

    // Ownership check
    const sessionId = getSessionId(req);
    const ownedBySession = sessionId && job.sessionId === sessionId;
    const ownedByUser = req.user && req.user._id && job.userId && job.userId.toString() === req.user._id.toString();

    if (!ownedBySession && !ownedByUser) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });
    }

    return res.json({ success: true, job: sanitizeJob(job) });
  } catch (err) {
    console.error('[studioController] getJobStatus error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch job.' });
  }
};

/**
 * GET /api/v1/studio/jobs
 */
exports.getUserJobs = async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      return res.json({ success: true, jobs: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      StudioJob.find({ sessionId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StudioJob.countDocuments({ sessionId })
    ]);

    return res.json({
      success: true,
      jobs: jobs.map(j => sanitizeJob(j)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('[studioController] getUserJobs error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch jobs.' });
  }
};

/**
 * GET /api/v1/studio/categories
 */
exports.getCategories = async (req, res) => {
  try {
    return res.json({ success: true, categories: adBrain.getAllCategories() });
  } catch (err) {
    console.error('[studioController] getCategories error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch categories.' });
  }
};

/**
 * POST /api/v1/studio/preview-prompt
 */
exports.previewPrompt = async (req, res) => {
  try {
    const { category, brandName, description, vibe, locale, targetAudience } = req.body;

    if (!category || !brandName) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'category and brandName are required.' });
    }

    const { finalPrompt, negativePrompt, promptMetadata } = adBrain.buildAdPrompt({
      category, brandName, description, vibe, locale, targetAudience
    });

    return res.json({
      success: true,
      preview: finalPrompt.substring(0, 300) + (finalPrompt.length > 300 ? '...' : ''),
      metadata: promptMetadata
    });
  } catch (err) {
    console.error('[studioController] previewPrompt error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to preview prompt.' });
  }
};

/**
 * DELETE /api/v1/studio/job/:id
 */
exports.cancelJob = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });
    }

    // Ownership check
    const sessionId = getSessionId(req);
    const ownedBySession = sessionId && job.sessionId === sessionId;
    const ownedByUser = req.user && req.user._id && job.userId && job.userId.toString() === req.user._id.toString();

    if (!ownedBySession && !ownedByUser) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });
    }

    if (!['queued', 'prompt_building'].includes(job.status)) {
      return res.status(400).json({
        success: false,
        error: 'not_cancellable',
        message: `Cannot cancel a job with status "${job.status}".`
      });
    }

    job.status = 'cancelled';
    await job.save();

    return res.json({ success: true, message: 'Job cancelled.' });
  } catch (err) {
    console.error('[studioController] cancelJob error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to cancel job.' });
  }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const ctrl = require('./controllers/studio/studioController'); console.log('studioController OK:', Object.keys(ctrl).join(', '));"
```

Expected: `studioController OK: createGeneration, getJobStatus, getUserJobs, getCategories, previewPrompt, cancelJob`

- [ ] **Step 3: Commit**

```bash
git add controllers/studio/studioController.js
git commit -m "feat: add studioController with generation, status, list, cancel endpoints"
```

---

## Task 9: Admin Studio Controller

**Files:**
- Create: `controllers/studio/adminStudioController.js`

- [ ] **Step 1: Create `controllers/studio/adminStudioController.js`**

```javascript
'use strict';

const StudioJob = require('../../model/schema/studioJob');
const DailyStat = require('../../model/schema/dailyStat');

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * GET /api/v1/studio/admin/stats
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const today = getTodayString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalJobs,
      todayStat,
      recentFailures,
      categoryBreakdown,
      activeJobCount
    ] = await Promise.all([
      StudioJob.countDocuments(),
      DailyStat.findOne({ date: today }).lean(),
      StudioJob.find({ status: 'failed', createdAt: { $gte: sevenDaysAgo } })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('category error createdAt')
        .lean(),
      StudioJob.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),
      StudioJob.countDocuments({ status: { $in: ['queued', 'generating', 'postprocessing'] } })
    ]);

    const categoryMap = {};
    categoryBreakdown.forEach(item => { categoryMap[item._id] = item.count; });

    return res.json({
      success: true,
      stats: {
        totalJobs,
        activeJobs: activeJobCount,
        today: todayStat || { totalJobs: 0, completedJobs: 0, failedJobs: 0, totalFalCost: 0 },
        categoryBreakdown: categoryMap,
        recentFailures: recentFailures.map(f => ({
          category: f.category,
          errorMessage: f.error?.message || 'Unknown error',
          createdAt: f.createdAt
        }))
      }
    });
  } catch (err) {
    console.error('[adminStudioController] getDashboardStats error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch stats.' });
  }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const a = require('./controllers/studio/adminStudioController'); console.log('adminCtrl OK:', typeof a.getDashboardStats);"
```

Expected: `adminCtrl OK: function`

- [ ] **Step 3: Commit**

```bash
git add controllers/studio/adminStudioController.js
git commit -m "feat: add adminStudioController with dashboard stats endpoint"
```

---

## Task 10: Studio Routes

**Files:**
- Create: `controllers/studio/_routes.js`

- [ ] **Step 1: Create `controllers/studio/_routes.js`**

```javascript
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ctrl = require('./studioController');
const adminCtrl = require('./adminStudioController');
const auth = require('../../middelwares/auth');

// Rate limiter: 5 requests per hour per IP or session cookie
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    return req.cookies?.qumak_session || req.headers['x-session-id'] || req.ip;
  },
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      message: 'Too many generation requests. Please wait before trying again.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Public routes (anonymous + session-based ownership checks inside controller)
router.post('/generate', generateLimiter, ctrl.createGeneration);
router.post('/preview-prompt', ctrl.previewPrompt);
router.get('/categories', ctrl.getCategories);
router.get('/jobs', ctrl.getUserJobs);
router.get('/job/:id', ctrl.getJobStatus);
router.delete('/job/:id', ctrl.cancelJob);

// Admin routes — require JWT auth
router.get('/admin/stats', auth, adminCtrl.getDashboardStats);

module.exports = router;
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "const r = require('./controllers/studio/_routes'); console.log('routes OK:', typeof r);"
```

Expected: `routes OK: function`

- [ ] **Step 3: Commit**

```bash
git add controllers/studio/_routes.js
git commit -m "feat: add studio routes with rate limiting and admin protection"
```

---

## Task 11: BullMQ Video Worker

**Files:**
- Create: `workers/videoWorker.js`

- [ ] **Step 1: Create `workers/videoWorker.js`**

```javascript
'use strict';

// Worker runs as a SEPARATE process via PM2 — must bootstrap independently
require('dotenv').config();

const mongoose = require('mongoose');
const { Worker } = require('bullmq');

const StudioJob = require('../model/schema/studioJob');
const DailyStat = require('../model/schema/dailyStat');
const falService = require('../services/falService');
const processingService = require('../services/processingService');
const { emitJobUpdate } = require('../utils/socketEmitter');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── MongoDB connection ────────────────────────────────────────────────────

async function connectDB() {
  const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const DATABASE = process.env.DB || 'qumak';
  try {
    await mongoose.connect(DATABASE_URL + '/' + DATABASE);
    console.log('[videoWorker] MongoDB connected');
  } catch (err) {
    console.error('[videoWorker] MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function updateStatus(job, status, progress, statusMessage) {
  job.status = status;
  job.progress = progress;
  job.statusMessage = statusMessage;
  await job.save();

  await emitJobUpdate(job.sessionId, {
    jobId: job._id.toString(),
    status,
    progress,
    statusMessage
  });
}

async function updateDailyStats(category, timeMs, costUsd, status) {
  const date = new Date().toISOString().split('T')[0];
  try {
    const inc = { totalJobs: 1 };
    if (status === 'completed') {
      inc.completedJobs = 1;
      inc[`categoryBreakdown.${category}`] = 1;
      if (costUsd) inc.totalFalCost = costUsd;
    } else if (status === 'failed') {
      inc.failedJobs = 1;
    }
    await DailyStat.findOneAndUpdate(
      { date },
      { $inc: inc, $setOnInsert: { date } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.warn('[videoWorker] updateDailyStats failed (non-fatal):', err.message);
  }
}

// ─── Core pipeline ────────────────────────────────────────────────────────

async function processVideoJob(bullJob) {
  const { jobId } = bullJob.data;
  const pipelineStart = Date.now();

  console.log(`[videoWorker] Starting job ${jobId}`);

  // 1. Load job from MongoDB
  const job = await StudioJob.findById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found in MongoDB`);

  job.startedAt = new Date();
  job.addStage('pipeline_start', { bullJobId: bullJob.id });

  try {
    // 2. Build prompt stage
    await updateStatus(job, 'prompt_building', 10, 'Building cinematic ad prompt...');
    job.completeStage('pipeline_start');
    job.addStage('prompt_building');

    const { buildAdPrompt } = require('../services/adBrain');
    const { finalPrompt, negativePrompt } = buildAdPrompt({
      category: job.category,
      brandName: job.userInputs.brandName,
      description: job.userInputs.description,
      targetAudience: job.userInputs.targetAudience,
      vibe: job.userInputs.vibe,
      locale: job.userInputs.locale,
      extras: job.userInputs.extras
    });

    job.promptPipeline.finalPrompt = finalPrompt;
    job.promptPipeline.negativePrompt = negativePrompt;
    job.completeStage('prompt_building');
    await job.save();

    // 3. Generating stage
    await updateStatus(job, 'generating', 20, 'Generating video with AI...');
    job.addStage('generating');

    const isProTier = job.tier === 'pro' || job.tier === 'agency';

    const onFalProgress = async (falProgress) => {
      const mapped = 20 + Math.floor(falProgress * 0.5); // 20–70 range
      await updateStatus(job, 'generating', mapped, `Generating video... ${falProgress}%`);
    };

    const falResult = await falService.generateVideo({
      prompt: finalPrompt,
      negativePrompt,
      aspectRatio: job.userInputs.aspectRatio,
      duration: job.userInputs.duration,
      tier: job.tier,
      onProgress: onFalProgress
    });

    job.falJobId = falResult.requestId;
    job.falResponse = falResult;
    job.output.rawVideoUrl = falResult.videoUrl;
    job.generationTimeMs = falResult.generationTimeMs;
    job.falCostUsd = falResult.estimatedCost;
    job.completeStage('generating');
    await job.save();

    let videoForProcessing = falResult.videoUrl;

    // 4. Upscaling (pro/agency only)
    if (isProTier) {
      await updateStatus(job, 'upscaling', 72, 'Upscaling video to 4K...');
      job.addStage('upscaling');

      const upscaleResult = await falService.upscaleVideo({
        videoUrl: videoForProcessing,
        scaleFactor: 2,
        onProgress: async (p) => {
          const mapped = 72 + Math.floor(p * 0.1);
          await updateStatus(job, 'upscaling', mapped, `Upscaling... ${p}%`);
        }
      });

      videoForProcessing = upscaleResult.upscaledUrl;
      job.completeStage('upscaling', { skipped: upscaleResult.skipped });
      await job.save();
    }

    // 5. Post-processing (color grade + watermark + R2 upload)
    await updateStatus(job, 'postprocessing', 82, 'Applying color grade and finalizing...');
    job.addStage('postprocessing');

    const procResult = await processingService.processVideo({
      videoUrl: videoForProcessing,
      jobId: job._id.toString(),
      category: job.category,
      brandName: job.userInputs.brandName,
      isWatermarked: job.isWatermarked,
      aspectRatio: job.userInputs.aspectRatio,
      onProgress: async (p) => {
        const mapped = 82 + Math.floor(p * 0.1);
        await updateStatus(job, 'postprocessing', mapped, `Post-processing... ${p}%`);
      }
    });

    job.output.storedVideoUrl = procResult.storedUrl;
    job.completeStage('postprocessing', { processedLocally: procResult.processedLocally });

    // 6. Extract thumbnail
    const ffmpegAvailable = await processingService.checkFFmpeg();
    if (ffmpegAvailable) {
      const thumbUrl = await processingService.extractThumbnail(procResult.storedUrl, job._id.toString());
      if (thumbUrl) job.output.thumbnailUrl = thumbUrl;
    }

    // 7. Set final output URLs
    if (job.isWatermarked) {
      job.output.watermarkedUrl = procResult.storedUrl;
    } else {
      job.output.cleanUrl = procResult.storedUrl;
    }

    // 8. Mark completed
    const totalPipelineTimeMs = Date.now() - pipelineStart;
    job.totalPipelineTimeMs = totalPipelineTimeMs;
    job.completedAt = new Date();
    job.addStage('completed');

    await updateStatus(job, 'completed', 100, 'Your video is ready!');

    // Emit final update with output
    await emitJobUpdate(job.sessionId, {
      jobId: job._id.toString(),
      status: 'completed',
      progress: 100,
      statusMessage: 'Your video is ready!',
      output: {
        videoUrl: job.isWatermarked ? job.output.watermarkedUrl : job.output.cleanUrl,
        thumbnailUrl: job.output.thumbnailUrl,
        duration: job.userInputs.duration
      }
    });

    console.log(`[videoWorker] Job ${jobId} completed in ${totalPipelineTimeMs}ms`);

    await updateDailyStats(job.category, totalPipelineTimeMs, job.falCostUsd, 'completed');

  } catch (err) {
    console.error(`[videoWorker] Job ${jobId} failed:`, err.message);

    job.error = {
      message: err.message,
      code: err.code || 'PIPELINE_ERROR',
      stack: err.stack
    };

    await updateStatus(job, 'failed', 0, 'Video generation failed. Please try again.');

    await emitJobUpdate(job.sessionId, {
      jobId: job._id.toString(),
      status: 'failed',
      progress: 0,
      statusMessage: 'Video generation failed. Please try again.',
      error: { message: err.message }
    });

    await updateDailyStats(job.category, 0, 0, 'failed');

    throw err; // Re-throw for BullMQ retry logic
  }
}

// ─── Worker setup ─────────────────────────────────────────────────────────

async function startWorker() {
  await connectDB();

  const worker = new Worker('video-generation', processVideoJob, {
    connection: { url: REDIS_URL },
    concurrency: 3,
    limiter: { max: 10, duration: 30000 }
  });

  worker.on('completed', (bullJob) => {
    console.log(`[videoWorker] BullMQ job ${bullJob.id} completed`);
  });

  worker.on('failed', (bullJob, err) => {
    console.error(`[videoWorker] BullMQ job ${bullJob?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[videoWorker] Worker error:', err.message);
  });

  console.log('[videoWorker] Worker started — listening for jobs on queue: video-generation');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[videoWorker] SIGTERM received — shutting down gracefully');
    await worker.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}

startWorker().catch((err) => {
  console.error('[videoWorker] Failed to start worker:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax (no connection needed)**

```bash
node --check workers/videoWorker.js && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Commit**

```bash
git add workers/videoWorker.js
git commit -m "feat: add BullMQ video generation worker with full pipeline"
```

---

## Task 12: Update index.js

**Files:**
- Modify: `index.js`

The spec requires exactly two changes:
1. Add studio route registration after existing routes
2. Call `setupJobUpdateSubscriber(wsServer.io)` inside the `server.listen` callback

- [ ] **Step 1: Add studio route registration**

In `index.js`, after this line:
```javascript
app.use('/api/v1/facebook', facebookRoutes);
```

Add (before the `// Chat WebSocket routes` comment):
```javascript
// Studio — AI Ad Video Generation
const studioRoutes = require('./controllers/studio/_routes');
app.use('/api/v1/studio', studioRoutes);
```

- [ ] **Step 2: Add socket subscriber in server.listen callback**

In `index.js`, inside the `server.listen` callback, after the existing `console.log` lines:
```javascript
    // Bridge Redis pub/sub → socket.io for Studio job updates
    const { setupJobUpdateSubscriber } = require('./utils/socketEmitter');
    setupJobUpdateSubscriber(wsServer.io);
    console.log('🎬 Qumak Studio: Redis pub/sub bridge initialized');
```

- [ ] **Step 3: Verify the server still starts**

```bash
node -e "
process.env.NODE_ENV = 'test';
const app = require('./index.js');
console.log('index.js loads OK');
"
```

Expected: `index.js loads OK` (may print some startup logs — as long as no crash)

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: register studio routes and Redis pub/sub bridge in index.js"
```

---

## Task 13: PM2 Ecosystem Config

**Files:**
- Create: `ecosystem.config.cjs`

- [ ] **Step 1: Check if ecosystem.config.js exists**

```bash
ls ecosystem.config.* 2>/dev/null && echo "exists" || echo "not found"
```

- [ ] **Step 2: Create `ecosystem.config.cjs` with both server and worker entries**

```javascript
module.exports = {
  apps: [
    {
      name: 'qumak-backend',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 5001
      },
      error_file: 'logs/server-error.log',
      out_file: 'logs/server-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'qumak-studio-worker',
      script: 'workers/videoWorker.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '800M',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
```

- [ ] **Step 3: Create logs directory**

```bash
mkdir -p /Users/gaian/Projects/startups/Qumak/qumak-backend/logs
```

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.cjs logs/.gitkeep 2>/dev/null; git add ecosystem.config.cjs
git commit -m "feat: add PM2 ecosystem config with studio worker entry"
```

---

## Verification

After all tasks are complete, run these checks:

- [ ] **V1: Categories endpoint**

```bash
curl -s http://localhost:5001/api/v1/studio/categories | node -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>console.log(JSON.parse(d.toString()).categories.map(c=>c.id)))"
```

Expected: `[ 'gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service' ]`

- [ ] **V2: Preview prompt**

```bash
curl -s -X POST http://localhost:5001/api/v1/studio/preview-prompt \
  -H "Content-Type: application/json" \
  -d '{"category":"perfume","brandName":"Oud Noir","locale":"gulf","vibe":"mystical"}' \
  | node -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>{ const r=JSON.parse(d); console.log('preview length:', r.preview?.length, 'meta:', r.metadata?.category); })"
```

Expected: `preview length: 300 meta: perfume`

- [ ] **V3: Submit generation job**

```bash
curl -s -X POST http://localhost:5001/api/v1/studio/generate \
  -H "Content-Type: application/json" \
  -d '{"category":"perfume","brandName":"Oud Noir","description":"luxury oud fragrance","locale":"gulf","aspectRatio":"16:9","duration":5}' \
  | node -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>{ const r=JSON.parse(d); console.log('status:', r.success, 'jobId:', !!r.jobId); })"
```

Expected: `status: true jobId: true`

- [ ] **V4: Get job status**

```bash
# Replace JOB_ID with the jobId from V3
curl -s http://localhost:5001/api/v1/studio/job/JOB_ID \
  | node -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>console.log(JSON.parse(d).job?.status))"
```

Expected: `queued` (or `generating` if worker is running)

---

## Required Environment Variables

Add to `.env`:

```
# fal.ai
FAL_API_KEY=your_fal_api_key

# Cloudflare R2
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret
R2_BUCKET_NAME=qumak-studio
R2_PUBLIC_URL=https://your-bucket.r2.dev

# Redis (if not default)
REDIS_URL=redis://localhost:6379
```

---

## Self-Review Against Spec

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| studioJob.js schema with all fields | Task 2 | ✅ |
| addStage / completeStage methods | Task 2 | ✅ |
| dailyStat.js schema | Task 2 | ✅ |
| adBrain CATEGORY_DNA for all 6 | Task 3 | ✅ Gulf + global variants |
| buildAdPrompt / getAllCategories / getCategoryDNA | Task 3 | ✅ |
| falService generateVideo (standard/pro model) | Task 4 | ✅ |
| falService upscaleVideo (non-fatal) | Task 4 | ✅ |
| falService generateProductImage | Task 4 | ✅ |
| FalGenerationError with isRetryable | Task 4 | ✅ |
| MODELS + MODEL_COSTS exported | Task 4 | ✅ |
| storageService uploadToR2 | Task 5 | ✅ |
| processingService GRADE_PRESETS (4 presets) | Task 6 | ✅ |
| CATEGORY_GRADE_MAP | Task 6 | ✅ |
| processVideo pipeline (download→grade→watermark→upload) | Task 6 | ✅ |
| extractThumbnail | Task 6 | ✅ |
| checkFFmpeg | Task 6 | ✅ |
| TMP_DIR created on module load | Task 6 | ✅ |
| Non-fatal FFmpeg failures | Task 6 | ✅ |
| Cleanup in finally blocks | Task 6 | ✅ |
| socketEmitter emitJobUpdate (singleton Redis pub) | Task 7 | ✅ |
| setupJobUpdateSubscriber | Task 7 | ✅ |
| CHANNEL constant | Task 7 | ✅ |
| studioController createGeneration with zod | Task 8 | ✅ |
| Session cookie set if new | Task 8 | ✅ |
| Free tier 2/month limit | Task 8 | ✅ |
| Content moderation blocklist | Task 8 | ✅ |
| BullMQ queue with tier priority | Task 8 | ✅ |
| getJobStatus with ownership check | Task 8 | ✅ |
| getUserJobs with pagination | Task 8 | ✅ |
| getCategories | Task 8 | ✅ |
| previewPrompt (300 char preview) | Task 8 | ✅ |
| cancelJob (queued/prompt_building only) | Task 8 | ✅ |
| adminStudioController getDashboardStats | Task 9 | ✅ |
| Parallel queries in stats | Task 9 | ✅ |
| Routes with rate limiting | Task 10 | ✅ |
| Admin routes protected with auth | Task 10 | ✅ |
| videoWorker separate process + dotenv/mongoose | Task 11 | ✅ |
| Worker concurrency 3, limiter max 10/30s | Task 11 | ✅ |
| Full pipeline stages with progress | Task 11 | ✅ |
| Upscaling only for pro/agency | Task 11 | ✅ |
| updateDailyStats after job | Task 11 | ✅ |
| SIGTERM graceful shutdown | Task 11 | ✅ |
| index.js route registration | Task 12 | ✅ |
| index.js socket subscriber setup | Task 12 | ✅ |
| PM2 ecosystem config with worker | Task 13 | ✅ |
