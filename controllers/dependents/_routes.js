const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');
const User = require('../../model/schema/user');

// We will store dependents inside User document for simplicity

router.use(auth);

// Add dependent
router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, relationship, passportNumber, nationality, dateOfBirth, email, phoneNumber } = req.body || {};
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    const dep = { firstName, lastName, relationship, passportNumber, nationality, dateOfBirth, email, phoneNumber, _id: require('mongoose').Types.ObjectId() };
    if (!user.dependents) user.dependents = [];
    user.dependents.push(dep);
    await user.save();
    res.json({ status: 'success', data: { dependent: dep } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// List dependents
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    res.json({ status: 'success', data: { dependents: user?.dependents || [] } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Update dependent
router.put('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    const idx = (user.dependents || []).findIndex(d => String(d._id) === req.params.id);
    if (idx === -1) return res.status(404).json({ status: 'error', message: 'Dependent not found' });
    user.dependents[idx] = { ...user.dependents[idx]._doc, ...req.body };
    await user.save();
    res.json({ status: 'success', data: { dependent: user.dependents[idx] } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Delete dependent
router.delete('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    user.dependents = (user.dependents || []).filter(d => String(d._id) !== req.params.id);
    await user.save();
    res.json({ status: 'success' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

module.exports = router;


