# Qumak Studio Extensions — Copy, Share, Leads, Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI copy generation, share links, lead capture, asset rating/download tracking, prompt refinement, UTM tracking, and extended admin analytics on top of the existing Qumak Studio video generation backend.

**Architecture:** Six new Mongoose models (shareableLink, studioAsset, studioUser, lead, adCopy, adBrainFeedback) + three new services (copyService using Claude Haiku, promptRefiner, shareService) + UTM middleware + a new controller/routes file. All additions are additive — zero modifications to existing models or controllers except adminStudioController.js (extended) and index.js (route registration).

**Tech Stack:** CommonJS (require/module.exports), Mongoose, @anthropic-ai/sdk (claude-haiku-4-5-20251001), ioredis, express-rate-limit, uuid.

**Critical architecture notes:**
- `studioAsset.js` does NOT exist — this plan CREATES it (spec said "extend" but file is missing)
- Refine endpoint reuses existing `video-generation` BullMQ queue (no separate imageWorker exists)
- UTM middleware uses ioredis (already installed) to store utm:{sessionId} keys with 24h TTL
- New routes mount at `/api/v1/studio` via separate `_extRoutes.js` — no collision with existing `_routes.js`
- Anthropic SDK singleton pattern: `getAnthropic()` lazy-init, model `claude-haiku-4-5-20251001`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `model/schema/studioAsset.js` | Generated media asset record (images + videos) |
| Create | `model/schema/shareableLink.js` | Public share codes for assets |
| Create | `model/schema/lead.js` | Email lead capture with UTM attribution |
| Create | `model/schema/adCopy.js` | AI-generated ad copy per asset |
| Create | `model/schema/adBrainFeedback.js` | Thumbs up/down ratings on generated assets |
| Create | `model/schema/studioUser.js` | Studio profile extension (referral, credits, UTM first-touch) |
| Create | `services/copyService.js` | AI ad copy generation via Claude Haiku |
| Create | `services/promptRefiner.js` | Prompt mutation via Claude Haiku |
| Create | `services/shareService.js` | Share link creation, view/click tracking |
| Create | `middleware/utmCapture.js` | Store UTM params in Redis on every studio request |
| Create | `controllers/studio/extController.js` | generateCopy, refine, share, lead, rate, download, usage |
| Create | `controllers/studio/_extRoutes.js` | Additive routes at /api/v1/studio |
| Modify | `controllers/studio/adminStudioController.js` | Add 8 new analytics queries |
| Modify | `index.js` | Register studioExtRoutes |

---

## Task 1: Models — studioAsset + shareableLink

**Files:**
- Create: `model/schema/studioAsset.js`
- Create: `model/schema/shareableLink.js`

- [ ] **Step 1: Create `model/schema/studioAsset.js`**

```javascript
'use strict';

const mongoose = require('mongoose');

const studioAssetSchema = new mongoose.Schema({
  jobId:        { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', required: true, index: true },
  sessionId:    { type: String, required: true, index: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  category:     { type: String, default: '' },
  brandName:    { type: String, default: '' },

  type:         { type: String, enum: ['video', 'image_hd', 'image_lifestyle'], default: 'video' },
  status:       { type: String, enum: ['processing', 'completed', 'failed'], default: 'completed' },

  url:              { type: String, default: null },   // main URL (watermarked or clean)
  watermarkedUrl:   { type: String, default: null },
  cleanUrl:         { type: String, default: null },
  thumbnailUrl:     { type: String, default: null },
  mimeType:         { type: String, default: 'video/mp4' },
  fileSize:         { type: Number, default: null },
  resolution:       { type: String, default: null },

  tier:             { type: String, enum: ['free', 'starter', 'pro', 'agency'], default: 'free' },
  isWatermarked:    { type: Boolean, default: true },

  // Quality + engagement signals
  rating:           { type: Number, enum: [1, -1, 0], default: 0 },
  shareCode:        { type: String, index: true, sparse: true, default: null },
  shareViewCount:   { type: Number, default: 0 },
  copyGenCount:     { type: Number, default: 0 },
  downloadCount:    { type: Number, default: 0 },
  downloadedAt:     { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('StudioAsset', studioAssetSchema);
```

- [ ] **Step 2: Create `model/schema/shareableLink.js`**

```javascript
'use strict';

const mongoose = require('mongoose');

const shareableLinkSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, index: true },
  assetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true },
  jobId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null },
  sessionId:  { type: String, default: null },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  category:   { type: String, default: '' },

  viewCount:  { type: Number, default: 0 },
  clickCount: { type: Number, default: 0 },
  isActive:   { type: Boolean, default: true },
  expiresAt:  { type: Date, required: true }
}, { timestamps: true });

module.exports = mongoose.model('ShareableLink', shareableLinkSchema);
```

- [ ] **Step 3: Verify both models load**

```bash
cd /Users/gaian/Projects/startups/Qumak/qumak-backend
node -e "
const A = require('./model/schema/studioAsset');
const S = require('./model/schema/shareableLink');
console.log('studioAsset:', A.modelName);
console.log('shareableLink:', S.modelName);
console.log('rating enum:', A.schema.path('rating').enumValues);
console.log('shareCode sparse index:', !!A.schema.path('shareCode').options.sparse);
"
```

Expected:
```
studioAsset: StudioAsset
shareableLink: ShareableLink
rating enum: [ 1, -1, 0 ]
shareCode sparse index: true
```

- [ ] **Step 4: Commit**

```bash
git add model/schema/studioAsset.js model/schema/shareableLink.js
git commit -m "feat: add StudioAsset and ShareableLink Mongoose models"
```

---

## Task 2: Models — lead + adCopy + adBrainFeedback

**Files:**
- Create: `model/schema/lead.js`
- Create: `model/schema/adCopy.js`
- Create: `model/schema/adBrainFeedback.js`

- [ ] **Step 1: Create `model/schema/lead.js`**

```javascript
'use strict';

const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  email:        { type: String, required: true, lowercase: true, trim: true, index: true },
  sessionId:    { type: String, index: true, default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  source:       {
    type: String,
    enum: ['post_generation', 'exit_intent', 'share_page', 'waitlist'],
    default: 'post_generation'
  },

  category:         { type: String, default: null },
  utmSource:        { type: String, default: null },
  utmMedium:        { type: String, default: null },
  utmCampaign:      { type: String, default: null },
  referralCode:     { type: String, default: null },
  firstAssetId:     { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', default: null },

  emailSequenceStep: { type: Number, default: 0 },
  isConverted:       { type: Boolean, default: false },
  convertedAt:       { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
```

- [ ] **Step 2: Create `model/schema/adCopy.js`**

```javascript
'use strict';

const mongoose = require('mongoose');

const adCopySchema = new mongoose.Schema({
  assetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true, index: true },
  jobId:      { type: mongoose.Schema.Types.ObjectId, ref: 'StudioJob', default: null },
  category:   { type: String, default: '' },
  brandName:  { type: String, default: '' },

  captions:   { type: [String], default: [] },   // 3 variants
  headlines:  { type: [String], default: [] },   // 2 variants
  ctas:       { type: [String], default: [] },   // 2 variants
  hashtags:   { type: [String], default: [] },   // 10 tags

  platform:   { type: String, default: 'instagram' },
  locale:     { type: String, default: 'gulf' },
  promptUsed: { type: String, default: '' },
  modelUsed:  { type: String, default: 'claude-haiku' }
}, { timestamps: true });

module.exports = mongoose.model('AdCopy', adCopySchema);
```

- [ ] **Step 3: Create `model/schema/adBrainFeedback.js`**

```javascript
'use strict';

const mongoose = require('mongoose');

const adBrainFeedbackSchema = new mongoose.Schema({
  assetId:          { type: mongoose.Schema.Types.ObjectId, ref: 'StudioAsset', required: true },
  sessionId:        { type: String, default: null },

  rating:           { type: Number, enum: [1, -1], required: true },
  category:         { type: String, default: '' },
  modelUsed:        { type: String, default: '' },
  vibe:             { type: String, default: '' },
  locale:           { type: String, default: '' },
  promptSnapshot:   { type: String, default: '' },
  regeneratedAfter: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('AdBrainFeedback', adBrainFeedbackSchema);
```

- [ ] **Step 4: Verify all three load**

```bash
node -e "
const Lead = require('./model/schema/lead');
const AdCopy = require('./model/schema/adCopy');
const Feedback = require('./model/schema/adBrainFeedback');
console.log(Lead.modelName, AdCopy.modelName, Feedback.modelName);
console.log('source enum:', Lead.schema.path('source').enumValues.join(', '));
console.log('rating enum:', Feedback.schema.path('rating').enumValues.join(', '));
"
```

Expected:
```
Lead AdCopy AdBrainFeedback
source enum: post_generation, exit_intent, share_page, waitlist
rating enum: 1, -1
```

- [ ] **Step 5: Commit**

```bash
git add model/schema/lead.js model/schema/adCopy.js model/schema/adBrainFeedback.js
git commit -m "feat: add Lead, AdCopy, AdBrainFeedback Mongoose models"
```

---

## Task 3: Model — studioUser

**Files:**
- Create: `model/schema/studioUser.js`

- [ ] **Step 1: Create `model/schema/studioUser.js`**

This is a separate collection — NOT modifying `user.js`. It stores the studio profile keyed by userId OR sessionId for anonymous users.

```javascript
'use strict';

const mongoose = require('mongoose');

const studioUserSchema = new mongoose.Schema({
  // One of these will be set
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  sessionId: { type: String, default: null, index: true },

  referralCode:   { type: String, unique: true, sparse: true, default: null },
  referredBy:     { type: String, default: null },
  creditsBonus:   { type: Number, default: 0 },

  // First-touch UTM — never overwritten after set
  utmSource:      { type: String, default: null },
  utmMedium:      { type: String, default: null },
  utmCampaign:    { type: String, default: null },

  emailCaptured:  { type: Boolean, default: false },
  onboardingDone: { type: Boolean, default: false },
  lastActiveAt:   { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('StudioUser', studioUserSchema);
```

- [ ] **Step 2: Verify**

```bash
node -e "
const SU = require('./model/schema/studioUser');
console.log('model:', SU.modelName);
console.log('referralCode sparse:', !!SU.schema.path('referralCode').options.sparse);
"
```

Expected:
```
model: StudioUser
referralCode sparse: true
```

- [ ] **Step 3: Commit**

```bash
git add model/schema/studioUser.js
git commit -m "feat: add StudioUser model for studio profile, referrals, and UTM attribution"
```

---

## Task 4: Service — copyService.js

**Files:**
- Create: `services/copyService.js`

This service uses Claude Haiku to generate platform-optimized ad copy with real Gulf market intelligence baked into the system prompt.

- [ ] **Step 1: Create `services/copyService.js`**

```javascript
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const AdCopy = require('../model/schema/adCopy');

const MODEL = 'claude-haiku-4-5-20251001';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─── Hook formulas injected by category ───────────────────────────────────

const HOOK_FORMULAS = {
  gym:        'Hook formula: "[Negative state]. Start [positive transformation]." — address pain first, transformation second.',
  realestate: 'Hook formula: "Every week you wait, [consequence]. [Brand] changes that." — consequence-driven urgency.',
  perfume:    'Hook formula: "The scent that [emotional outcome]." — identity and desire, not product features.',
  restaurant: 'Hook formula: "The [food/experience] Dubai can\'t stop talking about." — social proof and place.',
  skincare:   'Hook formula: "Your skin in 30 days. [Before] → [After]." — concrete transformation timeline.',
  saas:       'Hook formula: "[Pain point] is costing you [specific outcome]. Fix it today." — pain + cost + urgency.',
  service:    'Hook formula: "[Struggle]. [Brand] handles it — so you don\'t have to." — relief and delegation.'
};

// ─── Category area references for Gulf market ─────────────────────────────

const GULF_AREA_HINTS = {
  realestate: 'Reference specific Dubai areas where relevant: JBR, Downtown Dubai, Dubai Marina, Palm Jumeirah, Business Bay, Dubai Hills, DIFC.',
  restaurant:  'Reference UAE hospitality culture, family gatherings, and occasions like Eid and National Day where relevant.',
  gym:         'Reference Dubai fitness culture: morning workouts before the heat, transformation goals, Dubai Marina running track, premium club culture.',
  perfume:     'Reference oud tradition, bakhoor culture, luxury positioning. Never discount framing.',
  saas:        'Reference DIFC and Dubai tech ecosystem, business efficiency in the UAE market.',
  service:     'Reference UAE business environment, Mainland/Freezone context if relevant, professional trust signals.'
};

// ─── Platform rules ────────────────────────────────────────────────────────

const PLATFORM_RULES = {
  instagram: 'Instagram caption format: opening hook (first line before "more" — make it impossible to scroll past) + body + CTA + hashtags. Hook under 125 characters. Full caption 100-150 words sweet spot.',
  facebook:  'Facebook: storytelling works. Longer form ok (100-150 words). Emotional narrative. Lead with a question or bold claim. Audience: slightly older, more decision-ready.',
  tiktok:    'TikTok: FIRST 3 WORDS ARE EVERYTHING. Max 30 words visible. Punchy, lowercase-friendly, native-feeling. No corporate speak. Sound-on assumption: write for someone watching with audio.',
  whatsapp:  'WhatsApp: conversational, NOT ad-speak. Personal tone like a friend recommending something. Max 50 words. No hashtags. Direct and warm.'
};

// ─── Build the system prompt ────────────────────────────────────────────────

function buildSystemPrompt(category, platform, locale) {
  const hookFormula = HOOK_FORMULAS[category] || HOOK_FORMULAS.service;
  const gulfHint = GULF_AREA_HINTS[category] || '';
  const platformRule = PLATFORM_RULES[platform] || PLATFORM_RULES.instagram;

  return `You are an elite performance marketing copywriter with 10 years experience creating high-converting ads for Meta, TikTok, and Instagram. You specialize in the UAE/Gulf market and understand direct response principles, emotional triggers, and platform-specific copy.

PLATFORM RULES:
${platformRule}

${locale === 'gulf' ? `GULF MARKET COPY RULES:
- Never use aggressive scarcity ("LAST CHANCE!!!") — reads cheap in UAE premium market
- Use confident scarcity instead: "Delivery slots this week are filling fast"
- Ramadan context: warmth over urgency, family over individual, reflection themes
- Price mentions: always in AED for local ads, never show discount framing for luxury categories
- Arabic transliteration of key words boosts engagement in bilingual feeds (e.g. "habibi", "yalla")
${gulfHint}` : `GLOBAL MARKET RULES:
- Clear value proposition first
- Universal emotional triggers: status, belonging, transformation, simplicity
- No regional specifics`}

EMOTIONAL TRIGGERS BY CATEGORY:
- realestate: status, security, generational wealth, market timing
- gym: identity transformation (not just physical — who they become)
- perfume: memory, desire, exclusivity, identity
- restaurant: belonging, culture, occasion, shared experience
- saas: time saved, competitive edge, simplicity, control
- service: trust, relief, expertise proof, time reclaimed

CTA HIERARCHY (match to funnel stage):
- Awareness: "Explore" / "Discover" / "See how"
- Consideration: "Learn more" / "Reserve your spot"  
- Conversion: "Book now" / "Start today" / "Get yours"

${hookFormula}

OUTPUT FORMAT:
Output ONLY valid JSON — no markdown, no explanation, no preamble. Exactly this structure:
{
  "captions": ["caption1 (80-120 words, full storytelling)", "caption2 (50-70 words, concise)", "caption3 (20-30 words, punchy hook only)"],
  "headlines": ["headline1 (6-10 words)", "headline2 (6-10 words, different angle)"],
  "ctas": ["cta1 (2-4 words, strong)", "cta2 (2-4 words, softer)"],
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8", "#tag9", "#tag10"]
}

Hashtags: mix of niche (specific to category + location) and broad (fitness, luxury, etc). No spaces. UAE-specific tags where locale is gulf.`;
}

// ─── Generate copy ─────────────────────────────────────────────────────────

/**
 * generateCopy — generates platform-optimized ad copy and persists to DB.
 * @param {object} params
 * @param {string} params.assetId
 * @param {string} params.jobId
 * @param {string} params.category
 * @param {string} params.brandName
 * @param {string} params.platform — 'instagram'|'facebook'|'tiktok'|'whatsapp'
 * @param {string} params.locale — 'gulf'|'global'
 * @param {string} [params.adStructure] — e.g. "problem → solution → CTA"
 * @param {string} [params.targetAudience]
 * @returns {object} { captions, headlines, ctas, hashtags }
 */
async function generateCopy({ assetId, jobId, category, brandName, platform = 'instagram', locale = 'gulf', adStructure, targetAudience }) {
  const systemPrompt = buildSystemPrompt(category, platform, locale);

  const categoryLabel = {
    gym: 'gym and fitness brand',
    realestate: 'luxury real estate developer in Dubai',
    perfume: 'luxury perfume and fragrance brand',
    restaurant: 'restaurant and dining experience',
    saas: 'SaaS and technology product',
    service: 'professional service business'
  }[category] || category;

  let userPrompt = `Brand: "${brandName}" — ${categoryLabel}
Platform: ${platform}
Locale: ${locale === 'gulf' ? 'UAE/Gulf market' : 'Global market'}`;

  if (targetAudience) userPrompt += `\nTarget audience: ${targetAudience}`;
  if (adStructure) userPrompt += `\nAd structure to follow: ${adStructure}`;

  userPrompt += `\n\nGenerate high-converting ad copy for this brand. Apply all platform rules and market intelligence from your instructions.`;

  const callClaude = async (stricterInstruction = false) => {
    const messages = [{ role: 'user', content: stricterInstruction
      ? userPrompt + '\n\nIMPORTANT: Output ONLY the raw JSON object. No markdown. No explanation. Start with { and end with }.'
      : userPrompt
    }];

    const response = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages
    });

    const text = response.content[0]?.text || '';
    // Strip any markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  };

  let parsed;
  try {
    parsed = await callClaude(false);
  } catch (err) {
    console.warn('[copyService] First parse failed, retrying with stricter instruction:', err.message);
    try {
      parsed = await callClaude(true);
    } catch (retryErr) {
      throw new Error(`copyService: Failed to parse Claude response after retry: ${retryErr.message}`);
    }
  }

  // Validate structure
  if (!Array.isArray(parsed.captions) || parsed.captions.length < 3) throw new Error('copyService: invalid captions in response');
  if (!Array.isArray(parsed.headlines) || parsed.headlines.length < 2) throw new Error('copyService: invalid headlines in response');
  if (!Array.isArray(parsed.ctas) || parsed.ctas.length < 2) throw new Error('copyService: invalid ctas in response');
  if (!Array.isArray(parsed.hashtags) || parsed.hashtags.length < 5) throw new Error('copyService: insufficient hashtags in response');

  // Persist
  await AdCopy.create({
    assetId,
    jobId,
    category,
    brandName,
    captions: parsed.captions.slice(0, 3),
    headlines: parsed.headlines.slice(0, 2),
    ctas: parsed.ctas.slice(0, 2),
    hashtags: parsed.hashtags.slice(0, 10),
    platform,
    locale,
    modelUsed: MODEL
  });

  return {
    captions: parsed.captions.slice(0, 3),
    headlines: parsed.headlines.slice(0, 2),
    ctas: parsed.ctas.slice(0, 2),
    hashtags: parsed.hashtags.slice(0, 10)
  };
}

module.exports = { generateCopy };
```

- [ ] **Step 2: Verify syntax + structure**

```bash
node -e "
const cs = require('./services/copyService');
console.log('generateCopy type:', typeof cs.generateCopy);
console.log('copyService OK');
"
```

Expected: `generateCopy type: function` / `copyService OK`

- [ ] **Step 3: Manual copy quality test** (requires ANTHROPIC_API_KEY in env)

If API key is available, run this and verify the output reads like real ad copy, not generic filler:

```bash
node -e "
require('dotenv').config();
const { generateCopy } = require('./services/copyService');
// We need a fake assetId — use a mongoose ObjectId string
const fakeId = '000000000000000000000001';
generateCopy({
  assetId: fakeId, jobId: fakeId,
  category: 'gym', brandName: 'Iron Republic',
  platform: 'instagram', locale: 'gulf'
}).then(r => {
  console.log('caption[0] word count:', r.captions[0].split(' ').length);
  console.log('caption[2] word count:', r.captions[2].split(' ').length);
  console.log('headlines:', r.headlines);
  console.log('hashtags count:', r.hashtags.length);
}).catch(e => console.log('API error (expected without key):', e.message));
"
```

Acceptance criteria if key is available:
- `captions[0]` word count: 80-120
- `captions[2]` word count: under 35
- `headlines` mention Dubai or Iron Republic
- `hashtags` count: 10

- [ ] **Step 4: Commit**

```bash
git add services/copyService.js
git commit -m "feat: add copyService AI ad copy generation with Gulf market intelligence"
```

---

## Task 5: Service — promptRefiner.js

**Files:**
- Create: `services/promptRefiner.js`

- [ ] **Step 1: Create `services/promptRefiner.js`**

```javascript
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─── Instruction → prompt mutation guide (injected into system prompt) ─────

const MUTATION_GUIDE = `When the instruction says:
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

/**
 * refinePrompt — mutates an existing video generation prompt based on user instruction.
 * @param {object} params
 * @param {string} params.originalPrompt
 * @param {string} params.instruction
 * @param {string} params.category
 * @param {string} params.locale
 * @returns {{ refinedPrompt: string, changes: string }}
 */
async function refinePrompt({ originalPrompt, instruction, category, locale }) {
  const systemPrompt = `You are a prompt engineering expert for AI video generation for ${category} ads in the ${locale === 'gulf' ? 'UAE/Gulf' : 'global'} market.

Your job is to modify an existing video generation prompt based on a user's instruction.
Keep all the marketing and brand intelligence intact. Only modify what the instruction asks.
Preserve the labeled structure (VISUAL WORLD:, CAMERA:, LIGHTING:, BRAND:, etc.).

${MUTATION_GUIDE}

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

  // Extract prompt (everything before the CHANGES: line)
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
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const pr = require('./services/promptRefiner');
console.log('refinePrompt type:', typeof pr.refinePrompt);
console.log('promptRefiner OK');
"
```

Expected: `refinePrompt type: function` / `promptRefiner OK`

- [ ] **Step 3: Commit**

```bash
git add services/promptRefiner.js
git commit -m "feat: add promptRefiner service for Claude-powered prompt mutation"
```

---

## Task 6: Service — shareService.js

**Files:**
- Create: `services/shareService.js`

- [ ] **Step 1: Create `services/shareService.js`**

```javascript
'use strict';

const StudioAsset = require('../model/schema/studioAsset');
const ShareableLink = require('../model/schema/shareableLink');

/**
 * generateCode — 8-char alphanumeric shortcode.
 */
function generateCode() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * createShareLink — creates a share link for an asset (idempotent: returns existing if already shared).
 * @param {string} assetId
 * @param {string} sessionId
 * @param {string|null} userId
 * @returns {{ code: string, publicUrl: string }}
 */
async function createShareLink(assetId, sessionId, userId = null) {
  // Idempotent: return existing share link if present
  const existing = await ShareableLink.findOne({ assetId, isActive: true });
  if (existing) {
    const publicUrl = `${process.env.CLIENT_URL || 'https://qumak.ae'}/share/${existing.code}`;
    return { code: existing.code, publicUrl };
  }

  // Load asset for category
  const asset = await StudioAsset.findById(assetId).lean();
  if (!asset) throw new Error('Asset not found');

  // Generate unique code
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    const collision = await ShareableLink.findOne({ code });
    if (!collision) break;
    attempts++;
  } while (attempts < 5);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await ShareableLink.create({
    code,
    assetId,
    jobId: asset.jobId,
    sessionId,
    userId,
    category: asset.category,
    expiresAt
  });

  // Store shortcode on asset for fast lookup
  await StudioAsset.findByIdAndUpdate(assetId, { shareCode: code });

  const publicUrl = `${process.env.CLIENT_URL || 'https://qumak.ae'}/share/${code}`;
  return { code, publicUrl };
}

/**
 * getShareData — returns public-safe share page data for a given code.
 * @param {string} code
 * @returns {object} Public share data
 */
async function getShareData(code) {
  const link = await ShareableLink.findOne({
    code,
    isActive: true,
    expiresAt: { $gt: new Date() }
  });

  if (!link) return null;

  // Increment view count
  await ShareableLink.findByIdAndUpdate(link._id, { $inc: { viewCount: 1 } });
  await StudioAsset.findByIdAndUpdate(link.assetId, { $inc: { shareViewCount: 1 } });

  const asset = await StudioAsset.findById(link.assetId).lean();
  if (!asset) return null;

  const clientUrl = process.env.CLIENT_URL || 'https://qumak.ae';

  return {
    imageUrl: asset.watermarkedUrl || asset.url || null,
    thumbnailUrl: asset.thumbnailUrl || null,
    category: link.category,
    brandName: asset.brandName || '',
    createdAt: link.createdAt,
    clickCTA: `${clientUrl}/studio?ref=share&code=${code}`
  };
}

/**
 * recordShareClick — fires when visitor clicks "Create my own ad" on the share page.
 * @param {string} code
 */
async function recordShareClick(code) {
  await ShareableLink.findOneAndUpdate(
    { code, isActive: true },
    { $inc: { clickCount: 1 } }
  );
}

module.exports = { createShareLink, getShareData, recordShareClick };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const ss = require('./services/shareService');
console.log('createShareLink:', typeof ss.createShareLink);
console.log('getShareData:', typeof ss.getShareData);
console.log('recordShareClick:', typeof ss.recordShareClick);
"
```

Expected: all `function`.

- [ ] **Step 3: Commit**

```bash
git add services/shareService.js
git commit -m "feat: add shareService for share link creation, views, and click tracking"
```

---

## Task 7: Middleware — utmCapture.js

**Files:**
- Create: `middleware/utmCapture.js`

Note: directory is `middleware/` (without typo), NOT `middelwares/`.

- [ ] **Step 1: Create `middleware/utmCapture.js`**

```javascript
'use strict';

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const UTM_TTL_SECONDS = 24 * 60 * 60; // 24 hours

let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: false
    });
    _redis.on('error', (err) => {
      console.error('[utmCapture] Redis error (non-fatal):', err.message);
    });
  }
  return _redis;
}

/**
 * utmCapture — middleware that stores UTM params in Redis keyed by sessionId.
 * Non-fatal: if Redis is unavailable, the request continues.
 */
async function utmCapture(req, res, next) {
  try {
    const { utm_source, utm_medium, utm_campaign, utm_content, ref } = req.query;

    // Only act if at least one UTM param is present
    if (!utm_source && !utm_medium && !utm_campaign && !ref) {
      return next();
    }

    const sessionId = req.cookies?.qumak_session || req.headers['x-session-id'];
    if (!sessionId) return next();

    const utmData = {};
    if (utm_source)   utmData.utm_source   = utm_source;
    if (utm_medium)   utmData.utm_medium   = utm_medium;
    if (utm_campaign) utmData.utm_campaign = utm_campaign;
    if (utm_content)  utmData.utm_content  = utm_content;
    if (ref)          utmData.ref          = ref;

    const key = `utm:${sessionId}`;
    const redis = getRedis();
    await redis.set(key, JSON.stringify(utmData), 'EX', UTM_TTL_SECONDS);
  } catch (err) {
    // Non-fatal — UTM capture failure must never break the main request
    console.warn('[utmCapture] Failed to store UTM data (non-fatal):', err.message);
  }
  next();
}

/**
 * getUtmData — retrieves stored UTM data for a sessionId.
 * @param {string} sessionId
 * @returns {object|null}
 */
async function getUtmData(sessionId) {
  try {
    if (!sessionId) return null;
    const redis = getRedis();
    const data = await redis.get(`utm:${sessionId}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.warn('[utmCapture] getUtmData failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { utmCapture, getUtmData };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const { utmCapture, getUtmData } = require('./middleware/utmCapture');
console.log('utmCapture:', typeof utmCapture);
console.log('getUtmData:', typeof getUtmData);
"
```

Expected: both `function`.

- [ ] **Step 3: Commit**

```bash
git add middleware/utmCapture.js
git commit -m "feat: add UTM capture middleware with Redis 24h storage"
```

---

## Task 8: Controller — extController.js

**Files:**
- Create: `controllers/studio/extController.js`

Dependencies: studioAsset, studioJob, lead, adCopy, adBrainFeedback, studioUser models; copyService, promptRefiner, shareService; utmCapture.getUtmData; Queue from bullmq.

- [ ] **Step 1: Create `controllers/studio/extController.js`**

```javascript
'use strict';

const { Queue } = require('bullmq');
const StudioJob = require('../../model/schema/studioJob');
const StudioAsset = require('../../model/schema/studioAsset');
const Lead = require('../../model/schema/lead');
const AdBrainFeedback = require('../../model/schema/adBrainFeedback');
const StudioUser = require('../../model/schema/studioUser');
const copyService = require('../../services/copyService');
const promptRefiner = require('../../services/promptRefiner');
const shareService = require('../../services/shareService');
const { getUtmData } = require('../../middleware/utmCapture');

// ─── Queue (reuse existing video-generation queue) ─────────────────────────

let _queue = null;
function getQueue() {
  if (!_queue) {
    _queue = new Queue('video-generation', {
      connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 }
      }
    });
  }
  return _queue;
}

// ─── Tier limits ───────────────────────────────────────────────────────────

const TIER_LIMITS = {
  free:    { imageHd: 2,   video: 2 },
  starter: { imageHd: 20,  video: 5 },
  pro:     { imageHd: 100, video: 20 },
  agency:  { imageHd: -1,  video: -1 }
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function getSessionId(req) {
  return req.cookies?.qumak_session || req.headers['x-session-id'] || null;
}

function checkAssetOwnership(asset, req) {
  const sessionId = getSessionId(req);
  const ownedBySession = sessionId && asset.sessionId === sessionId;
  const ownedByUser = req.user?._id && asset.userId && asset.userId.toString() === req.user._id.toString();
  return ownedBySession || ownedByUser;
}

function getMonthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/studio/asset/:id/copy
 */
exports.generateCopy = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const { platform = 'instagram', adStructure, targetAudience } = req.body;

    const copy = await copyService.generateCopy({
      assetId: asset._id.toString(),
      jobId: asset.jobId?.toString(),
      category: asset.category,
      brandName: asset.brandName,
      platform,
      locale: req.body.locale || 'gulf',
      adStructure,
      targetAudience
    });

    // Increment asset copy gen count
    await StudioAsset.findByIdAndUpdate(asset._id, { $inc: { copyGenCount: 1 } });

    return res.json({ success: true, copy });
  } catch (err) {
    console.error('[extController] generateCopy error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to generate copy.' });
  }
};

/**
 * POST /api/v1/studio/job/:id/refine
 */
exports.refineGeneration = async (req, res) => {
  try {
    const job = await StudioJob.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'not_found', message: 'Job not found.' });

    const sessionId = getSessionId(req);
    const ownedBySession = sessionId && job.sessionId === sessionId;
    const ownedByUser = req.user?._id && job.userId && job.userId.toString() === req.user._id.toString();
    if (!ownedBySession && !ownedByUser) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    if (job.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'not_completed', message: 'Can only refine completed jobs.' });
    }

    const { instruction } = req.body;
    if (!instruction || typeof instruction !== 'string' || instruction.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'instruction is required.' });
    }

    const originalPrompt = job.promptPipeline?.finalPrompt || '';

    const { refinedPrompt, changes } = await promptRefiner.refinePrompt({
      originalPrompt,
      instruction: instruction.trim(),
      category: job.category,
      locale: job.userInputs?.locale || 'gulf'
    });

    // Create new job inheriting from parent
    const newJob = await StudioJob.create({
      userId: job.userId,
      sessionId: job.sessionId,
      category: job.category,
      userInputs: { ...job.userInputs.toObject ? job.userInputs.toObject() : job.userInputs },
      promptPipeline: {
        rawUserIntent: `Refined from job ${job._id}: ${instruction}`,
        finalPrompt: refinedPrompt,
        negativePrompt: job.promptPipeline?.negativePrompt || '',
        refinementNotes: changes
      },
      tier: job.tier,
      isWatermarked: job.isWatermarked,
      status: 'queued',
      statusMessage: 'Refined version queued.',
      userInputs: {
        ...job.userInputs.toObject ? job.userInputs.toObject() : job.userInputs,
        extras: { ...(job.userInputs.extras || {}), parentJobId: job._id.toString(), refinedFrom: instruction }
      }
    });

    await getQueue().add('generate', { jobId: newJob._id.toString() }, { priority: 3 });

    return res.status(201).json({ success: true, newJobId: newJob._id, changes });
  } catch (err) {
    console.error('[extController] refineGeneration error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to refine generation.' });
  }
};

/**
 * POST /api/v1/studio/asset/:id/share
 */
exports.createShareLink = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const sessionId = getSessionId(req);
    const { code, publicUrl } = await shareService.createShareLink(
      asset._id.toString(), sessionId, req.user?._id || null
    );

    return res.json({ success: true, shareUrl: publicUrl, code });
  } catch (err) {
    console.error('[extController] createShareLink error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to create share link.' });
  }
};

/**
 * GET /api/v1/studio/share/:code  — PUBLIC
 */
exports.getSharePage = async (req, res) => {
  try {
    const data = await shareService.getShareData(req.params.code);
    if (!data) return res.status(404).json({ success: false, error: 'not_found', message: 'Share link not found or expired.' });
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[extController] getSharePage error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to load share page.' });
  }
};

/**
 * POST /api/v1/studio/share/:code/click  — PUBLIC
 */
exports.recordShareClick = async (req, res) => {
  try {
    await shareService.recordShareClick(req.params.code);
    return res.json({ success: true });
  } catch (err) {
    console.error('[extController] recordShareClick error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to record click.' });
  }
};

/**
 * POST /api/v1/studio/lead/capture  — PUBLIC
 */
exports.captureLead = async (req, res) => {
  try {
    const { email, source = 'post_generation', referralCode } = req.body;

    // Basic email validation
    if (!email || typeof email !== 'string' || !email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Valid email is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const sessionId = getSessionId(req);

    // Deduplicate by email
    const existing = await Lead.findOne({ email: normalizedEmail });
    if (existing) return res.json({ success: true, exists: true, message: 'Already subscribed.' });

    // Get UTM data from Redis
    const utmData = await getUtmData(sessionId);

    // Find first asset for this session
    const firstAsset = sessionId
      ? await StudioAsset.findOne({ sessionId }).sort({ createdAt: 1 }).lean()
      : null;

    // Create lead
    await Lead.create({
      email: normalizedEmail,
      sessionId,
      userId: req.user?._id || null,
      source,
      category: firstAsset?.category || null,
      utmSource:   utmData?.utm_source   || null,
      utmMedium:   utmData?.utm_medium   || null,
      utmCampaign: utmData?.utm_campaign || null,
      referralCode: referralCode || utmData?.ref || null,
      firstAssetId: firstAsset?._id || null
    });

    // Referral bonus: find referring user, +5 credits
    if (referralCode || utmData?.ref) {
      const code = referralCode || utmData.ref;
      try {
        await StudioUser.findOneAndUpdate(
          { referralCode: code },
          { $inc: { creditsBonus: 5 } }
        );
      } catch (refErr) {
        console.warn('[extController] referral credit update failed (non-fatal):', refErr.message);
      }
    }

    // TODO: trigger SendGrid drip email sequence here
    console.log(`[extController] Lead captured: ${normalizedEmail} (source: ${source})`);

    return res.json({ success: true, message: 'Check your email for your saved creatives.' });
  } catch (err) {
    console.error('[extController] captureLead error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to capture lead.' });
  }
};

/**
 * PATCH /api/v1/studio/asset/:id/rate
 */
exports.rateAsset = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    const { rating } = req.body;
    if (rating !== 1 && rating !== -1) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'rating must be 1 or -1.' });
    }

    const sessionId = getSessionId(req);

    // Upsert feedback
    await AdBrainFeedback.findOneAndUpdate(
      { assetId: asset._id, sessionId },
      {
        assetId: asset._id,
        sessionId,
        rating,
        category: asset.category,
        locale: '',
        vibe: ''
      },
      { upsert: true, new: true }
    );

    // Update asset rating
    asset.rating = rating;
    await asset.save();

    const suggestion = rating === -1
      ? { refineUrl: `/api/v1/studio/job/${asset.jobId}/refine`, message: 'Try refining with a different instruction.' }
      : null;

    return res.json({ success: true, suggestion });
  } catch (err) {
    console.error('[extController] rateAsset error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to rate asset.' });
  }
};

/**
 * POST /api/v1/studio/asset/:id/download
 */
exports.trackDownload = async (req, res) => {
  try {
    const asset = await StudioAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'not_found', message: 'Asset not found.' });
    if (!checkAssetOwnership(asset, req)) return res.status(403).json({ success: false, error: 'forbidden', message: 'Access denied.' });

    asset.downloadCount = (asset.downloadCount || 0) + 1;
    asset.downloadedAt = new Date();
    await asset.save();

    const downloadUrl = asset.isWatermarked
      ? (asset.watermarkedUrl || asset.url)
      : (asset.cleanUrl || asset.url);

    return res.json({ success: true, downloadUrl });
  } catch (err) {
    console.error('[extController] trackDownload error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to track download.' });
  }
};

/**
 * GET /api/v1/studio/usage
 */
exports.getUsageStats = async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const tier = req.user?.plan || 'free';
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;
    const monthStart = getMonthStart();

    const query = sessionId ? { sessionId, createdAt: { $gte: monthStart } } : { createdAt: { $gte: monthStart }, _id: null };

    const [videoCount, imageHdCount] = await Promise.all([
      StudioJob.countDocuments({ ...query, status: { $in: ['completed', 'generating', 'queued'] } }),
      StudioAsset.countDocuments({ ...query, type: { $in: ['image_hd', 'image_lifestyle'] } })
    ]);

    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);
    resetDate.setDate(1);
    resetDate.setHours(0, 0, 0, 0);

    return res.json({
      success: true,
      tier,
      usage: { imageHd: imageHdCount, video: videoCount },
      limits,
      remaining: {
        imageHd: limits.imageHd === -1 ? -1 : Math.max(0, limits.imageHd - imageHdCount),
        video:   limits.video   === -1 ? -1 : Math.max(0, limits.video - videoCount)
      },
      resetDate
    });
  } catch (err) {
    console.error('[extController] getUsageStats error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch usage.' });
  }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const ctrl = require('./controllers/studio/extController');
const keys = Object.keys(ctrl);
console.log('exports:', keys.join(', '));
console.log('all functions:', keys.every(k => typeof ctrl[k] === 'function'));
"
```

Expected:
```
exports: generateCopy, refineGeneration, createShareLink, getSharePage, recordShareClick, captureLead, rateAsset, trackDownload, getUsageStats
all functions: true
```

- [ ] **Step 3: Commit**

```bash
git add controllers/studio/extController.js
git commit -m "feat: add extController for copy gen, share, leads, rating, download, usage"
```

---

## Task 9: Routes — _extRoutes.js

**Files:**
- Create: `controllers/studio/_extRoutes.js`

- [ ] **Step 1: Create `controllers/studio/_extRoutes.js`**

```javascript
'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./extController');
const auth = require('../../middelwares/auth');
const { utmCapture } = require('../../middleware/utmCapture');

// Apply UTM capture to all studio ext routes
router.use(utmCapture);

// ── Public routes ────────────────────────────────────────────────────────
router.get('/share/:code',         ctrl.getSharePage);
router.post('/share/:code/click',  ctrl.recordShareClick);
router.post('/lead/capture',       ctrl.captureLead);

// ── Session-authenticated routes (ownership checked inside controller) ───
router.post('/asset/:id/copy',     ctrl.generateCopy);
router.post('/asset/:id/share',    ctrl.createShareLink);
router.patch('/asset/:id/rate',    ctrl.rateAsset);
router.post('/asset/:id/download', ctrl.trackDownload);
router.post('/job/:id/refine',     ctrl.refineGeneration);
router.get('/usage',               ctrl.getUsageStats);

module.exports = router;
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const r = require('./controllers/studio/_extRoutes');
console.log('extRoutes type:', typeof r);
console.log('extRoutes is Router:', typeof r.get === 'function' && typeof r.post === 'function');
"
```

Expected: `extRoutes type: function` / `extRoutes is Router: true`

- [ ] **Step 3: Commit**

```bash
git add controllers/studio/_extRoutes.js
git commit -m "feat: add _extRoutes for studio extensions (copy, share, leads, rating, usage)"
```

---

## Task 10: Extend adminStudioController.js

**Files:**
- Modify: `controllers/studio/adminStudioController.js`

Read the file first, then add the new analytics queries to `getDashboardStats`.

- [ ] **Step 1: Read the current file**

Read `/Users/gaian/Projects/startups/Qumak/qumak-backend/controllers/studio/adminStudioController.js` to see the exact current content before editing.

- [ ] **Step 2: Replace the file with the extended version**

The new version adds 8 additional analytics queries. Replace the entire file:

```javascript
'use strict';

const StudioJob = require('../../model/schema/studioJob');
const DailyStat = require('../../model/schema/dailyStat');
const Lead = require('../../model/schema/lead');
const AdBrainFeedback = require('../../model/schema/adBrainFeedback');
const StudioAsset = require('../../model/schema/studioAsset');

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
      activeJobCount,
      // New analytics
      avgRatingByCategory,
      leadsThisWeek,
      totalLeads,
      convertedLeads,
      completedAssets,
      downloadedAssets,
      sharedAssets,
      regenJobs
    ] = await Promise.all([
      // Existing
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
      StudioJob.countDocuments({ status: { $in: ['queued', 'generating', 'postprocessing'] } }),

      // Quality: avg rating grouped by category
      AdBrainFeedback.aggregate([
        { $group: { _id: '$category', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]),

      // Acquisition: leads this week
      Lead.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Lead.countDocuments(),
      Lead.countDocuments({ isConverted: true }),

      // Asset engagement
      StudioAsset.countDocuments({ status: 'completed' }),
      StudioAsset.countDocuments({ downloadCount: { $gt: 0 } }),
      StudioAsset.countDocuments({ shareCode: { $ne: null } }),

      // Regen rate: jobs with parentJobId stored in extras
      StudioJob.countDocuments({ 'userInputs.extras.parentJobId': { $exists: true } })
    ]);

    // Shape quality signals
    const ratingMap = {};
    avgRatingByCategory.forEach(item => {
      ratingMap[item._id] = { avgRating: Math.round(item.avgRating * 100) / 100, count: item.count };
    });

    const categoryMap = {};
    categoryBreakdown.forEach(item => { categoryMap[item._id] = item.count; });

    const totalCompleted = Object.values(categoryMap).reduce((a, b) => a + b, 0);

    return res.json({
      success: true,
      stats: {
        // Core
        totalJobs,
        activeJobs: activeJobCount,
        today: todayStat || { totalJobs: 0, completedJobs: 0, failedJobs: 0, totalFalCost: 0 },
        categoryBreakdown: categoryMap,
        recentFailures: recentFailures.map(f => ({
          category: f.category,
          errorMessage: f.error?.message || 'Unknown error',
          createdAt: f.createdAt
        })),

        // Quality signals
        avgRatingByCategory: ratingMap,
        regenRateByCategory: totalCompleted > 0
          ? { total: regenJobs, rate: Math.round((regenJobs / totalCompleted) * 100) / 100 }
          : { total: 0, rate: 0 },

        // Acquisition
        leadsThisWeek,
        leadConversionRate: totalLeads > 0
          ? Math.round((convertedLeads / totalLeads) * 1000) / 1000
          : 0,

        // Asset engagement
        shareClickRate: completedAssets > 0
          ? Math.round((sharedAssets / completedAssets) * 1000) / 1000
          : 0,
        downloadRate: completedAssets > 0
          ? Math.round((downloadedAssets / completedAssets) * 1000) / 1000
          : 0
      }
    });
  } catch (err) {
    console.error('[adminStudioController] getDashboardStats error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch stats.' });
  }
};
```

- [ ] **Step 3: Verify syntax**

```bash
node -e "
const a = require('./controllers/studio/adminStudioController');
console.log('getDashboardStats:', typeof a.getDashboardStats);
"
```

Expected: `getDashboardStats: function`

- [ ] **Step 4: Commit**

```bash
git add controllers/studio/adminStudioController.js
git commit -m "feat: extend adminStudioController with quality, acquisition, and engagement analytics"
```

---

## Task 11: Update index.js

**Files:**
- Modify: `index.js`

Read the file first, then make exactly one addition.

- [ ] **Step 1: Read index.js to find insertion point**

The existing studio route registration looks like this (added in previous session):
```javascript
// Studio — AI Ad Video Generation
const studioRoutes = require('./controllers/studio/_routes');
app.use('/api/v1/studio', studioRoutes);
```

- [ ] **Step 2: Insert after the existing studio block**

Add immediately after `app.use('/api/v1/studio', studioRoutes);`:

```javascript
const studioExtRoutes = require('./controllers/studio/_extRoutes');
app.use('/api/v1/studio', studioExtRoutes);
```

- [ ] **Step 3: Verify syntax**

```bash
node --check index.js && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: register studioExtRoutes in index.js"
```

---

## Verification Tests

Run these against a live server with MongoDB + Redis running:

- [ ] **V1: Copy generation**

```bash
# Requires a valid assetId from your DB
curl -s -X POST http://localhost:5001/api/v1/studio/asset/ASSET_ID/copy \
  -H "Content-Type: application/json" \
  -b "qumak_session=SESSION_ID" \
  -d '{"platform":"instagram","adStructure":"problem → solution → CTA"}'
```

Expected: `captions` array (3 items), `headlines` (2), `ctas` (2), `hashtags` (10).
Word count check: `captions[0]` 80-120 words, `captions[2]` under 35 words.

- [ ] **V2: Refine generation**

```bash
curl -s -X POST http://localhost:5001/api/v1/studio/job/JOB_ID/refine \
  -H "Content-Type: application/json" \
  -b "qumak_session=SESSION_ID" \
  -d '{"instruction":"make it more luxury, less people"}'
```

Expected: `{ success: true, newJobId: "...", changes: "..." }`

- [ ] **V3: Share link creation and retrieval**

```bash
# Create share link
curl -s -X POST http://localhost:5001/api/v1/studio/asset/ASSET_ID/share \
  -b "qumak_session=SESSION_ID" | grep shareUrl

# Get share page (no auth — public)
curl -s http://localhost:5001/api/v1/studio/share/SHARE_CODE
```

Expected share page: `{ imageUrl, category, brandName, clickCTA }` — no auth cookie needed.

- [ ] **V4: Lead capture with UTM flow**

```bash
# Simulate UTM entry first
curl -s "http://localhost:5001/api/v1/studio/categories?utm_source=facebook&utm_campaign=gym_dubai" \
  -b "qumak_session=MY_SESSION"

# Capture lead
curl -s -X POST http://localhost:5001/api/v1/studio/lead/capture \
  -H "Content-Type: application/json" \
  -b "qumak_session=MY_SESSION" \
  -d '{"email":"test@example.com","source":"post_generation"}'
```

Check MongoDB: Lead record should have `utmSource: "facebook"` and `utmCampaign: "gym_dubai"`.

- [ ] **V5: Usage stats**

```bash
curl -s http://localhost:5001/api/v1/studio/usage -b "qumak_session=MY_SESSION"
```

Expected: `{ tier, usage: { imageHd, video }, limits, remaining, resetDate }`

- [ ] **V6: Admin stats (extended)**

```bash
curl -s http://localhost:5001/api/v1/studio/admin/stats \
  -H "Authorization: Bearer ADMIN_JWT"
```

Expected response includes: `avgRatingByCategory`, `shareClickRate`, `downloadRate`, `regenRateByCategory`, `leadsThisWeek`.

---

## Required .env additions

```env
# Anthropic (for copyService + promptRefiner)
ANTHROPIC_API_KEY=sk-ant-...

# Frontend URL (for share links)
CLIENT_URL=https://qumak.ae
```

---

## Self-Review

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| shareableLink schema | Task 1 | ✅ |
| studioAsset schema (create — not extend) | Task 1 | ✅ |
| lead schema with UTM fields | Task 2 | ✅ |
| adCopy schema | Task 2 | ✅ |
| adBrainFeedback schema | Task 2 | ✅ |
| studioUser schema (separate from user.js) | Task 3 | ✅ |
| copyService with Gulf market intelligence | Task 4 | ✅ |
| Platform-specific copy rules | Task 4 | ✅ |
| Hook formulas by category | Task 4 | ✅ |
| Gulf copy rules (no aggressive scarcity, AED, Ramadan) | Task 4 | ✅ |
| Emotional triggers by category | Task 4 | ✅ |
| 3 caption variants (80-120/50-70/20-30 words) | Task 4 | ✅ (enforced in system prompt) |
| Retry on JSON parse failure | Task 4 | ✅ |
| promptRefiner with mutation guide | Task 5 | ✅ |
| Mutation guide for all 8 instruction types | Task 5 | ✅ |
| shareService createShareLink (idempotent) | Task 6 | ✅ |
| shareService getShareData (increment views) | Task 6 | ✅ |
| shareService recordShareClick | Task 6 | ✅ |
| utmCapture middleware (Redis 24h TTL) | Task 7 | ✅ |
| getUtmData helper exported | Task 7 | ✅ |
| generateCopy controller | Task 8 | ✅ |
| refineGeneration (completed jobs only, new job + queue) | Task 8 | ✅ |
| createShareLink controller | Task 8 | ✅ |
| getSharePage PUBLIC endpoint | Task 8 | ✅ |
| recordShareClick PUBLIC endpoint | Task 8 | ✅ |
| captureLead (deduplicate, UTM attribution, referral bonus) | Task 8 | ✅ |
| rateAsset (1/-1, upsert feedback, update asset) | Task 8 | ✅ |
| trackDownload (downloadCount + downloadedAt) | Task 8 | ✅ |
| getUsageStats (tier limits, monthly usage) | Task 8 | ✅ |
| _extRoutes with utmCapture applied | Task 9 | ✅ |
| All routes mapped correctly | Task 9 | ✅ |
| adminStudioController extended (8 new queries) | Task 10 | ✅ |
| avgRatingByCategory aggregate | Task 10 | ✅ |
| regenRateByCategory | Task 10 | ✅ |
| leadsThisWeek + leadConversionRate | Task 10 | ✅ |
| shareClickRate + downloadRate | Task 10 | ✅ |
| index.js studioExtRoutes registration | Task 11 | ✅ |
