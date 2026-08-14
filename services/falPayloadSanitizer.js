// 'use strict';

/**
 * falPayloadSanitizer.js
 *
 * Per-model schema whitelist for fal.ai. Given (falModelId, rawPayload)
 * returns a payload that ONLY contains fields that model actually accepts,
 * with values coerced to the types fal expects.
 *
 * Families supported:
 *   Kling v1/v1.6/v2.x  — kling, klingI2V
 *   Kling O3 (all tiers) — klingO3T2V, klingO3I2V, klingO3Ref2V,
 *                          klingO3V2VEdit, klingO3V2VRef
 *   Flux                 — fluxSchnell, fluxDev, fluxPro, fluxI2I, fluxKontext
 *   Seedance v1/v1.5     — seedanceT2V, seedanceI2V   (INTEGER duration)
 *   Seedance 2.0         — seedance2T2V, seedance2I2V, seedance2Ref2V (STRING/auto duration)
 *   Happy Horse          — happyHorseRef2Vid
 *   Wan 2.7              — wanV27Ref2Vid
 *   Pixverse C1          — pixverseT2V, pixverseI2V
 *   Seedream v4          — seedream
 *   Video Upscaler       — videoUpscaler
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

// Guard: reject data URIs and relative paths — fal.ai only accepts public HTTPS URLs.
function isHttpUrl(v) {
  return (
    typeof v === "string" &&
    (v.startsWith("https://") || v.startsWith("http://"))
  );
}

// Filter an array to only HTTPS URLs, dropping data: URIs, blobs, and empties.
function filterUrls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isHttpUrl);
}

const KLING_O3_AR = new Set(["16:9", "9:16", "1:1"]);
const KLING_O3_DURATIONS = new Set([
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
]);
const FLUX_IMAGE_SIZES = new Set([
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
]);
const SEEDANCE_2_AR = new Set([
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);
const SEEDANCE_2_RES = new Set(["480p", "720p", "1080p"]);


const VEO31_AR = new Set(["auto", "16:9", "9:16"]);
const VEO31_RES = new Set(["720p", "1080p", "4k"]);
const VEO31_DURATIONS = new Set(["4s", "6s", "8s"]);
const VEO31_SAFETY = new Set(["1", "2", "3", "4", "5", "6"]);
const VEO31_EXTEND_AR = new Set([
  "auto",
  "16:9",
  "9:16",
]);

const VEO31_EXTEND_SAFETY = new Set([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
]);


const VEO31_FAST_AR = new Set(["16:9", "9:16"]);
const VEO31_FAST_RES = new Set(["720p", "1080p", "4k"]);
const VEO31_FAST_DURATION = new Set(["4s", "6s", "8s"]);
const VEO31_REF_AR = new Set(["16:9", "9:16"]);
const VEO31_REF_RES = new Set(["720p", "1080p", "4k"]);

function veo31FastDuration(value) {
  if (value == null) return "8s";

  const str = String(value).trim();

  if (VEO31_FAST_DURATION.has(str)) return str;

  const normalized = `${parseInt(str, 10)}s`;

  return VEO31_FAST_DURATION.has(normalized)
    ? normalized
    : "8s";
}
function veo31Duration(v) {
  const value = String(v ?? "8s");

  if (VEO31_DURATIONS.has(value)) return value;

  switch (Number(v)) {
    case 4:
      return "4s";
    case 6:
      return "6s";
    case 8:
      return "8s";
    default:
      return "8s";
  }
}


function takeAspect(raw, allowed, fallback) {
  return allowed.has(raw) ? raw : fallback;
}

function takeDurationString(raw, fallback = "5") {
  if (raw == null) return fallback;
  const s = String(raw);
  if (KLING_O3_DURATIONS.has(s)) return s;
  const n = Math.max(3, Math.min(15, Math.round(Number(raw) || 5)));
  return String(n);
}

function seedance2Duration(raw) {
  if (raw === "auto" || raw == null) return "auto";
  return String(Math.max(4, Math.min(15, Math.round(Number(raw)))));
}

// Multi-prompt shaper — each shot: { prompt, duration? }
function shapeMultiPrompt(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const cleaned = arr
    .filter((s) => s && s.prompt && String(s.prompt).trim().length > 0)
    .map((shot) => {
      const out = { prompt: String(shot.prompt).slice(0, 2500) };
      if (shot.duration != null)
        out.duration = takeDurationString(shot.duration);
      return out;
    });
  return cleaned.length > 0 ? cleaned : null;
}

// XOR: multi_prompt wins if present AND prompt is absent
function applyPromptXor(out, raw) {
  const hasMulti =
    Array.isArray(raw.multi_prompt) && raw.multi_prompt.length > 0;
  const hasPrompt = raw.prompt && String(raw.prompt).trim().length > 0;
  if (hasMulti && !hasPrompt) {
    const m = shapeMultiPrompt(raw.multi_prompt);
    if (m) out.multi_prompt = m;
  } else if (hasPrompt) {
    out.prompt = String(raw.prompt).slice(0, 2500);
  }
}

// Kling O3 ref2v element — frontal + references + optional video + voice
function shapeComboElement(el) {
  if (!el) return null;
  const e = {};
  if (isHttpUrl(el.frontal_image_url))
    e.frontal_image_url = el.frontal_image_url;
  const refs = filterUrls(el.reference_image_urls);
  if (refs.length > 0) e.reference_image_urls = refs.slice(0, 3);
  if (isHttpUrl(el.video_url)) e.video_url = el.video_url;
  if (el.voice_id && e.video_url) e.voice_id = el.voice_id;
  return Object.keys(e).length > 0 ? e : null;
}

// Kling O3 v2v element — image-only (no video, no voice per schema)
function shapeImageElement(el) {
  if (!el) return null;
  const e = {};
  if (isHttpUrl(el.frontal_image_url))
    e.frontal_image_url = el.frontal_image_url;
  const refs = filterUrls(el.reference_image_urls);
  if (refs.length > 0) e.reference_image_urls = refs.slice(0, 3);
  return Object.keys(e).length > 0 ? e : null;
}

// ─── Kling v1 / v1.6 / v2.x ─────────────────────────────────────────────────

function kling(raw) {
  const out = {};
  if (raw.prompt) out.prompt = String(raw.prompt).slice(0, 2500);
  if (raw.negative_prompt)
    out.negative_prompt = String(raw.negative_prompt).slice(0, 1000);
  const dur = Number(raw.duration || 5);
  out.duration = dur >= 8 ? "10" : "5";
  const validAR = new Set(["16:9", "9:16", "1:1"]);
  out.aspect_ratio = validAR.has(raw.aspect_ratio) ? raw.aspect_ratio : "9:16";
  if (raw.cfg_scale != null)
    out.cfg_scale = Math.max(0.1, Math.min(1.0, Number(raw.cfg_scale)));
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function klingI2V(raw) {
  const base = kling(raw);
  if (raw.image_url) base.image_url = raw.image_url;
  if (raw.end_image_url || raw.tail_image_url) {
    base.tail_image_url = raw.tail_image_url || raw.end_image_url;
  }
  return base;
}

// ─── Kling O3 — five mode functions ──────────────────────────────────────────
//
// All modes: shot_type='customize' (const), generate_audio bool, optional seed.
// t2v     — prompt XOR multi_prompt, duration, aspect_ratio
// i2v     — image_url (REQ), end_image_url, duration. NO aspect_ratio (derived from image)
// ref2v   — elements + image_urls ≤ 7, start/end frames, duration, aspect_ratio
// v2v_edit— video_url (REQ), prompt (REQ), image_urls ≤ 4, elements, keep_audio.
//           NO aspect_ratio, NO duration
// v2v_ref — video_url (REQ), prompt (REQ), image_urls ≤ 4, elements, keep_audio,
//           aspect_ratio (+'auto'), optional duration

function klingO3T2V(raw) {
  const out = { shot_type: "customize" };
  applyPromptXor(out, raw);
  out.aspect_ratio = takeAspect(raw.aspect_ratio, KLING_O3_AR, "16:9");
  out.duration = takeDurationString(raw.duration, "5");
  out.generate_audio = raw.generate_audio === true;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function klingO3I2V(raw) {
  if (!raw.image_url && !raw.start_image_url) {
    throw new Error("kling_o3_i2v_missing_image_url");
  }
  const out = { shot_type: "customize" };
  applyPromptXor(out, raw);
  out.image_url = raw.image_url || raw.start_image_url;
  if (raw.end_image_url) out.end_image_url = raw.end_image_url;
  out.duration = takeDurationString(raw.duration, "5");
  out.generate_audio = raw.generate_audio === true;
  if (raw.seed != null) out.seed = Number(raw.seed);
  // NB: i2v derives aspect_ratio from the image — do NOT send it
  return out;
}

function klingO3Ref2V(raw) {
  const out = { shot_type: "customize" };
  applyPromptXor(out, raw);
  if (raw.start_image_url) out.start_image_url = raw.start_image_url;
  if (raw.end_image_url) out.end_image_url = raw.end_image_url;

  // Elements — only include well-formed ones (frontal alone is allowed by docs,
  // but drop empties). Don't send elements:[] — send the key only if non-empty.
  if (Array.isArray(raw.elements) && raw.elements.length > 0) {
    const els = raw.elements.map(shapeComboElement).filter(Boolean);
    if (els.length > 0) out.elements = els;
  }

  // image_urls — must NOT duplicate the start/end frame. Strip any url that
  // equals a frame, then cap to the combined-7 budget.
  const frameSet = new Set(
    [raw.start_image_url, raw.end_image_url].filter(Boolean),
  );
  const safeImageUrls = filterUrls(raw.image_urls).filter(
    (u) => !frameSet.has(u),
  );
  if (safeImageUrls.length > 0) {
    const room = Math.max(0, 7 - (out.elements?.length || 0));
    if (room > 0) out.image_urls = safeImageUrls.slice(0, room);
  }
  out.image_urls = raw.image_urls || [];

  out.aspect_ratio = takeAspect(raw.aspect_ratio, KLING_O3_AR, "16:9");
  out.duration = takeDurationString(raw.duration, "5");
  out.generate_audio = raw.generate_audio === true;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function klingO3V2VEdit(raw) {
  if (!raw.video_url) throw new Error("kling_o3_v2v_edit_missing_video_url");
  if (!raw.prompt || !String(raw.prompt).trim())
    throw new Error("kling_o3_v2v_edit_missing_prompt");
  const out = {
    shot_type: "customize",
    video_url: raw.video_url,
    prompt: String(raw.prompt).slice(0, 2500),
    keep_audio: raw.keep_audio !== false,
  };
  const safeImgs = filterUrls(raw.image_urls);
  if (safeImgs.length > 0) out.image_urls = safeImgs.slice(0, 4);
  if (Array.isArray(raw.elements) && raw.elements.length > 0) {
    const els = raw.elements.map(shapeImageElement).filter(Boolean);
    if (els.length > 0) out.elements = els;
  }
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function klingO3V2VRef(raw) {
  if (!raw.video_url) throw new Error("kling_o3_v2v_ref_missing_video_url");
  if (!raw.prompt || !String(raw.prompt).trim())
    throw new Error("kling_o3_v2v_ref_missing_prompt");
  const out = {
    shot_type: "customize",
    video_url: raw.video_url,
    prompt: String(raw.prompt).slice(0, 2500),
    keep_audio: raw.keep_audio !== false,
  };
  const v2vRefAR = new Set(["auto", "16:9", "9:16", "1:1"]);
  out.aspect_ratio = takeAspect(raw.aspect_ratio, v2vRefAR, "auto");
  if (raw.duration != null)
    out.duration = takeDurationString(raw.duration, "5");
  const safeImgs = filterUrls(raw.image_urls);
  if (safeImgs.length > 0) out.image_urls = safeImgs.slice(0, 4);
  if (Array.isArray(raw.elements) && raw.elements.length > 0) {
    const els = raw.elements.map(shapeImageElement).filter(Boolean);
    if (els.length > 0) out.elements = els;
  }
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Flux ────────────────────────────────────────────────────────────────────

function fluxSchnell(raw) {
  const out = { prompt: String(raw.prompt || "").slice(0, 5000) };
  out.image_size = FLUX_IMAGE_SIZES.has(raw.image_size)
    ? raw.image_size
    : "square_hd";
  out.num_inference_steps = 4;
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  out.enable_safety_checker = raw.enable_safety_checker !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function isHttpUrl(v) {
  return (
    typeof v === "string" &&
    (v.startsWith("https://") || v.startsWith("http://"))
  );
}
function filterUrls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isHttpUrl);
}

// Valid GPT-Image-2 sizes (OpenAI). Map common aliases → nearest valid value.
const GPT_IMAGE_SIZES = new Set([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
]);
const ASPECT_TO_GPT_SIZE = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "3:2": "1536x1024", // landscape-ish
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "2:3": "1024x1536", // portrait-ish
  // flux aliases that must NOT be passed through:
  square_hd: "1024x1024",
  square: "1024x1024",
  landscape_16_9: "1536x1024",
  landscape_4_3: "1536x1024",
  portrait_16_9: "1024x1536",
  portrait_4_3: "1024x1536",
  auto: "auto",
};
function normalizeGptSize(raw, aspectRatio) {
  if (raw && GPT_IMAGE_SIZES.has(raw)) return raw; // already valid
  if (raw && ASPECT_TO_GPT_SIZE[raw]) return ASPECT_TO_GPT_SIZE[raw]; // alias → valid
  if (aspectRatio && ASPECT_TO_GPT_SIZE[aspectRatio])
    return ASPECT_TO_GPT_SIZE[aspectRatio];
  return "auto"; // safe default the model always accepts
}

// ── EDIT: requires at least one reference image ────────────────────────────
function gptImage2Edit(raw) {
  const out = {};
  out.prompt = String(raw.prompt || "").slice(0, 5000);

  const imgs = filterUrls(raw.image_urls);
  if (imgs.length === 0) {
    // Hard fail: /edit with no image is a routing mistake — caller should have
    // sent this to the generate route. Fail loud rather than 422 from fal.
    throw new Error("gpt_image_2_edit_missing_image_urls");
  }
  out.image_urls = imgs;

  out.image_size = normalizeGptSize(raw.image_size, raw.aspect_ratio); // valid size only
  if (["low", "medium", "high", "auto"].includes(raw.quality))
    out.quality = raw.quality;
  else out.quality = "high";
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  if (["png", "jpeg", "webp"].includes(raw.output_format))
    out.output_format = raw.output_format;
  else out.output_format = "png";
  if (isHttpUrl(raw.mask_url)) out.mask_url = raw.mask_url; // only if real; never null
  // NOTE: do NOT send input_fidelity — gpt-image-2 forbids it (doc 9).
  // NOTE: do NOT send sync_mode unless you actually want base64 inline.
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function gptImage2(raw) {
  const out = {};

  out.prompt = String(raw.prompt || "").slice(0, 5000);

  out.image_size = normalizeGptSize(
    raw.image_size,
    raw.aspect_ratio
  );

  if (["low", "medium", "high", "auto"].includes(raw.quality))
    out.quality = raw.quality;
  else
    out.quality = "high";

  out.num_images = Math.max(
    1,
    Math.min(4, Number(raw.num_images || 1))
  );

  if (["png", "jpeg", "webp"].includes(raw.output_format))
    out.output_format = raw.output_format;
  else
    out.output_format = "png";

  // Only send if explicitly requested
  if (typeof raw.sync_mode === "boolean")
    out.sync_mode = raw.sync_mode;

  return out;
}

// ── GENERATE: no reference image; text-to-image ────────────────────────────
function gptImage2Generate(raw) {
  const out = {};
  out.prompt = String(raw.prompt || "").slice(0, 5000);
  out.image_size = normalizeGptSize(raw.image_size, raw.aspect_ratio);
  if (["low", "medium", "high", "auto"].includes(raw.quality))
    out.quality = raw.quality;
  else out.quality = "high";
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  if (["png", "jpeg", "webp"].includes(raw.output_format))
    out.output_format = raw.output_format;
  else out.output_format = "png";
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function fluxDev(raw) {
  const out = { prompt: String(raw.prompt || "").slice(0, 5000) };
  out.image_size = FLUX_IMAGE_SIZES.has(raw.image_size)
    ? raw.image_size
    : "square_hd";
  out.num_inference_steps = Math.max(
    1,
    Math.min(50, Number(raw.num_inference_steps || 28)),
  );
  out.guidance_scale = Math.max(
    0,
    Math.min(20, Number(raw.guidance_scale || 3.5)),
  );
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  out.enable_safety_checker = raw.enable_safety_checker !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function fluxPro(raw) {
  return fluxDev(raw);
}

function fluxI2I(raw) {
  if (!isHttpUrl(raw.image_url)) throw new Error("flux_i2i_missing_image_url");
  const out = {
    image_url: raw.image_url,
    prompt: String(raw.prompt || "").slice(0, 5000),
  };
  out.strength =
    raw.strength != null
      ? Math.max(0.01, Math.min(1.0, Number(raw.strength)))
      : 0.85;
  out.num_inference_steps = Math.max(
    1,
    Math.min(50, Number(raw.num_inference_steps || 40)),
  );
  out.guidance_scale = Math.max(
    0,
    Math.min(20, Number(raw.guidance_scale || 3.5)),
  );
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  if (raw.seed != null) out.seed = Number(raw.seed);
  // NO image_size — flux i2i derives from input image
  return out;
}

function fluxKontext(raw) {
  if (!isHttpUrl(raw.image_url))
    throw new Error("flux_kontext_missing_image_url");
  const out = {
    image_url: raw.image_url,
    prompt: String(raw.prompt || "").slice(0, 5000),
  };
  out.guidance_scale = Math.max(
    0,
    Math.min(20, Number(raw.guidance_scale || 3.5)),
  );
  out.num_inference_steps = Math.max(
    1,
    Math.min(50, Number(raw.num_inference_steps || 28)),
  );
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Seedance v1 / v1.5 — INTEGER duration ───────────────────────────────────

function seedanceT2V(raw) {
  const out = { prompt: String(raw.prompt || "").slice(0, 2500) };
  const validAR = new Set(["16:9", "9:16", "1:1"]);
  out.aspect_ratio = validAR.has(raw.aspect_ratio) ? raw.aspect_ratio : "16:9";
  const dur = Number(raw.duration || 5);
  out.duration = dur >= 8 ? 10 : 5;
  const validRes = new Set(["480p", "580p", "720p", "1080p"]);
  if (raw.resolution && validRes.has(raw.resolution))
    out.resolution = raw.resolution;
  if (raw.seed != null) out.seed = Number(raw.seed);
  if (raw.generate_audio === true) out.generate_audio = true;
  return out;
}

function seedanceI2V(raw) {
  if (!raw.image_url) throw new Error("seedance_i2v_missing_image_url");
  const base = seedanceT2V(raw);
  base.image_url = raw.image_url;
  if (raw.end_image_url) base.end_image_url = raw.end_image_url;
  return base;
}

// ─── Seedance 2.0 — STRING / 'auto' duration ────────────────────────────────
// @Image1, @Video1, @Audio1 tokens via image_urls / video_urls / audio_urls arrays

function seedance2T2V(raw) {
  if (!raw.prompt) throw new Error("seedance2_t2v_missing_prompt");
  const out = { prompt: String(raw.prompt).slice(0, 4000) };
  out.aspect_ratio = takeAspect(raw.aspect_ratio, SEEDANCE_2_AR, "auto");
  out.duration = seedance2Duration(raw.duration);
  out.resolution = SEEDANCE_2_RES.has(raw.resolution) ? raw.resolution : "720p";
  out.generate_audio = raw.generate_audio !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// function seedance2I2V(raw) {
//   if (!raw.prompt)    throw new Error('seedance2_i2v_missing_prompt');
//   if (!raw.image_url) throw new Error('seedance2_i2v_missing_image_url');
//   const out = seedance2T2V(raw);
//   out.image_url = raw.image_url;
//   if (raw.end_image_url) out.end_image_url = raw.end_image_url;
//   return out;
// }
function seedance2I2V(raw) {
  if (!raw.prompt) {
    throw new Error("seedance2_i2v_missing_prompt");
  }

  if (!raw.image_url) {
    throw new Error("seedance2_i2v_missing_image_url");
  }

  return {
    prompt: String(raw.prompt).slice(0, 4000),
    image_url: raw.image_url,
    ...(raw.end_image_url && {
      end_image_url: raw.end_image_url,
    }),
    aspect_ratio: takeAspect(raw.aspect_ratio, SEEDANCE_2_AR, "auto"),
    duration: seedance2Duration(raw.duration),
    resolution: SEEDANCE_2_RES.has(raw.resolution) ? raw.resolution : "720p",
    generate_audio: raw.generate_audio !== false,
    ...(raw.seed != null && {
      seed: Number(raw.seed),
    }),
  };
}

function seedance2Ref2V(raw) {
  if (!raw.prompt) throw new Error("seedance2_ref2v_missing_prompt");
  const out = { prompt: String(raw.prompt).slice(0, 4000) };
  const safeImgs = filterUrls(raw.image_urls);
  if (safeImgs.length > 0) out.image_urls = safeImgs.slice(0, 9);
  const safeVids = filterUrls(raw.video_urls);
  if (safeVids.length > 0) out.video_urls = safeVids.slice(0, 3);
  if (Array.isArray(raw.audio_urls) && raw.audio_urls.length > 0)
    out.audio_urls = raw.audio_urls.slice(0, 3);
  out.aspect_ratio = takeAspect(raw.aspect_ratio, SEEDANCE_2_AR, "auto");
  out.duration = seedance2Duration(raw.duration);
  out.resolution = SEEDANCE_2_RES.has(raw.resolution) ? raw.resolution : "720p";
  out.generate_audio = raw.generate_audio !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Happy Horse ─────────────────────────────────────────────────────────────
// character1..character9 tokens via image_urls (frontal refs, INTEGER duration)

function happyHorseRef2Vid(raw) {
  if (!raw.prompt) throw new Error("happy_horse_missing_prompt");
  const safeImgs = filterUrls(raw.image_urls);
  if (safeImgs.length === 0) throw new Error("happy_horse_missing_image_urls");
  const out = {
    prompt: String(raw.prompt).slice(0, 2500),
    image_urls: safeImgs.slice(0, 9),
  };
  const validAR = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
  out.aspect_ratio = validAR.has(raw.aspect_ratio) ? raw.aspect_ratio : "16:9";
  const validRes = new Set(["720p", "1080p"]);
  out.resolution = validRes.has(raw.resolution) ? raw.resolution : "720p";
  out.duration = Math.max(
    3,
    Math.min(15, Math.round(Number(raw.duration ?? 5))),
  );
  out.enable_safety_checker = raw.enable_safety_checker !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function seedreamV5Lite(input) {
  return {
    prompt: input.prompt,
    ...(input.negative_prompt
      ? { negative_prompt: input.negative_prompt }
      : {}),
    image_size:
      input.image_size ||
      aspectToSeedreamSize(input.aspectRatio) ||
      "square_hd",
    num_images: Math.max(1, Math.min(4, input.num_images || 1)),
    ...(input.seed != null ? { seed: input.seed } : {}),
    enable_safety_checker: input.enable_safety_checker !== false,
  };
}
// ─── Wan 2.7 ─────────────────────────────────────────────────────────────────
// reference_image_urls field name, INTEGER duration [2..10]

function wanV27Ref2Vid(raw) {
  if (!raw.prompt) throw new Error("wan_v27_missing_prompt");
  const out = { prompt: String(raw.prompt).slice(0, 5000) };
  if (raw.negative_prompt)
    out.negative_prompt = String(raw.negative_prompt).slice(0, 500);
  const imgs = filterUrls(raw.reference_image_urls || raw.image_urls);
  if (imgs.length > 0) out.reference_image_urls = imgs;
  const vids = filterUrls(raw.reference_video_urls || raw.video_urls);
  if (vids.length > 0) out.reference_video_urls = vids;
  const validAR = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
  out.aspect_ratio = validAR.has(raw.aspect_ratio) ? raw.aspect_ratio : "16:9";
  const validRes = new Set(["720p", "1080p"]);
  out.resolution = validRes.has(raw.resolution) ? raw.resolution : "720p";
  out.duration = Math.max(
    2,
    Math.min(10, Math.round(Number(raw.duration ?? 5))),
  );
  if (raw.multi_shots === true) out.multi_shots = true;
  out.enable_safety_checker = raw.enable_safety_checker !== false;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Google Veo 3.1 ──────────────────────────────────────────────────────────
function veo31Image2Video(raw) {
  if (!raw.prompt) throw new Error("veo31_i2v_missing_prompt");
  if (!raw.image_url) throw new Error("veo31_i2v_missing_image_url");

  return {
    prompt: String(raw.prompt).slice(0, 20000),
    image_url: raw.image_url,
    aspect_ratio: takeAspect(raw.aspect_ratio, VEO31_AR, "auto"),
    duration: veo31Duration(raw.duration),
    resolution: VEO31_RES.has(raw.resolution) ? raw.resolution : "720p",
    generate_audio: raw.generate_audio !== false,
    ...(raw.negative_prompt && {
      negative_prompt: String(raw.negative_prompt).slice(0, 4000),
    }),
    safety_tolerance: VEO31_SAFETY.has(String(raw.safety_tolerance))
      ? String(raw.safety_tolerance)
      : "4",
    auto_fix: raw.auto_fix === true,
    ...(raw.seed != null && {
      seed: Number(raw.seed),
    }),
  };
}

function veo31ExtendVideo(raw) {
  if (!raw.prompt) {
    throw new Error("veo31_extend_missing_prompt");
  }

  if (!raw.video_url) {
    throw new Error("veo31_extend_missing_video_url");
  }

  return {
    prompt: String(raw.prompt).slice(0, 20000),

    video_url: raw.video_url,

    aspect_ratio: takeAspect(
      raw.aspect_ratio,
      VEO31_EXTEND_AR,
      "auto",
    ),

    resolution: "720p",

    duration: "7s",

    generate_audio: raw.generate_audio !== false,

    ...(raw.negative_prompt && {
      negative_prompt: String(raw.negative_prompt).slice(0, 4000),
    }),

    safety_tolerance: VEO31_EXTEND_SAFETY.has(
      String(raw.safety_tolerance),
    )
      ? String(raw.safety_tolerance)
      : "4",

    auto_fix: raw.auto_fix === true,

    ...(raw.seed != null && {
      seed: Number(raw.seed),
    }),
  };
}



function veo31FastT2V(raw) {
  if (!raw.prompt) {
    throw new Error("veo31_fast_missing_prompt");
  }

  const out = {
    prompt: String(raw.prompt).slice(0, 20000),

    aspect_ratio: VEO31_FAST_AR.has(raw.aspect_ratio)
      ? raw.aspect_ratio
      : "16:9",

    duration: veo31FastDuration(raw.duration),

    resolution: VEO31_FAST_RES.has(raw.resolution)
      ? raw.resolution
      : "720p",

    generate_audio: raw.generate_audio !== false,

    auto_fix: raw.auto_fix !== false,

    safety_tolerance: ["1", "2", "3", "4", "5", "6"].includes(
      String(raw.safety_tolerance)
    )
      ? String(raw.safety_tolerance)
      : "4",
  };

  if (raw.negative_prompt) {
    out.negative_prompt = String(raw.negative_prompt).slice(0, 4000);
  }

  if (raw.seed != null) {
    out.seed = Number(raw.seed);
  }

  return out;
}


function veo31FastRef2V(raw) {
  if (!raw.prompt) {
    throw new Error("veo31_fast_ref2v_missing_prompt");
  }

  const safeImgs = filterUrls(raw.image_urls);

  if (safeImgs.length === 0) {
    throw new Error("veo31_fast_ref2v_missing_image_urls");
  }

  const out = {
    prompt: String(raw.prompt).slice(0, 20000),
    image_urls: safeImgs.slice(0, 9),
  };

  const validAR = new Set(["16:9", "9:16"]);

  out.aspect_ratio = validAR.has(raw.aspect_ratio)
    ? raw.aspect_ratio
    : "16:9";

  const validRes = new Set(["720p", "1080p", "4k"]);

  out.resolution = validRes.has(raw.resolution)
    ? raw.resolution
    : "720p";

  out.duration = "8s";

  out.generate_audio = raw.generate_audio !== false;

  out.auto_fix = raw.auto_fix === true;

  if (raw.safety_tolerance != null) {
    const v = String(raw.safety_tolerance);
    if (["1", "2", "3", "4", "5", "6"].includes(v)) {
      out.safety_tolerance = v;
    }
  }

  return out;
}
// ─── Pixverse C1 ─────────────────────────────────────────────────────────────

function pixverseT2V(raw) {
  const out = { prompt: String(raw.prompt || "").slice(0, 2500) };
  const validAR = new Set(["16:9", "9:16", "1:1", "4:3"]);
  out.aspect_ratio = validAR.has(raw.aspect_ratio) ? raw.aspect_ratio : "16:9";
  const dur = Number(raw.duration || 4);
  out.duration = dur >= 6 ? 8 : 4;
  if (raw.quality && new Set(["normal", "smooth"]).has(raw.quality))
    out.quality = raw.quality;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

function pixverseI2V(raw) {
  if (!raw.image_url) throw new Error("pixverse_i2v_missing_image_url");
  return { ...pixverseT2V(raw), image_url: raw.image_url };
}

// ─── Seedream v4 ─────────────────────────────────────────────────────────────

function seedream(raw) {
  const out = { prompt: String(raw.prompt || "").slice(0, 5000) };
  out.image_size = FLUX_IMAGE_SIZES.has(raw.image_size)
    ? raw.image_size
    : "square_hd";
  out.num_images = Math.max(1, Math.min(4, Number(raw.num_images || 1)));
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Video Upscaler ───────────────────────────────────────────────────────────

function videoUpscaler(raw) {
  const out = {};
  if (raw.video_url) out.video_url = raw.video_url;
  out.scale_factor = Math.max(1, Math.min(4, Number(raw.scale_factor ?? 2)));
  return out;
}

// ─── Family / mode dispatch ───────────────────────────────────────────────────

const KLING_O3_SANITIZERS = {
  t2v: klingO3T2V,
  i2v: klingO3I2V,
  ref2v: klingO3Ref2V,
  v2v_edit: klingO3V2VEdit,
  v2v_ref: klingO3V2VRef,
};

const SEEDANCE_2_SANITIZERS = {
  t2v: seedance2T2V,
  i2v: seedance2I2V,
  ref2v: seedance2Ref2V,
};

const FAMILY_SANITIZERS = {
  kling_o3: KLING_O3_SANITIZERS,
  seedance_2_0: SEEDANCE_2_SANITIZERS,
};

function sanitizeForFamilyMode(family, mode, raw) {
  const map = FAMILY_SANITIZERS[family];
  if (!map) throw new Error(`unknown_family:${family}`);
  const fn = map[mode];
  if (!fn) {
    const supported = Object.keys(map).join(", ");
    throw new Error(
      `family_does_not_support_mode:${family}/${mode} (supported: ${supported})`,
    );
  }
  try {
    return fn(raw);
  } catch (err) {
    err.message = `[${family}/${mode}] ${err.message}`;
    throw err;
  }
}

// ─── Model schema registry ────────────────────────────────────────────────────

const MODEL_SCHEMAS = {
  // Kling v1 / v1.6 / v2.x — legacy single sanitizer per mode
  "fal-ai/kling-video/v1/standard/text-to-video": kling,
  "fal-ai/kling-video/v1/standard/image-to-video": klingI2V,
  "fal-ai/kling-video/v1.6/standard/text-to-video": kling,
  "fal-ai/kling-video/v1.6/standard/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.1/standard/text-to-video": kling,
  "fal-ai/kling-video/v2.1/standard/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.1/pro/text-to-video": kling,
  "fal-ai/kling-video/v2.1/pro/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.5-turbo/standard/text-to-video": kling,
  "fal-ai/kling-video/v2.5-turbo/standard/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": kling,
  "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.6/standard/text-to-video": kling,
  "fal-ai/kling-video/v2.6/standard/image-to-video": klingI2V,
  "fal-ai/kling-video/v2.6/pro/text-to-video": kling,
  "fal-ai/kling-video/v2.6/pro/image-to-video": klingI2V,
  "fal-ai/kling-video/v2/standard/text-to-video": kling,
  "fal-ai/kling-video/v2/pro/text-to-video": kling,

  // Kling O3 — 13 endpoints × 5 mode functions
  "fal-ai/kling-video/o3/4k/text-to-video": klingO3T2V,
  "fal-ai/kling-video/o3/pro/text-to-video": klingO3T2V,
  "fal-ai/kling-video/o3/standard/text-to-video": klingO3T2V,
  "fal-ai/kling-video/o3/4k/image-to-video": klingO3I2V,
  "fal-ai/kling-video/o3/pro/image-to-video": klingO3I2V,
  "fal-ai/kling-video/o3/standard/image-to-video": klingO3I2V,
  "fal-ai/kling-video/o3/4k/reference-to-video": klingO3Ref2V,
  "fal-ai/kling-video/o3/pro/reference-to-video": klingO3Ref2V,
  "fal-ai/kling-video/o3/standard/reference-to-video": klingO3Ref2V,
  "fal-ai/kling-video/o3/pro/video-to-video/edit": klingO3V2VEdit,
  "fal-ai/kling-video/o3/standard/video-to-video/edit": klingO3V2VEdit,
  "fal-ai/kling-video/o3/pro/video-to-video/reference": klingO3V2VRef,
  "fal-ai/kling-video/o3/standard/video-to-video/reference": klingO3V2VRef,

  // Flux
  "fal-ai/flux/schnell": fluxSchnell,
  "fal-ai/flux/dev": fluxDev,
  "fal-ai/flux-pro": fluxPro,
  "fal-ai/flux-pro/v1.1": fluxPro,
  "fal-ai/flux-pro/v1.1-ultra": fluxPro,
  "fal-ai/flux/dev/image-to-image": fluxI2I,
  "fal-ai/flux-1/dev/image-to-image": fluxI2I,
  "fal-ai/flux-lora/image-to-image": fluxI2I,
  "fal-ai/flux-pro/kontext": fluxKontext,

  // Seedance v1 / v1.5 — INTEGER duration
  "fal-ai/bytedance/seedance/v1/pro/text-to-video": seedanceT2V,
  "fal-ai/bytedance/seedance/v1/pro/image-to-video": seedanceI2V,
  "fal-ai/bytedance/seedance/v1.5/pro/text-to-video": seedanceT2V,
  "fal-ai/bytedance/seedance/v1.5/pro/image-to-video": seedanceI2V,

  // Seedance 2.0 — STRING/auto duration, @-token media arrays
  "bytedance/seedance-2.0/text-to-video": seedance2T2V,
  "fal-ai/bytedance/seedance-2.0/text-to-video": seedance2T2V,
  "bytedance/seedance-2.0/fast/text-to-video": seedance2T2V,
  "fal-ai/bytedance/seedance-2.0/fast/text-to-video": seedance2T2V,
  "bytedance/seedance-2.0/image-to-video": seedance2I2V,
  "fal-ai/bytedance/seedance-2.0/image-to-video": seedance2I2V,
  "bytedance/seedance-2.0/fast/image-to-video": seedance2I2V,
  "fal-ai/bytedance/seedance-2.0/fast/image-to-video": seedance2I2V,
  "bytedance/seedance-2.0/reference-to-video": seedance2Ref2V,
  "fal-ai/bytedance/seedance-2.0/reference-to-video": seedance2Ref2V,
  "bytedance/seedance-2.0/fast/reference-to-video": seedance2Ref2V,
  "fal-ai/bytedance/seedance-2.0/fast/reference-to-video": seedance2Ref2V,

  // Happy Horse, Wan, Pixverse, Seedream, Upscaler
  "alibaba/happy-horse/reference-to-video": happyHorseRef2Vid,
  "fal-ai/alibaba/happy-horse/reference-to-video": happyHorseRef2Vid,
  "alibaba/happy-horse/image-to-video": happyHorseRef2Vid,
  "fal-ai/wan/v2.7/reference-to-video": wanV27Ref2Vid,
  "fal-ai/wan/v2.7/image-to-video": wanV27Ref2Vid,
  "fal-ai/pixverse/c1/text-to-video": pixverseT2V,
  "fal-ai/pixverse/c1/image-to-video": pixverseI2V,
  "fal-ai/bytedance/seedream/v4/text-to-image": seedream,
  "fal-ai/video-upscaler": videoUpscaler,

  "openai/gpt-image-2/edit": gptImage2Edit,
  "openai/gpt-image-2": gptImage2,
  "fal-ai/bytedance/seedream/v5/lite/text-to-image": seedreamV5Lite,


  "fal-ai/veo3.1/image-to-video": veo31Image2Video,
  "fal-ai/veo3.1/fast/image-to-video": veo31Image2Video,
  "fal-ai/veo3.1/extend-video": veo31ExtendVideo,
  "fal-ai/veo3.1/fast/reference-to-video": veo31FastRef2V,
  "fal-ai/veo3.1/fast": veo31FastT2V,
};

// ─── Universal fallback ───────────────────────────────────────────────────────

function fallbackSanitize(raw) {
  const out = {};
  if (raw.prompt) out.prompt = String(raw.prompt).slice(0, 3000);
  if (raw.image_url) out.image_url = raw.image_url;
  if (raw.seed != null) out.seed = Number(raw.seed);
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function sanitize(falModelId, rawInput = {}) {
  if (!falModelId) throw new Error("sanitize: falModelId is required");
  const schemaFn = MODEL_SCHEMAS[falModelId];
  console.log("schemaFn", schemaFn, falModelId);
  if (!schemaFn) {
    console.warn(
      `[falPayloadSanitizer] Unknown model '${falModelId}' — using fallback. Add a schema entry.`,
    );
    return fallbackSanitize(rawInput);
  }
  try {
    return schemaFn(rawInput);
  } catch (err) {
    err.message = `[${falModelId}] ${err.message}`;
    throw err;
  }
}

function listDroppedFields(falModelId, rawInput = {}) {
  const cleaned = sanitize(falModelId, rawInput);
  const rawKeys = new Set(Object.keys(rawInput));
  const cleanKeys = new Set(Object.keys(cleaned));
  return [...rawKeys].filter((k) => !cleanKeys.has(k));
}

/**
 * falPayloadSanitizer.js
 *
 * Last-mile guard before payloads hit fal.ai.
 *
 * The router builds payloads from your registry's `inputSlots`. This sanitizer
 * is the final safety net: if your registry drifts from what fal actually
 * accepts (e.g. fal removes a field, renames one, tightens an enum), this
 * catches it here instead of getting a generic 422 from fal.
 *
 * For UNKNOWN endpoints (no schema entry), the sanitizer is permissive —
 * it passes the payload through untouched. This means new fal models work
 * immediately on registry add; you only add a sanitizer schema when you
 * want stricter validation for a critical model.
 *
 * To add a new endpoint schema, add an entry to FAL_SCHEMAS keyed by the
 * exact falModelId. The router will then enforce it.
 */

const DEBUG = process.env.STUDIO_DEBUG === "true";
const log = (...args) => DEBUG && console.log("[falSanitizer]", ...args);

// ─── Per-endpoint schemas ────────────────────────────────────────────────────
// Each schema declares:
//   allowed:   set of allowed providerKey names (drop everything else)
//   required:  must be present + non-empty
//   types:     per-field: 'string' | 'number' | 'boolean' | 'string_array'
//   enums:     per-field allowed values
//   const:     per-field constant override (force-set regardless of input)
//   coerce:    per-field coercion {to: 'string'|'number'|'array'}
//
// All fields optional — leaving everything out means "permissive passthrough".
// ─────────────────────────────────────────────────────────────────────────────
const FAL_SCHEMAS = {
  // ── OpenAI GPT Image 2 (edit) ──────────────────────────────────────────────
  "openai/gpt-image-2/edit": {
    allowed: new Set([
      "image_urls",
      "prompt",
      "mask_url",
      "image_size",
      "background",
      "quality",
      "input_fidelity",
      "num_images",
      "output_format",
      "sync_mode",
    ]),
    required: ["image_urls", "prompt"],
    types: {
      image_urls: "string_array",
      prompt: "string",
      mask_url: "string",
      num_images: "number",
      sync_mode: "boolean",
    },
    enums: {
      image_size: [
        "auto",
        "1024x1024",
        "1536x1024",
        "1024x1536",
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
      background: ["auto", "transparent", "opaque"],
      quality: ["low", "medium", "high"],
      input_fidelity: ["low", "high"],
      output_format: ["png", "jpeg", "webp"],
    },
  },

  // ── Flux Schnell (text-to-image) ───────────────────────────────────────────
  "fal-ai/flux/schnell": {
    allowed: new Set([
      "prompt",
      "image_size",
      "num_inference_steps",
      "num_images",
      "enable_safety_checker",
      "seed",
      "sync_mode",
    ]),
    required: ["prompt"],
    types: {
      prompt: "string",
      num_images: "number",
      seed: "number",
      sync_mode: "boolean",
      num_inference_steps: "number",
      enable_safety_checker: "boolean",
    },
    enums: {
      image_size: [
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
    },
  },

  // ── Flux Pro ───────────────────────────────────────────────────────────────
  "fal-ai/flux-pro": {
    allowed: new Set([
      "prompt",
      "image_size",
      "num_inference_steps",
      "guidance_scale",
      "num_images",
      "safety_tolerance",
      "seed",
      "sync_mode",
      "image_url",
    ]),
    required: ["prompt"],
    types: {
      prompt: "string",
      num_images: "number",
      seed: "number",
      guidance_scale: "number",
      num_inference_steps: "number",
      sync_mode: "boolean",
      image_url: "string",
    },
    enums: {
      image_size: [
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
      safety_tolerance: ["1", "2", "3", "4", "5", "6"],
    },
  },

  // ── Nano Banana 2 (Google fast) ────────────────────────────────────────────
  "fal-ai/nano-banana-2": {
    allowed: new Set([
      "prompt",
      "aspect_ratio",
      "resolution",
      "num_images",
      "output_format",
      "seed",
    ]),
    required: ["prompt"],
    types: {
      prompt: "string",
      num_images: "number",
      seed: "number",
    },
    enums: {
      aspect_ratio: [
        "auto",
        "21:9",
        "16:9",
        "3:2",
        "4:3",
        "5:4",
        "1:1",
        "4:5",
        "3:4",
        "2:3",
        "9:16",
        "4:1",
        "1:4",
        "8:1",
        "1:8",
      ],
      resolution: ["480p", "720p", "1080p", "4k"],
      output_format: ["jpeg", "png", "webp"],
    },
  },

  // ── Nano Banana Pro ────────────────────────────────────────────────────────
  "fal-ai/nano-banana-pro": {
    allowed: new Set([
      "prompt",
      "aspect_ratio",
      "resolution",
      "num_images",
      "output_format",
      "seed",
    ]),
    required: ["prompt"],
    types: {
      prompt: "string",
      num_images: "number",
      seed: "number",
    },
    enums: {
      aspect_ratio: [
        "auto",
        "21:9",
        "16:9",
        "3:2",
        "4:3",
        "5:4",
        "1:1",
        "4:5",
        "3:4",
        "2:3",
        "9:16",
      ],
      resolution: ["480p", "720p", "1080p", "4k"],
      output_format: ["jpeg", "png", "webp"],
    },
  },

  // ── Seedance 2.0 (text-to-video) ───────────────────────────────────────────
  "bytedance/seedance-2.0/fast/text-to-video": {
    allowed: new Set([
      "prompt",
      "negative_prompt",
      "resolution",
      "duration",
      "aspect_ratio",
      "generate_audio",
      "seed",
    ]),
    required: ["prompt"],
    types: {
      prompt: "string",
      negative_prompt: "string",
      duration: "string",
      generate_audio: "boolean",
      seed: "number",
    },
    enums: {
      resolution: ["480p", "720p", "1080p"],
      aspect_ratio: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    coerce: {
      duration: { to: "string" },
    },
  },
  "bytedance/seedance-2.0/fast/image-to-video": {
    allowed: new Set([
      "prompt",
      "negative_prompt",
      "image_url",
      "end_image_url",
      "resolution",
      "duration",
      "aspect_ratio",
      "generate_audio",
      "seed",
    ]),
    required: ["prompt", "image_url"],
    types: {
      prompt: "string",
      negative_prompt: "string",
      image_url: "string",
      end_image_url: "string",
      duration: "string",
      generate_audio: "boolean",
      seed: "number",
    },
    enums: {
      resolution: ["480p", "720p", "1080p"],
      aspect_ratio: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    coerce: {
      duration: { to: "string" },
    },
  },

  "fal-ai/bytedance/seedream/v5/lite/text-to-image": (input) => ({
    prompt: input.prompt,
    ...(input.negative_prompt
      ? { negative_prompt: input.negative_prompt }
      : {}),
    image_size:
      input.image_size ||
      aspectToSeedreamSize(input.aspectRatio) ||
      "square_hd",
    num_images: Math.max(1, Math.min(4, input.num_images || 1)),
    ...(input.seed != null ? { seed: input.seed } : {}),
    enable_safety_checker: input.enable_safety_checker !== false,
  }),

  // Add more endpoint schemas as needed. Anything not listed is passthrough.
};

// ─── Coercion helpers ────────────────────────────────────────────────────────
function coerceType(value, target) {
  if (value === undefined || value === null) return value;
  switch (target) {
    case "string":
      return Array.isArray(value) ? String(value[0] ?? "") : String(value);
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? undefined : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const v = value.toLowerCase();
        if (["true", "1", "yes"].includes(v)) return true;
        if (["false", "0", "no"].includes(v)) return false;
      }
      return Boolean(value);
    case "string_array":
    case "array": {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => (v == null ? "" : String(v))).filter(Boolean);
    }
    default:
      return value;
  }
}

function isEmpty(v) {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function hasSchema(falModelId) {
  return Object.prototype.hasOwnProperty.call(FAL_SCHEMAS, falModelId);
}

function listEndpoints() {
  return Object.keys(FAL_SCHEMAS);
}

module.exports = {
  sanitize,
  sanitizeForFamilyMode,
  listDroppedFields,
  MODEL_SCHEMAS,
  FAMILY_SANITIZERS,
  // Kling
  kling,
  klingI2V,
  klingO3T2V,
  klingO3I2V,
  klingO3Ref2V,
  klingO3V2VEdit,
  klingO3V2VRef,
  // Flux
  fluxSchnell,
  fluxDev,
  fluxPro,
  fluxI2I,
  fluxKontext,
  // Seedance
  seedanceT2V,
  seedanceI2V,
  seedance2T2V,
  seedance2I2V,
  seedance2Ref2V,
  seedance2Ref2Vid: seedance2Ref2V, // backward-compat alias
  // Misc
  happyHorseRef2Vid,
  wanV27Ref2Vid,
  pixverseT2V,
  pixverseI2V,
  seedream,
  videoUpscaler,
  gptImage2Edit,
  gptImage2Generate,
  normalizeGptSize,
  gptImage2,
  hasSchema,
  listEndpoints,
  _schemas: FAL_SCHEMAS, // exposed for tests
};
