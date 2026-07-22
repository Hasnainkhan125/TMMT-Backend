// services/urlToAds/competitorSeeder.js
// Seeds curated competitors based on business type.
// Placeholder for Layer 2's real competitor discovery.

const COMPETITORS_BY_TYPE = {
    product_brand: [
      { name: 'Amazon.ae',     url: 'https://amazon.ae',     tagline: 'Largest marketplace in the UAE',                category: 'retailer', region: 'gulf' },
      { name: 'Noon',          url: 'https://noon.com',      tagline: 'Home-grown Gulf ecommerce',                     category: 'retailer', region: 'gulf' },
      { name: 'Namshi',        url: 'https://namshi.com',    tagline: 'Fashion and lifestyle leader',                  category: 'fashion',  region: 'gulf' },
      { name: 'Centrepoint',   url: 'https://centrepoint.com', tagline: 'Family department store chain',               category: 'retailer', region: 'gulf' },
    ],
    restaurant: [
      { name: 'Talabat',       url: 'https://talabat.com',    tagline: 'Food delivery across MENA',                    category: 'delivery', region: 'gulf' },
      { name: 'Careem Food',   url: 'https://careem.com',     tagline: 'Super app delivery',                          category: 'delivery', region: 'gulf' },
      { name: 'Deliveroo UAE', url: 'https://deliveroo.ae',   tagline: 'Premium food delivery',                       category: 'delivery', region: 'gulf' },
      { name: 'Zomato',        url: 'https://zomato.com',     tagline: 'Reviews and discovery',                       category: 'discovery',region: 'global' },
    ],
    clinic_cosmetic: [
      { name: 'The Harley Medical Group', url: 'https://harleymedical.co.uk', tagline: 'UK cosmetic leader',          category: 'clinic', region: 'global' },
      { name: 'Euromed Clinic Dubai',     url: 'https://euromedclinicdubai.com', tagline: 'Dubai premium aesthetics',  category: 'clinic', region: 'gulf' },
      { name: 'Kaya Skin Clinic',         url: 'https://kaya.ae',              tagline: 'Skincare chain Gulf-wide',   category: 'clinic', region: 'gulf' },
      { name: 'Biolite',                  url: 'https://biolite.ae',           tagline: 'Medical aesthetics Dubai',   category: 'clinic', region: 'gulf' },
    ],
    real_estate: [
      { name: 'Property Finder', url: 'https://propertyfinder.ae', tagline: 'UAE largest listings',                    category: 'marketplace', region: 'gulf' },
      { name: 'Bayut',           url: 'https://bayut.com',         tagline: 'Property portal Gulf-wide',              category: 'marketplace', region: 'gulf' },
      { name: 'Emaar',           url: 'https://emaar.com',         tagline: 'Dubai master developer',                 category: 'developer',   region: 'gulf' },
      { name: 'Damac',           url: 'https://damacproperties.com', tagline: 'Luxury developer',                     category: 'developer',   region: 'gulf' },
    ],
    marketing_agency: [
      { name: 'BPG Group',       url: 'https://bpggroup.com',     tagline: 'Middle East agency network',             category: 'agency', region: 'gulf' },
      { name: 'Memac Ogilvy',    url: 'https://memacogilvy.com',  tagline: 'Legacy Dubai agency',                    category: 'agency', region: 'gulf' },
      { name: 'Create Media',    url: 'https://createmediagroup.com', tagline: 'Full-service Gulf agency',           category: 'agency', region: 'gulf' },
      { name: 'Wunderman Thompson', url: 'https://wundermanthompson.com', tagline: 'Global creative network',         category: 'agency', region: 'global' },
    ],
    fitness_gym: [
      { name: 'Fitness First UAE',  url: 'https://fitnessfirstme.com', tagline: 'Largest chain in the Gulf',          category: 'gym', region: 'gulf' },
      { name: 'Gold\'s Gym UAE',    url: 'https://goldsgym.ae',        tagline: 'Classic strength-focused',           category: 'gym', region: 'gulf' },
      { name: 'Warehouse Gym',      url: 'https://warehousegym.com',   tagline: 'Premium Dubai facility',             category: 'gym', region: 'gulf' },
      { name: 'Crank',              url: 'https://crank.fitness',      tagline: 'Boutique cycling studio',            category: 'studio', region: 'gulf' },
    ],
    saas_b2b: [
      { name: 'Zoho',        url: 'https://zoho.com',       tagline: 'B2B suite for SMEs',              category: 'saas', region: 'global' },
      { name: 'Freshworks',  url: 'https://freshworks.com', tagline: 'Customer engagement suite',       category: 'saas', region: 'global' },
      { name: 'Tamatem',     url: 'https://tamatem.co',     tagline: 'Arabic mobile platform',          category: 'saas', region: 'gulf' },
      { name: 'Alvys',       url: 'https://alvys.com',      tagline: 'SME ERP',                         category: 'saas', region: 'global' },
    ],
    
    // Default fallback
    general_business: [
      { name: 'LinkedIn',   url: 'https://linkedin.com',   tagline: 'Professional network',            category: 'network', region: 'global' },
      { name: 'Instagram',  url: 'https://instagram.com',  tagline: 'Visual discovery',                category: 'social',  region: 'global' },
      { name: 'TikTok',     url: 'https://tiktok.com',     tagline: 'Short-form video leader',        category: 'social',  region: 'global' },
      { name: 'Google',     url: 'https://google.com',     tagline: 'Discovery + intent',              category: 'search',  region: 'global' },
    ],
  };
  
  function getCuratedCompetitors(businessType, markets = ['AE']) {
    const competitors = COMPETITORS_BY_TYPE[businessType] || COMPETITORS_BY_TYPE.general_business;
    
    // Prioritize Gulf competitors when user's market is Gulf
    const isGulfMarket = markets.some(m => ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'].includes(m));
    
    if (isGulfMarket) {
      return [...competitors].sort((a, b) => {
        if (a.region === 'gulf' && b.region !== 'gulf') return -1;
        if (a.region !== 'gulf' && b.region === 'gulf') return 1;
        return 0;
      });
    }
    
    return competitors;
  }
  
  module.exports = { getCuratedCompetitors };