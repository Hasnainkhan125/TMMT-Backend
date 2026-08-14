'use strict';

/**
 * businessProfileInference — heuristic classifier for URL→Ads scans.
 *
 * Order of evidence (most to least authoritative):
 *   1. Strong product-catalog signals (Shopify/Woo + priced rows ≥ 5)
 *      → ecommerce_*  subtype derived from research.brand.category
 *   2. research.brand.category / .subcategory keywords (Anthropic already
 *      classified the page — trust it before re-running fuzzy LLM logic)
 *   3. Regex rules over the page text (last-resort heuristic)
 *
 * Complements aiResearch (Claude) without an extra LLM round-trip: we fuse
 * scrape signals + research.brand fields into a polymorphic `businessProfile`
 * the UI and prompt builder can treat like a discriminator.
 *
 * When research is null (API key missing / failure), scrape text alone still
 * yields a reasonable `general_business` vs `product_brand` split.
 */

const DEFAULT_TYPE = 'general_business';

// ── Enterprise / B2B type ─────────────────────────────────────────────────
// Added for sovereign energy companies (ADNOC, Aramco, QatarEnergy),
// financial institutions, government entities, telecom, logistics, etc.
// These were previously misclassified as ecommerce_general because:
//   1. None of the existing keyword matches fired on "integrated energy conglomerate"
//   2. The code fell through to regex which saw "shop"/"store"-adjacent CTAs
// Fix: explicit enterprise patterns in classifyType + catch-all at end of the
// ai-category block so we never fall through to ecommerce_general when AI told us better.

const TYPE_RULES = [
  {
    type: 'clinic_dental',
    weight: 3,
    re: /dental|dentist|orthodont|invisalign|veneer|smile\s*clinic|teeth\s*whitening/i,
  },
  {
    type: 'clinic_cosmetic',
    weight: 3,
    re: /derma|dermatolog|skin\s*clinic|botox|filler|laser\s*hair|cosmetic\s*surgery|plastic\s*surgery/i,
  },
  {
    type: 'clinic_medical',
    weight: 3,
    re: /clinic|hospital|medical\s*center|physician|doctor|patient|ivf|fertility|pediatric/i,
  },
  {
    type: 'clinic_wellness',
    weight: 4,
    re: /wellness\s*clinic|holistic\s*health|iv\s*drip|vitamin\s*infusion|recovery\s*studio/i,
  },
  {
    type: 'restaurant',
    weight: 3,
    re: /restaurant|dining|chef|menu|reservation|bistro|steakhouse|cuisine|kitchen/i,
  },
  {
    type: 'cafe',
    weight: 2,
    re: /\bcafe\b|\bcoffee\b|espresso|roastery|bakery/i,
  },
  {
    type: 'real_estate',
    weight: 3,
    re: /real\s*estate|property|broker|villa|apartment|off-plan|listing|sq\.?\s*ft|handover/i,
  },
  {
    type: 'law_firm',
    weight: 3,
    re: /law\s*firm|attorney|solicitor|legal\s*services|litigation|advocates/i,
  },
  {
    type: 'accounting',
    weight: 2,
    re: /accounting|audit|bookkeeping|vat\s*return|cfo\s*services/i,
  },
  {
    type: 'consulting',
    weight: 2,
    re: /consulting|advisory|strategy\s*firm|management\s*consult/i,
  },
  {
    type: 'fitness_gym',
    weight: 2,
    re: /\bgym\b|fitness\s*center|crossfit|membership|weight\s*room/i,
  },
  {
    type: 'fitness_coach',
    weight: 2,
    re: /personal\s*trainer|online\s*coach|transformation\s*program|calorie|macro/i,
  },
  {
    type: 'education_academic',
    weight: 2,
    re: /university|school|tutoring|curriculum|admissions|academy/i,
  },
  {
    type: 'education_coaching',
    weight: 2,
    re: /course|cohort|masterclass|bootcamp|certification|learn\s*online/i,
  },
  {
    type: 'hospitality_hotel',
    weight: 2,
    re: /hotel|resort|suites|check-in|staycation|hospitality/i,
  },
  {
    type: 'hospitality_experience',
    weight: 2,
    re: /safari|desert\s*tour|yacht\s*charter|experience\s*package/i,
  },
  {
    type: 'saas_b2b',
    weight: 2,
    re: /b2b|enterprise|api\s*access|sso|soc\s*2|salesforce|integration|dashboard\s*for\s*teams/i,
  },
  {
    type: 'saas_b2c',
    weight: 2,
    re: /\bsaas\b|subscription|free\s*trial|per\s*month|cloud\s*app|mobile\s*app/i,
  },
  {
    type: 'automotive',
    weight: 2,
    re: /dealership|detailing|car\s*rental|auto\s*service|showroom|vehicle/i,
  },
  {
    type: 'events_wedding',
    weight: 2,
    re: /wedding|event\s*planner|bridal|venue\s*hire|corporate\s*events/i,
  },
  {
    type: 'beauty_salon',
    weight: 2,
    // Word boundaries on 'spa', 'mani', 'pedi', 'nails' prevent false positives
    // on words like "dispatcher", "specialized", "manicotti", "pediatric"
    re: /salon|\bnails\b|hair\s*studio|\bspa\b|blowout|\bmani\b|\bpedi\b/i,
  },
  {
    type: 'ecommerce_electronics',
    weight: 3,
    re: /\blaptop|\bsmartphone|\bgadget|\belectronic|\bappliance|tech\s*store|mobile\s*phone|tablet/i,
  },
  {
    type: 'health_retail',
    weight: 3,
    re: /pharmacy|pharmacare|drugstore|chemist|\botc\s*medicine|\bprescription\s*delivery|otc\s*drug/i,
  },
  {
    type: 'ecommerce_general',
    weight: 2,
    re: /online\s*store|e-commerce|ecommerce|add\s*to\s*cart|checkout|free\s*delivery|shop\s*now/i,
  },
  {
    type: 'enterprise_b2b',
    weight: 4,
    re: /\benergy\b|oil\s*(?:&|and)\s*gas|petroleum|natural\s*gas|lng|lpg|refinery|upstream|downstream|midstream|conglomerate|sovereign\s*fund|state[- ]owned/i,
  },
];

const AD_STRATEGY = {
  product_brand: {
    winningAngles: ['lifestyle', 'product_hero', 'social_proof'],
    avoidAngles: ['fake_urgency', 'medical_claims'],
    testimonialStyle: 'quote',
    funnelShape: 'direct_sale',
  },
  ecommerce_general: {
    winningAngles: ['product_hero', 'price_anchor', 'fast_shipping', 'social_proof'],
    avoidAngles: ['fake_urgency', 'unverifiable_discounts'],
    testimonialStyle: 'star_rating',
    funnelShape: 'direct_sale',
  },
  ecommerce_electronics: {
    winningAngles: ['product_hero', 'spec_compare', 'authentic_warranty', 'installment_finance', 'fast_delivery'],
    avoidAngles: ['fake_urgency', 'gray_market_innuendo'],
    testimonialStyle: 'verified_buyer',
    funnelShape: 'direct_sale',
  },
  ecommerce_fashion: {
    winningAngles: ['lifestyle_hero', 'drop_release', 'styling_tips', 'social_proof'],
    avoidAngles: ['unflattering_compare'],
    testimonialStyle: 'ugc_quote',
    funnelShape: 'direct_sale',
  },
  ecommerce_beauty: {
    winningAngles: ['before_after_subtle', 'ingredient_story', 'routine', 'creator_demo'],
    avoidAngles: ['unverified_medical_claims', 'guaranteed_results'],
    testimonialStyle: 'transformation',
    funnelShape: 'direct_sale',
  },
  ecommerce_grocery: {
    winningAngles: ['fresh_today', 'time_saving', 'family_value', 'local_origin'],
    avoidAngles: ['health_overclaims'],
    testimonialStyle: 'quote',
    funnelShape: 'direct_sale',
  },
  ecommerce_home: {
    winningAngles: ['room_setting', 'before_after_space', 'craft_detail', 'free_install'],
    avoidAngles: ['fake_urgency'],
    testimonialStyle: 'quote',
    funnelShape: 'direct_sale',
  },
  marketing_agency: {
    winningAngles: ['case_study', 'roi_story', 'method_framework', 'social_proof'],
    avoidAngles: ['guaranteed_rankings', 'income_claims_without_disclaimer'],
    testimonialStyle: 'case_study',
    funnelShape: 'consultation',
  },
  clinic_dental: {
    winningAngles: ['trust', 'credentials', 'booking'],
    avoidAngles: ['guaranteed_results', 'before_after_without_disclaimer'],
    testimonialStyle: 'transformation',
    funnelShape: 'booking',
  },
  clinic_cosmetic: {
    winningAngles: ['trust', 'subtle_transformation', 'consultation'],
    avoidAngles: ['unverified_medical_claims'],
    testimonialStyle: 'case_study',
    funnelShape: 'consultation',
  },
  clinic_medical: {
    winningAngles: ['care_quality', 'team', 'safety'],
    avoidAngles: ['disease_cures', 'fear_based_messaging'],
    testimonialStyle: 'quote',
    funnelShape: 'booking',
  },
  clinic_wellness: {
    winningAngles: ['vitality', 'routine', 'professional_care'],
    avoidAngles: ['medical_diagnosis_claims'],
    testimonialStyle: 'quote',
    funnelShape: 'booking',
  },
  restaurant: {
    winningAngles: ['food_hero', 'ambiance', 'reservation'],
    avoidAngles: ['fake_discounts'],
    testimonialStyle: 'quote',
    funnelShape: 'booking',
  },
  cafe: {
    winningAngles: ['ambiance', 'craft', 'community'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'direct_sale',
  },
  real_estate: {
    winningAngles: ['location', 'trust', 'lifestyle'],
    avoidAngles: ['guaranteed_roi'],
    testimonialStyle: 'case_study',
    funnelShape: 'lead_gen',
  },
  law_firm: {
    winningAngles: ['authority', 'outcomes', 'discretion'],
    avoidAngles: ['guaranteed_win'],
    testimonialStyle: 'case_study',
    funnelShape: 'consultation',
  },
  accounting: {
    winningAngles: ['compliance', 'peace_of_mind', 'clarity'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'lead_gen',
  },
  consulting: {
    winningAngles: ['expertise', 'framework', 'roi_story'],
    avoidAngles: [],
    testimonialStyle: 'case_study',
    funnelShape: 'consultation',
  },
  fitness_gym: {
    winningAngles: ['community', 'equipment', 'trial'],
    avoidAngles: [],
    testimonialStyle: 'transformation',
    funnelShape: 'booking',
  },
  fitness_coach: {
    winningAngles: ['transformation', 'accountability', 'program'],
    avoidAngles: ['income_claims_without_disclaimer'],
    testimonialStyle: 'transformation',
    funnelShape: 'booking',
  },
  education_academic: {
    winningAngles: ['outcomes', 'credibility', 'peers'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'lead_gen',
  },
  education_coaching: {
    winningAngles: ['results', 'curriculum', 'social_proof'],
    avoidAngles: [],
    testimonialStyle: 'case_study',
    funnelShape: 'lead_gen',
  },
  hospitality_hotel: {
    winningAngles: ['experience', 'amenities', 'location'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'booking',
  },
  hospitality_experience: {
    winningAngles: ['adventure', 'memory', 'seasonal'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'booking',
  },
  saas_b2b: {
    winningAngles: ['roi', 'workflow', 'security'],
    avoidAngles: [],
    testimonialStyle: 'case_study',
    funnelShape: 'lead_gen',
  },
  saas_b2c: {
    winningAngles: ['speed', 'delight', 'habit'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'direct_sale',
  },
  health_retail: {
    winningAngles: ['speed_delivery', 'breadth_range', 'trust_authority', 'social_proof'],
    avoidAngles: ['medical_overclaims', 'unverified_cures'],
    testimonialStyle: 'verified_buyer',
    funnelShape: 'direct_sale',
  },
  automotive: {
    winningAngles: ['hero_vehicle', 'service_trust', 'offer'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'lead_gen',
  },
  events_wedding: {
    winningAngles: ['aspiration', 'seasonal', 'portfolio'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'consultation',
  },
  beauty_salon: {
    winningAngles: ['look', 'self_care', 'booking'],
    avoidAngles: [],
    testimonialStyle: 'transformation',
    funnelShape: 'booking',
  },
  enterprise_b2b: {
    winningAngles: ['scale', 'track_record', 'partnership', 'innovation', 'authority'],
    avoidAngles: ['consumer_discounts', 'urgency_scarcity', 'price_anchor'],
    testimonialStyle: 'case_study',
    funnelShape: 'relationship',
  },
  general_business: {
    winningAngles: ['clarity', 'trust', 'offer'],
    avoidAngles: [],
    testimonialStyle: 'quote',
    funnelShape: 'lead_gen',
  },
};

function corpus(scrape, research) {
  const parts = [
    research?.brand?.name,
    research?.brand?.category,
    research?.brand?.subcategory,
    research?.brand?.summary,
    research?.brand?.oneLiner,
    ...(research?.brand?.keywords || []),
    ...(research?.brand?.valueProps || []),
    scrape?.brandName,
    scrape?.category,
    scrape?.description,
    ...(scrape?.headlines || []),
    ...(scrape?.paragraphs || []).slice(0, 4),
  ].filter(Boolean);
  return parts.join(' ').toLowerCase();
}

function primaryActionsFor(type, brandName) {
  const b = brandName || 'us';
  const map = {
    clinic_dental: [
      { label: 'Book a consultation', intent: 'booking' },
      { label: 'Meet the dentists', intent: 'trust' },
    ],
    clinic_cosmetic: [
      { label: 'Book a consult', intent: 'consultation' },
      { label: 'View treatments', intent: 'learn' },
    ],
    clinic_medical: [
      { label: 'Book an appointment', intent: 'booking' },
      { label: 'Contact care team', intent: 'lead' },
    ],
    clinic_wellness: [
      { label: 'Book a session', intent: 'booking' },
      { label: 'View programs', intent: 'learn' },
    ],
    restaurant: [
      { label: 'Reserve a table', intent: 'booking' },
      { label: 'View menu', intent: 'learn' },
    ],
    cafe: [
      { label: 'Order pickup', intent: 'direct' },
      { label: 'Visit us', intent: 'location' },
    ],
    real_estate: [
      { label: 'Schedule a viewing', intent: 'booking' },
      { label: 'Get a valuation', intent: 'lead' },
    ],
    law_firm: [
      { label: 'Request consultation', intent: 'consultation' },
      { label: `Speak with ${b}`, intent: 'lead' },
    ],
    accounting: [
      { label: 'Book a discovery call', intent: 'consultation' },
      { label: 'Get a quote', intent: 'lead' },
    ],
    consulting: [
      { label: 'Book strategy call', intent: 'consultation' },
      { label: 'Download overview', intent: 'lead' },
    ],
    fitness_gym: [
      { label: 'Start free trial', intent: 'booking' },
      { label: 'View membership', intent: 'learn' },
    ],
    fitness_coach: [
      { label: 'Book a session', intent: 'booking' },
      { label: 'See programs', intent: 'learn' },
    ],
    education_academic: [
      { label: 'Apply now', intent: 'lead' },
      { label: 'Book a tour', intent: 'booking' },
    ],
    education_coaching: [
      { label: 'Join the cohort', intent: 'direct' },
      { label: 'Get syllabus', intent: 'lead' },
    ],
    hospitality_hotel: [
      { label: 'Check availability', intent: 'booking' },
      { label: 'View suites', intent: 'learn' },
    ],
    hospitality_experience: [
      { label: 'Book experience', intent: 'booking' },
      { label: 'See itinerary', intent: 'learn' },
    ],
    saas_b2b: [
      { label: 'Book a demo', intent: 'consultation' },
      { label: 'Talk to sales', intent: 'lead' },
    ],
    saas_b2c: [
      { label: 'Start free trial', intent: 'direct' },
      { label: 'See pricing', intent: 'learn' },
    ],
    health_retail: [
      { label: 'Order now', intent: 'direct' },
      { label: 'Shop vitamins & wellness', intent: 'learn' },
    ],
    automotive: [
      { label: 'Book test drive', intent: 'booking' },
      { label: 'View inventory', intent: 'learn' },
    ],
    events_wedding: [
      { label: 'Check dates', intent: 'consultation' },
      { label: 'Get proposal', intent: 'lead' },
    ],
    beauty_salon: [
      { label: 'Book appointment', intent: 'booking' },
      { label: 'See services', intent: 'learn' },
    ],
    product_brand: [
      { label: 'Shop the collection', intent: 'direct' },
      { label: 'Discover ' + b, intent: 'learn' },
    ],
    ecommerce_general: [
      { label: 'Shop now', intent: 'direct' },
      { label: 'View all products', intent: 'learn' },
    ],
    ecommerce_electronics: [
      { label: 'Shop now', intent: 'direct' },
      { label: 'See installment options', intent: 'learn' },
    ],
    ecommerce_fashion: [
      { label: 'Shop the drop', intent: 'direct' },
      { label: 'Browse collection', intent: 'learn' },
    ],
    ecommerce_beauty: [
      { label: 'Shop now', intent: 'direct' },
      { label: 'See ingredients', intent: 'learn' },
    ],
    ecommerce_grocery: [
      { label: 'Order now', intent: 'direct' },
      { label: 'See same-day slots', intent: 'learn' },
    ],
    ecommerce_home: [
      { label: 'Shop the room', intent: 'direct' },
      { label: 'Get a free quote', intent: 'lead' },
    ],
    marketing_agency: [
      { label: 'Book a strategy call', intent: 'consultation' },
      { label: 'See case studies', intent: 'learn' },
    ],
    enterprise_b2b: [
      { label: 'Partner with us', intent: 'lead' },
      { label: 'Contact investor relations', intent: 'lead' },
    ],
    general_business: [
      { label: 'Get started', intent: 'lead' },
      { label: 'Learn more', intent: 'learn' },
    ],
  };
  return map[type] || map.general_business;
}

function regexPick(text, hasProductRows) {
  let best = { type: DEFAULT_TYPE, score: 0 };
  for (const rule of TYPE_RULES) {
    if (rule.re.test(text)) {
      const s = rule.weight;
      if (s > best.score) best = { type: rule.type, score: s };
    }
  }
  if (best.score === 0 && hasProductRows) {
    return { type: 'product_brand', confidence: 0.72 };
  }
  if (best.score === 0 && /\b(shop|store|cart|checkout|buy\s+now|new\s+arrival)\b/i.test(text)) {
    return { type: 'product_brand', confidence: 0.58 };
  }
  const confidence = Math.min(0.95, 0.5 + best.score * 0.12);
  return { type: best.type, confidence: best.score ? confidence : 0.42 };
}

/**
 * Decide an ecommerce_* subtype from AI category text.
 * Returns null when nothing matches — caller falls back to ecommerce_general.
 */
function pickEcommerceSubtype(combined) {
  if (!combined) return 'ecommerce_general';
  if (/electronic|tech|gadget|laptop|smartphone|computer|apple|samsung|xiaomi|huawei|honor|console|appliance/i.test(combined)) return 'ecommerce_electronics';
  if (/fashion|clothing|apparel|shoe|sneaker|denim|outfit|wear/i.test(combined)) return 'ecommerce_fashion';
  if (/beauty|skincare|cosmetic|makeup|fragrance|perfume/i.test(combined)) return 'ecommerce_beauty';
  if (/grocery|supermarket|food\s*delivery|fresh\s*produce|pantry|household\s*essentials/i.test(combined)) return 'ecommerce_grocery';
  if (/furniture|home\s*decor|home\s*goods|kitchen|bedding|mattress|appliance/i.test(combined)) return 'ecommerce_home';
  return 'ecommerce_general';
}

/**
 * Strong-signal classifier. Trusts evidence in this order:
 *   - Shopify/Woo + ≥5 priced products → ecommerce_*
 *   - AI brand.category / .subcategory keywords (Anthropic already classified)
 *   - regex fallback over the full corpus
 */
function classifyType(scrape, research) {
  const aiCategory = (research?.brand?.category || '').toLowerCase();
  const aiSub = (research?.brand?.subcategory || '').toLowerCase();
  const combined = `${aiCategory} ${aiSub}`.trim();

  const platform = String(scrape?.productCatalog?.platform || '').toLowerCase();
  const products = Array.isArray(scrape?.productCatalog?.products)
    ? scrape.productCatalog.products
    : [];
  const priced = products.filter((p) => Number(p?.price) > 0);
  const hasProductCatalog =
    products.length >= 5 && (priced.length >= 3 || /shopify|woocommerce|magento|bigcommerce/.test(platform));

  if (hasProductCatalog) {
    return {
      type: pickEcommerceSubtype(combined || `${scrape?.description || ''} ${scrape?.headlines?.join(' ') || ''}`),
      confidence: 0.92,
      reason: 'product_catalog',
    };
  }

  if (combined) {
    // Electronics / tech retail — check FIRST because category text like "electronics retailer"
    // or "technology store" must not fall through to beauty_salon or general_business.
    if (/electronic|tech\s*store|gadget|laptop|smartphone|mobile\s*phone|appliance|computer\s*store/.test(combined)) {
      return { type: 'ecommerce_electronics', confidence: 0.88, reason: 'ai_category' };
    }
    if (/dental|dentist|orthodont|invisalign/.test(combined)) return { type: 'clinic_dental', confidence: 0.9, reason: 'ai_category' };
    if (/clinic|cosmetic|aesthetic|derma|botox|laser/.test(combined) && /(beauty|skin|nail|hair|cosmetic|aesthetic)/.test(combined)) {
      return { type: 'clinic_cosmetic', confidence: 0.88, reason: 'ai_category' };
    }
    if (/clinic|medical|hospital|physician|doctor|patient/.test(combined)) return { type: 'clinic_medical', confidence: 0.85, reason: 'ai_category' };
    if (/restaurant|dining|chef|cuisine|cafe|bistro|kitchen/.test(combined)) return { type: 'restaurant', confidence: 0.88, reason: 'ai_category' };
    if (/real\s*estate|property|broker/.test(combined)) return { type: 'real_estate', confidence: 0.92, reason: 'ai_category' };
    if (/(marketing|creative|advertising|branding)\s*(agency|studio|firm)?/.test(combined)) return { type: 'marketing_agency', confidence: 0.85, reason: 'ai_category' };
    if (/saas|software|platform|api|developer\s*tool/.test(combined)) return { type: 'saas_b2b', confidence: 0.82, reason: 'ai_category' };
    if (/pharmacy|pharmacare|drugstore|chemist|otc\s*medicine|prescription\s*delivery/.test(combined)) return { type: 'health_retail', confidence: 0.90, reason: 'ai_category' };
    if (/automotive|car|vehicle|dealership/.test(combined)) return { type: 'automotive', confidence: 0.85, reason: 'ai_category' };
    if (/(fitness|gym|trainer|wellness)/.test(combined)) {
      if (/gym|studio|center/.test(combined)) return { type: 'fitness_gym', confidence: 0.85, reason: 'ai_category' };
      return { type: 'fitness_coach', confidence: 0.78, reason: 'ai_category' };
    }
    if (/hotel|resort|hospitality|stay/.test(combined)) return { type: 'hospitality_hotel', confidence: 0.85, reason: 'ai_category' };
    if (/law|attorney|legal|advocate/.test(combined)) return { type: 'law_firm', confidence: 0.88, reason: 'ai_category' };
    if (/accounting|audit|bookkeeping|tax\s*service/.test(combined)) return { type: 'accounting', confidence: 0.85, reason: 'ai_category' };
    if (/consulting|advisor|advisory/.test(combined)) return { type: 'consulting', confidence: 0.82, reason: 'ai_category' };
    if (/wedding|event\s*planner|bridal/.test(combined)) return { type: 'events_wedding', confidence: 0.85, reason: 'ai_category' };
    if (/(university|school|tutoring|academy|admissions)/.test(combined)) return { type: 'education_academic', confidence: 0.82, reason: 'ai_category' };
    if (/(course|cohort|masterclass|bootcamp|certification)/.test(combined)) return { type: 'education_coaching', confidence: 0.78, reason: 'ai_category' };
    if (/(beauty\s*salon|nail\s*salon|hair\s*studio|spa)/.test(combined)) return { type: 'beauty_salon', confidence: 0.85, reason: 'ai_category' };
    if (/(ecommerce|e-commerce|online\s*store|online\s*retailer|marketplace)/.test(combined)) {
      return { type: pickEcommerceSubtype(combined), confidence: 0.78, reason: 'ai_category' };
    }

    // ── Enterprise / B2B catch — must come BEFORE the generic shop/store match ──
    // These categories previously fell through to ecommerce_general because the
    // regex chain below picked up "shop" CTAs from enterprise homepages.
    if (/energy|oil\s*(?:&|and)\s*gas|petroleum|natural\s*gas|lng|lpg|refinery|upstream|downstream|midstream|conglomerate|sovereign/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.88, reason: 'ai_category' };
    }
    if (/bank|banking|financial\s*institution|fintech|investment\s*bank|asset\s*management|fund\s*management|insurance|capital\s*markets|wealth\s*management/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.88, reason: 'ai_category' };
    }
    if (/government|ministry|sovereign|state[\s-]owned|public\s*sector|municipality|federal|national\s*authority|regulatory/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.85, reason: 'ai_category' };
    }
    if (/telecom|telecommunications|mobile\s*network|internet\s*service\s*provider|isp|broadband/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.83, reason: 'ai_category' };
    }
    if (/logistics|supply\s*chain|freight|shipping\s*company|cargo|transport\s*company|aviation|airline|port\s*operator/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.83, reason: 'ai_category' };
    }
    if (/construction|infrastructure|engineering\s*firm|general\s*contractor|epc\b|industrial/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.83, reason: 'ai_category' };
    }
    if (/manufacturing|factory|production\s*company|materials\s*company/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.80, reason: 'ai_category' };
    }
    if (/media|broadcasting|news\s*agency|publishing|newspaper|television\s*channel|radio\s*station/.test(combined)) {
      return { type: 'enterprise_b2b', confidence: 0.78, reason: 'ai_category' };
    }

    // ── Catch-all: AI gave us a real category but nothing above matched ──
    // Return general_business — NOT ecommerce_general.
    // Falling through to regexPick() when AI already told us the category is wrong
    // because regexPick reads site HTML that may have "shop"/"order" CTAs unrelated
    // to the brand's primary business (e.g. ADNOC has a merchandise store section).
    return { type: 'general_business', confidence: 0.55, reason: 'ai_category_unmatched' };
  }

  const text = corpus(scrape, research);
  const fallback = regexPick(text, products.length > 0);
  return { ...fallback, reason: 'regex_fallback' };
}

function buildAssets(type, scrape, research) {
  const products = (scrape?.productCatalog?.products || []).slice(0, 12);
  const isEcom = type.startsWith('ecommerce_');
  if (products.length && (isEcom || type === 'product_brand' || type === 'general_business')) {
    return {
      kind: 'product_catalog',
      products: products.map((p) => ({
        title: p.title,
        price: p.price,
        image: p.image || null,
      })),
    };
  }

  if (type === 'restaurant' || type === 'cafe') {
    const cuisine =
      research?.brand?.subcategory ||
      research?.brand?.category ||
      scrape?.category ||
      '';
    return {
      kind: 'restaurant_menu',
      dishes: [],
      cuisineType: cuisine,
      ambiance: research?.brand?.vibe || '',
    };
  }

  if (
    type.startsWith('clinic_') ||
    type === 'beauty_salon' ||
    type === 'fitness_coach' ||
    type === 'fitness_gym'
  ) {
    const services = (research?.brand?.valueProps || research?.brand?.keywords || [])
      .slice(0, 12)
      .map((s) => ({ name: String(s), description: '' }));
    return {
      kind: 'service_menu',
      services,
      practitioners: [],
    };
  }

  if (type === 'real_estate') {
    return {
      kind: 'real_estate',
      listings: [],
      areas: (research?.targetAudience?.digitalWateringHoles || []).slice(0, 6).map(String),
    };
  }

  if (type === 'law_firm' || type === 'accounting' || type === 'consulting' || type === 'marketing_agency') {
    return {
      kind: 'professional_services',
      expertise: (research?.brand?.keywords || []).slice(0, 10).map(String),
      credentials: [],
      caseStudies: [],
    };
  }

  if (type === 'education_academic' || type === 'education_coaching') {
    return {
      kind: 'education',
      courses: (research?.brand?.valueProps || []).slice(0, 8).map((x) => ({ title: String(x) })),
      outcomes: (research?.targetAudience?.jobsToBeDone || []).slice(0, 6).map(String),
    };
  }

  if (type === 'hospitality_hotel' || type === 'hospitality_experience') {
    return {
      kind: 'hospitality',
      experiences: (research?.brand?.valueProps || []).slice(0, 8).map(String),
      amenities: (research?.brand?.keywords || []).slice(0, 8).map(String),
    };
  }

  if (type === 'saas_b2b' || type === 'saas_b2c') {
    return {
      kind: 'general_business',
      offerings: (research?.brand?.valueProps || []).slice(0, 10).map(String),
    };
  }

  return {
    kind: 'general_business',
    offerings: (research?.brand?.keywords || []).slice(0, 10).map(String),
  };
}

function inferSubtype(type, research, scrape) {
  if (type.startsWith('ecommerce_')) {
    const cat = research?.brand?.category || scrape?.category || '';
    return cat ? deriveSubtype(cat, type) : type.replace('ecommerce_', '');
  }
  const cat = `${research?.brand?.category || ''} ${scrape?.category || ''}`.trim();
  if (!cat) return '';
  return deriveSubtype(cat, type);
}

/**
 * @param {object|null} scrape - urlScraper payload
 * @param {object|null} research - aiResearch payload
 */
function inferBusinessProfile(scrape, research) {
  const { type, confidence } = classifyType(scrape, research);

  let resolvedType = type;
  const text = corpus(scrape, research);
  if (resolvedType === 'clinic_medical' && /dental|dentist/.test(text)) resolvedType = 'clinic_dental';
  if (resolvedType === 'clinic_medical' && /derma|cosmetic|botox|laser/.test(text)) resolvedType = 'clinic_cosmetic';

  const brandName = research?.brand?.name || scrape?.brandName || '';
  const businessAssets = buildAssets(resolvedType, scrape, research);

  return {
    type: resolvedType,
    confidence,
    subtype: inferSubtype(resolvedType, research, scrape),
    brandIdentity: {
      name: brandName,
      tagline: research?.brand?.oneLiner || '',
      positioning: research?.brand?.summary || scrape?.description || '',
      palette: research?.brand?.palette || [],
      fonts: scrape?.fonts || [],
      tone: research?.brand?.tone || '',
      values: (research?.brand?.valueProps || []).slice(0, 6),
      emotionalAnchors: (research?.targetAudience?.buyingTriggers || []).slice(0, 6).map(String),
    },
    businessAssets,
    primaryActions: primaryActionsFor(resolvedType, brandName),
    adStrategy: AD_STRATEGY[resolvedType] || AD_STRATEGY.general_business,
    safetyNotes: safetyNotesFor(resolvedType),
  };
}

function safetyNotesFor(type) {
  if (type.startsWith('clinic_')) {
    return ['medical_claims_review', 'uae_health_advertising_compliance'];
  }
  if (type === 'fitness_coach' || type === 'education_coaching') {
    return ['income_result_claims_disclaimer'];
  }
  if (type === 'ecommerce_electronics') {
    return ['authenticity_warranty_disclosure'];
  }
  if (type === 'ecommerce_beauty') {
    return ['cosmetic_results_disclaimer'];
  }
  if (type === 'enterprise_b2b') {
    return ['no_consumer_price_anchoring', 'regulatory_compliance_check'];
  }
  return [];
}

/**
 * Short clause for adBrain / blueprint prompts (plain text).
 */
function formatBusinessContextForPrompt(bp) {
  if (!bp?.businessAssets) return '';
  const { kind } = bp.businessAssets;
  const type = bp.type || '';

  if (kind === 'product_catalog' && bp.businessAssets.products?.length) {
    const titles = bp.businessAssets.products.slice(0, 3).map((p) => p.title).filter(Boolean);
    if (type.startsWith('ecommerce_')) {
      const sub = type.replace('ecommerce_', '');
      const focus = sub === 'electronics'
        ? 'Hero the device on a clean studio surface with screen-accurate UI. Emphasize price/finance flexibility, authenticity, and warranty/support.'
        : sub === 'fashion'
          ? 'Hero the garment on-model in a stylized urban or studio setting. Emphasize the drop, fit, and styling pairings.'
          : sub === 'beauty'
            ? 'Hero the product on a soft, premium surface with macro detail. Emphasize ingredient story and the routine, not before/after.'
            : sub === 'grocery'
              ? 'Hero the basket or fresh ingredients with a "today" feel. Emphasize speed, freshness, and family value.'
              : sub === 'home'
                ? 'Hero the piece in a real room with natural light. Emphasize craft detail and the finished space.'
                : 'Hero the product cleanly. Emphasize price clarity, fast delivery, and a concrete reason to click now.';
      return ` E-commerce — ${focus} Featured products: ${titles.join(', ')}.`;
    }
    if (titles.length) return ` Featured offerings: ${titles.join(', ')}.`;
  }
  if (kind === 'restaurant_menu') {
    const c = bp.businessAssets.cuisineType || 'this concept';
    return ` Food & beverage brand — hero the dishes and atmosphere; cuisine angle: ${c}. Prefer reservation or visit CTAs over e-commerce SKU language.`;
  }
  if (kind === 'service_menu' && bp.businessAssets.services?.length) {
    const names = bp.businessAssets.services.slice(0, 4).map((s) => s.name).join(', ');
    return ` Service business — emphasize trust, team, and outcomes. Key services mentioned: ${names}.`;
  }
  if (kind === 'real_estate') {
    return ` Real estate — lead with location, lifestyle, and credibility; avoid guaranteed returns.`;
  }
  if (kind === 'professional_services') {
    const exp = (bp.businessAssets.expertise || []).slice(0, 4).join(', ');
    return ` Professional services — authority and discretion; practice areas: ${exp || 'as stated on site'}.`;
  }
  if (kind === 'education') {
    return ` Education provider — stress outcomes, credibility, and cohort quality.`;
  }
  if (kind === 'hospitality') {
    return ` Hospitality — experiential imagery; highlight amenities and the stay/journey.`;
  }
  if (kind === 'general_business' && bp.businessAssets.offerings?.length) {
    return ` Core themes: ${bp.businessAssets.offerings.slice(0, 5).join(', ')}.`;
  }
  return '';
}

function deriveSubtype(category, type) {
  if (!category) return type || 'general';

  const cleaned = category
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // remove junk chars
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  return cleaned.join('_') || type || 'general';
}

module.exports = {
  inferBusinessProfile,
  formatBusinessContextForPrompt,
  classifyType,
  AD_STRATEGY,
};
