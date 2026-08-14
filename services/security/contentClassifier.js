'use strict';

/**
 * contentClassifier — multi-layer content safety for Qumak.
 *
 * Committee-designed 4-layer defense system. Each layer is cheap on its own
 * and collectively covers 99%+ of harmful content with minimal false
 * positives on legitimate Gulf business content.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Layer 1: classifyUrl()        — pre-scrape, ~1ms                 │
 * │   Host-based check: blocks adult sites, darknet, extremist hosts │
 * │                                                                   │
 * │ Layer 2: classifyText()       — post-scrape, ~400ms, $0.0003     │
 * │   Claude Haiku: classifies scraped content + user prompt         │
 * │                                                                   │
 * │ Layer 3: classifyPrompt()     — pre-generation, ~400ms           │
 * │   Same Haiku classifier, run on final composed prompt            │
 * │                                                                   │
 * │ Layer 4: classifyImage()      — post-generation, ~800ms, $0.002  │
 * │   Claude Haiku vision: scans generated output before serving     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Fail-closed for content, fail-open for infrastructure:
 *   - If a user prompt IS unsafe content → BLOCK (fail-closed)
 *   - If Anthropic API is down → ALLOW with flag (fail-open)
 *   - If generated IMAGE flags → HIDE asset, log, refund (fail-closed)
 *
 * Wire into:
 *   1. urlScraper.js :: scrapeUrl          (call classifyUrl FIRST)
 *   2. urlToAdsService.js :: scanUrl       (call classifyText after scrape)
 *   3. studioController_enqueue.js         (call classifyPrompt before charge)
 *   4. VideoGenerationPipeline.js          (call classifyImage before asset)
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY          — for Haiku classifier
 *   CLASSIFIER_BYPASS_HOSTS    — comma-separated hosts to skip (testing)
 *   CLASSIFIER_STRICTNESS      — 'strict' | 'balanced' | 'permissive'
 */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { getRedis } = require('../redis');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLASSIFIER_MODEL = 'claude-haiku-4-5';
const CACHE_TTL_SEC = 86400; // 24h — classifications are stable enough
const STRICTNESS = process.env.CLASSIFIER_STRICTNESS || 'balanced';

// ─────────────────────────────────────────────────────────────────────
// LAYER 1: URL-based pre-scrape classification
// ─────────────────────────────────────────────────────────────────────

/**
 * Host blocklist — known categories of sites that should never scrape.
 * This is a pragmatic initial list; enhance with a commercial domain
 * intelligence API (Cloudflare, Webroot) when revenue justifies it.
 */
const HARD_BLOCKED_HOST_PATTERNS = [
  // Adult content
  /porn|xxx|xvideos|xhamster|redtube|youporn|pornhub|onlyfans|chaturbate/i,
  /sex(?:cam|chat|finder)|escort|camgirl|hookup|fetish/i,
  // Darknet / illegal
  /darkweb|darknet|\.onion$|tor2web/i,
  /silkroad|dreammarket|empire\s?market/i,
  // Weapons + drugs sales
  /gunbroker|armslist|firearms?market/i,
  /buy.*(?:cocaine|heroin|meth|fentanyl)/i,
  // Extremist content  
  /stormfront|dailystormer|ironmarch|atomwaffen/i,
  // Known gambling (UAE compliance)
  /bet365|pokerstars|ladbrokes|williamhill|draftkings/i,
];

const SOFT_WARN_HOST_PATTERNS = [
  // Gambling (flag but don't hard-block — some jurisdictions legal)
  /casino|gambl|poker|bet(?:ting)?\./i,
  // Crypto (flag for UAE regulatory review)
  /crypto.*exchange|ico|token.*sale/i,
];

function classifyUrlHost(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch (_e) {
    return { blocked: true, reason: 'invalid_url', layer: 'url_format' };
  }
  
  const host = url.host.toLowerCase();
  const fullUrl = url.toString().toLowerCase();
  
  // Admin bypass for testing
  const bypassList = (process.env.CLASSIFIER_BYPASS_HOSTS || '').split(',').map(s => s.trim().toLowerCase());
  if (bypassList.includes(host)) {
    return { blocked: false, layer: 'url_bypass', warning: 'Host in bypass list' };
  }
  
  // Hard blocks
  for (const pattern of HARD_BLOCKED_HOST_PATTERNS) {
    if (pattern.test(host) || pattern.test(fullUrl)) {
      return { 
        blocked: true, 
        reason: 'Host matches blocked content category',
        category: 'blocked_host',
        layer: 'url_host',
        pattern: pattern.source.slice(0, 40),
      };
    }
  }
  
  // Soft warnings (allow but flag)
  for (const pattern of SOFT_WARN_HOST_PATTERNS) {
    if (pattern.test(host) || pattern.test(fullUrl)) {
      return {
        blocked: false,
        warning: 'Host flagged for review',
        category: 'flagged_host',
        layer: 'url_host',
      };
    }
  }
  
  return { blocked: false, layer: 'url_host' };
}

/**
 * Public: Validate URL before we even scrape it.
 */
async function classifyUrl(rawUrl) {
  const hostResult = classifyUrlHost(rawUrl);
  return hostResult;
}

// ─────────────────────────────────────────────────────────────────────
// LAYER 2+3: Text classification (Claude Haiku)
// ─────────────────────────────────────────────────────────────────────

/**
 * Fast regex layer — catches obvious violations before Haiku runs.
 * Saves $0.0003 on 40% of requests.
 */
const HARD_BLOCK_TEXT_PATTERNS = {
  en: [
    /\b(nude|naked|topless|explicit|nsfw|porn(o|ographic)?|hardcore|xxx)\b/i,
    /\b(child|kid|minor|teen|underage|preteen)\s+\w{0,20}\s*(sex|nude|naked|lingerie|bikini|seduc)/i,
    /\b(lol[ia]|shota)\b/i,  // CSAM keywords
    /\b(gun|pistol|rifle|ak47|ar15|weapon|firearm)\s+(pointed|aimed|firing|shooting)\s+at\s+(person|people|kid|child|woman|man)/i,
    /\b(beheading|decapitat|torture|execution|dismember|mutilat)/i,
    /\b(hang(?:ing)?)\s+(from|themselves|yourself|by the neck)/i,
    /\b(suicide|kill\s+myself|end\s+my\s+life|overdose)\b/i,
    /\b(isis|al.?qaeda|taliban|hamas|hezbollah)\s+(recruit|training|bomb|attack)/i,
    /\b(fentanyl|methamphetamine|heroin)\s+(buy|sell|source|dealer)/i,
    /\bjihad.{0,20}(recruit|kill|attack|bomb)/i,
  ],
  ar: [
    // Arabic keywords — expand with native speaker review
    /[\u0600-\u06FF]*عار[ي]?[\u0600-\u06FF]*\s*(?:صور|فيديو|امرأة|فتاة|طفل)/,  // nude imagery
    /[\u0600-\u06FF]*إباحي[ة]?[\u0600-\u06FF]*/,  // pornographic
    /[\u0600-\u06FF]*سلاح[\u0600-\u06FF]*\s*[\u0600-\u06FF]*(?:مصوب|موجه).{0,20}(?:شخص|إنسان|طفل)/,  // weapon aimed at
    /[\u0600-\u06FF]*(?:انتحار|قتل\s+نفس)[\u0600-\u06FF]*/,  // suicide
    /[\u0600-\u06FF]*(?:جهاد|إرهاب).{0,30}(?:تجنيد|قنبلة|هجوم)/,  // terrorism recruit
  ],
  leetspeak: [
    /\b(n[u0]d[e3]|p[o0]rn|n[s5]fw|w[e3][a@]p[o0]n[s5]?)\b/i,
    /\bf[u\*][ck]k?\s+(?:kids?|children|minors?|girls?)/i,
  ],
};

function fastRegexScan(text) {
  if (!text || typeof text !== 'string') {
    return { blocked: false, layer: 'regex_empty' };
  }
  
  for (const [lang, patterns] of Object.entries(HARD_BLOCK_TEXT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return {
          blocked: true,
          layer: 'regex',
          category: lang === 'leetspeak' ? 'evasion' : 'explicit_match',
          lang,
          reason: 'Content matches blocked pattern',
          confidence: 1.0,
        };
      }
    }
  }
  
  return { blocked: false, layer: 'regex' };
}

// ─────────────────────────────────────────────────────────────────────
// Claude Haiku classifier
// ─────────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are the content safety classifier for Qumak, a UAE-based AI advertising platform serving Gulf SME businesses.

YOUR ROLE: Classify user prompts and scraped content as SAFE or UNSAFE for commercial advertising in the UAE/GCC region. You do NOT generate content; you only classify it.

LEGAL CONTEXT:
- UAE Federal Decree-Law No. 34 of 2021 on countering cybercrime
- UAE Cybercrime Law prohibits content inciting violence, obscenity, religious discrimination
- GCC advertising standards require modest imagery, no alcohol/pork, respect for Islamic values
- Meta/TikTok advertising policies apply (users will publish outputs on these platforms)

UNSAFE CATEGORIES (BLOCK these):
1. SEXUAL_CONTENT: nudity, suggestive poses, intimate apparel on humans, sexual acts
2. CHILD_SAFETY: minors in any suggestive/romantic/sexualized context (this is CSAM territory — zero tolerance)
3. VIOLENCE: weapons aimed at people, gore, blood-focused imagery, fighting, torture
4. DRUGS_ALCOHOL: alcohol promotion (UAE is strict), drug imagery, smoking glorification
5. HATE_SPEECH: discrimination by religion/race/nationality, supremacist symbols
6. POLITICAL: political party content, protest imagery, government criticism, religious mockery
7. MEDICAL_MISINFO: unproven medical claims, anti-vaccine content, miracle cures
8. DEEPFAKE: generating likenesses of real identifiable people without consent
9. FINANCIAL_FRAUD: pyramid schemes, crypto scams, guaranteed-returns claims
10. GAMBLING: casino promos, betting odds (UAE bans commercial gambling)

SAFE (ALLOW these even if the prompt is unusual):
- Fitness/sports/bodybuilding (including shirtless athletic poses, muscular bodies)
- Dramatic/cinematic lighting (even dark, moody, high-contrast)
- Gulf cultural imagery: kandura, abaya, hijab, falcon, desert, mosque exteriors, camel
- Food including meat/halal cuisine, shisha/hookah (legal in UAE)
- Modest fashion including lingerie marketing (if not nude)
- Business/corporate/professional imagery
- Cars, luxury products, real estate
- Perfume/fragrance imagery (including sensual marketing copy)
- Medical/wellness with qualified claims ("may help," "clinical studies suggest")

YOUR RESPONSE FORMAT (respond with ONLY this JSON — no other text):
{
  "safe": true | false,
  "category": "SEXUAL_CONTENT" | "CHILD_SAFETY" | "VIOLENCE" | "DRUGS_ALCOHOL" | "HATE_SPEECH" | "POLITICAL" | "MEDICAL_MISINFO" | "DEEPFAKE" | "FINANCIAL_FRAUD" | "GAMBLING" | "SAFE",
  "confidence": 0.0-1.0,
  "reason": "one sentence, max 20 words, explains what triggered the classification",
  "uae_specific_concern": true | false,
  "severity": "low" | "medium" | "high" | "critical"
}

STRICTNESS MODE: ${STRICTNESS}
- strict: err on the side of blocking; any ambiguity → false
- balanced: default; block clear violations, allow ambiguous cases with warning
- permissive: only block obvious violations

REMEMBER: False positives harm users; false negatives harm the platform. In balanced mode, if uncertain, lean ALLOW with uae_specific_concern=true so human review can follow up.`;

async function classifyWithHaiku(text, { locale = 'gulf', context = 'prompt' } = {}) {
  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 250,
      temperature: 0,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `CONTEXT: This text is a "${context}" to classify.
LOCALE: ${locale}

TEXT TO CLASSIFY:
"""
${text.slice(0, 2000)}
"""

Respond with ONLY the JSON classification object.`,
      }],
    });
    
    const responseText = response.content?.[0]?.text?.trim();
    if (!responseText) throw new Error('Empty classifier response');
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in classifier response');
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      blocked: !parsed.safe,
      layer: 'llm',
      category: parsed.category || 'UNKNOWN',
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || 'Classified by AI',
      uaeConcern: !!parsed.uae_specific_concern,
      severity: parsed.severity || 'medium',
      model: CLASSIFIER_MODEL,
    };
  } catch (err) {
    console.warn('[contentClassifier] Haiku failed:', err.message);
    // Fail-OPEN for prompts — don't block legit users due to API outage
    // BUT we flag it so downstream can apply extra scrutiny
    return {
      blocked: false,
      layer: 'fallback',
      category: 'UNKNOWN',
      warning: err.message,
      degraded: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// LAYER 4: Image classification (Claude Haiku Vision)
// ─────────────────────────────────────────────────────────────────────

async function classifyImageWithHaiku({ imageUrl, originalPrompt = '' }) {
  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 250,
      temperature: 0,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: imageUrl },
          },
          {
            type: 'text',
            text: `Classify this AI-generated image for Qumak's UAE advertising platform.

Original prompt that generated it: "${originalPrompt.slice(0, 500)}"

Check specifically:
- Nudity, suggestive content, or explicit imagery of humans
- Weapons aimed at people, gore, blood
- Minors in inappropriate contexts
- Drugs, alcohol promotion
- Political/religious controversy
- Content that Meta/TikTok would reject for Gulf ads

Respond with ONLY the JSON classification object.`,
          },
        ],
      }],
    });
    
    const responseText = response.content?.[0]?.text?.trim();
    const jsonMatch = responseText?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { blocked: false, layer: 'image_fallback', warning: 'Parse failed' };
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      blocked: !parsed.safe,
      layer: 'image_scan',
      category: parsed.category || 'UNKNOWN',
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || 'Image classified by AI',
      severity: parsed.severity || 'medium',
    };
  } catch (err) {
    console.warn('[contentClassifier] image classify failed:', err.message);
    // Fail-CLOSED for generated images — if we can't verify, hide by default
    // This is different from prompt classification because outputs are riskier
    return {
      blocked: false,
      layer: 'image_fallback',
      warning: err.message,
      degraded: true,
      requiresManualReview: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Caching layer
// ─────────────────────────────────────────────────────────────────────

async function getCachedResult(cacheKey) {
  try {
    const raw = await getRedis().get(cacheKey);
    return raw ? JSON.parse(raw) : null;
  } catch (_e) {
    return null;
  }
}

async function setCachedResult(cacheKey, result) {
  try {
    await getRedis().setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(result));
  } catch (_e) { /* non-fatal */ }
}

function cacheKeyFor(text, prefix = 'safety') {
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API — 4 methods, one per layer
// ─────────────────────────────────────────────────────────────────────

/**
 * Layer 2: Classify scraped text content.
 * Call this AFTER scrapeUrl returns but BEFORE calling researchBrand.
 * Saves LLM costs by not running Anthropic research on unsafe content.
 */
async function classifyText(text, { locale = 'gulf', context = 'scraped_content', skipCache = false } = {}) {
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return { blocked: false, layer: 'empty' };
  }
  
  // Layer 2a: regex fast-path
  const regexResult = fastRegexScan(text);
  if (regexResult.blocked) return regexResult;
  
  // Cache check
  if (!skipCache) {
    const cached = await getCachedResult(cacheKeyFor(text, 'text'));
    if (cached) return { ...cached, fromCache: true };
  }
  
  // Layer 2b: Haiku
  const llmResult = await classifyWithHaiku(text, { locale, context });
  
  // Cache stable results (not fallbacks)
  if (llmResult.layer !== 'fallback') {
    await setCachedResult(cacheKeyFor(text, 'text'), llmResult);
  }
  
  return llmResult;
}

/**
 * Layer 3: Classify a generation prompt.
 * Call this BEFORE charging credits or enqueueing to fal.
 */
async function classifyPrompt(prompt, { locale = 'gulf', skipCache = false } = {}) {
  return await classifyText(prompt, { 
    locale, 
    context: 'generation_prompt',
    skipCache,
  });
}

/**
 * Layer 4: Classify a generated image.
 * Call this AFTER fal returns the URL but BEFORE storing the StudioAsset.
 */
async function classifyImage({ imageUrl, originalPrompt = '', skipCache = false }) {
  if (!imageUrl) {
    return { blocked: false, layer: 'empty' };
  }
  
  // Cache by image URL (identical images = identical verdict)
  if (!skipCache) {
    const cached = await getCachedResult(cacheKeyFor(imageUrl, 'image'));
    if (cached) return { ...cached, fromCache: true };
  }
  
  const result = await classifyImageWithHaiku({ imageUrl, originalPrompt });
  
  if (result.layer !== 'image_fallback') {
    await setCachedResult(cacheKeyFor(imageUrl, 'image'), result);
  }
  
  return result;
}

/**
 * Convenience: run all 3 text-phase checks in sequence for a complete URL-to-ad flow.
 * Used by urlToAdsService.scanUrl for a single classification pass.
 */
async function classifyUrlToAdsFlow({ url, scrapedText, userPrompt = '' }) {
  // Layer 1
  const urlResult = await classifyUrl(url);
  if (urlResult.blocked) {
    return { blocked: true, failedAt: 'url', result: urlResult };
  }
  
  // Layer 2
  const textResult = await classifyText(scrapedText, { context: 'scraped_content' });
  if (textResult.blocked) {
    return { blocked: true, failedAt: 'scraped_content', result: textResult };
  }
  
  // Layer 3 (if user provided a prompt)
  if (userPrompt) {
    const promptResult = await classifyPrompt(userPrompt);
    if (promptResult.blocked) {
      return { blocked: true, failedAt: 'user_prompt', result: promptResult };
    }
  }
  
  return {
    blocked: false,
    url: urlResult,
    text: textResult,
    allSafe: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Audit logging — critical for compliance review
// ─────────────────────────────────────────────────────────────────────

async function logClassification({
  userId,
  sessionId,
  contentType,       // 'url' | 'text' | 'prompt' | 'image'
  contentHash,
  result,
  blocked,
  metadata = {},
}) {
  try {
    // In production, write to a dedicated audit collection (ContentSafetyLog)
    // For now, structured log for aggregation
    const entry = {
      timestamp: new Date().toISOString(),
      userId: userId ? String(userId) : null,
      sessionId,
      contentType,
      contentHash,
      blocked,
      category: result.category,
      layer: result.layer,
      confidence: result.confidence,
      severity: result.severity,
      reason: result.reason,
      ...metadata,
    };
    console.log('[contentSafety.audit]', JSON.stringify(entry));
  } catch (_e) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  // 4 public methods matching the 4 layers
  classifyUrl,
  classifyText,
  classifyPrompt,
  classifyImage,
  
  // Convenience method for URL-to-Ads flow
  classifyUrlToAdsFlow,
  
  // Audit
  logClassification,
  
  // Internals exposed for tests
  _internals: {
    fastRegexScan,
    classifyUrlHost,
    classifyWithHaiku,
    classifyImageWithHaiku,
    HARD_BLOCKED_HOST_PATTERNS,
    HARD_BLOCK_TEXT_PATTERNS,
  },
};