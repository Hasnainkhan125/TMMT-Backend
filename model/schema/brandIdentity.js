// models/brandIdentity.model.js
const mongoose = require('mongoose');

const EvidenceSchema = new mongoose.Schema({
  field:      { type: String, required: true },
  value:      { type: String },
  source:     { 
    type: String, 
    enum: ['meta_tags', 'schema_org', 'og_tags', 'footer_link', 'inline_script', 
           'tracking_id', 'logo_match', 'text_match', 'social_link', 'dns_record',
           'llm_inference', 'user_confirmed', 'third_party_api', 'cross_verification'],
  },
  confidence: { type: Number, min: 0, max: 1 },
  at:         { type: Date, default: Date.now },
}, { _id: false });

const BrandIdentitySchema = new mongoose.Schema({
  // ── INPUT ────────────────────────────────────────────────────
  inputUrl: { type: String, required: true },
  
  // ── CANONICAL IDENTITY ───────────────────────────────────────
  canonicalDomain: { type: String, required: true, index: true, unique: true },
  brandName:       { type: String },
  legalName:       { type: String },
  aliases:         { type: [String], default: [] },
  tagline:         { type: String },
  description:     { type: String },
  
  // ── MARKETS & LANGUAGES ──────────────────────────────────────
  markets:   { type: [String], default: [] },   // ISO country codes
  languages: { type: [String], default: [] },   // ISO lang codes
  currency:  { type: String },                  // AED, USD, etc.
  phone:     { type: String },
  email:     { type: String },
  address:   { type: String },
  
  // ── SOCIAL HANDLES ───────────────────────────────────────────
  handles: {
    facebookPageId:     { type: String },
    facebookPageUrl:    { type: String },
    facebookPageName:   { type: String },
    instagramHandle:    { type: String },
    instagramId:        { type: String },
    instagramFollowers: { type: Number },
    tiktokHandle:       { type: String },
    tiktokFollowers:    { type: Number },
    youtubeChannel:     { type: String },
    youtubeSubscribers: { type: Number },
    twitterHandle:      { type: String },
    linkedinCompany:    { type: String },
    linkedinEmployees:  { type: Number },
    snapchatHandle:     { type: String },
    pinterestHandle:    { type: String },
    threadsHandle:      { type: String },
    whatsappBusiness:   { type: String },
  },
  
  // ── TRACKING / ANALYTICS IDs (The Goldmine) ──────────────────
  trackingIds: {
    googleAnalytics:    [{ type: String }],   // G-XXXXXXX, UA-XXXXXXX
    googleTagManager:   [{ type: String }],   // GTM-XXXXXXX
    googleAdsConversion:[{ type: String }],   // AW-XXXXXXX
    facebookPixel:      [{ type: String }],   // 16-digit IDs
    tiktokPixel:        [{ type: String }],   // C4ABC... format
    linkedinInsight:    [{ type: String }],   // 6-digit partner ID
    snapchatPixel:      [{ type: String }],
    pinterestTag:       [{ type: String }],
    twitterPixel:       [{ type: String }],
    redditPixel:        [{ type: String }],
    microsoftUet:       [{ type: String }],
    hotjar:             [{ type: String }],
    mixpanel:           [{ type: String }],
    segment:            [{ type: String }],
    amplitude:          [{ type: String }],
    intercom:           [{ type: String }],
    hubspot:            [{ type: String }],
    klaviyo:            [{ type: String }],
    clarity:            [{ type: String }],   // Microsoft Clarity
    plausible:          [{ type: Boolean }],  // Just presence flag
    fathom:             [{ type: Boolean }],
  },
  
  // ── WHAT THEIR TRACKING STACK TELLS US ───────────────────────
  // Derived intelligence — these are the actionable bits
  adSignals: {
    runningMetaAds:     { type: Boolean, default: false },
    runningGoogleAds:   { type: Boolean, default: false },
    runningTikTokAds:   { type: Boolean, default: false },
    runningLinkedInAds: { type: Boolean, default: false },
    runningSnapchatAds: { type: Boolean, default: false },
    pixelAgeDays:       { type: Number },      // How long they've been tracking
    conversionApiActive: { type: Boolean },    // CAPI = serious advertiser
  },
  
  // ── TECH STACK ───────────────────────────────────────────────
  techStack: {
    platform:      { type: String },  // shopify, woocommerce, wix, squarespace, custom
    cms:           { type: String },
    framework:     { type: String },  // react, vue, next, nuxt, etc.
    hosting:       { type: String },  // cloudflare, vercel, aws, etc.
    ecommerceTech: { type: [String] },
    marketingTech: { type: [String] }, // klaviyo, mailchimp, etc.
    crmTech:       { type: [String] },
    supportTech:   { type: [String] }, // intercom, zendesk, etc.
  },
  
  // ── BRAND ASSETS ─────────────────────────────────────────────
  assets: {
    favicon:           { type: String },          // URL
    faviconHash:       { type: String },          // For brand match dedup
    logo:              { type: String },
    logoHash:          { type: String },
    logoIsLightBg:     { type: Boolean },
    ogImage:           { type: String },          // Open Graph default share image
    heroImages:        { type: [String], default: [] },
    screenshots: {
      desktop:   { type: String },                // S3/R2 URL of rendered screenshot
      mobile:    { type: String },
      fullPage:  { type: String },
      darkMode:  { type: String },                // If they have dark mode
    },
    brandColors: {
      palette: [{
        hex:        { type: String },
        role:       { type: String },             // primary, accent, bg, neutral
        brightness: { type: Number },
        saturation: { type: Number },
        coverage:   { type: Number },             // How much of UI uses it
        source:     { type: String },             // theme-color, css-var, vibrant, logo
      }],
      primary:    { type: String },
      accent:     { type: String },
      background: { type: String },
    },
    fonts: [{
      family:   { type: String },
      weights:  { type: [String] },
      provider: { type: String },                 // google, custom, adobe, system
      role:     { type: String },                 // headings, body, ui
      url:      { type: String },                 // If self-hosted
    }],
  },
  
  // ── CONTENT SNAPSHOT ─────────────────────────────────────────
  content: {
    title:       { type: String },
    metaDesc:    { type: String },
    headlines:   { type: [String], default: [] },
    heroCopy:    { type: String },
    ctas:        { type: [String], default: [] },
    valueProps:  { type: [String], default: [] },
    keywords:    { type: [String], default: [] },
    languages:   { type: [String], default: [] },
  },
  
  // ── TRAFFIC PROXIES ──────────────────────────────────────────
  trafficSignals: {
    estimatedMonthlyVisits: { type: Number },     // From 3rd party or null
    trafficSource:          { type: String },     // similarweb, alexa, null
    alexaRank:              { type: Number },
    domainAge:              { type: Number },     // Days since registration
    backlinks:              { type: Number },     // If detectable
    hasStructuredData:      { type: Boolean },
    hasSitemap:             { type: Boolean },
    pageCount:              { type: Number },     // From sitemap
    techCrunchFeatured:     { type: Boolean },    // Press mentions
    producthuntFeatured:    { type: Boolean },
  },
  
  // ── CONFIDENCE & EVIDENCE ────────────────────────────────────
  confidence: {
    brandName:       { type: Number, min: 0, max: 1, default: 0 },
    facebookPage:    { type: Number, min: 0, max: 1, default: 0 },
    instagramHandle: { type: Number, min: 0, max: 1, default: 0 },
    businessType:    { type: Number, min: 0, max: 1, default: 0 },
    overall:         { type: Number, min: 0, max: 1, default: 0 },
  },
  
  evidence: [EvidenceSchema],
  
  // ── DISCOVERED LANDING DOMAINS ───────────────────────────────
  knownLandingDomains: { type: [String], default: [] },
  redirectMap:         { type: Map, of: String },
  
  // ── BUSINESS CLASSIFICATION ──────────────────────────────────
  businessType: { 
    type: String,
    enum: ['product_brand', 'restaurant', 'cafe', 'clinic_medical', 
           'clinic_dental', 'clinic_cosmetic', 'real_estate', 'fitness_gym',
           'law_firm', 'beauty_salon', 'automotive', 'saas_b2b', 'saas_b2c',
           'education', 'hospitality', 'events_wedding',
           // ── Added ──
           'marketing_agency',      // ← MeshMedia fits here
           'creative_agency',
           'consulting',
           'professional_services',
           'general_business'],
    default: 'general_business',
  },
  subtype: { type: String },
  
  // ── LIFECYCLE ────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'resolving', 'resolved', 'enriching', 'complete', 'failed', 'blocked'],
    default: 'pending',
  },
  errors: [{ step: String, code: String, message: String, at: Date }],
  
  resolvedAt:      { type: Date },
  lastEnrichedAt:  { type: Date },
  nextEnrichAt:    { type: Date, index: true },
  enrichmentVersion: { type: Number, default: 1 },  // For re-running when extractors improve
  
  // ── CACHING / DEDUPLICATION ──────────────────────────────────
  htmlHash:     { type: String },                   // For change detection
  lastHtmlAt:   { type: Date },
  scanCount:    { type: Number, default: 1 },       // How many users scanned this
  
}, { 
  timestamps: true,
  strict: false,  // Allow extractor additions without schema bumps
});

// Compound indexes for common queries
BrandIdentitySchema.index({ canonicalDomain: 1, status: 1 });
BrandIdentitySchema.index({ 'handles.facebookPageId': 1 }, { sparse: true });
BrandIdentitySchema.index({ 'handles.instagramHandle': 1 }, { sparse: true });
BrandIdentitySchema.index({ nextEnrichAt: 1, status: 1 });

// Virtual: is this data fresh enough to trust?
BrandIdentitySchema.virtual('isFresh').get(function() {
  if (!this.resolvedAt) return false;
  const age = Date.now() - this.resolvedAt.getTime();
  return age < 7 * 24 * 60 * 60 * 1000; // 7 days
});

module.exports = mongoose.model('BrandIdentity', BrandIdentitySchema);