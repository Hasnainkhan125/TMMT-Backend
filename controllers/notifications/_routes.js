const express = require('express');
const router = express.Router();
const auth = require('../../middelwares/auth');
const Notification = require('../../model/schema/notification');

// All routes require auth
router.use(auth);

// Get my notifications
router.get('/', async (req, res) => {
  try {
    const list = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100);
    res.json({ status: 'success', data: { notifications: list } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Mark as read
router.post('/:id/read', async (req, res) => {
  try {
    await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { read: true });
    res.json({ status: 'success' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

module.exports = router;


