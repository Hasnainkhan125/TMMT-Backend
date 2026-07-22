'use strict';

/**
 * scripts/seedAiModels_capabilities_final.js
 *
 * FINAL version — all inputSlots sourced from verified OpenAPI schemas.
 * Replaces the earlier seedAiModels_capabilities.js entirely.
 *
 * Run:
 *   node scripts/seedAiModels_capabilities_final.js --dry-run
 *   node scripts/seedAiModels_capabilities_final.js
 *   node scripts/seedAiModels_capabilities_final.js --id=kling_o3_4k_ref2vid
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AiModel  = require('../model/schema/aiModel');

// ─── Verified schema data ─────────────────────────────────────────────────────
// Every value below came from the actual fal.ai OpenAPI JSON.
// Do NOT "guess" fields — if it's not in the schema JSON, don't add it.

const CAPABILITIES = [

  // ══════════════════════════════════════════════════════════════════════════
  // KLING O3 4K — Reference to Video
  // Slug: fal-ai/kling-video/o3/4k/reference-to-video
  // No required fields. Either prompt or multi_prompt (not both).
  // Prompt tokens: @Element1..N (elements), @Image1..N (image_urls)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'kling_o3_4k_ref2vid',
    capabilities: {
      uiVariant: 'ref2v_elements',   // default; UI also offers 'multi_shot' tab

      inputSlots: [
        // ── Elements (characters / objects) ──
        {
          key: 'elements', providerKey: 'elements', type: 'element_array',
          required: false, minItems: 0, maxItems: 7,
          uiLabel: 'Elements',
          uiHint: 'Reference in prompt as @Element1, @Element2. Each element: frontal photo + 1-3 ref images, OR one video clip.',
          uiOrder: 0,
          elementShape: {
            fields: [
              {
                key: 'frontal', providerKey: 'frontal_image_url', type: 'image',
                required: false,
                // Upload limits from schema
                uploadLimits: { maxFileSizeBytes: 10485760, minWidth: 300, minHeight: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
              },
              {
                key: 'references', providerKey: 'reference_image_urls', type: 'image_array',
                required: false, maxItems: 3,   // 1-3 per schema (NOT 4)
                uploadLimits: { maxFileSizeBytes: 10485760, minWidth: 300, minHeight: 300 },
              },
              {
                key: 'video', providerKey: 'video_url', type: 'video',
                required: false,
                // Video limits from schema
                uploadLimits: { maxFileSizeBytes: 209715200, minWidth: 720, minHeight: 720, maxWidth: 2160, maxHeight: 2160 },
              },
              {
                key: 'voiceId', providerKey: 'voice_id', type: 'string',
                required: false,
                // Only valid for video elements
              },
            ],
            oneOfGroups: [['frontal', 'references'], ['video']],
          },
        },

        // ── Global reference images ──
        {
          key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: false, minItems: 0, maxItems: 7,
          uiLabel: 'Reference images',
          uiHint: 'Style or appearance refs — reference in prompt as @Image1, @Image2. Combined with elements ≤ 7.',
          uiOrder: 1,
          uploadLimits: { maxFileSizeBytes: 10485760, minWidth: 300, minHeight: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
        },

        // ── Start / end frames ──
        {
          key: 'startFrame', providerKey: 'start_image_url', type: 'image',
          required: false,
          uiLabel: 'Start frame', uiHint: 'First frame of the video',
          uiOrder: 2,
          uploadLimits: { maxFileSizeBytes: 10485760, minWidth: 300, minHeight: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
        },
        {
          key: 'endFrame', providerKey: 'end_image_url', type: 'image',
          required: false,
          uiLabel: 'End frame', uiHint: 'Last frame — model interpolates between start and end',
          uiOrder: 3,
          uploadLimits: { maxFileSizeBytes: 10485760, minWidth: 300, minHeight: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
        },

        // ── Prompt (single shot) ──
        {
          key: 'prompt', providerKey: 'prompt', type: 'string',
          required: false, // either this or multiPrompt
          uiLabel: 'Prompt',
          uiHint: 'Use @Element1, @Image1 to reference uploads. Max 2500 chars.',
          uiOrder: 4,
        },

        // ── Multi-shot prompts ──
        // Each shot: { prompt: string, duration: string "1"-"15" }
        // NOTE: NO start/end frame per shot — only top-level start/end frames exist
        {
          key: 'multiPrompt', providerKey: 'multi_prompt',
          type: 'string_array_with_duration',
          required: false,
          uiLabel: 'Multi-shot prompts',
          uiHint: 'One row per shot. Each shot has its own prompt and duration. Elements/images apply globally.',
          uiOrder: 5,
          // Per-shot duration options
          shotDurationOptions: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15'],
          shotDurationDefault: '5',
        },

        // ── Params ──
        {
          key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          options: ['16:9', '9:16', '1:1'], default: '16:9',
          uiLabel: 'Aspect ratio', uiOrder: 6,
        },
        {
          // Global duration — only used in single-prompt mode
          // In multi_prompt mode, each shot has its own duration
          key: 'durationSec', providerKey: 'duration', type: 'enum',
          options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'],
          default: '5', coerceToString: true,
          uiLabel: 'Duration (single shot)', uiOrder: 7,
        },
        {
          key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
          default: false,  // Kling O3 default is FALSE
          uiLabel: 'Generate audio', uiOrder: 8,
        },
      ],

      constraints: [
        {
          type: 'sum_max',
          fields: ['elements', 'refImages'],
          value: 7,
          message: 'Elements + reference images cannot exceed 7 combined',
        },
        {
          type: 'requires_one_of',
          fields: ['prompt', 'multiPrompt'],
          message: 'Provide either a prompt or multi-shot prompts',
        },
        {
          type: 'mutual_exclusive',
          fields: ['prompt', 'multiPrompt'],
          message: 'Cannot use both prompt and multi-shot prompts — choose one',
        },
      ],

      promptTokens: {
        elementPattern: '@Element{N}',  // elements
        imagePattern:   '@Image{N}',    // image_urls
        sourceFields:   ['elements', 'refImages'],
      },

      supportsEndFrame:  true,
      supportsMultiShot: true,
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // HAPPY HORSE — Reference to Video
  // Slug: alibaba/happy-horse/reference-to-video
  // Required: prompt + image_urls
  // duration: INTEGER [3..15] — only model where it's not a string
  // tokens: character1..character9 (backtick format in prompt)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'happy_horse_ref2vid',
    capabilities: {
      uiVariant: 'ref2v',   // character token based

      inputSlots: [
        {
          key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: true, minItems: 1, maxItems: 9,
          uiLabel: 'Reference images',
          uiHint: 'Your subjects — 1-9 images. Order matters: first image = character1, second = character2, etc. Min 400px, max 10MB each.',
          uiOrder: 0,
          uploadLimits: { maxFileSizeBytes: 10485760 },
        },
        {
          key: 'prompt', providerKey: 'prompt', type: 'string',
          required: true,
          uiLabel: 'Prompt',
          uiHint: 'Reference subjects as character1, character2... (matches image order). Max 2500 chars.',
          uiOrder: 1,
        },
        {
          key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          // No "auto" for Happy Horse
          options: ['16:9', '9:16', '1:1', '4:3', '3:4'], default: '16:9',
          uiLabel: 'Aspect ratio', uiOrder: 2,
        },
        {
          key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['720p', '1080p'], default: '1080p',
          uiLabel: 'Resolution', uiOrder: 3,
        },
        {
          // INTEGER enum — different from all other models
          key: 'durationSec', providerKey: 'duration', type: 'enum_integer',
          options: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          default: 5, coerceToString: false,
          uiLabel: 'Duration', uiOrder: 4,
        },
      ],

      constraints: [],

      // UI token hints — character1, character2 style
      promptTokens: {
        pattern:     'character{N}',
        sourceField: 'refImages',
        maxN:        9,
      },
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // WAN 2.7 — Reference to Video
  // Slug: fal-ai/wan/v2.7/reference-to-video
  // Required: prompt only
  // duration: INTEGER [2..10] — shorter max than others
  // Field names: reference_image_urls, reference_video_urls (not image_urls/video_urls)
  // multi_shots: boolean toggle (intelligent segmentation, not per-shot control)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'wan_v27_ref2vid',
    capabilities: {
      uiVariant: 'ref2v',  // image + optional video refs, no audio, no elements

      inputSlots: [
        {
          // NOTE: providerKey is reference_image_urls, NOT image_urls
          key: 'refImages', providerKey: 'reference_image_urls', type: 'image_array',
          required: false, minItems: 0,
          uiLabel: 'Reference images',
          uiHint: 'Character or object references for appearance consistency. Multiple images for multi-subject. Max 20MB each.',
          uiOrder: 0,
          uploadLimits: { maxFileSizeBytes: 20971520 },
        },
        {
          // NOTE: providerKey is reference_video_urls, NOT video_urls
          key: 'refVideos', providerKey: 'reference_video_urls', type: 'video_array',
          required: false, minItems: 0,
          uiLabel: 'Reference videos',
          uiHint: 'Video references for motion/appearance. Max 100MB each, max 30s.',
          uiOrder: 1,
          uploadLimits: { maxFileSizeBytes: 104857600 },
        },
        {
          key: 'prompt', providerKey: 'prompt', type: 'string',
          required: true,
          uiLabel: 'Prompt', uiHint: 'Max 5000 characters.',
          uiOrder: 2,
        },
        {
          key: 'negativePrompt', providerKey: 'negative_prompt', type: 'string',
          required: false,
          uiLabel: 'Negative prompt', uiHint: 'What to avoid. Max 500 characters.',
          uiOrder: 3,
        },
        {
          key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          // No "auto" for Wan
          options: ['16:9', '9:16', '1:1', '4:3', '3:4'], default: '16:9',
          uiLabel: 'Aspect ratio', uiOrder: 4,
        },
        {
          key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['720p', '1080p'], default: '1080p',
          uiLabel: 'Resolution', uiOrder: 5,
        },
        {
          // INTEGER enum [2..10] — Wan max is 10s (shorter than other models)
          key: 'durationSec', providerKey: 'duration', type: 'enum_integer',
          options: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          default: 5, coerceToString: false,
          uiLabel: 'Duration', uiHint: 'Max 10 seconds.', uiOrder: 6,
        },
        {
          // multi_shots: boolean toggle — lets model decide shot boundaries
          key: 'multiShots', providerKey: 'multi_shots', type: 'boolean',
          default: false,
          uiLabel: 'Auto multi-shot',
          uiHint: 'Let Wan intelligently segment the video into multiple shots based on the prompt.',
          uiOrder: 7,
        },
      ],

      constraints: [],
      supportsNegativePrompt: true,
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SEEDANCE 2.0 — Image to Video (CORRECTED)
  // Slug: bytedance/seedance-2.0/image-to-video
  // Required: prompt + image_url (singular start frame)
  // Supports optional end_image_url interpolation
  // duration: STRING enum ["auto","4".."15"] — same as ref2vid
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'seedance_2_i2v',
    capabilities: {
      uiVariant: 'i2v_end',

      inputSlots: [
        {
          // SINGULAR image_url (start frame) — NOT an array
          key: 'startFrame', providerKey: 'image_url', type: 'image',
          required: true,
          uiLabel: 'Start frame', uiHint: 'JPEG/PNG/WebP, max 30MB.',
          uiOrder: 0,
          uploadLimits: { maxFileSizeBytes: 31457280 },
        },
        {
          key: 'endFrame', providerKey: 'end_image_url', type: 'image',
          required: false,
          uiLabel: 'End frame', uiHint: 'Optional last frame — video transitions from start to end.',
          uiOrder: 1,
          uploadLimits: { maxFileSizeBytes: 31457280 },
        },
        {
          key: 'prompt', providerKey: 'prompt', type: 'string',
          required: true,
          uiLabel: 'Prompt', uiHint: 'Describe the motion and action.',
          uiOrder: 2,
        },
        {
          key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          options: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
          default: 'auto',
          uiHint: 'Use "auto" to infer from the input image.',
          uiLabel: 'Aspect ratio', uiOrder: 3,
        },
        {
          // STRING enum — "auto" or "4"-"15"
          key: 'durationSec', providerKey: 'duration', type: 'enum',
          options: ['auto', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
          default: 'auto', coerceToString: false,
          uiLabel: 'Duration', uiOrder: 4,
        },
        {
          key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['480p', '720p', '1080p'], default: '720p',
          uiLabel: 'Resolution', uiOrder: 5,
        },
        {
          key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
          default: true,  // Seedance 2.0 default is TRUE
          uiLabel: 'Generate audio', uiOrder: 6,
        },
      ],

      constraints: [],
      supportsEndFrame: true,
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SEEDANCE 2.0 — Reference to Video (CORRECTED from previous file)
  // Slug: bytedance/seedance-2.0/reference-to-video
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'seedance_2_ref2vid',
    capabilities: {
      uiVariant: 'ref2v_mixed',

      inputSlots: [
        {
          key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: false, minItems: 0, maxItems: 9,
          uiLabel: 'Reference images',
          uiHint: 'Reference in prompt as @Image1, @Image2. JPEG/PNG/WebP, max 30MB each.',
          uiOrder: 0,
          uploadLimits: { maxFileSizeBytes: 31457280 },
        },
        {
          key: 'refVideos', providerKey: 'video_urls', type: 'video_array',
          required: false, minItems: 0, maxItems: 3,
          uiLabel: 'Reference videos',
          uiHint: 'Reference in prompt as @Video1. MP4/MOV, combined 2–15s, total max 50MB.',
          uiOrder: 1,
          uploadLimits: { maxFileSizeBytes: 52428800 },
        },
        {
          key: 'refAudios', providerKey: 'audio_urls', type: 'audio_array',
          required: false, minItems: 0, maxItems: 3,
          uiLabel: 'Reference audio',
          uiHint: 'Reference in prompt as @Audio1. MP3/WAV, combined max 15s, max 15MB each.',
          uiOrder: 2,
          uploadLimits: { maxFileSizeBytes: 15728640 },
        },
        {
          key: 'prompt', providerKey: 'prompt', type: 'string',
          required: true,
          uiLabel: 'Prompt',
          uiHint: 'Use @Image1, @Video1, @Audio1 to reference uploaded files.',
          uiOrder: 3,
        },
        {
          key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          options: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
          default: 'auto', uiLabel: 'Aspect ratio', uiOrder: 4,
        },
        {
          key: 'durationSec', providerKey: 'duration', type: 'enum',
          options: ['auto', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
          default: 'auto', coerceToString: false,
          uiLabel: 'Duration', uiOrder: 5,
        },
        {
          key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['480p', '720p', '1080p'], default: '720p',
          uiLabel: 'Resolution', uiOrder: 6,
        },
        {
          key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
          default: true, uiLabel: 'Generate audio', uiOrder: 7,
        },
      ],

      constraints: [
        {
          type: 'sum_max',
          fields: ['refImages', 'refVideos', 'refAudios'],
          value: 12,
          message: 'Total files (images + videos + audio) cannot exceed 12',
        },
      ],

      promptTokens: {
        imagePattern:  '@Image{N}',
        videoPattern:  '@Video{N}',
        audioPattern:  '@Audio{N}',
        sourceFields:  ['refImages', 'refVideos', 'refAudios'],
      },
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyId = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];
  const targets = onlyId ? CAPABILITIES.filter(m => m.id === onlyId) : CAPABILITIES;

  if (targets.length === 0) {
    console.error(`No model found for --id=${onlyId}`);
    process.exit(1);
  }

  let patched = 0, missing = 0, errors = 0;

  for (const { id, capabilities } of targets) {
    try {
      if (dryRun) {
        const exists = await AiModel.exists({ id });
        const slots = capabilities.inputSlots?.length || 0;
        console.log(`  ${exists ? '✓' : '✗'} [dry] ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(20)} ${slots} slots`);
        exists ? patched++ : missing++;
        continue;
      }

      const result = await AiModel.updateOne({ id }, { $set: { capabilities } });

      if (result.matchedCount === 0) {
        console.warn(`  ✗ NOT FOUND: ${id}`);
        missing++;
      } else {
        const slots = capabilities.inputSlots?.length || 0;
        console.log(`  ✓ ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(20)} ${slots} slots`);
        patched++;
      }
    } catch (err) {
      console.error(`  ✗ ERROR ${id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone — patched:${patched}  missing:${missing}  errors:${errors}`);
}

const url = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
const db  = process.env.DB    || 'qumak';

mongoose.connect(`${url}/${db}`)
  .then(run)
  .then(() => mongoose.disconnect())
  .catch(err => { console.error('Connect failed:', err.message); process.exit(1); });