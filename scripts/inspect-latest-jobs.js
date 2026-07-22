#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const StudioJob   = require('../model/schema/studioJob');
const StudioAsset = require('../model/schema/studioAsset');

(async () => {
  await mongoose.connect(`${process.env.DB_URL || 'mongodb://127.0.0.1:27017'}/${process.env.DB || 'qumak'}`);
  const limit = Number(process.argv[2] || 5);
  const jobs = await StudioJob.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  for (const j of jobs) {
    const asset = await StudioAsset.findOne({ jobId: j._id }).lean();
    console.log('─'.repeat(72));
    console.log(`${j._id}  kind=${j.kind}  tier=${j.tier}  status=${j.status}  progress=${j.progress}  "${j.statusMessage}"`);
    console.log(`  created:    ${j.createdAt}`);
    console.log(`  startedAt:  ${j.startedAt || '(null)'}   completedAt: ${j.completedAt || '(null)'}`);
    console.log(`  falModel:   ${j.falModelId}`);
    console.log(`  falJobId:   ${j.falJobId || '(null)'}`);
    console.log(`  rawVideo:   ${j.output?.rawVideoUrl || '(null)'}`);
    console.log(`  storedVideo:${j.output?.storedVideoUrl || '(null)'}`);
    console.log(`  stored URL: ${j.output?.watermarkedUrl || j.output?.cleanUrl || '(null)'}`);
    console.log(`  thumbnail:  ${j.output?.thumbnailUrl || '(null)'}`);
    console.log(`  stages:     ${(j.stages || []).map(s => `${s.name}:${s.status}`).join(' → ') || '(none)'}`);
    console.log(`  error:      ${j.error?.message || '(none)'} [${j.error?.code || ''}]`);
    console.log(`  asset:      ${asset ? `${asset._id} status=${asset.status} url=${asset.url}` : '(none)'}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
