'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * callVision — analyse images (frame thumbnails) with a text prompt.
 * @param {{ prompt: string, imageUrls: string[] }} args
 * @returns {Promise<string>}
 */
async function callVision({ prompt, imageUrls = [] }) {
  const imageContent = imageUrls.slice(0, 8).map((url) => ({
    type: 'image',
    source: { type: 'url', url },
  }));

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [...imageContent, { type: 'text', text: prompt }],
      },
    ],
  });
  return resp.content[0]?.text || '';
}

module.exports = { callVision };
