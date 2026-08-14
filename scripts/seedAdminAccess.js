'use strict';

/**
 * seedAdminAccess — promote one or more users to admin and (optionally) top
 * up their credit balance so they can stress-test the Studio without paying.
 *
 *   # Default: promote mzah5143@gmail.com to admin and grant 5000 credits.
 *   node scripts/seedAdminAccess.js
 *
 *   # Override email and amount.
 *   node scripts/seedAdminAccess.js my-test@example.com 10000
 *
 *   # Multiple emails are supported (comma-separated).
 *   node scripts/seedAdminAccess.js a@x.com,b@y.com 2500
 *
 *   # Only set the role (skip the credit grant) with --no-credits.
 *   node scripts/seedAdminAccess.js founder@x.com --no-credits
 *
 *   # Reset to exactly N credits instead of incrementing by N.
 *   node scripts/seedAdminAccess.js founder@x.com 5000 --reset
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../model/schema/user');
const creditsService = require('../services/creditsService');

const DEFAULT_EMAIL = 'mzah5143@gmail.com';
const DEFAULT_AMOUNT = 5000;
const DEFAULT_ROLE = 'admin';

async function run() {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  const emailArg = positional[0] || DEFAULT_EMAIL;
  const amount = Number(positional[1]) || DEFAULT_AMOUNT;
  const role = process.env.SEED_ADMIN_ROLE || DEFAULT_ROLE;
  const reset = flags.has('--reset');
  const skipCredits = flags.has('--no-credits');

  const emails = emailArg.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const DATABASE = process.env.DB || 'qumak';
  await mongoose.connect(`${DATABASE_URL}/${DATABASE}`);
  console.log(`[seedAdminAccess] connected to ${DATABASE}`);

  for (const email of emails) {
    let user = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });

    // If the user doesn't exist yet (first-time invite), create a stub
    // account so they can sign in via Google OAuth without a 404.
    if (!user) {
      user = await User.create({
        email,
        fullName: email.split('@')[0],
        role,
        provider: 'admin-seed',
      });
      console.log(`  ✓ created stub user ${email} with role=${role}`);
    } else if (user.role !== role) {
      user.role = role;
      await user.save();
      console.log(`  ✓ promoted ${email} → role=${role}`);
    } else {
      console.log(`  • ${email} already role=${role}`);
    }

    if (skipCredits) continue;

    if (reset) {
      await User.updateOne({ _id: user._id }, { $set: { platformCredits: amount } });
      console.log(`     ↳ reset balance to ${amount} credits`);
    } else {
      try {
        await creditsService.topUp({
          userId: user._id,
          amount,
          reason: 'topup_admin',
          meta: { source: 'seedAdminAccess', role, target: email },
        });
        const fresh = await User.findById(user._id).select('platformCredits').lean();
        console.log(`     ↳ +${amount} credits → balance ${fresh?.platformCredits ?? 'unknown'}`);
      } catch (err) {
        console.warn(`     ✗ topUp failed for ${email}: ${err.message}`);
      }
    }
  }

  console.log(`[seedAdminAccess] done — ${emails.length} target(s) processed`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[seedAdminAccess] failed:', err);
    process.exit(1);
  });
}

module.exports = { run };