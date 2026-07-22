'use strict';

const { z } = require('zod');
const BrandProfile = require('../../model/schema/brandProfile');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownershipFilter(req) {
  const userId = req.user?._id;
  const sessionId = getSessionId(req);
  if (userId) return { userId, isArchived: false };
  if (sessionId) return { sessionId, userId: null, isArchived: false };
  return null;
}

const profileSchema = z.object({
  name:            z.string().min(1).max(100),
  category:        z.enum(['gym', 'realestate', 'perfume', 'saas', 'restaurant', 'service', 'general']).optional().default('general'),
  description:     z.string().max(800).optional().default(''),
  targetAudience:  z.string().max(400).optional().default(''),
  vibe:            z.string().max(50).optional().default(''),
  brandColors:     z.array(z.string()).optional().default([]),
  fonts:           z.array(z.string()).optional().default([]),
  logoUrl:         z.string().url().optional().nullable(),
  locale:          z.enum(['gulf', 'global']).optional().default('gulf'),
  languages:       z.array(z.enum(['ar', 'en', 'fr', 'hi', 'tl'])).optional().default(['ar', 'en']),
  channels:        z.record(z.string().nullable()).optional().default({}),
  extras:          z.record(z.unknown()).optional().default({}),
  isDefault:       z.boolean().optional().default(false),
});

// GET /api/v1/studio/brand-profiles
exports.list = async (req, res) => {
  try {
    const filter = ownershipFilter(req);
    if (!filter) return res.json({ success: true, profiles: [] });
    const profiles = await BrandProfile.find(filter).sort({ isDefault: -1, updatedAt: -1 }).lean();
    res.json({ success: true, profiles });
  } catch (err) {
    console.error('[brandProfile] list error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
};

// POST /api/v1/studio/brand-profiles
exports.create = async (req, res) => {
  try {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'validation_error', issues: parsed.error.issues });
    }
    const userId = req.user?._id || null;
    const sessionId = getSessionId(req);
    if (!userId && !sessionId) {
      return res.status(401).json({ success: false, error: 'no_owner', message: 'Provide a session or sign in.' });
    }

    if (parsed.data.isDefault) {
      await BrandProfile.updateMany(
        userId ? { userId } : { sessionId, userId: null },
        { $set: { isDefault: false } }
      );
    }

    const profile = await BrandProfile.create({ ...parsed.data, userId, sessionId });
    res.status(201).json({ success: true, profile });
  } catch (err) {
    console.error('[brandProfile] create error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
};

// PUT /api/v1/studio/brand-profiles/:id
exports.update = async (req, res) => {
  try {
    const parsed = profileSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'validation_error', issues: parsed.error.issues });
    }
    const filter = ownershipFilter(req);
    if (!filter) return res.status(401).json({ success: false, error: 'no_owner' });

    if (parsed.data.isDefault) {
      await BrandProfile.updateMany(filter, { $set: { isDefault: false } });
    }
    const profile = await BrandProfile.findOneAndUpdate(
      { _id: req.params.id, ...filter },
      parsed.data,
      { new: true }
    );
    if (!profile) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, profile });
  } catch (err) {
    console.error('[brandProfile] update error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
};

// DELETE /api/v1/studio/brand-profiles/:id
exports.remove = async (req, res) => {
  try {
    const filter = ownershipFilter(req);
    if (!filter) return res.status(401).json({ success: false, error: 'no_owner' });
    const result = await BrandProfile.findOneAndUpdate(
      { _id: req.params.id, ...filter },
      { $set: { isArchived: true } }
    );
    if (!result) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[brandProfile] remove error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
};
