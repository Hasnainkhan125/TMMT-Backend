/**
 * storeController.js — Store CRUD + public view + AI marketing + brand launch
 */

const Store        = require('../../model/schema/store');
const Product      = require('../../model/schema/product');
const BrandProject = require('../../model/schema/brandProject');
const OpenAI       = require('openai');

let _aiClient;
function getAiClient() {
  if (!_aiClient) _aiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 2 });
  return _aiClient;
}

// ─── Create / update my store ─────────────────────────────────────────────────

exports.getMyStore = async (req, res) => {
  try {
    const store = await Store.findOne({ user: req.user._id }).lean();
    return res.json({ success: true, store: store || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.upsertStore = async (req, res) => {
  try {
    const { name, description, brandColor, category, socialLinks, currency } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Store name is required' });

    let store = await Store.findOne({ user: req.user._id });

    if (store) {
      store.name        = name;
      store.description = description || store.description;
      store.brandColor  = brandColor  || store.brandColor;
      store.category    = category    || store.category;
      store.currency    = currency    || store.currency;
      if (socialLinks) store.socialLinks = { ...store.socialLinks, ...socialLinks };
      if (req.files?.profileImage?.[0]?.location) store.profileImage = req.files.profileImage[0].location;
      if (req.files?.coverImage?.[0]?.location)   store.coverImage   = req.files.coverImage[0].location;
      await store.save();
    } else {
      store = await Store.create({
        user:         req.user._id,
        name,
        description:  description || '',
        brandColor:   brandColor  || '#944a00',
        category:     category    || 'other',
        currency:     currency    || 'AED',
        socialLinks:  socialLinks || {},
        profileImage: req.files?.profileImage?.[0]?.location || '',
        coverImage:   req.files?.coverImage?.[0]?.location   || '',
      });
    }

    return res.json({ success: true, store });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.publishStore = async (req, res) => {
  try {
    const store = await Store.findOne({ user: req.user._id });
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });
    store.isPublished = req.body.publish !== false;
    await store.save();
    return res.json({ success: true, store });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Public store view ────────────────────────────────────────────────────────

exports.getPublicStore = async (req, res) => {
  try {
    const store = await Store.findOne({ slug: req.params.slug, isPublished: true }).lean();
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    // Increment views (fire-and-forget)
    Store.updateOne({ _id: store._id }, { $inc: { views: 1 } }).catch(() => {});

    const products = await Product.find({ store: store._id, isPublished: true })
      .sort({ isFeatured: -1, createdAt: -1 })
      .lean();

    return res.json({ success: true, store, products });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getStoreDashboard = async (req, res) => {
  try {
    const store    = await Store.findOne({ user: req.user._id }).lean();
    if (!store) return res.json({ success: true, store: null, products: [], stats: {} });

    const products = await Product.find({ store: store._id }).sort({ createdAt: -1 }).lean();
    const stats = {
      totalProducts:   products.length,
      publishedProducts: products.filter(p => p.isPublished).length,
      totalSales:      products.reduce((s, p) => s + p.salesCount, 0),
      storeViews:      store.views,
    };

    return res.json({ success: true, store, products, stats });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── AI: Generate product copy & ad content ──────────────────────────────────

exports.generateProductContent = async (req, res) => {
  try {
    const { productId, type = 'all' } = req.body;
    if (!productId) return res.status(400).json({ success: false, message: 'productId required' });

    const product = await Product.findOne({ _id: productId, user: req.user._id }).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const store = await Store.findOne({ user: req.user._id }).lean();
    const brandName = store?.name || 'My Brand';

    const prompt = `You are a UAE e-commerce marketing expert. Generate marketing copy for this product:

Product: ${product.name}
Description: ${product.description || 'not provided'}
Price: ${product.price} ${product.currency || 'AED'}
Store: ${brandName}
Category: ${product.category || 'general'}

Respond ONLY with valid JSON:
{
  "instagramCaption": "150 char max, emotion-driven, no hashtags",
  "tiktokScript": "One sentence 15s TikTok concept",
  "adHeadline": "6-8 word headline",
  "adBody": "2 sentences body copy",
  "emailSubject": "under 50 chars",
  "smsText": "under 160 chars",
  "hashtags": ["tag1","tag2","tag3","tag4","tag5"],
  "improvedDescription": "2-3 sentences, sales-focused product description",
  "seoTitle": "optimised SEO product title under 60 chars"
}`;

    const completion = await getAiClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = JSON.parse(completion.choices[0].message.content);
    return res.json({ success: true, content });
  } catch (err) {
    console.error('[generateProductContent]', err.message);
    return res.status(500).json({ success: false, message: 'Content generation failed.' });
  }
};

// ─── AI: Generate product image prompt ───────────────────────────────────────

exports.generateProductImagePrompt = async (req, res) => {
  try {
    const { productId, style = 'commercial' } = req.body;
    if (!productId) return res.status(400).json({ success: false, message: 'productId required' });

    const product = await Product.findOne({ _id: productId, user: req.user._id }).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const styleMap = {
      commercial: 'professional commercial product photography on clean white background, sharp focus, soft shadows',
      lifestyle:  'lifestyle editorial photography, natural light, real-life context, aspirational mood',
      social:     'Instagram-perfect square crop, bold composition, on-brand color palette, trending aesthetic',
      dark:       'dramatic dark background product photography, single spotlight, moody luxury feel',
    };
    const styleDesc = styleMap[style] || styleMap.commercial;

    const imagePrompt = `${styleDesc}. Product: ${product.name}. ${product.description || ''}. Shot on Sony A7R V, 85mm f/1.4 lens, photorealistic, no text, no watermarks, no logos.`;

    // Generate the image via gpt-image-1
    const response = await getAiClient().images.generate({
      model: 'gpt-image-1',
      prompt: imagePrompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
    });

    const b64 = response.data[0]?.b64_json;
    if (!b64) throw new Error('No image data');

    return res.json({ success: true, url: `data:image/png;base64,${b64}`, prompt: imagePrompt });
  } catch (err) {
    console.error('[generateProductImagePrompt]', err.message);
    return res.status(500).json({ success: false, message: 'Image generation failed.' });
  }
};

// ─── Launch store from brand project ──────────────────────────────────────────

/**
 * POST /store/launch-from-brand
 * Reads a BrandProject, creates a Store + 3-4 Products with AI-generated details.
 * Product images are generated via GPT-image-1 (async, base64 stored in product.images).
 */
exports.launchStoreFromBrand = async (req, res) => {
  try {
    const { brandProjectId } = req.body;
    const userId = req.user._id;

    if (!brandProjectId) {
      return res.status(400).json({ success: false, message: 'brandProjectId is required' });
    }

    const brand = await BrandProject.findOne({ _id: brandProjectId, user: userId });
    if (!brand) {
      return res.status(404).json({ success: false, message: 'Brand project not found' });
    }

    const cfg = brand.config?.brand || {};
    const brandName     = brand.projectName || cfg.brandName || 'My Brand';
    const brandColor    = cfg.colorPalette?.primary || '#944a00';
    const tagline       = cfg.tagline || '';
    const category      = mapBrandToStoreCategory(brand.businessType);
    const currency      = 'AED';
    const pricePoint    = brand.pricePoint || cfg.pricePoint || 'mid-range';

    // Check if store already exists for this user
    let store = await Store.findOne({ user: userId });
    if (store) {
      store.name        = brandName;
      store.description = tagline;
      store.brandColor  = brandColor;
      store.category    = category;
      await store.save();
    } else {
      store = await Store.create({
        user:         userId,
        name:         brandName,
        description:  tagline,
        brandColor,
        category,
        currency,
        socialLinks:  {},
        isPublished:  false,
      });
    }

    // Use AI to generate product concepts from brand data
    const products = await generateProductConcepts(brand, cfg, pricePoint, currency);

    const createdProducts = [];
    for (const p of products) {
      const product = await Product.create({
        store:        store._id,
        user:         userId,
        name:         p.name,
        description:  p.description,
        price:        p.price,
        comparePrice: p.comparePrice || null,
        currency,
        quantity:     p.quantity || 50,
        images:       [],
        category:     p.category || category,
        tags:         p.tags || [],
        sku:          p.sku || '',
        weight:       0,
        isPublished:  true,
        isFeatured:   p.isFeatured || false,
      });
      createdProducts.push(product);
    }

    // Update brand project status
    await BrandProject.findByIdAndUpdate(brandProjectId, {
      $set: { status: 'launched' },
    });

    // Generate product images in background (fire-and-forget)
    generateProductImages(createdProducts, brand, cfg, userId).catch(err => {
      console.error('[launchStoreFromBrand] Background image gen failed:', err.message);
    });

    return res.json({
      success:  true,
      store:    { _id: store._id, slug: store.slug, name: store.name },
      products: createdProducts.map(p => ({ _id: p._id, name: p.name, price: p.price })),
      message:  `Store "${store.name}" created with ${createdProducts.length} products. Images generating in background.`,
    });
  } catch (err) {
    console.error('[launchStoreFromBrand]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

function mapBrandToStoreCategory(businessType) {
  const map = {
    perfume:   'perfume',
    skincare:  'skincare',
    food:      'food',
    clothing:  'fashion',
    fashion:   'fashion',
    tech:      'electronics',
    wellness:  'skincare',
  };
  return map[businessType] || 'other';
}

async function generateProductConcepts(brand, cfg, pricePoint, currency) {
  const brandName  = brand.projectName || cfg.brandName || 'Brand';
  const category   = brand.businessType || 'general';
  const tagline    = cfg.tagline || '';
  const usp        = brand.agentMemory?.usp?.current || '';

  const fragranceCtx = brand.fragranceConfig
    ? `Fragrance: ${brand.fragranceConfig.scentProfile || ''}, family: ${brand.fragranceConfig.family || ''}, concentration: ${brand.fragranceConfig.concentration || ''}`
    : '';
  const skincareCtx = brand.skincareConfig
    ? `Skincare: ${(brand.skincareConfig.productLine || []).join(', ')}, concerns: ${(brand.skincareConfig.targetConcern || []).join(', ')}`
    : '';

  const priceGuide = {
    'budget':       { hero: [25, 50],   variant: [15, 35] },
    'mid-range':    { hero: [80, 180],  variant: [45, 120] },
    'luxury':       { hero: [250, 500], variant: [150, 350] },
    'ultra-luxury': { hero: [500, 1200], variant: [300, 800] },
  };
  const guide = priceGuide[pricePoint] || priceGuide['mid-range'];

  const prompt = `You are a UAE e-commerce product strategist. Generate exactly 4 products for this brand's online store.

Brand: ${brandName}
Category: ${category}
Tagline: ${tagline}
USP: ${usp}
Price tier: ${pricePoint}
Currency: ${currency}
${fragranceCtx}
${skincareCtx}

Product guidelines:
- Product 1: HERO/FLAGSHIP product (price range: ${guide.hero[0]}-${guide.hero[1]} ${currency}). This is the brand's signature.
- Product 2: A complementary/variant product (price range: ${guide.variant[0]}-${guide.variant[1]} ${currency}).
- Product 3: A discovery/sampler/travel size (price: ${Math.round(guide.variant[0] * 0.5)}-${Math.round(guide.variant[0])} ${currency}).
- Product 4: A gift set or bundle (price: ${Math.round(guide.hero[1] * 1.2)}-${Math.round(guide.hero[1] * 1.8)} ${currency}). Set comparePrice 20-30% higher.

Return ONLY valid JSON array:
[{
  "name": "product name",
  "description": "2-3 sentence compelling product description",
  "price": 199,
  "comparePrice": null,
  "quantity": 50,
  "category": "${category}",
  "tags": ["tag1", "tag2", "tag3"],
  "sku": "SKU-001",
  "isFeatured": true
}]`;

  try {
    const completion = await getAiClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const text = completion.choices[0].message.content;
    const parsed = JSON.parse(text);
    const products = Array.isArray(parsed) ? parsed : parsed.products || [];
    return products.slice(0, 4);
  } catch (err) {
    console.error('[generateProductConcepts] AI failed, using fallback:', err.message);
    return getFallbackProducts(brandName, category, guide, currency);
  }
}

function getFallbackProducts(brandName, category, guide, currency) {
  return [
    {
      name:        `${brandName} Signature`,
      description: `The flagship ${category} product from ${brandName}. Crafted with premium ingredients for the discerning customer.`,
      price:       Math.round((guide.hero[0] + guide.hero[1]) / 2),
      quantity:    50,
      category,
      tags:        [category, 'signature', 'premium'],
      sku:         'SIG-001',
      isFeatured:  true,
    },
    {
      name:        `${brandName} Classic`,
      description: `A timeless essential from ${brandName}. Perfect for everyday luxury.`,
      price:       Math.round((guide.variant[0] + guide.variant[1]) / 2),
      quantity:    100,
      category,
      tags:        [category, 'classic', 'everyday'],
      sku:         'CLS-002',
      isFeatured:  false,
    },
    {
      name:        `${brandName} Discovery`,
      description: `Experience ${brandName} with this travel-friendly size. Ideal for first-time buyers.`,
      price:       Math.round(guide.variant[0] * 0.7),
      quantity:    200,
      category,
      tags:        [category, 'discovery', 'travel'],
      sku:         'DSC-003',
      isFeatured:  false,
    },
    {
      name:        `${brandName} Gift Collection`,
      description: `The perfect gift. Includes the signature product plus exclusive extras in premium packaging.`,
      price:       Math.round(guide.hero[1] * 1.4),
      comparePrice: Math.round(guide.hero[1] * 1.8),
      quantity:    30,
      category,
      tags:        [category, 'gift', 'collection', 'luxury'],
      sku:         'GFT-004',
      isFeatured:  false,
    },
  ];
}

async function generateProductImages(products, brand, cfg, userId) {
  const imagePromptPurifier = require('../../services/imagePromptPurifier');

  const brandContext = {
    brandName:       brand.projectName || cfg.brandName || 'Brand',
    category:        brand.businessType || 'default',
    brandId:         brand._id?.toString(),
    colorPalette:    cfg.colorPalette || {},
    tone:            cfg.tone || '',
    pricePoint:      brand.pricePoint || '',
    bottleShape:     brand.fragranceConfig?.bottleShape || brand.packaging?.bottleShape || '',
    bottleMaterial:  brand.fragranceConfig?.bottleMaterial || brand.packaging?.bottleMaterial || '',
    capStyle:        brand.packaging?.capStyle || '',
    labelFinish:     brand.packaging?.labelFinish || '',
    packagingStyle:  brand.skincareConfig ? 'minimal clinical white' : '',
    inputs:          {},
  };

  for (const product of products) {
    try {
      const result = await imagePromptPurifier.generateBrandImage(
        { ...brandContext, brandName: product.name },
        'heroBottle',
        userId?.toString(),
      );

      const imageData = result.base64
        ? `data:image/webp;base64,${result.base64}`
        : result.url || '';

      if (imageData) {
        await Product.findByIdAndUpdate(product._id, {
          $push: { images: imageData },
        });
      }

      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[generateProductImages] Failed for ${product.name}:`, err.message);
    }
  }
}
