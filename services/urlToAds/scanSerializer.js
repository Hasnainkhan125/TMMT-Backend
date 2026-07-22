// services/urlToAds/scanSerializer.js
// Converts: UrlAdsScan + BrandIdentity → UrlToAdsScanSnapshot
//
// The frontend expects a flat, friendly shape with `brandPalette`, `fonts`,
// `businessProfile`, `competitors`, `ads`, etc. at the top level.
// Our backend stores things under `brand.assets.brandColors`, etc.
// This adapter is the bridge.

/**
 * @param {UrlAdsScan} scan - The user's scan document
 * @param {BrandIdentity} brand - The global brand identity
 * @returns {UrlToAdsScanSnapshot} Ready for the frontend
 */
function serializeToScanSnapshot(scan, brand) {
    if (!scan || !brand) return null;
    
    return {
      // ── IDs + lifecycle ──
      id:        scan._id.toString(),
      url:       scan.inputUrl,
      host:      scan.host || brand.canonicalDomain,
      status:    scan.status || 'ready',
      errorMessage: scan.errorMessage || null,
      createdAt: scan.createdAt?.toISOString(),
      updatedAt: scan.updatedAt?.toISOString(),
      
      // ── Brand basics (what the Recognition Band reads) ──
      brand: {
        name:        brand.brandName || brand.canonicalDomain,
        siteName:    brand.brandName,
        url:         scan.inputUrl,
        host:        brand.canonicalDomain,
        title:       brand.content?.title,
        description: brand.description || brand.tagline,
        headlines:   sanitizeHeadlines(brand.content?.headlines || []),
        paragraphs:  [],  // backend doesn't store these yet
        images:      brand.assets?.heroImages || [],
        favicon:     brand.assets?.favicon,
        category:    brand.subtype || brand.businessType,
        audience:    brand.content?.audience,
      },
      
      // ── Brand palette (what BrandKitCard reads) ──
      brandPalette: serializePalette(brand.assets?.brandColors),
      
      // ── Fonts as simple string array ──
      fonts: serializeFonts(brand.assets?.fonts),
      
      // ── Product catalog (polymorphic — currently empty) ──
      productCatalog: null,  // TODO: wire when Layer 2 scraper extracts products
      
      // ── Business profile (what BusinessTypeTag reads) ──
      businessProfile: serializeBusinessProfile(brand, scan),
      
      // ── Competitors ──
      competitors: scan.competitors || [],
      
      // ── Live competitor ads (from Meta Ad Library — Layer 2) ──
      competitorAds: null,  // TODO: populate when Layer 2 ships
      
      // ── Copy bank ──
      copy: scan.copy || { headlines: [], captions: [], ctas: [], hashtags: [] },
      
      // ── User's 3 ad blueprints ──
      ads: scan.ads || [],
      adSetId: scan.adSetId || null,
      
      // ── Intelligence (Layer 2-5 output) ──
      intelligence: null,  // TODO: populate when battlefield report generator ships
    };
  }
  
  // ─── Sub-serializers ────────────────────────────────────────────
  
  function serializePalette(brandColors) {
    if (!brandColors || !brandColors.palette?.length) return null;
    
    // Filter fallback-only palettes — surface them, but flag in metadata
    const isFallback = brandColors.palette.every(c => 
      c.source?.startsWith('default_fallback') || c.source?.startsWith('wp-default:')
    );
    
    if (isFallback) {
      // Don't show fallback palette to user — frontend treats null as "not extracted"
      return null;
    }
    
    return {
      primary:    brandColors.primary,
      accent:     brandColors.accent,
      background: brandColors.background,
      swatches:   brandColors.palette.map(s => ({
        hex:        s.hex,
        role:       s.role || 'neutral',
        brightness: s.brightness || 0,
        saturation: s.saturation || 0,
        coverage:   s.coverage || 0,
        source:     s.source,
      })),
      cssVariables: brandColors.cssVariables || {},
      sourceImageUrl: null,
    };
  }
  
  function serializeFonts(fonts) {
    if (!fonts || !Array.isArray(fonts) || fonts.length === 0) return [];
    
    // Frontend expects simple string array of font family names
    return fonts
      .map(f => typeof f === 'string' ? f : f.family)
      .filter(Boolean)
      .filter(f => !f.startsWith('__'))  // Skip our internal sentinel markers
      .slice(0, 4);
  }
  
  function serializeBusinessProfile(brand, scan) {
    if (!brand.businessType) return null;
    
    return {
      type:       brand.businessType,
      subtype:    brand.subtype || null,
      confidence: brand.confidence?.businessType || 0,
      
      brandIdentity: {
        name:        brand.brandName,
        tagline:     brand.tagline,
        positioning: brand.description,
        values:      extractBrandValues(brand),
      },
      
      // Business-type-specific assets
      businessAssets: deriveBusinessAssets(brand),
      
      primaryActions: derivePrimaryActions(brand),
      
      // Strategic guidance (placeholder — Layer 3 will fill this)
      adStrategy: {
        winningAngles:    [],
        avoidAngles:      [],
        testimonialStyle: 'product_review',
        funnelShape:      'direct_to_cart',
      },
      
      safetyNotes: [],
    };
  }
  
  function extractBrandValues(brand) {
    // Extract value props from headlines + description using simple heuristics
    const values = new Set();
    
    const sourceTexts = [
      brand.description,
      brand.tagline,
      ...(brand.content?.headlines || []),
    ].filter(Boolean);
    
    // Look for explicit value statements
    const valuePatterns = [
      /\b(curated|premium|authentic|handcrafted|artisan)\b/gi,
      /\b(gulf|uae|dubai|abu dhabi|saudi|ksa|gcc)[\s-]+(?:based|focused|native|exclusive)\b/gi,
      /\b(verified|certified|approved|trusted)\b/gi,
      /\b(luxury|exclusive|limited|rare)\b/gi,
      /\b(sustainable|eco|organic|natural|clean)\b/gi,
    ];
    
    for (const text of sourceTexts) {
      for (const pattern of valuePatterns) {
        const matches = text.matchAll(pattern);
        for (const m of matches) {
          values.add(m[0].toLowerCase());
        }
      }
    }
    
    return Array.from(values).slice(0, 6);
  }
  
  function deriveBusinessAssets(brand) {
    // Based on businessType, return a polymorphic assets object
    const type = brand.businessType;
    
    if (type === 'product_brand') {
      return {
        kind: 'product_catalog',
        products: [],  // TODO: populated by Layer 2 product scraper
      };
    }
    
    if (type === 'restaurant' || type === 'cafe') {
      return {
        kind: 'restaurant_menu',
        dishes:      [],
        cuisineType: brand.subtype,
        ambiance:    null,
      };
    }
    
    if (type?.startsWith('clinic_') || type === 'beauty_salon' || type === 'fitness_gym') {
      return {
        kind: 'service_menu',
        services:      [],
        practitioners: [],
      };
    }
    
    if (type === 'real_estate') {
      return {
        kind:  'real_estate',
        areas: [],
      };
    }
    
    if (type === 'law_firm' || type === 'accounting' || type === 'consulting') {
      return {
        kind:      'professional_services',
        expertise: [],
      };
    }
    
    if (type === 'marketing_agency' || type === 'creative_agency') {
      return {
        kind:      'general_business',
        offerings: ['Ad campaigns', 'Brand strategy', 'Content creation'],
      };
    }
    
    return {
      kind:      'general_business',
      offerings: [],
    };
  }
  
  function derivePrimaryActions(brand) {
    const type = brand.businessType;
    
    const ACTIONS_BY_TYPE = {
      product_brand:      [{ label: 'Shop now',      intent: 'purchase' }],
      restaurant:         [{ label: 'Reserve table', intent: 'booking' }],
      cafe:               [{ label: 'Order now',     intent: 'purchase' }],
      clinic_medical:     [{ label: 'Book consultation', intent: 'booking' }],
      clinic_dental:      [{ label: 'Book appointment',  intent: 'booking' }],
      clinic_cosmetic:    [{ label: 'Book free consultation', intent: 'lead' }],
      real_estate:        [{ label: 'View listings',    intent: 'browse' }],
      fitness_gym:        [{ label: 'Claim free trial', intent: 'lead' }],
      saas_b2b:           [{ label: 'Start free trial', intent: 'signup' }],
      marketing_agency:   [{ label: 'Request proposal', intent: 'lead' }],
    };
    
    return ACTIONS_BY_TYPE[type] || [{ label: 'Learn more', intent: 'general' }];
  }
  
  function sanitizeHeadlines(headlines) {
    // Apply the filter we discussed — strip nav/chrome boilerplate
    const BOILERPLATE = new Set([
      'country/region', 'search', 'shopping cart', 'quick links', 'menu',
      'account', 'sign in', 'login', 'register', 'subscribe', 'newsletter',
      'home', 'shop', 'products', 'cart', 'checkout', 'connectivity',
      'support', 'help', 'faq', 'privacy policy', 'terms', 'returns',
      'shipping', 'currency', 'language', 'about', 'about us', 'contact',
    ]);
    
    return headlines
      .filter(h => h && h.trim().length > 5)
      .filter(h => !BOILERPLATE.has(h.toLowerCase().trim()))
      .filter(h => h.length < 200)
      .slice(0, 20);
  }
  
  module.exports = { serializeToScanSnapshot };