// services/resolver/steps/extractFonts.js
const cheerio = require('cheerio');

function extractFonts(html) {
  const $ = cheerio.load(html);
  const fonts = new Map();
  
  const addFont = (family, meta = {}) => {
    if (!family) return;
    const cleaned = family.replace(/['"]/g, '').trim();
    if (!cleaned || isGenericFamily(cleaned)) return;
    const existing = fonts.get(cleaned) || { family: cleaned, weights: new Set(), provider: 'unknown', roles: new Set(), urls: new Set() };
    if (meta.weight) existing.weights.add(meta.weight);
    if (meta.provider) existing.provider = meta.provider;
    if (meta.role) existing.roles.add(meta.role);
    if (meta.url) existing.urls.add(meta.url);
    fonts.set(cleaned, existing);
  };
  
  // 1. Google Fonts links
  $('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').each((_, el) => {
    const href = $(el).attr('href');
    // Parse: family=Playfair+Display:wght@400;700|Inter:wght@300;400
    const match = href?.match(/family=([^&]+)/);
    if (!match) return;
    const families = match[1].split('|').map(decodeURIComponent);
    for (const fam of families) {
      const [name, weightPart] = fam.split(':');
      const family = name.replace(/\+/g, ' ');
      const weights = weightPart ? (weightPart.match(/\d+/g) || []) : [];
      addFont(family, { provider: 'google', url: href });
      weights.forEach(w => addFont(family, { weight: w }));
    }
  });
  
  // 2. @font-face rules in <style>
  $('style').each((_, el) => {
    const css = $(el).html() || '';
    const fontFaceMatches = css.matchAll(/@font-face\s*\{([^}]+)\}/g);
    for (const m of fontFaceMatches) {
      const block = m[1];
      const familyMatch = block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i);
      const srcMatch = block.match(/url\(['"]?([^'")]+)['"]?\)/);
      const weightMatch = block.match(/font-weight\s*:\s*(\d+)/i);
      
      if (familyMatch) {
        const family = familyMatch[1].trim();
        addFont(family, {
          provider: srcMatch?.[1].includes('fonts.gstatic') ? 'google' : 'self-hosted',
          url: srcMatch?.[1],
          weight: weightMatch?.[1],
        });
      }
    }
  });

  // 4b. WordPress Gutenberg font presets (--wp--preset--font-family-*)
const wpFontMatches = html.matchAll(/--wp--preset--font-family--([a-z0-9-]+)\s*:\s*([^;]+);/gi);
for (const m of wpFontMatches) {
  const slug = m[1];
  const value = m[2].trim();
  // Value is like: "Playfair Display, serif" or `var(--some-var)`
  const family = value.split(',')[0].replace(/['"]/g, '').trim();
  if (family && !family.startsWith('var(')) {
    addFont(family, { provider: 'wordpress', role: slug.includes('heading') ? 'headings' : 'body' });
  }
}

// 5b. CSS font-family declarations outside <style> tags are already caught by inline styles
// But also check any text-style pattern
$('[class*="font-"]').each((_, el) => {
  const classes = $(el).attr('class') || '';
  // Match patterns like "font-playfair", "font-inter"
  const match = classes.match(/font-([a-z][a-z0-9-]+)/i);
  if (match && match[1].length > 2) {
    // We don't know actual family from class alone, skip
  }
});
  
  // 3. Inline style font-family usage
  $('[style*="font-family"]').each((_, el) => {
    const style = $(el).attr('style');
    const match = style?.match(/font-family\s*:\s*([^;]+)/i);
    if (!match) return;
    const family = match[1].split(',')[0].replace(/['"]/g, '').trim();
    const tag = el.name?.toLowerCase();
    let role = 'body';
    if (/^h[1-6]$/.test(tag)) role = 'headings';
    else if (tag === 'button' || /btn|cta/i.test($(el).attr('class') || '')) role = 'ui';
    addFont(family, { role });
  });
  
  // 4. Adobe Typekit
  $('link[href*="use.typekit.net"]').each((_, el) => {
    addFont('typekit-active', { provider: 'adobe', url: $(el).attr('href') });
  });
  
  // 5. Font providers by script src
  if (/typekit|fonts\.adobe/.test(html)) {
    addFont('__adobe_fonts_detected', { provider: 'adobe' });
  }
  if (/fonts\.bunny\.net/.test(html)) {
    addFont('__bunny_fonts_detected', { provider: 'bunny' });
  }
  
  return Array.from(fonts.values()).map(f => ({
    family: f.family,
    weights: Array.from(f.weights),
    provider: f.provider,
    roles: Array.from(f.roles),
    urls: Array.from(f.urls).slice(0, 2),
  })).filter(f => !f.family.startsWith('__'));
}

function isGenericFamily(family) {
  return /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial|unset)$/i.test(family);
}

module.exports = { extractFonts };