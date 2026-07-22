// services/providers/falAdapter.js
const { fal } = require('@fal-ai/client');
const BaseProviderAdapter = require('./baseAdapter');

class FalAdapter extends BaseProviderAdapter {
  buildPayload(canonical) {
    const payload = {};
    const map = this.model.providerHints.paramMap || {};
    
    // Default mappings
    if (canonical.prompt)         payload[map.prompt || 'prompt'] = canonical.prompt;
    if (canonical.startFrame)     payload[map.startFrame || 'image_url'] = canonical.startFrame;
    if (canonical.endFrame)       payload[map.endFrame || 'end_image_url'] = canonical.endFrame;
    
    if (canonical.references) {
      // Some fal models want image_urls, some want elements
      if (this.hints.referenceFormat === 'elements') {
        payload.elements = canonical.references.map(r => ({ frontal_image_url: r }));
      } else {
        payload[map.references || 'image_urls'] = canonical.references;
      }
    }
    
    if (canonical.refVideos) payload.video_urls = canonical.refVideos;
    if (canonical.refAudios) payload.audio_urls = canonical.refAudios;
    
    if (canonical.durationSec != null) {
      // fal sometimes wants string, sometimes integer — hint says which
      payload.duration = this.hints.durationAsString 
        ? String(canonical.durationSec) 
        : canonical.durationSec;
    }
    
    if (canonical.resolution)   payload.resolution = canonical.resolution;
    if (canonical.aspectRatio)  payload.aspect_ratio = canonical.aspectRatio;
    if (canonical.generateAudio != null) payload.generate_audio = canonical.generateAudio;
    if (canonical.seed != null) payload.seed = canonical.seed;
    
    if (canonical.multiPrompt)  payload.multi_prompt = canonical.multiPrompt;
    
    return payload;
  }
  
  async submit(canonical) {
    const payload = this.buildPayload(canonical);
    const result = await fal.queue.submit(this.model.providerModelId, {
      input: payload,
      webhookUrl: process.env.FAL_WEBHOOK_URL,
    });
    return { 
      requestId: result.request_id, 
      providerJobId: result.request_id,
      raw: result,
    };
  }
  
  async status(jobId) {
    const r = await fal.queue.status(this.model.providerModelId, { requestId: jobId });
    return { status: this._normalizeStatus(r.status), raw: r };
  }
  
  async result(jobId) {
    const r = await fal.queue.result(this.model.providerModelId, { requestId: jobId });
    return {
      videoUrl: r.data?.video?.url,
      imageUrl: r.data?.images?.[0]?.url,
      durationSec: r.data?.video?.duration,
      width: r.data?.video?.width || r.data?.images?.[0]?.width,
      height: r.data?.video?.height || r.data?.images?.[0]?.height,
      raw: r,
    };
  }
  
  _normalizeStatus(s) {
    return { 'IN_QUEUE': 'queued', 'IN_PROGRESS': 'running', 'COMPLETED': 'completed' }[s] || 'unknown';
  }
}