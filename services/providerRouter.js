'use strict';

/**
 * providerRouter.js
 *
 * The single entry point for ALL image/video generation across providers.
 * Wraps fal.ai, OpenAI (gpt-image-1 / gpt-image-1.5), and Google Gemini
 * (Nano Banana) behind one interface.
 *
 * Why this exists:
 *   - falService.js is fal-only. Your frontend lists OpenAI/Gemini models
 *     via AiModel registry but every call goes to fal. That's a bug.
 *   - Per-provider payload shapes are wildly different. OpenAI wants
 *     multipart for edits. Gemini wants inline base64. fal wants URLs.
 *   - Each provider has its own auth env var, its own retry semantics,
 *     its own error codes. A single catch-all confuses all three.
 *
 * Pattern:
 *   route() → provider adapter → normalized result shape
 *
 * Public shape returned by every adapter:
 *   {
 *     imageUrl?: string,        // for image generation
 *     videoUrl?: string,        // for video generation
 *     thumbnailUrl?: string,
 *     seed?: string | number,
 *     requestId: string,
 *     provider: 'fal' | 'openai' | 'gemini',
 *     generationTimeMs: number,
 *     estimatedCostUsd: number,
 *     raw: object,              // provider's unedited response for debugging
 *   }
 */

const falService = require('./falService');
const { validateReferenceUrl } = require('./referenceUrlGate');

const DEBUG = process.env.STUDIO_DEBUG === 'true';
const dlog = (...a) => { if (DEBUG) console.log('[providerRouter]', ...a); };

// ─── Provider registry ────────────────────────────────────────────────────
// Each AiModel doc in MongoDB has a `provider` field. We route on that.
// Adding a new provider = adding a new entry here + an adapter function.

class ProviderError extends Error {
  constructor(message, code, provider, isRetryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.isRetryable = isRetryable;
  }
}

// ─── OpenAI gpt-image-1 / gpt-image-1.5 adapter ───────────────────────────
// Docs: https://platform.openai.com/docs/api-reference/images
// Endpoints:
//   POST /v1/images/generations  — text→image
//   POST /v1/images/edits        — image→image (multipart form)
//   POST /v1/images/variations   — variations of existing image
//
// gpt-image-1 accepts: prompt, model, n, size ("1024x1024"|"1024x1536"|
//   "1536x1024"), quality ("low"|"medium"|"high"), output_format, background,
//   moderation ("auto"|"low")
//
// PRICING (Apr 2026):
//   low 1024x1024:   $0.011
//   med 1024x1024:   $0.042
//   high 1024x1024:  $0.167
//   Portrait/landscape: ~1.5x

const MAX_REFERENCE_IMAGES = 10;   // hard cap — protects cost
const MAX_REFERENCE_BYTES  = 20 * 1024 * 1024; // 20 MB per image


/**
 * enhanceImage — multi-reference image edit, provider-routed.
 *
 * @param {object} args
 * @param {string[]} args.images            Array of reference image URLs (1-10)
 * @param {object}   args.model             AiModel doc from MongoDB
 * @param {string}   [args.prompt]          Edit instruction (default: enhance)
 * @param {string}   [args.aspectRatio]     '1:1' | '4:5' | '16:9' | etc.
 * @param {string}   [args.quality]         'low' | 'medium' | 'high' | 'auto'
 * @param {string}   [args.mode]            'standard' | 'high' (cost ceiling)
 * @param {string}   [args.userId]          For storage key partitioning
 * @returns {Promise<object>}                Normalized result shape
 */
async function enhanceImage(args) {
  const {
    images,
    model,
    prompt = 'Enhance and refine this image. Improve lighting, sharpness, color balance, and overall quality while preserving the original subject and composition.',
    aspectRatio,
    quality,
    mode = 'standard',
    userId = 'anon',
  } = args;

  // ── Input validation ──────────────────────────────────────────────────
  if (!Array.isArray(images) || images.length === 0) {
    throw new ProviderError('images must be a non-empty array', 'NO_IMAGES', 'router', false);
  }
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new ProviderError(
      `Too many reference images (${images.length}). Max is ${MAX_REFERENCE_IMAGES}.`,
      'TOO_MANY_IMAGES', 'router', false
    );
  }
  if (!model) {
    throw new ProviderError('model (AiModel doc) required', 'NO_MODEL', 'router', false);
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new ProviderError('prompt must be a non-empty string', 'NO_PROMPT', 'router', false);
  }

  // ── SSRF gate every reference URL before it leaves our process ────────
  const validatedUrls = [];
  for (const url of images) {
    const v = await validateReferenceUrl(url);
    if (!v.ok) {
      throw new ProviderError(
        `Reference image rejected: ${v.reason} (${url})`,
        'REF_URL_BLOCKED', 'router', false
      );
    }
    validatedUrls.push(v.url);
  }

  const provider = (model.provider || 'fal').toLowerCase();
  dlog('enhanceImage routing to', provider, '/', model.id, 'refs=', validatedUrls.length);

  // Cost ceiling — `mode: 'high'` lets caller opt into high-quality pricing.
  // Default 'standard' clamps to medium to protect spend.
  const effectiveQuality = quality
    || (mode === 'high' ? 'high' : 'medium');

  switch (provider) {
    case 'openai':
      return openaiEnhance({
        providerModelId: model.providerModelId || 'gpt-image-2',
        modelId: model.id,
        prompt,
        referenceImageUrls: validatedUrls,
        aspectRatio,
        quality: effectiveQuality,
        userId,
      });

    case 'fal':
      return falEnhance({
        falModelId: model.falModelId || 'openai/gpt-image-2/edit',
        modelId: model.id,
        prompt,
        referenceImageUrls: validatedUrls,
        aspectRatio,
        quality: effectiveQuality,
      });

    case 'gemini':
    case 'google':
      return geminiEnhance({
        providerModelId: model.providerModelId || 'gemini-2.5-flash-image',
        modelId: model.id,
        prompt,
        referenceImageUrls: validatedUrls,
      });

    default:
      throw new ProviderError(`enhanceImage: unknown provider ${provider}`, 'UNKNOWN_PROVIDER', 'router', false);
  }
}




// ─── OpenAI gpt-image-2 multi-image edit ──────────────────────────────────
// Uses the official `openai` SDK rather than raw fetch — the SDK already
// handles multipart File construction correctly, including streaming each
// reference image without holding the whole array in form memory twice.
//
// Per OpenAI docs (gpt-image-2 launched 2026-04-21): pass `image` as an
// array of File-like objects. Output is base64 — we upload to R2.

async function openaiEnhance({
  providerModelId, modelId, prompt,
  referenceImageUrls, aspectRatio, quality, userId,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderError('OPENAI_API_KEY not set', 'OPENAI_AUTH_MISSING', 'openai', false);
  }

  // Lazy-require so the SDK isn't loaded unless this path runs.
  const OpenAI = require('openai').default || require('openai');
  const { toFile } = require('openai');
  const client = new OpenAI({ apiKey });

  const model = providerModelId || 'gpt-image-2';
  const size  = OPENAI_IMAGE_SIZES[aspectRatio] || 'auto'; // gpt-image-2 supports 'auto'
  const t0    = Date.now();

  // Fetch all reference images in parallel, wrap each as a File for the SDK.
  // toFile() takes a stream/Buffer/Blob and a filename — the SDK handles
  // multipart construction. We pass Buffers because we already have the
  // bytes in memory after fetch().
  const fileBlobs = await Promise.all(
    referenceImageUrls.map(async (url, i) => {
      const r = await fetch(url);
      if (!r.ok) {
        throw new ProviderError(
          `Could not fetch reference image ${i} (${r.status})`,
          'OPENAI_REF_FETCH', 'openai', true
        );
      }
      const contentLength = Number(r.headers.get('content-length') || 0);
      if (contentLength && contentLength > MAX_REFERENCE_BYTES) {
        throw new ProviderError(
          `Reference image ${i} too large (${contentLength} bytes)`,
          'OPENAI_REF_TOO_LARGE', 'openai', false
        );
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > MAX_REFERENCE_BYTES) {
        throw new ProviderError(
          `Reference image ${i} too large (${buf.byteLength} bytes)`,
          'OPENAI_REF_TOO_LARGE', 'openai', false
        );
      }
      const mime = r.headers.get('content-type') || 'image/png';
      const ext  = mime.split('/')[1]?.split(';')[0] || 'png';
      return toFile(buf, `ref-${i}.${ext}`, { type: mime });
    })
  );

  let response;
  try {
    // SDK call — multi-image edit. `image` accepts an array for gpt-image-2.
    // Note: gpt-image-2 doesn't support `input_fidelity` (always high) and
    // doesn't support transparent backgrounds — don't pass either.
    const reqBody = {
      model,
      image: fileBlobs,
      prompt,
      n: 1,
    };
    if (size && size !== 'auto') reqBody.size = size;
    if (quality && quality !== 'auto') reqBody.quality = quality;

    response = await client.images.edit(reqBody);
  } catch (err) {
    // Map SDK errors to ProviderError so the worker's retry logic works.
    const status = err?.status || err?.response?.status;
    const code =
      status === 401 ? 'OPENAI_AUTH_REJECTED'
      : status === 429 ? 'OPENAI_RATE_LIMITED'
      : status === 400 ? 'OPENAI_SCHEMA'
      : 'OPENAI_API_ERROR';
    const retryable = status === 429 || (status >= 500 && status < 600);
    throw new ProviderError(
      `OpenAI edit failed (${status || '?'}): ${err?.message || 'unknown'}`,
      code, 'openai', retryable
    );
  }

  // gpt-image-2 always returns b64_json for edits. Upload to R2.
  const first = response?.data?.[0];
  const b64   = first?.b64_json;
  if (!b64) {
    throw new ProviderError('OpenAI returned no image bytes', 'OPENAI_NO_IMAGE', 'openai', false);
  }

  const { uploadBufferToR2 } = require('./storageService');
  const outBuf = Buffer.from(b64, 'base64');
  const r2Key  = `studio-enhance/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const r2Url  = await uploadBufferToR2({
    buffer: outBuf,
    key: r2Key,
    contentType: 'image/png',
  });
  if (!r2Url) {
    throw new ProviderError('Failed to store edited image to R2', 'OPENAI_STORAGE', 'openai', true);
  }

  // Cost: gpt-image-2 is token-priced, but for rough accounting we use a
  // per-image estimate. Refine once you have a week of real usage logged.
  const costPerImage = {
    low: 0.02, medium: 0.07, high: 0.21, auto: 0.07,
  }[quality || 'medium'] || 0.07;
  // Edits with multiple references cost more (each ref = input tokens).
  const refMultiplier = 1 + (referenceImageUrls.length - 1) * 0.4;

  return {
    imageUrl: r2Url,
    seed: null,
    requestId: response?._request_id || `openai-enhance-${t0}`,
    provider: 'openai',
    generationTimeMs: Date.now() - t0,
    estimatedCostUsd: Number((costPerImage * refMultiplier).toFixed(4)),
    raw: { model, usage: response?.usage, size, quality, references: referenceImageUrls.length },
  };
}

// ─── fal.ai openai/gpt-image-2/edit endpoint ──────────────────────────────
// fal exposes the same model as a queue endpoint that accepts image_urls
// directly — no multipart, no fetch-and-rewrap. Cheaper to wire if your
// references are already on R2 (public URLs).

async function falEnhance({
  falModelId, modelId, prompt, referenceImageUrls, aspectRatio, quality,
}) {
  const t0 = Date.now();
  const input = {
    prompt,
    image_urls: referenceImageUrls,
    image_size: aspectRatio ? mapAspectToFalSize(aspectRatio) : 'auto',
  };
  if (quality && quality !== 'auto') input.quality = quality;

  let result;
  try {
    // falService.generateImage already handles polling, retries, payload
    // sanitization, and R2 mirroring. We just hand it the input.
    result = await falService.generateImage({
      falModelId: falModelId || 'openai/gpt-image-2/edit',
      input,
      modelId,
    });
  } catch (err) {
    const retryable = /timeout|rate|5\d\d/i.test(err?.message || '');
    throw new ProviderError(
      `fal edit failed: ${err?.message || 'unknown'}`,
      'FAL_EDIT_ERROR', 'fal', retryable
    );
  }

  if (!result?.imageUrl) {
    throw new ProviderError('fal returned no imageUrl', 'FAL_NO_IMAGE', 'fal', false);
  }

  return {
    imageUrl: result.imageUrl,
    seed: result.seed || null,
    requestId: result.requestId,
    provider: 'fal',
    generationTimeMs: Date.now() - t0,
    estimatedCostUsd: result.estimatedCost || 0.07,
    raw: result,
  };
}

// ─── Gemini multi-image edit (Nano Banana) ────────────────────────────────
// Gemini accepts multiple inline_data parts in a single request — stack all
// references as base64 parts, prompt last (or first, order doesn't matter
// much for these models).

async function geminiEnhance({ providerModelId, modelId, prompt, referenceImageUrls }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new ProviderError('GEMINI_API_KEY not set', 'GEMINI_AUTH_MISSING', 'gemini', false);
  }

  const model = providerModelId || 'gemini-2.5-flash-image';
  const t0    = Date.now();
  const parts = [{ text: prompt }];

  for (let i = 0; i < referenceImageUrls.length; i++) {
    const url  = referenceImageUrls[i];
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new ProviderError(
        `Could not fetch reference image ${i}`, 'GEMINI_REF_FETCH', 'gemini', true
      );
    }
    const buf  = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_REFERENCE_BYTES) {
      throw new ProviderError(
        `Reference image ${i} too large`, 'GEMINI_REF_TOO_LARGE', 'gemini', false
      );
    }
    const mime = resp.headers.get('content-type') || 'image/png';
    parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ProviderError(
      `Gemini edit failed (${response.status}): ${errText.slice(0, 200)}`,
      response.status === 429 ? 'GEMINI_RATE_LIMITED' : 'GEMINI_API_ERROR',
      'gemini', response.status === 429 || response.status >= 500
    );
  }

  const data     = await response.json();
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart  = outParts.find(p => p.inline_data?.data || p.inlineData?.data);
  if (!imgPart) {
    throw new ProviderError('Gemini returned no image', 'GEMINI_NO_IMAGE', 'gemini', false);
  }

  const b64  = imgPart.inline_data?.data     || imgPart.inlineData?.data;
  const mime = imgPart.inline_data?.mime_type || imgPart.inlineData?.mimeType || 'image/png';

  const { uploadBufferToR2 } = require('./storageService');
  const buf   = Buffer.from(b64, 'base64');
  const ext   = mime.split('/')[1]?.split(';')[0] || 'png';
  const r2Key = `studio-enhance-gemini/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const r2Url = await uploadBufferToR2({ buffer: buf, key: r2Key, contentType: mime });
  if (!r2Url) {
    throw new ProviderError('Failed to store Gemini output to R2', 'GEMINI_STORAGE', 'gemini', true);
  }

  return {
    imageUrl: r2Url,
    seed: null,
    requestId: response.headers.get('x-request-id') || `gemini-enhance-${t0}`,
    provider: 'gemini',
    generationTimeMs: Date.now() - t0,
    estimatedCostUsd: (GEMINI_COST[model]?.perImage || 0.05) * (1 + (referenceImageUrls.length - 1) * 0.3),
    raw: data,
  };
}

const OPENAI_IMAGE_SIZES = {
  '1:1':  '1024x1024',
  '3:4':  '1024x1536',
  '4:5':  '1024x1536',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
  '4:3':  '1536x1024',
};
const OPENAI_COST = {
  'gpt-image-1':       { low: 0.011, medium: 0.042, high: 0.167 },
  'gpt-image-1-mini':  { low: 0.005, medium: 0.009, high: 0.04  },
  'gpt-image-1.5':     { low: 0.009, medium: 0.035, high: 0.14  },
};

async function openaiImage({ modelId, providerModelId, prompt, aspectRatio, quality, referenceImageUrl, n = 1 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ProviderError('OPENAI_API_KEY not set', 'OPENAI_AUTH_MISSING', 'openai', false);

  const model = providerModelId || 'gpt-image-1';
  const size  = OPENAI_IMAGE_SIZES[aspectRatio] || '1024x1024';
  const q     = quality || 'medium';
  const t0    = Date.now();

  // Determine endpoint: edits vs generations
  const isEdit = !!referenceImageUrl;
  const endpoint = isEdit
    ? 'https://api.openai.com/v1/images/edits'
    : 'https://api.openai.com/v1/images/generations';

  let response;
  if (isEdit) {
    // Image edits require multipart/form-data with the reference as a file
    // blob. We fetch the pre-uploaded URL (which went through reference-
    // URL-gate at upload time) and stream its bytes into the form.
    const imgResp = await fetch(referenceImageUrl);
    if (!imgResp.ok) throw new ProviderError(`Could not fetch reference image (${imgResp.status})`, 'OPENAI_REF_FETCH', 'openai', true);
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', String(n));
    form.append('size', size);
    form.append('quality', q);
    form.append('image', new Blob([imgBuf], { type: 'image/png' }), 'image.png');

    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
    });
  } else {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, n, size, quality: q,
        output_format: 'webp',
      }),
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const code = response.status === 401 ? 'OPENAI_AUTH_REJECTED'
               : response.status === 429 ? 'OPENAI_RATE_LIMITED'
               : response.status === 400 ? 'OPENAI_SCHEMA'
               : 'OPENAI_API_ERROR';
    throw new ProviderError(
      `OpenAI rejected request (${response.status}): ${errText.slice(0, 200)}`,
      code, 'openai', response.status === 429 || response.status >= 500
    );
  }

  const data = await response.json();
  // OpenAI returns either { data: [{ url }] } or { data: [{ b64_json }] }
  // depending on output_format / account type. Handle both.
  const first = data?.data?.[0];
  let imageUrl;
  if (first?.url) {
    imageUrl = first.url;
  } else if (first?.b64_json) {
    const { uploadBufferToR2 } = require('./storageService');
    const buf = Buffer.from(first.b64_json, 'base64');
    const key = `studio-openai/${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const r2Url = await uploadBufferToR2({ buffer: buf, key, contentType: 'image/webp' });
    if (!r2Url) throw new ProviderError('Failed to store OpenAI output to R2', 'OPENAI_STORAGE', 'openai', true);
    imageUrl = r2Url;
  }
  if (!imageUrl) throw new ProviderError('OpenAI returned no image URL', 'OPENAI_NO_IMAGE', 'openai', false);

  return {
    imageUrl,
    seed: null,
    requestId: response.headers.get('x-request-id') || `openai-${t0}`,
    provider: 'openai',
    generationTimeMs: Date.now() - t0,
    estimatedCostUsd: (OPENAI_COST[model]?.[q] || 0.04) * n,
    raw: data,
  };
}

// ─── Google Gemini adapter (Nano Banana / 2.5 Flash Image / 3 Pro Image) ──
// Docs: https://ai.google.dev/gemini-api/docs/image-generation
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//
// Models:
//   gemini-2.5-flash-image            (Nano Banana 1)
//   gemini-3.1-flash-image-preview    (Nano Banana 2)
//   gemini-3-pro-image-preview        (Nano Banana Pro)
//
// Request shape:
//   {
//     contents: [{ parts: [{ text: "prompt" }, { inline_data: { mime_type, data (base64) } }] }]
//   }
// Response: { candidates: [{ content: { parts: [{ inline_data: { mime_type, data } }] } }] }
//
// Gemini's output is ALWAYS base64 inline — we need to upload to R2
// before returning a URL the rest of the pipeline can use.

const GEMINI_COST = {
  'gemini-2.5-flash-image':          { perImage: 0.039 },
  'gemini-3.1-flash-image-preview':  { perImage: 0.06  },
  'gemini-3-pro-image-preview':      { perImage: 0.134 },
};

async function geminiImage({ providerModelId, prompt, referenceImageUrl }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new ProviderError('GEMINI_API_KEY not set', 'GEMINI_AUTH_MISSING', 'gemini', false);

  const model = providerModelId || 'gemini-2.5-flash-image';
  const t0 = Date.now();
  const parts = [{ text: prompt }];

  // If there's a reference image, fetch and inline it as base64
  if (referenceImageUrl) {
    const imgResp = await fetch(referenceImageUrl);
    if (!imgResp.ok) throw new ProviderError(`Could not fetch reference image`, 'GEMINI_REF_FETCH', 'gemini', true);
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    const mimeType = imgResp.headers.get('content-type') || 'image/png';
    parts.push({ inline_data: { mime_type: mimeType, data: imgBuf.toString('base64') } });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      // Gemini doesn't accept size/quality on image models — it infers.
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ProviderError(
      `Gemini rejected request (${response.status}): ${errText.slice(0, 200)}`,
      response.status === 429 ? 'GEMINI_RATE_LIMITED' : 'GEMINI_API_ERROR',
      'gemini', response.status === 429 || response.status >= 500
    );
  }

  const data = await response.json();
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = outParts.find(p => p.inline_data?.data || p.inlineData?.data);
  if (!imagePart) throw new ProviderError('Gemini returned no image', 'GEMINI_NO_IMAGE', 'gemini', false);

  const b64 = imagePart.inline_data?.data || imagePart.inlineData?.data;
  const mime = imagePart.inline_data?.mime_type || imagePart.inlineData?.mimeType || 'image/png';

  const { uploadBufferToR2 } = require('./storageService');
  const imgBuf = Buffer.from(b64, 'base64');
  const imgExt = mime.split('/')[1]?.split(';')[0] || 'png';
  const r2Key = `studio-gemini/${Date.now()}-${Math.random().toString(36).slice(2)}.${imgExt}`;
  const r2Url = await uploadBufferToR2({ buffer: imgBuf, key: r2Key, contentType: mime });
  if (!r2Url) {
    throw new ProviderError('Failed to store Gemini output to R2', 'GEMINI_STORAGE', 'gemini', true);
  }

  return {
    imageUrl: r2Url,
    seed: null,
    requestId: response.headers.get('x-request-id') || `gemini-${t0}`,
    provider: 'gemini',
    generationTimeMs: Date.now() - t0,
    estimatedCostUsd: GEMINI_COST[model]?.perImage || 0.05,
    raw: data,
  };
}

// ─── fal.ai adapter (existing falService, wrapped) ────────────────────────
async function falImage({ falModelId, prompt, referenceImageUrl, aspectRatio, modelId }) {
  // Delegate to existing service — it already has payload sanitizer + retries
  const input = {
    prompt,
    image_size: mapAspectToFalSize(aspectRatio),
    ...(referenceImageUrl ? { image_url: referenceImageUrl } : {}),
  };
  const result = await falService.generateImage({ falModelId, input, modelId });
  return {
    imageUrl: result.imageUrl,
    seed: null,
    requestId: result.requestId,
    provider: 'fal',
    generationTimeMs: 0, // falService doesn't return this consistently for images
    estimatedCostUsd: result.estimatedCost,
    raw: result,
  };
}

async function falVideo(args) {
  const result = await falService.generateVideo(args);
  return {
    videoUrl: result.videoUrl,
    thumbnailUrl: result.thumbnailUrl,
    seed: result.seed,
    requestId: result.requestId,
    provider: 'fal',
    generationTimeMs: result.generationTimeMs,
    estimatedCostUsd: result.estimatedCost,
    raw: result,
  };
}

function mapAspectToFalSize(ar) {
  return {
    '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3',
    '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '4:3': 'landscape_4_3',
  }[ar] || 'square_hd';
}

// ─── Main router ──────────────────────────────────────────────────────────

/**
 * generate — the single function the worker calls.
 *
 * @param {object} args
 * @param {object} args.aiModel          AiModel doc from MongoDB
 * @param {string} args.kind             'image' | 'video'
 * @param {string} args.prompt
 * @param {string} [args.negativePrompt]
 * @param {string} [args.aspectRatio]
 * @param {number} [args.duration]       video only, seconds
 * @param {string} [args.quality]        'low' | 'medium' | 'high'
 * @param {number} [args.n]              how many images (some providers)
 * @param {string} [args.referenceImageUrl]
 * @param {string} [args.endFrameUrl]
 * @param {string} [args.tier]
 * @param {function} [args.onProgress]
 */
async function generate(args) {
  const {
    aiModel, kind = 'image', prompt, negativePrompt,
    aspectRatio, duration, quality, n = 1,
    referenceImageUrl, endFrameUrl, tier, onProgress,
  } = args;

  if (!aiModel) throw new ProviderError('aiModel required', 'NO_MODEL', 'router', false);
  if (!prompt) throw new ProviderError('prompt required', 'NO_PROMPT', 'router', false);

  // Validate ANY reference URL before it leaves our process. This stops
  // SSRF, data: URIs, and private IPs reaching the provider.
  let validatedRef = null;
  if (referenceImageUrl) {
    validatedRef = await validateReferenceUrl(referenceImageUrl);
    if (!validatedRef.ok) {
      throw new ProviderError(
        `Reference image rejected: ${validatedRef.reason}`,
        'REF_URL_BLOCKED', 'router', false
      );
    }
  }
  let validatedEnd = null;
  if (endFrameUrl) {
    validatedEnd = await validateReferenceUrl(endFrameUrl);
    if (!validatedEnd.ok) {
      throw new ProviderError(
        `End frame rejected: ${validatedEnd.reason}`,
        'REF_URL_BLOCKED', 'router', false
      );
    }
  }

  

  const provider = (aiModel.provider || 'fal').toLowerCase();
  dlog('routing to', provider, '/', aiModel.id, 'kind=', kind);

  switch (provider) {
    case 'fal':
      if (kind === 'video') {
        return falVideo({
          prompt, negativePrompt,
          aspectRatio, duration, tier,
          falModelId: aiModel.falVideoModelId || aiModel.falModelId,
          referenceImageUrl: validatedRef?.url,
          endFrameUrl: validatedEnd?.url,
          onProgress,
        });
      }
      return falImage({
        falModelId: aiModel.falModelId,
        prompt,
        referenceImageUrl: validatedRef?.url,
        aspectRatio,
        modelId: aiModel.id,
      });

    case 'openai':
      if (kind === 'video') {
        // OpenAI video (Sora) is separate — add its own adapter when needed.
        throw new ProviderError('OpenAI video not yet implemented', 'NOT_IMPLEMENTED', 'openai', false);
      }
      return openaiImage({
        modelId: aiModel.id,
        providerModelId: aiModel.providerModelId || 'gpt-image-1',
        prompt,
        aspectRatio,
        quality: quality || 'medium',
        referenceImageUrl: validatedRef?.url,
        n,
      });

    case 'gemini':
    case 'google':
      if (kind === 'video') {
        // Gemini video (Veo) is separate — route through fal's veo endpoint for now
        throw new ProviderError('Gemini video not yet implemented here (use fal veo)', 'NOT_IMPLEMENTED', 'gemini', false);
      }
      return geminiImage({
        providerModelId: aiModel.providerModelId || 'gemini-2.5-flash-image',
        prompt,
        referenceImageUrl: validatedRef?.url,
      });

    default:
      throw new ProviderError(`Unknown provider: ${provider}`, 'UNKNOWN_PROVIDER', 'router', false);
  }
}

module.exports = {
  generate,
  enhanceImage,
  ProviderError,
  // Exported for tests
  openaiImage, geminiImage, falImage, falVideo,
  openaiEnhance, falEnhance, geminiEnhance,  // ← and these
};
