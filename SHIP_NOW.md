# Qumak Backend — Ship State

> **Status:** This file replaces an older 1,000-line "ship in 1 hour" prompt
> that described a `qumak-studio/` folder that never existed and pinned
> `@fal-ai/serverless-client` (wrong package — the real one is
> `@fal-ai/client`, see `package.json`). Treat that older content as deleted.
>
> The real backend lives in **this** folder (`qumak-backend/`). Use this file
> as the source of truth for what is actually wired up today and what still
> needs to ship.

---

## 1. What Qumak is (one line)

Qumak is the **Arabic-first AI ad agency for GCC SMEs**: paste an Instagram
handle → get Arabic + English ads in 60 seconds → publish to Meta / Snap /
TikTok MENA → deliver previews on WhatsApp.

Everything else (marketplace, business buying, suppliers, trade license,
storefront builder, visa, customs, Hapag-Lloyd) is parked behind feature flags
or descoped from the seed-stage scope. Don't build new flows in those areas
without an explicit pivot decision.

---

## 2. Repo layout (real, not aspirational)

```
qumak-backend/
├── index.js                       # Express bootstrap, route mounting
├── routes/                        # Top-level Express routes
│   ├── brandProject.js            # Brand projects + Stripe credits
│   ├── templates.js               # GenerationTemplate intelligence layer
│   ├── aiBrand.js, images.js, facebook.js, tradeLicense.js, chat.js
├── controllers/
│   ├── studio/                    # AI Studio (image + video gen)
│   │   ├── _routes.js             # /api/v1/studio/*
│   │   ├── _extRoutes.js          # /api/v1/studio/* extended
│   │   ├── studioController.js
│   │   ├── extController.js
│   │   ├── brandProfileController.js
│   │   └── adminController.js
│   ├── marketplace/               # Marketplace listings, deposits, etc.
│   ├── store/, blog/, popupLeads/, jobs/, leads/, brandProject/, auth/
├── services/
│   ├── falService.js              # fal.ai (image + video)
│   ├── apolloClient.js            # Single Apollo.io client (don't fork)
│   ├── leadResearchService.js     # Lead research via Apollo
│   ├── outreachService.js         # Cold outreach (uses apolloClient)
│   ├── processingService.js       # FFmpeg / Sharp / R2 upload
│   ├── storageService.js          # Cloudflare R2 (S3 SDK v3)
│   ├── brandProjectMigration.js   # Embedded → sibling collection migrations
│   └── imagePromptPurifier.js
├── workers/
│   └── videoWorker.js             # BullMQ worker (dispatches video AND image jobs)
├── model/schema/                  # Mongoose schemas
│   ├── studioJob.js               # `kind: 'image' | 'video'`
│   ├── brandProject.js            # GOD SCHEMA — being decomposed (see §6)
│   ├── brandLead.js, brandContentItem.js, brandAgentMemory.js,
│   ├── brandAgentInsight.js, brandSupplier.js, brandTradeLicense.js
│   └── brandProfile.js, generationTemplate.js, ...
├── middelwares/                   # (yes, the typo is load-bearing)
│   └── auth.js                    # JWT auth + requireRole
└── utills/                        # (typo also load-bearing)
    └── whatsAppMessage.js         # Twilio (no-op if creds missing)
```

---

## 3. Tech stack (actual, from package.json)

- Node.js + Express (CommonJS)
- MongoDB via Mongoose
- Redis (Upstash) + **BullMQ** for the generation queue
- **`@fal-ai/client` ^1.9.5** for fal.ai (NOT `@fal-ai/serverless-client`)
- **Sharp** + **FFmpeg** (`child_process`) for media post-processing
- **`@aws-sdk/client-s3`** pointed at Cloudflare R2
- **Zod** for input validation on every studio route
- **Stripe** for credits (Checkout Session + webhook)
- **Twilio** for WhatsApp (lazy-init; no-ops in dev when creds missing)
- **Socket.io** for live job updates (`server.js` / chat WS)

---

## 4. Critical env vars

| Var | Purpose | Notes |
|---|---|---|
| `JWT_SECRET` | Signs auth tokens | **Process exits in production if missing** |
| `SESSION_SECRET` | express-session | Falls back to JWT_SECRET; exits in prod if both missing |
| `MONGO_URI` | Mongo connection | Required |
| `REDIS_URL` | BullMQ + cache | Required |
| `FAL_API_KEY` | fal.ai | Required for any generation |
| `R2_*` (endpoint, key, secret, bucket, public URL) | Cloudflare R2 | Storage |
| `STRIPE_SECRET_KEY` | Stripe | Lazy-loaded; credit endpoints 503 without it |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature | Required for `/api/v1/brand-projects/credits/webhook` |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | Checkout return URLs | Default to localhost |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | WhatsApp | Without these, sends are no-ops with a warning |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Copy + prompt refinement | Required for the agent layer |
| `APOLLO_API_KEY` (or `QUMAK_APOLO_LEADS_API_KEY`) | Lead research | Used by `apolloClient.js` |
| `APOLLO_BASE_URL` | Override for Apollo base | Defaults to `https://api.apollo.io/api/v1` |

---

## 5. The one demo flow that must always work

1. `POST /api/v1/studio/generate/image` (or `/generate/video`) with body validated by Zod
2. Atomic credit check + StudioJob created with `kind: 'image' \| 'video'`
3. Job enqueued on BullMQ (`generate-image` or `generate`)
4. `workers/videoWorker.js` dispatches by job name → `processImageJob` or `processVideoJob`
5. fal.ai call → R2 upload → optional FFmpeg watermark/grade
6. Status pushed via Socket.io; client polls `GET /api/v1/studio/job/:id`
7. Final asset returned with `imageUrl` OR `videoUrl` based on `job.kind`

If any of those 7 steps regress, the product is dead.

---

## 6. Known liabilities (track these, don't pretend they're fixed)

- **`brandProject.js` is still a god schema.** Six sibling collections now
  exist (`BrandLead`, `BrandContentItem`, `BrandAgentMemory`,
  `BrandAgentInsight`, `BrandSupplier`, `BrandTradeLicense`). The legacy
  embedded arrays are capped via a `pre('save')` hook so we won't hit the
  16 MB limit, but controllers still write to the embedded copies. Use
  `services/brandProjectMigration.js` to backfill. Migrate writes
  controller-by-controller; do not big-bang it.
- **No worker WebSocket bridge.** `videoWorker.js` updates Mongo but doesn't
  push to the Socket.io server. Frontend currently polls. Bridge Redis
  pub/sub → Socket.io before claiming "real-time progress".
- **Idempotency is partial.** Stripe webhook handler is idempotent. Studio
  generation endpoints are not — a double-click can still create two jobs.
  Add an `idempotencyKey` (header → unique index on StudioJob) before scaling
  paid traffic.
- **Retries.** `videoWorker.js` only marks `failed` on the last BullMQ
  attempt, but BullMQ `attempts` / `backoff` config is still default. Set
  `attempts: 3, backoff: { type: 'exponential', delay: 5000 }` on enqueue.
- **GenerationTemplate seed.** Templates are mounted at `/api/v1/templates`
  but `i18nPrompts.ar` is largely null. That's the moat — fill it.
- **Apollo.** Both lead services now go through `services/apolloClient.js`.
  Don't reintroduce a second base URL or env-var lookup.

---

## 7. What to build next (in order)

1. Arabic `promptBlueprint` + `i18nPrompts.ar` for the 10 highest-traffic templates.
2. WhatsApp delivery of finished assets (already have the Twilio shim).
3. Snap Ads + Meta Ads MENA one-click publish from a finished StudioAsset.
4. AED billing tiers (99 / 199 / 399) via Stripe + Tabby/Tamara.
5. Idempotency keys on `/studio/generate/*`.
6. The 60-second demo flow: paste IG handle → 10 ads → WhatsApp send.

Stop adding surface area until those six are real.
