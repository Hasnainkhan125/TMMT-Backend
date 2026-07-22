'use strict';

const brandRegistryService = require('../../services/brandRegistryService');

async function create(req, res) {
  try {
    const userId = req.user?._id || req.body.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'auth_required' });
    const brand = await brandRegistryService.createBrand({ userId, ...req.body });
    return res.status(201).json({ success: true, brand });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

async function list(req, res) {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ success: false, error: 'auth_required' });
    const brands = await brandRegistryService.listBrandsForUser(userId);
    return res.json({ success: true, brands });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function get(req, res) {
  try {
    const brand = await brandRegistryService.getBrand(req.params.id);
    if (!brand) return res.status(404).json({ success: false, error: 'brand_not_found' });
    return res.json({ success: true, brand });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function update(req, res) {
  try {
    const brand = await brandRegistryService.updateBrand(req.params.id, req.body);
    return res.json({ success: true, brand });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

async function pause(req, res) {
  try {
    const brand = await brandRegistryService.pauseBrand(req.params.id);
    return res.json({ success: true, brand });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function resume(req, res) {
  try {
    const brand = await brandRegistryService.resumeBrand(req.params.id);
    return res.json({ success: true, brand });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { create, list, get, update, pause, resume };
