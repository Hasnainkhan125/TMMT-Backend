/**
 * urlToAd.test.js
 *
 * Locks in:
 *  - urlScraper.scrapeUrl extracts brand name, OG image, headlines, paragraphs
 *  - urlToAdController.scan returns 3 blueprints with non-empty prompts
 *  - influencerController.buildPrompt synthesizes deterministic prompts
 *
 * No real network — `global.fetch` is mocked per-test. Anthropic is also
 * mocked because adBrain pulls in promptRefiner indirectly via the prompt
 * negative builder in some paths.
 */

process.env.ANTHROPIC_API_KEY = 'test_anthropic_key_mock';

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn().mockResolvedValue({ content: [{ text: 'noop' }] }) },
  }));
});

const { scrapeUrl, parseHtmlData, extractBestBrandIconUrl } = require('../services/urlScraper');
const urlToAdController = require('../controllers/studio/urlToAdController');
const influencerController = require('../controllers/studio/influencerController');

function fakeFetchWith(html, status = 200) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
    body: null,
  });
}

const SAMPLE_HTML = `
<html>
  <head>
    <title>Acme Activewear — Premium gym gear for Dubai athletes</title>
    <link rel="apple-touch-icon" href="https://cdn.acme.com/apple-touch.png" />
    <meta property="og:description" content="Acme Activewear builds high-performance gym gear for Gulf athletes." />
    <meta property="og:image" content="https://cdn.acme.com/hero.jpg" />
    <meta property="og:site_name" content="Acme Activewear" />
  </head>
  <body>
    <h1>Built for the heat</h1>
    <h2>Engineered in Dubai, tested in summer</h2>
    <p>Our compression tee handles 45°C training sessions without losing fit. Designed for early-morning Marina runs and evening rooftop HIIT.</p>
    <p>Every piece is sweat-tested by Dubai athletes before it ships. We don't sponsor influencers — we sponsor early risers.</p>
    <img src="/products/tee-charcoal.jpg" />
    <img src="https://cdn.acme.com/products/tee-olive.jpg" />
  </body>
</html>
`;

describe('urlScraper.scrapeUrl', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('extracts brand name, description, OG image, and category from real-looking HTML', async () => {
    global.fetch = fakeFetchWith(SAMPLE_HTML);
    const out = await scrapeUrl('https://acme.com', { skipCache: true });
    expect(out.brandName).toBe('Acme Activewear');
    expect(out.description).toMatch(/high-performance gym gear/i);
    expect(out.images[0]).toBe('https://cdn.acme.com/hero.jpg');
    expect(out.favicon).toBe('https://cdn.acme.com/apple-touch.png');
    expect(out.category).toBe('gym');
    expect(out.host).toBe('acme.com');
    expect(out.headlines.length).toBeGreaterThan(0);
    expect(out.paragraphs.length).toBeGreaterThan(0);
  });

  it('rejects an unparseable URL with code "invalid_url"', async () => {
    // Anything that survives the auto-https prefix but still fails the WHATWG
    // URL parser. A bare `://` is the simplest reproducer.
    await expect(scrapeUrl('http://')).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('surfaces a friendly error code when the upstream times out', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await expect(scrapeUrl('https://acme.com', { skipCache: true })).rejects.toMatchObject({
      code: 'fetch_timeout',
    });
  });
});

describe('urlScraper brand icon extraction', () => {
  it('parseHtmlData prefers apple-touch-icon over generic rel=icon', () => {
    const html = `
<html><head>
  <link rel="icon" href="/favicon-32x32.png" sizes="32x32" />
  <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example.com/apple.png" />
</head><body></body></html>`;
    const parsed = parseHtmlData(html, new URL('https://store.example.com/'));
    expect(parsed.brandIconUrl).toBe('https://cdn.example.com/apple.png');
  });

  it('extractBestBrandIconUrl resolves Organization.logo from JSON-LD', () => {
    const html = `
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","name":"Co","logo":"https://static.co.test/brand/logo.png"}
</script>`;
    expect(extractBestBrandIconUrl(html, new URL('https://co.test/'))).toBe(
      'https://static.co.test/brand/logo.png',
    );
  });

  it('extractBestBrandIconUrl resolves relative logo URLs', () => {
    const html =
      '<link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/android-chrome-192x192.png" />';
    expect(extractBestBrandIconUrl(html, new URL('https://merchant.example/en/'))).toBe(
      'https://merchant.example/assets/icons/android-chrome-192x192.png',
    );
  });
});

describe('urlToAdController.scan', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns 3 blueprint cards with non-empty prompts and unique aspect ratios', async () => {
    global.fetch = fakeFetchWith(SAMPLE_HTML);

    let captured;
    const req = { body: { url: 'https://acme-blueprint-jest.test' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: (body) => { captured = body; return body; },
    };

    await urlToAdController.scan(req, res);

    expect(captured.success).toBe(true);
    expect(captured.brand.name).toBe('Acme Activewear');
    expect(captured.brand.category).toBe('gym');
    expect(captured.ads).toHaveLength(3);
    captured.ads.forEach((ad) => {
      expect(typeof ad.prompt).toBe('string');
      expect(ad.prompt.length).toBeGreaterThan(40);
      expect(ad.headline).toBeTruthy();
      expect(['1:1', '9:16', '4:5']).toContain(ad.aspectRatio);
    });
  });

  it('surfaces a 502 with an error code if the scrape fails', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      const e = new Error('boom');
      e.name = 'AbortError';
      return Promise.reject(e);
    });
    let captured, statusCode;
    const req = { body: { url: 'https://acme-scrape-fail-jest.test' } };
    const res = {
      status: (n) => { statusCode = n; return res; },
      json: (body) => { captured = body; return body; },
    };
    await urlToAdController.scan(req, res);
    expect(statusCode).toBe(502);
    expect(captured.success).toBe(false);
    expect(captured.error).toBe('fetch_timeout');
  });

  it('rejects empty / missing URL with 400', async () => {
    let captured, statusCode;
    const req = { body: {} };
    const res = {
      status: (n) => { statusCode = n; return res; },
      json: (body) => { captured = body; return body; },
    };
    await urlToAdController.scan(req, res);
    expect(statusCode).toBe(400);
    expect(captured.error).toBe('invalid_url');
  });
});

describe('influencerController.buildPrompt', () => {
  it('combines core attributes into a single coherent prompt', () => {
    const prompt = influencerController.buildPrompt({
      characterType: 'human',
      gender: 'female',
      ethnicity: 'middle eastern',
      age: 'adult',
      eyeColor: 'amber',
      skinMaterial: 'human skin',
      userPrompt: 'on a Marina rooftop at golden hour',
    });
    expect(prompt).toMatch(/USER INTENT: on a Marina rooftop/i);
    expect(prompt).toMatch(/Middle Eastern \/ Khaleeji heritage/);
    expect(prompt).toMatch(/amber-gold eyes/);
    expect(prompt).toMatch(/photorealistic/);
  });

  it('falls back to a sensible default when no character type is given', () => {
    const prompt = influencerController.buildPrompt({});
    expect(prompt).toMatch(/confident person/);
    expect(prompt).toMatch(/photorealistic/);
  });
});
