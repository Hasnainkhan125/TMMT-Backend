'use strict';

/**
 * ugcService — UGC Factory pipeline.
 *
 * The UGC Factory lets a user pick a creator template (from
 * scripts/creatify_templates.json), optionally swap in their own
 * portrait image, and generate a short UGC-style spokesperson clip
 * driven by a short action script + optional spoken audio text.
 *
 * Under the hood we compose:
 *   portraitUrl  (user upload OR template.previewUrl from catalog)
 * + audioScript  → TTS via lipsyncService.generateTtsAudio
 * + actionPrompt → stitched into the final model prompt
 * + background   → stitched into the final model prompt
 * And run the template.recommendedModel (falModelId) with that input.
 *
 * The heavy lifting (audio TTS, fal call, postprocess, R2 store, asset
 * persist, socket emit) mirrors lipsyncService — we intentionally keep
 * this service small and independent from the legacy video worker so
 * the UGC endpoint is a working product today.
 */

const StudioJob          = require('../model/schema/studioJob');
const StudioAsset        = require('../model/schema/studioAsset');
const falService         = require('./falService');
const processingService  = require('./processingService');
const creditsService     = require('./creditsService');
const catalog            = require('./templatesCatalog');
const { generateTtsAudio } = require('./lipsyncService');
const { emitJobUpdate }  = require('../utils/socketEmitter');
const { runUgcJob } = require('./pipelines/ugcPipeline');
// Baseline UGC cost. If the template's modelParameters dictate more
// expensive model we can bump in future; 20 credits lines up with
// veed_lipsync pricing which is a reasonable parity.
const DEFAULT_UGC_CREDITS = 20;

function resolveFalModelId(template) {
  return (
    template?.recommendedModel
    || template?.supportedModels?.[0]
    || 'fal-ai/veed/avatars'
  );
}

function composePrompt({ template, actionPrompt, backgroundPrompt }) {
  const base = template?.promptBlueprint || '';
  const parts = [base, actionPrompt, backgroundPrompt]
    .map((s) => (s || '').toString().trim())
    .filter(Boolean);
  return parts.join('. ').slice(0, 900);
}

// async function runUgcJob(jobId) {
//   const job = await StudioJob.findById(jobId);
//   if (!job) return;

//   const extras = job.userInputs?.extras || {};
//   const templateId = extras.templateId;
//   const template = templateId ? catalog.getTemplateById(templateId) : null;

//   const falModelId = extras.falModelId
//     || resolveFalModelId(template)
//     || 'fal-ai/veed/avatars';

//   const start = Date.now();
//   try {
//     job.startedAt = new Date();
//     job.status = 'prompt_building';
//     job.progress = 12;
//     job.statusMessage = 'Preparing UGC inputs…';
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId: String(job._id), status: job.status, progress: job.progress,
//       statusMessage: job.statusMessage,
//     });

//     // 1. Resolve / generate audio (optional for UGC — some templates run
//     //    purely on visual direction without spoken lines).
//     let audioUrl = extras.audioUrl || null;
//     if (!audioUrl && extras.audioScript && extras.audioScript.trim()) {
//       job.status = 'generating';
//       job.progress = 22;
//       job.statusMessage = 'Generating voice audio…';
//       await job.save();
//       await emitJobUpdate(job.sessionId, {
//         jobId: String(job._id), status: job.status, progress: job.progress,
//         statusMessage: job.statusMessage,
//       });
//       audioUrl = await generateTtsAudio({
//         text:     extras.audioScript,
//         voiceId:  extras.voiceId  || 'rachel',
//         language: extras.language || 'en',
//       });
//     }

//     // 2. Portrait: user upload wins; falls back to template thumbnail.
//     const portraitUrl = job.userInputs?.referenceImageUrl
//       || extras.portraitUrl
//       || template?.previewUrl
//       || null;

//     // 3. Compose the final prompt from template + user text.
//     const prompt = composePrompt({
//       template,
//       actionPrompt:    extras.actionPrompt,
//       backgroundPrompt: extras.backgroundPrompt,
//     });

//     job.promptPipeline = {
//       ...(job.promptPipeline || {}),
//       finalPrompt: prompt,
//       strategy:   'template',
//       intentType: 'ugc',
//       domain:     'video',
//     };
//     job.status = 'generating';
//     job.progress = 38;
//     job.statusMessage = 'Rendering UGC clip…';
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId: String(job._id), status: job.status, progress: job.progress,
//       statusMessage: job.statusMessage,
//     });

//     // 4. Provider input — UGC creator models commonly accept
//     //    image_url + prompt + audio_url (fal-ai/veed/avatars,
//     //    fal-ai/kling-video/v1/pro/ai-avatar, fal-ai/hedra/character-3).
//     const providerInput = {
//       prompt,
//       image_url:    portraitUrl,
//       audio_url:    audioUrl,
//       aspect_ratio: job.userInputs?.aspectRatio || template?.aspectRatio || '9:16',
//       duration:     job.userInputs?.duration || template?.defaultDuration || 8,
//       resolution:   job.userInputs?.resolution || template?.defaultResolution || '720p',
//     };

//     const falResult = await falService._callFal(falModelId, providerInput, {
//       onQueueUpdate: (u) => {
//         const pct = Math.min(75, 38 + Math.floor((u?.progress || 0) * 0.4));
//         job.progress = pct;
//         job.statusMessage = `Rendering UGC clip… ${pct}%`;
//         job.save().catch(() => {});
//       },
//     });

//     const rawVideoUrl = falResult?.data?.video?.url
//       || falResult?.data?.video_url
//       || falResult?.data?.output?.url
//       || null;
//     if (!rawVideoUrl) {
//       throw Object.assign(new Error('UGC model returned no video URL'), { code: 'UGC_NO_OUTPUT' });
//     }

//     // 5. Postprocess + store.
//     job.output = job.output || {};
//     job.output.rawVideoUrl = rawVideoUrl;
//     job.status = 'postprocessing';
//     job.progress = 82;
//     job.statusMessage = 'Storing your UGC clip…';
//     await job.save();
//     await emitJobUpdate(job.sessionId, {
//       jobId: String(job._id), status: job.status, progress: job.progress,
//       statusMessage: job.statusMessage,
//     });

//     const proc = await processingService.processVideo({
//       videoUrl:   rawVideoUrl,
//       jobId:      String(job._id),
//       category:   job.category,
//       brandName:  job.userInputs?.brandName,
//       isWatermarked: job.isWatermarked,
//       aspectRatio: job.userInputs?.aspectRatio,
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
//       metadata: { feature: 'ugc', templateId, falModelId },
//     }).catch(() => null);

//     job.totalPipelineTimeMs = Date.now() - start;
//     job.completedAt = new Date();
//     job.status = 'completed';
//     job.progress = 100;
//     job.statusMessage = 'Your UGC clip is ready!';
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
//     console.error(`[ugcService] job ${jobId} failed:`, err.message);
//     job.status = 'failed';
//     job.statusMessage = err.message || 'UGC generation failed.';
//     job.error = { message: err.message, code: err.code || 'UGC_ERROR' };
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
  runUgcJob,
  DEFAULT_UGC_CREDITS: 20, // preserve constant referenced elsewhere
  resolveFalModelId: (template) => template?.recommendedModel || 'fal-ai/veed/avatars',
  composePrompt: ({ template, actionPrompt, backgroundPrompt }) => {
    return [template?.promptBlueprint, actionPrompt, backgroundPrompt]
      .filter(Boolean).join('. ').slice(0, 900);
  },
};
