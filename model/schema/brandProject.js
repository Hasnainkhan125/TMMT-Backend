const mongoose = require('mongoose');

// ─── Fragrance Config Sub-Schema ─────────────────────────────────────────────
const fragranceConfigSchema = new mongoose.Schema({
  brandName:       { type: String },
  scentProfile:    { type: String },
  family:          { type: String },
  concentration:   { type: String },
  topNotes:        [{ type: String }],
  middleNotes:     [{ type: String }],
  baseNotes:       [{ type: String }],
  longevity:       { type: String },
  targetGender:    { type: String, enum: ['masculine', 'feminine', 'unisex', ''] },
  targetAgeGroup:  { type: String },
  mood:            { type: String },
  occasion:        { type: String },
}, { _id: false });

// ─── Skincare Config Sub-Schema ──────────────────────────────────────────────
const skincareConfigSchema = new mongoose.Schema({
  brandName:       { type: String },
  productLine:     [{ type: String }],
  skinType:        [{ type: String }],
  keyIngredients:  [{ type: String }],
  certifications:  [{ type: String }],
  targetConcern:   [{ type: String }],
  formulationType: { type: String },
  productCategory: { type: String },
}, { _id: false });

// ─── Custom Business Config Sub-Schema ───────────────────────────────────────
const customFieldSchema = new mongoose.Schema({
  key:   { type: String},
  label: { type: String},
  value: { type: mongoose.Schema.Types.Mixed },
  type:  { type: String, enum: ['text', 'select', 'multiselect', 'number', 'textarea', 'boolean'] },
}, { _id: false });

// ─── Bottle & Packaging Sub-Schema ───────────────────────────────────────────
const packagingSchema = new mongoose.Schema({
  bottleShape:      { type: String },
  bottleMaterial:   { type: String },
  bottleSizeMl:     { type: Number },
  capStyle:         { type: String },
  labelFinish:      { type: String },
  labelColors:      [{ type: String }],
  packagingType:    { type: String },
  packagingMaterial:{ type: String },
  unboxingNote:     { type: String },
  qrCodeEnabled:    { type: Boolean, default: false },
  nfcEnabled:       { type: Boolean, default: false },
}, { _id: false });

// ─── Supplier Quotation Sub-Schema ───────────────────────────────────────────
const quotationSchema = new mongoose.Schema({
  supplierId:      { type: String },
  supplierName:    { type: String },
  quantity:        { type: Number },
  pricePerUnit:    { type: Number },
  totalCost:       { type: Number },
  currency:        { type: String, default: 'USD' },
  leadTimeDays:    { type: Number },
  status:          { type: String, enum: ['pending', 'sent', 'accepted', 'rejected'], default: 'pending' },
  sentAt:          { type: Date },
}, { _id: false });

// ─── Generated Asset Sub-Schema ──────────────────────────────────────────────
const generatedAssetSchema = new mongoose.Schema({
  type:        { type: String, enum: ['mockup', 'label', 'bottle', 'ad_video', 'packaging', 'logo'] },
  url:         { type: String },
  thumbnail:   { type: String },
  prompt:      { type: String },
  creditsCost: { type: Number, default: 1 },
  generatedAt: { type: Date, default: Date.now },
  status:      { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
}, { _id: true });

// ─── Main Brand Project Schema ────────────────────────────────────────────────
const brandProjectSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  businessType: {
    type: String,
    enum: ['perfume', 'skincare', 'food', 'clothing', 'tech', 'wellness', 'consulting', 'services', 'trading', 'manufacturing', 'custom'],
    required: true,
  },
  detectedActivity: { type: String },
  sector: { type: String },
  projectName:  { type: String, required: true, trim: true },
  status:       {
    type: String,
    enum: ['draft', 'configured', 'quotation_sent', 'launched'],
    default: 'draft',
  },

  // Wizard completion tracking
  wizardStep: { type: Number, default: 0 },
  wizardCompleted: { type: Boolean, default: false },

  // Business-type specific configs
  fragranceConfig: { type: fragranceConfigSchema, default: null },
  skincareConfig:  { type: skincareConfigSchema,  default: null },
  customFields:    { type: [customFieldSchema],   default: [] },
  customBusinessType: { type: String }, // for custom type: e.g. "Candle Brand"

  // Packaging (shared across types)
  packaging: { type: packagingSchema, default: {} },

  // Production
  quantity: { type: Number, default: 1000 },
  targetMarket: { type: String },
  targetCountries: [{ type: String }],
  pricePoint: { type: String, enum: ['budget', 'mid-range', 'luxury', 'ultra-luxury', ''] },

  // Supplier
  selectedSupplierId: { type: String },
  quotation: { type: quotationSchema, default: null },

  // AI-generated assets
  generatedAssets: { type: [generatedAssetSchema], default: [] },

  // Ad video
  adVideo: {
    status: { type: String, enum: ['none', 'generating', 'ready', 'failed'], default: 'none' },
    url:    { type: String },
    script: { type: String },
    style:  { type: String },
    creditsCost: { type: Number, default: 5 },
    generatedAt: { type: Date },
  },

  // Upsell tracking
  upsellSuggestions: [{ type: String }],
  completionScore:   { type: Number, default: 0, min: 0, max: 100 },

  // AI-generated brand concept (from aiBrandController.saveBrand)
  // Stores { brand: BrandData, inputs: object } — Mixed to allow flexible shape
  config: { type: mongoose.Schema.Types.Mixed, default: null },

  // ─── AI-researched business profile (runs once on first dashboard open) ────
  businessProfile: {
    businessType: String,
    sector: String,
    financials: {
      estimatedMonthlyRevenueLow: Number,
      estimatedMonthlyRevenueHigh: Number,
      estimatedStartupCostLow: Number,
      estimatedStartupCostHigh: Number,
      estimatedMarginPercent: Number,
      revenueModelExplanation: String,
      researchBasis: String,
    },
    suppliers: [{
      name: String,
      type: String,
      location: String,
      relevance: String,
      contactType: { type: String, enum: ['website', 'whatsapp', 'walk_in', 'registration', 'phone', 'email'] },
      contactValue: String,
      estimatedCost: String,
      _id: false,
    }],
    audiencePlatforms: {
      instagram: Number,
      tiktok: Number,
      google: Number,
      linkedin: Number,
      snapchat: Number,
      youtube: Number,
      dubizzle: Number,
    },
    startupChecklist: [{
      item: String,
      cost: String,
      priority: { type: String, enum: ['immediate', 'week1', 'month1'] },
      _id: false,
    }],
    aiResearchCompletedAt: Date,
    aiResearchModel: String,
    // Competitors & Dashboard Intelligence
    competitors: [{
      name: String,
      location: String,
      website: String,
      instagram: String,
      estimatedMonthlyRevenue: String,
      estimatedAdSpendMonthly: String,
      estimatedAdSpendDaily: String,
      strengths: String,
      weaknesses: String,
      targetAudience: String,
      _id: false,
    }],
    usp: [String],
    kpis: [{
      label: String,
      value: String,
      target: String,
      unit: String,
      _id: false,
    }],
    estimatedDailyAdSpend: String,
    competitorTotalMonthlyAdSpend: String,
  },

  // ─── Generated Images (Visual Studio — saved after each generation) ────────
  generatedImages: [{
    url: String,
    prompt: String,
    type: { type: String, default: 'visual' },
    createdAt: { type: Date, default: Date.now },
    _id: false,
  }],

  // ─── Email addresses captured for kit downloads ───────────────────────────
  kitDownloadEmails: [String],

  // ─── Content Calendar (30 items generated per brand) ──────────────────────
  contentCalendar: [{
    dayNumber: Number,
    platform: { type: String, enum: ['instagram', 'tiktok', 'facebook', 'linkedin', 'snapchat', 'youtube'] },
    contentType: { type: String, enum: ['launch', 'story', 'product', 'hook', 'qa', 'cta', 'testimonial', 'carousel', 'behind_scenes', 'tips', 'lifestyle', 'community', 'milestone', 'recap', 'transformation', 'value'] },
    caption: String,
    hashtags: [String],
    hook: String,
    status: { type: String, enum: ['draft', 'scheduled', 'posted'], default: 'draft' },
    scheduledAt: Date,
    postedAt: Date,
  }],

  // Zapier webhook for auto-posting
  zapierWebhookUrl: String,

  // ─── Marketing Cofounder Agent Memory (structured, per spec) ────────────────
  agentMemory: {
    lastResearchAt:  Date,
    lastStrategyAt:  Date,
    lastContentAt:   Date,
    lastGrowthAt:    Date,

    competitors: [{
      name:              String,
      platform:          String,
      handle:            String,
      strengths:         [String],
      weaknesses:        [String],
      recentPostTopics:  [String],
      avgEngagementRate: Number,
      lastScannedAt:     Date,
      _id: false,
    }],

    usp: {
      current:           String,
      history: [{
        statement:  String,
        rationale:  String,
        generatedAt: Date,
        version:    Number,
        _id: false,
      }],
      competitiveGap:    String,
      customerPainPoints:[String],
    },

    audience: {
      primary: {
        description:        String,
        platforms:           [String],
        peakHours:           [String],
        contentPreferences:  [String],
        buyingTriggers:      [String],
      },
      b2bTargets: [{
        companyType:       String,
        decisionMaker:     String,
        painPoint:         String,
        approachChannel:   String,
        emailSubjectLine:  String,
        coldEmailTemplate: String,
        _id: false,
      }],
    },

    contentInsights: [{
      topic:           String,
      platform:        String,
      postedAt:        Date,
      performanceNote: String,
      agentLearning:   String,
      _id: false,
    }],

    growthStage: {
      current:        String,
      weeklyGoal:     String,
      suggestedFocus: String,
      metrics: {
        followersTarget: Number,
        leadsTarget:     Number,
        revenueTarget:   Number,
      },
    },

    s3Paths: {
      root:     String,
      research: String,
      content:  String,
      assets:   String,
      memory:   String,
    },

    // Legacy tab-based memory (kept for backward compat)
    chatHistory: [{
      tab:       String,
      message:   String,
      response:  String,
      createdAt: { type: Date, default: Date.now },
      _id: false,
    }],
  },

  // ─── Agent Insights (shown on dashboard — from all 4 agents) ──────────────
  agentInsights: [{
    id:            String,
    agentType:     { type: String, enum: ['research', 'strategy', 'content', 'growth'] },
    type:          { type: String, enum: ['competitor_gap', 'usp', 'content_idea', 'growth_action', 'trend_alert', 'weekly_theme'] },
    title:         String,
    body:          String,
    actionLabel:   String,
    actionPayload: { type: mongoose.Schema.Types.Mixed },
    priority:      { type: Number, default: 3 },
    read:          { type: Boolean, default: false },
    dismissed:     { type: Boolean, default: false },
    generatedAt:   { type: Date, default: Date.now },
    _id: false,
  }],

  // ─── Content Items (enriched calendar — agent-generated) ──────────────────
  contentItems: [{
    id:                     String,
    agentGenerated:         { type: Boolean, default: false },
    platform:               { type: String, enum: ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'snapchat', 'youtube'] },
    contentType:            { type: String, enum: ['post', 'reel', 'story', 'carousel', 'article', 'thread', 'video_description'] },
    status:                 { type: String, enum: ['draft', 'approved', 'scheduled', 'posted'], default: 'draft' },
    caption:                String,
    hashtags:               [String],
    hook:                   String,
    visualPrompt:           String,
    imageUrl:               String,
    videoUrl:               String,
    videoApprovalStatus:    { type: String, enum: ['pending_admin', 'approved', 'rejected'] },
    videoApprovalRequestedAt: Date,
    topic:                  String,
    strategicGoal:          { type: String, enum: ['awareness', 'engagement', 'conversion', 'retention'] },
    competitorGapExploited: String,
    callToAction:           String,
    contentPillar:          { type: String, enum: ['education', 'entertainment', 'inspiration', 'promotion', 'social_proof'] },
    audienceSegment:        String,
    estimatedBestTime:      String,
    dayNumber:              Number,
    scheduledAt:            Date,
    postedAt:               Date,
    zapierWebhookFired:     { type: Boolean, default: false },
    performance: {
      views:      Number,
      likes:      Number,
      comments:   Number,
      shares:     Number,
      leads:      Number,
      founderNote: String,
    },
    generatedAt: { type: Date, default: Date.now },
    _id: false,
  }],

  // ─── Video Generation Requests (require admin approval) ───────────────────
  videoRequests: [{
    platform:    String,
    description: String,
    style:       String,
    duration:    String,
    status:      { type: String, enum: ['pending', 'approved', 'generating', 'done', 'rejected'], default: 'pending' },
    videoUrl:    String,
    requestedAt: { type: Date, default: Date.now },
    _id:         false,
  }],

  // ─── Scheduled Social Posts (from calendar — legacy, use contentItems) ─────
  scheduledPosts: [{
    platform:    String,
    content:     String,
    imageUrl:    String,
    scheduledAt: Date,
    dayNumber:   Number,
    status:      { type: String, enum: ['draft', 'scheduled', 'posted'], default: 'scheduled' },
    createdAt:   { type: Date, default: Date.now },
    _id:         false,
  }],

  // ─── Leads (Sales Cofounder — Apollo + Outreach) ───────────────────────────
  leads: [{
    id:             String,
    source:         { type: String, enum: ['apollo', 'manual', 'linkedin_import'], default: 'apollo' },
    apolloId:       String,
    firstName:      String,
    lastName:       String,
    fullName:       String,
    email:          String,
    emailVerified:  { type: Boolean, default: false },
    title:          String,
    company:        String,
    companySize:    String,
    industry:       String,
    linkedinUrl:    String,
    website:        String,
    location:       String,
    icpScore:       { type: Number, default: 0 },
    icpRationale:   String,
    leadStage:      { type: String, enum: ['new', 'contacted', 'replied', 'meeting', 'closed', 'not_fit'], default: 'new' },
    outreachMessages: [{
      id:              String,
      channel:         { type: String, enum: ['email', 'linkedin', 'whatsapp'], default: 'email' },
      subject:         String,
      body:            String,
      aiGenerated:     { type: Boolean, default: true },
      edited:          { type: Boolean, default: false },
      status:          { type: String, enum: ['draft', 'approved', 'sent', 'opened', 'replied', 'bounced'], default: 'draft' },
      sentAt:          Date,
      openedAt:        Date,
      repliedAt:       Date,
      resendMessageId: String,
      sequenceNumber:  { type: Number, default: 1 },
      _id: false,
    }],
    agentNotes:       String,
    painPointMatched: String,
    uspAngle:         String,
    addedAt:          { type: Date, default: Date.now },
    lastContactedAt:  Date,
    nextFollowUpAt:   Date,
    estimatedDealValueAED: { type: Number, default: 0 },
    _id: false,
  }],

  // Soft delete
  isArchived: { type: Boolean, default: false },

  // ─── Trade License Application ────────────────────────────────────────────
  tradeLicenseApplication: {
    package:        { type: String, enum: ['starter', 'growth', 'premium'] },
    fullName:       String,
    email:          String,
    phone:          String,
    passportNumber: String,
    companyName:    String,
    visaEligible:   { type: Boolean, default: true },
    numberOfVisas:  { type: Number, default: 1 },
    officeType:     { type: String, enum: ['flexi_desk', 'dedicated', 'warehouse', 'virtual'], default: 'flexi_desk' },
    freeZone:       { type: String, default: 'RAKEZ' },
    notes:          String,
    submittedAt:    Date,
    status:         { type: String, enum: ['submitted', 'processing', 'approved', 'rejected'], default: 'submitted' },
  },

}, { timestamps: true });

// ─── Indexes ──────────────────────────────────────────────────────────────────
brandProjectSchema.index({ user: 1, createdAt: -1 });
brandProjectSchema.index({ user: 1, businessType: 1 });

// ─── Safety caps on embedded arrays (DEPRECATED — migrate to sibling collections) ─
//
// These arrays are being moved out of this schema to avoid hitting MongoDB's
// 16MB per-document limit. New writes should go to:
//   - leads          → BrandLead          (model/schema/brandLead.js)
//   - contentItems   → BrandContentItem   (model/schema/brandContentItem.js)
//   - contentCalendar→ BrandContentItem   (legacy field is kept readable)
//   - agentInsights  → BrandAgentInsight  (model/schema/brandAgentInsight.js)
//   - agentMemory    → BrandAgentMemory   (model/schema/brandAgentMemory.js)
//   - businessProfile.suppliers → BrandSupplier (model/schema/brandSupplier.js)
//   - tradeLicenseApplication   → BrandTradeLicense (model/schema/brandTradeLicense.js)
//
// Until controllers are migrated, the pre-save hook below caps embedded array
// growth and warns. This is a hard guardrail — it protects the production DB.
const ARRAY_CAPS = {
  leads: 200,
  contentItems: 100,
  contentCalendar: 60,
  agentInsights: 100,
  videoRequests: 50,
  scheduledPosts: 100,
  generatedAssets: 200,
  generatedImages: 200,
};

brandProjectSchema.pre('save', function (next) {
  for (const [field, cap] of Object.entries(ARRAY_CAPS)) {
    const arr = this.get(field);
    if (Array.isArray(arr) && arr.length > cap) {
      // Trim oldest, keep newest. Caller should be using the sibling collection.
      console.warn(`[BrandProject] '${field}' exceeded cap of ${cap} (was ${arr.length}). Trimming. Migrate to sibling collection.`);
      this.set(field, arr.slice(-cap));
    }
  }
  next();
});

// ─── Virtual: totalAssetsGenerated ───────────────────────────────────────────
brandProjectSchema.virtual('totalAssetsGenerated').get(function () {
  return (this.generatedAssets || []).filter(a => a.status === 'ready').length;
});

brandProjectSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('BrandProject', brandProjectSchema);
