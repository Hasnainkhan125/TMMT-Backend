'use strict';

/**
 * vibeMotionService — "Create with Vibe Motion" pipeline.
 *
 * Vibe Motion lets a user pick a preset (Infographics, Text Animation,
 * Posters, Presentation, or From scratch) and optionally click a tile
 * from data/manifest.json to seed the look. We then fan that out into
 * a text-to-video (or image-to-video when a source image is present)
 * render using Seedance / Kling / Veo style models.
 *
 * Preset → model mapping:
 *   infographics   → Seedance v1 Pro       (clean geometric motion)
 *   textAnimation  → Kling v2 Master       (stylised kinetic type)
 *   posters        → Pika v2.2 (img2vid)   (camera push-ins on stills)
 *   presentation   → Veo 3 / Hailuo 02     (slow pans + transitions)
 *   scratch        → Seedance v1 Pro       (safe default)
 */

const StudioJob          = require('../model/schema/studioJob');
const StudioAsset        = require('../model/schema/studioAsset');
const falService         = require('./falService');
const processingService  = require('./processingService');
const creditsService     = require('./creditsService');
const { emitJobUpdate }  = require('../utils/socketEmitter');
const { runVibeMotionJob } = require('./pipelines/vibeMotionPipeline');

const DEFAULT_VIBE_CREDITS = 16;

const PRESET_CONFIG = {
  infographics: {
    name:      'Infographics',
    falModelId: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    defaultPromptPrefix:
      'Animated infographic sequence. Flat design with crisp geometric shapes, clean type, and precise motion. ',
    aspectRatio: '16:9',
    duration: 10,
  },
  textAnimation: {
    name:      'Text Animation',
    falModelId: 'fal-ai/kling-video/v2/master/text-to-video',
    defaultPromptPrefix:
      'Cinematic kinetic typography animation with expressive lettering, bold color accents, and studio lighting. ',
    aspectRatio: '9:16',
    duration: 10,
  },
  posters: {
    name:      'Posters',
    falModelId: 'fal-ai/pika/v2.2/image-to-video',
    defaultPromptPrefix:
      'Editorial poster brought to life with a slow dramatic camera push and subtle parallax layers. ',
    aspectRatio: '9:16',
    duration: 10,
    requiresImage: true,
  },
  presentation: {
    name:      'Presentation',
    falModelId: 'fal-ai/veo3/fast',
    defaultPromptPrefix:
      'Smooth motion-slide presentation sequence with cinematic transitions and clean bokeh backgrounds. ',
    aspectRatio: '16:9',
    duration: 10,
  },
  scratch: {
    name:      'From scratch',
    falModelId: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    defaultPromptPrefix: '',
    aspectRatio: '16:9',
    duration: 10,
  },
};

function getPresetConfig(preset) {
  return PRESET_CONFIG[preset] || PRESET_CONFIG.scratch;
}

function buildProviderInput(cfg, { prompt, aspectRatio, duration, referenceImageUrl }) {
  const base = {
    prompt,
    aspect_ratio: aspectRatio,
    duration,
  };
  if (cfg.requiresImage || referenceImageUrl) {
    base.image_url = referenceImageUrl || undefined;
  }
  return base;
}

// async function runVibeMotionJob(jobId) {
//   const job = await StudioJob.findById(jobId);
//   if (!job) return;

//   const extras = job.userInputs?.extras || {};
//   const preset = extras.preset || 'scratch';
//   const cfg = getPresetConfig(preset);

//   const start = Date.now();
//   try {
//     job.startedAt = new Date();
//     job.status = 'generating';
//     job.progress = 22;
//     job.statusMessage = `Rendering ${cfg.name}…`;
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId: String(job._id), status: job.status, progress: job.progress,
//       statusMessage: job.statusMessage,
//     });

//     const userPrompt = (job.userInputs?.description || '').trim();
//     const finalPrompt = `${cfg.defaultPromptPrefix}${userPrompt}`.trim();
//     const aspectRatio = job.userInputs?.aspectRatio || cfg.aspectRatio;
//     const duration    = job.userInputs?.duration     || cfg.duration;
//     const referenceImageUrl = job.userInputs?.referenceImageUrl || extras.seedTileUrl || null;

//     if (cfg.requiresImage && !referenceImageUrl) {
//       throw Object.assign(new Error('Posters preset requires a source image'), {
//         code: 'VIBE_NO_IMAGE',
//       });
//     }

//     const providerInput = buildProviderInput(cfg, {
//       prompt: finalPrompt,
//       aspectRatio,
//       duration,
//       referenceImageUrl,
//     });

//     const falResult = await falService._callFal(cfg.falModelId, providerInput, {
//       onQueueUpdate: (u) => {
//         const pct = Math.min(75, 22 + Math.floor((u?.progress || 0) * 0.55));
//         job.progress = pct;
//         job.statusMessage = `Rendering ${cfg.name}… ${pct}%`;
//         job.save().catch(() => {});
//       },
//     });

//     const rawVideoUrl = falResult?.data?.video?.url
//       || falResult?.data?.video_url
//       || falResult?.data?.output?.url
//       || null;
//     if (!rawVideoUrl) {
//       throw Object.assign(new Error('Vibe Motion model returned no video URL'), {
//         code: 'VIBE_NO_OUTPUT',
//       });
//     }

//     job.output = job.output || {};
//     job.output.rawVideoUrl = rawVideoUrl;
//     job.status = 'postprocessing';
//     job.progress = 82;
//     job.statusMessage = 'Storing your clip…';
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId: String(job._id), status: job.status, progress: job.progress,
//       statusMessage: job.statusMessage,
//     });

//     const proc = await processingService.processVideo({
//       videoUrl:    rawVideoUrl,
//       jobId:       String(job._id),
//       category:    job.category,
//       brandName:   job.userInputs?.brandName,
//       isWatermarked: job.isWatermarked,
//       aspectRatio,
//     });

//     job.output.storedVideoUrl = proc.storedUrl;
//     if (job.isWatermarked) job.output.watermarkedUrl = proc.storedUrl;
//     else                   job.output.cleanUrl      = proc.storedUrl;

//     const ffOk = await processingService.checkFFmpeg();
//     if (ffOk) {
//       const thumb = await processingService.extractThumbnail(proc.storedUrl, String(job._id));
//       if (thumb) job.output.thumbnailUrl = thumb;
//     }

//     const finalUrl = job.isWatermarked ? job.output.watermarkedUrl : job.output.cleanUrl;
//     const asset = await StudioAsset.create({
//       jobId:     job._id,
//       sessionId: job.sessionId,
//       userId:    job.userId || null,
//       type:      'video',
//       category:  job.category,
//       url:       finalUrl,
//       thumbnailUrl: job.output.thumbnailUrl || null,
//       mimeType:  'video/mp4',
//       isWatermarked: !!job.isWatermarked,
//       metadata:  { feature: 'vibeMotion', preset, falModelId: cfg.falModelId },
//     }).catch(() => null);

//     job.totalPipelineTimeMs = Date.now() - start;
//     job.completedAt = new Date();
//     job.status = 'completed';
//     job.progress = 100;
//     job.statusMessage = 'Your Vibe Motion clip is ready!';
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId:         String(job._id),
//       status:        'completed',
//       progress:      100,
//       statusMessage: job.statusMessage,
//       assetId:       asset?._id?.toString() || null,
//       isWatermarked: !!job.isWatermarked,
//       output: { videoUrl: finalUrl, thumbnailUrl: job.output.thumbnailUrl },
//     });
//   } catch (err) {
//     console.error(`[vibeMotionService] job ${jobId} failed:`, err.message);
//     job.status = 'failed';
//     job.statusMessage = err.message || 'Vibe Motion generation failed.';
//     job.error = { message: err.message, code: err.code || 'VIBE_ERROR' };
//     await job.save().catch(() => {});
//     await emitJobUpdate(job.sessionId, {
//       jobId:         String(job._id),
//       status:        'failed',
//       progress:      0,
//       statusMessage: job.statusMessage,
//       error:         { message: err.message, code: err.code },
//     });
//     await creditsService.refundForJob(job).catch(() => {});
//   }
// }

module.exports = {
  DEFAULT_VIBE_CREDITS,
  PRESET_CONFIG,
  getPresetConfig,
  runVibeMotionJob,
};
