#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const StudioJob   = require('../model/schema/studioJob');
const StudioAsset = require('../model/schema/studioAsset');

(async () => {
  const url = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const db  = process.env.DB || 'qumak';
  await mongoose.connect(`${url}/${db}`);
  const jobId = process.argv[2];
  if (!jobId) { console.error('usage: inspect-job.js <jobId>'); process.exit(1); }
  const job = await StudioJob.findById(jobId).lean();
  if (!job) { console.log('job not found'); process.exit(1); }
  console.log(JSON.stringify({
    _id: job._id,
    status: job.status,
    progress: job.progress,
    statusMessage: job.statusMessage,
    modelId: job.modelId,
    falModelId: job.falModelId,
    falJobId: job.falJobId,
    kind: job.kind,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    output: job.output,
    stageCount: (job.stages || []).length,
    stagesSummary: (job.stages || []).map(s => `${s.name}:${s.status}`).join(' → '),
    assetId: job.assetId,
  }, null, 2));
  const asset = await StudioAsset.findOne({ jobId: job._id }).lean();
  console.log('\n-- ASSET --\n' + (asset ? JSON.stringify({
    _id: asset._id, type: asset.type, status: asset.status, url: asset.url,
  }, null, 2) : '(no asset)'));
  await mongoose.disconnect();
})();
