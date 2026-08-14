'use strict';

const {
  inferBusinessProfile,
  formatBusinessContextForPrompt,
} = require('../services/businessProfileInference');

describe('businessProfileInference', () => {
  it('classifies a dental clinic URL text as clinic_dental', () => {
    const scrape = {
      brandName: 'Smiles Dental',
      category: 'general',
      description: 'Pediatric dentistry and Invisalign in Dubai.',
      headlines: ['Book your dental checkup'],
      paragraphs: [],
    };
    const research = {
      brand: { name: 'Smiles Dental', category: 'dental', keywords: ['veneers'] },
    };
    const bp = inferBusinessProfile(scrape, research);
    expect(bp.type).toBe('clinic_dental');
    expect(bp.businessAssets.kind).toBe('service_menu');
    expect(formatBusinessContextForPrompt(bp)).toMatch(/trust/i);
  });

  it('classifies omni-channel pharmacy as health_retail, not automotive', () => {
    const scrape = {
      brandName: 'Life Pharmacy',
      description: 'UAE omni-channel pharmacy delivering health & beauty in 30 minutes.',
      headlines: ['Live Healthy with Life Pharmacy'],
      paragraphs: ['Order prescription/OTC medicines online. Vitamins, beauty, baby care.'],
    };
    const research = {
      brand: {
        name: 'Life Pharmacy',
        category: 'omni-channel pharmacy & healthcare retailer',
        subcategory: 'online pharmacy with beauty & wellness focus',
      },
    };
    const bp = inferBusinessProfile(scrape, research);
    expect(bp.type).toBe('health_retail');
    expect(bp.type).not.toBe('automotive');
    expect(bp.primaryActions.some((a) => a.label.toLowerCase().includes('shop') || a.label.toLowerCase().includes('order'))).toBe(true);
  });

  it('classifies standalone pharmacy text via regex as health_retail', () => {
    const scrape = {
      brandName: 'Aster Pharmacy',
      description: 'Prescription medicines, OTC drugs and vitamins delivered fast.',
      headlines: ['Your trusted pharmacy'],
      paragraphs: [],
    };
    const bp = inferBusinessProfile(scrape, null);
    expect(bp.type).toBe('health_retail');
  });

  it('prefers product_catalog when Shopify-style products exist', () => {
    const scrape = {
      brandName: 'Oud House',
      category: 'perfume',
      description: 'Luxury fragrances.',
      productCatalog: {
        products: [
          { title: 'Royal Oud', price: 299 },
          { title: 'Desert Rose', price: 199 },
        ],
      },
    };
    const bp = inferBusinessProfile(scrape, null);
    expect(bp.type).toBe('product_brand');
    expect(bp.businessAssets.kind).toBe('product_catalog');
    expect(formatBusinessContextForPrompt(bp)).toMatch(/Royal Oud/);
  });

  it('classifies AI banking category as enterprise_b2b (not misled by shop CTAs)', () => {
    const scrape = {
      brandName: 'Gulf Bank',
      description: 'Corporate banking and personal accounts.',
      headlines: ['Shop gift cards', 'Order checks online'],
      paragraphs: [],
    };
    const research = {
      brand: {
        name: 'Gulf Bank',
        category: 'multinational banking and financial services',
        subcategory: 'retail and corporate banking',
      },
    };
    const bp = inferBusinessProfile(scrape, research);
    expect(bp.type).toBe('enterprise_b2b');
    expect(bp.safetyNotes).toContain('no_consumer_price_anchoring');
  });

  it('classifies a full Shopify catalog with electronics AI category as ecommerce_electronics', () => {
    const products = Array.from({ length: 6 }, (_, i) => ({ title: `Phone ${i}`, price: 99 + i }));
    const scrape = {
      brandName: 'Gadget Zone',
      productCatalog: { platform: 'shopify', products },
      description: 'Consumer electronics and accessories.',
    };
    const research = {
      brand: { category: 'consumer electronics', subcategory: 'smartphones and tablets' },
    };
    const bp = inferBusinessProfile(scrape, research);
    expect(bp.type).toBe('ecommerce_electronics');
    expect(formatBusinessContextForPrompt(bp)).toMatch(/Hero the device/i);
  });

  it('formatBusinessContextForPrompt uses fashion e-commerce guidance for ecommerce_fashion', () => {
    const products = Array.from({ length: 6 }, (_, i) => ({ title: `Kaftan ${i}`, price: 199 + i }));
    const scrape = {
      brandName: 'Desert Moda',
      productCatalog: { platform: 'shopify', products },
    };
    const research = {
      brand: { category: 'fashion', subcategory: 'womens apparel and kaftans' },
    };
    const bp = inferBusinessProfile(scrape, research);
    expect(bp.type).toBe('ecommerce_fashion');
    expect(formatBusinessContextForPrompt(bp)).toMatch(/garment|on-model/i);
  });
});
