'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * callHaiku — single text completion over messages[].
 * @param {Array<{role:'user'|'system'|'assistant', content:string}>} messages
 * @returns {Promise<string>} assistant text content
 */
async function callHaiku(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const userMsgs = messages.filter((m) => m.role !== 'system');

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: system || undefined,
    messages: userMsgs,
  });
  return resp.content[0]?.text || '';
}

module.exports = { callHaiku };
