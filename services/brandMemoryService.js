/**
 * brandMemoryService.js — Brand Agent Memory (S3 + MongoDB)
 *
 * Every agent reads from Brand Memory before running.
 * Every agent writes back to Brand Memory after running.
 * The longer a brand exists on Qumak, the smarter all four agents become.
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const BrandProject = require('../model/schema/brandProject');

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'qumak-brands';
const REGION    = process.env.AWS_REGION || 'me-south-1';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// ─── 1. Initialize Brand Memory ──────────────────────────────────────────────
async function initializeBrandMemory(brandId) {
  const project = await BrandProject.findById(brandId);
  if (!project) throw new Error(`Brand ${brandId} not found`);

  const s3Root = `brands/${brandId}/`;
  const s3Paths = {
    root:     s3Root,
    research: `${s3Root}research/`,
    content:  `${s3Root}content/`,
    assets:   `${s3Root}assets/`,
    memory:   `${s3Root}memory/`,
  };

  if (!project.agentMemory?.s3Paths?.root) {
    if (!project.agentMemory) project.agentMemory = {};
    project.agentMemory.s3Paths = s3Paths;
    project.markModified('agentMemory');
    await project.save();
  }

  const brand  = project.config?.brand || {};
  const inputs = project.config?.inputs || {};

  const context = {
    brandId,
    brandName:       project.projectName || brand.brandName || 'Unnamed',
    category:        project.businessType || inputs.category || 'custom',
    businessType:    project.businessProfile?.businessType || project.businessType || 'default',
    tagline:         brand.tagline || '',
    brandStory:      brand.brandStory || '',
    colorPalette:    Array.isArray(brand.colorPalette) ? brand.colorPalette.map(c => c.hex || c) : [],
    targetPersona:   brand.targetAudience?.primary || (Array.isArray(brand.targetAudience) ? brand.targetAudience.join(', ') : brand.targetAudience) || '',
    pricePositioning: brand.pricePositioning || project.pricePoint || '',
    marketTarget:    project.targetMarket || 'UAE',
    competitors:     (project.agentMemory?.competitors || []).slice(0, 5),
    uspCurrent:      project.agentMemory?.usp?.current || '',
    growthStage:     project.agentMemory?.growthStage?.current || 'awareness',
    contentInsights: (project.agentMemory?.contentInsights || []).slice(-5),
    updatedAt:       new Date().toISOString(),
  };

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         `${s3Paths.memory}brand-context.json`,
      Body:        JSON.stringify(context, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error('[brandMemory] S3 write failed:', err.message);
  }

  return context;
}

// ─── 2. Read Brand Memory ────────────────────────────────────────────────────
async function readBrandMemory(brandId) {
  try {
    const data = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key:    `brands/${brandId}/memory/brand-context.json`,
    }));
    const bodyStr = await data.Body.transformToString('utf-8');
    return JSON.parse(bodyStr);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return initializeBrandMemory(brandId);
    }
    console.error('[brandMemory] S3 read failed:', err.message);
    return initializeBrandMemory(brandId);
  }
}

// ─── 3. Write Brand Memory ───────────────────────────────────────────────────
async function writeBrandMemory(brandId, updates) {
  const existing = await readBrandMemory(brandId);
  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         `brands/${brandId}/memory/brand-context.json`,
      Body:        JSON.stringify(merged, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error('[brandMemory] S3 write failed:', err.message);
  }

  // Sync key fields back to MongoDB
  const dbUpdates = {};
  if (updates.uspCurrent)   dbUpdates['agentMemory.usp.current'] = updates.uspCurrent;
  if (updates.growthStage)  dbUpdates['agentMemory.growthStage.current'] = updates.growthStage;
  if (updates.competitors)  dbUpdates['agentMemory.competitors'] = updates.competitors;

  if (Object.keys(dbUpdates).length > 0) {
    await BrandProject.findByIdAndUpdate(brandId, { $set: dbUpdates }).catch(() => {});
  }

  return merged;
}

// ─── 4. Save Research to S3 ──────────────────────────────────────────────────
async function saveResearchToS3(brandId, researchData) {
  const filename = `${Date.now()}-competitive-research.json`;
  const key = `brands/${brandId}/research/${filename}`;

  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        JSON.stringify(researchData, null, 2),
    ContentType: 'application/json',
  }));

  return `s3://${S3_BUCKET}/${key}`;
}

// ─── 5. Save Content Batch to S3 ─────────────────────────────────────────────
async function saveContentToS3(brandId, contentData) {
  const filename = `${Date.now()}-content-batch.json`;
  const key = `brands/${brandId}/content/${filename}`;

  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        JSON.stringify(contentData, null, 2),
    ContentType: 'application/json',
  }));

  return `s3://${S3_BUCKET}/${key}`;
}

// ─── 6. Save Image to S3 ─────────────────────────────────────────────────────
async function saveImageToS3(brandId, imageBuffer, filename) {
  const key = `brands/${brandId}/assets/images/${filename}`;

  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        imageBuffer,
    ContentType: 'image/png',
  }));

  return `https://${S3_BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

// ─── 7. Save Agent Insight to DB ─────────────────────────────────────────────
async function saveInsightToDB(brandId, insight) {
  if (!insight.id) insight.id = uuidv4();
  if (!insight.generatedAt) insight.generatedAt = new Date();

  await BrandProject.findByIdAndUpdate(brandId, {
    $push: { agentInsights: { $each: [insight], $slice: -50 } },
  });

  return insight;
}

// ─── 8. Save Content Items to DB ─────────────────────────────────────────────
async function saveContentItemsToDB(brandId, items) {
  const enriched = items.map(item => ({
    ...item,
    id: item.id || uuidv4(),
    agentGenerated: true,
    status: item.status || 'draft',
    generatedAt: new Date(),
  }));

  await BrandProject.findByIdAndUpdate(brandId, {
    $push: { contentItems: { $each: enriched } },
  });

  // Also save to S3
  try {
    await saveContentToS3(brandId, enriched);
  } catch (err) {
    console.error('[brandMemory] S3 content save failed:', err.message);
  }

  return enriched;
}

module.exports = {
  initializeBrandMemory,
  readBrandMemory,
  writeBrandMemory,
  saveResearchToS3,
  saveContentToS3,
  saveImageToS3,
  saveInsightToDB,
  saveContentItemsToDB,
};
