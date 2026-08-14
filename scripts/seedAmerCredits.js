'use strict';

/**
 * seedAmerCredits — give every user with role 'amer' (and optionally any
 * email passed as args) a fat 1000-credit balance for testing.
 *
 *   node scripts/seedAmerCredits.js
 *   node scripts/seedAmerCredits.js my-test@example.com 5000
 *
 * Idempotent in the sense that re-running adds another grant on top — so
 * use `--reset` if you want to set the balance to exactly N rather than
 * incrementing by N.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../model/schema/user');
const creditsService = require('../services/creditsService');

async function run() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const reset = process.argv.includes('--reset');

  const explicitEmail = args[0];
  const amount = Number(args[1]) || 1000;

  const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
  const DATABASE = process.env.DB || 'qumak';
  await mongoose.connect(`${DATABASE_URL}/${DATABASE}`);
  console.log(`[seedAmerCredits] connected to ${DATABASE}`);

  const filter = explicitEmail
    ? { email: explicitEmail }
    : { role: 'amer' };

  const users = await User.find(filter).select('_id email role platformCredits').lean();
  if (!users.length) {
    console.warn(`[seedAmerCredits] no users matched ${JSON.stringify(filter)} — nothing to do`);
    await mongoose.disconnect();
    return;
  }

  for (const u of users) {
    if (reset) {
      await User.updateOne({ _id: u._id }, { $set: { platformCredits: amount } });
      console.log(`  ✓ reset ${u.email || u._id} → ${amount} credits`);
    } else {
      await creditsService.topUp({
        userId: u._id,
        amount,
        reason: 'topup_admin',
        meta: { source: 'seedAmerCredits', operatorRole: u.role },
      });
      console.log(`  ✓ +${amount} → ${u.email || u._id} (was ${u.platformCredits || 0})`);
    }
  }

  console.log(`[seedAmerCredits] done — ${users.length} user(s) topped up`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[seedAmerCredits] failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
