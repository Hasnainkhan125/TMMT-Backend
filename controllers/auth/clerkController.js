const User = require('../../model/schema/user');

// Sync Clerk user into local DB
const syncClerkUser = async (req, res) => {
  try {
    // Expect clerk payload from frontend or middleware
    const {
      clerkId,
      email,
      firstName,
      lastName,
      phoneNumber,
      role
    } = req.body;

    if (!clerkId || !email) {
      return res.status(400).json({ message: 'clerkId and email are required' });
    }

    const defaults = {
      firstName: firstName || '',
      lastName: lastName || '',
      phoneNumber: phoneNumber || '',
      role: role || 'sponsor'
    };

    const user = await User.findOneAndUpdate(
      { clerkId },
      { $setOnInsert: { email, clerkId }, $set: defaults },
      { new: true, upsert: true }
    );

    return res.json({ user });
  } catch (err) {
    console.error('Clerk sync error:', err);
    return res.status(500).json({ message: 'Failed to sync Clerk user' });
  }
};

const getMe = async (req, res) => {
  try {
    const id = req.user?.userId || req.user?._id;
    const user = await User.findById(id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch profile' });
  }
};

module.exports = { syncClerkUser, getMe }; 