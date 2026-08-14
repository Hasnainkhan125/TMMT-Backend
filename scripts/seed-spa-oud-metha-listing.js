/**
 * Upsert the featured Spa / wellness listing (Oud Metha, Dubai) for marketplace auctions.
 * Run: node scripts/seed-spa-oud-metha-listing.js
 * Requires MONGO_URI in .env
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BusinessListing = require('../model/schema/businessListing');

const SLUG = 'spa-oud-metha-dubai';

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGO_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 45);

  const doc = {
    name: 'Spa & Wellness — Oud Metha, Dubai',
    slug: SLUG,
    industry: 'Healthcare',
    location: {
      emirate: 'Dubai',
      area: 'Oud Metha',
      setupType: 'mainland',
    },
    financials: {
      askingPrice: 250000,
      monthlyRevenue: 32000,
      monthlyProfit: 16000,
      profitMargin: 50,
      currency: 'AED',
      vatRegistered: true,
    },
    yearsInOperation: 4,
    employees: 6,
    description:
      'Established spa and wellness centre in Oud Metha with professional license (Dubai DET). '
      + 'Monthly revenue typically AED 29,000–35,000; expenses circa AED 16,000; net profit range AED 13,000–19,000.',
    shortDescription: 'Oud Metha spa & wellness — verified license, stable cash flows.',
    assetsIncluded: [
      'Trade license & permits',
      'Treatment rooms and reception',
      'Equipment inventory',
      'Client database & bookings',
    ],
    reasonForSale: 'Owner pursuing other ventures',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1200&q=80',
        caption: 'Wellness centre',
        isPrimary: true,
      },
    ],
    verificationStatus: 'verified',
    listingStatus: 'active',
    isPublished: true,
    publishedAt: new Date(),
    listingMode: 'auction',
    listingType: 'public_auction',
    listingTypeConfig: {
      countdownDays: 7,
      reserveHiddenUntilMet: true,
      depositToUnlockAED: 500,
      financialsLocked: true,
    },
    auction: {
      startingBid: 250000,
      reservePrice: 220000,
      bidIncrement: 5000,
      endsAt,
    },
    expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    tags: ['spa', 'oud-metha', 'dubai', 'wellness', 'healthcare'],
  };

  const existing = await BusinessListing.findOne({ slug: SLUG });
  if (existing) {
    await BusinessListing.updateOne({ _id: existing._id }, { $set: doc });
    console.log('Updated listing', SLUG);
  } else {
    await BusinessListing.create(doc);
    console.log('Created listing', SLUG);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
