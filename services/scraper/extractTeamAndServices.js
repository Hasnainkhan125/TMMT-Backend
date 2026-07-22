'use strict';

/**
 * extractTeamAndServices — pulls the brand's team members (doctors, staff,
 * practitioners, founders) and service offerings from rendered HTML.
 *
 * Why: Malabar's homepage exposes 12 doctors with names, titles, photos, and
 * profile URLs in a Swiper carousel. It exposes 8 service departments in
 * dropdown menus. Our previous extractor returned `team: 0 members` and
 * `services: 5 items` (vague auto-summarized blurbs, not actual service
 * names). All of this signal was sitting in plain HTML.
 *
 * Strategy:
 *   - Team: scan menus, dropdowns, doctor-card containers for elements that
 *           look like person entries. Each entry needs at least: a name
 *           matching person-name patterns, optionally a title/credentials,
 *           an image, a profile URL.
 *   - Services: scan menus, headings + sibling lists, swiper carousels,
 *               feature grids. Each entry needs a service name and ideally
 *               a description and URL.
 *
 * We score and dedupe so the same doctor mentioned in 3 different swipers
 * counts once but with high confidence.
 */

const cheerio = require('cheerio');

// ---------- Person name patterns ----------

// Match common honorifics + 1-3 capitalized name parts
// Examples that should match:
//   "Dr. Sumayya Babu", "Dr Basit Hasan", "Dr. Anju Elizabeth Raju"
// Examples that should NOT match:
//   "Dr. Strange" (single name after honorific is fine)
//   "DR SHOUTING ALL CAPS" (we accept caps but only for whole-word recognition)
const PERSON_NAME_PATTERNS = [
  // Doctor honorific + name(s)
  /\b(?:Dr\.?|Doctor|Prof\.?|Professor)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3})/g,
  // Mr/Mrs/Ms + name
  /\b(?:Mr\.?|Mrs\.?|Ms\.?|Eng\.?|Engineer)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3})/g,
];

// Credential / title fragments that suggest a person card
const TITLE_TOKENS = [
  'BDS', 'MDS', 'MD', 'MBBS', 'PhD', 'DDS', 'DMD',
  'CEO', 'CTO', 'CFO', 'COO', 'Founder', 'Co-Founder', 'Co-founder',
  'Director', 'Manager', 'Specialist', 'Consultant',
  'Dentist', 'Surgeon', 'Orthodontist', 'Endodontist', 'Periodontist',
  'Pedodontist', 'Implantologist', 'Hygienist',
  'Doctor', 'Dr.', 'Dr',
];

// Container selectors where person-cards typically live
const TEAM_CONTAINER_SELECTORS = [
  '.swiper-slide',
  '.doctor-card', '.team-card', '.staff-card', '.member-card',
  '.post-card', // generic card class some themes use
  '.elementor-team-member',
  '[class*="team"]', '[class*="doctor"]', '[class*="staff"]',
  '.team-grid > *', '.team-list > *',
  'article.team', 'article.member',
];

// ---------- Service patterns ----------

const SERVICE_TOKENS = [
  'service', 'services', 'department', 'departments',
  'specialty', 'specialties', 'speciality', 'specialities',
  'treatment', 'treatments', 'procedure', 'procedures',
  'product', 'products', 'menu', 'offering', 'offerings',
];

// Service categories vary by vertical — we keep a list of strong indicators
// for medical/dental, F&B, retail, real estate, automotive
const SERVICE_INDICATOR_PATTERNS = [
  // Dental
  /\b(?:dentistry|orthodontics?|endodontics?|periodontics?|pedodontics?|implant(?:ology|s)?|root canal|teeth (?:whitening|cleaning)|braces|veneers?|extractions?|crowns?|bridges?|invisalign)\b/i,
  // Medical
  /\b(?:cardiology|dermatology|neurology|oncology|radiology|surgery|pediatrics|gynecology)\b/i,
  // F&B
  /\b(?:appetizers?|mains?|desserts?|beverages?|starters?|breakfast|lunch|dinner|menu|cuisine|grill|bbq)\b/i,
  // Real estate
  /\b(?:apartments?|villas?|townhouses?|penthouses?|studios?|leasing|sales|management|brokerage|valuation)\b/i,
  // Retail / e-com
  /\b(?:laptop|smartphone|accessor(?:y|ies)|appliance|tv|computer|tablet|headphone)\b/i,
];

// ---------- Helpers ----------

function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function looksLikePersonName(text) {
  if (!text) return false;
  const cleaned = cleanText(text);
  if (cleaned.length < 4 || cleaned.length > 80) return false;

  for (const pattern of PERSON_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) return true;
  }

  // Also accept "FirstName LastName" if it has 2-3 caps-words and a known
  // title nearby in the surrounding container (caller responsibility).
  return false;
}

function extractNameFrom(text) {
  if (!text) return null;
  const cleaned = cleanText(text);

  for (const pattern of PERSON_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(cleaned);
    if (m) {
      // Prefer whole match including "Dr."
      const fullMatch = m[0];
      return cleanText(fullMatch).replace(/\.+$/, '');
    }
  }

  // Fallback: 2-3 capitalized words in a row
  const fallback = cleaned.match(/\b[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2}\b/);
  if (fallback) return cleaned.startsWith('Dr') ? `Dr. ${fallback[0]}` : fallback[0];

  return null;
}

function pickFirstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (c && cleanText(c)) return cleanText(c);
  }
  return null;
}

function absolutize(href, baseUrl) {
  if (!href) return null;
  if (/^https?:/i.test(href)) return href;
  if (!baseUrl) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---------- Team extraction ----------

function extractTeamFromContainers($, baseUrl) {
  const candidates = new Map(); // key = normalized name, value = candidate

  for (const sel of TEAM_CONTAINER_SELECTORS) {
    $(sel).each((_, el) => {
      const $card = $(el);
      const cardText = cleanText($card.text());
      if (cardText.length < 5 || cardText.length > 800) return;

      // Look for name in obvious places first
      const nameText =
        pickFirstNonEmpty(
          $card.find('h1, h2, h3, h4').first().text(),
          $card.find('.name, .person-name, .doctor-name, .member-name').first().text(),
          $card.find('img').first().attr('alt')
        ) || cardText;

      const name = extractNameFrom(nameText);
      if (!name) return;

      // Title / credentials
      const titleText = pickFirstNonEmpty(
        $card.find('.designation, .title, .role, .credentials, .specialty, .specialization').first().text(),
        $card.find('p.designation, p.title').first().text(),
        $card.find('h5, h6').first().text()
      );

      // Image
      const imgEl = $card.find('img').first();
      const image = imgEl.length
        ? absolutize(imgEl.attr('src') || imgEl.attr('data-src') || '', baseUrl)
        : null;

      // Profile URL
      const profileLink = $card.find('a[href]').first();
      const profileUrl = profileLink.length
        ? absolutize(profileLink.attr('href') || '', baseUrl)
        : null;

      // Bio (short)
      const bioText = pickFirstNonEmpty(
        $card.find('.bio, .short-bio, .description, .summary').first().text(),
        $card.find('p').not('.designation').not('.title').first().text()
      );

      const key = name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
      const existing = candidates.get(key);

      const entry = {
        name,
        title: titleText || null,
        image,
        profileUrl,
        bio: bioText && bioText.length < 280 ? bioText : null,
        confidence: 0,
        sources: [sel],
      };

      // Confidence scoring
      if (titleText && TITLE_TOKENS.some((t) => titleText.includes(t))) entry.confidence += 3;
      if (image) entry.confidence += 2;
      if (profileUrl) entry.confidence += 2;
      if (bioText) entry.confidence += 1;
      if (name.startsWith('Dr')) entry.confidence += 2;

      if (entry.confidence < 2) return; // Too weak

      if (existing) {
        existing.confidence = Math.max(existing.confidence, entry.confidence);
        existing.title = existing.title || entry.title;
        existing.image = existing.image || entry.image;
        existing.profileUrl = existing.profileUrl || entry.profileUrl;
        existing.bio = existing.bio || entry.bio;
        if (!existing.sources.includes(sel)) existing.sources.push(sel);
      } else {
        candidates.set(key, entry);
      }
    });
  }

  return Array.from(candidates.values()).sort((a, b) => b.confidence - a.confidence);
}

// Fallback: scan menu items for "Dr. X" entries (Malabar has 12 doctors in nav)
function extractTeamFromMenus($, baseUrl) {
  const candidates = new Map();

  $('nav a, .menu a, .sub-menu a, [class*="menu"] a').each((_, el) => {
    const $a = $(el);
    const text = cleanText($a.text());
    const name = extractNameFrom(text);
    if (!name) return;
    if (!/^(?:Dr|Doctor|Prof)/i.test(name)) return; // require honorific in menus

    const href = $a.attr('href') || '';
    const profileUrl = absolutize(href, baseUrl);

    const key = name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    if (candidates.has(key)) return;

    candidates.set(key, {
      name,
      title: null,
      image: null,
      profileUrl,
      bio: null,
      confidence: 4, // menu listing = strong signal
      sources: ['menu'],
    });
  });

  return Array.from(candidates.values());
}

// ---------- Service extraction ----------

function extractServicesFromMenus($, baseUrl) {
  const candidates = new Map();

  // Find the menu item whose text suggests "services" / "departments"
  // and walk its sub-menu
  $('nav a, .menu a, [class*="menu"] a').each((_, el) => {
    const $a = $(el);
    const text = cleanText($a.text());
    if (!text) return;
    if (!SERVICE_TOKENS.some((tok) => text.toLowerCase().includes(tok))) return;

    // Walk the parent's submenu
    const $parent = $a.closest('li, .menu-item, [class*="menu-item"]');
    const $submenu = $parent.find('.sub-menu, .submenu, ul');
    if (!$submenu.length) return;

    $submenu.find('a').each((_, subEl) => {
      const $sub = $(subEl);
      const subText = cleanText($sub.text());
      if (!subText || subText.length < 2 || subText.length > 80) return;
      if (SERVICE_TOKENS.includes(subText.toLowerCase())) return; // skip "Services" itself

      const href = $sub.attr('href') || '';
      const url = absolutize(href, baseUrl);

      const key = subText.toLowerCase();
      if (candidates.has(key)) return;

      candidates.set(key, {
        name: subText,
        category: text, // parent menu item
        url,
        description: null,
        confidence: 3,
        sources: ['menu'],
      });
    });
  });

  return Array.from(candidates.values());
}

function extractServicesFromCards($, baseUrl) {
  const candidates = new Map();

  // Service cards typically: image + h3/h4 + short description + read-more link
  const cardSelectors = [
    '.service-card', '.department-card', '.specialty-card',
    '.swiper-slide', '.post-card',
    '[class*="service"]', '[class*="department"]', '[class*="specialty"]',
  ];

  for (const sel of cardSelectors) {
    $(sel).each((_, el) => {
      const $card = $(el);
      const titleEl = $card.find('h1, h2, h3, h4').first();
      if (!titleEl.length) return;

      const title = cleanText(titleEl.text());
      if (!title || title.length < 3 || title.length > 80) return;

      // Skip if title is a person name (this is a doctor card, not a service)
      if (extractNameFrom(title) && /^Dr/i.test(title)) return;

      // Must look service-y
      const allText = cleanText($card.text());
      const isService =
        SERVICE_INDICATOR_PATTERNS.some((rx) => rx.test(allText)) ||
        SERVICE_TOKENS.some((tok) => allText.toLowerCase().includes(tok));
      if (!isService && allText.length < 30) return;

      const description = cleanText(
        $card.find('p').first().text() || ''
      );

      const linkEl = $card.find('a[href]').first();
      const url = linkEl.length ? absolutize(linkEl.attr('href') || '', baseUrl) : null;

      const key = title.toLowerCase();
      const existing = candidates.get(key);
      const confidence = (description ? 2 : 1) + (url ? 1 : 0) +
        (SERVICE_INDICATOR_PATTERNS.some((rx) => rx.test(title)) ? 2 : 0);

      if (existing) {
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.description = existing.description || (description.length < 200 ? description : null);
        existing.url = existing.url || url;
      } else {
        candidates.set(key, {
          name: title,
          category: null,
          url,
          description: description && description.length < 200 ? description : null,
          confidence,
          sources: [sel],
        });
      }
    });
  }

  return Array.from(candidates.values());
}

// Merge two service lists, preferring entries with URLs and descriptions
function mergeServiceLists(...lists) {
  const merged = new Map();

  for (const list of lists) {
    for (const svc of list) {
      const key = svc.name.toLowerCase().trim();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, svc);
        continue;
      }
      // Merge: keep richest fields
      existing.url = existing.url || svc.url;
      existing.category = existing.category || svc.category;
      existing.description = existing.description || svc.description;
      existing.confidence = Math.max(existing.confidence, svc.confidence);
      existing.sources = Array.from(new Set([...existing.sources, ...svc.sources]));
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
}

// ---------- Main entrypoint ----------

/**
 * Extract team and services from rendered HTML.
 *
 * @param {object} opts
 * @param {string} opts.html - merged HTML (multi-page is fine)
 * @param {string} [opts.baseUrl] - for resolving relative links
 * @returns {{
 *   team: Array<{name, title, image, profileUrl, bio, confidence}>,
 *   services: Array<{name, category, url, description, confidence}>,
 *   stats: { teamCount, servicesCount }
 * }}
 */
function extractTeamAndServices({ html, baseUrl } = {}) {
  if (!html || typeof html !== 'string') {
    return { team: [], services: [], stats: { teamCount: 0, servicesCount: 0 } };
  }

  const $ = cheerio.load(html, { decodeEntities: false });

  // Team
  const teamFromCards = extractTeamFromContainers($, baseUrl);
  const teamFromMenus = extractTeamFromMenus($, baseUrl);
  const teamMap = new Map();
  for (const t of [...teamFromCards, ...teamFromMenus]) {
    const key = t.name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    const existing = teamMap.get(key);
    if (!existing) {
      teamMap.set(key, t);
    } else {
      existing.title = existing.title || t.title;
      existing.image = existing.image || t.image;
      existing.profileUrl = existing.profileUrl || t.profileUrl;
      existing.bio = existing.bio || t.bio;
      existing.confidence = Math.max(existing.confidence, t.confidence);
      existing.sources = Array.from(new Set([...existing.sources, ...t.sources]));
    }
  }
  const team = Array.from(teamMap.values())
    .filter((t) => t.confidence >= 2)
    .sort((a, b) => b.confidence - a.confidence);

  // Services
  const servicesFromMenus = extractServicesFromMenus($, baseUrl);
  const servicesFromCards = extractServicesFromCards($, baseUrl);
  const services = mergeServiceLists(servicesFromMenus, servicesFromCards)
    .filter((s) => s.confidence >= 2);

  return {
    team,
    services,
    stats: {
      teamCount: team.length,
      servicesCount: services.length,
    },
  };
}

module.exports = {
  extractTeamAndServices,
  _internal: {
    extractNameFrom,
    looksLikePersonName,
    extractTeamFromContainers,
    extractTeamFromMenus,
    extractServicesFromMenus,
    extractServicesFromCards,
    mergeServiceLists,
    cleanText,
  },
};
