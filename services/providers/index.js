// services/providers/index.js
const FalAdapter = require('./falAdapter');
const GeminiAdapter = require('./geminiAdapter');
const OpenAiAdapter = require('./openaiAdapter');
const ReplicateAdapter = require('./replicateAdapter');
const RunwayAdapter = require('./runwayAdapter');

const REGISTRY = {
  fal: FalAdapter,
  gemini: GeminiAdapter,
  openai: OpenAiAdapter,
  replicate: ReplicateAdapter,
  runway: RunwayAdapter,
};

function getAdapter(model) {
  const Klass = REGISTRY[model.provider];
  if (!Klass) throw new Error(`no_adapter_for_provider:${model.provider}`);
  return new Klass(model, model.providerHints || {});
}

module.exports = { getAdapter };