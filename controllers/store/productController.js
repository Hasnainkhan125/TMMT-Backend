/**
 * productController.js — Product CRUD for store
 */

const Product = require('../../model/schema/product');
const Store   = require('../../model/schema/store');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure the user has a store. Creates a minimal one on first product if needed.
 * @returns {{ store: import('mongoose').Document, created: boolean }}
 */
async function getOrCreateStoreForUser(req) {
  let store = await Store.findOne({ user: req.user._id });
  if (store) return { store, created: false };

  const defaultName =
    (req.user.name && String(req.user.name).trim())
    || (req.user.email && String(req.user.email).split('@')[0])
    || 'My Store';

  store = await Store.create({
    user: req.user._id,
    name: defaultName,
    description: '',
    brandColor: '#C9A24C',
    category: 'other',
    currency: 'AED',
    socialLinks: {},
    profileImage: '',
    coverImage: '',
  });
  return { store, created: true };
}

// ─── Create product ───────────────────────────────────────────────────────────

exports.createProduct = async (req, res) => {
  try {
    const { store } = await getOrCreateStoreForUser(req);
    const { name, description, price, comparePrice, quantity, category, tags, sku, weight } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ success: false, message: 'name and price are required' });
    }

    const images = (req.files || []).map(f => f.location).filter(Boolean);

    const product = await Product.create({
      store:        store._id,
      user:         req.user._id,
      name,
      productType:  req.body.productType || 'PHYSICAL_PRODUCT',
      description:  description  || '',
      price:        parseFloat(price),
      comparePrice: comparePrice ? parseFloat(comparePrice) : undefined,
      currency:     store.currency,
      quantity:     parseInt(quantity) || 0,
      images,
      category:     category || '',
      tags:         tags     ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      sku:          sku      || '',
      weight:       parseFloat(weight) || 0,
    });

    return res.status(201).json({ success: true, product, store: store.toObject ? store.toObject() : store });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── List products (authenticated owner) ─────────────────────────────────────

exports.listMyProducts = async (req, res) => {
  try {
    const store = await Store.findOne({ user: req.user._id });
    if (!store) return res.json({ success: true, products: [] });
    const products = await Product.find({ store: store._id })
      .sort({ isFeatured: -1, createdAt: -1 })
      .lean();
    return res.json({ success: true, products });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Get single product ───────────────────────────────────────────────────────

exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, product });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Update product ───────────────────────────────────────────────────────────

exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user._id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const { name, description, price, comparePrice, quantity, category, tags, sku, weight, isPublished, isFeatured } = req.body;

    if (name         !== undefined) product.name         = name;
    if (description  !== undefined) product.description  = description;
    if (price        !== undefined) product.price        = parseFloat(price);
    if (comparePrice !== undefined) product.comparePrice = comparePrice ? parseFloat(comparePrice) : null;
    if (quantity     !== undefined) product.quantity     = parseInt(quantity);
    if (category     !== undefined) product.category     = category;
    if (sku          !== undefined) product.sku          = sku;
    if (weight       !== undefined) product.weight       = parseFloat(weight);
    if (isPublished  !== undefined) product.isPublished  = isPublished === true || isPublished === 'true';
    if (isFeatured   !== undefined) product.isFeatured   = isFeatured  === true || isFeatured  === 'true';
    if (tags         !== undefined) product.tags         = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());

    // Append new images
    const newImages = (req.files || []).map(f => f.location).filter(Boolean);
    if (newImages.length) product.images.push(...newImages);

    // Remove images by URL list (passed as JSON string)
    if (req.body.removeImages) {
      const toRemove = JSON.parse(req.body.removeImages);
      product.images = product.images.filter(img => !toRemove.includes(img));
    }

    await product.save();
    return res.json({ success: true, product });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Delete product ───────────────────────────────────────────────────────────

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /me/products/:id/nas-leads — ICP + leads captured for this product (NAS-style).
 * Returns cached payload when present; otherwise empty structure for UI.
 */
exports.getNasLeadsForProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    if (product.nasLeadsCache && typeof product.nasLeadsCache === 'object') {
      const cached = product.nasLeadsCache;
      const leads = Array.isArray(cached.leads) ? cached.leads : [];
      const slice = leads.slice((page - 1) * limit, page * limit);
      return res.json({
        success: true,
        data: {
          ...cached,
          leads: slice,
          metadata: {
            total: cached.metadata?.total ?? leads.length,
            limit,
            page,
            pages: Math.max(1, Math.ceil((cached.metadata?.total ?? leads.length) / limit)),
          },
        },
      });
    }

    const thumb = (product.images && product.images[0]) || '';
    return res.json({
      success: true,
      data: {
        product: {
          _id: product._id,
          productType: product.productType || 'PHYSICAL_PRODUCT',
          title: product.name,
          thumbnail: thumb,
        },
        currentIcpProfile: null,
        leads: [],
        searchCountInfo: { limit: 10, count: 0, resetDateTime: null },
        metadata: { total: 0, limit, page, pages: 0 },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
