/**
 * aiBrandController.js
 * AI-powered brand generation for Perfume, Skincare Dropshipping, and Custom businesses.
 * Uses OpenAI gpt-4o-mini for cost efficiency with JSON mode for reliable parsing.
 * Built-in rate limiting (15 req/hr per IP) + backend-level LRU-style cache (1hr TTL).
 */
const BrandSubmission = require("../../model/schema/brandSubmission");
const BrandProject = require("../../model/schema/brandProject");
const OpenAI = require("openai");

let _client;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 2,
    });
  }
  return _client;
}

// ─── Backend cache (Map-based, 1hr TTL, max 500 entries) ────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 500;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

function hashInput(obj) {
  const str = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ─── Rate limiting (15 req/hr per IP) ───────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW = 60 * 60 * 1000;
const RATE_MAX = 15;

function isRateLimited(ip) {
  const now = Date.now();
  const times = (rateLimits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (times.length >= RATE_MAX) return true;
  times.push(now);
  rateLimits.set(ip, times);
  return false;
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildPerfumePrompt(inputs) {
  return `You are a luxury brand strategist specializing in Gulf and global niche fragrance markets.
Create a complete brand identity for a new perfume brand based on these inputs:

Brand name input: ${inputs.brandNameInput || "generate a memorable 1-2 word name"}
Fragrance family: ${inputs.fragranceFamily || inputs.vibe || "Oud & Wood"}
Strength: ${inputs.strength || "EDP (15-25%)"}
Character words: ${(inputs.character || []).join(", ") || "Dark, Warm, Mysterious"}
Scent vision: ${inputs.scentVision || "not specified"}
Inspiration fragrances: ${inputs.inspirationFragrances || "not specified"}
Gender: ${inputs.gender || "Unisex"}
Age group: ${inputs.ageGroup || "25-35"}
Price point: ${inputs.pricePoint || "Premium (AED 380-650)"}
Brand personality: ${(inputs.personality || []).join(", ") || "Elegant, Refined, Modern"}
Unique edge: ${inputs.uniqueEdge || "not specified"}
Competitor references: ${inputs.competitors || "not specified"}
Bottle shape: ${inputs.bottleShape || "Classic Rectangular"}
Bottle material: ${inputs.bottleMaterial || "Frosted Glass"}
Label finish: ${inputs.labelFinish || "Matte"}
Cap style: ${inputs.capStyle || "Magnetic Closure"}
Outer box: ${inputs.outerBox || "Rigid Luxury Box"}
Box exterior: ${inputs.boxExterior || "Matte Black"}

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "brandName": "1-2 word memorable name",
  "tagline": "5-8 word tagline, no cliches",
  "brandStory": "3 sentences written as if brand has 10 years of heritage",
  "brandVoice": ["adj1", "adj2", "adj3"],
  "customerPersona": "one precise sentence describing the exact buyer",
  "positioning": "one line defining the brand in the market",
  "colorPalette": {
    "primary": "#hexcode",
    "secondary": "#hexcode",
    "accent": "#hexcode",
    "background": "#hexcode",
    "primaryName": "name",
    "secondaryName": "name",
    "accentName": "name"
  },
  "fragranceNotes": {
    "top": "2-3 top notes description",
    "heart": "2-3 heart notes description",
    "base": "2-3 base notes description"
  },
  "bottleDescription": "2 sentences describing the bottle for a product listing",
  "targetAudience": {
    "primary": "one sentence describing the primary buyer",
    "age": "age range and context",
    "income": "income level and lifestyle",
    "location": "geographic focus",
    "interests": ["interest1", "interest2", "interest3", "interest4"],
    "painPoints": ["pain1", "pain2", "pain3"],
    "buyingTriggers": ["trigger1", "trigger2", "trigger3"],
    "channels": ["channel1", "channel2", "channel3"]
  },
  "marketingKit": {
    "instagramCaption": "150 char caption with emotion, no hashtags",
    "tiktokScript": "one sentence concept for a 15s TikTok",
    "adHeadline": "6-8 word headline for digital ads",
    "adBody": "2 sentences for an ad body copy",
    "emailSubject": "email subject line under 50 chars",
    "smsText": "SMS under 160 chars"
  },
  "instagramBio": "max 140 chars, no hashtags",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"],
  "videoScript": ["Scene 1: opening shot description (1 sentence)", "Scene 2: product reveal (1 sentence)", "Scene 3: emotion/benefit moment (1 sentence)", "Scene 4: brand close/CTA (1 sentence)"],
  "storeConceptDescription": "2 sentences describing an ideal physical store or popup",
  "ecommerceConceptDescription": "2 sentences describing the ideal online store aesthetic",
  "suggestedRetailPrice": "AED range for primary 50ml volume",
  "estimatedCOGS": "AED range cost of goods per unit",
  "estimatedMargin": "percentage margin",
  "supplierBrief": "2 sentences telling a fragrance supplier what to produce"
}`;
}

function buildCustomPrompt(inputs) {
  return `You are a brand strategist and identity expert. Create a complete brand identity for a new business.

Business name: ${inputs.brandNameInput || "generate a memorable 1-2 word name"}
Business description: ${inputs.businessDescription || "general consumer business"}
Category: ${inputs.category || "general"}

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "brandName": "1-2 word memorable name",
  "tagline": "5-8 word tagline, punchy and unique",
  "brandStory": "3 sentences written as if the brand has 5 years of heritage",
  "brandVoice": ["adj1", "adj2", "adj3"],
  "customerPersona": "one precise sentence describing the exact buyer",
  "positioning": "one line defining the brand in the market",
  "colorPalette": {
    "primary": "#hexcode",
    "secondary": "#hexcode",
    "accent": "#hexcode",
    "background": "#hexcode",
    "primaryName": "name",
    "secondaryName": "name",
    "accentName": "name"
  },
  "targetAudience": {
    "primary": "one sentence describing the primary buyer",
    "age": "age range and context",
    "income": "income level and lifestyle",
    "location": "geographic focus",
    "interests": ["interest1", "interest2", "interest3", "interest4"],
    "painPoints": ["pain1", "pain2", "pain3"],
    "buyingTriggers": ["trigger1", "trigger2", "trigger3"],
    "channels": ["channel1", "channel2", "channel3"]
  },
  "marketingKit": {
    "instagramCaption": "150 char caption with emotion, no hashtags",
    "tiktokScript": "one sentence concept for a 15s TikTok",
    "adHeadline": "6-8 word headline for digital ads",
    "adBody": "2 sentences for an ad body copy",
    "emailSubject": "email subject line under 50 chars",
    "smsText": "SMS under 160 chars"
  },
  "instagramBio": "max 140 chars, no hashtags",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"],
  "videoScript": ["Scene 1: opening hook (1 sentence)", "Scene 2: product/service showcase (1 sentence)", "Scene 3: customer transformation/benefit (1 sentence)", "Scene 4: brand close with CTA (1 sentence)"],
  "ecommerceConceptDescription": "2 sentences describing the ideal online presence for this brand",
  "estimatedStartupCost": "AED range to launch MVP",
  "estimatedMonthlyRevenue": "AED range realistic first-month revenue",
  "estimatedMargin": "percentage margin"
}`;
}

function buildSkincarePrompt(inputs) {
  return `You are a brand strategist specializing in skincare dropshipping for the UAE and GCC market.
Create a complete brand identity for a skincare dropshipping brand based on these inputs:

Brand name input: ${inputs.brandNameInput || "generate a clean, modern 1-2 word name"}
Product focus: ${(inputs.productTypes || []).join(", ") || "Serums and Moisturizers"}
Skin concerns targeted: ${(inputs.skinConcerns || []).join(", ") || "Anti-aging, Hydration"}
Skin types: ${(inputs.skinTypes || []).join(", ") || "All skin types"}
Key ingredients: ${(inputs.keyIngredients || []).join(", ") || "Hyaluronic acid, Niacinamide"}
Brand personality: ${(inputs.personality || []).join(", ") || "Clinical, Clean, Trustworthy"}
Gender: ${inputs.gender || "Female leaning"}
Age group: ${inputs.ageGroup || "25-40"}
Price tier: ${inputs.priceTier || "Mid-premium (AED 120-280 per product)"}
Dropship model: ${inputs.dropshipModel || "AliExpress / private label"}
Unique angle: ${inputs.uniqueAngle || "not specified"}
Competitors: ${inputs.competitors || "The Ordinary, Minimalist, CeraVe"}
Packaging style: ${inputs.packagingStyle || "Minimal clinical white"}

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "brandName": "1-2 word clean modern name",
  "tagline": "5-7 word tagline focused on skin transformation",
  "brandStory": "3 sentences — science meets nature, credible and aspirational",
  "brandVoice": ["adj1", "adj2", "adj3"],
  "customerPersona": "one precise sentence describing the exact buyer",
  "positioning": "one line — how this brand sits in the market",
  "colorPalette": {
    "primary": "#hexcode",
    "secondary": "#hexcode",
    "accent": "#hexcode",
    "background": "#hexcode",
    "primaryName": "name",
    "secondaryName": "name",
    "accentName": "name"
  },
  "heroProduct": {
    "name": "flagship product name",
    "description": "2 sentences selling this product",
    "keyBenefit": "one key benefit claim",
    "ingredients": ["ingredient1", "ingredient2", "ingredient3"]
  },
  "productLine": [
    {"name": "product 1", "type": "type", "price": "AED range"},
    {"name": "product 2", "type": "type", "price": "AED range"},
    {"name": "product 3", "type": "type", "price": "AED range"}
  ],
  "targetAudience": {
    "primary": "one sentence describing the primary buyer",
    "age": "age range and context",
    "income": "income level",
    "location": "geographic focus",
    "interests": ["interest1", "interest2", "interest3", "interest4"],
    "painPoints": ["pain1", "pain2", "pain3"],
    "buyingTriggers": ["trigger1", "trigger2", "trigger3"],
    "channels": ["channel1", "channel2", "channel3"]
  },
  "marketingKit": {
    "instagramCaption": "150 char caption showing transformation, no hashtags",
    "tiktokScript": "one sentence concept for a before/after TikTok",
    "adHeadline": "6-8 word headline for digital ads",
    "adBody": "2 sentences for an ad body copy",
    "emailSubject": "email subject line under 50 chars",
    "smsText": "SMS under 160 chars"
  },
  "instagramBio": "max 140 chars, no hashtags",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"],
  "videoScript": ["Scene 1: skin problem / before state (1 sentence)", "Scene 2: product application (1 sentence)", "Scene 3: visible transformation / after glow (1 sentence)", "Scene 4: brand close with CTA (1 sentence)"],
  "storeConceptDescription": "2 sentences describing an ideal popup or standalone store",
  "ecommerceConceptDescription": "2 sentences describing the ideal online store — clean, clinical, trustworthy",
  "dropshippingBrief": "2 sentences telling a dropship supplier what you need",
  "estimatedStartupCost": "AED range to launch MVP dropshipping store",
  "estimatedMonthlyRevenue": "AED range realistic first-month revenue at full launch",
  "estimatedMargin": "percentage margin after supplier cost and ads"
}`;
}

// ─── Main concept generation endpoint ────────────────────────────────────────

exports.generateBrandConcept = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({
        success: false,
        message: "Rate limit reached. Try again in an hour.",
      });
    }

    const { category, ...inputs } = req.body;

    if (!category) {
      return res
        .status(400)
        .json({ success: false, message: "category is required" });
    }

    const cacheKey = `brand_${category}_${hashInput(inputs)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ success: true, brand: cached, cached: true });
    }

    let prompt;
    if (category === "perfume") {
      prompt = buildPerfumePrompt(inputs);
    } else if (category === "skincare") {
      prompt = buildSkincarePrompt(inputs);
    } else {
      // food, clothing, tech, wellness, custom — use universal prompt
      prompt = buildCustomPrompt({ ...inputs, category });
    }

    const message = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1400,
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.choices[0]?.message?.content || "{}";
    const brand = JSON.parse(text);

    if (!brand.brandName) {
      throw new Error("AI returned incomplete brand data");
    }

    setCache(cacheKey, brand);

    // ── Log submission (async, non-blocking) ─────────────────────────────
    try {

      const sessionId =
        req.body.sessionId ||
        req.headers["x-session-id"] ||
        `anon_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let sub = await BrandSubmission.findOne({ sessionId });
      if (!sub) {
        sub = await BrandSubmission.create({
          sessionId,
          userId: req.user?._id,
          category,
          mode: "wizard",
          inputs,
          brand,
          email: req.user?.email,
          ipAddress:
            req.headers["x-forwarded-for"] || req.connection?.remoteAddress,
          userAgent: req.headers["user-agent"],
          utm: {
            source: req.body.utmSource,
            medium: req.body.utmMedium,
            campaign: req.body.utmCampaign,
            content: req.body.utmContent,
          },
          launchScore: 20,
        });
      } else {
        await BrandSubmission.updateOne(
          { sessionId },
          { $set: { brand, inputs } },
        );
      }
      return res.json({
        success: true,
        brand,
        submissionId: sub._id,
        sessionId,
      });
    } catch (logErr) {
      console.warn("[submission log]", logErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────

    return res.json({ success: true, brand });
  } catch (err) {
    console.error(
      "[aiBrandController] generateBrandConcept error:",
      err.message,
    );
    const isNetwork =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.message?.includes("fetch failed") ||
      err.message?.includes("connect");
    const msg = isNetwork
      ? "AI service temporarily unavailable. Please try again in a moment."
      : "Brand generation failed. Please try again.";
    return res.status(500).json({ success: false, message: msg });
  }
};

// ─── Quick auto-generate (minimal inputs, smart defaults) ────────────────────

exports.autoGenerateBrand = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip)) {
      return res
        .status(429)
        .json({
          success: false,
          message: "Rate limit reached. Try again in an hour.",
        });
    }

    const {
      category = "perfume",
      brandName,
      family,
      moods = [],
      gender = "Unisex",
      businessDescription,
    } = req.body;

    const cacheKey = `auto_${category}_${hashInput({ brandName, family, moods, gender, businessDescription })}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json({ success: true, brand: cached, cached: true });

    let prompt;
    if (category === "skincare") {
      const inputs = { brandNameInput: brandName, character: moods, gender };
      prompt = buildSkincarePrompt(inputs);
    } else if (category === "perfume") {
      const inputs = {
        brandNameInput: brandName,
        fragranceFamily: family,
        character: moods,
        gender,
        pricePoint: "Premium (AED 380-650)",
        personality: ["Elegant", "Refined", "Modern"],
        bottleShape: "Classic Rectangular",
        bottleMaterial: "Frosted Glass",
        labelFinish: "Matte",
        capStyle: "Magnetic Closure",
        outerBox: "Rigid Luxury Box",
        boxExterior: "Matte Black",
      };
      prompt = buildPerfumePrompt(inputs);
    } else {
      // food, clothing, tech, wellness, custom, or any other category
      prompt = buildCustomPrompt({
        brandNameInput: brandName,
        businessDescription,
        category,
      });
    }

    const message = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1200,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const brand = JSON.parse(message.choices[0]?.message?.content || "{}");
    if (!brand.brandName) throw new Error("Incomplete AI response");

    setCache(cacheKey, brand);

    // ── Log submission ────────────────────────────────────────────────────
    try {
      const sessionId =
        req.body.sessionId ||
        req.headers["x-session-id"] ||
        `anon_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let sub = await BrandSubmission.findOne({ sessionId });
      if (!sub) {
        sub = await BrandSubmission.create({
          sessionId,
          userId: req.user?._id,
          category,
          mode: "auto",
          inputs: req.body,
          brand,
          email: req.user?.email,
          ipAddress:
            req.headers["x-forwarded-for"] || req.connection?.remoteAddress,
          userAgent: req.headers["user-agent"],
          launchScore: 20,
        });
      } else {
        await BrandSubmission.updateOne({ sessionId }, { $set: { brand } });
      }
      return res.json({
        success: true,
        brand,
        submissionId: sub._id,
        sessionId,
      });
    } catch (logErr) {
      console.warn("[submission log]", logErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────

    return res.json({ success: true, brand });
  } catch (err) {
    console.error("[aiBrandController] autoGenerateBrand error:", err.message);
    const isNetwork =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.message?.includes("fetch failed") ||
      err.message?.includes("connect");
    const msg = isNetwork
      ? "AI service temporarily unavailable. Please try again in a moment."
      : "Auto-generation failed. Please try again.";
    return res.status(500).json({ success: false, message: msg });
  }
};

// ─── Social media post scheduling (infrastructure ready) ─────────────────────

exports.scheduleSocialPost = async (req, res) => {
  try {
    const { platform, caption, imageUrl, scheduledAt } = req.body;

    // TODO: Integrate platform SDKs when OAuth credentials are configured:
    // Instagram/Facebook: META_APP_ID, META_APP_SECRET + user access token
    // TikTok: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
    // LinkedIn: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET

    // For now: log the post intent and return queued status
    console.log(`[Social] Post queued for ${platform}:`, {
      caption: caption?.slice(0, 50),
      imageUrl: imageUrl?.slice(0, 60),
    });

    return res.json({
      success: true,
      status: "queued",
      message: `Post queued for ${platform}. Connect your ${platform} account to publish.`,
      platform,
      scheduledAt: scheduledAt || new Date().toISOString(),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Social post scheduling failed." });
  }
};

// ─── Save brand to DB (for logged-in users) ──────────────────────────────────

exports.saveBrand = async (req, res) => {
  try {
    const { brand, inputs, category } = req.body;
    const userId = req.user?._id;

    // Save to brandProject collection using existing model

    const VALID_TYPES = [
      "perfume",
      "skincare",
      "food",
      "clothing",
      "tech",
      "wellness",
      "consulting",
      "services",
      "trading",
      "manufacturing",
      "custom",
    ];
    const businessType = VALID_TYPES.includes(category) ? category : "custom";

    // Build category-specific config fields so admin views can display them
    const categoryConfig = {};
    if (businessType === "perfume") {
      categoryConfig.fragranceConfig = {
        brandName: brand.brandName,
        tagline: brand.tagline,
        scentProfile: brand.brandStory,
        family: inputs?.fragranceFamily || inputs?.family || "—",
      };
    } else if (businessType === "skincare") {
      categoryConfig.skincareConfig = {
        brandName: brand.brandName,
        tagline: brand.tagline,
        formulationType: inputs?.formulationType || "—",
      };
    } else {
      categoryConfig.customFields = [
        { key: "brandName", value: brand.brandName },
        { key: "tagline", value: brand.tagline },
        { key: "story", value: brand.brandStory },
        { key: "category", value: businessType },
      ];
    }

    const project = new BrandProject({
      user: userId,
      businessType,
      projectName: brand.brandName,
      wizardStep: 5,
      wizardCompleted: true,
      status: "configured",
      config: { brand, inputs },
      completionScore: 100,
      ...categoryConfig,
    });

    await project.save();

    return res.json({
      success: true,
      projectId: project._id,
      message: "Brand saved to your account.",
    });
  } catch (err) {
    console.error("[aiBrandController] saveBrand error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save brand." });
  }
};

// ─── Get saved brand project by ID (public — for shareable links) ────────────

exports.getBrandProject = async (req, res) => {
  try {
    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(req.params.id).lean();
    if (!project) {
      return res
        .status(404)
        .json({ success: false, message: "Brand project not found." });
    }
    return res.json({ success: true, project });
  } catch (err) {
    console.error("[aiBrandController] getBrandProject error:", err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Get all brands for logged-in user ─────────────────────────────────────────

exports.getUserBrands = async (req, res) => {
  try {
    const BrandProject = require("../../model/schema/brandProject");
    const userId = req.user?._id;
    if (!userId)
      return res
        .status(401)
        .json({ success: false, message: "Login required." });

    const brands = await BrandProject.find({
      user: userId,
      wizardCompleted: true,
    })
      .sort({ createdAt: -1 })
      .select("projectName businessType generatedBrand wizardData createdAt")
      .lean();

    const list = brands.map((b) => ({
      id: b._id,
      name: b.projectName,
      category: b.businessType,
      tagline: b.generatedBrand?.tagline || "",
      color: b.generatedBrand?.colorPalette?.primary || "#C9A227",
      createdAt: b.createdAt,
    }));

    return res.json({ success: true, brands: list });
  } catch (err) {
    console.error("[aiBrandController] getUserBrands error:", err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Image Generation (gpt-image-1) ─────────────────────────────────────────

async function generateWithGptImage1(prompt) {
  const cleanPrompt = prompt.replace(/\s+/g, " ").trim();

  const response = await getClient().images.generate({
    model: "gpt-image-1",
    prompt: cleanPrompt,
    n: 1,
    size: "1024x1024",
    quality: "high",
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) throw new Error("No image data in gpt-image-1 response");
  return `data:image/png;base64,${b64}`;
}

exports.generateMockupImage = async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "prompt is required" });
    }

    const dataUrl = await generateWithGptImage1(prompt);
    return res.json({ success: true, url: dataUrl, provider: "gpt-image-1" });
  } catch (err) {
    console.error("[generateMockupImage] error:", err.message);

    if (
      err.message?.includes("content_policy") ||
      err.message?.includes("safety")
    ) {
      return res.status(400).json({
        success: false,
        message: "Prompt flagged. Try regenerating.",
        code: "CONTENT_POLICY",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Image generation failed. " + (err.message || ""),
    });
  }
};

// ─── AI Image Edit (with optional reference image) ───────────────────────────

exports.editImage = async (req, res) => {
  try {
    const { prompt, referenceImage } = req.body;
    if (!prompt)
      return res
        .status(400)
        .json({ success: false, message: "prompt is required" });

    let dataUrl;

    if (referenceImage) {
      // Use gpt-image-1 edit mode with reference image
      const { toFile } = require("openai");
      const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const file = await toFile(buffer, "reference.png", { type: "image/png" });

      const response = await getClient().images.edit({
        model: "gpt-image-1",
        image: file,
        prompt: prompt.replace(/\s+/g, " ").trim(),
        n: 1,
        size: "1024x1024",
      });
      const b64 = response.data[0]?.b64_json;
      if (!b64) throw new Error("No image data from gpt-image-1 edit");
      dataUrl = `data:image/png;base64,${b64}`;
    } else {
      dataUrl = await generateWithGptImage1(prompt);
    }

    return res.json({
      success: true,
      url: dataUrl,
      provider: referenceImage ? "gpt-image-1-edit" : "gpt-image-1",
    });
  } catch (err) {
    console.error("[editImage]", err.message);
    if (
      err.message?.includes("content_policy") ||
      err.message?.includes("safety")
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Prompt flagged. Try a different description.",
          code: "CONTENT_POLICY",
        });
    }
    return res
      .status(500)
      .json({ success: false, message: "Image edit failed: " + err.message });
  }
};

// ─── Inquiry (Custom Business) ────────────────────────────────────────────────

exports.submitInquiry = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      businessType,
      targetMarket,
      budget,
      timeline,
      message,
    } = req.body;

    if (!name || !email || !phone || !businessType) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name, email, phone and businessType are required.",
        });
    }

    // Send WhatsApp notification if available
    try {
      const { sendWhatsappMessage } = require("../../utills/whatsAppMessage");
      await sendWhatsappMessage({
        to: process.env.ADMIN_WHATSAPP || process.env.ADMIN_PHONE,
        body: `New Brand Inquiry\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nBusiness: ${businessType}\nBudget: ${budget}\nTimeline: ${timeline}\n${message || ""}`,
      });
    } catch (_) {
      /* WhatsApp optional */
    }

    return res.json({
      success: true,
      message:
        "Inquiry received. We will contact you within 24 hours on WhatsApp.",
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to submit inquiry." });
  }
};

// ─── Lead capture / funnel tracking / PDF download ───────────────────────────

exports.captureEmail = async (req, res) => {
  try {
    const BrandSubmission = require("../../model/schema/brandSubmission");
    const { queueEmail } = require("../../services/emailService");
    const { email, phone, sessionId, brandName, category } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "email required" });

    let sub = sessionId ? await BrandSubmission.findOne({ sessionId }) : null;
    if (sub) {
      sub.email = email;
      if (phone) sub.phone = phone;
      await sub.save();
    } else {
      sub = await BrandSubmission.create({
        email,
        phone,
        sessionId,
        brandName,
        category,
      });
    }

    // Trigger 1hr follow-up email immediately (email1 slot)
    if (!sub.email1SentAt) {
      await queueEmail("brand_ready", email, {
        brandName: brandName || "Your Brand",
        submissionId: sub._id,
      });
      sub.email1SentAt = new Date();
      await sub.save();
    }

    return res.json({ success: true, submissionId: sub._id });
  } catch (err) {
    console.error("[captureEmail]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to capture email." });
  }
};

exports.trackEvent = async (req, res) => {
  try {
    const BrandSubmission = require("../../model/schema/brandSubmission");
    const { submissionId, sessionId, event, value } = req.body;
    if (!event)
      return res
        .status(400)
        .json({ success: false, message: "event required" });

    const query = submissionId
      ? { _id: submissionId }
      : sessionId
        ? { sessionId }
        : null;
    if (!query)
      return res
        .status(400)
        .json({
          success: false,
          message: "submissionId or sessionId required",
        });

    const sub = await BrandSubmission.findOne(query);
    if (!sub)
      return res
        .status(404)
        .json({ success: false, message: "submission not found" });

    const updates = {};
    const pushOps = {};
    if (event === "mockup_generated")
      updates.mockupsGenerated = (sub.mockupsGenerated || 0) + 1;
    if (event === "kit_downloaded") updates.downloadedKit = true;
    if (event === "social_connected") updates.connectedSocial = true;
    if (event === "license_started") updates.tradeLicenseCTA = true;
    if (event === "launch_score") updates.launchScore = value;
    if (event === "tab_visit" && value) pushOps.tabsVisited = value;
    if (event === "saved") updates.savedToAccount = true;

    const updateQuery = { $set: updates };
    if (Object.keys(pushOps).length) updateQuery.$addToSet = pushOps;
    await BrandSubmission.updateOne(query, updateQuery);
    return res.json({ success: true });
  } catch (err) {
    console.error("[trackEvent]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to track event." });
  }
};

exports.downloadPdf = async (req, res) => {
  try {
    const { generateBrandKitPDF } = require("../../services/pdfService");
    const { submissionId } = req.params;

    // POST /download-pdf/generate — no submissionId, generate from body
    if (submissionId === "generate") {
      const { brand, inputs } = req.body || {};
      if (!brand)
        return res
          .status(400)
          .json({ success: false, message: "brand is required" });

      let logoBase64 = null;
      try {
        const imageEngine = require("../../services/imagePromptPurifier");
        const brandContext = {
          brandName: brand.brandName,
          category: inputs?.category || "luxury",
          colorPalette: brand.colorPalette,
        };
        const logoResult = await imageEngine.generateLogoImage(
          brandContext,
          null,
        );
        logoBase64 = logoResult.base64 || null;
      } catch (e) {
        console.error("[downloadPdf] logo gen skipped:", e.message);
      }

      const pdfBuffer = await generateBrandKitPDF(brand, inputs || {}, {
        logoBase64,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${(brand.brandName || "brand-kit").replace(/\s+/g, "-")}-brand-kit.pdf"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.end(pdfBuffer);
    }

    const BrandSubmission = require("../../model/schema/brandSubmission");
    const BrandProject = require("../../model/schema/brandProject");

    let sub = await BrandSubmission.findById(submissionId);
    let brand = null;
    let projectDoc = null;
    let inputs = {};

    if (sub) {
      if (sub.brandProjectId) {
        projectDoc = await BrandProject.findById(sub.brandProjectId);
        brand = projectDoc?.config?.brand || null;
        inputs = projectDoc?.config?.inputs || {};
      }
      if (!brand && sub.brand) brand = sub.brand;
    } else {
      // Dashboard passes BrandProject id — submissions use a different collection
      projectDoc = await BrandProject.findById(submissionId);
      if (!projectDoc) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Brand project or submission not found",
          });
      }
      brand = projectDoc.config?.brand || null;
      inputs = projectDoc.config?.inputs || {};
      if (!brand) {
        return res
          .status(400)
          .json({
            success: false,
            message: "No brand data saved for this project yet.",
          });
      }
    }

    let logoBase64 = null;
    try {
      const imageEngine = require("../../services/imagePromptPurifier");
      const brandContext = {
        brandId: projectDoc?._id,
        brandName: brand?.brandName || "Brand",
        category: projectDoc?.businessType || "luxury",
        colorPalette: brand?.colorPalette,
      };
      const userId = req.user?._id || null;
      const logoResult = await imageEngine.generateLogoImage(
        brandContext,
        userId,
      );
      logoBase64 = logoResult.base64 || null;
    } catch (e) {
      console.error("[downloadPdf] logo gen skipped:", e.message);
    }

    const pdfBuffer = await generateBrandKitPDF(brand || {}, inputs, {
      logoBase64,
    });
    const safeName = (brand?.brandName || "brand-kit")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);

    if (sub) {
      await BrandSubmission.updateOne(
        { _id: submissionId },
        { $set: { kitDownloaded: true } },
      );
    }
  } catch (err) {
    console.error("[downloadPdf]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "PDF generation failed." });
  }
};

exports.unsubscribe = async (req, res) => {
  try {
    const BrandSubmission = require("../../model/schema/brandSubmission");
    const { id, token } = req.query;
    if (!id || !token) return res.status(400).send("Invalid unsubscribe link.");

    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", process.env.JWT_SECRET || "secret")
      .update(id)
      .digest("hex");
    if (token !== expected) return res.status(400).send("Invalid token.");

    await BrandSubmission.updateOne(
      { _id: id },
      { $set: { unsubscribed: true } },
    );
    res.send(
      '<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">You have been unsubscribed.</h2>',
    );
  } catch (err) {
    res.status(500).send("Error processing unsubscribe.");
  }
};

// ─── AI Cofounder Chat ───────────────────────────────────────────────────────

exports.cofounderChat = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip)) {
      return res
        .status(429)
        .json({ success: false, message: "Rate limit reached." });
    }

    const { message, brandData, history = [], mode = "chat" } = req.body;
    if (!message)
      return res
        .status(400)
        .json({ success: false, message: "message is required" });

    const brandContext = brandData
      ? `
BRAND CONTEXT:
- Brand: ${brandData.brandName || "Not set"}
- Tagline: ${brandData.tagline || "Not set"}
- Category: ${brandData.category || "general"}
- Target Audience: ${brandData.targetAudience?.primary || "Not defined"}
- Positioning: ${brandData.positioning || "Not set"}
- Location: ${brandData.targetAudience?.location || "UAE"}
- Monthly Revenue Est: ${brandData.estimatedMonthlyRevenue || "Unknown"}
- Startup Cost: ${brandData.estimatedStartupCost || "Unknown"}
`
      : "";

    let systemPrompt;
    if (mode === "roast") {
      systemPrompt = `You are Qumak Cofounder — a brutally honest but constructive startup advisor for UAE businesses. 
The founder is asking you to roast their business idea. Be direct, identify weaknesses, market risks, competition threats, 
and pricing problems. End with 2-3 specific actionable fixes. Use numbers and market data when possible. 
Keep it under 300 words. Be tough but fair — you want them to succeed.
${brandContext}`;
    } else if (mode === "roadmap") {
      systemPrompt = `You are Qumak Cofounder — an expert growth strategist for UAE startups.
Generate a detailed 90-day launch roadmap with specific weekly milestones, budget allocations, and KPIs.
Include: pre-launch (weeks 1-2), soft launch (weeks 3-4), growth phase (weeks 5-8), scale phase (weeks 9-12).
Each week should have 2-3 specific tasks with estimated costs in AED. End with month-3 revenue target.
${brandContext}`;
    } else if (mode === "ads") {
      systemPrompt = `You are Qumak Cofounder — a paid advertising strategist specializing in UAE/GCC markets.
Calculate the ad spend needed to reach the target audience. Include:
- Platform recommendations (Meta, Google, TikTok) with % budget split
- CPM estimates for UAE market per platform
- Expected CTR, CPC, and conversion rates
- Daily/monthly budget recommendations for 3 tiers (starter, growth, scale)
- ROAS expectations and break-even timeline
- Specific audience targeting recommendations
All numbers in AED. Be precise with calculations.
${brandContext}`;
    } else {
      systemPrompt = `You are Qumak Cofounder — an AI business partner for UAE entrepreneurs using the Qumak brand builder platform.
You know the founder's brand deeply and give strategic, actionable advice. You're direct, practical, and data-driven.
Cover: marketing strategy, pricing, audience targeting, content ideas, growth tactics, competitor analysis, 
and UAE-specific regulations when relevant. Keep responses concise (under 250 words) with clear action items.
If the founder hasn't built their brand yet, help them clarify their vision and pick the right business activity.
${brandContext}`;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 800,
      temperature: 0.8,
      messages,
    });

    const reply =
      completion.choices[0]?.message?.content ||
      "I need more context to help you.";
    return res.json({ success: true, reply, mode });
  } catch (err) {
    console.error("[cofounderChat]", err.message);
    return res
      .status(500)
      .json({
        success: false,
        message: "Cofounder AI temporarily unavailable.",
      });
  }
};

// ─── Generate business-specific templates (like nas.io) ──────────────────────

exports.generateTemplates = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip)) {
      return res
        .status(429)
        .json({ success: false, message: "Rate limit reached." });
    }

    const { brandData, category, activity } = req.body;
    if (!brandData?.brandName)
      return res
        .status(400)
        .json({ success: false, message: "brandData with brandName required" });

    const cacheKey = `tpl_${category}_${hashInput({ brandName: brandData.brandName, activity })}`;
    const cached = getCached(cacheKey);
    if (cached)
      return res.json({ success: true, templates: cached, cached: true });

    const prompt = `You are a business template generator for UAE entrepreneurs.
Generate 8 ready-to-use business templates for this brand:
Brand: ${brandData.brandName}
Category: ${category || "general"}
Activity: ${activity || "general business"}
Tagline: ${brandData.tagline || ""}
Target: ${brandData.targetAudience?.primary || "UAE consumers"}

Create templates across these types: Physical Product, Digital File, Challenge, Event, Membership, 1:1 Session, Online Course, Workshop.
Each template should be specific to this exact business — not generic.

Respond ONLY with valid JSON array:
[
  {
    "type": "Physical Product|Digital File|Challenge|Event|Membership|1:1 Session|Online Course|Workshop",
    "title": "specific template title",
    "description": "2 sentences describing the template",
    "suggestedPrice": "AED XX.XX",
    "platform": "Instagram|Website|WhatsApp|TikTok|Marketplace",
    "effort": "Low|Medium|High",
    "revenueType": "one-time|recurring|per-session"
  }
]`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1000,
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = completion.choices[0]?.message?.content || '{"templates":[]}';
    const parsed = JSON.parse(text);
    const templates = Array.isArray(parsed) ? parsed : parsed.templates || [];

    setCache(cacheKey, templates);
    return res.json({ success: true, templates });
  } catch (err) {
    console.error("[generateTemplates]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Template generation failed." });
  }
};

// ─── Detect activity from description using AI ──────────────────────────────

exports.detectActivity = async (req, res) => {
  try {
    const { description } = req.body;
    if (!description)
      return res
        .status(400)
        .json({ success: false, message: "description required" });

    const fs = require("fs");
    const path = require("path");
    const activitiesPath = path.join(
      __dirname,
      "../../assets/activities_names.txt",
    );
    let activities = [];
    try {
      const raw = fs.readFileSync(activitiesPath, "utf-8");
      activities = raw
        .split("\n")
        .filter((l) => l.trim() && l !== "Activity Name")
        .slice(0, 200);
    } catch {
      /* file not found */
    }

    const prompt = `Given this business description: "${description}"
And this sample list of UAE business activities:
${activities.join("\n")}

Return JSON with:
{
  "detectedActivity": "the most matching activity name from the list or a new one",
  "category": "perfume|skincare|food|clothing|tech|wellness|consulting|services|trading|manufacturing|other",
  "sector": "short sector label",
  "isProduct": true/false,
  "isService": true/false,
  "suggestedActivities": ["top 3 matching activities from the list"],
  "licenseType": "Commercial|Professional|Industrial|Freelance",
  "estimatedSetupCost": "AED range"
}`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[detectActivity]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Activity detection failed." });
  }
};

// ─── Trade License Application ─────────────────────────────────────────────────

exports.submitLicenseApplication = async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      passportNumber,
      emiratesId,
      hasResidenceVisa,
      companyName,
      packageType,
      numberOfVisas,
      officeType,
      brandName,
      brandCategory,
      notes,
    } = req.body;

    if (!fullName || !email || !phone || !companyName) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Full name, email, phone, and company name are required.",
        });
    }

    // Use the existing application model or create inline
    const mongoose = require("mongoose");

    // Check if LicenseApplication model already exists
    let LicenseApplication;
    try {
      LicenseApplication = mongoose.model("LicenseApplication");
    } catch {
      const schema = new mongoose.Schema({
        fullName: { type: String, required: true },
        email: { type: String, required: true },
        phone: { type: String, required: true },
        passportNumber: String,
        emiratesId: String,
        hasResidenceVisa: { type: Boolean, default: false },
        companyName: { type: String, required: true },
        packageType: {
          type: String,
          enum: ["starter", "growth", "premium"],
          default: "starter",
        },
        numberOfVisas: { type: Number, default: 1 },
        officeType: {
          type: String,
          enum: ["flexi-desk", "dedicated-office", "warehouse", "virtual"],
          default: "flexi-desk",
        },
        brandName: String,
        brandCategory: String,
        notes: String,
        status: {
          type: String,
          enum: ["pending", "reviewing", "approved", "rejected", "processing"],
          default: "pending",
        },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      });
      LicenseApplication = mongoose.model("LicenseApplication", schema);
    }

    const application = new LicenseApplication({
      fullName,
      email,
      phone,
      passportNumber,
      emiratesId,
      hasResidenceVisa,
      companyName,
      packageType,
      numberOfVisas,
      officeType,
      brandName,
      brandCategory,
      notes,
      user: req.user?._id,
    });

    await application.save();

    return res.json({
      success: true,
      applicationId: application._id,
      message: "License application submitted successfully.",
    });
  } catch (err) {
    console.error(
      "[aiBrandController] submitLicenseApplication error:",
      err.message,
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to submit application." });
  }
};

// ─── Get License Applications (for AmerDashboard) ──────────────────────────────

exports.getLicenseApplications = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    let LicenseApplication;
    try {
      LicenseApplication = mongoose.model("LicenseApplication");
    } catch {
      return res.json({ success: true, applications: [] });
    }

    const applications = await LicenseApplication.find()
      .sort({ createdAt: -1 })
      .populate("user", "name email")
      .lean();

    return res.json({ success: true, applications });
  } catch (err) {
    console.error(
      "[aiBrandController] getLicenseApplications error:",
      err.message,
    );
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── AI Research Pipeline ──────────────────────────────────────────────────────
// Runs ONCE per brand. Generates businessProfile with real UAE market data.
// Everything downstream (stats, suppliers, audience, costs) reads from this.

exports.researchBusiness = async (req, res) => {
  try {
    const { brandProjectId } = req.body;
    if (!brandProjectId)
      return res
        .status(400)
        .json({ success: false, message: "brandProjectId required." });

    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(brandProjectId);
    if (!project)
      return res
        .status(404)
        .json({ success: false, message: "Project not found." });

    if (project.businessProfile?.aiResearchCompletedAt) {
      return res.json({
        success: true,
        businessProfile: project.businessProfile,
        cached: true,
      });
    }

    const brand = project.config?.brand || {};
    const inputs = project.config?.inputs || {};
    const category = project.businessType || inputs.category || "custom";
    const brandName = project.projectName || brand.brandName || "Unnamed";
    const description =
      inputs.description || brand.positioning || brand.tagline || "";
    const positioning = brand.positioning || "";

    const prompt = `You are a UAE business analyst with deep knowledge of the Dubai and wider UAE market.
The user has created a brand called "${brandName}" in the category "${category}"
with the description: "${description}"
Their positioning is: "${positioning}"

Research and return ACCURATE, SPECIFIC data for this EXACT type of business in UAE.
Do NOT use generic startup data. Think about what THIS specific business actually needs.

For a used car dealership, think: What does it actually cost to open in UAE? What are the real inventory sources? What margins do dealers make? Where does their customer actually find them (Dubizzle? Google? Showroom walk-ins?)

For a perfume brand: fragrance houses, bottle suppliers, filling services in Ajman/Sharjah.
For consulting: no physical suppliers, focus on networking platforms, LinkedIn, co-working.
For food: Dubai Municipality licensing, wholesale markets, delivery platforms.

Return ONLY valid JSON. No markdown. No backticks. No preamble.

{
  "businessType": "descriptive_slug",
  "sector": "sector_name",
  "financials": {
    "estimatedMonthlyRevenueLow": number_in_AED,
    "estimatedMonthlyRevenueHigh": number_in_AED,
    "estimatedStartupCostLow": number_in_AED,
    "estimatedStartupCostHigh": number_in_AED,
    "estimatedMarginPercent": number,
    "revenueModelExplanation": "How this business actually makes money in UAE",
    "researchBasis": "Based on UAE [relevant] market 2024-2025"
  },
  "suppliers": [
    {
      "name": "Specific real company/platform name",
      "type": "inventory_source|supplier|marketplace|platform|service_provider|wholesaler",
      "location": "Specific UAE location or Online",
      "relevance": "Why this matters for this business",
      "contactType": "website|whatsapp|walk_in|registration|phone",
      "contactValue": "actual URL if known, otherwise leave empty",
      "estimatedCost": "realistic cost range in AED"
    }
  ],
  "audiencePlatforms": {
    "instagram": 0-100,
    "tiktok": 0-100,
    "google": 0-100,
    "linkedin": 0-100,
    "snapchat": 0-100,
    "youtube": 0-100,
    "dubizzle": 0-100
  },
  "startupChecklist": [
    { "item": "Specific action item", "cost": "AED X,XXX - AED Y,YYY", "priority": "immediate|week1|month1" }
  ]
}

Give 5-8 suppliers, 5-7 cost checklist items, realistic platform scores. All financial numbers must be realistic for UAE market.`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res
        .status(500)
        .json({
          success: false,
          message: "AI returned invalid data. Try again.",
        });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    project.businessProfile = {
      businessType: parsed.businessType,
      sector: parsed.sector,
      financials: parsed.financials,
      suppliers: (parsed.suppliers || []).map((s) => ({
        name: s.name,
        type: s.type,
        location: s.location,
        relevance: s.relevance,
        contactType: s.contactType || "website",
        contactValue: s.contactValue || "",
        estimatedCost: s.estimatedCost || "",
      })),
      audiencePlatforms: parsed.audiencePlatforms || {},
      startupChecklist: (parsed.startupChecklist || []).map((c) => ({
        item: c.item,
        cost: c.cost,
        priority: c.priority || "month1",
      })),
      aiResearchCompletedAt: new Date(),
      aiResearchModel: "gpt-4o-mini",
    };

    await project.save();
    return res.json({
      success: true,
      businessProfile: project.businessProfile,
      cached: false,
    });
  } catch (err) {
    console.error("[researchBusiness]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Research failed. " + err.message });
  }
};

// ─── Generate Content Calendar (30 posts for a brand) ──────────────────────────

exports.generateContentCalendar = async (req, res) => {
  try {
    const { brandProjectId } = req.body;
    if (!brandProjectId)
      return res
        .status(400)
        .json({ success: false, message: "brandProjectId required." });

    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(brandProjectId);
    if (!project)
      return res
        .status(404)
        .json({ success: false, message: "Project not found." });

    if (project.contentCalendar && project.contentCalendar.length >= 20) {
      return res.json({
        success: true,
        calendar: project.contentCalendar,
        cached: true,
      });
    }

    const brand = project.config?.brand || {};
    const category = project.businessType || "custom";
    const brandName = project.projectName || brand.brandName || "Brand";

    const prompt = `Generate a 30-day social media content calendar for "${brandName}", a ${category} business in UAE.
Return ONLY valid JSON array. No markdown. No backticks.

Each item: { "dayNumber": 1-30, "platform": "instagram|tiktok|facebook|linkedin", "contentType": "launch|story|product|hook|qa|cta|testimonial|carousel|behind_scenes|tips|lifestyle|community|milestone|recap", "caption": "full ready-to-post caption text", "hashtags": ["#tag1","#tag2"], "hook": "first 3 seconds text for TikTok only, empty for others" }

Rules:
- Mix platforms: ~40% Instagram, ~25% TikTok, ~20% Facebook, ~15% LinkedIn
- Week 1: launch/announcement content, build hype
- Week 2: product/value focused, establish authority
- Week 3: engagement/community, testimonials, Q&A
- Week 4: CTA/conversion, recap, milestone celebration
- Each caption must be specific to "${brandName}" and ${category}
- Include relevant UAE-market hashtags
- TikTok entries must have a hook field (the attention-grabbing first line)
- Schedule 4-5 posts per week (not every day)
- Skip some days to feel natural

Return array of 16-20 items (not all 30 days need posts).`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 3000,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content || "";
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      return res
        .status(500)
        .json({
          success: false,
          message: "AI returned invalid calendar data.",
        });
    }

    const items = JSON.parse(arrayMatch[0]);
    project.contentCalendar = items.map((item) => ({
      dayNumber: item.dayNumber,
      platform: item.platform,
      contentType: item.contentType,
      caption: item.caption,
      hashtags: item.hashtags || [],
      hook: item.hook || "",
      status: "draft",
    }));

    await project.save();
    return res.json({
      success: true,
      calendar: project.contentCalendar,
      cached: false,
    });
  } catch (err) {
    console.error("[generateContentCalendar]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Calendar generation failed." });
  }
};

// ─── Update a single content calendar item ─────────────────────────────────────

exports.updateCalendarItem = async (req, res) => {
  try {
    const {
      brandProjectId,
      dayNumber,
      caption,
      hashtags,
      status,
      scheduledAt,
    } = req.body;
    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(brandProjectId);
    if (!project)
      return res.status(404).json({ success: false, message: "Not found." });

    const item = project.contentCalendar.find((c) => c.dayNumber === dayNumber);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Calendar item not found." });

    if (caption !== undefined) item.caption = caption;
    if (hashtags !== undefined) item.hashtags = hashtags;
    if (status !== undefined) item.status = status;
    if (scheduledAt !== undefined) item.scheduledAt = scheduledAt;

    await project.save();

    // If status changed to 'scheduled' and zapier webhook exists, fire it
    if (status === "scheduled" && project.zapierWebhookUrl) {
      try {
        const fetch = require("node-fetch");
        await fetch(project.zapierWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caption: item.caption,
            hashtags: (item.hashtags || []).join(" "),
            platform: item.platform,
            scheduledAt: item.scheduledAt,
            brandName: project.projectName,
            contentType: item.contentType,
          }),
        });
      } catch (webhookErr) {
        console.error("[zapier webhook]", webhookErr.message);
      }
    }

    return res.json({ success: true, item });
  } catch (err) {
    console.error("[updateCalendarItem]", err.message);
    return res.status(500).json({ success: false, message: "Update failed." });
  }
};

// ─── Save Zapier webhook URL ───────────────────────────────────────────────────

exports.saveZapierWebhook = async (req, res) => {
  try {
    const { brandProjectId, webhookUrl } = req.body;
    const BrandProject = require("../../model/schema/brandProject");
    await BrandProject.findByIdAndUpdate(brandProjectId, {
      zapierWebhookUrl: webhookUrl,
    });
    return res.json({ success: true });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to save webhook." });
  }
};

// ─── Research Competitors ─────────────────────────────────────────────────────

exports.researchCompetitors = async (req, res) => {
  try {
    const {
      brandProjectId,
      brand: brandFallback,
      category: catFallback,
    } = req.body;

    let brand = brandFallback || {};
    let category = catFallback || "general";
    let brandName = brand.brandName || "Unnamed";
    let project = null;

    // Try to load from DB if projectId given
    if (brandProjectId && brandProjectId.match(/^[0-9a-f]{24}$/i)) {
      const BrandProject = require("../../model/schema/brandProject");
      project = await BrandProject.findById(brandProjectId);
      if (project) {
        if (project.businessProfile?.competitors?.length > 0) {
          return res.json({
            success: true,
            competitors: project.businessProfile.competitors,
            usp: project.businessProfile.usp,
            kpis: project.businessProfile.kpis,
            estimatedDailyAdSpend:
              project.businessProfile.estimatedDailyAdSpend,
            cached: true,
          });
        }
        const cfg = project.config?.brand || {};
        const inp = project.config?.inputs || {};
        category =
          project.businessType || inp.category || catFallback || "general";
        brandName = project.projectName || cfg.brandName || brandName;
        brand = { ...cfg, ...brandFallback };
      }
    }

    const description = brand.positioning || brand.tagline || "";

    const prompt = `You are a senior UAE competitive intelligence analyst with access to market data. Research the competitive landscape for "${brandName}" (${description}) in the "${category}" sector in UAE/Dubai.

Return ONLY valid JSON. No markdown. No backticks. No preamble.

{
  "competitors": [
    {
      "name": "Real competitor brand name in UAE",
      "location": "Dubai/Abu Dhabi/Sharjah etc.",
      "website": "https://actual-website.com",
      "instagram": "@instagramhandle",
      "instagramFollowers": "125K",
      "tiktok": "@tiktokhandle",
      "tiktokFollowers": "45K",
      "logoUrl": "https://logo.clearbit.com/domain.com",
      "estimatedMonthlyRevenue": "AED X,XXX - X,XXX",
      "estimatedMonthlyTraffic": "15K - 25K visits",
      "estimatedAdSpendMonthly": "AED X,XXX",
      "estimatedAdSpendDaily": "AED XX - XXX",
      "adPlatforms": ["Instagram Ads", "Google Ads", "TikTok Ads"],
      "targetDemographic": "Women 25-38, UAE residents, mid-high income",
      "targetLocations": ["Dubai", "Abu Dhabi", "Sharjah"],
      "priceRange": "AED XX - AED XXX",
      "topSellingProducts": ["Product 1", "Product 2"],
      "contentStrategy": "Brief description of their content approach",
      "strengths": "What they do well - be specific",
      "weaknesses": "Where they fall short - be specific and actionable",
      "threatLevel": "high/medium/low"
    }
  ],
  "marketOverview": {
    "totalMarketSize": "AED X billion",
    "growthRate": "X% annually",
    "topTrends": ["Trend 1", "Trend 2", "Trend 3"],
    "entryBarriers": "Low/Medium/High - brief explanation",
    "seasonalPeaks": ["Ramadan", "Eid", "DSF"]
  },
  "usp": [
    "Specific USP suggestion 1 for ${brandName} to differentiate",
    "Specific USP suggestion 2",
    "Specific USP suggestion 3"
  ],
  "kpis": [
    { "label": "Monthly Revenue Target", "value": "AED X,XXX", "target": "AED X,XXX+", "unit": "AED" },
    { "label": "Daily Ad Spend Budget", "value": "AED XX", "target": "AED XXX", "unit": "AED" },
    { "label": "Customer Acquisition Cost", "value": "AED XX", "target": "< AED XX", "unit": "AED" },
    { "label": "Social Followers (3 months)", "value": "0", "target": "5,000+", "unit": "" },
    { "label": "Monthly Orders Target", "value": "0", "target": "100+", "unit": "" }
  ],
  "estimatedDailyAdSpend": "AED XX - XX",
  "competitorTotalMonthlyAdSpend": "AED X,XXX combined"
}

IMPORTANT: Give 3-5 REAL competitors in this ${category} space in UAE. Use their actual website domains, actual Instagram handles, actual TikTok handles. For logoUrl, use https://logo.clearbit.com/THEIR_DOMAIN.com format. Be specific about demographics, pricing, and product lines. All financial estimates must be realistic for UAE market.`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 3000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      return res
        .status(500)
        .json({ success: false, message: "AI returned invalid data." });

    const parsed = JSON.parse(jsonMatch[0]);

    if (project) {
      if (!project.businessProfile) project.businessProfile = {};
      project.businessProfile.competitors = parsed.competitors || [];
      project.businessProfile.usp = parsed.usp || [];
      project.businessProfile.kpis = parsed.kpis || [];
      project.businessProfile.marketOverview = parsed.marketOverview || {};
      project.businessProfile.estimatedDailyAdSpend =
        parsed.estimatedDailyAdSpend || "";
      project.businessProfile.competitorTotalMonthlyAdSpend =
        parsed.competitorTotalMonthlyAdSpend || "";
      project.markModified("businessProfile");
      await project.save();
    }

    return res.json({
      success: true,
      competitors: parsed.competitors,
      usp: parsed.usp,
      kpis: parsed.kpis,
      marketOverview: parsed.marketOverview,
      estimatedDailyAdSpend: parsed.estimatedDailyAdSpend,
      competitorTotalMonthlyAdSpend: parsed.competitorTotalMonthlyAdSpend,
      cached: false,
    });
  } catch (err) {
    console.error("[researchCompetitors]", err.message);
    return res
      .status(500)
      .json({
        success: false,
        message: "Competitor research failed: " + err.message,
      });
  }
};

// ─── Save Generated Image to DB ───────────────────────────────────────────────

exports.saveGeneratedImage = async (req, res) => {
  try {
    const { brandProjectId, imageUrl, prompt, type } = req.body;
    if (!brandProjectId || !imageUrl)
      return res
        .status(400)
        .json({
          success: false,
          message: "brandProjectId and imageUrl required.",
        });

    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(brandProjectId);
    if (!project)
      return res
        .status(404)
        .json({ success: false, message: "Project not found." });

    if (!project.generatedImages) project.generatedImages = [];
    project.generatedImages.push({
      url: imageUrl,
      prompt: prompt || "",
      type: type || "visual",
      createdAt: new Date(),
    });
    project.markModified("generatedImages");
    await project.save();

    return res.json({ success: true, images: project.generatedImages });
  } catch (err) {
    console.error("[saveGeneratedImage]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save image." });
  }
};

// ─── Get Saved Images for a Brand ────────────────────────────────────────────

exports.getGeneratedImages = async (req, res) => {
  try {
    const { id } = req.params;
    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(id).select(
      "generatedImages projectName",
    );
    if (!project)
      return res.status(404).json({ success: false, message: "Not found." });
    return res.json({ success: true, images: project.generatedImages || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Email + Download Brand Kit ───────────────────────────────────────────────

exports.emailAndDownloadKit = async (req, res) => {
  try {
    const { brandProjectId, email, kitType } = req.body;
    if (!brandProjectId || !email)
      return res
        .status(400)
        .json({
          success: false,
          message: "brandProjectId and email are required.",
        });

    const BrandProject = require("../../model/schema/brandProject");
    const project = await BrandProject.findById(brandProjectId);
    if (!project)
      return res
        .status(404)
        .json({ success: false, message: "Brand not found." });

    // Save email to project if not already stored
    if (!project.kitDownloadEmails) project.kitDownloadEmails = [];
    if (!project.kitDownloadEmails.includes(email)) {
      project.kitDownloadEmails.push(email);
      await project.save();
    }

    // Send email via SendGrid
    try {
      const sgMail = require("@sendgrid/mail");
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const brand = project.config?.brand || {};
      const brandName = project.projectName || brand.brandName || "Your Brand";

      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM_EMAIL || "hello@qumak.io",
        subject: `Your ${brandName} Brand Kit is Ready`,
        html: `
          <div style="font-family: DM Sans, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; background: #FAFAF8;">
            <div style="text-align: center; margin-bottom: 32px;">
              <span style="font-size: 28px; font-weight: 600; color: #C9A227;">Qumak</span>
            </div>
            <h1 style="font-size: 22px; color: #1A1A1A; margin-bottom: 8px;">Your Brand Kit is Ready</h1>
            <p style="color: #6B6B6B; font-size: 14px; margin-bottom: 24px;">
              Hi there! Your ${brandName} ${kitType || "Brand Kit"} has been generated and is ready to download.
            </p>
            <div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
              <h2 style="font-size: 16px; color: #1A1A1A; margin-bottom: 12px;">${brandName} Brand Assets</h2>
              <p style="color: #6B6B6B; font-size: 13px;">Your complete brand kit includes logo direction, color palette, typography, brand story, target audience, ad copy, and social media captions.</p>
            </div>
            <div style="text-align: center;">
              <a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/brand-dashboard?id=${brandProjectId}&tab=kit" 
                 style="display: inline-block; background: #C9A227; color: #fff; padding: 14px 32px; border-radius: 100px; text-decoration: none; font-size: 14px; font-weight: 500;">
                View Your Brand Kit
              </a>
            </div>
            <p style="color: #9CA3AF; font-size: 11px; text-align: center; margin-top: 32px;">
              Powered by Qumak — AI Brand Builder for UAE Founders
            </p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("[emailKit] SendGrid error:", emailErr.message);
      // Don't fail the request if email fails — still return success for download
    }

    return res.json({
      success: true,
      message: "Email sent and kit access granted.",
      projectId: brandProjectId,
    });
  } catch (err) {
    console.error("[emailAndDownloadKit]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Social Content Strategy ─────────────────────────────────────────────────
exports.generateSocialStrategy = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip))
      return res
        .status(429)
        .json({ success: false, message: "Rate limit reached." });

    const { brand, goal, audience } = req.body;
    if (!brand || !goal || !audience) {
      return res
        .status(400)
        .json({
          success: false,
          message: "brand, goal, and audience are required.",
        });
    }

    const cacheKey = hashInput({ bn: brand.brandName, goal, audience });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ success: true, strategy: cached });

    const prompt = `You are a growth marketing strategist for a startup. Generate a social media content strategy.

Brand: ${brand.brandName}
Tagline: ${brand.tagline || ""}
Category: ${brand.category || "general"}
Positioning: ${brand.positioning || ""}
Target Audience: ${brand.targetAudience?.primary || audience}
Founder Goal: ${goal}
Target ICP: ${audience}

Respond ONLY with valid JSON:
{
  "approach": "2-3 sentences describing the overall strategy and tone. Be specific to the brand and goal.",
  "posts": [
    {
      "platform": "LinkedIn",
      "hook": "Short provocative hook line",
      "copy": "Full post copy (150-300 words, founder-to-founder tone, specific to the brand)"
    },
    {
      "platform": "Instagram",
      "hook": "Attention-grabbing opening",
      "copy": "Caption with storytelling, 120-180 chars + 5 relevant hashtags"
    },
    {
      "platform": "X / Twitter",
      "hook": "Thread opener",
      "copy": "280 char tweet or thread start. Punchy, no filler."
    },
    {
      "platform": "Reddit",
      "hook": "Community-native headline",
      "copy": "Genuine Reddit post — value-first, no hard sell, 200-250 words"
    }
  ],
  "cta": "Specific, measurable call-to-action aligned with the goal"
}`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.75,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0].message.content || "{}";
    const strategy = JSON.parse(raw);
    setCache(cacheKey, strategy);

    return res.json({ success: true, strategy });
  } catch (err) {
    console.error("[generateSocialStrategy]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Strategy generation failed." });
  }
};

// ─── Research Suppliers (China / Global) ─────────────────────────────────────
exports.researchSuppliers = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip))
      return res
        .status(429)
        .json({ success: false, message: "Rate limit reached." });

    const { brand, category, brandProjectId } = req.body;
    if (!brand && !category)
      return res
        .status(400)
        .json({ success: false, message: "brand or category required." });

    const cacheKey = hashInput({
      cat: category || brand?.category,
      bn: brand?.brandName,
    });
    const cached = getCached(cacheKey);
    if (cached)
      return res.json({ success: true, suppliers: cached, cached: true });

    const brandName = brand?.brandName || "Brand";
    const brandCat = category || brand?.category || "custom";
    const isProduct =
      /perfume|fragrance|skincare|clothing|textile|product|physic/i.test(
        brandCat,
      );

    const prompt = `You are a global sourcing expert helping a UAE-based brand find the best suppliers.

Brand: ${brandName}
Category: ${brandCat}
Business type: ${isProduct ? "Physical product (needs manufacturing/sourcing)" : "Service or digital"}

Research and list 6–8 of the BEST real suppliers, manufacturers, or service providers for this business. Focus on:
- For product brands: China/Asia manufacturers (Alibaba, 1688, Made-in-China), Middle East distributors
- For service brands: SaaS tools, platform partners, UAE service providers
- Include realistic MOQ, pricing, and margin data

Return ONLY valid JSON. No markdown.

{
  "suppliers": [
    {
      "name": "Real supplier/manufacturer name",
      "country": "China|India|UAE|Turkey|etc.",
      "type": "manufacturer|distributor|platform|service",
      "platform": "Alibaba|1688|Made-in-China|Direct|etc.",
      "contactUrl": "https://actual-url.com",
      "whatsapp": "+XX XXXX XXXXXX or empty",
      "moq": "Minimum 100 units / $500 minimum order",
      "priceRange": "$X.XX – $X.XX per unit",
      "leadTime": "15–25 days",
      "estimatedMargin": "40–60%",
      "rating": "4.8/5 (verified supplier)",
      "speciality": "What they specifically make or offer",
      "pros": "Key advantage",
      "cons": "Main risk or limitation",
      "isVerified": true
    }
  ],
  "sourcingTips": [
    "Specific tip 1 for sourcing in this category",
    "Specific tip 2",
    "Specific tip 3"
  ],
  "marginGuide": {
    "targetMargin": "45–65%",
    "costBreakdown": "Materials 30% · Shipping 10% · Customs 5% · Markup 55%",
    "pricingFormula": "Cost × 3.5 for retail pricing in UAE"
  }
}

Give REAL supplier names from Alibaba, 1688, or industry directories. Be specific to the ${brandCat} industry.`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    const raw = completion.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw);
    const result = {
      suppliers: parsed.suppliers || [],
      sourcingTips: parsed.sourcingTips || [],
      marginGuide: parsed.marginGuide,
    };

    setCache(cacheKey, result);

    if (brandProjectId) {
      const BrandProject = require("../../model/schema/brandProject");
      BrandProject.findByIdAndUpdate(brandProjectId, {
        $set: { "businessProfile.supplierResearch": result },
      })
        .exec()
        .catch(() => {});
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[researchSuppliers]", err.message);
    return res
      .status(500)
      .json({
        success: false,
        message: "Supplier research failed: " + err.message,
      });
  }
};

// ─── Marketing Cofounder: Competitive Intelligence ("While you were sleeping") ─
exports.getCompetitiveIntelligence = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    if (isRateLimited(ip))
      return res
        .status(429)
        .json({ success: false, message: "Rate limit reached." });

    const { brand, category, brandProjectId } = req.body;
    if (!brand)
      return res
        .status(400)
        .json({ success: false, message: "brand required." });

    const cacheKey = hashInput({
      bn: brand.brandName,
      cat: category || brand.category,
      v: "ci1",
    });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });

    const brandName = brand.brandName || "Your Brand";
    const brandCat = category || brand.category || "general";
    const audience = Array.isArray(brand.targetAudience)
      ? brand.targetAudience.join(", ")
      : brand.targetAudience || "";
    const voice = brand.brandVoice || "";

    const prompt = `You are a Marketing Intelligence Agent for a UAE brand called "${brandName}" in the ${brandCat} category.

Target audience: ${audience}
Brand voice: ${voice}
Brand tagline: ${brand.tagline || ""}
Brand positioning: ${brand.positioning || brand.uniqueSellingPoint || ""}

Simulate competitive analysis as if you researched Instagram, TikTok, LinkedIn, and Google for the top ${brandCat} brands in UAE.

Generate an intelligence report in JSON:

{
  "competitorGap": {
    "what_they_post": "What the top 3 competitors in ${brandCat} are posting about this week",
    "what_they_avoid": "The topic, angle, or customer pain point that NONE of them are addressing",
    "opportunity": "Specific content angle ${brandName} can own that competitors are ignoring"
  },
  "suggestedContent": {
    "platform": "instagram",
    "hook": "The opening line that would stop the scroll",
    "caption": "Full ready-to-post caption (200–300 words) specific to ${brandName}",
    "hashtags": ["array", "of", "10", "relevant", "hashtags"],
    "imagePrompt": "Detailed DALL-E image generation prompt for the post visual",
    "whyItWorks": "1-2 sentence explanation of the psychology behind this content"
  },
  "weeklyTheme": "The one big idea ${brandName} should own this week",
  "urgentAction": "The single most important thing the founder should do in the next 24 hours",
  "trendAlert": "A trend in the ${brandCat} space that ${brandName} should react to NOW"
}

Be specific to the ${brandCat} industry and UAE market. Make the content feel like it was personally researched by a senior strategist, not generated by AI.`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.75,
      response_format: { type: "json_object" },
      max_tokens: 1500,
    });

    const raw = completion.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw);

    const result = {
      ...parsed,
      brandName,
      generatedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result);

    if (brandProjectId) {
      const BrandProject = require("../../model/schema/brandProject");
      BrandProject.findByIdAndUpdate(brandProjectId, {
        $push: {
          agentMemory: {
            $each: [
              {
                tab: "dashboard",
                message: "competitive-intelligence",
                response: JSON.stringify(result).substring(0, 2000),
                createdAt: new Date(),
              },
            ],
            $slice: -50,
          },
        },
      })
        .exec()
        .catch(() => {});
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[getCompetitiveIntelligence]", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Intelligence report failed." });
  }
};

// ─── GET /api/v1/brand-ai/admin/submissions — all brand funnel leads ──────────
exports.adminGetSubmissions = async (req, res) => {
  try {
    const BrandSubmission = require("../../model/schema/brandSubmission");
    const page = parseInt(req.query.page || "1");
    const limit = parseInt(req.query.limit || "50");
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.hasEmail === "true")
      filter.email = { $exists: true, $ne: "" };

    const [submissions, total] = await Promise.all([
      BrandSubmission.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BrandSubmission.countDocuments(filter),
    ]);

    res.json({
      success: true,
      submissions,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[adminGetSubmissions]", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /api/v1/brand-ai/admin/brands — all saved brand projects ─────────────
exports.adminGetBrands = async (req, res) => {
  try {
    const BrandProject = require("../../model/schema/brandProject");
    const page = parseInt(req.query.page || "1");
    const limit = parseInt(req.query.limit || "50");
    const skip = (page - 1) * limit;

    const filter = { isArchived: { $ne: true } };
    if (req.query.category) filter.businessType = req.query.category;

    const [brands, total] = await Promise.all([
      BrandProject.find(filter)
        .populate("user", "name email phone createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BrandProject.countDocuments(filter),
    ]);

    const enriched = brands.map((b) => ({
      _id: b._id,
      brandName:
        b.fragranceConfig?.brandName ||
        b.skincareConfig?.brandName ||
        b.customFields?.find((f) => f.key === "brandName")?.value ||
        b.projectName ||
        "—",
      category: b.businessType || "custom",
      tagline: b.fragranceConfig?.tagline || b.skincareConfig?.tagline || "—",
      status: b.status || "draft",
      email: b.user?.email || "—",
      phone: b.user?.phone || "—",
      ownerName: b.user?.name || "—",
      createdAt: b.createdAt,
      leadScore: Math.round(
        (b.fragranceConfig?.brandName ? 20 : 0) +
          (b.status === "quotation_sent"
            ? 30
            : b.status === "launched"
              ? 50
              : b.status === "configured"
                ? 15
                : 0) +
          ((b.generatedAssets?.length || 0) > 0 ? 20 : 0) +
          (b.user?.email ? 10 : 0),
      ),
    }));

    res.json({
      success: true,
      brands: enriched,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[adminGetBrands]", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
