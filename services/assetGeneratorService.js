'use strict';

const ContentBrief          = require('../model/schema/contentBrief');
const { enqueueGeneration } = require('../controllers/studio/studioController_enqueue');


const AUTONOMOUS_PRIORITY = 8;

async function generateForBrief(brand, brief) {
  const sessionContext = {
    sessionId: `auto_${brand._id}_${Date.now()}`,
    userId:    brand.userId || null,
    tier:      brand.tier || 'growth',
    priority:  AUTONOMOUS_PRIORITY,
  };

  const productDesc = brief.product?.name
    ? `${brief.product.name}${brief.product.price ? ` — ${brief.product.price} ${brief.product.currency}` : ''}`
    : '';

  const prompt = [
    `${brand.persona.name} — ${brief.angle}`,
    productDesc,
    brand.description,
  ].filter(Boolean).join('. ');

  const jobSpec = {
    kind:              brief.outputKind,
    prompt,
    brandName:         brand.brandName,
    description:       brand.description,
    targetAudience:    '',
    vibe:              brief.angle,
    locale:            brand.locale,
    aspectRatio:       brief.aspectRatio,
    category:          brand.category,
    referenceImageUrl: brand.persona.referenceImageUrl,
    duration:          brief.outputKind === 'video' ? 5 : undefined,
    genMode:           'business',
    extras: {
      autonomousBrandId: brand._id.toString(),
      briefId:           brief._id.toString(),
      platform:          brief.platform,
      angle:             brief.angle,
      productName:       brief.product?.name || null,
    },
  };

  let result;
  try {
    result = await enqueueGeneration(jobSpec, sessionContext);
  } catch (err) {
    brief.status = 'failed';
    brief.error  = err.message;
    await brief.save().catch(() => {});
    throw err;
  }

  brief.studioJobId = result.jobId;
  brief.status      = 'generating';
  await brief.save().catch(() => {});

  return result;
}

/**
 * generatePendingBriefs — picks up all ContentBriefs whose scheduledFor
 * is due and fires them. Called by brandPlannerWorker after planDay.
 */
async function generatePendingBriefs() {
  const AutonomousBrand = require('../model/schema/autonomousBrand');
  const now = new Date();

  const dueBriefs = await ContentBrief.find({
    status:       'pending',
    scheduledFor: { $lte: now },
  }).populate({ path: 'brandId', model: AutonomousBrand }).limit(100);

  let generated = 0;
  for (const brief of dueBriefs) {
    const brand = brief.brandId;
    if (!brand || brand.status !== 'active') continue;

    if (brand.postsUsedThisMonth >= brand.postsQuotaPerMonth) {
      brief.status = 'skipped';
      brief.error  = 'monthly_quota_exceeded';
      await brief.save().catch(() => {});
      continue;
    }

    try {
      await generateForBrief(brand, brief);
      generated++;
    } catch (err) {
      console.error(`[assetGenerator] Brief ${brief._id} failed:`, err.message);
    }
  }

  return generated;
}

module.exports = { generateForBrief, generatePendingBriefs };
