#!/usr/bin/env node
'use strict';

/**
 * smoke-e2e.js — Phase 9 investor-demo smoke test.
 *
 * Exercises the critical happy path against a running backend:
 *   1. /health & /metrics are alive
 *   2. signup  → get JWT
 *   3. /api/v1/me/credits returns signup bonus balance
 *   4. POST /studio/url-to-ads/scan  → persistent scan
 *   5. GET  /studio/url-to-ads/scan/:id (poll until ready / timeout)
 *   6. POST /studio/url-to-ads/scan/:id/generate → ad set kicked off
 *   7. GET  /me/credits/ledger → sees the top-up + charge rows
 *   8. (if admin creds) GET /admin/ops/overview returns rollups
 *   9. /metrics is populated with http_requests_total / url_scans_total
 *
 * Usage:
 *   BASE_URL=http://localhost:5001 node scripts/smoke-e2e.js
 *   BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/smoke-e2e.js
 *
 * Exit codes:
 *   0 — all critical steps passed (admin step is skipped not failed)
 *   1 — at least one critical step failed
 *
 * Uses only the node built-in fetch (Node ≥ 20) so it runs with zero deps.
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5001').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCAN_URL = process.env.SCAN_URL || 'https://example.com';
const SCAN_POLL_TIMEOUT_MS = Number(process.env.SCAN_POLL_TIMEOUT_MS || 60_000);
const SCAN_POLL_INTERVAL_MS = 2_000;

const results = [];
let criticalFailures = 0;

function log(status, step, detail) {
  const icons = { ok: '✔', skip: '↷', fail: '✗' };
  // keep the output grep-friendly for CI
  const line = `[${icons[status] || '·'}] ${step}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  results.push({ status, step, detail });
}

function fail(step, detail) {
  criticalFailures++;
  log('fail', step, detail);
}

async function http(method, path, { token, body, headers = {}, allow = [] } = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const h = { accept: 'application/json', ...headers };
  if (body) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { /* non-json */ }
  if (!res.ok && !allow.includes(res.status)) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 180);
    throw new Error(`${method} ${path} → ${res.status} ${msg}`);
  }
  return { status: res.status, body: json, raw: text };
}

async function step(name, fn) {
  try {
    const out = await fn();
    log('ok', name, out);
    return out;
  } catch (err) {
    fail(name, err?.message || String(err));
    return null;
  }
}

async function main() {
  console.log(`\n── Qumak smoke E2E ─ ${BASE_URL} ─ ${new Date().toISOString()} ──`);

  // 1. health + metrics
  await step('GET /health', async () => {
    const { body } = await http('GET', '/health');
    if (!body?.status && !body?.ok && body?.success !== true) throw new Error('health body missing status/ok/success');
    return body?.status || body?.ok ? `status=${body.status || 'ok'}` : 'ok';
  });

  await step('GET /metrics (before)', async () => {
    const { raw } = await http('GET', '/metrics');
    if (!raw || !raw.includes('http_requests_total')) throw new Error('/metrics missing http_requests_total');
    return `${raw.split('\n').length} lines`;
  });

  // 2. signup
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@qumak.test`;
  const password = 'Smoke!Test!1234';
  let token = null;
  let userId = null;

  const signupRes = await step('POST /api/v1/auth/signup', async () => {
    const { body } = await http('POST', '/api/v1/auth/signup', {
      body: { firstName: 'Smoke', lastName: 'Test', email, password },
    });
    token = body?.data?.token || body?.token;
    userId = body?.data?.user?.id;
    if (!token) throw new Error('no token in signup response');
    return `userId=${userId || '?'} tokenLen=${token.length}`;
  });
  if (!signupRes || !token) {
    console.log('\n⛔ cannot continue without an auth token — aborting further user-scoped steps.\n');
    return finalize();
  }

  // 3. credits balance (signup bonus)
  await step('GET /api/v1/me/credits', async () => {
    const { body } = await http('GET', '/api/v1/me/credits', { token });
    if (typeof body?.balance !== 'number') throw new Error('credits balance missing');
    return `balance=${body.balance}`;
  });

  // 4. URL→Ads scan
  let scanId = null;
  await step('POST /api/v1/studio/url-to-ads/scan', async () => {
    const { body } = await http('POST', '/api/v1/studio/url-to-ads/scan', {
      token,
      body: { url: SCAN_URL },
    });
    scanId = body?.scan?.id || body?.scan?._id || body?.scan?.scanId;
    if (!scanId) throw new Error('no scanId in response');
    return `scanId=${scanId} status=${body?.scan?.status || '?'}`;
  });

  // 5. poll scan status
  if (scanId) {
    await step('GET scan status until ready/failed', async () => {
      const deadline = Date.now() + SCAN_POLL_TIMEOUT_MS;
      let lastStatus = '?';
      let polls = 0;
      while (Date.now() < deadline) {
        polls++;
        const { body } = await http('GET', `/api/v1/studio/url-to-ads/scan/${scanId}`, { token });
        lastStatus = body?.scan?.status || '?';
        if (lastStatus === 'ready' || lastStatus === 'failed') {
          return `polls=${polls} final=${lastStatus}`;
        }
        await new Promise(r => setTimeout(r, SCAN_POLL_INTERVAL_MS));
      }
      throw new Error(`timed out after ${polls} polls; lastStatus=${lastStatus}`);
    });

    // 6. kick generate — skipped if scan isn't ready, we just check the endpoint
    await step('POST .../generate (kick only)', async () => {
      // Accept 200 (generated) or 409/422/400 (scan not ready yet / busy) —
      // this step is primarily wiring + auth check, not a full render.
      const { status, body } = await http(
        'POST',
        `/api/v1/studio/url-to-ads/scan/${scanId}/generate`,
        { token, allow: [400, 402, 409, 422] },
      );
      return `status=${status} reply=${body?.error || body?.message || 'ok'}`;
    });
  }

  // 7. ledger (may be empty if no generation ran, but the endpoint must work)
  await step('GET /api/v1/me/credits/ledger', async () => {
    const { body } = await http('GET', '/api/v1/me/credits/ledger?limit=10', { token });
    if (!Array.isArray(body?.items)) throw new Error('ledger items missing');
    return `items=${body.items.length}`;
  });

  // 8. admin ops (optional — only runs if creds supplied)
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    let adminToken = null;
    await step('POST /auth/signin as admin', async () => {
      const { body } = await http('POST', '/api/v1/auth/signin', {
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      adminToken = body?.data?.token || body?.token;
      if (!adminToken) throw new Error('no admin token');
      return `tokenLen=${adminToken.length}`;
    });
    if (adminToken) {
      await step('GET /admin/ops/overview', async () => {
        const { body } = await http('GET', '/api/v1/admin/ops/overview?windowDays=7', { token: adminToken });
        if (!body?.success) throw new Error('ops/overview did not return success');
        const c = body?.credits?.totals;
        const j = body?.jobs?.status;
        return `credits=${c ? Object.keys(c).length : 0} jobs=${j ? Object.keys(j).length : 0}`;
      });
    }
  } else {
    log('skip', 'admin/ops check', 'ADMIN_EMAIL / ADMIN_PASSWORD not provided');
  }

  // 9. metrics populated after traffic
  await step('GET /metrics (after) — sees activity', async () => {
    const { raw } = await http('GET', '/metrics');
    const hasHttp = /http_requests_total\{[^}]*status="2\d\d"[^}]*\}\s+\d+/m.test(raw)
      || /http_requests_total\{[^}]*status="304"[^}]*\}\s+\d+/m.test(raw);
    if (!hasHttp) throw new Error('no http_requests_total rows with counted traffic');
    return 'metrics reflect smoke traffic';
  });

  finalize();
}

function finalize() {
  const ok = results.filter(r => r.status === 'ok').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const bad = results.filter(r => r.status === 'fail').length;
  console.log(`\n── Result: ${ok} passed · ${skip} skipped · ${bad} failed ──\n`);
  process.exit(criticalFailures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ smoke-e2e crashed:', err?.stack || err?.message || err);
  process.exit(1);
});
