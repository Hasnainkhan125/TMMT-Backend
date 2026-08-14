// services/providers/openaiAdapter.js  
class OpenAiAdapter extends BaseProviderAdapter {
    buildPayload(canonical) {
      // OpenAI image API:
      return {
        model: this.model.providerModelId,
        prompt: canonical.prompt,
        n: canonical.numVariants || 1,
        size: this._mapSize(canonical.aspectRatio),
        quality: canonical.quality || 'high',
        // OpenAI uses base64 for image inputs in edit mode:
        ...(canonical.startFrame ? { image: canonical.startFrame } : {}),
      };
    }
    
    async submit(canonical) { /* ... */ }
    // etc
  }