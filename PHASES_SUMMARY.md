# Qumak — Phase 1–9 Implementation Summary

> **Audience:** engineering co-workers and AI collaborators reviewing the
> cumulative state of the Studio stack. Written to be shared & argued with.
> Tells you **what was built, why, where the seams are, and what's still
> up for debate** — not a feature brochure.

**Last updated:** 2026-04-21, end of Phase 9.

---

## 0. TL;DR

Over nine phases we built a full "paste-a-URL → get finished ads → pay
per credit" pipeline on top of the existing Express/Mongo monolith:

- A generic image/video generation core (jobs, workers, storage, sockets).
- Copy generation, share links, lead capture, UTM attribution.
- An intent / prompt intelligence layer that classifies free-text prompts,
  picks strategies, and rewrites them into model-aware final prompts.
- A Scene Builder ("reel") and Ad-Set pipeline (3–5 variants per brief).
- An Influencer Builder.
- A URL→Ads flow that scrapes a site, extracts a brand kit, and produces
  three ad blueprints ready to render.
- A credits ledger and a quote/charge/refund service.
- Structured logging, request IDs, in-process Prometheus metrics.
- An Admin Ops dashboard (API + React UI) for operational visibility.
- An end-to-end smoke test, a load test, a demo seed, and a runbook.

Phases 7, 8, 9 are exhaustively documented below because that's where I
have first-hand history. Phases 1–6 are reconstructed from on-disk code
(file headers, model schemas, service structure, existing tests). Where I
say "Phase N introduced X" for 1–6 I'm summarising code I've read; treat it
as informed inference, not a commit log.

---

## 1. High-level architecture snapshot

```
┌───────────────────────────────────────────────────────────────────────────┐
│ qumak-frontend (Vite + React)                                             │
│   Studio page, URL→Ads page, Admin Ops dashboard, BrandBuilder            │
└───────────────▲───────────────────────▲──────────────────▲────────────────┘
                │ REST                  │ websocket        │ REST
                │                       │ (socket.io)      │
┌───────────────┴───────────────────────┴──────────────────┴────────────────┐
│ qumak-backend (Express, CommonJS)                                         │
│                                                                           │
│  middleware: requestContext · optionalAuth · auth · utmCapture · rate-lim │
│                                                                           │
│  controllers:                                                             │
│    auth · admin (+ops) · studio (+ext, +urlToAds, +adSet, +reel)          │
│                                                                           │
│  services:                                                                │
│    adBrain · intentEngine · promptBuilder_v2 · promptEnhancer ·           │
│    falService_v2 · storageService · processingService ·                   │
│    copyService · shareService · creditsService ·                          │
│    adSetService · reelService · influencerService ·                       │
│    urlScraper · urlToAdsService · modelRouter · providerRouter            │
│                                                                           │
│  data (Mongo):                                                            │
│    StudioJob · StudioAsset · AiModel · CreditLedger · Persona ·           │
│    BrandProject · GenerationTemplate · UrlToAdsScan · ShareableLink ·     │
│    Lead · AdCopy · AdBrainFeedback · StudioUser · DailyStat               │
│                                                                           │
│  infra:                                                                   │
│    BullMQ (Redis) queue · Redis pub/sub · R2 storage · FAL (video/image) │
│                                                                           │
│  observability (Phase 8):                                                 │
│    utils/logger · utils/metrics · middelwares/requestContext · /metrics   │
│                                                                           │
│  workers:                                                                 │
│    videoWorker_v3 (BullMQ consumer → FAL → ffmpeg → R2 → socket relay)    │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase-by-phase breakdown

### Phase 1 — Studio foundations *(reconstructed)*

**Goal.** Let anonymous/authenticated users submit a brief and get a
watermarked short ad video back, with real-time progress.

**What went in:**
- `model/schema/studioJob.js` — the central job document (category,
  userInputs, promptPipeline, stages, status, output, kind, tier, credits).
- `model/schema/dailyStat.js` — per-day rollups of completed/failed jobs,
  cost in USD, category breakdown.
- `model/schema/aiModel.js` — catalog of image/video models with
  per-image / per-second credit costs; single source of truth for pricing.
- `services/adBrain.js` — category "DNA" + deterministic prompt assembly.
- `services/falService.js` (+ later `falService_v2.js`) — FAL API wrapper,
  handles text-to-image, text-to-video, upscale.
- `services/storageService.js` — R2 uploads via @aws-sdk/client-s3.
- `services/processingService.js` — FFmpeg color grading + watermark.
- `utils/socketEmitter.js` — Redis pub/sub → socket.io relay so the
  worker process can stream progress to the client.
- `controllers/studio/studioController.js` + `_routes.js` — REST for
  generate / status / list with rate limiting.
- `workers/videoWorker*.js` — BullMQ worker consuming a Redis queue.

**Why this shape:** the worker had to be a separate process (FFmpeg is CPU
heavy, FAL calls are long), and Redis pub/sub was already in the stack
for sockets, so it got double-duty as the worker→web bridge.

**Open questions worth raising:**
- `studioJob_v3.js` exists alongside `studioJob.js`. One is stale. The
  mounted model is `studioJob.js` (line 361 `mongoose.model('StudioJob')`)
  but `v3.js` also registers as `'StudioJob'` (line 206) — load order
  decides the winner. That's a foot-gun and should be resolved.

---

### Phase 2 — Studio extensions *(reconstructed)*

**Goal.** Turn a single-purpose generator into a product — you can capture
the lead, share the asset, rate the result, and refine it.

**What went in:**
- `model/schema/studioAsset.js` — generated media record tied to a job,
  with watermarked + clean URLs, variants, ownership.
- `model/schema/shareableLink.js` — short codes for public share pages
  (view count, click count).
- `model/schema/lead.js` — email capture with UTM attribution.
- `model/schema/adCopy.js` — AI ad copy (headline, body, CTAs) per asset.
- `model/schema/adBrainFeedback.js` — 👍/👎 on generated assets.
- `model/schema/studioUser.js` — studio-side profile (referral, credits,
  first-touch UTM).
- `services/copyService.js` — Claude Haiku for copy generation.
- `services/promptRefiner.js` — "make it brighter / more energetic" prompt
  mutation, also Claude Haiku.
- `services/shareService.js` — share-link lifecycle + view/click tracking.
- `middleware/utmCapture.js` (in `middelwares/`) — stores UTM params in
  Redis keyed by session with a 24 h TTL.
- `controllers/studio/extController.js` + `_extRoutes.js` — the additive
  surface (generateCopy, refine, share, lead, rate, download, usage).

**Design note:** everything here was intentionally additive so the core
generate path in Phase 1 stayed untouched. Refine reuses the same BullMQ
queue — there is still only one worker kind.

---

### Phase 3 — Director Rail + prompt intelligence *(reconstructed)*

**Goal.** Treat the user's free-text prompt as a signal to be understood,
not a string to be forwarded. Improve "what the model sees" without
changing "what the user types".

**What went in:**
- `services/intentEngine.js` — classifies a prompt into an intent
  (`creative_image`, `ad_video`, `director`, `url_to_ad`, `template`, etc.)
  and a domain (gym, restaurant, perfume, saas, …). These become indexed
  fields on the StudioJob.
- `services/promptBuilder_v2.js` — assembles `finalPrompt`, negative
  prompt, and "refinement notes". The Director Rail additions live at
  `// ── Director Rail additions (Phase 3) ──` (line 345 of that file).
- `services/promptEnhancer.js` — the LLM rewriter that turns a terse
  user brief into a cinema-grade prompt, with purification to strip
  provider-banned tokens before sending to FAL.
- `services/imagePromptPurifier.js` + `services/falPayloadSanitizer.js` —
  the last-mile guards.

**Why:** empirically, what kills ad quality is not the model — it's the
prompt. We keep raw intent in `promptPipeline.rawUserIntent` for debugging
and pay attention to `promptPipeline.sceneFromUser` so we can answer "why
did my text get ignored?" complaints deterministically.

---

### Phase 4 — Scene Builder (Reels) *(reconstructed)*

**Goal.** Let a user assemble multi-scene reels, not just single shots.

**What went in:**
- `services/reelService.js` — orchestrates N scene jobs → stitches. Each
  scene is itself a StudioJob with `parentJobId` pointing at the reel.
- `controllers/studio/reelController.js` — REST surface for create / scene
  CRUD / status.
- `tests/reelService.test.js` — Jest coverage.

**Phase 9 aside:** I fixed a bug here during Phase 9 work — `reelService`
was calling `creditsService.refundJob(...)` (non-existent) on scene
failures. Corrected to `creditsService.refundForJob(...)`.

---

### Phase 5 — Ad-set pipeline *(reconstructed)*

**Goal.** "Give me 3 headline+caption+aspect variations of this one brief"
— parallel variant generation that shares a copy pass but renders in a
fan-out with independent jobs.

**What went in:**
- `services/adSetService.js` — the fan-out orchestrator. Produces an
  "ad-set parent" StudioJob and N child jobs, one per variant, each with
  its own copy and aspect ratio.
- `controllers/studio/adSetController.js` — REST surface.
- `services/creditsService.js` — quote/canAfford/chargeForJob/refundForJob
  landed here because ad sets made per-item pricing unavoidable.
- `model/schema/creditLedger.js` — append-only ledger, every charge /
  refund / top-up / grant writes a row with `balanceAfter`.
- `tests/adSetService.test.js` — Jest.

**Why a ledger:** once we had refunds, admin grants, and multi-channel
top-ups (Stripe, Tabby, Tamara), a single `User.platformCredits` field
couldn't be reconciled without knowing the sequence of events. The
ledger is the finance-grade answer.

---

### Phase 6 — Influencer Builder *(reconstructed)*

**Goal.** Generate a consistent synthetic influencer/persona and reuse
them across shoots — same face, new scenes.

**What went in:**
- `model/schema/persona.js` — persisted character spec (traits, likeness
  tokens, reference images).
- `services/influencerService.js` — persona CRUD + "put this persona in
  this scene" orchestration (routes through adSetService or direct
  studioJob depending on the shape).
- `services/referenceUrlGate.js` — enforces that likeness reference URLs
  live on R2 / trusted hosts.
- `tests/influencerService.test.js` — Jest.

**Concerns flagged in code:** persona likeness is a legally sensitive
area. The gate exists so we never upload user-supplied URLs straight to
FAL without a known-safe host check.

---

### Phase 7 — URL→Ads persistent scan *(first-hand)*

**Goal.** Replace the transient "paste a URL, wait, see three images"
drawer with a **first-class report page** that is shareable, bookmarkable,
and re-renderable.

**What went in:**
- `model/schema/urlToAdsScan.js` — new persistent document:
  URL, status, host, brand kit (title, description, headlines, images,
  category, audience), competitors, AI copy bundle, 3 ad blueprints,
  `freeTrialConsumed` boolean.
- `services/urlToAdsService.js` — scanUrl / getScan / listScans /
  generateAds / archiveScan. Delegates rendering to `adSetService` so
  the credits flow is identical to Phase 5.
- `controllers/studio/urlToAdsController.js` + routes at
  `/api/v1/studio/url-to-ads/...`.
- Frontend `qumak-frontend/src/pages/Studio/UrlToAdsPage.tsx` — the
  report page with header, brand kit, competitors, copy, 3 ad tiles.
- Sidebar entry so users can find it.

**Business mechanic:** the **first generation per scan is free**. The
service grants a `topup_signup_bonus` equal to the cost, then the ad-set
service charges normally. This gives reconciliation a clean "+N / -N"
pair in the ledger instead of a magic "first generate is free" flag in
the charge path. `scan.freeTrialConsumed = true` afterwards.

**Test coverage:** `tests/urlToAd.test.js`, `tests/urlToAdsService.test.js`,
`tests/urlToAdsController.test.js` — all green (37 cases).

**Open question:** should an admin role bypass `freeTrialConsumed`?
Currently admins *do* bypass (it's intentional for demos), but that means
admin activity inflates "free trials consumed" metrics. Worth debating.

---

### Phase 8 — Observability + Admin + Credits *(first-hand)*

**Goal.** Make the system legible to operators, and make the credits
system finance-grade.

**Observability additions:**
- `utils/logger.js` — zero-dependency structured JSON logger with levels,
  child bindings, error-safe serialization. We rejected `pino` because it
  would have been another dep for ~60 lines of value.
- `middelwares/requestContext.js` — assigns a `req.id` (honours inbound
  `x-request-id`), mints a child logger at `req.log`, logs one access
  record per request on `finish`, and bumps HTTP metrics.
- `utils/metrics.js` — tiny in-process Prometheus-compatible metrics:
  counters (`http_requests_total`, `studio_jobs_total`, `credit_movements_total`,
  `url_scans_total`) and histograms (`http_request_duration_ms`,
  `studio_job_duration_ms`). Exposed at `GET /metrics`.
- Worker wired: `videoWorker_v3.updateDailyStats` now also calls
  `metrics.incJob(kind, status, { durationMs })` so job metrics populate.

**Credits hardening:**
- `creditsService.recordTopUp` — ledger-mirror utility for top-up paths
  that had already done the atomic `$inc` on `User.platformCredits`
  (legacy Stripe / BNPL webhooks). Every top-up now writes a ledger row.
- All top-up sites updated:
  `confirmCredits`, `handleStripeWebhookEvent`, `handleTabbyWebhook`,
  `handleTamaraWebhook`, `adminGrantCredits`.
- `_grant`, `chargeForJob`, `refundForJob` all emit metrics.

**Admin Ops dashboard:**
- `controllers/admin/adminOpsController.js` — one parallel fan-out of
  aggregations per tile:
  - `GET /admin/ops/overview` — credit totals by reason, job status/success
    rate, daily costs, active users.
  - `GET /admin/ops/jobs` + `/jobs/:id` — paginated list with filters and
    per-job detail (including linked ledger rows + child jobs).
  - `GET /admin/ops/credits/ledger` — raw ledger search.
  - `GET /admin/ops/credits/summary` — by reason, by day.
  - `GET /admin/ops/credits/top-spenders`.
  - `GET /admin/ops/scans` — URL→Ads list with filter.
  - `GET /admin/ops/health` — queue depth, metric counters, process info.
- Router gated with `requireRole('admin','superadmin')` — intentionally
  stricter than the rest of `/admin` which also accepts `amer`.
- Frontend:
  - `qumak-frontend/src/api/admin-ops-api.ts` — typed client.
  - `qumak-frontend/src/pages/BackOffice/AdminOpsPage.tsx` — tabbed
    dashboard (Overview, Jobs, Credits, URL→Ads).
  - Route `/admin/ops` (lazy), link from `AdminControlPanel`.

**Also in Phase 8:**
- Fixed `reelService` refund bug (`refundJob` → `refundForJob`).

---

### Phase 9 — E2E + Load + Investor Demo Polish *(first-hand)*

**Goal.** Prove the system is demo-ready, *prove it*, and leave behind
tools that prove it again next time.

**What was built:**
- `scripts/smoke-e2e.js` (`npm run smoke`) — 10-second E2E happy path:
  `/health` → `/metrics` → signup → balance (expect signup bonus) →
  scan URL → poll until ready → kick generate → ledger → (optional admin
  ops) → metrics populated.
- `scripts/load-test.js` (`npm run loadtest`) — weighted-target concurrent
  load. Accepts a token via `SMOKE_TOKEN` / `ADMIN_TOKEN` to exercise
  authed paths. Reports p50/p95/p99/max/err% per target. Fails the
  process if any target exceeds the error budget (default 2 %).
- `scripts/seed-demo.js` (`npm run seed:demo` / `npm run seed:demo:reset`)
  — idempotent demo dataset: `demo@qumak.io` / `Demo!2026`, 9 reconciled
  ledger rows (bonus → top-ups → charges → refund), 3 completed image
  jobs + 1 completed video + 1 live "generating" job, 1 ready URL→Ads
  scan with free trial available, 7 days of DailyStat rollups. Runs
  `--reset` to wipe demo-user data without touching anyone else.
- `DEMO_RUNBOOK.md` — the 5-minute demo script with failure recovery.
- `PHASES_SUMMARY.md` — **this file**.

**Four demo-breaking bugs the tooling exposed (all fixed):**

| # | Bug | File | Why it would have blown up on stage |
|---|---|---|---|
| 1 | `useEffect` dep was the whole `jobs` store map, so every socket update → re-ran effect → fired `tick()` → updated store → repeat. We saw ~200 req/sec to `/studio/job/:id` in the terminal logs. | `frontend/src/pages/Studio/StudioPage.tsx` (the 2.5 s "polling fallback" effect) | Network tab on stage would have shown a request storm. Fix: dep on scalar `activeJobStatus`, read fresh snapshot from store inside tick. |
| 2 | `urlToAdsService.ownerFromReq` read `req.user.id`, but the auth middleware sets `._id` / `.userId`. | `services/urlToAdsService.js` | Every authenticated scan was persisted as anonymous. Owner check on GET returned 403 "You can't access that scan." Fix: `getUserId(req)` helper that accepts `_id || userId || id`. |
| 3 | `/api/v1/me/credits` was mounted without any auth middleware. Every logged-in caller got anonymous balance=0. | `routes/credits.js` | Demo user's credit chip would permanently read 0. Fix: `router.use(optionalAuth)`. |
| 4 | Signup bonus was only granted lazily on first `getBalance()`. If an investor inspected a brand-new user's ledger immediately, it looked empty. | `controllers/auth/authController.js` | Ledger-is-the-source-of-truth story broke on day 0. Fix: eager `creditsService.topUp({ reason: 'topup_signup_bonus' })` at signup. |

**Measured results (dev laptop):**
- Smoke: 9 passed · 1 skipped · 0 failed.
- Load (20 concurrent, 6 s, anonymous paths only): 4,487 rps aggregate,
  p50 2.7 ms, p95 12 ms, 0 errors.
- Load (with authed `/me/credits` in the mix): 2,469 rps aggregate,
  /me/credits at 1,242 rps p50=11 ms / p95=19 ms, 0 errors across
  14,828 requests.
- All 75 phase-5/6/7/8/9 unit tests green.
- Frontend TypeScript clean.

---

## 3. Cross-cutting concerns — things you should know

### 3.1 Identity resolution is inconsistent
Phases 1–6 use various shapes for "current user" — `req.user._id`,
`req.user.userId`, or `req.user.id`. The JWT middleware populates `_id`
and `userId` but NOT `id`. Any service that reads `req.user.id` is subtly
broken for signed-in users (Phase 9 caught one in `urlToAdsService`).
**Action item:** audit every `req.user.id` reference in the codebase
and switch to a helper. I have not yet done the full sweep.

### 3.2 Anonymous sessions have no client-visible session cookie round-trip
`getSessionId(req)` reads from `req.cookies.qumakSession`, `req.session.id`,
or `x-session-id`. On first scan we may mint a UUID internally and never
send it back in a Set-Cookie header or response body. That leaves
anonymous users unable to re-fetch their own scan. For the demo we
side-step this by always running as a signed-in user. **Action item:**
either set `qumakSession` as a cookie on first use or surface the id in
the response.

### 3.3 Duplicate StudioJob model
`model/schema/studioJob.js` and `model/schema/studioJob_v3.js` both call
`mongoose.model('StudioJob', …)`. Whichever loads last wins. We need to
delete one, carefully.

### 3.4 The worker uses `updateDailyStats` for BOTH analytics and metrics
Phase 8 piggy-backed `metrics.incJob()` onto `updateDailyStats`. This is
convenient but couples "daily rollup" to "realtime counter" — if daily
stat writing is ever turned off, metrics silently break. Worth splitting
into two explicit calls at some point.

### 3.5 Admin vs amer roles
`/admin/*` routes accept `amer` (visa officer) in addition to `admin` /
`superadmin`. `/admin/ops/*` is deliberately `admin|superadmin` only.
That distinction is **not** documented anywhere else; anyone adding new
admin endpoints needs to be told.

### 3.6 Free-trial accounting
The Phase 7 "first scan free" logic grants `topup_signup_bonus` equal to
the projected cost, then lets adSetService charge normally. The upside
is clean reconciliation. The downside is the ledger reason
`topup_signup_bonus` now means two things (real signup bonus + URL→Ads
free trial), distinguished only by `meta.trial === 'url_to_ads'`.
Reporting queries that care about signup bonuses must filter on meta.

---

## 4. Known open TODOs

| ID | Task | Priority |
|---|---|---|
| ident-sweep | Replace every `req.user.id` in services/controllers with a shared `getUserId(req)` helper | high |
| studiojob-dedup | Delete the stale `studioJob_v3.js` (or merge useful fields into canonical) | high |
| anon-session-cookie | On first scan, issue `Set-Cookie: qumakSession=…` so anon users can re-fetch | medium |
| preexisting-test-failures | 6 pre-existing failures in `adBrain`, `brandProjectController.buyCredits`, `searchLeads` tests — surviving from Phase 5/6 WIP. Decide: fix or delete. | medium |
| metric-job-coupling | Split `updateDailyStats` into "metric" + "rollup" | low |
| ledger-ambiguity | Distinguish `topup_signup_bonus` (real) from URL→Ads free trial in the reason enum | low |
| worker-version-sprawl | Multiple worker generations coexist (videoWorker / videoWorker_v3). Audit + consolidate. | low |

---

## 5. Test / deploy / demo checklist

```bash
# 1. Unit + integration
cd qumak-backend
npm test                             # full Jest
npx jest tests/urlToAdsService.test.js tests/reelService.test.js \
       tests/adSetService.test.js tests/urlToAd.test.js \
       tests/urlToAdsController.test.js --forceExit
# → 75 passed, 0 failed (Phase 5–9 surface)

# 2. End-to-end smoke against running dev server
npm run dev                          # terminal 1
npm run studio:worker                # terminal 2
npm run smoke                        # terminal 3 → expect "9 passed · 1 skipped · 0 failed"

# 3. Load
SMOKE_TOKEN=$(...) npm run loadtest  # expect p95 < 30 ms, 0 errors

# 4. Demo primer
npm run seed:demo                    # demo@qumak.io / Demo!2026

# 5. Frontend typecheck
cd ../qumak-frontend
npx tsc --noEmit                     # expect zero errors
```

See `DEMO_RUNBOOK.md` for the 5-minute stage script.

---

## 6. Questions I want a second pair of eyes on

1. **Credits ledger as finance record.** Is an append-only Mongo
   collection sufficient for our definition of "finance grade", or do
   we want an external double-entry ledger (PostgreSQL + partitioned
   events, or even a managed service like Moov) before we take real
   money at scale?
2. **Worker topology.** One BullMQ queue, one worker process, many job
   kinds. Is that still right as ad-set fan-out grows? Do we need a
   priority queue so a single "generate 3 ads for an investor demo"
   doesn't get stuck behind 40 async bulk jobs?
3. **Intent engine as a classifier vs an LLM call.** Today
   `intentEngine.js` is mostly heuristics. Would a tiny fine-tuned model
   (or a prompt to Claude Haiku) raise the accuracy enough to justify
   the cost and latency on the hot path?
4. **Admin Ops metrics surface.** We expose `/metrics` in Prometheus
   format but don't yet run Prometheus. Should we just commit to a
   Grafana Cloud free tier and scrape it, or is our in-product Ops
   dashboard (admin UI) sufficient until we hire an SRE?
5. **Poll vs push.** The Studio page still polls on a 2.5 s fallback
   even when the socket is healthy. That's defensive but wasteful.
   Can we turn it off when `socket.connected === true`?
6. **URL→Ads free-trial abuse.** One free generation per scan — but a
   motivated user can create unlimited scans. Rate-limit per session?
   Per email? Per IP? All of the above?
7. **Duplicate code in webhooks.** Stripe / Tabby / Tamara top-up
   handlers all look alike except for the outer payload parsing. Do we
   refactor into one `processTopUp(owner, amount, source, externalId)`
   or is the current explicit-per-provider form clearer for auditors?

---

## 7. File index (quick reference)

**New in Phase 8:**
- `utils/logger.js`, `utils/metrics.js`
- `middelwares/requestContext.js`
- `controllers/admin/adminOpsController.js`
- `qumak-frontend/src/api/admin-ops-api.ts`
- `qumak-frontend/src/pages/BackOffice/AdminOpsPage.tsx`

**New in Phase 9:**
- `scripts/smoke-e2e.js`
- `scripts/load-test.js`
- `scripts/seed-demo.js`
- `DEMO_RUNBOOK.md`
- `PHASES_SUMMARY.md` (this file)

**Touched-and-fixed in Phase 9:**
- `qumak-frontend/src/pages/Studio/StudioPage.tsx` — polling dep fix
- `services/urlToAdsService.js` — user-id resolution
- `routes/credits.js` — optionalAuth
- `controllers/auth/authController.js` — eager signup bonus

**Phase 7 canonical files:**
- `model/schema/urlToAdsScan.js`
- `services/urlToAdsService.js`
- `controllers/studio/urlToAdsController.js`
- `qumak-frontend/src/pages/Studio/UrlToAdsPage.tsx`

**Credits:**
- `services/creditsService.js`
- `model/schema/creditLedger.js`
- `routes/credits.js`

**Observability touchpoints:**
- `utils/logger.js`, `utils/metrics.js`
- `middelwares/requestContext.js`
- `index.js` (wires both + exposes `/metrics`)

---

*End of summary. Reply with "looks good" or a markup of what you'd change.*
