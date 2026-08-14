'use strict';

const { runActor } = require('../apifyClient');

const ACTOR_ID = 'curious_coder/website-content-crawler';

/**
 * @param {{ startUrls: { url: string }[], maxCrawlPages?: number }} input
 * @returns {Promise<string>} concatenated markdown of crawled pages
 */
async function fetchWebsiteMarkdown(input) {
  const startUrls = (input.startUrls || []).filter((u) => u && u.url);
  if (!startUrls.length) return '';

  const apifyInput = {
    startUrls,
    maxCrawlPages: Math.min(Math.max(Number(input.maxCrawlPages) || 30, 1), 80),
  };

  const { items } = await runActor(ACTOR_ID, apifyInput, { timeoutSecs: 300, memoryMbytes: 4096 });

  const chunks = (items || [])
    .map((row) => {
      const md =
        row.markdown ||
        row.text ||
        row.cleanedText ||
        row.content ||
        row.body ||
        '';
      return typeof md === 'string' ? md : '';
    })
    .filter(Boolean);

  return chunks.join('\n\n---\n\n').slice(0, 200_000);
}

module.exports = { fetchWebsiteMarkdown, ACTOR_ID };
