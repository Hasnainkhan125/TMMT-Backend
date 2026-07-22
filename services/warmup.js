// services/warmup.js
async function warmupBreakers() {
    const popular = ['fal-ai/flux/schnell','fal-ai/kling-video/v2.5-turbo/standard/text-to-video'];
    for (const id of popular) getBreaker(id);  // creates the breaker, doesn't fire
  }