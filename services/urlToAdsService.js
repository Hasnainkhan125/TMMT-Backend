'use strict';

/**
 * urlToAdsService — Phase 7 "paste a URL, get ads" orchestration layer.
 *
 * The Phase-1 controller (urlToAdController) already scrapes the page and
 * spits out 3 blueprint cards inline. Good for a drawer. Not good for a
 * real product: the result vanished the moment the drawer closed, there
 * was no competitor panel, copy was a single headline, and the user had
 * to click "Generate" three times to render the free ads.
 *
 * Phase 7 promotes the flow to a proper report:
 *
 *   scanUrl({ url, req })
 *     ├─ scrape page (reuses urlScraper)
 *     ├─ pick competitors (curated seeds by category)
 *     ├─ compose an ad-copy pack (headlines + captions + CTAs + hashtags)
 *     ├─ build 3 ad blueprints (prompt / ratio / hook)
 *     └─ persist a UrlToAdsScan document and return it
 *
 *   generateAds({ scanId, req })
 *     ├─ validate ownership + status
 *     ├─ charge credits (free the *first* scan per session for trial)
 *     ├─ fan out to adSetService.enqueueAdSet (kind=image, numVariants=3)
 *     └─ back-fill scan.ads[].status='queued' + scan.adSetId
 *
 *   getScan(id, owner) / listScans(owner) / archiveScan(id, owner)
 *     plain CRUD on UrlToAdsScan.
 *
 * Design notes:
 *   • The service is deliberately synchronous during scan — we don't queue
 *     the scrape because it's <2s p95. If it ever needs to be async, the
 *     caller just polls GET /scan/:id.
 *   • Copy generation uses a deterministic hook bank first, then optionally
 *     enriches via copyService if the Anthropic key is present. This keeps
 *     unit tests hermetic (no live LLM required) while still producing rich
 *     copy in production.
 *   • Competitors are a pragmatic curated list, not a live web search. The
 *     investor demo doesn't need fresh competitor data; it needs a believable
 *     panel. We can swap in a SERP API later without touching the frontend.
 */

const { z }          = require('zod');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const UrlToAdsScan   = require('../model/schema/urlToAdsScan');
const { scrapeUrl }  = require('./urlScraper');
const { extractSocialHandles } = require('./scraper/extractSocialHandles');
const { extractBrandPalette: extractCssPalette } = require('./scraper/extractBrandPalette');
const { extractTeamAndServices } = require('./scraper/extractTeamAndServices');
const { detectWhatsAppCommerce } = require('./scraper/detectWhatsAppCommerce');
const { whatsappCopyVariants } = require('./urlToAds/whatsappCopyVariants');
const { researchBrand } = require('./aiResearch');
const { rootDomain } = require('./resolver/utils/normalizeDomain');
const {
  inferBusinessProfile,
  formatBusinessContextForPrompt,
} = require('./businessProfileInference');
const adBrain        = require('./adBrain');
const adSetService   = require('./adSetService');
const creditsService = require('./creditsService');
const { getStudioSessionId } = require('../middelwares/studioIdentity');
const { normalizeCompetitorSocialUrls } = require('./apify/competitorResolution');
const { enrichScanStrategicAnglesWithMedia } = require('./urlToAds/mergeStrategicAnglesWithMedia');
const intentEngine = require('./intentEngine');
const { enqueueUrlToAdsEnrich } = require('./queues');

const { syncShotJobToVideoAd } = require('./syncShotJobToVideoAd');

const { OpenAI } = require('openai');

const openai = new OpenAI();

// Metrics are best-effort — never block a scan on a bad metric import.
let _metrics;
function _bumpScanMetric(status) {
  try {
    _metrics = _metrics || require('../utils/metrics');
    _metrics.incScan(status);
  } catch (_e) { /* optional */ }
}

// Optional LLM copy — loaded lazily so unit tests don't have to stub it.
function loadCopyService() {
  try { return require('./copyService'); } catch (_e) { return null; }
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const scanInputSchema = z.object({
  url: z.string().trim().min(3, 'Paste a URL to scan.').max(2500),
});

/** Trims/coerces blank strings to undefined for optional POST fields. */
function preprocessTrimmedString(maxLen) {
  return z.preprocess((v) => {
    if (v == null || v === '') return undefined;
    const s = String(v).trim().slice(0, maxLen);
    return s || undefined;
  }, z.optional(z.string()));
}

const generateInputSchema = z.object({
  scanId: z.string().min(1),
  numVariants: z.coerce.number().int().min(1).max(5).optional().default(3),
  kind: z.enum(['image', 'video']).optional().default('image'),
  generateCopy: z.boolean().optional().default(true),
  /** Overrides per-blueprint models when enqueueing variants. */
  modelId: preprocessTrimmedString(120),
  userId: z.string().min(1),
  mode: z.enum(['append', 'replace']).optional().default('append'),
  /** Optional UX hint — appended to prompts (never mutates stored scan.ads). */
  templateCategory: preprocessTrimmedString(240),
  templateName: preprocessTrimmedString(240),
  creativeStyleHint: preprocessTrimmedString(1200),
  referenceImageUrl: preprocessTrimmedString(6000),
  extras: z.record(z.string(), z.unknown()).optional(),
  /**
   * Region hint that flows down to intentEngine + aiResearch. Default is
   * 'global' (worldwide audience). Pass 'gulf' to resurface the legacy
   * UAE/KSA-flavored prompts; 'india', 'china', 'uk', 'us', 'europe',
   * 'russia' are also recognized. Unknown values fall back to 'global'.
   */
  locale: z.preprocess(
    (v) => (v == null || v === '' ? undefined : String(v).trim().toLowerCase()),
    z.string().optional().default('global'),
  ),
});

const perProductGenerateSchema = z.object({
  scanId: z.string().min(1),
  productIds: z.array(z.string().min(1)).min(1).max(15),
  variantsPerProduct: z.coerce.number().int().min(1).max(5).optional().default(3),
  kind: z.enum(['image', 'video']).optional().default('image'),
  generateCopy: z.boolean().optional().default(true),
  modelId: preprocessTrimmedString(120),
  templateCategory: preprocessTrimmedString(240),
  templateName: preprocessTrimmedString(240),
  creativeStyleHint: preprocessTrimmedString(1200),
  referenceImageUrl: preprocessTrimmedString(6000),
  extras: z.record(z.string(), z.unknown()).optional(),
  locale: z.preprocess(
    (v) => (v == null || v === '' ? undefined : String(v).trim().toLowerCase()),
    z.string().optional().default('global'),
  ),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

// The auth middleware stashes the JWT payload at req.user. Depending on the
// code path that signed the token, the user id lives at `_id`, `userId`, or
// `id` — all of them mean the same Mongo ObjectId. Read the first match so we
// don't silently orphan scans as anonymous when a user is actually signed in.
function getUserId(req) {
  return req?.user?._id || req?.user?.userId || req?.user?.id || null;
}

function ownerFromReq(req, sessionId) {
  const userId = getUserId(req);
  return userId
    ? { userId, sessionId }
    : { userId: null, sessionId };
}

// NOTE: category→audience hardcoded map REMOVED in v2. Audience now comes
// from aiResearch (Anthropic) per-URL, with a minimal fallback string when
// the AI key is missing. Kept as a 1-liner so call sites still compile.
function pickAudience(research) {
  return research?.targetAudience?.primary
      || 'buyers ready to discover a brand that actually fits their life';
}

/**
 * Deterministic ad-copy pack. Works with whatever the scraper gave us,
 * even if half the fields are empty — you always get something usable.
 *
 * Hashtag strategy:
 *   • `COPY_PACK_HASHTAGS` is region-neutral by category (no #UAE / #Dubai
 *     baked in). It produces evergreen hashtags that read fine in any market.
 *   • `REGIONAL_HASHTAGS` is the small region-specific tail that gets
 *     appended based on `locale`. Default is 'global'.
 *   • Unknown locales fall back to the 'global' set, so callers passing
 *     a locale we haven't tagged here still get a sensible result.
 */
const COPY_PACK_HASHTAGS = {
  health_retail:    ['#Pharmacy', '#HealthAndWellness', '#OnlinePharmacy', '#HomeDelivery', '#Wellness'],
  restaurant:       ['#Foodie', '#FoodLover', '#Foodstagram', '#Eats', '#Tasty'],
  cafe:             ['#CafeLife', '#CoffeeLover', '#CoffeeTime', '#LatteArt', '#Cafe'],
  fitness_gym:      ['#Fitness', '#Gym', '#Workout', '#FitLife', '#FitnessMotivation'],
  fitness_coach:    ['#FitnessCoach', '#PersonalTrainer', '#TrainSmart', '#HealthGoals', '#FitnessJourney'],
  beauty_salon:     ['#Beauty', '#SalonLife', '#BeautyGoals', '#SelfCare', '#GlowUp'],
  real_estate:      ['#RealEstate', '#PropertyForSale', '#NewHome', '#InvestSmart', '#DreamHome'],
  clinic_dental:    ['#Dental', '#SmileBright', '#DentalCare', '#OralHealth', '#HealthySmile'],
  clinic_medical:   ['#Healthcare', '#Clinic', '#HealthMatters', '#DoctorVisit', '#Wellness'],
  clinic_cosmetic:  ['#Aesthetics', '#CosmeticCare', '#GlowUp', '#BeautyMedical', '#LookGood'],
  ecommerce_fashion:['#Fashion', '#OOTD', '#StyleInspo', '#FashionDaily', '#NewArrivals'],
  ecommerce_beauty: ['#Beauty', '#Skincare', '#Glow', '#Makeup', '#BeautyAddict'],
  luxury: ['#Luxury', '#LuxuryLife', '#LuxuryExperience', '#LuxuryStay', '#LuxuryLife'],
  luxury_jewelry: ['#Jewelry', '#LuxuryJewelry', '#LuxuryJewelryExperience', '#LuxuryJewelryStay', '#LuxuryJewelryLife'],
  luxury_watch: ['#Watch', '#LuxuryWatch', '#LuxuryWatchExperience', '#LuxuryWatchStay', '#LuxuryWatchLife'],
  luxury_fashion: ['#Fashion', '#LuxuryFashion', '#LuxuryFashionExperience', '#LuxuryFashionStay', '#LuxuryFashionLife'],
  luxury_beauty: ['#Beauty', '#LuxuryBeauty', '#LuxuryBeautyExperience', '#LuxuryBeautyStay', '#LuxuryBeautyLife'],
  luxury_real_estate: ['#RealEstate', '#LuxuryRealEstate', '#LuxuryRealEstateExperience', '#LuxuryRealEstateStay', '#LuxuryRealEstateLife'],
  luxury_car: ['#Car', '#LuxuryCar', '#LuxuryCarExperience', '#LuxuryCarStay', '#LuxuryCarLife'],
  luxury_travel: ['#Travel', '#LuxuryTravel', '#LuxuryTravelExperience', '#LuxuryTravelStay', '#LuxuryTravelLife'],
  saas_b2b:         ['#SaaS', '#TechStartup', '#BusinessGrowth', '#Productivity', '#B2BSoftware'],
  ecommerce_general: ['#Ecommerce', '#OnlineShopping', '#ShopSmart', '#BuyNow', '#Shopping'],
  real_estate: ['#RealEstate', '#PropertyForSale', '#NewHome', '#InvestSmart', '#DreamHome'],
  dental: ['#Dental', '#SmileBright', '#DentalCare', '#OralHealth', '#HealthySmile'],
  beauty_clinic: ['#Beauty', '#SalonLife', '#BeautyGoals', '#SelfCare', '#GlowUp'],
  clinic_wellness: ['#Wellness', '#Clinic', '#HealthMatters', '#DoctorVisit', '#Wellness'],
  clinic_cosmetic: ['#Aesthetics', '#CosmeticCare', '#GlowUp', '#BeautyMedical', '#LookGood'],
  clinic_medical: ['#Healthcare', '#Clinic', '#HealthMatters', '#DoctorVisit', '#Wellness'],
  transport: ['#Transport', '#Travel', '#Journey', '#Explore', '#Adventure'],
  education: ['#Education', '#Learn', '#Study', '#Knowledge', '#Academy'],
  education_academic: ['#Academic', '#University', '#College', '#School', '#Education'],
  education_coaching: ['#Coaching', '#Tutoring', '#Mentoring', '#Education', '#Learning'],
  education_online: ['#Online', '#Elearning', '#Education', '#Learning', '#OnlineLearning'],
  education_offline: ['#Offline', '#Education', '#Learning', '#OfflineLearning'],
  education_self_paced: ['#SelfPaced', '#Education', '#Learning', '#SelfPacedLearning'],
  education_structured: ['#Structured', '#Education', '#Learning', '#StructuredLearning'],
  education_interactive: ['#Interactive', '#Education', '#Learning', '#InteractiveLearning'],
  education_blended: ['#Blended', '#Education', '#Learning', '#BlendedLearning'],
  education_hybrid: ['#Hybrid', '#Education', '#Learning', '#HybridLearning'],
  education_flipped: ['#Flipped', '#Education', '#Learning', '#FlippedLearning'],
  education_project_based: ['#ProjectBased', '#Education', '#Learning', '#ProjectBasedLearning'],
  education_problem_based: ['#ProblemBased', '#Education', '#Learning', '#ProblemBasedLearning'],
  education_inquiry_based: ['#InquiryBased', '#Education', '#Learning', '#InquiryBasedLearning'],
  education_scaffolded: ['#Scaffolded', '#Education', '#Learning', '#ScaffoldedLearning'],
  education_guided: ['#Guided', '#Education', '#Learning', '#GuidedLearning'],
  cartoon: ['#Cartoon', '#CartoonLife', '#CartoonExperience', '#CartoonStay', '#CartoonLife'],
  cartoon_animation: ['#Animation', '#AnimationLife', '#AnimationExperience', '#AnimationStay', '#AnimationLife'],
  cartoon_illustration: ['#Illustration', '#IllustrationLife', '#IllustrationExperience', '#IllustrationStay', '#IllustrationLife'],
  cartoon_漫画: ['#漫画', '#CartoonLife', '#CartoonExperience', '#CartoonStay', '#CartoonLife'],
  cartoon_anime: ['#Anime', '#AnimeLife', '#AnimeExperience', '#AnimeStay', '#AnimeLife'],
  cartoon_manga: ['#Manga', '#MangaLife', '#MangaExperience', '#MangaStay', '#MangaLife'],
  cartoon_漫画: ['#漫画', '#CartoonLife', '#CartoonExperience', '#CartoonStay', '#CartoonLife'],
  cartoon_anime: ['#Anime', '#AnimeLife', '#AnimeExperience', '#AnimeStay', '#AnimeLife'],
  manufacturing: ['#Manufacturing', '#Factory', '#Production', '#Quality', '#Innovation'],
  manufacturing_automation: ['#Automation', '#AutomationLife', '#AutomationExperience', '#AutomationStay', '#AutomationLife'],
  manufacturing_robotics: ['#Robotics', '#RoboticsLife', '#RoboticsExperience', '#RoboticsStay', '#RoboticsLife'],
  manufacturing_3d_printing: ['#3DPrinting', '#3DPrintingLife', '#3DPrintingExperience', '#3DPrintingStay', '#3DPrintingLife'],
  manufacturing_laser_cutting: ['#LaserCutting', '#LaserCuttingLife', '#LaserCuttingExperience', '#LaserCuttingStay', '#LaserCuttingLife'],
  manufacturing_cnc_machining: ['#CNCMachining', '#CNCMachiningLife', '#CNCMachiningExperience', '#CNCMachiningStay', '#CNCMachiningLife'],
  manufacturing_3d_modeling: ['#3DModeling', '#3DModelingLife', '#3DModelingExperience', '#3DModelingStay', '#3DModelingLife'],
  manufacturing_3d_scanning: ['#3DScanning', '#3DScanningLife', '#3DScanningExperience', '#3DScanningStay', '#3DScanningLife'],

  transport_car: ['#Car', '#CarLife', '#CarExperience', '#CarStay', '#CarLife'],
  transport_bus: ['#Bus', '#BusLife', '#BusExperience', '#BusStay', '#BusLife'],
  transport_train: ['#Train', '#TrainLife', '#TrainExperience', '#TrainStay', '#TrainLife'],
  transport_plane: ['#Plane', '#PlaneLife', '#PlaneExperience', '#PlaneStay', '#PlaneLife'],
  transport_boat: ['#Boat', '#BoatLife', '#BoatExperience', '#BoatStay', '#BoatLife'],
  transport_bike: ['#Bike', '#BikeLife', '#BikeExperience', '#BikeStay', '#BikeLife'],
  transport_motorcycle: ['#Motorcycle', '#MotorcycleLife', '#MotorcycleExperience', '#MotorcycleStay', '#MotorcycleLife'],
  transport_scooter: ['#Scooter', '#ScooterLife', '#ScooterExperience', '#ScooterStay', '#ScooterLife'],
  transport_truck: ['#Truck', '#TruckLife', '#TruckExperience', '#TruckStay', '#TruckLife'],
  transport_van: ['#Van', '#VanLife', '#VanExperience', '#VanStay', '#VanLife'],
  transport_rv: ['#RV', '#RVLife', '#RVExperience', '#RVStay', '#RVLife'],
  transport_boat: ['#Boat', '#BoatLife', '#BoatExperience', '#BoatStay', '#BoatLife'],
  transport_yacht: ['#Yacht', '#YachtLife', '#YachtExperience', '#YachtStay', '#YachtLife'],
  transport_sailboat: ['#Sailboat', '#SailboatLife', '#SailboatExperience', '#SailboatStay', '#SailboatLife'],
  transport_catamaran: ['#Catamaran', '#CatamaranLife', '#CatamaranExperience', '#CatamaranStay', '#CatamaranLife'],
  transport_sailboat: ['#Sailboat', '#SailboatLife', '#SailboatExperience', '#SailboatStay', '#SailboatLife'],
  transport_catamaran: ['#Catamaran', '#CatamaranLife', '#CatamaranExperience', '#CatamaranStay', '#CatamaranLife'],
  transport_sailboat: ['#Sailboat', '#SailboatLife', '#SailboatExperience', '#SailboatStay', '#SailboatLife'],

  hotel: ['#Hotel', '#HotelLife', '#HotelExperience', '#HotelStay', '#HotelLife'],
  restaurant: ['#Restaurant', '#RestaurantLife', '#RestaurantExperience', '#RestaurantStay', '#RestaurantLife'],
  cafe: ['#Cafe', '#CafeLife', '#CafeExperience', '#CafeStay', '#CafeLife'],
  fitness_gym: ['#Fitness', '#Gym', '#Workout', '#FitLife', '#FitnessMotivation'],
  fitness_coach: ['#FitnessCoach', '#PersonalTrainer', '#TrainSmart', '#HealthGoals', '#FitnessJourney'],
  beauty_salon: ['#Beauty', '#SalonLife', '#BeautyGoals', '#SelfCare', '#GlowUp'],
  real_estate: ['#RealEstate', '#PropertyForSale', '#NewHome', '#InvestSmart', '#DreamHome'],
  ecommerce_food: ['#Food', '#Foodie', '#FoodLover', '#Foodstagram', '#Eats'],
  ecommerce_health: ['#Health', '#HealthAndWellness', '#OnlinePharmacy', '#HomeDelivery', '#Wellness'],
  ecommerce_electronics: ['#Electronics', '#TechGadgets', '#SmartHome', '#TechInnovation', '#GadgetLife'],
  ecommerce_家居: ['#家居', '#HomeDecor', '#HomeLife', '#HomeStyle', '#HomeDesign'],
  ecommerce_家具: ['#家具', '#Furniture', '#HomeFurnishings', '#LivingSpace', '#InteriorDesign'],
  ecommerce_家居: ['#家居', '#HomeDecor', '#HomeLife', '#HomeStyle', '#HomeDesign'],
  ecommerce_家具: ['#家具', '#Furniture', '#HomeFurnishings', '#LivingSpace', '#InteriorDesign'],
  ecommerce_家居: ['#家居', '#HomeDecor', '#HomeLife', '#HomeStyle', '#HomeDesign'],
  default:          ['#Discover', '#NewDrop', '#ShopNow', '#Brand', '#ShoppingInspo'],
};

const REGIONAL_HASHTAGS = {
  gulf:   ['#Dubai', '#UAE', '#GulfCreators'],
  global: ['#smallbusiness', '#brand', '#shoppinginspo'],
  india:  ['#India', '#MadeInIndia', '#shoppinginspo'],
  china:  ['#China', '#newdrop', '#brand'],
  uk:     ['#UK', '#smallbusiness', '#shoppinginspo'],
  us:     ['#USA', '#smallbusiness', '#shoppinginspo'],
  europe: ['#Europe', '#smallbusiness', '#shoppinginspo'],
  russia: ['#Russia', '#brand', '#newdrop'],
  africa: ['#Africa', '#smallbusiness', '#shoppinginspo'],
  latin_america: ['#LatinAmerica', '#smallbusiness', '#shoppinginspo'],
  middle_east: ['#MiddleEast', '#smallbusiness', '#shoppinginspo'],
  asia: ['#Asia', '#smallbusiness', '#shoppinginspo'],
  oceania: ['#Oceania', '#smallbusiness', '#shoppinginspo'],
  antarctica: ['#Antarctica', '#smallbusiness', '#shoppinginspo'],
  arctic: ['#Arctic', '#smallbusiness', '#shoppinginspo'],
  antarctic: ['#Antarctic', '#smallbusiness', '#shoppinginspo'],
  australia: ['#Australia', '#smallbusiness', '#shoppinginspo'],
  canada: ['#Canada', '#smallbusiness', '#shoppinginspo'],
  france: ['#France', '#smallbusiness', '#shoppinginspo'],
  germany: ['#Germany', '#smallbusiness', '#shoppinginspo'],
  italy: ['#Italy', '#smallbusiness', '#shoppinginspo'],
  japan: ['#Japan', '#smallbusiness', '#shoppinginspo'],
  korea: ['#Korea', '#smallbusiness', '#shoppinginspo'],
  mexico: ['#Mexico', '#smallbusiness', '#shoppinginspo'],
  netherlands: ['#Netherlands', '#smallbusiness', '#shoppinginspo'],
  new_zealand: ['#NewZealand', '#smallbusiness', '#shoppinginspo'],
  norway: ['#Norway', '#smallbusiness', '#shoppinginspo'],
  poland: ['#Poland', '#smallbusiness', '#shoppinginspo'],
  portugal: ['#Portugal', '#smallbusiness', '#shoppinginspo'],
  russia: ['#Russia', '#smallbusiness', '#shoppinginspo'],
  spain: ['#Spain', '#smallbusiness', '#shoppinginspo'],
  sweden: ['#Sweden', '#smallbusiness', '#shoppinginspo'],
  switzerland: ['#Switzerland', '#smallbusiness', '#shoppinginspo'],
  turkey: ['#Turkey', '#smallbusiness', '#shoppinginspo'],
  ukraine: ['#Ukraine', '#smallbusiness', '#shoppinginspo'],
  united_kingdom: ['#UnitedKingdom', '#smallbusiness', '#shoppinginspo'],
  united_states: ['#UnitedStates', '#smallbusiness', '#shoppinginspo'],
  venezuela: ['#Venezuela', '#smallbusiness', '#shoppinginspo'],
  vietnam: ['#Vietnam', '#smallbusiness', '#shoppinginspo'],
  south_africa: ['#SouthAfrica', '#smallbusiness', '#shoppinginspo'],
  south_korea: ['#SouthKorea', '#smallbusiness', '#shoppinginspo'],
};

function pickRegionalHashtags(locale) {
  const key = String(locale || 'global').toLowerCase();
  return REGIONAL_HASHTAGS[key] || REGIONAL_HASHTAGS.global;
}

function buildCopyPack(scrape, businessProfile, locale = 'global') {
  const brand = scrape.brandName || scrape.siteName || 'your brand';
  const cat   = scrape.category || 'general';
  const type  = businessProfile?.type || 'default';
  const oneLiner = (scrape.description || scrape.headlines?.[0] || scrape.paragraphs?.[0] || '')
    .trim().slice(0, 180);

  const localeKey = String(locale || 'global').toLowerCase();
  const isGulf    = localeKey === 'gulf';

  const headlines = [
    `Meet ${brand}. Made for the moments that matter.`,
    `${brand} — finally, a brand that gets it.`,
    `Stop scrolling. ${brand} is the upgrade you've been looking for.`,
    oneLiner ? `${brand}: ${oneLiner}` : `${brand}, redefined.`,
    isGulf
      ? `New from ${brand}. Limited drop. Built for the Gulf.`
      : `New from ${brand}. Limited drop. Built for the world.`,
  ].filter(Boolean);

  const captions = [
    oneLiner
      ? `${oneLiner} That's why people are switching to ${brand}.`
      : `People are switching to ${brand} — and here's why it's not slowing down.`,
    isGulf
      ? `Built in the Gulf. Loved by the Gulf. ${brand} isn't trying to fit in — it's setting the benchmark.`
      : `Built with care. Loved everywhere. ${brand} isn't trying to fit in — it's setting the benchmark.`,
    `Three reasons people choose ${brand}: quality you can feel, service you can trust, a promise we keep. Try it once.`,
  ];

  const ctas = [
    'Shop the drop',
    'Try it today',
    `Discover ${brand}`,
    'Reserve yours',
    'Book a free consultation',
  ];

  const categoryTags = COPY_PACK_HASHTAGS[type] || COPY_PACK_HASHTAGS.default;
  const regionalTags = pickRegionalHashtags(localeKey);
  const testimonial = String(businessProfile?.adStrategy?.testimonialStyle || '').toLowerCase();
  const styleTags = [];
  if (testimonial.includes('ugc') || testimonial.includes('creator')) {
    styleTags.push('#UGC', '#Authentic');
  }
  if (testimonial.includes('founder')) styleTags.push('#FounderStory');
  const combinedCat = `${type} ${cat}`.toLowerCase();
  if (/(jewel|luxury|bridal|watch|fine)/.test(combinedCat)) {
    styleTags.push('#LuxuryLife', '#FineJewellery');
  }
  if (/(skincare|beauty|spa)/.test(combinedCat)) {
    styleTags.push('#GlowUp', '#SkincareRoutine');
  }
  const hashtagBase = [
    `#${brand.replace(/\s+/g, '')}`,
    ...categoryTags,
    ...styleTags,
    ...regionalTags,
    '#ForYou',
  ];

  const openingLines = [
    `Before you scroll past — ${brand} is worth 10 seconds.`,
    `The ${cat} space is crowded. Here's why ${brand} is different.`,
    `Everyone's posting the same ${cat} ads. ${brand} isn't.`,
  ];
          
  return { headlines, captions, ctas, hashtags: hashtagBase, openingLines };
}

/**
 * Ad blueprint generator. Prefers Anthropic-authored hooks; falls back to
 * deterministic copy if the research payload is thin.
 *
 * @param {object} args
 * @param {string} [args.locale='global'] – region hint for the prompt engine.
 *   Default 'global' produces a worldwide-neutral prompt; pass 'gulf' to
 *   resurface the legacy Gulf-flavored mod, or 'india' / 'uk' / etc.
 */
function buildAdBlueprint({ scrape, research, hookIdx, businessProfile: bpIn, locale = 'global',knownDomain }) {
  const businessProfile = bpIn || inferBusinessProfile(scrape, research || null);
  const defaultModel =
    process.env.URL_TO_ADS_IMAGE_MODEL_ID
    || 'nano_banana_pro';
  const fallbackHooks = [
    { vibe: 'cinematic', aspectRatio: '1:1',  label: 'Hero shot',      modelHint: defaultModel },
    { vibe: 'editorial', aspectRatio: '9:16', label: 'Social-first',   modelHint: defaultModel },
    { vibe: 'urgent',    aspectRatio: '4:5',  label: 'Conversion CTA', modelHint: defaultModel },
  ];
  const idx = Math.max(0, Math.min(2, hookIdx));
  const aiHook = research?.hooks?.[idx] || null;
  const hook = aiHook || fallbackHooks[idx];

  const brandName = research?.brand?.name || scrape.brandName;
  const head = aiHook?.headline || `Meet ${brandName}.`;
  const body = aiHook?.body     || research?.brand?.summary || scrape.description || '';

  const paletteClause = scrape.brandPalette
  ? ` Brand color palette: ${scrape.brandPalette.primary} (primary), ${scrape.brandPalette.accent} (accent). Color grade should integrate these tones into lighting and composition.`
  : '';


  const verticalCtx = formatBusinessContextForPrompt(businessProfile);
  const productCtx = scrape.productCatalog?.products?.slice(0, 3)
    ? ` Featured products: ${scrape.productCatalog.products.slice(0, 3).map((p) => p.title).join(', ')}.`
    : '';

  // const description = `${head} ${body}${paletteClause}${verticalCtx || productCtx}`.slice(0, 1000);
  const description = `${head} ${body}${paletteClause}`.slice(0, 800);

  const resolvedLocale = String(locale || 'global').toLowerCase();
  const built = adBrain.buildAdPrompt({
    brandName,
    description: description,
    targetAudience: pickAudience(research),
    category: knownDomain,
    // category:       research?.brand?.category || scrape.category || 'general',
    vibe:           hook.vibe || 'cinematic',
    locale:         resolvedLocale,
    aspectRatio:    hook.aspectRatio || fallbackHooks[idx].aspectRatio,
    featuredProducts: scrape.productCatalog?.products?.slice(0, 3),
  });

  return {
    label: hook.label || fallbackHooks[idx].label,
    headline: head,
    hookLine: head,
    body,
    cta: aiHook?.cta || 'Discover',
    aspectRatio: hook.aspectRatio || fallbackHooks[idx].aspectRatio,
    vibe: hook.vibe || 'cinematic',
    category: research?.brand?.category || scrape.category || 'general',
    prompt: built.finalPrompt,
    negativePrompt: built.negativePrompt,
    modelId: hook.modelHint || defaultModel,
    referenceImageUrl: scrape.images?.[0] || null,
    status: 'pending',
    brandPalette: scrape.brandPalette,
    featuredProducts: scrape.productCatalog?.products?.slice(0, 3),
    _debug: {
      knownDomain,
      classifiedDomain: built.promptMetadata?.domain,
      promptHead: built.finalPrompt.slice(0, 200),
    },
  };
}

function scrapeShimFromScan(scan) {
  const b = scan.brand || {};
  return {
    url: scan.url,
    host: scan.host,
    brandName: b.name || scan.host || 'Brand',
    siteName: b.siteName || b.name || scan.host,
    description: b.description || '',
    headlines: b.headlines || [],
    paragraphs: b.paragraphs || [],
    images: b.images || [],
    category: b.category || 'general',
    brandPalette: scan.brandPalette || null,
    productCatalog: scan.productCatalog || null,
    socialHandles: b.socialHandles || {},
  };
}

function resolveProductsFromCatalog(catalog, productIds) {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const wanted = productIds.map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const wid of wanted) {
    const found = products.find((p) => {
      const id = String(p?.id ?? p?.handle ?? p?.sku ?? '').trim();
      const url = String(p?.url || p?.permalink || '');
      const slug = url.split('/').filter(Boolean).pop() || '';
      const slugDec = slug ? decodeURIComponent(slug) : '';
      return id === wid || slug === wid || slugDec === wid;
    });
    if (found) out.push(found);
  }
  return out;
}

function pickProductTitle(p) {
  return String(p?.title || p?.name || 'Product').trim();
}

function pickProductImage(p, fallbackList) {
  const direct =
    p?.image ||
    p?.imageUrl ||
    p?.featuredImage ||
    (Array.isArray(p?.images) && p.images[0]) ||
    null;
  if (direct) return String(direct);
  if (Array.isArray(fallbackList) && fallbackList[0]) return String(fallbackList[0]);
  return null;
}

/**
 * One blueprint centered on a single catalog product — used by per-product
 * batch rendering (each batch is its own AdSet, max 5 variants).
 */
async function buildAdBlueprintForProduct({
  scrape,
  research,
  hookIdx,
  businessProfile: bpIn,
  locale,
  product,
  knownDomain
}) {
  const businessProfile = bpIn || inferBusinessProfile(scrape, research || null);
  const defaultModel =
    process.env.URL_TO_ADS_IMAGE_MODEL_ID
    || 'gpt_image_2';
  const fallbackHooks = [
    { vibe: 'cinematic', aspectRatio: '1:1',  label: 'Hero shot',      modelHint: defaultModel },
    { vibe: 'editorial', aspectRatio: '9:16', label: 'Social-first',   modelHint: defaultModel },
    { vibe: 'urgent',    aspectRatio: '4:5',  label: 'Conversion CTA', modelHint: defaultModel },
    { vibe: 'cinematic', aspectRatio: '4:5',  label: 'Product focus', modelHint: defaultModel },
    { vibe: 'editorial', aspectRatio: '1:1',  label: 'Catalog square', modelHint: defaultModel },
  ];
  const idx = Math.max(0, Math.min(fallbackHooks.length - 1, hookIdx));
  const aiHooks = Array.isArray(research?.hooks) ? research.hooks : [];
  const aiHook = aiHooks[idx] || null;
  const hook = aiHook
    ? { ...fallbackHooks[idx % 3], ...aiHook, aspectRatio: aiHook.aspectRatio || fallbackHooks[idx % 3].aspectRatio }
    : fallbackHooks[idx];

  const brandName = research?.brand?.name || scrape.brandName;
  const title = pickProductTitle(product);
  const priceStr = product?.price != null ? String(product.price) : '';
  const head = aiHook?.headline || `${title} — ${brandName}`;
  const body =
    aiHook?.body
    || `${title}${priceStr ? ` (${priceStr})` : ''}. Premium creative for performance ads.`;

  const paletteClause = scrape.brandPalette
    ? ` Brand color palette: ${scrape.brandPalette.primary} (primary), ${scrape.brandPalette.accent} (accent). Color grade should integrate these tones into lighting and composition.`
    : '';

  const verticalCtx = formatBusinessContextForPrompt(businessProfile);
  const productClause =
    ` This ad must hero ONE product only: "${title}".${priceStr ? ` Price: ${priceStr}.` : ''}`
    + ' Show the product clearly; studio or lifestyle context may support it but the product is the focal point.';

  const description = `${head} ${body}${paletteClause}${productClause}${verticalCtx}`.slice(0, 1200);
  const featuredOne = {
    title,
    price: product?.price,
    image: pickProductImage(product, scrape.images),
    url: product?.url || product?.permalink,
  };
  // const built = adBrain.buildAdPrompt({
  //   brandName,
  //   description,
  //   targetAudience: pickAudience(research),
  //   category:       research?.brand?.category || scrape.category || 'general',
  //   vibe:           hook.vibe || 'cinematic',
  //   locale:         resolvedLocale,
  //   aspectRatio:    hook.aspectRatio || fallbackHooks[0].aspectRatio,
  //   featuredProducts: [featuredOne],
  // });

        const palettePart = scrape.brandPalette
        ? ` Brand palette: ${scrape.brandPalette.primary} primary, ${scrape.brandPalette.accent} accent — integrate into lighting and composition, not as graphic overlay.`
        : '';

      const userScene = [
        `Hero product shot of "${title}"${priceStr ? ` (${priceStr})` : ''} for ${brandName}.`,
        `The product is the single focal point — clearly visible, sharp, premium staging.`,
        body,
        palettePart,
      ].filter(Boolean).join(' ').slice(0, 1000);

      const resolvedLocale = String(locale || 'global').toLowerCase();
      const intentResult = await intentEngine.run({
        inputs: {
          prompt: userScene,
          brandName,
          targetAudience: pickAudience(research),
          locale: resolvedLocale,
          vibe: hook.vibe || 'cinematic',
          kind: 'image',
        },
        knownDomain,   // ← THE FIX: bypass classifier, force correct DNA
      });
    
      const pid = String(product?.id ?? product?.handle ?? product?.sku ?? title).slice(0, 200);
      const refUrl = pickProductImage(product, scrape.images);
    

  // const pid = String(product?.id ?? product?.handle ?? product?.sku ?? title).slice(0, 200);
  // const refUrl = pickProductImage(product, scrape.images);

  return {
    label:            `${hook.label || 'Variant'} · ${title.slice(0, 40)}`,
    headline:         head,
    hookLine:         head,
    body,
    cta:              aiHook?.cta || 'Shop now',
    aspectRatio:      hook.aspectRatio || fallbackHooks[idx].aspectRatio,
    vibe:             hook.vibe || 'cinematic',
    category:         research?.brand?.category || scrape.category || 'general',
    prompt:           intentResult.finalPrompt,
    negativePrompt:   intentResult.negativePrompt,
    modelId:          hook.modelHint || defaultModel,
    referenceImageUrl: refUrl,
    status:           'pending',
    brandPalette:     scrape.brandPalette,
    featuredProducts: [featuredOne],
    productId:        pid,
    productTitle:     title,
    productPrice:     product?.price,
    productImageUrl:  refUrl,
    kind:             'image',
    _debug: {
      knownDomain,
      promptHead: intentResult.finalPrompt.slice(0, 200),
    },
  };
}

// New function inside urlToAdsService.js
async function renderConceptPreviews(scan) {
  if (process.env.URL_TO_ADS_FLUX_SCHNELL_PREVIEWS !== '1') return;

  let falService;
  try { falService = require('./falService'); } catch (_e) { return; } // skip if fal not configured

  await Promise.allSettled(
    scan.ads.map(async (ad, idx) => {
      try {
        const aspectMap = { '9:16': 'portrait_16_9', '1:1': 'square_hd', '4:5': 'portrait_4_5' };
        const result = await falService.generateImage({
          falModelId: 'fal-ai/flux/schnell',
          input: {
            prompt: ad.prompt.slice(0, 500),
            image_size: aspectMap[ad.aspectRatio] || 'square_hd',
            num_inference_steps: 2,
            enable_safety_checker: false,
          },
        });
        const imgUrl = result?.images?.[0]?.url;
        if (imgUrl) {
          scan.ads[idx].assetUrl = imgUrl;
          scan.ads[idx].thumbnailUrl = imgUrl;
          scan.ads[idx].status = 'preview_ready';
        }
      } catch (err) {
        console.warn('[concept-preview] failed for ad', idx, ':', err.message);
      }
    })
  );

  await scan.save().catch((e) => console.warn('[concept-preview] save failed:', e.message));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * scanUrl — paste-a-URL entry point. Scrapes, enriches, persists.
 *
 * Returns a hydrated `UrlToAdsScan` document ready to serialize to the UI.
 * On scrape failure, we still persist the scan with `status='failed'` and
 * an `errorMessage` so the user can see why and hit "retry".
 *
 * @param {object} args
 * @param {string} args.url
 * @param {object} args.req
 * @param {string} [args.locale='global']  Region hint that drives copy
 *   fallbacks (hashtags, headline tail, caption tail). 'global' is the
 *   worldwide-neutral default; 'gulf' resurfaces the legacy UAE/Dubai copy.
 */
async function scanUrl({ url, req, locale, lightweight=false }) {
  // const brand = await extractBrand(url);
  // if (lightweight) return { id: makeId(), brand, blueprints: [] };

  console.log(url,"url");
  const parsed = scanInputSchema.parse({ url });
  // const requestedLocale = String(locale || 'global').toLowerCase();
  const requestedLocale = req.geo?.country?.toLowerCase() || 'global';

  const sessionId = getSessionId(req) || uuidv4();
  const owner = ownerFromReq(req, sessionId);


  try{
  // Create the scan doc upfront so the user has something to link to even
  // if the scrape blows up halfway through. We flip `status='ready'` on
  // success or `'failed'` on exception.
  const scan = await UrlToAdsScan.create({
    userId:    owner.userId,
    sessionId: owner.sessionId,
    url:       parsed.url,
    status:    'scanning',
  });

  // try {
    // Fast single-page scrape (sync path — must stay under ~30s for proxy timeout).
    // Multi-page crawl runs in the background enrichment job and updates the scan.
    let scrape;
    try {
      // Wrap with timeout — scraper must complete in 30 seconds
      // Note: Scraper may be slow on first visit; timeout ensures we don't hang indefinitely
      const scrapePromise = await scrapeUrl(parsed.url, { only: ['palette', 'products', 'ads'], includeHtml: true });

       
      scrape = await Promise.race([
        scrapePromise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Scraper timeout after 30s')), 30000)
        )
      ]);
    } catch (scrapeErr) {
      console.warn('[urlToAdsService] scrapeUrl failed (non-fatal):', scrapeErr.message);
      let urlObj;
      try { urlObj = new URL(parsed.url.startsWith('http') ? parsed.url : `https://${parsed.url}`); }
      catch (_) { urlObj = { host: parsed.url, hostname: parsed.url, origin: `https://${parsed.url}` }; }
      const hostStem = (urlObj.hostname || urlObj.host || '').replace(/^www\./, '').split('.')[0];
      const brandFallback = hostStem
        ? hostStem.charAt(0).toUpperCase() + hostStem.slice(1).replace(/-/g, ' ')
        : 'Unknown Brand';
      scrape = {
        url: parsed.url, host: urlObj.host || parsed.url, origin: urlObj.origin || `https://${parsed.url}`,
        brandName: brandFallback, siteName: brandFallback, title: brandFallback,
        description: '', headlines: [], paragraphs: [], images: [], ctas: [], fonts: [],
        category: 'general', favicon: `${urlObj.origin || `https://${parsed.url}`}/favicon.ico`,
        rawHtml: '', brandPalette: null, socialHandles: {}, productCatalog: null,
        _scrapeError: scrapeErr.message,
      };
    }


    
    
    // Extract social handles, CSS palette, and team/services from the single-page HTML.
    // The background enrichment job will re-run these against the full multi-page crawl.
    const singlePageHtml = scrape.rawHtml || '';
  //   const socialResult = singlePageHtml
  //   ? await extractSocialHandles({ html: singlePageHtml, url: parsed.url, forceHydrated: true, brand: {
  //     tokens: scrape.brandName.split(' '),
  //     domainStem: scrape.brandName.toLowerCase().replace(/ /g, ''),
  //     country: '971',  // UAE
  //   },
  //   fetchSource: 'axios',
  //  })
  //   : { handles: {} };
  //   const socialHandles = { ...scrape.socialHandles, ...socialResult.handles };
  const socialHandles = scrape.socialHandles || {};


    const cssP = singlePageHtml ? extractCssPalette({ html: singlePageHtml }) : null;
    if (cssP?.palette?.length >= 2 && (!scrape.brandPalette || scrape.brandPalette._source === 'image')) {
      scrape.brandPalette = { ...scrape.brandPalette, ...cssP, _source: 'css' };
    }
    const teamAndServices = singlePageHtml
      ? extractTeamAndServices({ html: singlePageHtml, baseUrl: parsed.url })
      : { team: [], services: [], stats: { teamCount: 0, servicesCount: 0 } };

    // ONE Anthropic call. Returns brand/audience/competitors/competitorAds/hooks
    // — no hardcoded buckets, no curated lists. Cost-efficient: exactly one
    // LLM roundtrip per scan (cached by the controller on retries).
    let research = null;
    try {
      research = await researchBrand({
        url:   scrape.url,
        html:  singlePageHtml,
        scrape: { ...scrape, socialHandles, team: teamAndServices.team, services: teamAndServices.services },
      });
    } catch (err) {
      console.error('[urlToAdsService] researchBrand FAILED — full details:', {
        error: err.message,
        code: err.code,
        status: err.status,
        url: scrape.url,
        htmlLength: singlePageHtml?.length || 0,
      });
      // Don't fail the entire scan — fall back to scrape-only mode
      research = null;
    }

    const knownDomain = mapBrandCategoryToDomain(
      research?.brand?.category || scrape.category
    );
    // Derive ad copy pack from Anthropic hooks where available, else the
    // deterministic fallback pack so captions/ctas/hashtags are never empty.
    // Pass `requestedLocale` so hashtags + caption tails match the caller's
    // target market (default 'global').
    const businessProfile = inferBusinessProfile(scrape, research);
    const detPack = buildCopyPack(scrape, businessProfile, requestedLocale);
    const aiHeadlines = (research?.hooks || [])
      .map((h) => h.headline)
      .filter(Boolean);
    const enriched = {
      headlines:    aiHeadlines.length ? aiHeadlines.slice(0, 8) : detPack.headlines,
      captions:     detPack.captions,
      ctas:         (research?.hooks || []).map((h) => h.cta).filter(Boolean).slice(0, 6)
                      .concat(detPack.ctas).slice(0, 6),
      hashtags:     detPack.hashtags,
      openingLines: detPack.openingLines,
    };


    const ads = [0, 1, 2].map((i) =>
      buildAdBlueprint({ scrape, research, hookIdx: i, businessProfile, locale: requestedLocale,knownDomain })
    );
    // ── WhatsApp-commerce signal detection ────────────────────────────────
    // Gulf-region differentiator: most ad-copy generators ignore the fact
    // that a huge slice of UAE/KSA/India SMBs sell through WhatsApp first.
    // We detect that signal here (regex-only, never throws) and persist it
    // so the frontend WhatsAppCommercePanel can surface 5 ready-to-paste
    // variants when it lights up.
    let whatsappCommerce = { detected: false, waLinks: [], waNumbers: [], waCtas: [], cataloguePresence: false, confidence: 'low' };
    try {
      whatsappCommerce = detectWhatsAppCommerce({
        ...scrape,
        socialHandles: { ...(scrape.socialHandles || {}), ...socialHandles },
      });
    } catch (waErr) {
      console.warn('[urlToAdsService] detectWhatsAppCommerce non-fatal:', waErr.message);
    }
    scan.host = scrape.host;
    scan.brand = {
      name:        research?.brand?.name       || scrape.brandName,
      siteName:    scrape.siteName,
      url:         scrape.url,
      host:        scrape.host,
      title:       scrape.title,
      description: research?.brand?.summary    || scrape.description,
      headlines:   scrape.headlines,
      paragraphs:  (scrape.paragraphs || []).slice(0, 6),
      images:      (scrape.images     || []).slice(0, 8),
      favicon:     scrape.favicon,
      logoUrl:     (scrape.images && scrape.images[0]) || null,
      socialHandles,
      team:     teamAndServices.team.slice(0, 20),
      services: teamAndServices.services.slice(0, 20),
      category:
        research?._source === 'fallback' && scrape?.category
          ? scrape.category
          : (research?.brand?.category || scrape.category || 'general'),
      audience:    research?.targetAudience?.primary || '',
      oneLiner:    research?.brand?.oneLiner   || '',
      vibe:        research?.brand?.vibe       || '',
      keywords:    research?.brand?.keywords   || [],
      valueProps:  research?.brand?.valueProps || [],
      tone:        research?.brand?.tone       || '',
      palette:     research?.brand?.palette    || [],
    };
    // Belt-and-suspenders: aiResearch already drops the user's own brand,
    // but if competitorValidator is bypassed (env flag, hot path, etc.)
    // we still refuse to scan the user's own domain as a "competitor".
    const ownRoot = rootDomain(scrape.url) || rootDomain(parsed.url);

    // If research failed, generate fallback competitors based on category + brand
    const competitorList = research?.competitors || [];
    if (competitorList.length === 0 && scrape.category) {
      // Fallback competitor generator (simple heuristic-based)
      const fallbackCompetitors = generateFallbackCompetitors(scrape, businessProfile);
      competitorList.push(...fallbackCompetitors);
      console.log(`[urlToAdsService] Generated ${fallbackCompetitors.length} fallback competitors for ${scrape.category}`);
    }

    scan.competitors = competitorList
      .filter((c) => {
        const compRoot = rootDomain(c?.domain || c?.url || c?.website || '');
        return compRoot && compRoot !== ownRoot;
      })
      .map(normalizeCompetitorSocialUrls);
    scan.competitorAds = research?.competitorAds  || [];
    enrichScanStrategicAnglesWithMedia(scan);
    scan.audience      = research?.targetAudience || {};
    scan.research         = research                 || null;
    scan.productCatalog   = scrape.productCatalog || null;
    scan.brandPalette     = scrape.brandPalette || null;
    scan.fonts            = Array.isArray(scrape.fonts) ? scrape.fonts.slice(0, 8) : [];
    // Persist social handles into intelligence.brandIdentity so the ROAST
    // panel reads from the right place (it checks handles, not brand.socialHandles)
    if (!scan.intelligence) scan.intelligence = {};
    if (!scan.intelligence.brandIdentity) scan.intelligence.brandIdentity = {};
    scan.intelligence.brandIdentity.handles = socialHandles;
    scan.intelligence.brandIdentity.palette = scrape.brandPalette?.palette || [];
    scan.intelligence.brandIdentity.primaryColor = scrape.brandPalette?.primary || null;
    scan.intelligence.brandIdentity.secondaryColor = scrape.brandPalette?.secondary || null;
    scan.intelligence.brandIdentity.accentColor = scrape.brandPalette?.accent || null;
    scan.intelligence.brandIdentity.team = teamAndServices.team.slice(0, 20);
    scan.intelligence.brandIdentity.services = teamAndServices.services.slice(0, 20);
    scan.markModified('intelligence');
    scan.businessProfile  = businessProfile;
    scan.copy             = enriched;
    scan.ads              = ads;
    // Persist WA-commerce signals + the deterministic copy pack. Pack is
    // computed against the partially-built scan so the brand/product
    // anchors are already in place. Only ship the pack when detection is
    // positive — frontend panel hides itself otherwise.
    scan.whatsappCommerce = whatsappCommerce;
    scan.markModified('whatsappCommerce');
    scan.whatsappCopyPack = whatsappCommerce.detected
      ? whatsappCopyVariants(scan)
      : null;
    scan.markModified('whatsappCopyPack');
    // Core brand kit is ready; heavy Apify + intel runs in background worker.
    scan.status           = 'scanning';
    await scan.save();
    // Call inside scanUrl() AFTER scan.ads = ads; await scan.save();
    renderConceptPreviews(scan).catch(e =>
      console.warn('[concept-preview] non-fatal:', e.message)
    );

    _bumpScanMetric('scanning');

    try {
      await enqueueUrlToAdsEnrich({
        scanId: scan._id,
        userId: owner.userId || null,
        priority: 2,
      });
    } catch (qErr) {
      console.warn('[urlToAdsService] enrich queue unavailable, scheduling in-process:', qErr.message);
      const { runScanEnrichmentJob } = require('./urlToAdsEnrichJob');
      setImmediate(() => {
        runScanEnrichmentJob({
          scanId: String(scan._id),
          userId: owner.userId || null,
        }).catch((e) => console.error('[urlToAdsService] inline enrich failed:', e.message));
      });
    }

    return scan;
  } catch (err) {
    scan.status       = 'failed';
    scan.errorMessage = err.message || 'Scan failed';
    await scan.save();
    _bumpScanMetric('failed');
    const e = new Error(scan.errorMessage);
    e.code    = err.code || 'scan_failed';
    e.scanId  = scan._id.toString();
    throw e;
  }
}


function compileSeedanceVideoPrompt({
  brief,        // { character, environment, camera, lighting, shots, arc }
  brandContext, // { name, category, palette }
  durationSec,
  aspectRatio,
  format,       // 'ugc' | 'transformation' | 'orb' | 'pov' | 'fight' | 'cinematic'
}) {
  const lines = [];

  // 1. STRUCTURE DECLARATION — Seedance reads this first, plans accordingly
  const shotCount = brief.shots?.length || 1;
  lines.push(
    `${shotCount > 1 ? 'Multi-shot' : 'Single continuous shot'} ` +
    `${format === 'transformation' ? 'action Hollywood movie, ' : ''}` +
    `${durationSec}s / ${shotCount} ${shotCount > 1 ? 'shots' : 'shot'} / ${aspectRatio}`
  );

  // 2. QUALITY TAIL UPFRONT (Seedance attends to early tokens harder)
  lines.push(
    "Cinematic lighting, photorealistic, 35mm film quality, " +
    "professional color grading, sharp focus, high detail texture, " +
    "film grain, ARRI ALEXA aesthetic"
  );

  // 3. CHARACTER + ENVIRONMENT (one continuous descriptive paragraph)
  const sceneParts = [];
  if (brief.character) sceneParts.push(brief.character);
  if (brief.environment) sceneParts.push(brief.environment);
  if (brief.lighting) sceneParts.push(brief.lighting);
  if (sceneParts.length) lines.push(sceneParts.join(' '));

  // 4. ESCALATION ARC (one sentence, plain English)
  if (brief.arc) lines.push(brief.arc);

  // 5. CAMERA GRAMMAR (one sentence, what's happening AND what's NOT)
  if (brief.camera) lines.push(brief.camera);

  // 6. NUMBERED SHOT LIST — the real meat
  if (Array.isArray(brief.shots) && brief.shots.length > 1) {
    lines.push(''); // blank line for readability
    brief.shots.forEach((shot, i) => {
      const vfxClause = shot.vfx ? ` [VFX: ${shot.vfx}]` : '';
      lines.push(
        `Shot ${i + 1}: ${shot.description}${vfxClause}` +
        (shot.cameraNote ? `. ${shot.cameraNote}` : '') +
        (shot.duration ? ` (~${shot.duration}s)` : '')
      );
    });
  } else if (brief.shots?.[0]) {
    // Single-shot — describe it as one continuous action
    lines.push(brief.shots[0].description);
  }

  // 7. BRAND CONTEXT TAIL — never asks for text on-screen
  if (brandContext?.name) {
    lines.push(
      `Brand context (do not render as on-screen text): ` +
      `${brandContext.name}${brandContext.category ? `, ${brandContext.category}` : ''}.`
    );
  }

  // 8. FINAL STRUCTURE LINE — Seedance likes the totals confirmed
  lines.push(`Total: ${durationSec}s / ${shotCount} ${shotCount > 1 ? 'shots' : 'shot'} / ${aspectRatio}`);

  return lines.filter(Boolean).join('\n\n');
}

/** Extra prompt tail from template/category + optional free-text hint (URL→Ads). */
function buildCreativeStyleSuffix(parsed) {
  const parts = [];
  if (parsed.creativeStyleHint) parts.push(parsed.creativeStyleHint);
  if (parsed.templateCategory && parsed.templateName) {
    parts.push(
      [
        `Creative reference direction — category: "${parsed.templateCategory}",`,
        `visual pattern: "${parsed.templateName}". Match lighting, framing, and pacing`,
        'of this archetype while keeping brand identity coherent.',
      ].join(' '),
    );
  }
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}


function mapBrandCategoryToDomain(category) {
  if (!category) return 'product';
  const c = String(category).toLowerCase();

  // ── B2B / Services FIRST — many of these contain "tech" or "software"
  //    as substrings and would otherwise resolve to consumer electronics.
  if (/legal|law|tax|accounting|audit|consulting|advisory|consultancy/.test(c)) return 'service';
  if (/agency|firm|professional.?services|corporate.?services/.test(c)) return 'service';
  if (/medical|clinic|dental|healthcare/.test(c)) return 'medical';
  if (/education|academy|coaching|training/.test(c)) return 'education';

  // Beauty
  if (/skincare|skin care|serum|moistur|toner|cleanser/.test(c)) return 'skincare';
  if (/haircare|hair care|shampoo/.test(c)) return 'haircare';
  if (/perfume|fragrance|cologne|oud/.test(c)) return 'perfume';
  if (/makeup|cosmetic|beauty/.test(c)) return 'beauty';
  if (/jewel|watch|ring|necklace/.test(c)) return 'jewelry';

  // Fashion
  if (/streetwear/.test(c)) return 'streetwear';
  if (/luxury.*(fashion|apparel)|haute/.test(c)) return 'luxury_fashion';
  if (/fashion|apparel|clothing/.test(c)) return 'fashion';

  // F&B
  if (/restaurant|cafe|coffee|bakery/.test(c)) return 'restaurant';
  if (/\bf&b\b|food.?service/.test(c)) return 'food';

  // Property + auto + fitness
  if (/real ?estate|property/.test(c)) return 'realestate';
  if (/automotive|\bcar\b|vehicle/.test(c)) return 'automotive';
  if (/gym|fitness|workout/.test(c)) return 'gym';
  if (/wellness|spa/.test(c)) return 'wellness';

  // Tech — LAST because greedy
  if (/saas|b2b.?software|enterprise.?software|crm|erp/.test(c)) return 'saas';
  if (/electronic|gadget|consumer.?tech|wearable/.test(c)) return 'tech';
  if (/\btech\b(?!.*service)/.test(c)) return 'tech';  // bare "tech" but not "tech services"

  return 'product';
}

function extractChildJobIds(result) {
  if (!result) return [];
  if (Array.isArray(result.childJobIds) && result.childJobIds.length) {
    return result.childJobIds.map((x) => String(x));
  }
  if (Array.isArray(result.children) && result.children.length) {
    return result.children.map((c) => String(c?._id || c?.id || '')).filter(Boolean);
  }
  if (Array.isArray(result.childIds) && result.childIds.length) {
    return result.childIds.map((x) => String(x));
  }
  if (Array.isArray(result.jobIds) && result.jobIds.length) {
    return result.jobIds.map((x) => String(x));
  }
  return [];
}


function stripPaletteLine(prompt) {
  // Remove any pre-baked "Brand color palette: ..." sentence from the stored
  // blueprint so we can inject the CORRECT swatches without contradiction.
  return String(prompt || '')
    .replace(/Brand color palette:[^.]*\.[^.]*\./i, '')
    .replace(/Color grade should integrate these tones[^.]*\./i, '')
    .trim();
}

function safeJsonParse(s) {
  if (!s || typeof s !== 'string') return null;
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (t[0] !== '{') {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  }
  try { return JSON.parse(t); } catch { return null; }
}
async function extractAdSkeleton({ competitorImageUrl, angle }) {
  const system = [
    'You are an ad-layout analyst. Look at the advertisement image and describe',
    'ONLY its visual STRUCTURE so a different brand can rebuild the same layout.',
    'Rules:',
    '- NEVER transcribe the brand name, logo text, taglines, or product names.',
    '- NEVER name colors as brand colors; describe color ROLES (e.g. "dark',
    '  diagonal block lower-left", "bright accent triangle upper-right").',
    '- Describe: overall composition, number/placement of text blocks and their',
    '  hierarchy (headline/subhead/CTA), product placement, any device/UI mockups,',
    '  iconography rows, diagonal/grid splits, focal flow.',
    'Return STRICT JSON only:',
    '{ "layout": string, "regions": [{ "role": "headline|subhead|cta|product|logo|icon_row|background", "position": string, "notes": string }], "composition": string, "mood": string }',
  ].join(' ');
 
  let parsed = null;
  try {
    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      // Force JSON so the output is always parseable.
      text: { format: { type: 'json_object' } },
      input: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `Extract the layout skeleton. The user wants to reuse this structure for the angle: "${angle || 'general'}". JSON only, no prose.` },
            { type: 'input_image', image_url: competitorImageUrl },
          ],
        },
      ],
    });
 
    // ── FIX: read the model's TEXT, not the response object. ──
    // The old code checked resp.layout — resp is the API envelope, not the
    // model's JSON, so it ALWAYS failed and ALWAYS fell back to generic.
    const raw =
      resp?.output_text ??
      resp?.output?.[0]?.content?.[0]?.text ??   // fallback shape for older SDKs
      '';
      console.log(raw);
    // if (raw) parsed = JSON.parse(stripCodeFences(raw));
    if (raw) parsed = safeJsonParse(raw)
  } catch (e) {
    console.error('[extractAdSkeleton] failed:', e?.message || e);
  }
 
  if (parsed && (parsed.layout || (Array.isArray(parsed.regions) && parsed.regions.length))) {
    return parsed;
  }
 
  // Loud fallback — if you see this in logs, vision returned nothing usable and
  // the clone is running on a generic skeleton (the thing that makes it drift).
  console.warn('[extractAdSkeleton] using generic fallback skeleton — vision returned nothing usable.');
  return {
    layout: 'Bold single-focal ad: large two-line headline upper area, product hero center, CTA button lower-right.',
    regions: [
      { role: 'headline', position: 'upper', notes: 'two-line bold' },
      { role: 'product', position: 'center', notes: 'hero placement' },
      { role: 'cta', position: 'lower-right', notes: 'button' },
    ],
    composition: 'clean, high-contrast, strong hierarchy',
    mood: 'confident, premium',
  };
}
 
// ── 2. Build the brand-true prompt from skeleton + USER brand ──────────────────
// Renders headline + CTA IN-IMAGE (there is no post step on this path) and
// hard-locks photoreal commercial style (kills the WPA-poster drift).
function buildClonePromptFromSkeleton({ skeleton, scan, angle, headline, cta }) {
  const brandName = scan.brand?.name || 'the brand';
  const category = scan.brand?.category || '';
  const colors = (Array.isArray(scan?.brandPalette?.swatches)
    ? scan.brandPalette.swatches.map(s => s?.hex).filter(Boolean) : []).slice(0, 5);
 
  const regionLines = (skeleton.regions || [])
    .map(r => `- ${r.role} (${r.position}): ${r.notes || ''}`.trim())
    .join('\n');
 
  const finalHeadline = (headline || angle || `${brandName} — built for the job`).trim();
  const finalCta = (cta || 'Learn more').trim();
 
  return [
    `Create a finished, photorealistic advertising image for "${brandName}"${category ? ` (${category})` : ''}.`,
    '',
    'RENDER MEDIUM (non-negotiable): professional commercial advertising photography — photorealistic, sharp critical focus, studio-grade lighting, real materials and textures. NOT an illustration, NOT a poster, NOT flat vector art, NOT a painterly or screen-print style.',
    '',
    'Reuse ONLY this proven LAYOUT STRUCTURE (do not copy any other brand):',
    skeleton.layout,
    regionLines,
    `Composition: ${skeleton.composition}.`,
    '',
    'RENDER THIS TEXT IN-IMAGE (this is a finished ad, not a background plate):',
    `- Headline (large, bold, placed per the layout): "${finalHeadline}"`,
    `- A clear call-to-action button reading: "${finalCta}"`,
    `- Reserve a small clean area for the ${brandName} logo (upper-left or per layout).`,
    'Text must be legible, correctly spelled, professionally kerned, high contrast against its background.',
    '',
    colors.length ? `Use ONLY this brand palette: ${colors.join(', ')}. These dominate the whole composition.` : '',
    `The product shown must be ${brandName}'s own product (a ${category || 'product'}). Do NOT depict any other company's logo, name, products, badges, or taglines.`,
    'Professional advertising quality, commercially usable, ready to run on Meta.',
  ].filter(Boolean).join('\n');
}
 

async function generateSingleAd({
  scanId, req, kind, modelId, prompt, label, aspectRatio,
  referenceImageUrl, creativeStyleHint, sourceCompetitor,
  angle,
}) {

  const competitorImageUrl = req.body?.competitorImageUrl;
  const scan = await UrlToAdsScan.findById(scanId);
  if (!scan) { const e = new Error('Scan not found'); e.code = 'not_found'; throw e; }

  // ownership check (same as generateAds) ...
  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || (req?.user?.role || '').toLowerCase() === 'admin';
  if (!isOwner) { const e = new Error('forbidden'); e.code = 'forbidden'; throw e; }

  // CORRECT palette only — swatches.
  const colors = (Array.isArray(scan?.brandPalette?.swatches)
    ? scan.brandPalette.swatches.map(s => s?.hex).filter(Boolean) : []);
  const paletteLine = colors.length
    ? ` Use ONLY this brand palette: ${colors.join(', ')}.` : '';

    let finalPrompt;
    let genReferenceUrl = referenceImageUrl;   // user's product image, if provided
   
    if (competitorImageUrl) {
      const skeleton = await extractAdSkeleton({ competitorImageUrl: competitorImageUrl, angle });
      finalPrompt = buildClonePromptFromSkeleton({ skeleton, scan, angle,headline: angle, cta:  'Learn more' });
      if (creativeStyleHint) finalPrompt += `\n${creativeStyleHint}`;
      // CRITICAL: the competitor image is NEVER used as a generation reference.
      // genReferenceUrl stays as the user's product image (or undefined).
    } else {
      // normal single-ad path (unchanged behavior)
      finalPrompt = `${stripPaletteLine(prompt)}${paletteLine}${creativeStyleHint ? ` ${creativeStyleHint}` : ''}`.trim();
    }
  

    const newLabel = label || (sourceCompetitor ? `Inspired by ${sourceCompetitor}` : 'New variant');

    const inputs = {
      prompt: finalPrompt,
      kind: kind || 'image',
      numVariants: 1,
      aspectRatio: aspectRatio || '1:1',
      brandName: scan.brand?.name || '',
      targetAudience: (scan.audience?.primary || '').slice(0, 200),
      category: scan.brand?.category || '',
      locale: 'global',
      vibe: 'cinematic',
      referenceImageUrl: genReferenceUrl || undefined,   // ← user's product, NOT competitor
      generateCopy: false,
      variantBlueprints: [{
        prompt: finalPrompt,
        aspectRatio: aspectRatio || '1:1',
        modelId: modelId || process.env.URL_TO_ADS_IMAGE_MODEL_ID,
        referenceImageUrl: genReferenceUrl || undefined,
        label: newLabel,
      }],
      extras: {
        sourceScanId: String(scan._id),
        source: competitorImageUrl ? 'competitor_structure_clone' : 'single_ad',
        sourceCompetitor: sourceCompetitor || null,
        // store skeleton for audit/debug + so the report can show "based on this structure"
        ...(competitorImageUrl ? { clonedFromStructure: true } : {}),
      },
    };
console.log(inputs);
  const result = await adSetService.enqueueAdSet({ req, inputs });
  const jobIds = extractChildJobIds(result);
  if (!jobIds.length) {
    const e = new Error('Render job was not created'); e.code = 'enqueue_empty'; throw e;
  }

  // APPEND a new ad — do NOT touch existing scan.ads entries.
  const newAd = {
    label: newLabel,
    prompt: finalPrompt,
    aspectRatio: aspectRatio || '1:1',
    kind: kind || 'image',
    modelId: inputs.variantBlueprints[0].modelId,
    referenceImageUrl: genReferenceUrl || undefined,
    status: 'queued',
    jobId: String(jobIds[0]),
    sourceCompetitor: sourceCompetitor || undefined,
  };
  scan.ads = [...(scan.ads || []), newAd];
  if (scan.status !== 'rendering') scan.status = 'rendering';
  await scan.save();


  return { scan, adSetId: result?.adSetId || null, jobId: String(jobIds[0]) };
}



async function generateAds({
  scanId, req, numVariants = 3, kind = 'image', mode = 'append',
  generateCopy = false,
  modelId, templateCategory, templateName, creativeStyleHint,
  referenceImageUrl, referenceVideoUrl, startImageUrl, locale, extras,
}) {
  const parsed = generateInputSchema.parse({
    scanId,  numVariants, kind, generateCopy, modelId,
    templateCategory, templateName, creativeStyleHint, referenceImageUrl, locale, extras,
  });
  

  const scan = await UrlToAdsScan.findById(parsed.scanId);
  if (!scan) { const e = new Error('Scan not found'); e.code = 'not_found'; throw e; }

  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || (req?.user?.role || '').toLowerCase() === 'admin';
  if (!isOwner) { const e = new Error('forbidden'); e.code = 'forbidden'; throw e; }


  const scrape = scrapeShimFromScan(scan);
  const research = scan.research;
  const businessProfile = scan.businessProfile || inferBusinessProfile(scrape, research);
  const knownDomain = mapBrandCategoryToDomain(scan.brand?.category);
 
  const defaultImageModel = process.env.URL_TO_ADS_IMAGE_MODEL_ID || 'nano_banana_pro';
  const defaultVideoModel = process.env.URL_TO_ADS_VIDEO_MODEL_ID || 'seedance_2_0';
  const defaultModel = kind === 'video' ? defaultVideoModel : defaultImageModel;
 





        

  const newAds = [];
  for (let i = 0; i < parsed.numVariants; i += 1) {
    const bp = await buildAdBlueprint({   
      scrape, research, hookIdx: i, businessProfile,
      locale: parsed.locale || 'global', knownDomain,
      templateCategory, templateName, creativeStyleHint,
    });
 
    newAds.push({
      ...bp,
      kind,
      modelId: modelId || bp.modelId || defaultModel,
      ...(kind === 'video'
        ? { referenceVideoUrl: referenceVideoUrl || undefined, startImageUrl: startImageUrl || undefined,
            aspectRatio: bp.aspectRatio || '9:16' }
        : { referenceImageUrl: referenceImageUrl || bp.referenceImageUrl || undefined }),
      status: 'pending',
    });
  }


  if (mode === 'replace') {
    const otherKind = (scan.ads || []).map(a => (a.toObject ? a.toObject() : a))
      .filter(a => (a.kind || 'image') !== kind);
    scan.ads = [...otherKind, ...newAds];
  } else {
    const existing = (scan.ads || []).map(a => (a.toObject ? a.toObject() : a));
    scan.ads = [...existing, ...newAds];
  }

  
  
  
  const styleSuffix = buildCreativeStyleSuffix(parsed);
  const modelOverride = parsed.modelId || undefined;
  const refOverride = parsed.referenceImageUrl || undefined;
  const rawAudience = scan.audience?.primary || scan.brand?.audience || '';
  const truncatedAudience = rawAudience.length > 200 ? `${rawAudience.slice(0, 197)}…` : rawAudience;

 
  const variantBlueprints = newAds.map((ad) => ({
    prompt:            `${ad.prompt}${styleSuffix}`,
    negativePrompt:    ad.negativePrompt || undefined,
    aspectRatio:       ad.aspectRatio || (kind === 'video' ? '9:16' : '1:1'),
    modelId:           ad.modelId || defaultModel,

    referenceImageUrl: ad.referenceImageUrl || undefined,
    referenceVideoUrl: ad.referenceVideoUrl || undefined,
    startImageUrl:     ad.startImageUrl || undefined,
    label:             ad.label || undefined,
  }));
  // const adsForGen = (scan.ads || []).slice(0, parsed.numVariants);
  const seed = newAds[0];
  if (!seed || !seed.prompt) {
    const e = new Error('Scan has no ad blueprints'); e.code = 'invalid_scan'; throw e;
  }

  // const variantBlueprints = adsForGen.map((ad) => ({
  //   prompt:            `${ad.prompt}${styleSuffix}`,
  //   negativePrompt:    ad.negativePrompt || undefined,
  //   aspectRatio:       ad.aspectRatio || '1:1',
  //   modelId:           modelOverride || ad.modelId || defaultModel,
  //   referenceImageUrl: refOverride || ad.referenceImageUrl || undefined,
  //   label:             ad.label || undefined,
  // }));
 

  const inputs = {
    prompt:            `${seed.prompt}${styleSuffix}`,
    kind:              parsed.kind,                 // ← 'video' flows straight through
    numVariants:       newAds.length,
    aspectRatio:       seed.aspectRatio || (kind === 'video' ? '9:16' : '1:1'),
    brandName:         scan.brand?.name || '',
    targetAudience:    truncatedAudience,
    category:          scan.brand?.category || '',
    locale:            parsed.locale || 'global',
    vibe:              seed.vibe || 'cinematic',
    referenceImageUrl: seed.referenceImageUrl || undefined,
    referenceVideoUrl: seed.referenceVideoUrl || undefined,
    startImageUrl:     seed.startImageUrl || undefined,
    generateCopy:      parsed.generateCopy,
    variantBlueprints,
    extras: { ...(parsed.extras || {}), sourceScanId: String(scan._id), source: 'url_to_ads_scan' },
  };

  // Free-trial grant (unchanged)
  const isAdmin = (req?.user?.role || '').toLowerCase() === 'admin';
  if (!scan.freeTrialConsumed && !isAdmin) {
    try {
      const plan = await adSetService.planAdSet(inputs);
      const grantAmount = Number(plan?.totalCreditsCost) || 0;
      if (grantAmount > 0) {
        const owner = ownerFromReq(req, scan.sessionId);
        if (owner.userId) {
          await creditsService.topUp({
            userId: owner.userId, amount: grantAmount,
            reason: 'topup_signup_bonus',
            meta: { trial: 'url_to_ads', scanId: String(scan._id) },
          }).catch(() => {});
        }
      }
      scan.freeTrialConsumed = true;
      await scan.save().catch(() => {});
    } catch (_e) { /* additive */ }
  }

  const result = await adSetService.enqueueAdSet({ req, inputs });  
  const jobIds = extractChildJobIds(result);
  const adSetId = result?.adSetId || null;
  scan.adSetId = adSetId;
  
  if (!jobIds.length) {
    // Mark ONLY the new ads failed — never touch the older surviving ads.
    const newIds = new Set(newAds.map(a => a.label));
    scan.ads = (scan.ads || []).map(a => {
      const ad = a.toObject ? a.toObject() : a;
      if (newIds.has(ad.label) && !ad.jobId) {
        return { ...ad, status: 'failed', errorMessage: 'Render jobs were not created.' };
      }
      return ad;
    });
    scan.status = 'partial';
    await scan.save();
    return { scan, adSetId: scan.adSetId };
  }

  


  scan.status = 'rendering';
  let cursor = 0;
  scan.ads = (scan.ads || []).map(a => {
    const ad = a.toObject ? a.toObject() : a;
    const isNew = newAds.some(n => n.label === ad.label) && !ad.jobId && ad.status === 'pending';
    if (isNew && jobIds[cursor]) {
      const linked = { ...ad, status: 'queued', jobId: String(jobIds[cursor]) };
      cursor += 1;
      return linked;
    }
    return ad;
  });
  await scan.save();


  return { scan, adSetId:scan.adSetId  };
}


/**
 * Append N×M product-scoped image ads: one AdSet per product (≤5 variants each),
 * then merge new `scan.ads[]` rows with productId metadata for the report UI.
 */
async function generatePerProductAds({
  scanId,
  req,
  productIds,
  variantsPerProduct,
  kind,
  generateCopy,
  modelId,
  templateCategory,
  templateName,
  creativeStyleHint,
  referenceImageUrl,
  locale,
  extras,
}) {
  const parsed = perProductGenerateSchema.parse({
    scanId,
    productIds,
    variantsPerProduct,
    kind,
    generateCopy,
    modelId,
    templateCategory,
    templateName,
    creativeStyleHint,
    referenceImageUrl,
    locale,
    extras,
  });

  const scan = await UrlToAdsScan.findById(parsed.scanId);
  if (!scan) {
    const err = new Error('Scan not found');
    err.code = 'not_found';
    throw err;
  }
  const knownDomain = mapBrandCategoryToDomain(scan.brand?.category);


  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || (req?.user?.role || '').toLowerCase() === 'admin';
  if (!isOwner) {
    const err = new Error('forbidden');
    err.code = 'forbidden';
    throw err;
  }

  // if (scan.status !== 'ready' && scan.status !== 'partial') {
  //   const err = new Error(`Scan is ${scan.status}; can't generate yet.`);
  //   err.code = 'scan_not_ready';
  //   throw err;
  // }
  const REGENERATABLE = new Set(['ready', 'partial', 'completed', 'rendering']);
if (!REGENERATABLE.has(scan.status)) {
  const err = new Error(`Scan is ${scan.status}; can't generate yet.`);
  err.code = 'scan_not_ready';
  throw err;
}

  const products = resolveProductsFromCatalog(scan.productCatalog, parsed.productIds);
  if (!products.length) {
    const err = new Error('None of those product IDs were found in this scan catalog.');
    err.code = 'invalid_product_selection';
    throw err;
  }

  const scrape = scrapeShimFromScan(scan);
  const research = scan.research;
  const businessProfile = scan.businessProfile || inferBusinessProfile(scrape, research);
  const vp = parsed.variantsPerProduct;
  const defaultModel =
    process.env.URL_TO_ADS_IMAGE_MODEL_ID
    || 'nano_banana_pro';

  const parsedStyle = generateInputSchema.parse({
    scanId: parsed.scanId,
    creativeStyleHint: parsed.creativeStyleHint,
    templateCategory: parsed.templateCategory,
    templateName: parsed.templateName,
    referenceImageUrl: parsed.referenceImageUrl,
    locale: parsed.locale,
    extras: parsed.extras,
  });
  const styleSuffix = buildCreativeStyleSuffix(parsedStyle);
  const modelOverride = parsed.modelId || undefined;
  const refOverrideGlobal = parsed.referenceImageUrl || undefined;

  const rawAudience =
    scan.audience?.primary || scan.brand?.audience || '';
  const truncatedAudience =
    rawAudience.length > 200 ? `${rawAudience.slice(0, 197)}…` : rawAudience;

  const existing = (scan.ads || []).map((a) => (a.toObject ? a.toObject() : { ...a }));
  const appended = [];

  let lastAdSetId = scan.adSetId || null;

  const isAdmin = (req?.user?.role || '').toLowerCase() === 'admin';
  let trialUsedThisRun = !!scan.freeTrialConsumed;

  for (const product of products) {
    const blueprints = [];
    for (let vi = 0; vi < vp; vi += 1) {
      const bp = await buildAdBlueprintForProduct({
        scrape,
        research,
        hookIdx: vi,
        businessProfile,
        locale: parsed.locale || 'global',
        product,
        knownDomain: knownDomain,
      });
      blueprints.push(bp);
    }

    const refOverride = refOverrideGlobal || blueprints[0]?.referenceImageUrl;

    const variantBlueprints = blueprints.map((ad) => ({
      prompt:            `${ad.prompt}${styleSuffix}`,
      negativePrompt:    ad.negativePrompt || undefined,
      aspectRatio:       ad.aspectRatio || '1:1',
      modelId:           modelOverride || ad.modelId || defaultModel,
      referenceImageUrl: refOverride || ad.referenceImageUrl || undefined,
      label:             ad.label || undefined,
    }));

    const seed = blueprints[0];
    const inputs = {
      prompt:              `${seed.prompt}${styleSuffix}`,
      kind:                parsed.kind,
      numVariants:         vp,
      aspectRatio:         seed.aspectRatio || '1:1',
      brandName:           scan.brand?.name                 || '',
      targetAudience:      truncatedAudience,
      category:            scan.brand?.category             || '',
      locale:              parsed.locale || 'global',
      vibe:                seed.vibe || 'cinematic',
      referenceImageUrl:   refOverride || seed.referenceImageUrl || undefined,
      generateCopy:        parsed.generateCopy,
      variantBlueprints,
      // extras:              parsed.extras && Object.keys(parsed.extras).length ? parsed.extras : undefined,
      extras: {
        ...(parsed.extras || {}),
        sourceScanId: String(scan._id),
        sourceProductId: String(product?.id ?? product?.handle ?? product?.sku ?? ''),
        source: 'per_product',
      },
    }


    if (!trialUsedThisRun && !isAdmin) {
      try {
        const plan = await adSetService.planAdSet(inputs);
        const grantAmount = Number(plan?.totalCreditsCost) || 0;
        if (grantAmount > 0) {
          const owner = ownerFromReq(req, scan.sessionId);
          if (owner.userId) {
            await creditsService.topUp({
              userId: owner.userId,
              amount: grantAmount,
              reason: 'topup_signup_bonus',
              meta: { trial: 'url_to_ads_per_product', scanId: String(scan._id) },
            }).catch(() => {});
          }
        }
        trialUsedThisRun = true;
        scan.freeTrialConsumed = true;
        await scan.save().catch(() => {});
      } catch (_e) {
        // continue without grant
      }
    }

    const { adSetId, children } = await adSetService.enqueueAdSet({ req, inputs });
    lastAdSetId = adSetId;
    const childrenArr = Array.isArray(children) ? children : [];


    const result = await adSetService.enqueueAdSet({ req, inputs });
    const jobIds = extractChildJobIds(result);
    lastAdSetId = result?.adSetId || lastAdSetId;

    if (!jobIds.length) {
      console.error('[generatePerProductAds] enqueueAdSet returned NO child ids for product:',
        product?.title, '| keys:', JSON.stringify(Object.keys(result || {})));
    }

    for (let i = 0; i < blueprints.length; i += 1) {
      const ad = blueprints[i];
      const jobId = jobIds[i];
      appended.push({
        ...ad,
        status: jobId ? 'queued' : 'failed',
        jobId: jobId ? String(jobId) : undefined,
        errorMessage: jobId ? undefined : 'Render job not created.',
        kind: 'image',
      });
    }
    
  }

  scan.ads = [...existing, ...appended];
  scan.adSetId = lastAdSetId;
  scan.status = 'rendering';
  await scan.save();

  return { scan, adSetId: lastAdSetId };
}

async function getScan(scanId, req) {
  const scan = await UrlToAdsScan.findById(scanId);
  if (!scan) return null;
  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || (req?.user?.role || '').toLowerCase() === 'admin';
  if (!isOwner) {
    const err = new Error('forbidden');
    err.code = 'forbidden';
    throw err;
  }
  return scan;
}

async function listScans({ req, limit = 20 }) {
  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const filter = userId
    ? { userId }
    : sessionId
      ? { sessionId }
      : null;
  if (!filter) return [];
  return UrlToAdsScan.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();
}

async function archiveScan(scanId, req) {
  const scan = await getScan(scanId, req);
  if (!scan) return null;
  scan.status = 'archived';
  await scan.save();
  return scan;
}

async function updateScanDigest({ scanId, req, digestEnrolled }) {
  const scan = await getScan(scanId, req);
  if (!scan) return null;
  scan.digestEnrolled = !!digestEnrolled;
  await scan.save();
  return scan;
}

/**
 * Called from the image worker when an ad_set_child job finishes so the
 * UrlToAdsScan document reflects real CDN URLs (polling GET /scan/:id).
 *
 * Uses positional `$` updates to avoid lost writes when 3 children complete
 * in parallel.
 *
 * @param {any} job — StudioJob document or `.lean()` object
 */
async function syncStudioJobToUrlToAdsScan(job) {
  try {
    if (!job || job.promptPipeline?.strategy !== 'ad_set_child' || job.kind !== 'image') return;
    const jobIdStr = String(job._id);
    const scanRow = await UrlToAdsScan.findOne({ 'ads.jobId': jobIdStr }).select('_id').lean();
    if (!scanRow?._id) return;

    if (job.status === 'completed') {
      const finalUrl = job.isWatermarked ? job.output?.watermarkedUrl : job.output?.cleanUrl;
      const thumb = job.output?.storedImageUrl || finalUrl;
      await UrlToAdsScan.updateOne(
        { _id: scanRow._id, 'ads.jobId': jobIdStr },
        {
          $set: {
            'ads.$.status':       'ready',
            'ads.$.assetUrl':     finalUrl || null,
            'ads.$.thumbnailUrl': thumb || null,
            'ads.$.assetId':      job.assetId ? String(job.assetId) : null,
          },
          $unset: { 'ads.$.errorMessage': '' },
        },
      );
    } else if (job.status === 'failed') {
      await UrlToAdsScan.updateOne(
        { _id: scanRow._id, 'ads.jobId': jobIdStr },
        {
          $set: {
            'ads.$.status':        'failed',
            'ads.$.errorMessage':  job.error?.message || job.statusMessage || 'Render failed',
          },
        },
      );
    } else {
      return;
    }

    const fresh = await UrlToAdsScan.findById(scanRow._id).lean();
    const ads = fresh?.ads || [];
    const isTerminal = (s) => s === 'ready' || s === 'failed';
    if (ads.length && ads.every((a) => isTerminal(a.status))) {
      const anyReady = ads.some((a) => a.status === 'ready');
      const anyFailed = ads.some((a) => a.status === 'failed');
      let nextStatus = 'ready';
      if (anyFailed && !anyReady) nextStatus = 'partial';
      else if (anyFailed && anyReady) nextStatus = 'partial';
      await UrlToAdsScan.updateOne({ _id: scanRow._id }, { $set: { status: nextStatus } });
    }
  } catch (e) {
    console.warn('[urlToAdsService] syncStudioJobToUrlToAdsScan:', e?.message);
  }
}

/**
 * Fallback competitor generator when AI research fails.
 * Uses simple heuristics: competitor names based on category + category-specific templates.
 */
function generateFallbackCompetitors(scrape, businessProfile) {
  const category = (scrape.category || 'general').toLowerCase();
  const brandName = (scrape.brandName || '').toLowerCase();

  const competitorTemplates = {
    gym: [
      { name: 'Gold\'s Gym', domain: 'goldsgym.com' },
      { name: 'Planet Fitness', domain: 'planetfitness.com' },
      { name: 'ANYTIME FITNESS', domain: 'anytimefitness.com' },
      { name: 'LA Fitness', domain: 'lafitness.com' },
      { name: 'Crunch Fitness', domain: 'crunch.com' },
    ],
    retail: [
      { name: 'Amazon', domain: 'amazon.com' },
      { name: 'eBay', domain: 'ebay.com' },
      { name: 'Alibaba', domain: 'alibaba.com' },
      { name: 'Shopify Store', domain: 'shopify.com' },
    ],
    saas: [
      { name: 'Salesforce', domain: 'salesforce.com' },
      { name: 'HubSpot', domain: 'hubspot.com' },
      { name: 'Monday.com', domain: 'monday.com' },
      { name: 'Slack', domain: 'slack.com' },
    ],
    ecommerce: [
      { name: 'Shopify', domain: 'shopify.com' },
      { name: 'WooCommerce', domain: 'woocommerce.com' },
      { name: 'BigCommerce', domain: 'bigcommerce.com' },
      { name: 'Magento', domain: 'magento.com' },
    ],
    restaurant: [
      { name: 'Zomato', domain: 'zomato.com' },
      { name: 'Just Eat', domain: 'justeat.com' },
      { name: 'Grubhub', domain: 'grubhub.com' },
      { name: 'DoorDash', domain: 'doordash.com' },
    ],
    fitness: [
      { name: 'Peloton', domain: 'peloton.com' },
      { name: 'Apple Fitness+', domain: 'apple.com/fitness' },
      { name: 'ClassPass', domain: 'classpass.com' },
      { name: 'Beachbody', domain: 'beachbody.com' },
    ],
  };

  // Pick template set based on category
  const templates = competitorTemplates[category] || competitorTemplates.retail;

  // Return 4-5 competitors from the template, shuffled
  return templates
    .sort(() => Math.random() - 0.5)
    .slice(0, 4)
    .map((c) => ({
      name: c.name,
      url: `https://${c.domain}`,
      domain: c.domain,
      why: `Direct competitor in ${category}`,
      differentiator: 'Template-based fallback',
      source: 'fallback',
    }));
}



async function confirmBrand({ scanId, req, payload }) {
  const scan = await UrlToAdsScan.findById(scanId);
  if (!scan) { const e = new Error('Scan not found'); e.code = 'not_found'; throw e; }
 
  const sessionId = getSessionId(req);
  const userId = getUserId(req);
  const isOwner = (userId && String(scan.userId) === String(userId))
    || (sessionId && scan.sessionId === sessionId)
    || (req?.user?.role || '').toLowerCase() === 'admin';
  if (!isOwner) { const e = new Error('forbidden'); e.code = 'forbidden'; throw e; }
 
  // Whitelist + clamp.
  const palette = Array.isArray(payload.palette)
    ? payload.palette.filter((h) => /^#[0-9a-fA-F]{6}$/.test(h)).slice(0, 6)
    : [];
 
  const socials = {};
  for (const k of ['instagram', 'facebook', 'tiktok', 'linkedin', 'twitter']) {
    const s = payload?.socials?.[k];
    socials[k] = s && (s.handle || s.url)
      ? { handle: String(s.handle || '').slice(0, 120), url: String(s.url || '').slice(0, 400), confirmed: !!s.confirmed }
      : null;
  }
 
  const competitors = Array.isArray(payload.competitors)
    ? payload.competitors.slice(0, 12)
    : [];
 
  scan.confirmedBrand = {
    confirmed: true,
    confirmedAt: new Date(),
    name: String(payload.name || scan.brand?.name || '').slice(0, 200),
    category: String(payload.category || scan.brand?.category || '').slice(0, 120),
    palette,
    socials,
    competitors,
    edits: payload.edits && typeof payload.edits === 'object' ? payload.edits : {},
  };
  scan.markModified('confirmedBrand');
 
  // Mirror confirmed data back into the canonical fields generation reads,
  // so existing generate paths pick it up WITHOUT a rewrite:
  if (scan.confirmedBrand.name) scan.brand = { ...(scan.brand || {}), name: scan.confirmedBrand.name };
  if (scan.confirmedBrand.category) scan.brand = { ...(scan.brand || {}), category: scan.confirmedBrand.category };
  if (palette.length) {
    scan.brandPalette = {
      ...(scan.brandPalette || {}),
      swatches: palette.map((hex) => ({ hex })),
      primary: palette[0],
      accent: palette[1] || palette[0],
      _source: 'user_confirmed',
    };
    scan.markModified('brandPalette');
  }
  // Confirmed socials → the place ROAST + generation read from.
  const handleRecord = {};
  for (const [k, v] of Object.entries(socials)) {
    if (v) { handleRecord[`${k}Handle`] = v.handle; handleRecord[`${k}Url`] = v.url; }
  }
  if (!scan.intelligence) scan.intelligence = {};
  if (!scan.intelligence.brandIdentity) scan.intelligence.brandIdentity = {};
  scan.intelligence.brandIdentity.handles = { ...(scan.intelligence.brandIdentity.handles || {}), ...handleRecord };
  scan.brand = { ...(scan.brand || {}), socialHandles: { ...(scan.brand?.socialHandles || {}), ...handleRecord } };
  scan.markModified('intelligence');
  scan.markModified('brand');
 
  if (competitors.length) {
    scan.competitors = competitors;
    scan.markModified('competitors');
  }
 
  await scan.save();
  return scan;
}


async function buildVideoAdBlueprints(args) {
  const {
    scan, count, modelId, templateCategory, templateName,
    creativeStyleHint, referenceVideoUrl, startImageUrl, extras,
  } = args;
 
  const brand = scan.confirmedBrand?.confirmed ? scan.confirmedBrand : scan.brand;
 

  const angles = await videoAdGenerator.selectAngles({ scan, count });
 
  const blueprints = [];
  for (const angle of angles.slice(0, count)) {
    const vp = await videoAdGenerator.buildPrompt({
      brand,
      angle,
      styleHint: creativeStyleHint,
      referenceVideoUrl,        // the nas.io-style clip the user picked
      startImageUrl,            // competitor poster, if "make this as video"
      palette: scan.brandPalette?.swatches,
    });
 
    blueprints.push({
      kind: 'video',
      label: angle.label,
      headline: angle.headline,
      hookLine: angle.hookLine,
      aspectRatio: angle.aspectRatio || '9:16',
      vibe: angle.vibe,
      prompt: vp.prompt,
      negativePrompt: vp.negativePrompt,
      modelId: modelId || 'seedance_2_0',
      referenceVideoUrl: referenceVideoUrl || null,
      startImageUrl: startImageUrl || null,
      templateCategory: templateCategory || null,
      templateName: templateName || null,
      status: 'pending',
      _providerInput: vp.providerInput, // pass through ensureRouting (extras)
    });
  }
  return blueprints;
}



 
/**
 * onStudioJobCompleted — route a finished job to the correct scan sync.
 * Call AFTER job.output.storedVideoUrl (or image url) is persisted.
 */
async function onStudioJobCompleted(job) {
  const jobId = String(job._id || job.id);
 
  // Is this job one of a video ad's shots? (its id is in some row's shotJobIds)
  const isVideoShot = await UrlToAdsScan.exists({ 'ads.shotJobIds': jobId });
 
  if (isVideoShot) {
    const r = await syncShotJobToVideoAd(job);     // writes clipUrl into shotPlan[i]
    // when all shots ready, trigger the stitch (Phase 4)
    if (r?.allReady && r?.adRow) {
      const { enqueueStitchJob } = require('./queues');
      await enqueueStitchJob({ scanId: r.scanId, adJobId: r.adRow.jobId });
    }
    return;
  }
 
  // otherwise it's an image ad (or a normal studio job) — existing path
  if (typeof syncStudioJobToUrlToAdsScan === 'function') {
    await syncStudioJobToUrlToAdsScan(job).catch(() => {});
  }
}





module.exports = {
  scanUrl,
  generateAds,
  generateSingleAd,
  generatePerProductAds,
  getScan,
  listScans,
  confirmBrand,
  archiveScan,
  updateScanDigest,
  syncStudioJobToUrlToAdsScan,
  // Pure helpers (exported for unit tests)
  buildCopyPack,
  buildAdBlueprint,
  buildAdBlueprintForProduct,
  onStudioJobCompleted,
  pickAudience,
  inferBusinessProfile,
  _schemas: { scanInputSchema, generateInputSchema, perProductGenerateSchema },
};
