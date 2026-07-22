const { getVideoStitchQueue } = require('./services/queues');
const q = getVideoStitchQueue();
async function run() {
  console.log('waiting :', await q.getWaitingCount());
  console.log('failed  :', await q.getFailedCount());
  const failed = await q.getFailed(0, 20);
  failed.forEach(j => console.log('FAILED', j.id, '| reason:', j.failedReason));
}

async function main() {
  await run();
}

main();