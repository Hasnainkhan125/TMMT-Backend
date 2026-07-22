#!/usr/bin/env node
'use strict';

/**
 * scanQuality.js — 30-URL eval harness for the URL→Ads scanner.
 *
 * Why this exists:
 *   Every scan we shipped in the last week had a different bug — Hot Shay
 *   surfaced its own outlets as competitors, Zigwheels labelled itself as
 *   Tesla, Afghan Palace returned null for handles that lived in plain
 *   anchor tags. None of those bugs would have shipped if a single
 *   regression suite had run before push. This is that suite.
 *
 *   Run it before every push. If pass-rate drops below threshold, the
 *   script exits non-zero so a CI hook (or a human) can block the push.
 *
 * Usage:
 *   node scripts/scanQuality.js                  # full 30-URL run
 *   node scripts/scanQuality.js --limit 5        # smoke 5 URLs
 *   node scripts/scanQuality.js --only hotshay   # filter by host substring
 *   node scripts/scanQuality.js --concurrency 2  # cap parallel scans
 *   node scripts/scanQuality.js --threshold 0.6  # min pass-rate (default 0.7)
 *   node scripts/scanQuality.js --timeout 180000 # ms per scan, default 120000
 *   node scripts/scanQuality.js --json out.json  # also write a JSON report
 *
 * Environment:
 *   DB_URL, DB                  Mongo connection (defaults match the app)
 *   ANTHROPIC_API_KEY           Optional. Without it, Money Math + Roast
 *                               run on the deterministic fallback path.
 *                               The harness still validates that fallback.
 *   APIFY_API_TOKEN             Optional. Without it, competitor ads always
 *                               return empty — the "competitors" criterion
 *                               will be marked SKIP, not FAIL.
 *
 * Pass criteria (per scan):
 *   handles            — at least 1 of {facebook,instagram,tiktok,youtube} resolved
 *   businessProfile    — type set, not 'default', confidence >= 0.5
 *   moneyMath          — benchmarks.avgCPL > 0 AND expectedROAS.high in [0.5, 30]
 *   competitors        — apifyData.competitorAds non-empty AND >= 1 ad has a video/image
 *                        (skipped when APIFY_API_TOKEN is missing)
 *
 * The script exits with code 1 when overall pass-rate < --threshold.
 */

require('dotenv').config();

const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');

// ── Catalog: 30 known UAE / Saudi brands across categories ─────────────────
//
// Mix is intentional:
//   - QSR / restaurant / cafe (where Hot Shay style bugs hide)
//   - E-commerce (Shopify + custom carts)
//   - B2C services (clinics, gyms, salons)
//   - B2B (agencies, SaaS)
//   - Marketplaces / property
//   - One deliberately deep-link URL to test the homepage-fallback path
//
const CATALOG = [
  // QSR / restaurant
  { url: 'https://hotshay.ae',                      category: 'qsr_karak',          country: 'AE' },
  { url: 'https://www.afghanpalace.ae',             category: 'restaurant',         country: 'AE' },
  { url: 'https://www.albaik.com',                  category: 'qsr',                country: 'SA' },
  { url: 'https://www.shawarmer.com',               category: 'qsr',                country: 'SA' },
  // E-commerce
  { url: 'https://www.ecityuae.ae',                 category: 'ecommerce_electronics', country: 'AE' },
  { url: 'https://www.sharafdg.com',                category: 'ecommerce_electronics', country: 'AE' },
  { url: 'https://www.namshi.com',                  category: 'ecommerce_fashion',  country: 'AE' },
  { url: 'https://www.ounass.ae',                   category: 'ecommerce_fashion',  country: 'AE' },
  { url: 'https://www.sivvi.com',                   category: 'ecommerce_fashion',  country: 'AE' },
  { url: 'https://www.6thstreet.com',               category: 'ecommerce_fashion',  country: 'AE' },
  // Beauty
  { url: 'https://www.boutiqaat.com',               category: 'ecommerce_beauty',   country: 'KW' },
  { url: 'https://www.faces.com/ae-en/',            category: 'ecommerce_beauty',   country: 'AE' },
  // Grocery
  { url: 'https://www.kibsons.com',                 category: 'ecommerce_grocery',  country: 'AE' },
  { url: 'https://www.organicfoodsandcafe.com',     category: 'ecommerce_grocery',  country: 'AE' },
  // Clinics / health
  { url: 'https://www.medcare.ae',                  category: 'healthcare',         country: 'AE' },
  { url: 'https://www.aster.ae',                    category: 'healthcare',         country: 'AE' },
  { url: 'https://www.americanhospital.com',        category: 'healthcare',         country: 'AE' },
  // Fitness
  { url: 'https://www.fitnessfirstme.com',          category: 'fitness',            country: 'AE' },
  { url: 'https://www.gymnation.com',               category: 'fitness',            country: 'AE' },
  // Real estate
  { url: 'https://www.bayut.com',                   category: 'real_estate',        country: 'AE' },
  { url: 'https://www.propertyfinder.ae',           category: 'real_estate',        country: 'AE' },
  // Automotive
  { url: 'https://www.dubicars.com',                category: 'automotive',         country: 'AE' },
  // Travel / hospitality
  { url: 'https://www.almosafer.com',               category: 'travel',             country: 'SA' },
  { url: 'https://www.wego.com',                    category: 'travel',             country: 'AE' },
  // SaaS / B2B / agency
  { url: 'https://www.zoho.com/sa-en/',             category: 'saas_b2b',           country: 'SA' },
  { url: 'https://www.tabby.ai',                    category: 'fintech',            country: 'AE' },
  { url: 'https://tamara.co',                       category: 'fintech',            country: 'SA' },
  { url: 'https://www.careem.com',                  category: 'mobility',           country: 'AE' },
  { url: 'https://www.talabat.com',                 category: 'food_delivery',      country: 'AE' },
  // Deep-link case (homepage fallback gate)
  { url: 'https://www.sharafdg.com/category/mobile/smartphones/', category: 'ecommerce_electronics', country: 'AE', tag: 'deep_link' },
];

// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { limit: null, only: null, concurrency: 3, threshold: 0.7, timeout: 120_000, json: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--limit':       args.limit       = parseInt(next, 10); i++; break;
      case '--only':        args.only        = String(next || '').toLowerCase(); i++; break;
      case '--concurrency': args.concurrency = Math.max(1, parseInt(next, 10)); i++; break;
      case '--threshold':   args.threshold   = Math.max(0, Math.min(1, parseFloat(next))); i++; break;
      case '--timeout':     args.timeout     = Math.max(10_000, parseInt(next, 10)); i++; break;
      case '--json':        args.json        = String(next); i++; break;
      case '--dry-run':     args.dryRun      = true; break;
      case '-h':
      case '--help':        printHelpAndExit();
      default: break;
    }
  }
  return args;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/scanQuality.js [options]

  --limit N            Run only the first N catalog entries
  --only SUBSTR        Filter to entries whose URL contains SUBSTR (case-insensitive)
  --concurrency N      Parallel scans (default 3)
  --threshold P        Pass-rate floor in [0,1] (default 0.7)
  --timeout MS         Per-scan timeout in ms (default 120000)
  --json PATH          Also write the full report as JSON to PATH
  --dry-run            Print the catalog and exit (no scans, no Mongo)
`);
  process.exit(0);
}

// ── Pass / fail criteria ────────────────────────────────────────────────────

/** Non-empty string or rich { handles: string[] } from older extractors. */
function handleValuePresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'object' && Array.isArray(v.handles)) return v.handles.length > 0;
  return false;
}

/**
 * Layer-1 `brandIdentity.handles` uses facebookHandle / facebookPageUrl /
 * instagramHandle / youtubeChannel. Initial scan + scraper `extractSocialHandles`
 * use the same names. The harness used to look for `facebook` / `instagram`
 * keys (wrong) and always reported FAIL even when handles resolved.
 */
function evaluateScan(scan, hasApifyToken) {
  const checks = {};

  // — handles —
  const handles = scan?.intelligence?.brandIdentity?.handles
              || scan?.brand?.socialHandles
              || scan?.brand?.handles
              || {};
  const handlePresent = [
    ['facebook', () => handleValuePresent(handles.facebook)
      || handleValuePresent(handles.facebookHandle)
      || handleValuePresent(handles.facebookPageUrl)],
    ['instagram', () => handleValuePresent(handles.instagram)
      || handleValuePresent(handles.instagramHandle)
      || handleValuePresent(handles.instagramUrl)],
    ['tiktok', () => handleValuePresent(handles.tiktok)
      || handleValuePresent(handles.tiktokHandle)
      || handleValuePresent(handles.tiktokUrl)],
    ['youtube', () => handleValuePresent(handles.youtube)
      || handleValuePresent(handles.youtubeChannel)
      || handleValuePresent(handles.youtubeUrl)],
  ].some(([, test]) => test());
  const handleDetailKeys = Object.keys(handles).filter((k) => {
    const v = handles[k];
    if (v == null) return false;
    if (typeof v === 'string') return v.length > 0;
    if (typeof v === 'object' && Array.isArray(v.handles)) return v.handles.length > 0;
    return false;
  });
  checks.handles = {
    pass: handlePresent,
    detail: handlePresent ? handleDetailKeys.join(',') : 'none resolved',
  };

  // — businessProfile —
  const bp = scan?.businessProfile || {};
  const bpPass = !!bp.type && bp.type !== 'default' && (bp.confidence ?? 0.5) >= 0.5;
  checks.businessProfile = {
    pass: bpPass,
    detail: bp.type ? `${bp.type} (conf=${bp.confidence ?? 'n/a'})` : 'no type',
  };

  // — moneyMath —
  const mm = scan?.moneyMath || {};
  const cpl = mm?.benchmarks?.avgCPL;
  const projHigh = Array.isArray(mm?.projections) && mm.projections[0]?.expectedROAS?.high;
  const mmPass =
    Number.isFinite(cpl) && cpl > 0 &&
    Number.isFinite(projHigh) && projHigh >= 0.5 && projHigh <= 30;
  checks.moneyMath = {
    pass: mmPass,
    detail: `vertical=${mm.vertical || '?'} cpl=${cpl ?? '?'} roasHigh=${projHigh ?? '?'} src=${mm.source || '?'}`,
  };

  // — competitors —
  const compRows = scan?.apifyData?.competitorAds || [];
  let totalAds = 0;
  let adsWithMedia = 0;
  let competitorsWithAds = 0;
  for (const row of compRows) {
    const ads = Array.isArray(row?.ads) ? row.ads : [];
    if (ads.length > 0) competitorsWithAds++;
    totalAds += ads.length;
    for (const a of ads) {
      const hasVideo = Array.isArray(a?.videos) && a.videos.length > 0;
      const hasImage = Array.isArray(a?.images) && a.images.length > 0;
      const hasCard  = Array.isArray(a?.cards)  && a.cards.length  > 0;
      if (hasVideo || hasImage || hasCard) adsWithMedia++;
    }
  }
  if (!hasApifyToken) {
    checks.competitors = {
      pass: true, // skipped (treat as pass when token missing)
      skipped: true,
      detail: 'APIFY_API_TOKEN missing — skipped',
    };
  } else {
    const compPass = totalAds > 0 && adsWithMedia > 0;
    checks.competitors = {
      pass: compPass,
      detail: `${competitorsWithAds}/${compRows.length} competitors returned ads, ${adsWithMedia}/${totalAds} ads have media`,
    };
  }

  const summary = {
    overallPass: Object.values(checks).every((c) => c.pass || c.skipped),
    failedCount: Object.values(checks).filter((c) => !c.pass && !c.skipped).length,
  };
  return { checks, summary };
}

// ── Polling helper ──────────────────────────────────────────────────────────

async function pollUntilReady(scanId, { timeoutMs }) {
  const UrlToAdsScan = require('../model/schema/urlToAdsScan');
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const doc = await UrlToAdsScan.findById(scanId).lean();
    if (!doc) throw new Error('scan disappeared from DB');
    last = doc;
    if (doc.status === 'ready' || doc.status === 'failed') return doc;
    await sleep(2_000);
  }
  return last; // timeout — return last known state
}

// Probe a Redis URL with a single TCP socket — no client library, so we
// don't drag in a BullMQ-style retry loop just to discover the server is
// off. Returns true iff a TCP handshake completes within 1s.
async function probeRedis(url) {
  const net = require('net');
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const u = new URL(url);
    if (u.hostname) host = u.hostname;
    if (u.port) port = Number(u.port) || port;
  } catch (_e) { /* fall through with defaults */ }
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(1000);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ── Concurrency-bounded runner ──────────────────────────────────────────────

async function runWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { item: items[i], error: err && err.message ? err.message : String(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return out;
}

// ── Pretty print ────────────────────────────────────────────────────────────

const COLORS = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

function tag(kind) {
  if (kind === 'pass') return `${COLORS.green}PASS${COLORS.reset}`;
  if (kind === 'fail') return `${COLORS.red}FAIL${COLORS.reset}`;
  if (kind === 'skip') return `${COLORS.yellow}SKIP${COLORS.reset}`;
  if (kind === 'err')  return `${COLORS.red}ERR ${COLORS.reset}`;
  return kind;
}

function printRow(rec) {
  const { item, scan, evalResult, durationMs, error } = rec;
  const url = item.url.padEnd(56);
  const ms = (durationMs == null ? '?' : `${(durationMs / 1000).toFixed(1)}s`).padStart(7);
  if (error) {
    console.log(`  ${tag('err')}  ${url}  ${ms}  ${COLORS.red}${error}${COLORS.reset}`);
    return;
  }
  if (!scan) {
    console.log(`  ${tag('err')}  ${url}  ${ms}  ${COLORS.red}no scan persisted${COLORS.reset}`);
    return;
  }
  const overall = evalResult.summary.overallPass ? tag('pass') : tag('fail');
  const checks = evalResult.checks;
  const checkLine = ['handles', 'businessProfile', 'moneyMath', 'competitors']
    .map((k) => {
      const c = checks[k];
      const t = c.skipped ? tag('skip') : (c.pass ? tag('pass') : tag('fail'));
      return `${COLORS.dim}${k}${COLORS.reset}=${t}`;
    })
    .join(' ');
  console.log(`  ${overall}  ${url}  ${ms}  ${checkLine}`);
  if (!evalResult.summary.overallPass) {
    for (const [k, c] of Object.entries(checks)) {
      if (!c.pass && !c.skipped) {
        console.log(`         ${COLORS.dim}↳ ${k}: ${c.detail}${COLORS.reset}`);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  let items = CATALOG;
  if (args.only) items = items.filter((c) => c.url.toLowerCase().includes(args.only));
  if (Number.isFinite(args.limit) && args.limit > 0) items = items.slice(0, args.limit);

  if (args.dryRun) {
    console.log(`Catalog (${items.length} items):`);
    items.forEach((it, i) => console.log(`  ${(i + 1).toString().padStart(2)}. ${it.url}  [${it.category}/${it.country}]`));
    return process.exit(0);
  }

  const hasApifyToken = !!process.env.APIFY_API_TOKEN;
  const hasAnthropic  = !!process.env.ANTHROPIC_API_KEY;
  console.log(`${COLORS.bold}scanQuality:${COLORS.reset} ${items.length} URLs, concurrency=${args.concurrency}, timeout=${args.timeout}ms, threshold=${args.threshold}`);
  console.log(`            ANTHROPIC_API_KEY=${hasAnthropic ? 'set' : 'MISSING (fallback paths)'}, APIFY_API_TOKEN=${hasApifyToken ? 'set' : 'MISSING (competitor checks skipped)'}`);

  // ── Preflight: Redis must be reachable ─────────────────────────────────
  // The enrichment job runs in a BullMQ worker connected to Redis. Without
  // it, scanUrl() returns immediately with status='scanning' and the work
  // never executes — every URL silently times out at the per-scan timeout.
  // Checking once up-front saves 30 × timeout seconds of frustrated waiting.
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redisOk = await probeRedis(redisUrl).catch(() => false);
  if (!redisOk) {
    console.log('');
    console.log(`${COLORS.red}${COLORS.bold}PREFLIGHT FAIL${COLORS.reset}: Redis is not reachable at ${redisUrl}`);
    console.log(`            The URL→Ads enrichment job runs in a BullMQ worker; without`);
    console.log(`            Redis the scan never enriches and every URL times out.`);
    console.log('');
    console.log(`            Start it with one of:`);
    console.log(`              brew services start redis`);
    console.log(`              docker run -d --name qumak-redis -p 6379:6379 redis:7-alpine`);
    console.log(`              redis-server --daemonize yes`);
    console.log('');
    process.exit(2);
  }
  console.log(`            redis up:    ${redisUrl}`);

  // Connect Mongo
  const dbUrl = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.DB || 'qumak';
  await mongoose.connect(`${dbUrl}/${dbName}`);
  console.log(`            db connected: ${dbName}`);
  console.log('');

  const { scanUrl } = require('../services/urlToAdsService');
  const { runScanEnrichmentJob } = require('../services/urlToAdsEnrichJob');

  const records = await runWithConcurrency(items, args.concurrency, async (item, idx) => {
    const t0 = Date.now();
    try {
      // Synthetic req shim — gives ownerFromReq / getStudioSessionId real fields
      // to read without us booting middleware.
      const req = {
        studioSessionId: `eval-harness-${idx}-${Date.now()}`,
        user: null,
        headers: {},
        cookies: {},
      };
      const initial = await Promise.race([
        scanUrl({ url: item.url, req }),
        sleep(args.timeout).then(() => { throw new Error(`scanUrl timed out after ${args.timeout}ms`); }),
      ]);

      // Production scanUrl() enqueues enrichment to a BullMQ worker that may
      // not be running in eval/CI environments. Run the enrichment inline
      // so the harness is self-contained: just needs Mongo + Redis (queue
      // primitives), no `npm run dev` worker required.
      await Promise.race([
        runScanEnrichmentJob({ scanId: String(initial._id), userId: null }),
        sleep(args.timeout).then(() => { throw new Error(`enrichment timed out after ${args.timeout}ms`); }),
      ]).catch((e) => {
        // Don't kill the eval — record the error against the scan and let
        // pollUntilReady decide if the partial state is good enough.
        console.warn(`[scanQuality] enrich error for ${item.url}:`, e.message);
      });

      const finalScan = await pollUntilReady(initial._id, { timeoutMs: 5000 });
      const evalResult = evaluateScan(finalScan, hasApifyToken);
      return {
        item,
        scan: finalScan,
        evalResult,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        item,
        scan: null,
        evalResult: null,
        durationMs: Date.now() - t0,
        error: err && err.message ? err.message : String(err),
      };
    }
  });

  // Stream the report after all scans complete (parallel logs would interleave)
  console.log(`${COLORS.bold}Results:${COLORS.reset}`);
  for (const rec of records) printRow(rec);

  // Aggregate
  const total       = records.length;
  const errored     = records.filter((r) => r.error).length;
  const evaluated   = records.filter((r) => r.evalResult).length;
  const passed      = records.filter((r) => r.evalResult?.summary.overallPass).length;
  const failureMix  = {};
  for (const r of records) {
    if (!r.evalResult) continue;
    for (const [k, c] of Object.entries(r.evalResult.checks)) {
      if (!c.pass && !c.skipped) failureMix[k] = (failureMix[k] || 0) + 1;
    }
  }
  const passRate = evaluated ? passed / evaluated : 0;

  console.log('');
  console.log(`${COLORS.bold}Summary:${COLORS.reset} ${passed}/${evaluated} passed (${(passRate * 100).toFixed(1)}%), ${errored} errored, ${total} total`);
  if (Object.keys(failureMix).length) {
    console.log(`Failures by check:`);
    Object.entries(failureMix)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log(`  ${COLORS.red}✗${COLORS.reset} ${k.padEnd(18)} ${n} failures`));
  }

  if (args.json) {
    const reportPath = path.resolve(args.json);
    const json = {
      generatedAt: new Date().toISOString(),
      env: { hasApifyToken, hasAnthropic, db: dbName },
      args,
      summary: { total, evaluated, passed, errored, passRate, failureMix },
      records: records.map((r) => ({
        url: r.item.url,
        category: r.item.category,
        country: r.item.country,
        durationMs: r.durationMs,
        scanId: r.scan?._id ? String(r.scan._id) : null,
        status: r.scan?.status || null,
        error: r.error || null,
        evalResult: r.evalResult || null,
      })),
    };
    fs.writeFileSync(reportPath, JSON.stringify(json, null, 2));
    console.log(`Wrote JSON report to ${reportPath}`);
  }

  await mongoose.disconnect();

  if (passRate < args.threshold) {
    console.log(`${COLORS.red}${COLORS.bold}FAIL${COLORS.reset}: pass rate ${(passRate * 100).toFixed(1)}% < threshold ${(args.threshold * 100).toFixed(0)}%`);
    process.exit(1);
  } else {
    console.log(`${COLORS.green}${COLORS.bold}OK${COLORS.reset}: pass rate ${(passRate * 100).toFixed(1)}% >= threshold ${(args.threshold * 100).toFixed(0)}%`);
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('scanQuality crashed:', err);
    process.exit(2);
  });
}

module.exports = {
  evaluateScan,
  handleValuePresent,
  CATALOG,
};
