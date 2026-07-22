'use strict';

/**
 * ugcPipeline — UGC Factory rendering, now using VideoGenerationPipeline.
 *
 * BEFORE: ugcService.js was 200 lines of procedural code.
 * AFTER:  this file is 60 lines. All the common logic moved to base class.
 *
 * Replaces ugcService.runUgcJob — update ugcController to use this.
 */

const { VideoGenerationPipeline, PipelineError } = require('./VideoGenerationPipeline');
const catalog = require('../templatesCatalog');
const { generateTtsAudio } = require('../lipsyncService');

class UgcPipeline extends VideoGenerationPipeline {
  constructor(opts) {
    super({ ...opts, feature: 'ugc', kind: 'video' });
  }
  
  async _prepare() {
    const extras = this.job.userInputs?.extras || {};
    const templateId = extras.templateId;
    const template = templateId ? catalog.getTemplateById(templateId) : null;
    
    // 1. Resolve or generate audio
    let audioUrl = extras.audioUrl || null;
    if (!audioUrl && extras.audioScript?.trim()) {
      await this._stage('AUDIO_TTS');
      audioUrl = await generateTtsAudio({
        text: extras.audioScript,
        voiceId: extras.voiceId || 'rachel',
        language: extras.language || 'en',
      }).catch((err) => {
        throw new PipelineError(`TTS failed: ${err.message}`, { 
          code: 'tts_failed', stage: 'audio', refundable: true 
        });
      });
    }
    
    // 2. Resolve portrait — user upload > template preview > null
    const portraitUrl = this.job.userInputs?.referenceImageUrl
      || extras.portraitUrl
      || template?.previewUrl
      || null;
    
    if (!portraitUrl) {
      throw new PipelineError(
        'UGC requires a portrait image',
        { code: 'missing_portrait', stage: 'prepare', refundable: true }
      );
    }
    
    // 3. Compose prompt from template + user action
    const promptParts = [
      template?.promptBlueprint,
      extras.actionPrompt,
      extras.backgroundPrompt,
    ].filter((p) => p?.toString?.().trim());
    
    const finalPrompt = promptParts.join('. ').slice(0, 900);
    
    return { template, audioUrl, portraitUrl, finalPrompt, extras };
  }
  
  async _buildProviderInput({ template, audioUrl, portraitUrl, finalPrompt }) {
    return {
      prompt: finalPrompt,
      image_url: portraitUrl,
      audio_url: audioUrl,
      aspect_ratio: this.job.userInputs?.aspectRatio || template?.aspectRatio || '9:16',
      duration: this.job.userInputs?.duration || template?.defaultDuration || 8,
      resolution: this.job.userInputs?.resolution || template?.defaultResolution || '720p',
    };
  }
  
  _getAssetMetadata(prepared) {
    return {
      feature: 'ugc',
      templateId: prepared.extras?.templateId || null,
      falModelId: this.falModelId,
      hasAudio: !!prepared.audioUrl,
      language: prepared.extras?.language || 'en',
    };
  }
}

async function runUgcJob(jobId) {
  const StudioJob = require('../../model/schema/studioJob');
  const job = await StudioJob.findById(jobId);
  if (!job) return;
  
  const extras = job.userInputs?.extras || {};
  const falModelId = extras.falModelId || 'fal-ai/veed/avatars';
  
  const pipeline = new UgcPipeline({ jobId, falModelId });
  return await pipeline.run();
}

module.exports = { runUgcJob, UgcPipeline };