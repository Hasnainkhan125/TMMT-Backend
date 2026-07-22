'use strict';

/**
 * PublicFacebookPageCollector — scrapes the PUBLIC Facebook Page of a brand
 * (not the Ads Library — that's a separate collector) for organic content
 * signals: page name, likes/follower count, recent post copy, bio/website.
 *
 * Why it matters: even when we can't get the Ads Library, organic post copy
 * reveals the rhetorical devices / hooks the brand relies on. Combined
 * with the landing-page crawler we get ~60% of what the Ads Library gives.
 *
 * Playwright would give us 100% of the rendered content, but Playwright is
 * 500MB of Chromium and the user doesn't have it installed. We use plain
 * HTTP + regex here — it catches the server-rendered parts (og tags, page
 * name, about blurb, the 1st-page of posts via `mbasic.facebook.com`), and
 * the orchestrator's circuit breaker auto-disables us if FB blocks the
 * pattern. If needed, we can swap this implementation for a Playwright
 * version later without touching the contract.
 */

const { BaseCollector } = require('../sourceContract');
const { fetchHtml } = require('../httpFetch');
const { _internals } = require('../brandIdentity');

const { pickMeta, safeText } = _internals;

class PublicFacebookPageCollector extends BaseCollector {
  constructor(opts = {}) {
    super('public_fb_page', { reliability: 0.7, ...opts });
  }

  async collect(brandIdentity) {
    const url = brandIdentity?.handles?.facebookPageUrl;
    if (!url) return this.softFail('no_handle');

    return this.cached(
      () => `${url}:${dayStamp()}`,
      3600,
      () => this._collect(url),
    );
  }

  async _collect(url) {
    // mbasic.facebook.com renders server-side and is far friendlier to scrapers
    // than the SPA. We try mbasic first, fall back to the canonical URL.
    const handle = extractHandleFromUrl(url);
    const mbasicUrl = handle ? `https://mbasic.facebook.com/${handle}` : url;

    let html;
    try {
      const r = await fetchHtml(mbasicUrl, { maxAttempts: 2, timeoutMs: 10000 });
      html = r.html;
    } catch (err) {
      if (err.code === 'blocked') return this.retryableFail('blocked_mbasic');
      if (err.code === 'not_found') {
        try {
          const r2 = await fetchHtml(url, { maxAttempts: 2, timeoutMs: 10000 });
          html = r2.html;
        } catch (_err2) {
          return this.softFail('fb_unavailable');
        }
      } else {
        return this.retryableFail(err.code || 'fb_fetch_error');
      }
    }

    if (!html || html.length < 200) return this.softFail('empty_body');

    // Detect "Login to view" / "Page not available" wall.
    if (/log\s*in|please log in|content not available|this content isn't available/i.test(html)) {
      return this.softFail('gated_content');
    }

    const pageName = pickMeta(html, ['og:title']) || extractPageName(html);
    const description = pickMeta(html, ['og:description']);
    const website = extractListedWebsite(html);
    const posts = extractRecentPosts(html);

    if (!pageName && !posts.length) return this.softFail('no_signal');

    return this.ok({
      pageName: pageName || null,
      description: description || null,
      listedWebsite: website || null,
      posts,
      totalPosts: posts.length,
      scrapedUrl: mbasicUrl,
    });
  }
}

function extractHandleFromUrl(u) {
  const m = String(u).match(/facebook\.com\/(?:pages\/[^/]+\/)?([^/?#]+)/i);
  return m ? m[1] : null;
}

function dayStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

function extractPageName(html) {
  const t = safeText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  return t ? t.split(/\s*[-|]\s*/)[0].trim() : '';
}

function extractListedWebsite(html) {
  // mbasic renders `Website` in the About section as plain text followed by a URL.
  const m = html.match(/website[^<]*<[^>]*>\s*(https?:\/\/[^"<\s]+)/i);
  if (m) return m[1];
  const m2 = html.match(/(https?:\/\/(?!www\.facebook\.com)(?:www\.)?[\w.-]+\.[a-z]{2,})/i);
  return m2 ? m2[1] : null;
}

function extractRecentPosts(html) {
  // mbasic post containers have `role="article"` or `<div id="u_...">` with a
  // story_body_container. We take every visible paragraph up to ~15 posts.
  const posts = [];
  // Loosely match the story_body_container blocks that hold post text.
  const re = /<div[^>]*story_body_container[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = re.exec(html)) && posts.length < 15) {
    const body = safeText(m[1]);
    if (body && body.length > 10) posts.push({ text: body });
  }

  // Fallback: just extract any visible paragraph on the page that looks like copy.
  if (!posts.length) {
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let p;
    while ((p = pRe.exec(html)) && posts.length < 20) {
      const body = safeText(p[1]);
      if (body && body.length >= 15 && body.length <= 500) posts.push({ text: body });
    }
  }
  return posts;
}

module.exports = { PublicFacebookPageCollector };
