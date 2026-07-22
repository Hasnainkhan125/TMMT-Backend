const { Worker } = require('bullmq');
const { getRedis } = require('../queues/redis');
const { assembleVideoAd } = require('../services/assembleVideoAd');

new Worker(
  'video-stitch',
  async (job) => {
    const { scanId, adJobId } = job.data;
    return assembleVideoAd(scanId, adJobId);
  },
  {
    connection: getRedis(),
    concurrency: 2,
  },
);