// 'use strict';

// /**
//  * scripts/seedAiModels_addManifests.js
//  *
//  * Adds the new models (Kling O3, Seedance 2.0 i2v/ref2vid, Happy Horse,
//  * Wan 2.7) AND backfills capabilities.inputSlots on existing models.
//  *
//  * Idempotent — safe to re-run. Uses upsert ($setOnInsert) for new models,
//  * $set for the capabilities patch on existing rows.
//  *
//  *   node scripts/seedAiModels_addManifests.js               # apply
//  *   node scripts/seedAiModels_addManifests.js --dry-run     # preview
//  *   node scripts/seedAiModels_addManifests.js --id=<id>     # one model
//  */

// require('dotenv').config();
// const mongoose = require('mongoose');
// const AiModel  = require('../model/schema/aiModel');

// // Reusable slot factories
// const S = {
//   prompt:    (o = 0, req = true) => ({ key: 'prompt', providerKey: 'prompt', type: 'string', required: req, uiLabel: 'Prompt', uiOrder: o }),
//   startFrame:(o, req = false, providerKey = 'image_url') => ({ key: 'startFrame', providerKey, type: 'image', required: req, uiLabel: 'Start frame', uiOrder: o }),
//   endFrame:  (o, providerKey = 'end_image_url') => ({ key: 'endFrame', providerKey, type: 'image', required: false, uiLabel: 'End frame', uiHint: 'Optional last frame for interpolation', uiOrder: o }),
//   klingDur:  (o) => ({ key: 'durationSec', providerKey: 'duration', type: 'enum', options: ['5','10'], default: '5', coerceToString: true, uiLabel: 'Duration', uiOrder: o }),
//   klingDurO3:(o) => ({ key: 'durationSec', providerKey: 'duration', type: 'enum', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5', coerceToString: true, uiLabel: 'Duration (single shot)', uiOrder: o }),
//   klingAR:   (o) => ({ key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum', options: ['16:9','9:16','1:1'], default: '16:9', uiLabel: 'Aspect ratio', uiOrder: o }),
//   seedanceAR:(o) => ({ key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum', options: ['auto','21:9','16:9','4:3','1:1','3:4','9:16'], default: 'auto', uiLabel: 'Aspect ratio', uiOrder: o }),
//   hhAR:      (o) => ({ key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum', options: ['16:9','9:16','1:1','4:3','3:4'], default: '16:9', uiLabel: 'Aspect ratio', uiOrder: o }),
//   seedanceDur:(o) => ({ key: 'durationSec', providerKey: 'duration', type: 'enum', options: ['auto','4','5','6','7','8','9','10','11','12','13','14','15'], default: 'auto', coerceToString: false, uiLabel: 'Duration', uiOrder: o }),
//   hhDur:     (o) => ({ key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5, coerceToString: false, uiLabel: 'Duration', uiOrder: o }),
//   wanDur:    (o) => ({ key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [2,3,4,5,6,7,8,9,10], default: 5, coerceToString: false, uiLabel: 'Duration', uiHint: 'Max 10s', uiOrder: o }),
//   res:       (o, opts = ['480p','720p','1080p'], def = '720p') => ({ key: 'resolution', providerKey: 'resolution', type: 'enum', options: opts, default: def, uiLabel: 'Resolution', uiOrder: o }),
//   audio:     (o, def = false) => ({ key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean', default: def, uiLabel: 'Generate audio', uiOrder: o }),
//   fluxSize:  (o) => ({ key: 'imageSize', providerKey: 'image_size', type: 'enum', options: ['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9'], default: 'square_hd', uiLabel: 'Image size', uiOrder: o }),
//   numImages: (o) => ({ key: 'numImages', providerKey: 'num_images', type: 'integer', default: 1, uiLabel: 'Count', uiOrder: o }),
// };

// // ─── New models to upsert ───────────────────────────────────────────────────
// // Each one is a complete AiModel doc — these are NEW rows.

// const NEW_MODELS = [
//   // ── Kling O3 4K — premium ref2v with elements + multi-shot ────────────
//   {
//     id: 'kling_o3_4k_ref2vid',
//     label: 'Kling O3 4K',
//     shortLabel: 'Kling O3',
//     description: 'Premium 4K video with character elements and multi-shot narration.',
//     provider: 'fal',
//     falModelId: 'fal-ai/kling-video/o3/4k/reference-to-video',
//     falVideoModelId: 'fal-ai/kling-video/o3/4k/reference-to-video',
//     kind: 'video',
//     videoVariant: 'r2v',
//     supportsReferenceImage: true,
//     supportsCharacterLock: true,
//     supportsAudio: true,
//     supportedAspectRatios: ['16:9','9:16','1:1'],
//     supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
//     maxResolution: 2160,
//     creditsPerSecondVideo: 6,    // ~AED 3/sec retail @ 50% margin on $0.30/sec fal cost
//     baseCreditsForVideo: 0,
//     creditsPerImage: 0,
//     minPlan: 'pro',
//     isActive: true,
//     isDefault: false,
//     sortOrder: 5,
//     logoUrl: 'https://qumak.ai/models/kling-o3.png',
//     badge: 'Premium',
//     capabilities: {
//       uiVariant: 'ref2v_elements',
//       supportsEndFrame: true,
//       supportsMultiShot: true,
//       supportsSeed: true,
//       supportedResolutions: ['4k'],
//       providerParamMap: {
//         referenceImageUrl: 'start_image_url',
//         endFrameUrl: 'end_image_url',
//         duration: 'duration',
//         negativePrompt: 'negative_prompt',
//       },
//       requiredFields: [],
//       audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
//       promptTokens: { elementPattern: '@Element{N}', imagePattern: '@Image{N}', sourceFields: ['elements','refImages'] },
//       inputSlots: [
//         {
//           key: 'elements', providerKey: 'elements', type: 'element_array',
//           required: false, minItems: 0, maxItems: 7,
//           uiLabel: 'Elements (characters / objects)',
//           uiHint: 'Reference in prompt as @Element1, @Element2. Each: frontal photo + 1–3 references, OR one video clip.',
//           uiOrder: 0,
//           elementShape: {
//             fields: [
//               { key: 'frontal',    providerKey: 'frontal_image_url',    type: 'image',       required: false },
//               { key: 'references', providerKey: 'reference_image_urls', type: 'image_array', required: false, maxItems: 3 },
//               { key: 'video',      providerKey: 'video_url',            type: 'video',       required: false },
//               { key: 'voiceId',    providerKey: 'voice_id',             type: 'string',      required: false },
//             ],
//             oneOfGroups: [['frontal','references'], ['video']],
//           },
//         },
//         {
//           key: 'refImages', providerKey: 'image_urls', type: 'image_array',
//           required: false, maxItems: 7,
//           uiLabel: 'Reference images',
//           uiHint: 'Style/appearance refs. Reference as @Image1. Combined with elements ≤ 7.',
//           uiOrder: 1,
//         },
//         S.startFrame(2, false, 'start_image_url'),
//         S.endFrame(3, 'end_image_url'),
//         { key: 'prompt',      providerKey: 'prompt',      type: 'string', required: false, uiLabel: 'Prompt', uiHint: 'Use @Element1, @Image1 in your prompt. Max 2500 chars.', uiOrder: 4 },
//         {
//           key: 'multiPrompt', providerKey: 'multi_prompt', type: 'string_array_with_duration',
//           required: false,
//           uiLabel: 'Multi-shot prompts',
//           uiHint: 'One row per shot — each has its own prompt + duration. Elements & images apply to all shots.',
//           uiOrder: 5,
//         },
//         S.klingAR(6),
//         S.klingDurO3(7),
//         S.audio(8, false),
//       ],
//       constraints: [
//         { type: 'sum_max',         fields: ['elements','refImages'],    value: 7, message: 'Elements + reference images cannot exceed 7 combined' },
//         { type: 'requires_one_of', fields: ['prompt','multiPrompt'],              message: 'Provide either a prompt or multi-shot prompts' },
//         { type: 'mutual_exclusive',fields: ['prompt','multiPrompt'],              message: 'Cannot use both prompt and multi-shot prompts' },
//       ],
//     },
//   },

//   // ── Seedance 2.0 I2V — i2v with optional end frame, native audio ──────
//   {
//     id: 'seedance_2_i2v',
//     label: 'Seedance 2.0 (image-to-video)',
//     shortLabel: 'Seedance 2 I2V',
//     description: 'Premium image-to-video with start/end frame and native audio.',
//     provider: 'fal',
//     falModelId: 'bytedance/seedance-2.0/image-to-video',
//     falVideoModelId: 'bytedance/seedance-2.0/image-to-video',
//     kind: 'video',
//     videoVariant: 'i2v',
//     supportsReferenceImage: true,
//     supportsAudio: true,
//     supportedAspectRatios: ['auto','21:9','16:9','4:3','1:1','3:4','9:16'],
//     supportedDurations: [4,5,6,7,8,9,10,11,12,13,14,15],
//     maxResolution: 1080,
//     creditsPerSecondVideo: 4,
//     minPlan: 'starter',
//     isActive: true,
//     sortOrder: 10,
//     logoUrl: 'https://qumak.ai/models/seedance.png',
//     capabilities: {
//       uiVariant: 'i2v_with_end',
//       supportsEndFrame: true,
//       audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
//       inputSlots: [
//         S.startFrame(0, true, 'image_url'),
//         S.endFrame(1, 'end_image_url'),
//         S.prompt(2, true),
//         S.seedanceAR(3),
//         S.seedanceDur(4),
//         S.res(5),
//         S.audio(6, true),
//       ],
//       constraints: [],
//     },
//   },

//   // ── Seedance 2.0 Ref2Vid — image + video + audio refs ──────────────────
//   {
//     id: 'seedance_2_ref2vid',
//     label: 'Seedance 2.0 (ref-to-video)',
//     shortLabel: 'Seedance 2 R2V',
//     description: 'Mixed-reference video — combine images, videos, and audio in one prompt.',
//     provider: 'fal',
//     falModelId: 'bytedance/seedance-2.0/reference-to-video',
//     falVideoModelId: 'bytedance/seedance-2.0/reference-to-video',
//     kind: 'video',
//     videoVariant: 'r2v',
//     supportsReferenceImage: true,
//     supportsAudio: true,
//     supportedAspectRatios: ['auto','21:9','16:9','4:3','1:1','3:4','9:16'],
//     supportedDurations: [4,5,6,7,8,9,10,11,12,13,14,15],
//     maxResolution: 1080,
//     creditsPerSecondVideo: 5,
//     minPlan: 'pro',
//     isActive: true,
//     sortOrder: 11,
//     logoUrl: 'https://qumak.ai/models/seedance.png',
//     badge: 'New',
//     capabilities: {
//       uiVariant: 'ref2v_with_video_refs',
//       audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
//       promptTokens: { imagePattern: '@Image{N}', videoPattern: '@Video{N}', audioPattern: '@Audio{N}', sourceFields: ['refImages','refVideos','refAudios'] },
//       inputSlots: [
//         { key: 'refImages', providerKey: 'image_urls', type: 'image_array', required: false, maxItems: 9, uiLabel: 'Reference images', uiHint: 'Reference as @Image1. Max 30MB each.', uiOrder: 0 },
//         { key: 'refVideos', providerKey: 'video_urls', type: 'video_array', required: false, maxItems: 3, uiLabel: 'Reference videos', uiHint: 'Reference as @Video1. Combined 2–15s, 50MB total.', uiOrder: 1 },
//         { key: 'refAudios', providerKey: 'audio_urls', type: 'audio_array', required: false, maxItems: 3, uiLabel: 'Reference audio', uiHint: 'Reference as @Audio1. MP3/WAV, combined ≤15s.', uiOrder: 2 },
//         S.prompt(3, true),
//         S.seedanceAR(4),
//         S.seedanceDur(5),
//         S.res(6),
//         S.audio(7, true),
//       ],
//       constraints: [
//         { type: 'sum_max', fields: ['refImages','refVideos','refAudios'], value: 12, message: 'Total files (images + videos + audio) cannot exceed 12' },
//       ],
//     },
//   },

//   // ── Happy Horse — multi-character ref2v with character tokens ────────
//   {
//     id: 'happy_horse_ref2vid',
//     label: 'Happy Horse (multi-character)',
//     shortLabel: 'Happy Horse',
//     description: 'Multi-character video. Reference your subjects as character1, character2, etc.',
//     provider: 'fal',
//     falModelId: 'alibaba/happy-horse/reference-to-video',
//     falVideoModelId: 'alibaba/happy-horse/reference-to-video',
//     kind: 'video',
//     videoVariant: 'r2v',
//     supportsReferenceImage: true,
//     supportsCharacterLock: true,
//     supportsAudio: false,
//     supportedAspectRatios: ['16:9','9:16','1:1','4:3','3:4'],
//     supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
//     maxResolution: 1080,
//     creditsPerSecondVideo: 4,
//     minPlan: 'starter',
//     isActive: true,
//     sortOrder: 12,
//     logoUrl: 'https://qumak.ai/models/happy-horse.png',
//     capabilities: {
//       uiVariant: 'ref2v_multi_image',
//       promptTokens: { pattern: 'character{N}', sourceField: 'refImages', maxN: 9 },
//       inputSlots: [
//         { key: 'refImages', providerKey: 'image_urls', type: 'image_array', required: true, minItems: 1, maxItems: 9, uiLabel: 'Subject images', uiHint: 'Order matters: first image = character1, second = character2. Min 400px, max 10MB each.', uiOrder: 0 },
//         { key: 'prompt', providerKey: 'prompt', type: 'string', required: true, uiLabel: 'Prompt', uiHint: 'Reference subjects as character1, character2... Max 2500 chars.', uiOrder: 1 },
//         S.hhAR(2),
//         S.res(3, ['720p','1080p'], '1080p'),
//         S.hhDur(4),
//       ],
//       constraints: [],
//     },
//   },

//   // ── Wan 2.7 — multi-subject ref2v + auto multi-shot ──────────────────
//   {
//     id: 'wan_v27_ref2vid',
//     label: 'Wan 2.7',
//     shortLabel: 'Wan 2.7',
//     description: 'Multi-subject reference-to-video with optional auto multi-shot segmentation.',
//     provider: 'fal',
//     falModelId: 'fal-ai/wan/v2.7/reference-to-video',
//     falVideoModelId: 'fal-ai/wan/v2.7/reference-to-video',
//     kind: 'video',
//     videoVariant: 'r2v',
//     supportsReferenceImage: true,
//     supportsAudio: false,
//     supportedAspectRatios: ['16:9','9:16','1:1','4:3','3:4'],
//     supportedDurations: [2,3,4,5,6,7,8,9,10],
//     maxResolution: 1080,
//     creditsPerSecondVideo: 4,
//     minPlan: 'starter',
//     isActive: true,
//     sortOrder: 13,
//     logoUrl: 'https://qumak.ai/models/wan.png',
//     badge: 'New',
//     capabilities: {
//       uiVariant: 'ref2v_with_video_refs',
//       supportsNegativePrompt: true,
//       supportsMultiShot: true,
//       providerParamMap: {
//         referenceImageUrl: 'reference_image_urls',
//         negativePrompt: 'negative_prompt',
//       },
//       inputSlots: [
//         { key: 'refImages', providerKey: 'reference_image_urls', type: 'image_array', required: false, uiLabel: 'Reference images', uiHint: 'Character/object refs. Max 20MB each.', uiOrder: 0 },
//         { key: 'refVideos', providerKey: 'reference_video_urls', type: 'video_array', required: false, uiLabel: 'Reference videos', uiHint: 'Motion/appearance ref. Max 100MB, 30s each.', uiOrder: 1 },
//         S.prompt(2, true),
//         { key: 'negativePrompt', providerKey: 'negative_prompt', type: 'string', required: false, uiLabel: 'Negative prompt', uiHint: 'Max 500 chars.', uiOrder: 3 },
//         S.hhAR(4),
//         S.res(5, ['720p','1080p'], '1080p'),
//         S.wanDur(6),
//         { key: 'multiShots', providerKey: 'multi_shots', type: 'boolean', default: false, uiLabel: 'Auto multi-shot', uiHint: 'Let the model intelligently segment into multiple shots.', uiOrder: 7 },
//       ],
//       constraints: [],
//     },
//   },
// ];

// // ─── Capability backfill for existing models ────────────────────────────────
// // $set only the capabilities.* fields — does NOT overwrite the rest of the doc.

// const EXISTING_PATCHES = [
//   // Kling T2V family
//   ...['kling_v1_standard_t2v','kling_v1_6_standard_t2v','kling_v2_1_standard_t2v',
//       'kling_v2_1_pro_t2v','kling_v2_5_standard_t2v','kling_v2_5_pro_t2v',
//       'kling_v2_6_standard_t2v','kling_v2_6_pro_t2v'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 't2v_simple',
//       supportsNegativePrompt: true,
//       supportsSeed: true,
//       inputSlots: [
//         S.prompt(0, true),
//         { key: 'negativePrompt', providerKey: 'negative_prompt', type: 'string', required: false, uiLabel: 'Negative prompt', uiOrder: 1 },
//         S.klingAR(2),
//         S.klingDur(3),
//       ],
//       constraints: [],
//     },
//   })),

//   // Kling I2V standard (no end frame)
//   ...['kling_v1_standard_i2v','kling_v1_6_standard_i2v','kling_v2_1_standard_i2v',
//       'kling_v2_5_standard_i2v','kling_v2_6_standard_i2v'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 'i2v_simple',
//       supportsNegativePrompt: true,
//       inputSlots: [
//         S.startFrame(0, true, 'image_url'),
//         S.prompt(1, true),
//         { key: 'negativePrompt', providerKey: 'negative_prompt', type: 'string', required: false, uiLabel: 'Negative prompt', uiOrder: 2 },
//         S.klingAR(3),
//         S.klingDur(4),
//       ],
//       constraints: [],
//     },
//   })),

//   // Kling I2V pro (with end frame)
//   ...['kling_v2_1_pro_i2v','kling_v2_5_pro_i2v','kling_v2_6_pro_i2v'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 'i2v_with_end',
//       supportsEndFrame: true,
//       inputSlots: [
//         S.startFrame(0, true, 'image_url'),
//         S.endFrame(1, 'tail_image_url'),
//         S.prompt(2, true),
//         S.klingAR(3),
//         S.klingDur(4),
//       ],
//       constraints: [],
//     },
//   })),

//   // Flux T2I family
//   ...['flux_schnell','flux_dev','flux_pro','flux_pro_v1_1','flux_pro_v1_1_ultra','seedream_v4'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 't2i_simple',
//       inputSlots: [ S.prompt(0, true), S.fluxSize(1), S.numImages(2) ],
//       constraints: [],
//     },
//   })),

//   // Flux I2I / Kontext
//   { id: 'flux_dev_i2i',  capabilities: { uiVariant: 'i2i_edit', inputSlots: [
//     S.startFrame(0, true, 'image_url'), S.prompt(1, true),
//     { key: 'strength', providerKey: 'strength', type: 'number', default: 0.85, uiLabel: 'Edit strength', uiHint: '0 = preserve, 1 = full repaint', uiOrder: 2 },
//   ], constraints: [] }},
//   { id: 'flux_kontext',  capabilities: { uiVariant: 'i2i_edit', inputSlots: [
//     S.startFrame(0, true, 'image_url'), S.prompt(1, true),
//   ], constraints: [] }},

//   // Seedance v1 / v1.5
//   ...['seedance_v1_pro_t2v','seedance_v1_5_pro_t2v'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 't2v_simple',
//       inputSlots: [
//         S.prompt(0, true),
//         S.klingAR(1),
//         { key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [5,10], default: 5, uiLabel: 'Duration', uiOrder: 2 },
//         S.res(3, ['480p','580p','720p','1080p']),
//       ],
//       constraints: [],
//     },
//   })),
//   ...['seedance_v1_pro_i2v','seedance_v1_5_pro_i2v'].map(id => ({
//     id,
//     capabilities: {
//       uiVariant: 'i2v_simple',
//       inputSlots: [
//         S.startFrame(0, true, 'image_url'),
//         S.prompt(1, true),
//         S.klingAR(2),
//         { key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [5,10], default: 5, uiLabel: 'Duration', uiOrder: 3 },
//         S.res(4, ['480p','580p','720p','1080p']),
//       ],
//       constraints: [],
//     },
//   })),

//   // Pixverse
//   { id: 'pixverse_c1_t2v', capabilities: { uiVariant: 't2v_simple', inputSlots: [
//     S.prompt(0, true),
//     { key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum', options: ['16:9','9:16','1:1','4:3'], default: '16:9', uiLabel: 'Aspect ratio', uiOrder: 1 },
//     { key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [4,8], default: 4, uiLabel: 'Duration', uiOrder: 2 },
//   ], constraints: [] }},
//   { id: 'pixverse_c1_i2v', capabilities: { uiVariant: 'i2v_simple', inputSlots: [
//     S.startFrame(0, true, 'image_url'),
//     S.prompt(1, true),
//     { key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum', options: ['16:9','9:16','1:1','4:3'], default: '16:9', uiLabel: 'Aspect ratio', uiOrder: 2 },
//     { key: 'durationSec', providerKey: 'duration', type: 'enum_integer', options: [4,8], default: 4, uiLabel: 'Duration', uiOrder: 3 },
//   ], constraints: [] }},
// ];

// async function run() {
//   const dryRun = process.argv.includes('--dry-run');
//   const onlyId = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];

//   let inserted = 0, updated = 0, missing = 0, errors = 0;

//   // Step 1: Upsert NEW models
//   console.log('\n── New models ──');
//   for (const model of NEW_MODELS) {
//     if (onlyId && model.id !== onlyId) continue;
//     try {
//       if (dryRun) {
//         const exists = await AiModel.exists({ id: model.id });
//         console.log(`  ${exists ? '~' : '+'} [dry] ${model.id.padEnd(36)} ${model.capabilities.uiVariant.padEnd(22)} ${model.capabilities.inputSlots.length} slots`);
//         continue;
//       }
//       const result = await AiModel.updateOne(
//         { id: model.id },
//         { $set: model },
//         { upsert: true },
//       );
//       if (result.upsertedId) { console.log(`  + ${model.id} INSERTED`); inserted++; }
//       else { console.log(`  ~ ${model.id} updated`); updated++; }
//     } catch (err) {
//       console.error(`  ✗ ${model.id}: ${err.message}`);
//       errors++;
//     }
//   }

//   // Step 2: Patch EXISTING models with capabilities
//   console.log('\n── Capability patches (existing models) ──');
//   for (const { id, capabilities } of EXISTING_PATCHES) {
//     if (onlyId && id !== onlyId) continue;
//     try {
//       if (dryRun) {
//         const exists = await AiModel.exists({ id });
//         console.log(`  ${exists ? '~' : '✗'} [dry] ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(22)} ${capabilities.inputSlots.length} slots`);
//         if (!exists) missing++; else updated++;
//         continue;
//       }
//       const setObj = {};
//       for (const [k, v] of Object.entries(capabilities)) setObj[`capabilities.${k}`] = v;
//       const result = await AiModel.updateOne({ id }, { $set: setObj });
//       if (result.matchedCount === 0) { console.warn(`  ✗ NOT FOUND: ${id}`); missing++; }
//       else { console.log(`  ~ ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(22)} ${capabilities.inputSlots.length} slots`); updated++; }
//     } catch (err) {
//       console.error(`  ✗ ${id}: ${err.message}`);
//       errors++;
//     }
//   }

//   console.log(`\nDone — inserted:${inserted}  updated:${updated}  missing:${missing}  errors:${errors}`);
//   if (missing > 0) console.log('Missing rows: add them to your main seedAiModels.js first.');
// }

// const url = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
// const db  = process.env.DB    || 'qumak';
// mongoose.connect(`${url}/${db}`)
//   .then(run)
//   .then(() => mongoose.disconnect())
//   .catch(err => { console.error('Connect failed:', err.message); process.exit(1); });





'use strict';

/**
 * scripts/seedAiModels_addManifests.js
 *
 * Aligned to REAL fal OpenAPI schemas (verified May 2026).
 * Patches every active fal model in your DB with the correct inputSlots,
 * and inserts the 4 new models (Kling O3, Seedance 2 ref2vid, Happy Horse,
 * Wan 2.7).
 *
 *   node scripts/seedAiModels_addManifests.js               # apply
 *   node scripts/seedAiModels_addManifests.js --dry-run     # preview
 *   node scripts/seedAiModels_addManifests.js --id=<id>     # one model
 *
 * PRE-FLIGHT — required ONCE before this script can write nested elementShape:
 * In model/schema/aiModel.js, ensure inputSlots/constraints are Mixed:
 *
 *   inputSlots:  [{ type: mongoose.Schema.Types.Mixed }],
 *   constraints: [{ type: mongoose.Schema.Types.Mixed }],
 *
 * Without that, Mongoose throws CastError on the Kling O3 elements field.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AiModel  = require('../model/schema/aiModel');

// ─── Slot factories — every helper matches a real fal field shape ──────────
const S = {
  // Generic
  prompt:     (o, req = true) => ({
    key: 'prompt', providerKey: 'prompt', type: 'string', required: req,
    uiLabel: 'Prompt', uiOrder: o,
  }),
  negPrompt:  (o) => ({
    key: 'negativePrompt', providerKey: 'negative_prompt', type: 'string',
    required: false, uiLabel: 'Negative prompt', uiOrder: o,
  }),
  startFrame: (o, req = false, providerKey = 'image_url') => ({
    key: 'startFrame', providerKey, type: 'image', required: req,
    uiLabel: 'Start frame', uiOrder: o,
  }),
  endFrame:   (o, providerKey = 'end_image_url') => ({
    key: 'endFrame', providerKey, type: 'image', required: false,
    uiLabel: 'End frame', uiHint: 'Optional last frame for interpolation', uiOrder: o,
  }),
  seed:       (o) => ({
    key: 'seed', providerKey: 'seed', type: 'integer', required: false,
    uiLabel: 'Seed', uiHint: 'Same seed → same output', uiOrder: o,
  }),
  outputFormat: (o, def = 'png') => ({
    key: 'outputFormat', providerKey: 'output_format', type: 'enum',
    options: ['jpeg','png','webp'], default: def, uiLabel: 'Format', uiOrder: o,
  }),

  // Kling
  klingDur:   (o) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum',
    options: ['5','10'], default: '5', coerceToString: true,
    uiLabel: 'Duration', uiOrder: o,
  }),
  klingDurO3: (o) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum',
    options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'],
    default: '5', coerceToString: true,
    uiLabel: 'Duration (single shot)', uiOrder: o,
  }),
  klingAR:    (o) => ({
    key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
    options: ['16:9','9:16','1:1'], default: '16:9',
    uiLabel: 'Aspect ratio', uiOrder: o,
  }),

  // Seedance 2.0 (matches real OpenAPI: STRING duration, auto/4..15)
  seedanceAR:    (o) => ({
    key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
    options: ['auto','21:9','16:9','4:3','1:1','3:4','9:16'], default: 'auto',
    uiLabel: 'Aspect ratio', uiOrder: o,
  }),
  seedanceDur:   (o) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum',
    options: ['auto','4','5','6','7','8','9','10','11','12','13','14','15'],
    default: 'auto', coerceToString: true,
    uiLabel: 'Duration', uiOrder: o,
  }),
  // Seedance FAST tier: 480p/720p only (verified)
  seedanceFastRes: (o) => ({
    key: 'resolution', providerKey: 'resolution', type: 'enum',
    options: ['480p','720p'], default: '720p',
    uiLabel: 'Resolution', uiOrder: o,
  }),
  // Seedance FULL tier: 480p/720p/1080p
  seedanceProRes:  (o) => ({
    key: 'resolution', providerKey: 'resolution', type: 'enum',
    options: ['480p','720p','1080p'], default: '1080p',
    uiLabel: 'Resolution', uiOrder: o,
  }),
  audio: (o, def = true) => ({
    key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
    default: def, uiLabel: 'Generate audio',
    uiHint: 'Native audio: lip-sync, ambient, SFX', uiOrder: o,
  }),

  // Happy Horse / Wan 2.7
  hhAR:   (o) => ({
    key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
    options: ['16:9','9:16','1:1','4:3','3:4'], default: '16:9',
    uiLabel: 'Aspect ratio', uiOrder: o,
  }),
  hhDur:  (o) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum_integer',
    options: [3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5,
    coerceToString: false, uiLabel: 'Duration', uiOrder: o,
  }),
  wanDur: (o) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum_integer',
    options: [2,3,4,5,6,7,8,9,10], default: 5, coerceToString: false,
    uiLabel: 'Duration', uiHint: 'Max 10s', uiOrder: o,
  }),

  // Pixverse
  pixverseAR:  (o) => ({
    key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
    options: ['16:9','9:16','1:1'], default: '16:9',
    uiLabel: 'Aspect ratio', uiOrder: o,
  }),
  pixverseDur: (o, opts = [5,8,15]) => ({
    key: 'durationSec', providerKey: 'duration', type: 'enum_integer',
    options: opts, default: opts[0], coerceToString: false,
    uiLabel: 'Duration', uiOrder: o,
  }),

  // Flux image
  fluxSize: (o) => ({
    key: 'imageSize', providerKey: 'image_size', type: 'enum',
    options: ['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9'],
    default: 'square_hd', uiLabel: 'Image size', uiOrder: o,
  }),
  numImages: (o, max = 4, def = 1) => ({
    key: 'numImages', providerKey: 'num_images', type: 'integer',
    default: def, min: 1, max, uiLabel: 'Count', uiOrder: o,
  }),

  // Seedream v4 / v4.5 (image_size includes auto_2K, auto_4K)
  seedreamSize: (o, def = 'auto_2K') => ({
    key: 'imageSize', providerKey: 'image_size', type: 'enum',
    options: ['square_hd','square','portrait_4_3','portrait_16_9',
              'landscape_4_3','landscape_16_9','auto','auto_2K','auto_4K'],
    default: def, uiLabel: 'Image size', uiOrder: o,
  }),
  seedreamMaxImages: (o) => ({
    key: 'maxImages', providerKey: 'max_images', type: 'integer',
    default: 1, min: 1, max: 6,
    uiLabel: 'Max per gen', uiHint: 'Multi-image cap (1–6)', uiOrder: o,
  }),

  // GPT Image 1.5 edit (NON-standard image_size!)
  gptImageSize: (o) => ({
    key: 'imageSize', providerKey: 'image_size', type: 'enum',
    options: ['auto','1024x1024','1536x1024','1024x1536'], default: 'auto',
    uiLabel: 'Image size', uiOrder: o,
  }),
  gptQuality: (o) => ({
    key: 'quality', providerKey: 'quality', type: 'enum',
    options: ['low','medium','high'], default: 'high',
    uiLabel: 'Quality', uiOrder: o,
  }),
  gptBackground: (o) => ({
    key: 'background', providerKey: 'background', type: 'enum',
    options: ['auto','transparent','opaque'], default: 'auto',
    uiLabel: 'Background', uiOrder: o,
  }),
  gptInputFidelity: (o) => ({
    key: 'inputFidelity', providerKey: 'input_fidelity', type: 'enum',
    options: ['low','high'], default: 'high',
    uiLabel: 'Input fidelity', uiOrder: o,
  }),

  // Nano Banana 2 (extreme aspect ratios + resolution enum)
  nanoBananaAR:  (o) => ({
    key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
    options: ['auto','21:9','16:9','3:2','4:3','5:4','1:1','4:5','3:4','2:3','9:16','4:1','1:4','8:1','1:8'],
    default: 'auto', uiLabel: 'Aspect ratio', uiOrder: o,
  }),
  nanoBananaRes: (o) => ({
    key: 'resolution', providerKey: 'resolution', type: 'enum',
    options: ['0.5K','1K','2K','4K'], default: '1K',
    uiLabel: 'Resolution', uiOrder: o,
  }),

  // Clarity Upscaler — number knobs with min/max
  upscaleFactor: (o) => ({
    key: 'upscaleFactor', providerKey: 'upscale_factor', type: 'number',
    default: 2, min: 1, max: 4, uiLabel: 'Upscale factor', uiOrder: o,
  }),
  creativity:    (o) => ({
    key: 'creativity', providerKey: 'creativity', type: 'number',
    default: 0.35, min: 0, max: 1,
    uiLabel: 'Creativity', uiHint: 'Higher = more deviation from prompt', uiOrder: o,
  }),
  resemblance:   (o) => ({
    key: 'resemblance', providerKey: 'resemblance', type: 'number',
    default: 0.6, min: 0, max: 1,
    uiLabel: 'Resemblance', uiHint: 'Higher = closer to original', uiOrder: o,
  }),
  guidanceScale: (o, def = 4) => ({
    key: 'guidanceScale', providerKey: 'guidance_scale', type: 'number',
    default: def, min: 0, max: 20,
    uiLabel: 'Guidance scale', uiOrder: o,
  }),
  numInfSteps:   (o, def = 18, max = 50) => ({
    key: 'numInferenceSteps', providerKey: 'num_inference_steps', type: 'integer',
    default: def, min: 4, max,
    uiLabel: 'Inference steps', uiOrder: o,
  }),
};

// ─── New models to insert ──────────────────────────────────────────────────

const NEW_MODELS = [
  // ── Kling O3 4K — premium ref2v with elements + multi-shot ────────────
  {
    id: 'kling_o3_4k_ref2v',
    label: 'Kling O3 4K',
    shortLabel: 'Kling O3',
    description: 'Premium 4K video with character elements and multi-shot narration.',
    provider: 'fal',
    falModelId: 'fal-ai/kling-video/o3/4k/reference-to-video',
    falVideoModelId: 'fal-ai/kling-video/o3/4k/reference-to-video',
    kind: 'video',
    videoVariant: 'r2v',
    supportsReferenceImage: true,
    supportsCharacterLock: true,
    supportsAudio: true,
    supportedAspectRatios: ['16:9','9:16','1:1'],
    supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
    maxResolution: 2160,
    creditsPerSecondVideo: 6,
    baseCreditsForVideo: 0,
    creditsPerImage: 0,
    minPlan: 'pro',
    isActive: true,
    isDefault: false,
    sortOrder: 5,
    logoUrl: 'https://d1735p3aqhycef.cloudfront.net/aigc-web/public/ai-image-creation/models/kling.png',
    badge: 'Premium',
    capabilities: {
      uiVariant: 'ref2v_elements',
      supportsEndFrame: true,
      supportsMultiShot: true,
      supportsSeed: true,
      supportedResolutions: ['4k'],
      providerParamMap: {
        referenceImageUrl: 'start_image_url',
        endFrameUrl: 'end_image_url',
        duration: 'duration',
        negativePrompt: 'negative_prompt',
      },
      requiredFields: [],
      audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
      promptTokens: {
        elementPattern: '@Element{N}',
        imagePattern: '@Image{N}',
        sourceFields: ['elements','refImages'],
      },
      inputSlots: [
        {
          key: 'elements', providerKey: 'elements', type: 'element_array',
          required: false, minItems: 0, maxItems: 7,
          uiLabel: 'Elements (characters / objects)',
          uiHint: 'Reference as @Element1, @Element2. Each: frontal photo + 1–3 references, OR one video clip.',
          uiOrder: 0,
          elementShape: {
            fields: [
              { key: 'frontal',    providerKey: 'frontal_image_url',    type: 'image',       required: false },
              { key: 'references', providerKey: 'reference_image_urls', type: 'image_array', required: false, maxItems: 3 },
              { key: 'video',      providerKey: 'video_url',            type: 'video',       required: false },
              { key: 'voiceId',    providerKey: 'voice_id',             type: 'string',      required: false },
            ],
            oneOfGroups: [['frontal','references'], ['video']],
          },
        },
        {
          key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: false, maxItems: 7,
          uiLabel: 'Reference images',
          uiHint: 'Style/appearance refs. @Image1 in prompt. Combined with elements ≤ 7.',
          uiOrder: 1,
        },
        // S.startFrame(2, false, 'start_image_url'),
        // S.endFrame(3, 'end_image_url'),
        {
          key: 'prompt', providerKey: 'prompt', type: 'string', required: false,
          uiLabel: 'Prompt',
          uiHint: 'Use @Element1, @Image1 in your prompt. Max 2500 chars.',
          uiOrder: 2,
        },
        {
          key: 'multiPrompt', providerKey: 'multi_prompt', type: 'string_array_with_duration',
          required: false,
          uiLabel: 'Multi-shot prompts',
          uiHint: 'One row per shot. Elements & images apply to all shots.',
          uiOrder: 3,
        },
        S.klingAR(4),
        S.klingDurO3(5),
        S.audio(6, false),
      ],
      constraints: [
        { type: 'sum_max',          fields: ['elements','refImages'], value: 7,
          message: 'Elements + reference images cannot exceed 7 combined' },
        { type: 'requires_one_of',  fields: ['prompt','multiPrompt'],
          message: 'Provide either a prompt or multi-shot prompts' },
        { type: 'mutual_exclusive', fields: ['prompt','multiPrompt'],
          message: 'Cannot use both prompt and multi-shot prompts' },
      ],
    },
  },
  {
  id: 'kling_o3_4k_t2v',
  shortLabel: 'Kling O3 4K T2V',
  description: 'Premium 4K video with text to video.',
  videoVariant: 't2v',
  supportsCharacterLock: true,
  kind: 'video',
  provider: 'fal',
  falModelId: 'fal-ai/kling-video/o3/4k/text-to-video',
  falVideoModelId: 'fal-ai/kling-video/o3/4k/text-to-video',
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
  creditsPerSecondVideo: 6,
  supportsAudio: true,
  supportsReferenceImage: false, 
    maxResolution: 2160,
    baseCreditsForVideo: 0,
    creditsPerImage: 0,
    minPlan: 'pro',
    isActive: true,
    isDefault: false,
    sortOrder: 5,
    logoUrl: 'https://d1735p3aqhycef.cloudfront.net/aigc-web/public/ai-image-creation/models/kling.png',
    badge: 'Premium',
    capabilities: {
      uiVariant: 't2v',
      supportsMultiShot: true,
      supportsSeed: true,
      supportedResolutions: ['4k'],
      requiredFields: [],
      audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
      inputSlots: [
        { key: 'prompt', providerKey: 'prompt', type: 'string', uiOrder: 0 },
        { key: 'multiPrompt', providerKey: 'multi_prompt', type: 'string_array_with_duration', uiOrder: 1 },
        { key: 'aspectRatio', providerKey: 'aspect_ratio', type: 'enum',
          options: ['16:9','9:16','1:1'], default: '16:9', uiOrder: 2 },
        { key: 'durationSec', providerKey: 'duration', type: 'enum',
          options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'],
          default: '5', coerceToString: true, uiOrder: 3 },
        { key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
          default: false, uiOrder: 4 },
      ],
      constraints: [
        { type: 'requires_one_of', fields: ['prompt','multiPrompt'],
          message: 'Provide either a prompt or multi-shot prompts' },
        { type: 'mutual_exclusive', fields: ['prompt','multiPrompt'],
          message: 'Cannot use both prompt and multi-shot prompts' },
      ],
    },
  },
  {
  id: 'kling_o3_4k_i2v',
  shortLabel: 'Kling O3 4K I2V',
  description: 'Premium 4K video with image to video.',
  videoVariant: 'i2v',
  supportsCharacterLock: true,
  kind: 'video',
  family: 'kling_o3',
  tier: '4k',
  mode: 'i2v',
  provider: 'fal',
  falModelId: 'fal-ai/kling-video/o3/4k/image-to-video',
  falVideoModelId: 'fal-ai/kling-video/o3/4k/image-to-video',
  // supportedAspectRatios: ['16:9', '9:16', '1:1'],
  supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
  creditsPerSecondVideo: 6,
  supportsAudio: true,
  supportsReferenceImage: false, 
    maxResolution: 2160,
    baseCreditsForVideo: 0,
    creditsPerImage: 0,
    minPlan: 'pro',
    isActive: true,
    isDefault: false,
    sortOrder: 5,
    logoUrl: 'https://d1735p3aqhycef.cloudfront.net/aigc-web/public/ai-image-creation/models/kling.png',
    badge: 'Premium',
    capabilities: {
      uiVariant: 'i2v_with_end',
      supportsMultiShot: true,
      supportsSeed: true,
      supportedResolutions: ['4k'],
      requiredFields: [],
      audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
      inputSlots: [
        { key: 'prompt', providerKey: 'prompt', type: 'string', uiLabel: 'Prompt' },
        { key: 'multiPrompt', providerKey: 'multi_prompt', type: 'string_array_with_duration',
          uiLabel: 'Multi-shot', options: ['3','4','5','6','7','8','9','10'] },
        { key: 'startFrame', providerKey: 'image_url', type: 'image', required: true,
          uiLabel: 'Start frame' },
        { key: 'endFrame', providerKey: 'end_image_url', type: 'image',
          uiLabel: 'End frame (optional)' },
        { key: 'durationSec', providerKey: 'duration', type: 'enum', coerceToString: true,
          options: ['5','10'], default: '5', uiLabel: 'Duration' },
        { key: 'generateAudio', providerKey: 'generate_audio', type: 'boolean',
          default: false, uiLabel: 'Audio' },
        // Note: NO aspectRatio — i2v derives from image
      ],
      constraints: [
        { type: 'requires_one_of', fields: ['prompt', 'multiPrompt'],
          message: 'Provide a prompt or multi-shot list' },
        { type: 'mutual_exclusive', fields: ['prompt', 'multiPrompt'] },
      ],
    },
  },

  // ── Seedance 2.0 Ref-to-Video — image + video + audio refs ────────────
  {
    id: 'seedance_2_ref2vid',
    label: 'Seedance 2.0 (ref-to-video)',
    shortLabel: 'Seedance 2 R2V',
    description: 'Mixed-reference video — combine images, videos, and audio in one prompt.',
    provider: 'fal',
    falModelId: 'bytedance/seedance-2.0/reference-to-video',
    falVideoModelId: 'bytedance/seedance-2.0/reference-to-video',
    kind: 'video',
    videoVariant: 'r2v',
    supportsReferenceImage: true,
    supportsAudio: true,
    supportedAspectRatios: ['auto','21:9','16:9','4:3','1:1','3:4','9:16'],
    supportedDurations: [4,5,6,7,8,9,10,11,12,13,14,15],
    maxResolution: 1080,
    creditsPerSecondVideo: 5,
    minPlan: 'pro',
    isActive: true,
    sortOrder: 11,
    logoUrl: 'https://seedance2.ai/logo.png',
    badge: 'New',
    capabilities: {
      uiVariant: 'ref2v_with_video_refs',
      audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
      promptTokens: {
        imagePattern: '@Image{N}', videoPattern: '@Video{N}', audioPattern: '@Audio{N}',
        sourceFields: ['refImages','refVideos','refAudios'],
      },
      inputSlots: [
        { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: false, maxItems: 9,
          uiLabel: 'Reference images', uiHint: '@Image1 in prompt. Max 30MB each.', uiOrder: 0 },
        { key: 'refVideos', providerKey: 'video_urls', type: 'video_array',
          required: false, maxItems: 3,
          uiLabel: 'Reference videos', uiHint: '@Video1 in prompt. Combined 2–15s, 50MB total.', uiOrder: 1 },
        { key: 'refAudios', providerKey: 'audio_urls', type: 'audio_array',
          required: false, maxItems: 3,
          uiLabel: 'Reference audio', uiHint: '@Audio1 in prompt. MP3/WAV, ≤15s combined.', uiOrder: 2 },
        S.prompt(3, true),
        S.seedanceAR(4),
        S.seedanceDur(5),
        S.seedanceProRes(6),
        S.audio(7, true),
        S.seed(8),
      ],
      constraints: [
        { type: 'sum_max', fields: ['refImages','refVideos','refAudios'], value: 12,
          message: 'Total files (images + videos + audio) cannot exceed 12' },
      ],
    },
  },

  // ── Happy Horse — multi-character ref2v ───────────────────────────────
  {
    id: 'happy_horse_ref2vid',
    label: 'Happy Horse (multi-character)',
    shortLabel: 'Happy Horse',
    description: 'Multi-character video. Reference your subjects as character1, character2, etc.',
    provider: 'fal',
    falModelId: 'alibaba/happy-horse/reference-to-video',
    falVideoModelId: 'alibaba/happy-horse/reference-to-video',
    kind: 'video',
    videoVariant: 'r2v',
    supportsReferenceImage: true,
    supportsCharacterLock: true,
    supportsAudio: false,
    supportedAspectRatios: ['16:9','9:16','1:1','4:3','3:4'],
    supportedDurations: [3,4,5,6,7,8,9,10,11,12,13,14,15],
    maxResolution: 1080,
    creditsPerSecondVideo: 4,
    minPlan: 'starter',
    isActive: true,
    sortOrder: 12,
    logoUrl: 'https://d1735p3aqhycef.cloudfront.net/aigc-web/public/ai-image-creation/models/pic_flux.png',
    capabilities: {
      uiVariant: 'ref2v_multi_image',
      promptTokens: { pattern: 'character{N}', sourceField: 'refImages', maxN: 9 },
      inputSlots: [
        { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
          required: true, minItems: 1, maxItems: 9,
          uiLabel: 'Subject images',
          uiHint: 'Order matters: 1st = character1, 2nd = character2. Min 400px, ≤10MB each.',
          uiOrder: 0 },
        { key: 'prompt', providerKey: 'prompt', type: 'string', required: true,
          uiLabel: 'Prompt',
          uiHint: 'Reference subjects as character1, character2... Max 2500 chars.',
          uiOrder: 1 },
        S.hhAR(2),
        { key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['720p','1080p'], default: '1080p',
          uiLabel: 'Resolution', uiOrder: 3 },
        S.hhDur(4),
        S.seed(5),
      ],
      constraints: [],
      requiredFields: ['refImages'],
    },
  },

  // ── Wan 2.7 — multi-subject ref2v + auto multi-shot ───────────────────
  {
    id: 'wan_v27_ref2vid',
    label: 'Wan 2.7',
    shortLabel: 'Wan 2.7',
    description: 'Multi-subject reference-to-video with optional auto multi-shot segmentation.',
    provider: 'fal',
    falModelId: 'fal-ai/wan/v2.7/reference-to-video',
    falVideoModelId: 'fal-ai/wan/v2.7/reference-to-video',
    kind: 'video',
    videoVariant: 'r2v',
    supportsReferenceImage: true,
    supportsAudio: false,
    supportedAspectRatios: ['16:9','9:16','1:1','4:3','3:4'],
    supportedDurations: [2,3,4,5,6,7,8,9,10],
    maxResolution: 1080,
    creditsPerSecondVideo: 4,
    minPlan: 'starter',
    isActive: true,
    sortOrder: 13,
    logoUrl: 'https://d1735p3aqhycef.cloudfront.net/aigc-web/public/ai-image-creation/models/pic_flux.png',
    badge: 'New',
    capabilities: {
      uiVariant: 'ref2v_with_video_refs',
      supportsNegativePrompt: true,
      supportsMultiShot: true,
      providerParamMap: {
        referenceImageUrl: 'reference_image_urls',
        negativePrompt: 'negative_prompt',
      },
      inputSlots: [
        { key: 'refImages', providerKey: 'reference_image_urls', type: 'image_array',
          required: false, uiLabel: 'Reference images',
          uiHint: 'Character/object refs. Max 20MB each.', uiOrder: 0 },
        { key: 'refVideos', providerKey: 'reference_video_urls', type: 'video_array',
          required: false, uiLabel: 'Reference videos',
          uiHint: 'Motion/appearance ref. Max 100MB, 30s each.', uiOrder: 1 },
        S.prompt(2, true),
        S.negPrompt(3),
        S.hhAR(4),
        { key: 'resolution', providerKey: 'resolution', type: 'enum',
          options: ['720p','1080p'], default: '1080p',
          uiLabel: 'Resolution', uiOrder: 5 },
        S.wanDur(6),
        { key: 'multiShots', providerKey: 'multi_shots', type: 'boolean',
          default: false, uiLabel: 'Auto multi-shot',
          uiHint: 'Let the model intelligently segment into multiple shots.',
          uiOrder: 7 },
        S.seed(8),
      ],
      constraints: [],
    },
  },
];

// ─── Capability backfill — aligned to YOUR REAL DB ids and REAL schemas ────

const EXISTING_PATCHES = [
  // ─── Flux text-to-image family ────────────────────────────────────────
  { id: 'flux_schnell', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.fluxSize(1), S.numImages(2), S.seed(3),
  ], constraints: [] }},
  { id: 'flux_dev', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.fluxSize(1), S.numImages(2), S.seed(3),
  ], constraints: [] }},
  { id: 'flux_pro_v11', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.fluxSize(1), S.numImages(2), S.seed(3),
  ], constraints: [] }},
  { id: 'flux_2_pro', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.fluxSize(1), S.numImages(2), S.seed(3),
  ], constraints: [] }},
  // Legacy `flux_pro` row (if it exists from old seeds)
  { id: 'flux_pro', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.fluxSize(1), S.numImages(2), S.seed(3),
  ], constraints: [] }},

  // ─── Flux Kontext Pro — image edit ────────────────────────────────────
  { id: 'flux_kontext_pro', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['referenceImageUrl'],
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.prompt(1, true),
      S.fluxSize(2),
      S.numImages(3),
      S.seed(4),
    ],
    constraints: [],
  }},

  // ─── Nano Banana family ───────────────────────────────────────────────
  { id: 'nano_banana_pro', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true), S.nanoBananaAR(1), S.numImages(2),
    S.outputFormat(3), S.seed(4),
  ], constraints: [] }},

  { id: 'nano_banana_pro_edit', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['refImages'],
    inputSlots: [
      { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
        required: true, minItems: 1, maxItems: 10,
        uiLabel: 'Reference images', uiOrder: 0 },
      S.prompt(1, true),
      S.nanoBananaAR(2),
      S.numImages(3),
      S.outputFormat(4),
      S.seed(5),
    ],
    constraints: [],
  }},

  { id: 'nano_banana_2', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true),
    S.nanoBananaAR(1),
    S.nanoBananaRes(2),
    S.numImages(3),
    S.outputFormat(4),
    S.seed(5),
  ], constraints: [] }},

  // Nano Banana 2 EDIT — verified from your fetched schema
  { id: 'nano_banana_2_edit', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['refImages'],
    inputSlots: [
      { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
        required: true, minItems: 1, maxItems: 10,
        uiLabel: 'Reference images', uiHint: 'Up to 10 images.', uiOrder: 0 },
      S.prompt(1, true),
      S.nanoBananaAR(2),
      S.nanoBananaRes(3),
      S.numImages(4),
      S.outputFormat(5),
      { key: 'safetyTolerance', providerKey: 'safety_tolerance', type: 'enum',
        options: ['1','2','3','4','5','6'], default: '4', coerceToString: true,
        uiLabel: 'Safety tolerance',
        uiHint: '1 = strictest, 6 = least strict', uiOrder: 6 },
      S.seed(7),
    ],
    constraints: [],
  }},

  // ─── GPT Image 1.5 edit (id: gpt_image_2) ─ verified from your schema ─
  { id: 'gpt_image_2', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['refImages'],
    inputSlots: [
      { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
        required: true, minItems: 1,
        uiLabel: 'Reference images', uiOrder: 0 },
      S.prompt(1, true),
      S.gptImageSize(2),
      S.gptBackground(3),
      S.gptQuality(4),
      S.gptInputFidelity(5),
      S.numImages(6),
      S.outputFormat(7),
      { key: 'maskImage', providerKey: 'mask_image_url', type: 'image',
        required: false, uiLabel: 'Mask (optional)',
        uiHint: 'White = edit area, black = preserve', uiOrder: 8 },
    ],
    constraints: [],
  }},

  // ─── Seedream v4.5 edit ─ verified from your schema ───────────────────
  { id: 'seedream_v45_edit', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['refImages'],
    inputSlots: [
      { key: 'refImages', providerKey: 'image_urls', type: 'image_array',
        required: true, minItems: 1, maxItems: 10,
        uiLabel: 'Reference images',
        uiHint: 'Up to 10. First image leads composition.', uiOrder: 0 },
      S.prompt(1, true),
      S.seedreamSize(2, 'auto_2K'),
      S.numImages(3, 6, 1),
      S.seedreamMaxImages(4),
      S.seed(5),
    ],
    constraints: [
      { type: 'sum_max', fields: ['refImages','numImages'], value: 15,
        message: 'Total images (input + output) cannot exceed 15' },
    ],
  }},

  // ─── Seedream v4 t2i ─ verified from your schema ──────────────────────
  { id: 'seedream_v4', capabilities: { uiVariant: 't2i_simple', inputSlots: [
    S.prompt(0, true),
    S.seedreamSize(1, 'auto_2K'),
    S.numImages(2, 6, 1),
    S.seedreamMaxImages(3),
    { key: 'enhancePromptMode', providerKey: 'enhance_prompt_mode', type: 'enum',
      options: ['standard','fast'], default: 'standard',
      uiLabel: 'Prompt enhancement',
      uiHint: 'Standard = higher quality. Fast = quicker.', uiOrder: 4 },
    S.seed(5),
  ], constraints: [] }},

  // ─── Clarity Upscaler (qumak_upscale) ─ verified from your schema ─────
  { id: 'qumak_upscale', capabilities: { uiVariant: 'i2i_edit',
    requiredFields: ['referenceImageUrl'],
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.upscaleFactor(1),
      S.prompt(2, false),
      S.creativity(3),
      S.resemblance(4),
      S.guidanceScale(5),
      S.numInfSteps(6),
      S.negPrompt(7),
      S.seed(8),
    ],
    constraints: [],
  }},

  // ─── Seedance 2.0 FAST text-to-video ─ verified (480p/720p only!) ─────
  { id: 'seedance_2_0_fast', capabilities: { uiVariant: 't2v_simple',
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.prompt(0, true),
      S.seedanceFastRes(1),
      S.seedanceDur(2),
      S.seedanceAR(3),
      S.audio(4, true),
      S.seed(5),
    ],
    constraints: [],
  }},

  // ─── Seedance 2.0 FAST image-to-video ─ verified (480p/720p only!) ────
  { id: 'seedance_2_0_fast_i2v', capabilities: { uiVariant: 'i2v_with_end',
    requiredFields: ['referenceImageUrl'],
    supportsEndFrame: true,
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.endFrame(1, 'end_image_url'),
      S.prompt(2, true),
      S.seedanceFastRes(3),
      S.seedanceDur(4),
      S.seedanceAR(5),
      S.audio(6, true),
      S.seed(7),
    ],
    constraints: [],
  }},

  // ─── Seedance 2.0 (full) text-to-video ────────────────────────────────
  { id: 'seedance_2_0', capabilities: { uiVariant: 't2v_simple',
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.prompt(0, true),
      S.seedanceProRes(1),
      S.seedanceDur(2),
      S.seedanceAR(3),
      S.audio(4, true),
      S.seed(5),
    ],
    constraints: [],
  }},

  // ─── Seedance 2.0 (full) image-to-video ───────────────────────────────
  { id: 'seedance_2_0_i2v', capabilities: { uiVariant: 'i2v_with_end',
    requiredFields: ['referenceImageUrl'],
    supportsEndFrame: true,
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.endFrame(1, 'end_image_url'),
      S.prompt(2, true),
      S.seedanceProRes(3),
      S.seedanceDur(4),
      S.seedanceAR(5),
      S.audio(6, true),
      S.seed(7),
    ],
    constraints: [],
  }},

  // ─── Kling 1.6 standard t2v (id: kling_v2_standard) ───────────────────
  { id: 'kling_v2_standard', capabilities: { uiVariant: 't2v_simple',
    supportsNegativePrompt: true,
    inputSlots: [
      S.prompt(0, true),
      S.negPrompt(1),
      S.klingAR(2),
      S.klingDur(3),
      S.seed(4),
    ],
    constraints: [],
  }},

  // ─── Kling 2.5 Pro t2v (id: kling_v2_pro) ─────────────────────────────
  { id: 'kling_v2_pro', capabilities: { uiVariant: 't2v_simple',
    supportsNegativePrompt: true,
    inputSlots: [
      S.prompt(0, true),
      S.negPrompt(1),
      S.klingAR(2),
      S.klingDur(3),
      S.seed(4),
    ],
    constraints: [],
  }},

  // ─── Kling 2.6 Pro i2v ────────────────────────────────────────────────
  { id: 'kling_v2_6_pro', capabilities: { uiVariant: 'i2v_with_end',
    requiredFields: ['referenceImageUrl'],
    supportsEndFrame: true,
    supportsNegativePrompt: true,
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.endFrame(1, 'tail_image_url'),
      S.prompt(2, true),
      S.negPrompt(3),
      S.klingAR(4),
      S.klingDur(5),
      S.audio(6, false),
      S.seed(7),
    ],
    constraints: [],
  }},

  // ─── Kling 3.0 Pro i2v ────────────────────────────────────────────────
  { id: 'kling_v3_pro', capabilities: { uiVariant: 'i2v_with_end',
    requiredFields: ['referenceImageUrl'],
    supportsEndFrame: true,
    supportsNegativePrompt: true,
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.endFrame(1, 'tail_image_url'),
      S.prompt(2, true),
      S.negPrompt(3),
      S.klingAR(4),
      S.klingDur(5),
      S.audio(6, true),
      S.seed(7),
    ],
    constraints: [],
  }},

  // ─── Pixverse C1 t2v ──────────────────────────────────────────────────
  { id: 'pixverse_c1_t2v', capabilities: { uiVariant: 't2v_simple',
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.prompt(0, true),
      S.pixverseAR(1),
      S.pixverseDur(2, [5,8,15]),
      S.audio(3, true),
      S.seed(4),
    ],
    constraints: [],
  }},

  // ─── Pixverse C1 i2v ──────────────────────────────────────────────────
  { id: 'pixverse_c1_i2v', capabilities: { uiVariant: 'i2v_simple',
    requiredFields: ['referenceImageUrl'],
    audio: { supportsNativeAudio: true, audioParamKey: 'generate_audio' },
    inputSlots: [
      S.startFrame(0, true, 'image_url'),
      S.prompt(1, true),
      S.pixverseAR(2),
      S.pixverseDur(3, [5,8]),
      S.audio(4, true),
      S.seed(5),
    ],
    constraints: [],
  }},
];

// ─── Run ───────────────────────────────────────────────────────────────────

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyId = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];

  let inserted = 0, updated = 0, missing = 0, errors = 0;

  // Step 1: Upsert NEW models
  console.log('\n── New models ──');
  for (const model of NEW_MODELS) {
    if (onlyId && model.id !== onlyId) continue;
    try {
      if (dryRun) {
        const exists = await AiModel.exists({ id: model.id });
        console.log(`  ${exists ? '~' : '+'} [dry] ${model.id.padEnd(36)} ${model.capabilities.uiVariant.padEnd(22)} ${model.capabilities.inputSlots.length} slots`);
        continue;
      }
      const result = await AiModel.updateOne(
        { id: model.id },
        { $set: model },
        { upsert: true },
      );
      if (result.upsertedId) { console.log(`  + ${model.id} INSERTED`); inserted++; }
      else { console.log(`  ~ ${model.id} updated`); updated++; }
    } catch (err) {
      console.error(`  ✗ ${model.id}: ${err.message}`);
      errors++;
    }
  }

  // Step 2: Patch EXISTING models
  console.log('\n── Capability patches (existing models) ──');
  for (const { id, capabilities } of EXISTING_PATCHES) {
    if (onlyId && id !== onlyId) continue;
    try {
      if (dryRun) {
        const exists = await AiModel.exists({ id });
        console.log(`  ${exists ? '~' : '✗'} [dry] ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(22)} ${capabilities.inputSlots.length} slots`);
        if (!exists) missing++; else updated++;
        continue;
      }
      const setObj = {};
      for (const [k, v] of Object.entries(capabilities)) setObj[`capabilities.${k}`] = v;
      const result = await AiModel.updateOne({ id }, { $set: setObj });
      if (result.matchedCount === 0) { console.warn(`  ✗ NOT FOUND: ${id}`); missing++; }
      else { console.log(`  ~ ${id.padEnd(36)} ${capabilities.uiVariant.padEnd(22)} ${capabilities.inputSlots.length} slots`); updated++; }
    } catch (err) {
      console.error(`  ✗ ${id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone — inserted:${inserted}  updated:${updated}  missing:${missing}  errors:${errors}`);
  if (missing > 0) console.log('Missing rows are likely OpenAI/Gemini models (no fal manifest needed) or legacy aliases.');
}

const url = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
const db  = process.env.DB    || 'qumak';
mongoose.connect(`${url}/${db}`)
  .then(run)
  .then(() => mongoose.disconnect())
  .catch(err => { console.error('Connect failed:', err.message); process.exit(1); });