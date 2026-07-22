'use strict';

/**
 * vibeMotionPipeline — Vibe Motion rendering using VideoGenerationPipeline.
 *
 * Replaces vibeMotionService.runVibeMotionJob — 100 lines → 50 lines.
 */

const { VideoGenerationPipeline, PipelineError } = require('./VideoGenerationPipeline');

const PRESET_CONFIG = {
  infographics: {
    name: 'Infographics',
    falModelId: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    promptPrefix: 'Animated infographic with clean geometric shapes, crisp type, precise motion. ',
    aspectRatio: '16:9',
    duration: 10,
  },
  textAnimation: {
    name: 'Text Animation',
    falModelId: 'fal-ai/kling-video/v2/master/text-to-video',
    promptPrefix: 'Cinematic kinetic typography with bold color, studio lighting. ',
    aspectRatio: '9:16',
    duration: 10,
  },
  posters: {
    name: 'Posters',
    falModelId: 'fal-ai/pika/v2.2/image-to-video',
    promptPrefix: 'Editorial poster with slow dramatic camera push and subtle parallax. ',
    aspectRatio: '9:16',
    duration: 10,
    requiresImage: true,
  },
  presentation: {
    name: 'Presentation',
    falModelId: 'fal-ai/veo3/fast',
    promptPrefix: 'Smooth motion-slide presentation with cinematic transitions. ',
    aspectRatio: '16:9',
    duration: 10,
  },
  scratch: {
    name: 'From scratch',
    falModelId: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    promptPrefix: '',
    aspectRatio: '16:9',
    duration: 10,
  },
};

function getPresetConfig(preset) {
  return PRESET_CONFIG[preset] || PRESET_CONFIG.scratch;
}

class VibeMotionPipeline extends VideoGenerationPipeline {
  constructor(opts) {
    super({ ...opts, feature: 'vibeMotion', kind: 'video' });
    this.cfg = opts.cfg; // preset config
  }
  
  async _prepare() {
    const extras = this.job.userInputs?.extras || {};
    const userPrompt = (this.job.userInputs?.description || '').trim();
    const referenceImageUrl = this.job.userInputs?.referenceImageUrl 
      || extras.seedTileUrl 
      || null;
    
    if (this.cfg.requiresImage && !referenceImageUrl) {
      throw new PipelineError(
        `${this.cfg.name} preset requires a source image. Upload one to continue.`,
        { code: 'missing_image', stage: 'prepare', refundable: true }
      );
    }
    
    const finalPrompt = `${this.cfg.promptPrefix}${userPrompt}`.trim();
    
    return {
      finalPrompt,
      referenceImageUrl,
      aspectRatio: this.job.userInputs?.aspectRatio || this.cfg.aspectRatio,
      duration: this.job.userInputs?.duration || this.cfg.duration,
    };
  }
  
  async _buildProviderInput({ finalPrompt, referenceImageUrl, aspectRatio, duration }) {
    const payload = {
      prompt: finalPrompt,
      aspect_ratio: aspectRatio,
      duration,
    };
    
    if (this.cfg.requiresImage || referenceImageUrl) {
      payload.image_url = referenceImageUrl || undefined;
    }
    
    return payload;
  }
  
  _getAssetMetadata(prepared) {
    return {
      feature: 'vibeMotion',
      preset: this.job.userInputs?.extras?.preset || 'scratch',
      falModelId: this.falModelId,
    };
  }
}

async function runVibeMotionJob(jobId) {
  const StudioJob = require('../../model/schema/studioJob');
  const job = await StudioJob.findById(jobId);
  if (!job) return;
  
  const preset = job.userInputs?.extras?.preset || 'scratch';
  const cfg = getPresetConfig(preset);
  
  const pipeline = new VibeMotionPipeline({
    jobId,
    falModelId: cfg.falModelId,
    cfg,
  });
  
  return await pipeline.run();
}

module.exports = {
  runVibeMotionJob,
  VibeMotionPipeline,
  PRESET_CONFIG,
  getPresetConfig,
};