const semaphore = require('../utils/browserSemaphore');

async function renderWithPlaywright(url, opts) {
  await semaphore.acquire();
  const browser = await chromium.launch({ /* ... */ });
  try {
    // ... existing logic
  } finally {
    await browser.close().catch(() => {});
    semaphore.release();
  }
}