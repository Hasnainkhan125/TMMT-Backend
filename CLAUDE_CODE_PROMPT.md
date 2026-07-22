## Paste this entire file. Do exactly what it says. No extras.

---

## WHAT THIS IS

You are implementing the Qumak AI Studio backend — a product ad image generation service.

The code files are already written and attached to this project (SHIP_NOW_V2/ directory).
Your job is:
1. Install dependencies
2. Fix any import/syntax issues
3. Verify all files are present
4. Create .env from .env.example (ask me for the credentials)
5. Run the test suite to confirm everything works

---

## SETUP COMMANDS (run in order)

```bash
cd qumak-studio
npm install
cp .env.example .env
```

Then ask the user: "Please provide values for the following .env variables:
- MONGODB_URI
- REDIS_URL
- CLOUDFLARE_ACCOUNT_ID
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
- R2_BUCKET_NAME
- R2_PUBLIC_URL
- FAL_API_KEY"

After they provide credentials, populate .env and continue.

---

## VERIFY FILE STRUCTURE

Confirm these files exist:
```
src/index.js
src/db.js
src/redis.js
src/r2.js
src/queue.js
src/promptBuilder.js
src/middleware/session.js
src/middleware/validate.js
src/models/StudioJob.js
src/models/StudioAsset.js
src/workers/imageWorker.js
src/routes/studio.js
test.js
package.json
.env
```

---

## KNOWN ISSUES TO FIX BEFORE RUNNING

### Fix 1: fal.ai SDK verification
Open src/workers/imageWorker.js and confirm line 1 of imports has:
```js
const { fal } = require('@fal-ai/client');
```
NOT `@fal-ai/client`. If wrong, fix it.

### Fix 2: Check fal.subscribe result shape
The fal.subscribe() result shape varies by model. After the fal.subscribe() call in imageWorker.js, the result extraction is:
```js
const rawImageUrl = falResult.images?.[0]?.url || falResult.data?.images?.[0]?.url;
```
This handles both result shapes. Do not change this.

### Fix 3: multer dependency
package.json includes multer. Confirm it installed:
```bash
ls node_modules/multer
```
If missing: `npm install multer`

---

## HOW TO RUN

Terminal 1 (server):
```bash
node src/index.js
```

Terminal 2 (worker — must run separately):
```bash
node src/workers/imageWorker.js
```

Terminal 3 (tests — after both are running):
```bash
node test.js
```

---

## WHAT SUCCESS LOOKS LIKE

test.js output:
```
Test 1: Health check
  ✓ PASS status=ok, mongo=connected, redis=connected

Test 2: Validation rejects empty body
  ✓ PASS Returns 400 with field-level errors

Test 3: Validation rejects missing brandName
  ✓ PASS Returns 400 with brandName error

Test 4: Usage endpoint creates session
  ✓ PASS Session created. Remaining: 3/3

Test 5: Generation flow (queued → completed via polling)
  ✓ PASS Job completed. Image URL: https://pub-xxx.r2.dev/hd/.../clean.jpg

Test 6: Credit limit
  ✓ PASS 402 credit_limit_reached

Test 7: Idempotency
  ✓ PASS Same jobId returned

Results: 7 passed, 0 failed
✓ All tests passed. Phase 1 complete.
```

---

## DO NOT BUILD

Do not add anything beyond what is in the files:
- No copy generation
- No share links
- No admin dashboard
- No payments
- No video generation
- No Arabic TTS

Phase 1 = images work. Everything else is Phase 2.

---

## COMMON ERRORS

**Error: Cannot find module '@fal-ai/client'**
→ `npm install @fal-ai/client`

**Error: Redis connection refused**
→ REDIS_URL in .env is wrong. Use the rediss:// URL from Upstash, not the REST URL.

**Worker: "Transition failed: job ... expected status 'queued' but found 'processing'"**
→ Normal on restart if job was mid-processing. Create a new generation request.

**fal.ai 401**
→ FAL_API_KEY format should be `key_id:key_secret`. Check fal.ai dashboard.

**R2 upload: InvalidAccessKeyId**
→ R2_ACCESS_KEY_ID is wrong. Regenerate tokens in Cloudflare R2 → Manage API Tokens.

**WebSocket events not reaching frontend**
→ Both server and worker must be running. The Redis adapter bridges them.
→ In dev, you can also test via polling endpoint: GET /api/v1/studio/job/:id/status

**Test 5 times out (job never completes)**
→ Worker is not running. Open second terminal: `node src/workers/imageWorker.js`
→ OR fal.ai has no credits — check your fal.ai dashboard balance.
