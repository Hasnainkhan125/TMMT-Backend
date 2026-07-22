'use strict';

/**
 * productCatalog — extract product catalog from common e-commerce platforms.
 *
 * Tries known endpoints in order:
 *   - Shopify:    /products.json
 *   - WooCommerce: /wp-json/wc/store/products
 *   - Magento 2: /rest/V1/products
 *   - Wix:       /_api/cloud-data/v1/wix-data/items/query
 *   - Generic:   /api/products, /api/v1/products
 *
 * Returns up to 20 products with normalized shape:
 *   { id, title, price, currency, image, productUrl, description }
 *
 * Why this matters: When Qumak generates an ad for a Shopify store, we
 * can offer "Generate an ad carousel for your top 3 bestsellers" as a
 * one-click flow. The user doesn't upload anything — we already have
 * their catalog. That's the magic.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 500 * 1024;

const COMMON_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; Qumak/1.0)',
  'accept': 'application/json',
};

async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  
  try {
    const resp = await fetch(url, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });
    
    if (!resp.ok) return null;
    
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl > MAX_RESPONSE_BYTES) return null;
    
    const text = await resp.text();
    if (text.length > MAX_RESPONSE_BYTES) return null;
    
    return JSON.parse(text);
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Platform-specific normalizers ───────────────────────────────────

function normalizeShopifyProduct(p, origin) {
  const variant = p.variants?.[0];
  const image = p.image?.src || p.images?.[0]?.src || null;
  return {
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    price: variant?.price ? parseFloat(variant.price) : null,
    currency: null, // Shopify products.json doesn't expose currency
    image,
    productUrl: `${origin}/products/${p.handle}`,
    description: (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
    vendor: p.vendor,
    type: p.product_type,
    tags: typeof p.tags === 'string' ? p.tags.split(',').map((t) => t.trim()) : p.tags,
  };
}

function normalizeWooProduct(p, origin) {
  return {
    id: String(p.id),
    title: p.name,
    handle: p.slug,
    price: p.prices?.price ? parseInt(p.prices.price, 10) / 100 : null,
    currency: p.prices?.currency_code || null,
    image: p.images?.[0]?.src || null,
    productUrl: p.permalink,
    description: (p.short_description || p.description || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240),
    tags: (p.categories || []).map((c) => c.name),
  };
}

function normalizeMagentoProduct(p, origin) {
  return {
    id: String(p.id || p.sku),
    title: p.name,
    handle: p.url_key,
    price: p.price || null,
    currency: null,
    image: p.media_gallery_entries?.[0]?.file ? `${origin}/media/catalog/product${p.media_gallery_entries[0].file}` : null,
    productUrl: `${origin}/${p.url_key}.html`,
    description: (p.custom_attributes?.find((a) => a.attribute_code === 'short_description')?.value || '').slice(0, 240),
  };
}

// ─── Platform detection + dispatch ───────────────────────────────────

async function tryShopify(origin) {
  const data = await fetchJson(`${origin}/products.json?limit=20`);
  if (!data?.products || !Array.isArray(data.products)) return null;
  return {
    platform: 'shopify',
    products: data.products.map((p) => normalizeShopifyProduct(p, origin)),
  };
}

async function tryWoocommerce(origin) {
  const data = await fetchJson(`${origin}/wp-json/wc/store/products?per_page=20`);
  if (!Array.isArray(data) || !data.length || !data[0].name) return null;
  return {
    platform: 'woocommerce',
    products: data.map((p) => normalizeWooProduct(p, origin)),
  };
}

async function tryMagento(origin) {
  const data = await fetchJson(`${origin}/rest/V1/products?searchCriteria[pageSize]=20`);
  if (!data?.items || !Array.isArray(data.items)) return null;
  return {
    platform: 'magento',
    products: data.items.map((p) => normalizeMagentoProduct(p, origin)),
  };
}

async function tryGeneric(origin) {
  const endpoints = ['/api/products', '/api/v1/products', '/api/catalog/products'];
  for (const endpoint of endpoints) {
    const data = await fetchJson(`${origin}${endpoint}?limit=20`);
    if (data && (Array.isArray(data) || Array.isArray(data.products) || Array.isArray(data.data))) {
      const products = Array.isArray(data) ? data : (data.products || data.data);
      return {
        platform: 'generic',
        products: products.slice(0, 20).map((p) => ({
          id: String(p.id || p._id || p.sku || Math.random()),
          title: p.title || p.name || 'Unnamed product',
          price: p.price || p.cost || null,
          image: p.image || p.thumbnail || p.images?.[0] || null,
          productUrl: p.url || p.link || null,
          description: (p.description || '').slice(0, 240),
        })),
      };
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────

async function fetchProductCatalog(origin) {
  if (!origin) return null;
  
  // Run all four in parallel — whichever responds first with valid data wins.
  // This is fast because most sites only host ONE platform's endpoints.
  const results = await Promise.allSettled([
    tryShopify(origin),
    tryWoocommerce(origin),
    tryMagento(origin),
    tryGeneric(origin),
  ]);
  
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.products?.length) {
      return {
        ...r.value,
        fetchedAt: new Date().toISOString(),
        total: r.value.products.length,
      };
    }
  }
  
  return null;
}

module.exports = { fetchProductCatalog };