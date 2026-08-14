# Qumak Studio — End-to-end test scenarios

These are the canonical scenarios we'll run against staging once Redis,
Mongo, and the fal/Seedance worker are live. Each scenario describes the
intent, the inputs the user gives, the expected backend dispatch, the
expected media output, and the assertions we verify.

## 0 · Test data prerequisites

Before running, ensure the database is seeded:

```bash
# 1. AI model registry — populates the ModelSelector.
node qumak-backend/scripts/seedAiModels.js

# 2. Generation templates — converts the manifest to ~313 documents.
node qumak-backend/scripts/ingestManifestToTemplates.js
```

Check counts:

```bash
mongosh qumak --eval 'db.aimodels.countDocuments()'        # ≥ 9
mongosh qumak --eval 'db.generationtemplates.countDocuments()' # ≈ 313
```

Anonymous demo accounts get 60 free credits via `creditsService.topUp`
on first session — enough for ~12 image generations or ~3 short videos.

---

## 1 · Real-Estate static ad (image, 3 variants)

**User flow:**
1. Land on `/studio/create`.
2. Click the **Real Estate** chip in the industry row.
3. Industry preset auto-fills:
   - `outputKind = "video"` → user toggles back to **IMAGE**
   - `constraints = { cameraAngle: 'tracking', lighting: 'golden_hour', motion: 'gimbal', shotType: 'wide', pace: 'slow' }`
   - Starter prompt: *"A luxury 3-bedroom apartment in {city}…"*
4. User edits `{city}` → "Dubai Marina".
5. Selects **Qumak Flux Pro** in ModelSelector.
6. Sets variants to 3.
7. Clicks **Generate**.

**Expected backend dispatch:**
- `POST /api/v1/studio/generate/image` payload contains:
  - `category: "realestate"`
  - `modelId: "flux_pro"`
  - `variants: 3`
  - `constraints: { cameraAngle, lighting, shotType, pace }` (motion stripped server-side for static)
- `studioController.enqueueGeneration` calls:
  - `creditsService.quote({ modelId: 'flux_pro', kind: 'image', variants: 3 })` → 12 credits
  - `creditsService.chargeForJob(...)`  — charge 12 credits, returns `ledgerEntryId`
  - `enqueueStudioJob({ kind: 'image', ... })` × 3
- Worker picks each variant, calls `falService.runFlux(falModelId, prompt)`, uploads to R2, sets `studioJob.status = 'completed'`.

**Expected output:**
- Three Studio assets in the workspace gallery, all 1024×1280 (or chosen aspect).
- Credit ledger has `delta: -12`, then `delta: 0` (no refund) once all three succeed.
- `User.platformCredits` decremented by 12.

**Assertions:**
- `GET /api/v1/me/credits` returns `balance` minus 12.
- `studioJobs.find({ parentJobId: <root> })` returns 3 sibling jobs.
- All three job documents have `templateId: null`, `modelId: "flux_pro"`, `falModelId: "fal-ai/flux-pro"`.

---

## 2 · 5-second Seedance scene (video, single variant)

**User flow:**
1. From `/studio/create`, click **Real Estate** chip.
2. Switch to the **VIDEO** mode toggle in the BottomInputBar.
3. Pick **Qumak Soul (Seedance 2.0)** from ModelSelector.
4. Open the `?tool=scene&kind=video` link from the sidebar (not yet rendered, but the route param is honoured).
5. Apply the **Luxury walkthrough — 15s** scene recipe → storyboard auto-fills with 4 scenes.
6. Edit scene 3's prompt to include "infinity pool".
7. Click **Render reel**.

**Expected backend dispatch (per-scene):**
- 4 sibling `POST /api/v1/studio/generate/video` requests, each with:
  - `modelId: "seedance_2.0"`
  - `duration: <scene.durationSec>`
  - `aspectRatio: "9:16"`
  - `prompt: <scene.prompt>` (each scene's text)
  - `referenceImageUrl: <firstFrameUrl>` if set
- Cost per scene: `4 credits/sec * sceneSec` → 16 + 12 + 16 + 16 = 60 credits total.
- Single ledger entry `delta: -60` with `meta.scenes: 4`.

**Expected output:**
- 4 mp4 clips in R2; the front-end stitches them into a single preview (or keeps them as a reel for v1).
- `studioJobs.find({ parentJobId: <root> })` returns 4 children with sequential `variantIndex`.

**Assertions:**
- BullMQ `video-generation` queue had 4 jobs.
- All 4 completed within 4 retries.
- Worker called `creditsService.refundForJob` if any individual scene failed on the final attempt.

---

## 3 · Image upscale (single asset → 4K)

**User flow:**
1. From `/studio/history`, hover any completed image.
2. Click **Upscale** action → routes to `/studio/create?tool=upscale&assetId=<id>`.
3. ModelSelector pre-selects **Qumak Upscale** (kind=image, requiresReferenceImage=true).
4. Click **Generate** with the asset URL pre-filled as `referenceImageUrl`.

**Expected backend dispatch:**
- `POST /api/v1/studio/generate/image` with:
  - `modelId: "qumak_upscale"`
  - `referenceImageUrl: <r2Url>`
  - `variants: 1`
- `creditsService.quote` returns 2 credits (upscale tariff).
- `modelRouter.route` resolves to `fal-ai/clarity-upscaler` and constructs the provider payload with the source image URL.

**Expected output:**
- One new Studio asset, 4× resolution of the source.
- The original asset is untouched; the upscale is stored as a child asset with `parentAssetId: <source>`.

**Assertions:**
- `studioAsset.find({ _id: <new> }).meta.upscaledFrom === <source>`.
- Credit ledger `-2`.

---

## 4 · Insufficient-credits guard

**User flow:**
1. Anonymous user runs out of credits (balance < quote).
2. Tries to generate.

**Expected behaviour:**
- Backend returns `400 { error: "insufficient_credits", needed, balance, modelId }`.
- Frontend toast surfaces the message and opens the **Pricing** modal.
- No job is created; no credits are deducted.

---

## 5 · Job cancellation refund

**User flow:**
1. Start a 10-second Kling 3.0 generation (80 credits).
2. While `status: 'processing'`, click **Cancel**.

**Expected behaviour:**
- `POST /api/v1/studio/jobs/:id/cancel` removes the BullMQ job and calls `creditsService.refundForJob`.
- Ledger gains `delta: +80, reason: 'refund_cancel'`.
- `User.platformCredits` returns to pre-charge balance.

---

## 6 · Source neutralisation

After re-running `ingestManifestToTemplates.js`, hit the templates API:

```bash
curl http://localhost:3000/api/v1/templates?limit=5 | jq '.items[].name'
```

**None** of the returned names should contain "Higgsfield", "Creatify", or any
upstream brand. They should read as Qumak templates ("Cinematic seedance 2.0",
"Luxury walkthrough", etc.). The `meta.originSource` field (kept for re-ingest
provenance) must be **stripped** from the public detail endpoint —
`GET /api/v1/templates/:id` must not include `meta`.

```bash
curl http://localhost:3000/api/v1/templates/<id> | jq 'has("meta") | not'
# → true
```
