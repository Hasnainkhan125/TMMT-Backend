'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const AiModel = require('../model/schema/aiModel');

const FAL_OPENAPI_URL = (endpointId) => 
  `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${endpointId}`;

/**
 * Fetch fal's OpenAPI schema for an endpoint.
 */
async function fetchFalSchema(falModelId) {
  const url = FAL_OPENAPI_URL(falModelId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal_schema_fetch_failed: ${res.status} for ${falModelId}`);
  return res.json();
}

/**
 * Find the request body schema in the OpenAPI doc.
 * Standard pattern: paths['/{endpoint}'].post.requestBody.content['application/json'].schema.$ref
 */
function findRequestSchema(openapi) {
  const paths = openapi.paths || {};
  for (const [path, methods] of Object.entries(paths)) {
    const post = methods.post;
    if (!post) continue;
    const ref = post.requestBody?.content?.['application/json']?.schema?.$ref;
    if (!ref) continue;
    const schemaName = ref.replace('#/components/schemas/', '');
    return openapi.components?.schemas?.[schemaName];
  }
  return null;
}

/**
 * Resolve a $ref to the actual schema object.
 */
function resolveRef(openapi, ref) {
  const name = ref.replace('#/components/schemas/', '');
  return openapi.components?.schemas?.[name];
}

/**
 * Detect whether an `anyOf` block represents a nullable field
 * (i.e., union with `{ "type": "null" }`).
 */
function unwrapNullable(prop) {
  if (!prop.anyOf) return { prop, nullable: false };
  const nonNull = prop.anyOf.filter(p => p.type !== 'null');
  if (nonNull.length === 1) {
    return { prop: { ...nonNull[0], description: prop.description, default: prop.default }, nullable: true };
  }
  return { prop, nullable: false };
}

/**
 * Map a property to a slot type.
 */
function inferSlotType(prop, openapi) {
  const { prop: unwrapped } = unwrapNullable(prop);
  const p = unwrapped;
  
  // Array shapes
  if (p.type === 'array') {
    const itemRef = p.items?.$ref;
    if (itemRef) {
      const itemSchema = resolveRef(openapi, itemRef);
      // Kling element type
      if (itemSchema?.title?.includes('ComboElement') || 
          itemSchema?.properties?.frontal_image_url) {
        return 'element_array';
      }
      // Multi-prompt
      if (itemSchema?.title?.includes('MultiPrompt')) {
        return 'string_array_with_duration';
      }
    }
    const itemType = p.items?.type;
    const fieldHint = p.items?._fal_ui_field;
    if (fieldHint === 'image' || itemType === 'string' && /image|url/i.test(JSON.stringify(p.items))) {
      return 'image_array';
    }
    if (fieldHint === 'video') return 'video_array';
    if (fieldHint === 'audio') return 'audio_array';
    return 'string_array';
  }
  
  // Single image/video
  const uiField = p._fal_ui_field || p.ui?.field;
  if (uiField === 'image') return 'image';
  if (uiField === 'video') return 'video';
  if (uiField === 'audio') return 'audio';
  
  // Enums
  if (p.enum) {
    if (p.type === 'integer' || typeof p.enum[0] === 'number') return 'enum_integer';
    return 'enum';
  }
  
  // anyOf unions (e.g. GPT Image image_size)
  if (p.anyOf && !p.enum) return 'union';
  
  // Primitives
  if (p.type === 'integer') return 'integer';
  if (p.type === 'number')  return 'number';
  if (p.type === 'boolean') return 'boolean';
  if (p.type === 'string')  return 'string';
  
  return 'unknown';
}

/**
 * Extract upload limits from x-fal block.
 */
function extractUploadLimits(prop) {
  const xfal = prop['x-fal'] || prop.items?.['x-fal'];
  if (!xfal) return null;
  return {
    maxFileSizeBytes: xfal.max_file_size,
    minWidth:         xfal.min_width,
    minHeight:        xfal.min_height,
    maxWidth:         xfal.max_width,
    maxHeight:        xfal.max_height,
    minAspectRatio:   xfal.min_aspect_ratio,
    maxAspectRatio:   xfal.max_aspect_ratio,
  };
}

/**
 * Build the elementShape for nested element_array slots.
 */
function buildElementShape(refSchema) {
  const fields = [];
  for (const [propKey, prop] of Object.entries(refSchema.properties || {})) {
    const { prop: unwrapped } = unwrapNullable(prop);
    const isArray = unwrapped.type === 'array';
    fields.push({
      key:         camelize(propKey),
      providerKey: propKey,
      type:        isArray ? 'image_array' : (unwrapped._fal_ui_field === 'video' ? 'video' : 'image'),
      required:    (refSchema.required || []).includes(propKey),
      maxItems:    isArray ? (unwrapped.maxItems || 4) : null,
    });
  }
  
  // Kling: frontal+references vs video are mutually exclusive
  const hasFrontal = fields.some(f => f.providerKey === 'frontal_image_url');
  const hasVideo = fields.some(f => f.providerKey === 'video_url');
  const oneOfGroups = (hasFrontal && hasVideo) ? [['frontal', 'video']] : [];
  
  return { fields, oneOfGroups };
}

/**
 * Map a fal property name to a semantic slot key.
 * This is where you decide canonical names — keep them consistent across models.
 */
function semanticKey(providerKey) {
  const MAP = {
    'image_url':         'startFrame',
    'start_image_url':   'startFrame',
    'end_image_url':     'endFrame',
    'tail_image_url':    'endFrame',
    'image_urls':        'refImages',
    'video_url':         'refVideo',
    'video_urls':        'refVideos',
    'audio_url':         'refAudio',
    'audio_urls':        'refAudios',
    'reference_image_urls': 'references',
    'frontal_image_url': 'frontal',
    'multi_prompt':      'multiPrompt',
    'elements':          'elements',
    'prompt':            'prompt',
    'negative_prompt':   'negativePrompt',
    'duration':          'durationSec',
    'aspect_ratio':      'aspectRatio',
    'resolution':        'resolution',
    'generate_audio':    'generateAudio',
    'seed':              'seed',
    'image_size':        'imageSize',
    'quality':           'quality',
    'num_images':        'numImages',
    'output_format':     'outputFormat',
    'cfg_scale':         'cfgScale',
    'shot_type':         'shotType',
    'voice_id':          'voiceId',
    'enable_safety_checker': 'safetyChecker',
  };
  return MAP[providerKey] || camelize(providerKey);
}

function camelize(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Detect prompt token patterns (Happy Horse: character1/character2/...).
 * Look at description text for token mentions.
 */
function detectPromptTokens(promptProp, refImagesField) {
  const desc = promptProp?.description || '';
  const m = desc.match(/(`character|@Element|@Image|@Video|@Audio)\d*/);
  if (!m) return null;
  const symbol = m[1].replace(/[`@]/g, '');
  return {
    pattern:     `${symbol}{N}`,
    sourceField: refImagesField,
    maxN:        9,  // most fal models cap at 9
  };
}

/**
 * Detect cross-field constraints from descriptions.
 * Examples:
 *   "Maximum 7 total (elements + reference images)" → sum_max
 *   "Either prompt or multi_prompt must be provided" → requires_one_of
 *   "Total files across all modalities must not exceed 12" → sum_max
 */
function detectConstraints(schema) {
  const constraints = [];
  const fullText = JSON.stringify(schema);
  
  // Kling: elements + image_urls ≤ 7
  if (/Maximum 7 total \(elements \+ reference images\)/i.test(fullText)) {
    constraints.push({
      type:    'sum_max',
      fields:  ['elements', 'refImages'],
      value:   7,
      message: 'Combined elements and reference images cannot exceed 7',
    });
  }
  
  // Either prompt or multi_prompt
  if (/Either prompt or multi_prompt must be provided/i.test(fullText)) {
    constraints.push({
      type:    'requires_one_of',
      fields:  ['prompt', 'multiPrompt'],
      message: 'Provide either prompt or multi-prompt list',
    });
  }
  
  // Seedance: total files across modalities ≤ 12
  if (/Total files across all modalities must not exceed 12/i.test(fullText)) {
    constraints.push({
      type:    'sum_max',
      fields:  ['refImages', 'refVideos', 'refAudios'],
      value:   12,
      message: 'Combined references (images + videos + audio) cannot exceed 12',
    });
  }
  
  return constraints;
}

/**
 * Detect the UI variant from the request schema title + presence of fields.
 */
function inferUiVariant(reqSchema, slots) {
  const title = (reqSchema.title || '').toLowerCase();
  const slotKeys = new Set(slots.map(s => s.key));
  
  if (slotKeys.has('elements') && slotKeys.has('multiPrompt')) return 'ref2v_elements';
  if (slotKeys.has('refImages') && slotKeys.has('refVideos'))   return 'ref2v_with_video_refs';
  if (slotKeys.has('refImages') && !slotKeys.has('startFrame')) return 'ref2v_multi_image';
  if (slotKeys.has('startFrame') && slotKeys.has('endFrame'))   return 'i2v_with_end';
  if (slotKeys.has('startFrame'))                                return 'i2v_simple';
  if (slotKeys.has('multiPrompt'))                               return 'multi_shot';
  if (title.includes('text-to-video') || title.includes('t2v')) return 't2v_simple';
  if (title.includes('image-to-image') || title.includes('edit')) return 'i2i_edit';
  return 't2i_simple';
}

/**
 * Main: convert a fal OpenAPI schema → manifest.
 */
async function buildManifest(falModelId) {
  const openapi = await fetchFalSchema(falModelId);
  const reqSchema = findRequestSchema(openapi);
  if (!reqSchema) throw new Error(`no_request_schema:${falModelId}`);
  
  const required = new Set(reqSchema.required || []);
  const orderHint = reqSchema['x-fal-order-properties'] || [];
  const slots = [];
  
  for (const [propKey, propRaw] of Object.entries(reqSchema.properties || {})) {
    const { prop, nullable } = unwrapNullable(propRaw);
    const slotType = inferSlotType(prop, openapi);
    
    const slot = {
      key:         semanticKey(propKey),
      providerKey: propKey,
      type:        slotType,
      required:    required.has(propKey),
      default:     prop.default,
      uiLabel:     prop.title || humanizeKey(propKey),
      uiHint:      prop.description,
      uiOrder:     orderHint.indexOf(propKey) >= 0 ? orderHint.indexOf(propKey) : 999,
    };
    
    // Enum options
    if (prop.enum) {
      slot.options = prop.enum;
      // Detect coercion: Kling sends duration as string "5", Happy Horse as integer 5
      slot.coerceToString = (typeof prop.enum[0] === 'string') && (prop.type === 'string');
    }
    
    // Array bounds (best effort — fal's schema doesn't always declare maxItems)
    if (slotType.endsWith('_array')) {
      slot.minItems = prop.minItems || 0;
      slot.maxItems = prop.maxItems || inferMaxFromDescription(prop.description) || 9;
    }
    
    // Nested element shape
    if (slotType === 'element_array') {
      const itemRef = prop.items?.$ref;
      if (itemRef) {
        const itemSchema = resolveRef(openapi, itemRef);
        slot.elementShape = buildElementShape(itemSchema);
      }
    }
    
    // Upload limits (image/video size, file size)
    const limits = extractUploadLimits(prop);
    if (limits) slot.uploadLimits = limits;
    
    // anyOf unions (GPT Image image_size: preset OR {width, height})
    if (slotType === 'union') {
      slot.anyOf = prop.anyOf.map(opt => {
        if (opt.enum) return { kind: 'preset', options: opt.enum };
        if (opt.$ref) {
          const refSchema = resolveRef(openapi, opt.$ref);
          return { kind: 'object', shape: refSchema.properties };
        }
        return { kind: 'raw', shape: opt };
      });
    }
    
    slots.push(slot);
  }
  
  // Sort by uiOrder
  slots.sort((a, b) => (a.uiOrder ?? 999) - (b.uiOrder ?? 999));
  
  // Detect prompt tokens (character1, @Element1)
  const promptSlot = slots.find(s => s.key === 'prompt');
  const refImagesSlot = slots.find(s => s.key === 'refImages' || s.key === 'elements');
  const promptTokens = promptSlot && refImagesSlot 
    ? detectPromptTokens(reqSchema.properties[promptSlot.providerKey], refImagesSlot.key)
    : null;
  
  const constraints = detectConstraints(reqSchema);
  const uiVariant = inferUiVariant(reqSchema, slots);
  
  const schemaHash = crypto.createHash('sha256')
    .update(JSON.stringify(reqSchema))
    .digest('hex')
    .slice(0, 16);
  
  return {
    sourceSchemaUrl: FAL_OPENAPI_URL(falModelId),
    syncedAt:        new Date(),
    schemaHash,
    inputSlots:      slots,
    constraints,
    uiVariant,
    promptTokens,
  };
}

function humanizeKey(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function inferMaxFromDescription(desc) {
  if (!desc) return null;
  const m = desc.match(/up to (\d+)|max(?:imum)? (\d+)/i);
  return m ? parseInt(m[1] || m[2]) : null;
}

/**
 * Sync all active fal models.
 */
async function syncAll({ dryRun = false, onlyMissing = false } = {}) {
  const models = await AiModel.find({ provider: 'fal', isActive: true }).lean();
  console.log(`[syncManifests] found ${models.length} active fal models`);
  
  const results = { synced: 0, skipped: 0, failed: 0, errors: [] };
  
  for (const model of models) {
    const falId = model.falVideoModelId || model.falModelId;
    if (!falId) {
      console.warn(`  ⊘ ${model.id}: no falModelId`);
      results.skipped++;
      continue;
    }
    
    if (onlyMissing && model.capabilities?.manifest?.inputSlots?.length > 0) {
      console.log(`  ↺ ${model.id}: already has manifest (skip)`);
      results.skipped++;
      continue;
    }
    
    try {
      const manifest = await buildManifest(falId);
      console.log(`  ✓ ${model.id.padEnd(28)} ${manifest.uiVariant.padEnd(24)} ${manifest.inputSlots.length} slots`);
      
      if (!dryRun) {
        await AiModel.updateOne(
          { id: model.id },
          { $set: { 'capabilities.manifest': manifest } }
        );
      }
      results.synced++;
    } catch (err) {
      console.error(`  ✗ ${model.id}: ${err.message}`);
      results.failed++;
      results.errors.push({ id: model.id, error: err.message });
    }
    
    // Rate limit fal docs server
    await new Promise(r => setTimeout(r, 250));
  }
  
  console.log(`\n[syncManifests] synced=${results.synced} skipped=${results.skipped} failed=${results.failed}`);
  return results;
}

if (require.main === module) {
  require('dotenv').config();
  const url = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const db = process.env.DB || 'qumak';
  
  mongoose.connect(`${url}/${db}`)
    .then(() => syncAll({ 
      dryRun: process.argv.includes('--dry-run'),
      onlyMissing: process.argv.includes('--only-missing'),
    }))
    .then(() => mongoose.disconnect())
    .catch(err => {
      console.error('Failed:', err);
      process.exit(1);
    });
}

module.exports = { buildManifest, syncAll };