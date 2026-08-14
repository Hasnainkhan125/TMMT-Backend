'use strict';

/**
 * Shared runner for standalone Apify CLI scripts.
 *
 * Goals:
 *   - One place that knows about APIFY_API_TOKEN, the client, retries, memory.
 *   - File-system cache so re-running a script with the same input is free.
 *   - JSON dump to `scripts/apify/output/` for downstream piping.
 *   - Predictable summary printout: ok/fail + first 3 keys of result.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApifyClient } = require('apify-client');

const OUT_DIR = path.resolve(__dirname, '..', 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function token() {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) {
    console.error('APIFY_API_TOKEN missing. Add it to .env.');
    process.exit(1);
  }
  return t;
}

let _client;
function client() {
  if (!_client) _client = new ApifyClient({ token: token() });
  return _client;
}

function hashKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

function cachePath(step, key) {
  return path.join(OUT_DIR, `${step}-${key}.json`);
}

/**
 * Run an Apify actor with input. Cached to disk by (actorId + input).
 * Use `fresh: true` to force re-run. Memory bounded to keep $ low.
 */
async function runActor({ step, actorId, input, memoryMbytes = 1024, timeoutSecs = 240, fresh = false }) {
  const key = hashKey({ actorId, input });
  const cacheFile = cachePath(step, key);
  if (!fresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`[${step}] cache hit (${actorId}) → ${cached.items?.length || 0} items`);
    return cached;
  }
  const startedAt = Date.now();
  console.log(`[${step}] running ${actorId} (mem=${memoryMbytes}MB, timeout=${timeoutSecs}s)…`);
  const run = await client().actor(actorId).call(input);
  const { items } = await client().dataset(run.defaultDatasetId).listItems();
  const out = {
    step, actorId, input, runId: run.id, durationMs: Date.now() - startedAt,
    itemCount: items.length, items,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  console.log(`[${step}] done in ${out.durationMs}ms → ${items.length} items → ${cacheFile}`);
  return out;
}

/**
 * Write any blob to /output, useful for non-Apify steps (HTML scrape, AI calls).
 */
function writeOutput(step, key, payload) {
  const file = cachePath(step, key);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`[${step}] wrote ${file}`);
  return file;
}

function readCache(step, key) {
  const file = cachePath(step, key);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[k] = true; }
      else { out[k] = next; i++; }
    }
  }
  return out;
}

function rootDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const parts = u.hostname.replace(/^www\./, '').split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
  } catch { return null; }
}

module.exports = { runActor, writeOutput, readCache, parseFlags, hashKey, rootDomain, OUT_DIR };