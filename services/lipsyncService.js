'use strict';

/**
 * lipsyncService — real, working Lipsync pipeline backed by Fal.
 *
 * Pipeline:
 *   1. Validate inputs (portraitUrl is image or video; audioUrl OR text+voice)
 *   2. If audioUrl missing and text+voice provided → generate audio via
 *      Fal ElevenLabs TTS (fal-ai/elevenlabs/tts/eleven-v3)
 *   3. Call chosen lipsync model:
 *        - sync_lipsync_v2       → fal-ai/sync-lipsync/v2  (video + audio)
 *        - veed_lipsync          → fal-ai/veed/lipsync
 *        - hedra_character_3     → fal-ai/hedra-character-3 (image + audio → video)
 *        - kling_avatar_pro      → fal-ai/kling-video/v1/pro/ai-avatar
 *   4. Postprocess + store in R2 via processingService.processVideo
 *   5. Persist asset, mark job completed, emit Socket.IO update
 *
 * Job lifecycle is tracked via the existing StudioJob model so the UI
 * can use the standard /studio/job/:id polling endpoint — no new socket
 * channel, no new schema. Credits are charged via creditsService on
 * enqueue and refunded on failure (same shape as video generation).
 */

const StudioJob        = require('../model/schema/studioJob');
const StudioAsset      = require('../model/schema/studioAsset');
const falService       = require('./falService');
const processingService = require('./processingService');
const creditsService   = require('./creditsService');
const { emitJobUpdate } = require('../utils/socketEmitter');

// ─── Lipsync model catalog (public-facing, icon-free) ──────────────────────

const LIPSYNC_MODELS = [
  {
    id: 'sync_lipsync_v2',
    name: 'Sync Lipsync v2',
    tagline: 'Best-in-class studio-grade lipsync for any face',
    falModelId: 'fal-ai/sync-lipsync/v2',
    inputKind: 'video',          // requires a video portrait
    credits: 22,
    estSeconds: 45,
    supportsImage: false,
    description: 'Drives mouth shapes on an existing clip. Preserves original framing and head motion.',
  },
  {
    id: 'veed_lipsync',
    name: 'VEED Lipsync',
    tagline: 'Fast, friendly lipsync tuned for social clips',
    falModelId: 'fal-ai/veed/lipsync',
    inputKind: 'video',
    credits: 18,
    estSeconds: 40,
    supportsImage: false,
    description: 'Great for quick UGC cuts. Delivers tight lip-to-audio alignment under a minute.',
  },
  {
    id: 'hedra_character_3',
    name: 'Hedra Character 3',
    tagline: 'Talking portraits from a single image + audio',
    falModelId: 'fal-ai/hedra/character-3',
    inputKind: 'image',
    credits: 24,
    estSeconds: 60,
    supportsImage: true,
    description: 'Brings a still image to life — subtle facial motion plus accurate lip sync.',
  },
  {
    id: 'kling_avatar_pro',
    name: 'Kling AI Avatar Pro',
    tagline: 'Cinematic avatar with expressive delivery',
    falModelId: 'fal-ai/kling-video/v1/pro/ai-avatar',
    inputKind: 'image',
    credits: 30,
    estSeconds: 90,
    supportsImage: true,
    description: 'Richer body/head motion. Best for polished avatar spots.',
  },
  {
    id: 'infinitetalk',
    name: 'InfiniteTalk',
    tagline: 'Long-form talking-head with natural cadence',
    falModelId: 'fal-ai/infinitetalk',
    inputKind: 'image',
    credits: 28,
    estSeconds: 75,
    supportsImage: true,
    description: 'Ideal for monologues or longer scripts — stable identity across minutes.',
  },
  {
    id: 'higgsfield_speak',
    name: 'Higgsfield Speak',
    tagline: 'Photo-real spokesperson takes in seconds',
    falModelId: 'fal-ai/higgsfield/speak',
    inputKind: 'image',
    credits: 26,
    estSeconds: 55,
    supportsImage: true,
    description: 'Signature Higgsfield realism. Great with stylized portraits.',
  },
];

const LIPSYNC_VOICES = [
  { id: 'rachel',  name: 'Rachel',  gender: 'female', accent: 'American',    description: 'Warm, articulate, conversational' },
  { id: 'bella',   name: 'Bella',   gender: 'female', accent: 'American',    description: 'Young, bright, friendly' },
  { id: 'sarah',   name: 'Sarah',   gender: 'female', accent: 'British',     description: 'Confident, editorial' },
  { id: 'adam',    name: 'Adam',    gender: 'male',   accent: 'American',    description: 'Deep, authoritative' },
  { id: 'brian',   name: 'Brian',   gender: 'male',   accent: 'American',    description: 'Smooth, narrator-ready' },
  { id: 'antoni',  name: 'Antoni',  gender: 'male',   accent: 'American',    description: 'Warm, well-paced' },
  { id: 'arabic1', name: 'Layla',   gender: 'female', accent: 'Arabic (MSA)', description: 'Modern Standard Arabic, broadcast tone' },
  { id: 'arabic2', name: 'Amir',    gender: 'male',   accent: 'Arabic (MSA)', description: 'Modern Standard Arabic, confident' },
];

function getLipsyncModel(id) {
  return LIPSYNC_MODELS.find((m) => m.id === id) || null;
}

// ─── Audio generation (TTS) ────────────────────────────────────────────────

async function generateTtsAudio({ text, voiceId = 'rachel', language = 'en' }) {
  if (!text || !text.trim()) return null;
  // We use Eleven v3 for both English and Arabic scripts via the
  // multilingual endpoint when language !== 'en'.
  const slug = language === 'en'
    ? 'fal-ai/elevenlabs/tts/eleven-v3'
    : 'fal-ai/elevenlabs/tts/multilingual-v2';
  const result = await falService._callFal(slug, {
    text: text.trim(),
    // voice: voiceId,
  });
  // Fal TTS returns either .audio.url or .audio_url depending on model;
  // normalize.
  const audio = result?.data?.audio || result?.data?.audio_url || result?.audio || null;
  const url = typeof audio === 'object' ? audio?.url : audio;
  return url || null;
}

// ─── Build provider input per model family ─────────────────────────────────

function buildProviderInput(model, { portraitUrl, audioUrl, aspectRatio, resolution }) {
  if (model.id === 'sync_lipsync_v2' || model.id === 'veed_lipsync') {
    return {
      video_url: portraitUrl,
      audio_url: audioUrl,
    };
  }
  if (model.id === 'hedra_character_3' || model.id === 'higgsfield_speak' || model.id === 'infinitetalk') {
    return {
      image_url: portraitUrl,
      audio_url: audioUrl,
      aspect_ratio: aspectRatio || '9:16',
      resolution:   resolution   || '720p',
    };
  }
  if (model.id === 'kling_avatar_pro') {
    return {
      image_url: portraitUrl,
      audio_url: audioUrl,
      aspect_ratio: aspectRatio || '9:16',
    };
  }
  return { image_url: portraitUrl, audio_url: audioUrl };
}

// ─── Core run ──────────────────────────────────────────────────────────────

/**
 * runLipsyncJob — async pipeline. Intended to be invoked via setImmediate
 * after the HTTP handler has persisted the StudioJob. Never awaited by the
 * HTTP handler; updates flow through Socket.IO + the StudioJob record.
 */
async function runLipsyncJob(jobId) {
  const job = await StudioJob.findById(jobId);
  if (!job) return;

  const modelId = job.userInputs?.extras?.lipsyncModelId || 'sync_lipsync_v2';
  const model = getLipsyncModel(modelId);
  if (!model) {
    job.status = 'failed';
    job.statusMessage = `Unknown lipsync model '${modelId}'.`;
    job.error = { message: job.statusMessage, code: 'LIPSYNC_MODEL_UNKNOWN' };
    await job.save();
    await emitJobUpdate(job.sessionId, {
      jobId: String(job._id), status: 'failed', progress: 0,
      statusMessage: job.statusMessage,
    });
    await creditsService.refundForJob(job).catch(() => {});
    return;
  }

  const start = Date.now();
  try {
    job.startedAt = new Date();
    job.status = 'prompt_building';
    job.progress = 10;
    job.statusMessage = 'Preparing lipsync inputs…';
    await job.save();
    await emitJobUpdate(job.sessionId, {
      jobId: String(job._id), status: job.status, progress: job.progress,
      statusMessage: job.statusMessage,
    });

    // 1. Resolve the audio URL (either user-provided, or freshly TTS'd).
    let audioUrl = job.userInputs?.extras?.audioUrl || null;
    const audioText = job.userInputs?.extras?.audioScript || '';
    const voiceId   = job.userInputs?.extras?.voiceId   || 'rachel';
    const language  = job.userInputs?.extras?.language  || 'en';

    if (!audioUrl && audioText && audioText.trim().length > 0) {
      job.status = 'generating';
      job.progress = 20;
      job.statusMessage = 'Generating voice audio…';
      await job.save();
      await emitJobUpdate(job.sessionId, {
        jobId: String(job._id), status: job.status, progress: job.progress,
        statusMessage: job.statusMessage,
      });
      audioUrl = await generateTtsAudio({ text: audioText, voiceId, language });
    }
    if (!audioUrl) {
      throw Object.assign(new Error('Either audioUrl or audioScript+voiceId must be provided'), {
        code: 'LIPSYNC_NO_AUDIO',
      });
    }

    const portraitUrl = job.userInputs?.referenceImageUrl
      || job.userInputs?.extras?.portraitUrl;
    if (!portraitUrl) {
      throw Object.assign(new Error('Portrait (image or video) is required'), {
        code: 'LIPSYNC_NO_PORTRAIT',
      });
    }

    // 2. Kick off the lipsync model.
    job.status = 'generating';
    job.progress = 35;
    job.statusMessage = `Running ${model.name}…`;
    await job.save();
    await emitJobUpdate(job.sessionId, {
      jobId: String(job._id), status: job.status, progress: job.progress,
      statusMessage: job.statusMessage,
    });

    const providerInput = buildProviderInput(model, {
      portraitUrl,
      audioUrl,
      aspectRatio: job.userInputs?.aspectRatio,
      resolution:  job.userInputs?.resolution,
    });

    const progressDebouncer = new Map(); // jobId → last save time
    
    const falResult = await falService._callFal(model.falModelId, providerInput, {
      // onQueueUpdate: (u) => {
      //   // Fal gives us a percentage when logs: true, otherwise we just
      //   // bump progress cosmetically so the UI doesn't stall.
      //   const pct = Math.min(75, 35 + Math.floor((u?.progress || 0) * 0.4));
      //   job.progress = pct;
      //   job.statusMessage = `Running ${model.name}… ${pct}%`;
      //   job.save().catch(() => {});
      // },

      // Emit to socket immediately, debounce the DB write
      
    onQueueUpdate: async (u) => {
      const pct = Math.min(75, 22 + Math.floor((u?.progress || 0) * 0.55));
      
      // Always emit to client — cheap
      await emitJobUpdate(job.sessionId, {
        jobId: String(job._id),
        progress: pct,
        statusMessage: `Rendering ${cfg.name}… ${pct}%`,
      });
      
      // Persist at most once per 3 seconds per job
      const now = Date.now();
      const last = progressDebouncer.get(String(job._id)) || 0;
      if (now - last < 3000) return;
      progressDebouncer.set(String(job._id), now);
      
      try {
        await StudioJob.updateOne(
          { _id: job._id },
          { $set: { progress: pct, statusMessage: `Rendering… ${pct}%` } }
        );
      } catch (err) {
        metrics.counter('progress.save.failed', 1, { feature: cfg.name });
        // Non-fatal, but LOGGED
      }
    },
    });

    // Fal lipsync responses tend to be `{ video: { url } }` or `{ video_url }`.
    const rawVideoUrl = falResult?.data?.video?.url
      || falResult?.data?.video_url
      || falResult?.data?.output?.url
      || falResult?.data?.result?.video
      || null;
    if (!rawVideoUrl) {
      throw Object.assign(new Error('Lipsync model returned no video URL'), {
        code: 'LIPSYNC_NO_OUTPUT',
      });
    }

    // 3. Postprocess (mirror videoWorker's logic) + persist.
    job.output = job.output || {};
    job.output.rawVideoUrl = rawVideoUrl;
    job.status = 'postprocessing';
    job.progress = 82;
    job.statusMessage = 'Storing your video…';
    await job.save();
    await emitJobUpdate(job.sessionId, {
      jobId: String(job._id), status: job.status, progress: job.progress,
      statusMessage: job.statusMessage,
    });

    const proc = await processingService.processVideo({
      videoUrl:    rawVideoUrl,
      jobId:       String(job._id),
      category:    job.category,
      brandName:   job.userInputs?.brandName,
      isWatermarked: job.isWatermarked,
      aspectRatio: job.userInputs?.aspectRatio,
    });

    job.output.storedVideoUrl = proc.storedUrl;
    if (job.isWatermarked) job.output.watermarkedUrl = proc.storedUrl;
    else                   job.output.cleanUrl      = proc.storedUrl;

    const ffOk = await processingService.checkFFmpeg();
    if (ffOk) {
      const thumb = await processingService.extractThumbnail(proc.storedUrl, String(job._id));
      if (thumb) job.output.thumbnailUrl = thumb;
    }

    const finalUrl = job.isWatermarked ? job.output.watermarkedUrl : job.output.cleanUrl;
    const asset = await StudioAsset.create({
      jobId:       job._id,
      sessionId:   job.sessionId,
      userId:      job.userId || null,
      type:        'video',
      category:    job.category,
      url:         finalUrl,
      thumbnailUrl: job.output.thumbnailUrl || null,
      mimeType:    'video/mp4',
      isWatermarked: !!job.isWatermarked,
      metadata:    { lipsyncModel: model.id, audioText, voiceId, language },
    }).catch(() => null);

    job.totalPipelineTimeMs = Date.now() - start;
    job.completedAt = new Date();
    job.status = 'completed';
    job.progress = 100;
    job.statusMessage = 'Your lipsynced video is ready!';
    await job.save();
    await emitJobUpdate(job.sessionId, {
      jobId:         String(job._id),
      status:        'completed',
      progress:      100,
      statusMessage: job.statusMessage,
      assetId:       asset?._id?.toString() || null,
      isWatermarked: !!job.isWatermarked,
      output: {
        videoUrl:     finalUrl,
        thumbnailUrl: job.output.thumbnailUrl,
      },
    });
  } catch (err) {
    console.error(`[lipsyncService] job ${jobId} failed:`, err.message);
    job.status = 'failed';
    job.statusMessage = err.message || 'Lipsync generation failed. Please try again.';
    job.error = { message: err.message, code: err.code || 'LIPSYNC_ERROR' };
    await job.save().catch(() => {});
    await emitJobUpdate(job.sessionId, {
      jobId:         String(job._id),
      status:        'failed',
      progress:      0,
      statusMessage: job.statusMessage,
      error:         { message: err.message, code: err.code },
    });
    await creditsService.refundForJob(job).catch(() => {});
  }
}

module.exports = {
  LIPSYNC_MODELS,
  LIPSYNC_VOICES,
  getLipsyncModel,
  runLipsyncJob,
  generateTtsAudio,
};
