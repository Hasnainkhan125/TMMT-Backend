'use strict';

/**
 * brandPlannerWorker.js
 *
 * Standalone process — separate from the studio worker.
 * Cron fires at 06:00 UTC daily (Gulf morning window).
 * Set PLANNER_RUN_NOW=true to fire immediately on startup (useful for testing).
 */

require('dotenv').config();

const cron     = require('node-cron');
const mongoose = require('mongoose');

const brandRegistryService = require('../services/brandRegistryService');
const { planDay }          = require('../services/contentPlannerService');

const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
const DATABASE     = process.env.DB || 'qumak';

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(`${DATABASE_URL}/${DATABASE}`);
  console.log('[brandPlannerWorker] MongoDB connected');
}

async function runPlanner() {
  console.log('[brandPlannerWorker] Running daily planner at', new Date().toISOString());
  const brands = await brandRegistryService.getActiveBrandsForPlanning();
  console.log(`[brandPlannerWorker] Found ${brands.length} active brands`);

  for (const brand of brands) {
    try {
      const briefs = await planDay(brand, new Date());
      console.log(`[brandPlannerWorker] Planned ${briefs.length} posts for brand "${brand.brandName}"`);
    } catch (err) {
      console.error(`[brandPlannerWorker] Failed to plan brand "${brand.brandName}":`, err.message);
    }
  }
}

async function start() {
  await connectDB();

  if (process.env.PLANNER_RUN_NOW === 'true') {
    await runPlanner();
  }

  cron.schedule('0 6 * * *', async () => {
    await runPlanner().catch(err => {
      console.error('[brandPlannerWorker] Planner run failed:', err.message);
    });
  });

  console.log('[brandPlannerWorker] Scheduled daily at 06:00 UTC');
}

start().catch(err => {
  console.error('[brandPlannerWorker] Failed to start:', err.message);
  process.exit(1);
});
