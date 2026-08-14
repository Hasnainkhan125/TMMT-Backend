// services/resolver/steps/extractMetaSignals.js
const cheerio = require('cheerio');

/**
 * Extract every identity signal from HTML head/meta tags.
 * This is the cheapest, highest-confidence source.
 */
function extractMetaSignals(html) {
  const $ = cheerio.load(html);
  
  const signals = {
    // OpenGraph (Facebook standard)
    og: {
      title:       $('meta[property="og:title"]').attr('content')?.trim(),
      description: $('meta[property="og:description"]').attr('content')?.trim(),
      siteName:    $('meta[property="og:site_name"]').attr('content')?.trim(),
      url:         $('meta[property="og:url"]').attr('content')?.trim(),
      image:       $('meta[property="og:image"]').attr('content')?.trim(),
      type:        $('meta[property="og:type"]').attr('content')?.trim(),
      locale:      $('meta[property="og:locale"]').attr('content')?.trim(),
    },
    
    // Twitter Card
    twitter: {
      card:        $('meta[name="twitter:card"]').attr('content')?.trim(),
      site:        $('meta[name="twitter:site"]').attr('content')?.trim(),     // @handle
      creator:     $('meta[name="twitter:creator"]').attr('content')?.trim(),
      title:       $('meta[name="twitter:title"]').attr('content')?.trim(),
      description: $('meta[name="twitter:description"]').attr('content')?.trim(),
      image:       $('meta[name="twitter:image"]').attr('content')?.trim(),
    },
    
    // Facebook Page associations (critical)
    facebook: {
      appId:       $('meta[property="fb:app_id"]').attr('content')?.trim(),
      pageId:      $('meta[property="fb:page_id"]').attr('content')?.trim(),
      pages:       $('meta[property="fb:pages"]').attr('content')?.split(',').map(s => s.trim()).filter(Boolean),
      admins:      $('meta[property="fb:admins"]').attr('content')?.trim(),
    },
    
    // Generic SEO
    seo: {
      title:         $('title').first().text()?.trim(),
      description:   $('meta[name="description"]').attr('content')?.trim(),
      keywords:      $('meta[name="keywords"]').attr('content')?.split(',').map(s => s.trim()).filter(Boolean),
      canonical:     $('link[rel="canonical"]').attr('href')?.trim(),
      robots:        $('meta[name="robots"]').attr('content')?.trim(),
      generator:     $('meta[name="generator"]').attr('content')?.trim(),
      author:        $('meta[name="author"]').attr('content')?.trim(),
      themeColor:    $('meta[name="theme-color"]').attr('content')?.trim(),
      msApplicationColor: $('meta[name="msapplication-TileColor"]').attr('content')?.trim(),
    },
    
    // Language
    lang: {
      html: $('html').attr('lang')?.trim(),
      dir:  $('html').attr('dir')?.trim(),
    },
    
    // Favicon candidates
    favicons: collectFavicons($),
    
    // Apple touch icons (often higher quality than favicons)
    appleTouchIcons: $('link[rel*="apple-touch-icon"]')
      .map((_, el) => ({
        href: $(el).attr('href'),
        sizes: $(el).attr('sizes'),
      }))
      .get()
      .filter(x => x.href),
    
    // Manifest (PWA apps often have brand info here)
    manifestUrl: $('link[rel="manifest"]').attr('href'),
    
    // RSS / feeds
    feeds: $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')
      .map((_, el) => $(el).attr('href'))
      .get()
      .filter(Boolean),
  };
  
  // Schema.org JSON-LD — highest-value structured data
  signals.schemaOrg = extractSchemaOrg($);
  
  // Microdata (schema.org in HTML attrs)
  signals.microdata = extractMicrodata($);
  
  return signals;
}

function collectFavicons($) {
  const candidates = [];
  
  $('link[rel*="icon"]').each((_, el) => {
    const rel = $(el).attr('rel') || '';
    const href = $(el).attr('href');
    const sizes = $(el).attr('sizes');
    const type = $(el).attr('type');
    if (!href) return;
    
    candidates.push({
      href,
      sizes,
      type,
      rel,
      // Score by size (bigger is better for logo extraction)
      score: scoreFavicon(sizes, type),
    });
  });
  
  // Default /favicon.ico as last resort
  if (candidates.length === 0) {
    candidates.push({ href: '/favicon.ico', score: 0 });
  }
  
  return candidates.sort((a, b) => b.score - a.score);
}

function scoreFavicon(sizes, type) {
  let score = 0;
  if (type === 'image/png') score += 5;
  if (type === 'image/svg+xml') score += 10;
  if (sizes) {
    const dims = sizes.split('x');
    const n = parseInt(dims[0], 10);
    if (!isNaN(n)) score += Math.min(n / 32, 20);
  }
  return score;
}

function extractSchemaOrg($) {
  const nodes = [];
  
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      
      for (const node of list) {
        // Handle @graph wrapper
        if (node['@graph'] && Array.isArray(node['@graph'])) {
          nodes.push(...node['@graph']);
        } else {
          nodes.push(node);
        }
      }
    } catch {
      // Silently skip malformed JSON-LD
    }
  });
  
  // Index by type
  const byType = {};
  for (const node of nodes) {
    const type = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
    if (!type) continue;
    if (!byType[type]) byType[type] = [];
    byType[type].push(node);
  }
  
  return {
    all: nodes,
    byType,
    organization:     byType.Organization?.[0] || byType.LocalBusiness?.[0] || byType.Corporation?.[0],
    website:          byType.WebSite?.[0],
    localBusiness:    byType.LocalBusiness?.[0] || byType.Restaurant?.[0] || byType.Store?.[0] || byType.MedicalClinic?.[0],
    product:          byType.Product?.[0],
    breadcrumb:       byType.BreadcrumbList?.[0],
  };
}

function extractMicrodata($) {
  const orgs = [];
  
  $('[itemtype*="schema.org/Organization"], [itemtype*="schema.org/LocalBusiness"]').each((_, el) => {
    const $el = $(el);
    const org = {};
    $el.find('[itemprop]').each((_, sub) => {
      const prop = $(sub).attr('itemprop');
      const content = $(sub).attr('content') || $(sub).attr('href') || $(sub).text().trim();
      if (prop && content) org[prop] = content;
    });
    if (Object.keys(org).length > 0) orgs.push(org);
  });
  
  return { organizations: orgs };
}

module.exports = { extractMetaSignals };