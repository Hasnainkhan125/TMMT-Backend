#!/usr/bin/env node
'use strict';

/**
 * load-test.js — Phase 9 lightweight load test for the investor demo.
 *
 * Why this exists: during the demo we'll likely have multiple browsers open
 * (the presenter, the investor mirroring on their laptop, the admin ops page
 * refreshing). This script proves the read-heavy paths hold up under
 * concurrent load BEFORE we find out on stage.
 *
 * Targets (configurable):
 *   - GET /health                    — liveness, should be ~sub-ms
 *   - GET /metrics                   — Prometheus scrape; medium cost
 *   - GET /api/v1/me/credits         — hot path, polled by studio sidebar
 *   - GET /api/v1/admin/ops/overview — hero dashboard, heavy aggregations
 *     (requires ADMIN_TOKEN)
 *
 * Usage:
 *   BASE_URL=http://localhost:5001 node scripts/load-test.js
 *   BASE_URL=... DURATION_SEC=20 CONCURRENCY=40 \
 *     SMOKE_TOKEN=$(...) ADMIN_TOKEN=$(...) node scripts/load-test.js
 *
 * Output: JSON summary per target with p50/p95/p99/max/err-rate/RPS.
 * Exit 1 if error-rate > 2% on any target (tweakable via ERR_BUDGET_PCT).
 *
 * Zero dependencies — uses built-in fetch + performance.now().
 */

const { performance } = require('node:perf_hooks');

const BASE_URL    = (process.env.BASE_URL || 'http://localhost:5001').replace(/\/+$/, '');
const DURATION_MS = Number(process.env.DURATION_SEC || 10) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const ERR_BUDGET  = Number(process.env.ERR_BUDGET_PCT || 2);
const SMOKE_TOKEN = process.env.SMOKE_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const targets = [
  { name: '/health',                     path: '/health',                                 weight: 1 },
  { name: '/metrics',                    path: '/metrics',                                weight: 1 },
  { name: '/me/credits (auth)',          path: '/api/v1/me/credits',                     weight: 2, token: SMOKE_TOKEN,
    skipIfNoToken: true },
  { name: '/admin/ops/overview (admin)', path: '/api/v1/admin/ops/overview?windowDays=7', weight: 1, token: ADMIN_TOKEN,
    skipIfNoToken: true },
].filter(t => !(t.skipIfNoToken && !t.token));

// Weighted round-robin picker so heavier targets hit proportionally.
const pool = [];
for (const t of targets) for (let i = 0; i < t.weight; i++) pool.push(t);
const pickTarget = () => pool[Math.floor(Math.random() * pool.length)];

// Per-target stats.
const stats = Object.fromEntries(targets.map(t => [t.name, {
  samples: [],           // ms
  ok: 0,
  err: 0,
  status: {},            // status code → count
}]));

async function hit(target) {
  const start = performance.now();
  try {
    const headers = { accept: 'application/json' };
    if (target.token) headers.authorization = `Bearer ${target.token}`;
    const res = await fetch(`${BASE_URL}${target.path}`, { headers });
    // Drain body so TCP connection can reuse / timing is fair.
    await res.text();
    const ms = performance.now() - start;
    const s = stats[target.name];
    s.samples.push(ms);
    s.status[res.status] = (s.status[res.status] || 0) + 1;
    if (res.ok || res.status === 304) s.ok++;
    else                              s.err++;
  } catch (_err) {
    const ms = performance.now() - start;
    const s = stats[target.name];
    s.samples.push(ms);
    s.err++;
    s.status['network_error'] = (s.status['network_error'] || 0) + 1;
  }
}

async function worker(endAt) {
  while (performance.now() < endAt) {
    await hit(pickTarget());
  }
}

function pct(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function fmt(ms) { return ms >= 10 ? ms.toFixed(0) : ms.toFixed(1); }

async function main() {
  console.log(`\n── Qumak load test ─ ${BASE_URL} ─ concurrency=${CONCURRENCY} duration=${DURATION_MS / 1000}s ──`);
  console.log(`targets: ${targets.map(t => t.name).join(', ') || '(none)'}`);
  if (targets.length === 0) {
    console.log('\n(no targets configured — pass SMOKE_TOKEN and/or ADMIN_TOKEN)\n');
    return;
  }

  const endAt = performance.now() + DURATION_MS;
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(endAt)));
  const elapsedSec = (performance.now() - started) / 1000;

  let budgetBreached = false;
  const rows = [];
  let totalReqs = 0;
  for (const [name, s] of Object.entries(stats)) {
    const n = s.samples.length;
    totalReqs += n;
    const errPct = n === 0 ? 0 : (s.err / n) * 100;
    const row = {
      target: name,
      reqs: n,
      rps: n === 0 ? 0 : n / elapsedSec,
      p50: pct(s.samples, 50),
      p95: pct(s.samples, 95),
      p99: pct(s.samples, 99),
      max: s.samples.length ? Math.max(...s.samples) : 0,
      err_pct: errPct,
      status: s.status,
    };
    rows.push(row);
    if (errPct > ERR_BUDGET) budgetBreached = true;
  }

  // Table output.
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\n${pad('target', 32)}${pad('reqs', 8)}${pad('rps', 10)}${pad('p50', 10)}${pad('p95', 10)}${pad('p99', 10)}${pad('max', 10)}${pad('err%', 8)}status`,
  );
  console.log('─'.repeat(110));
  for (const r of rows) {
    console.log(
      pad(r.target, 32) +
      pad(r.reqs, 8) +
      pad(r.rps.toFixed(1), 10) +
      pad(fmt(r.p50), 10) +
      pad(fmt(r.p95), 10) +
      pad(fmt(r.p99), 10) +
      pad(fmt(r.max), 10) +
      pad(r.err_pct.toFixed(2), 8) +
      JSON.stringify(r.status),
    );
  }
  console.log('─'.repeat(110));
  console.log(
    `total: ${totalReqs} reqs in ${elapsedSec.toFixed(1)}s → ${(totalReqs / elapsedSec).toFixed(1)} rps aggregate\n`,
  );

  // Machine-readable JSON on stderr for CI pipelines that want it.
  if (process.env.EMIT_JSON) {
    process.stderr.write(JSON.stringify({ baseUrl: BASE_URL, durationSec: elapsedSec, concurrency: CONCURRENCY, rows }, null, 2));
    process.stderr.write('\n');
  }

  if (budgetBreached) {
    console.log(`❌ error budget (${ERR_BUDGET}%) breached on at least one target`);
    process.exit(1);
  }
  console.log(`✅ all targets under the ${ERR_BUDGET}% error budget`);
}

main().catch(err => { console.error('load-test crashed:', err); process.exit(1); });
