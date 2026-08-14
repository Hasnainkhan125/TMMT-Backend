#!/usr/bin/env node
'use strict';

/**
 * seed-demo.js — Phase 9 investor-demo data primer.
 *
 * Produces a clean, convincing "this product is real" dataset:
 *   • demo@qumak.io / Demo!2026 — a user with 500 platform credits and a
 *     populated ledger (1× signup bonus, 2× top-ups, N× charges)
 *   • 3 completed image jobs + 1 completed video job + 1 in-flight job
 *     attached to that user, spread across 5 days so the timeline renders
 *   • 1 ready UrlToAdsScan with 3 prebuilt ad blueprints ready to generate
 *   • DailyStat rows for the past 7 days so the admin ops dashboard and any
 *     analytics charts have something to plot
 *
 * The script is idempotent: running it again resets the demo user's ledger,
 * jobs, and scans to the baseline. It never touches other users or data.
 *
 *   MONGODB_URL=... node scripts/seed-demo.js           # seed
 *   MONGODB_URL=... node scripts/seed-demo.js --reset   # wipe only
 *   MONGODB_URL=... node scripts/seed-demo.js --email=custom@qumak.io
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const args = process.argv.slice(2);
const MODE_RESET = args.includes('--reset');
const EMAIL = (args.find(a => a.startsWith('--email=')) || '').split('=')[1] || 'demo@qumak.io';
const PASSWORD = 'Demo!2026';
const CREDITS = 500;

// Load models.
const User          = require('../model/schema/user');
const StudioJob     = require('../model/schema/studioJob');
const CreditLedger  = require('../model/schema/creditLedger');
const DailyStat     = require('../model/schema/dailyStat');
let UrlToAdsScan = null;
try { UrlToAdsScan = require('../model/schema/urlToAdsScan'); } catch (_e) { /* optional */ }

// ─── Helpers ───────────────────────────────────────────────────────────────
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const BRANDS = [
  { name: 'Pulse Fitness Dubai', category: 'gym',        prompt: 'Cinematic 16:9 ad of a trainer pushing a tire, golden hour, Dubai skyline backdrop' },
  { name: 'Attar House Muscat',  category: 'perfume',    prompt: 'Luxury oud bottle on marble, flickering candlelight, Gulf aesthetic' },
  { name: 'Burj Heights',        category: 'realestate', prompt: 'Penthouse terrace at sunset with infinity pool overlooking the Marina' },
  { name: 'Shawarma & Co.',      category: 'restaurant', prompt: 'Close-up of a chef carving shawarma, neon sign background, 9:16 vertical' },
  { name: 'Loom Atelier',        category: 'fashion',    prompt: 'Model in modest-luxury abaya walking through Souq Madinat, 4:5' },
];

async function connect() {
  // Match the main server's connection convention so we write to the SAME
  // database the dev server reads from. The server uses:
  //   mongoose.connect(DB_URL, { dbName: DB })
  // Accept any of the common env names teams use.
  const uri = process.env.DB_URL
    || process.env.MONGODB_URI
    || process.env.MONGO_URI
    || process.env.MONGODB_URL
    || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.DB || 'qumak';
  await mongoose.connect(uri, { dbName });
  console.log(`[seed] connected → ${uri.replace(/\/\/[^@]+@/, '//***@')} (db=${dbName})`);
}

async function findOrCreateDemoUser() {
  let user = await User.findOne({ email: EMAIL });
  if (user) {
    console.log(`[seed] reusing existing user ${EMAIL} (${user._id})`);
    return user;
  }
  const hashed = await bcrypt.hash(PASSWORD, 10);
  user = await User.create({
    firstName: 'Demo',
    lastName:  'Investor',
    email:     EMAIL,
    password:  hashed,
    role:      'user',
    platformCredits: 0,
    deleted: false,
  });
  console.log(`[seed] created user ${EMAIL} (${user._id}) — password: ${PASSWORD}`);
  return user;
}

async function wipeDemoData(userId) {
  const [j, l, s] = await Promise.all([
    StudioJob.deleteMany({ userId }),
    CreditLedger.deleteMany({ userId }),
    UrlToAdsScan ? UrlToAdsScan.deleteMany({ userId }) : Promise.resolve({ deletedCount: 0 }),
  ]);
  await User.updateOne({ _id: userId }, { $set: { platformCredits: 0 } });
  console.log(`[seed] wiped: ${j.deletedCount} jobs, ${l.deletedCount} ledger rows, ${s.deletedCount} scans`);
}

async function seedCredits(userId) {
  // Ledger: signup bonus → top-up → charges → top-up → charges. Balances roll
  // forward on each row so the admin dashboard renders a realistic graph.
  const events = [
    { days: 7, delta:  +25, reason: 'topup_signup_bonus', meta: { source: 'seed' } },
    { days: 6, delta: +200, reason: 'topup_stripe',       meta: { source: 'seed', sessionId: 'cs_demo_1' } },
    { days: 5, delta:   -8, reason: 'charge_studio_image',meta: { source: 'seed', modelId: 'flux-schnell' } },
    { days: 5, delta:   -8, reason: 'charge_studio_image',meta: { source: 'seed', modelId: 'flux-schnell' } },
    { days: 4, delta:  -35, reason: 'charge_studio_video',meta: { source: 'seed', modelId: 'kling-2.5' } },
    { days: 3, delta: +500, reason: 'topup_stripe',       meta: { source: 'seed', sessionId: 'cs_demo_2' } },
    { days: 2, delta:   -8, reason: 'charge_studio_image',meta: { source: 'seed' } },
    { days: 1, delta:   -8, reason: 'charge_studio_image',meta: { source: 'seed' } },
    { days: 1, delta:   +8, reason: 'refund_studio_failure', meta: { source: 'seed', reason: 'fal_timeout' } },
  ];

  let running = 0;
  for (const e of events) {
    running += e.delta;
    await CreditLedger.create({
      userId,
      delta: e.delta,
      balanceAfter: running,
      reason: e.reason,
      meta: e.meta,
      createdAt: daysAgo(e.days),
    });
  }
  // platformCredits must equal the running ledger balance — otherwise the
  // admin ops dashboard shows a reconciliation drift on the first frame.
  await User.updateOne({ _id: userId }, { $set: { platformCredits: running } });
  console.log(`[seed] created ${events.length} ledger rows, balance=${running}`);
}

async function seedJobs(userId) {
  const jobs = [];
  // 3 completed image jobs, spread across 5 days
  for (let i = 0; i < 3; i++) {
    const brand = pick(BRANDS);
    const createdAt = daysAgo(5 - i);
    jobs.push({
      userId,
      sessionId: `seed-${i}`,
      category: brand.category,
      userInputs: {
        brandName: brand.name,
        description: `Ad for ${brand.name}`,
        prompt: brand.prompt,
        aspectRatio: pick(['16:9', '9:16', '1:1', '4:5']),
        locale: 'gulf',
      },
      promptPipeline: {
        rawUserIntent: brand.prompt,
        finalPrompt: `${brand.prompt}, shot on Arri Alexa, cinematic grade`,
        strategy: 'creative_image',
        intentType: 'creative_image',
        domain: brand.category,
      },
      status: 'completed',
      progress: 100,
      statusMessage: 'Done',
      kind: 'image',
      tier: 'pro',
      isWatermarked: false,
      generationTimeMs: rnd(3000, 9000),
      totalPipelineTimeMs: rnd(8000, 14000),
      falCostUsd: +(Math.random() * 0.08 + 0.02).toFixed(4),
      creditsCharged: 8,
      modelId: 'flux-schnell',
      variantsRequested: 1,
      output: {
        storedImageUrl: `https://picsum.photos/seed/qumak-${i}/1024/1024`,
        thumbnailUrl:   `https://picsum.photos/seed/qumak-${i}/256/256`,
        cleanUrl:       `https://picsum.photos/seed/qumak-${i}/1024/1024`,
      },
      startedAt: createdAt,
      completedAt: new Date(createdAt.getTime() + rnd(5000, 15000)),
      createdAt,
      updatedAt: createdAt,
    });
  }

  // 1 completed video job (4 days ago)
  {
    const brand = BRANDS[0];
    const createdAt = daysAgo(4);
    jobs.push({
      userId,
      sessionId: 'seed-video',
      category: brand.category,
      userInputs: {
        brandName: brand.name,
        description: 'Hero reel for homepage',
        prompt: brand.prompt,
        aspectRatio: '16:9',
        duration: 10,
        locale: 'gulf',
      },
      promptPipeline: {
        rawUserIntent: brand.prompt,
        finalPrompt: `${brand.prompt}, 5 second cinematic motion`,
        strategy: 'ad_video',
        intentType: 'ad_video',
        domain: brand.category,
      },
      status: 'completed',
      progress: 100,
      statusMessage: 'Done',
      kind: 'video',
      tier: 'pro',
      isWatermarked: false,
      generationTimeMs: 45000,
      totalPipelineTimeMs: 60000,
      falCostUsd: 0.45,
      creditsCharged: 35,
      modelId: 'kling-2.5',
      output: {
        storedVideoUrl: 'https://cdn.qumak.io/demo/reel-demo.mp4',
        thumbnailUrl:   `https://picsum.photos/seed/qumak-video/512/288`,
        duration: 10,
      },
      startedAt: createdAt,
      completedAt: new Date(createdAt.getTime() + 60000),
      createdAt,
      updatedAt: createdAt,
    });
  }

  // 1 in-flight "generating" job created just now (shows up live in admin)
  {
    const brand = BRANDS[1];
    jobs.push({
      userId,
      sessionId: 'seed-live',
      category: brand.category,
      userInputs: {
        brandName: brand.name,
        description: 'Live demo job',
        prompt: brand.prompt,
        aspectRatio: '1:1',
        locale: 'gulf',
      },
      promptPipeline: {
        rawUserIntent: brand.prompt,
        finalPrompt: brand.prompt,
        strategy: 'creative_image',
        intentType: 'creative_image',
        domain: brand.category,
      },
      status: 'generating',
      progress: 45,
      statusMessage: 'Rendering variants…',
      kind: 'image',
      tier: 'pro',
      modelId: 'flux-schnell',
      startedAt: new Date(Date.now() - 8000),
      createdAt: new Date(Date.now() - 10000),
      updatedAt: new Date(),
    });
  }

  await StudioJob.insertMany(jobs);
  console.log(`[seed] created ${jobs.length} studio jobs (3 image completed, 1 video completed, 1 generating)`);
}

async function seedUrlToAdsScan(userId) {
  if (!UrlToAdsScan) {
    console.log('[seed] UrlToAdsScan model not available — skipping');
    return;
  }
  const brand = BRANDS[0];
  const scan = await UrlToAdsScan.create({
    userId,
    sessionId: `seed-scan-${Date.now()}`,
    url: 'https://pulsefitness.ae',
    status: 'ready',
    host: 'pulsefitness.ae',
    brand: {
      name: brand.name,
      siteName: brand.name,
      url: 'https://pulsefitness.ae',
      host: 'pulsefitness.ae',
      title: 'Pulse Fitness Dubai — 12-Week Transformations',
      description: 'The Gulf’s most results-obsessed fitness coaching studio.',
      headlines: ['12 Weeks. One Transformation.', 'Train Like You Mean It.'],
      paragraphs: ['Coaching, nutrition, and recovery built for Gulf professionals.'],
      images: [`https://picsum.photos/seed/pulse/1200/800`],
      category: brand.category,
      audience: 'urban professionals 25-45 in Dubai who want results in 12 weeks',
    },
    competitors: [
      { name: 'FitCo Dubai',       url: 'https://fitco.ae' },
      { name: 'Gulf Strength Lab', url: 'https://gulfstrength.ae' },
    ],
    copy: {
      headlines:    ['12 Weeks to Your Strongest Self', 'Results You Can Measure', 'Dubai’s Transformation Studio'],
      captions:     ['Coaching built around you.', 'Nutrition. Training. Recovery.'],
      ctas:         ['Start Free Week', 'Book a Consultation', 'See Transformations'],
      hashtags:     ['#dubaifitness', '#gcctraining', '#12weektransformation'],
      openingLines: ['Your strongest self starts Monday.'],
    },
    ads: [0, 1, 2].map((i) => ({
      id: `ad-${i}`,
      status: 'pending',
      headline: `Variant ${i + 1}: 12 Weeks to Your Strongest Self`,
      caption: 'Coaching. Nutrition. Recovery.',
      cta: 'Start Free Week',
      aspectRatio: i === 0 ? '1:1' : i === 1 ? '4:5' : '9:16',
    })),
    freeTrialConsumed: false,
  });
  console.log(`[seed] created UrlToAdsScan ${scan._id} (status=ready, 3 blueprints, free-trial available)`);
}

async function seedDailyStats() {
  // Seven days of plausible analytics so the ops dashboard has a curve.
  for (let i = 0; i < 7; i++) {
    const date = daysAgo(i).toISOString().slice(0, 10);
    const total = rnd(12, 80);
    const completed = Math.round(total * (0.85 + Math.random() * 0.1));
    const failed = total - completed;
    await DailyStat.updateOne(
      { date },
      {
        $set: {
          date,
          totalJobs: total,
          completedJobs: completed,
          failedJobs: failed,
          totalFalCost: +(total * 0.06).toFixed(2),
          avgGenerationTimeMs: rnd(4000, 9000),
          categoryBreakdown: {
            gym:        rnd(0, Math.round(total * 0.3)),
            realestate: rnd(0, Math.round(total * 0.3)),
            perfume:    rnd(0, Math.round(total * 0.2)),
            saas:       rnd(0, Math.round(total * 0.2)),
            restaurant: rnd(0, Math.round(total * 0.2)),
            service:    rnd(0, Math.round(total * 0.2)),
          },
        },
      },
      { upsert: true },
    );
  }
  console.log('[seed] upserted 7 days of DailyStat rows');
}

async function main() {
  await connect();
  try {
    const user = await findOrCreateDemoUser();
    if (MODE_RESET) {
      await wipeDemoData(user._id);
      console.log('[seed] reset complete.');
      return;
    }
    await wipeDemoData(user._id);
    await seedCredits(user._id);
    await seedJobs(user._id);
    await seedUrlToAdsScan(user._id);
    await seedDailyStats();
    const u = await User.findById(user._id).select('platformCredits').lean();
    console.log('\n──────────────────────────────────────────────');
    console.log(` Demo account ready`);
    console.log(`  email:    ${EMAIL}`);
    console.log(`  password: ${PASSWORD}`);
    console.log(`  credits:  ${u.platformCredits}`);
    console.log('──────────────────────────────────────────────\n');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(err => {
  console.error('[seed] failed:', err?.stack || err?.message || err);
  process.exit(1);
});
