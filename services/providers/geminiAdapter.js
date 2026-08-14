// services/providers/geminiAdapter.js
const { GoogleGenAI } = require('@google/genai');
const BaseProviderAdapter = require('./baseAdapter');

class GeminiAdapter extends BaseProviderAdapter {
  constructor(model, hints) {
    super(model, hints);
    this.ai = new GoogleGenAI({});
  }
  
  buildPayload(canonical) {
    const config = {};
    const args = {
      model: this.model.providerModelId,  // 'veo-3.1-generate-preview'
      prompt: canonical.prompt,
    };
    
    // Veo handles inputs structurally differently from fal:
    // i2v       → image: {imageBytes, mimeType}
    // ref2v     → config.referenceImages: [{image, referenceType: 'asset'}]
    // interp    → image (start) + config.lastFrame (end)
    // extend    → video: {videoBytes, mimeType}, no image
    
    if (canonical.startFrame && !canonical.references) {
      args.image = canonical.startFrame; // already in {imageBytes, mimeType} shape
    }
    
    if (canonical.endFrame) {
      config.lastFrame = canonical.endFrame;
    }
    
    if (canonical.references?.length) {
      config.referenceImages = canonical.references.map(img => ({
        image: img,
        referenceType: 'asset',
      }));
    }
    
    if (canonical.sourceVideo) {
      args.video = canonical.sourceVideo;
    }
    
    if (canonical.resolution)  config.resolution = canonical.resolution;
    if (canonical.numVariants) config.numberOfVideos = canonical.numVariants;
    if (canonical.aspectRatio) config.aspectRatio = canonical.aspectRatio;
    
    if (Object.keys(config).length) args.config = config;
    return args;
  }
  
  async submit(canonical) {
    const args = this.buildPayload(canonical);
    const operation = await this.ai.models.generateVideos(args);
    return {
      requestId: operation.name,
      providerJobId: operation.name,
      raw: operation,
    };
  }
  
  async status(jobId) {
    // Veo uses long-running operations. We poll.
    const op = await this.ai.operations.getVideosOperation({ operation: { name: jobId } });
    if (op.done) {
      return { status: op.error ? 'failed' : 'completed', raw: op };
    }
    return { status: 'running', raw: op };
  }
  
  async result(jobId) {
    const op = await this.ai.operations.getVideosOperation({ operation: { name: jobId } });
    if (!op.done) throw new Error('not_ready');
    if (op.error) throw new Error(op.error.message);
    
    const video = op.response.generatedVideos[0].video;
    // Veo gives you a file handle — you upload to your own R2 and return a URL
    const r2Url = await this._uploadToR2(video);
    return {
      videoUrl: r2Url,
      durationSec: op.response.generatedVideos[0].duration,
      raw: op,
    };
  }
  
  async _uploadToR2(falFileHandle) {
    // Implementation specific to your storage layer
    // Veo gives you bytes; you stream them to R2 and return the URL
  }
}