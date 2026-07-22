// services/resolver/utils/browserSemaphore.js
let active = 0;
const MAX = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '4', 10);
const waiters = [];

async function acquire() {
  if (active < MAX) {
    active++;
    return;
  }
  await new Promise(resolve => waiters.push(resolve));
  active++;
}

function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

function isAtCapacity() { return active >= MAX; }

module.exports = { acquire, release, isAtCapacity };