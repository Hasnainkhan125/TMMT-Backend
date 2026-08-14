const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProject', index: true },
  feature: {
    type: String,
    enum: [
      'brand_generation', 'image_generation', 'prompt_purification',
      'agent_research', 'content_generation', 'leads_generation',
      'cofounder_chat', 'analyze_url', 'pdf_generation',
    ],
    required: true,
  },
  model: { type: String, required: true },
  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  imageCostUSD: { type: Number, default: 0 },
  estimatedCostUSD: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true },
});

const TOKEN_COSTS = {
  'claude-sonnet-4-20250514': { in: 0.000003, out: 0.000015 },
  'claude-haiku-4-5-20251001': { in: 0.0000008, out: 0.000004 },
  'gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
  'gpt-image-1': { in: 0, out: 0 },
  'flux-pro': { in: 0, out: 0 },
};

usageSchema.pre('save', function () {
  const cost = TOKEN_COSTS[this.model] || { in: 0, out: 0 };
  this.estimatedCostUSD =
    this.tokensIn * cost.in + this.tokensOut * cost.out + (this.imageCostUSD || 0);
});

const Usage = mongoose.models.Usage || mongoose.model('Usage', usageSchema);

const PLAN_LIMITS = {
  trial: { tokensPerMonth: 50000, imagesPerMonth: 5, brandsTotal: 1, leadsPerMonth: 0, researchPerMonth: 3 },
  free: { tokensPerMonth: 30000, imagesPerMonth: 3, brandsTotal: 1, leadsPerMonth: 0, researchPerMonth: 2 },
  pro: { tokensPerMonth: 500000, imagesPerMonth: 50, brandsTotal: 5, leadsPerMonth: 100, researchPerMonth: 30 },
  growth: { tokensPerMonth: 2000000, imagesPerMonth: 200, brandsTotal: 999, leadsPerMonth: 999, researchPerMonth: 999 },
};

async function log({ userId, brandId, feature, model, tokensIn = 0, tokensOut = 0, imageCostUSD = 0 }) {
  try {
    const entry = new Usage({ userId, brandId, feature, model, tokensIn, tokensOut, imageCostUSD });
    await entry.save();
    return entry;
  } catch (err) {
    console.error('[tokenMeter] log error:', err.message);
    return null;
  }
}

async function getUserStats(userId, plan = 'trial') {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const pipeline = [
    { $match: { userId: new mongoose.Types.ObjectId(userId), createdAt: { $gte: startOfMonth } } },
    {
      $group: {
        _id: '$feature',
        tokensUsed: { $sum: { $add: ['$tokensIn', '$tokensOut'] } },
        imagesGenerated: { $sum: { $cond: [{ $eq: ['$feature', 'image_generation'] }, 1, 0] } },
        totalCostUSD: { $sum: '$estimatedCostUSD' },
      },
    },
  ];

  const results = await Usage.aggregate(pipeline);

  const totals = results.reduce(
    (acc, r) => ({
      tokensUsed: acc.tokensUsed + r.tokensUsed,
      imagesGenerated: acc.imagesGenerated + r.imagesGenerated,
      totalCostUSD: acc.totalCostUSD + r.totalCostUSD,
    }),
    { tokensUsed: 0, imagesGenerated: 0, totalCostUSD: 0 },
  );

  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;

  return {
    plan,
    tokensUsed: totals.tokensUsed,
    tokensLimit: limits.tokensPerMonth,
    tokensPercent: Math.min(100, Math.round((totals.tokensUsed / limits.tokensPerMonth) * 100)),
    tokensRemaining: Math.max(0, limits.tokensPerMonth - totals.tokensUsed),
    imagesUsed: totals.imagesGenerated,
    imagesLimit: limits.imagesPerMonth,
    imagesPercent: Math.min(100, Math.round((totals.imagesGenerated / limits.imagesPerMonth) * 100)),
    totalCostUSD: Math.round(totals.totalCostUSD * 100) / 100,
    resetDate: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    breakdown: results,
  };
}

async function checkCanGenerate(userId, plan, feature) {
  const stats = await getUserStats(userId, plan);
  if (feature === 'image_generation') {
    return { allowed: stats.imagesUsed < stats.imagesLimit, reason: 'image_limit_reached' };
  }
  if (stats.tokensPercent >= 100) {
    return { allowed: false, reason: 'token_limit_reached' };
  }
  return { allowed: true };
}

module.exports = { log, getUserStats, checkCanGenerate, PLAN_LIMITS };
