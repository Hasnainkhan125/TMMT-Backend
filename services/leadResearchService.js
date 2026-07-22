/**
 * leadResearchService.js — Apollo.io lead research, AI scoring, and DB persistence
 *
 * Apollo client is centralized in services/apolloClient.js — do NOT add a second
 * Apollo base URL or key lookup here.
 */

const axios      = require('axios');
const Anthropic  = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const BrandProject = require('../model/schema/brandProject');
const apollo = require('./apolloClient');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
const APOLLO_BASE = apollo.APOLLO_BASE;
function getApolloKey() { return apollo.getApolloKey(); }

// ── UAE / GCC location filter (always applied) ────────────────────────────────
const UAE_GCC_LOCATIONS = [
  'Dubai',
  'Abu Dhabi',
  'Sharjah',
  'United Arab Emirates',
  'Saudi Arabia',
  'Kuwait',
  'Qatar',
  'Oman',
];

// ── Category to Apollo filter mapping ────────────────────────────────────────
const CATEGORY_MAP = {
  perfume: {
    personTitles: ['Retail Buyer', 'Category Manager', 'Store Owner', 'CEO'],
    industries:   ['Retail', 'Cosmetics', 'Luxury Goods'],
  },
  fragrance: {
    personTitles: ['Retail Buyer', 'Category Manager', 'Store Owner', 'CEO'],
    industries:   ['Retail', 'Cosmetics', 'Luxury Goods'],
  },
  skincare: {
    personTitles: ['Buyer', 'Category Manager', 'Brand Manager', 'CEO'],
    industries:   ['Retail', 'Health and Wellness', 'Cosmetics'],
  },
  food: {
    personTitles: ['F&B Manager', 'Procurement Manager', 'Restaurant Owner', 'CEO'],
    industries:   ['Food and Beverages', 'Hospitality'],
  },
  food_beverage: {
    personTitles: ['F&B Manager', 'Procurement Manager', 'Restaurant Owner', 'CEO'],
    industries:   ['Food and Beverages', 'Hospitality'],
  },
  clothing: {
    personTitles: ['Buyer', 'Fashion Director', 'Merchandising Manager', 'CEO'],
    industries:   ['Retail', 'Fashion', 'Apparel'],
  },
  fashion: {
    personTitles: ['Buyer', 'Fashion Director', 'Merchandising Manager', 'CEO'],
    industries:   ['Retail', 'Fashion', 'Apparel'],
  },
  tech: {
    personTitles: ['CTO', 'IT Manager', 'CEO', 'Founder', 'Product Manager'],
    industries:   ['Information Technology', 'Software', 'SaaS'],
  },
  technology: {
    personTitles: ['CTO', 'IT Manager', 'CEO', 'Founder', 'Product Manager'],
    industries:   ['Information Technology', 'Software', 'SaaS'],
  },
  wellness: {
    personTitles: ['Wellness Director', 'Operations Manager', 'CEO', 'Founder'],
    industries:   ['Health and Wellness', 'Fitness', 'Hospitality'],
  },
  custom: {
    personTitles: ['CEO', 'Founder', 'Managing Director', 'Owner'],
    industries:   [],
  },
};

const DEFAULT_FILTERS = {
  personTitles: ['CEO', 'Founder', 'Managing Director', 'Owner'],
  industries:   [],
};

/**
 * buildSearchFilters — maps brand category to Apollo search filters.
 * @param {object} brandMemory - brand document or brand memory object
 * @returns {object} Apollo-compatible filter object
 */
function buildSearchFilters(brandMemory) {
  const category = (brandMemory.businessType || brandMemory.category || 'default').toLowerCase();
  const base = CATEGORY_MAP[category] || DEFAULT_FILTERS;

  // Merge any agent-memory b2b targets (decision makers) into titles
  const agentTitles = (brandMemory.agentMemory?.audience?.b2bTargets || [])
    .map(t => t.decisionMaker)
    .filter(Boolean);

  const personTitles = [...new Set([...base.personTitles, ...agentTitles])];

  return {
    personTitles,
    industries:      base.industries,
    personLocations: UAE_GCC_LOCATIONS,
  };
}

/**
 * searchLeads — calls Apollo /mixed_people/search and returns raw lead objects.
 * @param {string} brandId
 * @param {object} brandMemory
 * @param {object} options
 * @returns {object} { people: [], pagination: {} }
 */
function stripEmpty(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v === undefined || v === null) return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  });
  return out;
}

async function searchLeads(brandId, brandMemory, options = { count: 25, page: 1 }) {
  if (!getApolloKey()) throw new Error('Apollo API key not configured (QUMAK_APOLO_LEADS_API_KEY)');

  const { count = 25, page = 1 } = options;
  const filters = buildSearchFilters(brandMemory);

  const perPage = Math.min(Math.max(1, parseInt(String(count), 10) || 25), 50);

  // Apollo returns 422 if filters are invalid — omit empty arrays and use conservative email status first
  const buildBody = (minimal) => {
    const base = {
      api_key: getApolloKey(),
      per_page: perPage,
      page,
    };
    if (!minimal) {
      if (filters.personTitles?.length) base.q_person_title = filters.personTitles.slice(0, 12);
      if (filters.personLocations?.length) base.person_locations = filters.personLocations;
      if (filters.industries?.length) base.q_organization_keyword_tags = filters.industries.slice(0, 8);
      base.contact_email_status = ['verified'];
    } else {
      base.q_person_title = ['CEO', 'Founder', 'Owner'];
      base.person_locations = ['United Arab Emirates', 'Dubai'];
      base.contact_email_status = ['verified'];
    }
    return stripEmpty(base);
  };

  let response;
  try {
    response = await axios.post(
      `${APOLLO_BASE}/mixed_people/search`,
      buildBody(false),
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error || err.message || '';
    console.error('[searchLeads] Apollo error', status, msg);
    if (status === 422 || status === 400) {
      response = await axios.post(
        `${APOLLO_BASE}/mixed_people/search`,
        buildBody(true),
        { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
      );
    } else {
      throw err;
    }
  }

  const rawPeople = response.data.people || [];

  const leads = rawPeople.map(p => ({
    id:           uuidv4(),
    source:       'apollo',
    apolloId:     p.id,
    firstName:    p.first_name || '',
    lastName:     p.last_name  || '',
    fullName:     p.name       || '',
    email:        p.email      || null,
    emailVerified: p.email_status === 'verified',
    title:        p.title      || '',
    company:      p.organization?.name               || '',
    companySize:  String(p.organization?.estimated_num_employees || ''),
    industry:     p.organization?.industry           || '',
    linkedinUrl:  p.linkedin_url                     || '',
    website:      p.organization?.website_url        || '',
    location:     [p.city, p.country].filter(Boolean).join(', '),
    leadStage:    'new',
    outreachMessages: [],
    addedAt:      new Date(),
  }));

  return {
    leads,
    pagination: response.data.pagination || {},
  };
}

/**
 * revealEmail — calls Apollo /people/match to reveal a contact email.
 * @param {string} apolloId
 * @returns {{ email: string|null, verified: boolean }}
 */
async function revealEmail(apolloId) {
  if (!getApolloKey()) throw new Error('Apollo API key not configured (QUMAK_APOLO_LEADS_API_KEY)');

  const response = await axios.post(
    `${APOLLO_BASE}/people/match`,
    {
      api_key: getApolloKey(),
      id: apolloId,
      reveal_personal_emails: false,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );

  const person = response.data.person;
  return {
    email:    person?.email        || null,
    verified: person?.email_status === 'verified',
  };
}

/**
 * scoreLeads — uses Anthropic claude-haiku-4-5 to batch-score leads.
 * @param {Array} leads
 * @param {object} brandMemory
 * @param {object} audienceData - optional extra audience context
 * @returns {Array} leads sorted by icpScore desc
 */
async function scoreLeads(leads, brandMemory, audienceData = {}) {
  if (!leads || leads.length === 0) return [];

  const cfg       = brandMemory.config?.brand || {};
  const brandName = brandMemory.projectName   || cfg.brandName || 'Unnamed Brand';
  const category  = brandMemory.businessType  || 'General';
  const usp       = brandMemory.agentMemory?.usp?.current || cfg.tagline || '';
  const painPoint = brandMemory.agentMemory?.usp?.competitiveGap || '';
  const audience  = audienceData.description  ||
                    brandMemory.agentMemory?.audience?.primary?.description || '';

  const leadsText = leads
    .map((l, i) => `${i}: ${l.title || 'Unknown Title'} at ${l.company || 'Unknown Co'} (${l.industry || 'Unknown Industry'}) — ${l.location || 'Unknown Location'}`)
    .join('\n');

  const prompt = `You are a B2B sales analyst. Score these ${leads.length} leads for ICP fit.

Brand: ${brandName}
Category: ${category}
USP: ${usp}
Target customer: ${audience}
Key pain point we solve: ${painPoint}

Score each lead 0-100 (100 = perfect fit). Consider: title relevance, company relevance, location (UAE/GCC preferred), industry match.

Leads:
${leadsText}

Return ONLY a valid JSON array, no markdown, no explanation:
[{"index":0,"score":85,"rationale":"brief reason","painPoint":"their likely pain","angle":"which USP angle to use"}]`;

  try {
    const response = await getAnthropic().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text   = response.content[0].text.replace(/```json|```/g, '').trim();
    const scores = JSON.parse(text);

    const scored = leads.map((lead, i) => {
      const s = scores.find(x => x.index === i) || {
        score: 50, rationale: 'Auto-scored', painPoint: '', angle: '',
      };
      return {
        ...lead,
        icpScore:       s.score      || 50,
        icpRationale:   s.rationale  || '',
        painPointMatched: s.painPoint || '',
        uspAngle:       s.angle      || '',
      };
    });

    return scored.sort((a, b) => b.icpScore - a.icpScore);
  } catch (err) {
    console.error('[scoreLeads] AI scoring failed:', err.message);
    return leads
      .map(l => ({ ...l, icpScore: 50, icpRationale: 'Auto-scored', painPointMatched: '', uspAngle: '' }))
      .sort((a, b) => b.icpScore - a.icpScore);
  }
}

/**
 * saveLeadsToDb — deduplicates by apolloId and pushes new leads to BrandProject.
 * @param {string} brandId
 * @param {Array}  leads
 * @returns {{ added: number, skipped: number }}
 */
async function saveLeadsToDb(brandId, leads) {
  const brand = await BrandProject.findById(brandId).select('leads');
  if (!brand) throw new Error('Brand not found');

  const existingApolloIds = new Set(
    (brand.leads || []).map(l => l.apolloId).filter(Boolean)
  );

  const newLeads = leads.filter(l => !l.apolloId || !existingApolloIds.has(l.apolloId));

  if (newLeads.length > 0) {
    await BrandProject.findByIdAndUpdate(brandId, {
      $push: { leads: { $each: newLeads, $slice: -500 } },
    });
  }

  return {
    added:   newLeads.length,
    skipped: leads.length - newLeads.length,
  };
}

module.exports = {
  buildSearchFilters,
  searchLeads,
  revealEmail,
  scoreLeads,
  saveLeadsToDb,
};
