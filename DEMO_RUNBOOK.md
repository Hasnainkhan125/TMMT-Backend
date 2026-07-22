# Qumak — Investor Demo Runbook

Short, executable playbook for the investor demo. Everything here has been
exercised against the running backend.

---

## 1. One-time setup

```bash
# From repo root
cd qumak-backend
npm install
cp .env.example .env   # if you haven't already
# .env must include (at minimum):
#   MONGODB_URI=mongodb://127.0.0.1:27017
#   DB=qumak
#   JWT_SECRET=<anything_nonempty_for_local>
#   FAL_API_KEY=<real key, demo needs real rendering>
```

Then seed the database with supporting data if you haven't already:

```bash
npm run seed:models        # AI model catalog (required for quoting / charging)
npm run seed:admin         # an admin user for the ops dashboard
npm run seed:demo          # demo@qumak.io + 500-ish credits + 5 jobs + a scan
```

Open two terminals:

```bash
# terminal 1 — API + sockets + HTTP layer
cd qumak-backend && npm run dev

# terminal 2 — video/image worker (consumes the StudioJob queue)
cd qumak-backend && npm run studio:worker
```

Start the frontend:

```bash
cd qumak-frontend && npm run dev
# → http://localhost:5173  (or whichever port Vite picks)
```

Before going on stage, run:

```bash
cd qumak-backend && npm run smoke     # 10-second end-to-end happy path
```

If any critical step fails, the demo is not ready. Fix it, re-seed, re-run.

---

## 2. Demo accounts

### User (the one you'll demo)

- **email**: `demo@qumak.io`
- **password**: `Demo!2026`
- **credits**: ~666 (varies slightly per seed run; reconciled with ledger)

The account comes pre-loaded with:
- 9 ledger rows (bonus → top-ups → charges → refund)
- 3 completed image jobs + 1 completed video job + 1 live "generating" job
- 1 `ready` URL→Ads scan for `pulsefitness.ae` with the free trial available

### Admin (for the ops dashboard)

Whatever `npm run seed:admin` created for you (check `scripts/seedAdminAccess.js`
for the credentials — typically `admin@qumak.io / <env-driven password>`).

Once signed in as admin, navigate to `/admin/ops` for the operational
dashboard (Overview / Jobs / Credits / URL→Ads).

---

## 3. The 5-minute demo script

| Beat | Action | What to point at |
|---|---|---|
| 0:00 | Sign in as `demo@qumak.io` | Credits chip shows a real balance, not "0" |
| 0:30 | Studio → paste a brand prompt | Prompt pipeline, model picker |
| 1:00 | Hit Generate | Real FAL render in ~5–10s; progress bar advances via websocket |
| 2:00 | URL→Ads → paste `pulsefitness.ae` (or use the pre-seeded scan) | Persistent scan page, 3 blueprint tiles, brand kit extraction |
| 3:00 | Click "Generate all 3" | Free-trial credit is granted and charged — ledger trail visible |
| 4:00 | `/admin/ops` in a second tab | KPI tiles, jobs list, credits ledger, URL→Ads scans |
| 4:30 | `/metrics` if asked about observability | Prometheus counters for http + jobs + credits + scans |

---

## 4. If something goes wrong, in order

1. **Credits show 0 / anonymous balance**
   - You probably hit the page before the JWT cookie was set. Hard-refresh.
   - If it persists, run `npm run smoke` to confirm `/me/credits` is auth'd.

2. **Studio generation stuck at 0%**
   - Worker isn't running. Check terminal 2.
   - If FAL credentials expired, check `FAL_API_KEY` in `.env`.

3. **URL→Ads scan says "forbidden"**
   - Re-seed: `npm run seed:demo`. Confirms scan ownership uses the current JWT.

4. **The ops dashboard is empty**
   - Normal if you never hit a page on this DB. Run the smoke to put some data
     on the wire, or re-run `seed:demo` for realistic rollups.

5. **Demo data is wrong or polluted mid-run**
   - `npm run seed:demo:reset` wipes the demo user's jobs/ledger/scans WITHOUT
     touching other users. Then `npm run seed:demo` recreates it cleanly.

---

## 5. Verification & performance checks

Before the demo you should get a clean run of all three:

```bash
# 1. End-to-end smoke (signup → balance → scan → generate → ledger → metrics)
npm run smoke
# Expected: "9 passed · 1 skipped · 0 failed"

# 2. Load test — proves the hot paths hold up under concurrent pressure.
# Needs a token; grab one from a login response.
TOKEN=$(curl -s -X POST http://localhost:5001/api/v1/auth/signin \
  -H 'content-type: application/json' \
  -d '{"email":"demo@qumak.io","password":"Demo!2026"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.token))")

SMOKE_TOKEN="$TOKEN" DURATION_SEC=10 CONCURRENCY=20 npm run loadtest
# Expected on a dev laptop: p95 < 30ms on every target, 0 errors,
# 2000+ rps aggregate.

# 3. Unit + integration
npm test
# Expected: all Phase 5–8 specs (urlToAds*, reelService, adSetService,
# creditsService) green.
```

---

## 6. Scripts cheat-sheet

| Command | Purpose |
|---|---|
| `npm run dev` | API + HTTP + sockets |
| `npm run studio:worker` | FAL job consumer |
| `npm run seed:models` | AI model catalog (prerequisite) |
| `npm run seed:admin` | Admin user |
| `npm run seed:demo` | Demo user + realistic jobs/ledger/scan |
| `npm run seed:demo:reset` | Wipe demo user's data only |
| `npm run smoke` | E2E happy-path smoke |
| `npm run loadtest` | Concurrent load on hot paths |
| `npm test` | Jest suites |

---

## 7. What Phase 9 added

| File | Why |
|---|---|
| `scripts/smoke-e2e.js` | 10-second proof the whole happy path works |
| `scripts/load-test.js` | Sanity-check concurrent throughput + latencies |
| `scripts/seed-demo.js` | Reproducible demo dataset with finance-consistent ledger |
| `DEMO_RUNBOOK.md` | This document |
| `StudioPage.tsx` — polling fix | Was polling at ~200 req/sec; now 2.5s |
| `urlToAdsService.js` — userId resolution | Used to orphan scans as anonymous |
| `routes/credits.js` — optional auth | Signed-in users no longer see anonymous balance |
| `authController.js` — eager signup bonus | Ledger row exists from t=0, not on first balance read |
