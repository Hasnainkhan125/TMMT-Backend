/**
 * brandAgentController.js
 * Marketing Cofounder Agent — powered by Anthropic Claude claude-sonnet
 *
 * Each brand tab gets a specialized agent with:
 *   - Context-aware skill loading from .agents/skills/
 *   - Brand memory stored in MongoDB
 *   - Persistent insights that grow over time
 *   - Live research prompts and competitor intelligence
 */

const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const fs        = require('fs');
const BrandProject = require('../../model/schema/brandProject');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Cache (5min TTL for agent responses) ────────────────────────────────────
const agentCache = new Map();
const CACHE_TTL  = 5 * 60 * 1000;

function getCached(key) {
  const e = agentCache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL) { agentCache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) {
  if (agentCache.size > 200) agentCache.delete(agentCache.keys().next().value);
  agentCache.set(key, { data, ts: Date.now() });
}

// ── Skill file loader ────────────────────────────────────────────────────────
const SKILLS_ROOT = path.resolve(__dirname, '../../../.agents/skills');

function loadSkill(skillName) {
  try {
    const skillPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, 'utf8');
      // Extract the body (skip YAML front matter)
      const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
      return body.substring(0, 3000); // cap at 3k chars
    }
  } catch {}
  return '';
}

// ── Tab → skill mapping ──────────────────────────────────────────────────────
const TAB_SKILLS = {
  dashboard:   ['marketing-ideas', 'customer-research', 'content-strategy'],
  kit:         ['copywriting', 'copy-editing', 'marketing-psychology'],
  social:      ['social-content', 'content-strategy', 'marketing-ideas'],
  content:     ['content-strategy', 'social-content', 'launch-strategy'],
  ads:         ['ad-creative', 'paid-ads', 'marketing-psychology'],
  visuals:     ['ad-creative', 'copywriting'],
  competitors: ['competitor-alternatives', 'customer-research', 'marketing-ideas'],
  suppliers:   ['sales-enablement', 'revops'],
  license:     ['launch-strategy', 'revops'],
};

// ── Tab-specific system prompt builder ──────────────────────────────────────
function buildSystemPrompt(tab, brand, skillTexts) {
  const brandContext = brand ? `
BRAND CONTEXT:
- Brand: ${brand.brandName || 'Unknown'}
- Category: ${brand.category || brand.businessType || 'General'}
- Tagline: ${brand.tagline || ''}
- Target Audience: ${Array.isArray(brand.targetAudience) ? brand.targetAudience.join(', ') : brand.targetAudience || ''}
- Brand Voice: ${brand.brandVoice || ''}
- Positioning: ${brand.positioning || brand.uniqueSellingPoint || ''}
- Colors: ${Array.isArray(brand.colorPalette) ? brand.colorPalette.map(c => c.hex || c).join(', ') : ''}
- Market: ${brand.market || 'UAE / Global'}
` : '';

  const tabInstructions = {
    dashboard: `You are a Marketing Cofounder reviewing the overall brand strategy. 
Give specific USP suggestions, KPI priorities, and growth actions the founder can take TODAY.
Be provocative — what is the ONE thing they must do to grow?`,

    kit: `You are a Brand Identity Strategist reviewing this brand kit. 
Suggest improvements to copy, voice, messaging hierarchy. 
Point out what's missing that top brands have. Give exact alternative copy they can use.`,

    social: `You are a Social Media Growth Expert.
Research what top brands in this category are doing on each platform.
Give platform-specific angles: LinkedIn for B2B trust, Instagram for visual storytelling, 
TikTok for virality, X for thought leadership. 
Suggest 3 post hooks they can use today.`,

    content: `You are a Content Calendar Strategist.
Review the content mix and suggest what content types will drive the most engagement.
Give a 4-week theme structure with specific day-by-day focus areas.
Identify content gaps that competitors are exploiting.`,

    ads: `You are a Performance Marketing Expert.
Analyze this brand's ad potential. What is the estimated CPM, CPC, and ROAS for their category?
Give specific ad headline angles (3 approaches), audience targeting suggestions,
and estimate daily ad spend needed to see results in 90 days.`,

    visuals: `You are a Creative Director reviewing brand visuals.
Suggest the visual style, mood board direction, and specific image compositions
that would resonate with their target audience. 
What do competitor brands look like visually, and how can we stand out?`,

    competitors: `You are a Competitive Intelligence Analyst.
Research this brand's competitive landscape. Who are the top 3 competitors?
What are their weaknesses? What is the whitespace opportunity?
Give a specific USP angle that no competitor is using.`,

    suppliers: `You are a Supply Chain Strategist.
Identify key supplier categories this brand needs.
Suggest supplier qualification criteria, negotiation tips, and red flags.
What are the margins they should target?`,

    license: `You are a Business Setup Expert for UAE/global markets.
Guide the founder through the trade license and compliance requirements.
What license type fits their business? What are the costs and timelines?
What common mistakes should they avoid?`,
  };

  const skillContent = skillTexts.map(s => s.trim()).filter(Boolean).join('\n\n---\n\n');

  return `You are the AI Marketing Cofounder for Qumak — a seasoned startup advisor who has built 10+ companies and raised millions.
You speak directly, confidently, and practically. No fluff. No vague advice. Just specific, actionable intelligence.

${tabInstructions[tab] || tabInstructions.dashboard}

${brandContext}

MARKETING EXPERTISE (from your skills library):
${skillContent.substring(0, 4000)}

RESPONSE FORMAT:
- Lead with the most important insight in BOLD
- Use bullet points for action items
- Include specific numbers, timelines, and metrics where possible
- Always end with "Next Step: [one specific action]"
- Keep total response under 400 words
- Be provocative and specific to THIS brand, not generic advice`;
}

// ── Store agent memory in BrandProject (uses new chatHistory sub-array) ──────
async function storeAgentMemory(brandProjectId, tab, message, response) {
  try {
    if (!brandProjectId) return;
    await BrandProject.findByIdAndUpdate(brandProjectId, {
      $push: {
        'agentMemory.chatHistory': {
          $each: [{ tab, message: message.substring(0, 500), response: response.substring(0, 2000), createdAt: new Date() }],
          $slice: -50,
        },
      },
    });
  } catch (e) { console.error('[storeAgentMemory]', e.message); }
}

// ── Load previous agent memory ───────────────────────────────────────────────
async function loadAgentMemory(brandProjectId, tab) {
  try {
    if (!brandProjectId) return [];
    const project = await BrandProject.findById(brandProjectId).select('agentMemory.chatHistory').lean();
    const history = project?.agentMemory?.chatHistory || [];
    return history
      .filter(m => m.tab === tab)
      .slice(-5)
      .map(m => ({ role: 'user', content: m.message }));
  } catch { return []; }
}

// ── POST /agent/insights — Get tab-specific agent insights ───────────────────
exports.getAgentInsights = async (req, res) => {
  try {
    const { brandProjectId, tab = 'dashboard', brand, message, context } = req.body;

    if (!brand && !brandProjectId) {
      return res.status(400).json({ success: false, message: 'Brand data required' });
    }

    // Cache key
    const cacheKey = `agent_${brandProjectId || 'anon'}_${tab}_${(message || 'auto').substring(0, 40)}`;
    const cached = getCached(cacheKey);
    if (cached && !message) return res.json({ success: true, ...cached, cached: true });

    // Load skills for this tab
    const skillNames = TAB_SKILLS[tab] || TAB_SKILLS.dashboard;
    const skillTexts = skillNames.map(s => loadSkill(s)).filter(Boolean);

    // Load previous memory
    const prevMemory = await loadAgentMemory(brandProjectId, tab);

    // Build system prompt
    const systemPrompt = buildSystemPrompt(tab, brand, skillTexts);

    // Auto-prompt if no message provided
    const userMessage = message || `Give me your most important insight and 3 specific actions I should take RIGHT NOW for the ${tab} section of my brand ${brand?.brandName || ''}. Be direct and specific.`;

    // Build messages array
    const messages = [
      ...prevMemory,
      { role: 'user', content: userMessage },
    ];

    // Call Claude
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const agentResponse = response.content[0]?.text || 'No insights available.';

    // Store in brand memory
    await storeAgentMemory(brandProjectId, tab, userMessage, agentResponse);

    const result = {
      insight: agentResponse,
      tab,
      skills: skillNames,
      timestamp: new Date().toISOString(),
    };

    if (!message) setCache(cacheKey, result);

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[BrandAgent] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Agent temporarily unavailable', error: err.message });
  }
};

// ── POST /agent/content-ideas — Generate platform-specific post ideas ─────────
exports.generateContentIdeas = async (req, res) => {
  try {
    const { brand, platform, contentType, dayNumber, context } = req.body;

    if (!brand) return res.status(400).json({ success: false, message: 'Brand required' });

    const socialSkill = loadSkill('social-content');
    const copySkill   = loadSkill('copywriting');

    const platformGuidelines = {
      instagram: 'Instagram: Visual-first. 2200 char max. 30 hashtags max. Use line breaks. Hook in first line. Stories and carousels get 3x reach.',
      facebook:  'Facebook: Longer form works. Videos get 6x more engagement. Ask questions. Use emojis sparingly. Tag relevant pages.',
      linkedin:  'LinkedIn: Professional tone. Personal story drives 2x engagement. No more than 3 hashtags. First 3 lines must hook. Polls get massive reach.',
      tiktok:    'TikTok: First 3 seconds are everything. Trending sounds. Text overlay. Hook → Problem → Solution → CTA. Informal tone.',
      x:         'X/Twitter: Under 280 chars for text-only. Threads for depth. Hot takes perform. Start with a strong statement. No hashtag stuffing.',
      youtube:   'YouTube Shorts: 60 seconds max. Strong hook in 0-3s. Tutorial or story format. CTAs at 30s and 55s mark.',
    };

    const prompt = `Generate engaging ${platform} content for this brand:

Brand: ${brand.brandName}
Category: ${brand.category || brand.businessType || 'Business'}
Tagline: ${brand.tagline || ''}
Target Audience: ${Array.isArray(brand.targetAudience) ? brand.targetAudience.join(', ') : brand.targetAudience || 'General'}
Brand Voice: ${brand.brandVoice || 'Professional and authentic'}
Content Type: ${contentType || 'promotional post'}
Day in calendar: ${dayNumber || 'N/A'}
Additional context: ${context || ''}

Platform Guidelines: ${platformGuidelines[platform] || ''}

Generate:
1. A compelling hook (first line that stops the scroll)
2. Full post copy (platform-appropriate length)
3. 5-10 relevant hashtags
4. Call-to-action
5. Image/visual suggestion

Format as JSON: { "hook": "", "copy": "", "hashtags": [], "cta": "", "visualSuggestion": "" }`;

    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: `You are an expert social media content creator. ${socialSkill.substring(0, 1000)}\n${copySkill.substring(0, 500)}`,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';

    // Extract JSON
    let content = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      content = match ? JSON.parse(match[0]) : { hook: '', copy: text, hashtags: [], cta: '', visualSuggestion: '' };
    } catch {
      content = { hook: '', copy: text, hashtags: [], cta: '', visualSuggestion: '' };
    }

    return res.json({ success: true, content, platform });
  } catch (err) {
    console.error('[ContentIdeas] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /agent/video-request — Submit video request for admin approval ───────
exports.submitVideoRequest = async (req, res) => {
  try {
    const { brandProjectId, platform, description, style, duration, brandName } = req.body;

    if (!brandName && !brandProjectId) {
      return res.status(400).json({ success: false, message: 'Brand required' });
    }

    // Store request in DB if project exists
    if (brandProjectId) {
      await BrandProject.findByIdAndUpdate(brandProjectId, {
        $push: {
          videoRequests: {
            platform,
            description,
            style: style || 'Brand story',
            duration: duration || '30s',
            status: 'pending',
            requestedAt: new Date(),
          },
        },
      });
    }

    // In production: send notification to admin via email/webhook
    // For now: log and return success
    console.log('[VideoRequest] New video request:', { brandName, platform, description });

    return res.json({
      success: true,
      message: 'Video request submitted! Our creative team will review and generate your video within 24-48 hours.',
      requestId: `VR-${Date.now().toString(36).toUpperCase()}`,
    });
  } catch (err) {
    console.error('[VideoRequest] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /agent/content-strategy — Full researched 30-day content calendar ──
exports.generateContentStrategy = async (req, res) => {
  try {
    const { brandProjectId, brand, category, goal } = req.body;
    if (!brand) return res.status(400).json({ success: false, message: 'Brand data required' });

    const contentSkill  = loadSkill('content-strategy');
    const socialSkill   = loadSkill('social-content');
    const launchSkill   = loadSkill('launch-strategy');
    const adSkill       = loadSkill('ad-creative');
    const psychSkill    = loadSkill('marketing-psychology');

    const brandName = brand.brandName || 'Unnamed Brand';
    const cat = category || brand.category || brand.businessType || 'General';
    const audience = Array.isArray(brand.targetAudience) ? brand.targetAudience.join(', ') : (brand.targetAudience || 'General UAE audience');
    const voice = brand.brandVoice || 'Professional and authentic';

    const BUSINESS_TYPE_PLATFORMS = {
      product:   ['instagram', 'tiktok', 'facebook', 'snapchat'],
      service:   ['linkedin', 'instagram', 'facebook', 'x'],
      b2b:       ['linkedin', 'x', 'instagram'],
      perfume:   ['instagram', 'tiktok', 'snapchat', 'facebook'],
      skincare:  ['instagram', 'tiktok', 'facebook'],
      food:      ['instagram', 'tiktok', 'snapchat'],
      tech:      ['linkedin', 'x', 'instagram', 'tiktok'],
      clothing:  ['instagram', 'tiktok', 'facebook'],
      default:   ['instagram', 'tiktok', 'linkedin', 'facebook'],
    };

    const platforms = BUSINESS_TYPE_PLATFORMS[cat] || BUSINESS_TYPE_PLATFORMS.default;

    const systemPrompt = `You are the Marketing Cofounder for ${brandName} — a seasoned startup advisor.
You generate platform-specific, researched content strategies with exact posts ready to publish.
Every post must be specific to THIS brand, reference real brand details, and target the UAE/GCC market.
Never use placeholder text like [brand name] or [your product].

CONTENT STRATEGY EXPERTISE:
${contentSkill.substring(0, 2000)}

SOCIAL MEDIA EXPERTISE:
${socialSkill.substring(0, 1500)}

LAUNCH STRATEGY:
${launchSkill.substring(0, 800)}

PERSUASION PSYCHOLOGY:
${psychSkill.substring(0, 500)}

Return ONLY valid JSON. No markdown. No explanation outside JSON.`;

    const userPrompt = `Generate a complete 30-day content calendar for this brand.

BRAND: ${brandName}
CATEGORY: ${cat}
TAGLINE: ${brand.tagline || ''}
USP: ${brand.positioning || brand.uniqueSellingPoint || ''}
TARGET AUDIENCE: ${audience}
BRAND VOICE: ${voice}
BRAND STORY: ${(brand.brandStory || '').substring(0, 600)}
GOAL: ${goal || 'Build brand awareness and generate first customers'}
PLATFORMS: ${platforms.join(', ')}
MARKET: UAE / GCC

RULES:
- Generate exactly 30 content pieces, one per day
- Mix platforms across the 30 days based on platform strengths
- 40% awareness, 30% engagement, 30% conversion content
- Every caption must mention the brand name at least once
- Hashtags must include both niche and broad UAE tags
- Include the hook (first line that stops the scroll)
- Include a visual prompt for AI image generation specific to this brand
- Vary content types: post, reel, story, carousel, article, thread

Return JSON array of 30 items:
[
  {
    "dayNumber": 1,
    "platform": "instagram",
    "contentType": "post",
    "strategicGoal": "awareness",
    "contentPillar": "education",
    "topic": "short topic",
    "hook": "first line hook",
    "caption": "full caption with brand name, specific to this business",
    "hashtags": ["relevant", "uae", "tags"],
    "callToAction": "specific CTA",
    "visualPrompt": "detailed image generation prompt with brand colors and style",
    "estimatedBestTime": "7pm-9pm UAE",
    "competitorGapExploited": "what competitor weakness this targets"
  }
]`;

    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0]?.text || '[]';
    let items = [];
    try {
      const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      items = JSON.parse(cleaned);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      items = match ? JSON.parse(match[0]) : [];
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(500).json({ success: false, message: 'Failed to generate content strategy' });
    }

    // Enrich each item
    const { v4: uuidv4 } = require('uuid');
    const enriched = items.map(item => ({
      ...item,
      id: uuidv4(),
      agentGenerated: true,
      status: 'draft',
      generatedAt: new Date(),
      hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
    }));

    // Save to DB if projectId exists
    if (brandProjectId && brandProjectId.match(/^[0-9a-f]{24}$/i)) {
      try {
        await BrandProject.findByIdAndUpdate(brandProjectId, {
          $set: { contentItems: enriched },
          'agentMemory.lastContentAt': new Date(),
        });
      } catch (e) { console.error('[ContentStrategy] DB save failed:', e.message); }

      // Save to S3
      try {
        const brandMemory = require('../../services/brandMemoryService');
        await brandMemory.saveContentToS3(brandProjectId, enriched);
      } catch (e) { console.error('[ContentStrategy] S3 save failed:', e.message); }
    }

    return res.json({ success: true, items: enriched, count: enriched.length });
  } catch (err) {
    console.error('[ContentStrategy] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Content strategy generation failed: ' + err.message });
  }
};

// ── POST /agent/post-to-platform — Schedule post for publishing ─────────────
exports.schedulePost = async (req, res) => {
  try {
    const { brandProjectId, platform, content, scheduledAt, dayNumber } = req.body;

    if (brandProjectId) {
      await BrandProject.findByIdAndUpdate(brandProjectId, {
        $push: {
          scheduledPosts: {
            platform,
            content: content.substring(0, 3000),
            scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
            dayNumber,
            status: 'scheduled',
            createdAt: new Date(),
          },
        },
      });
    }

    return res.json({ success: true, message: 'Post scheduled successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
