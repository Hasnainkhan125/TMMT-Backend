#!/usr/bin/env node
/**
 * Seed marketplace listings for development/testing.
 * Creates listings with slug "1", "2", etc. to match frontend mock IDs.
 * Run: node scripts/seed-marketplace-listings.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BusinessListing = require('../model/schema/businessListing');

const DATABASE_URL = process.env.DB_URL || 'mongodb://127.0.0.1:27017';
const DATABASE = process.env.DB || 'qumak';

const SEED_LISTINGS = [
  {
    slug: '1', name: 'Premium Perfume E-commerce Brand', industry: 'E-commerce',
    price: 850000, revenue: 95000, margin: 34, years: 3, employees: 4,
    bids: 7, watchers: 23, viewsToday: 31, highestBid: 820000,
    endsAt: new Date(Date.now() + 7 * 24 * 3600000).toISOString(),
    badge: 'Hot Deal', setupType: 'freezone',
    assets: ['Shopify store', 'Amazon & Noon accounts', 'Brand identity', 'Customer database 12K+', 'Supplier relationships', '45K social followers'],
    highlights: ['12K+ customer database', '45K social followers', 'Exclusive supplier deals'],
  },
  {
    slug: '2', name: 'Digital Marketing Agency — Dubai', industry: 'Digital Marketing',
    price: 1200000, revenue: 145000, margin: 42, years: 5, employees: 8,
    bids: 12, watchers: 31, viewsToday: 41, highestBid: 1150000,
    endsAt: new Date(Date.now() + 5 * 24 * 3600000).toISOString(),
    badge: 'Verified', setupType: 'mainland',
    assets: ['18 retainer client contracts', 'Proprietary tools & dashboards', 'Team of 8', 'Trade license', 'Brand & domain'],
    highlights: ['18 retainer clients', '42% profit margin', '5 years established'],
  },
  {
    slug: '3', name: 'Cloud Kitchen — Multi-Cuisine', industry: 'Restaurant',
    price: 480000, revenue: 62000, margin: 28, years: 2, employees: 6,
    bids: 4, watchers: 17, viewsToday: 18, highestBid: 465000,
    endsAt: new Date(Date.now() + 12 * 24 * 3600000).toISOString(),
    setupType: 'mainland',
    assets: ['Commercial kitchen equipment', '3 virtual brand licenses', 'Delivery platform accounts', 'Recipes & SOPs', 'Supplier contracts'],
    highlights: ['3 virtual brands', 'All delivery platforms', 'Full kitchen included'],
  },
  {
    slug: '4', name: 'Real Estate Brokerage — RERA Licensed', industry: 'Real Estate',
    price: 2100000, revenue: 280000, margin: 38, years: 6, employees: 12,
    bids: 19, watchers: 42, viewsToday: 67, highestBid: 1980000,
    endsAt: new Date(Date.now() + 2 * 24 * 3600000).toISOString(),
    badge: 'Premium', setupType: 'mainland',
    assets: ['RERA license', '15+ developer partnerships', 'CRM with 8K leads', 'Team of 12', 'Office space lease'],
    highlights: ['RERA licensed', '15+ developer partnerships', '8K lead database'],
  },
  {
    slug: '5', name: 'Clothing Brand — Online & Retail', industry: 'Retail',
    price: 320000, revenue: 42000, margin: 31, years: 2, employees: 3,
    bids: 2, watchers: 28, viewsToday: 9, highestBid: 295000,
    endsAt: new Date(Date.now() + 15 * 24 * 3600000).toISOString(),
    setupType: 'freezone', verificationStatus: 'pending',
    assets: ['Brand identity', 'Instagram account 28K', 'Website', 'Inventory AED 80K', 'Supplier contacts'],
    highlights: ['28K Instagram followers', 'AED 80K inventory', 'Active kiosk location'],
  },
  {
    slug: '6', name: 'SaaS Tech Startup — HR Platform', industry: 'Tech',
    price: 3500000, revenue: 185000, margin: 52, years: 4, employees: 15,
    bids: 24, watchers: 56, viewsToday: 89, highestBid: 3250000,
    endsAt: new Date(Date.now() + 1 * 24 * 3600000).toISOString(),
    badge: 'High ROI', setupType: 'freezone',
    assets: ['SaaS platform full IP', '45 enterprise clients', 'Dev team 7 engineers', 'DIFC license', 'IP & patents'],
    highlights: ['92% retention rate', '45 enterprise clients', 'Full IP ownership'],
  },
];

async function seed() {
  await mongoose.connect(`${DATABASE_URL}/${DATABASE}`);
  console.log('Connected to MongoDB');

  for (const s of SEED_LISTINGS) {
    const existing = await BusinessListing.findOne({ slug: s.slug });
    const profit = Math.round(s.revenue * (s.margin / 100));

    const listingData = {
      name: s.name,
      slug: s.slug,
      industry: s.industry,
      location: { emirate: 'Dubai', setupType: s.setupType || 'freezone' },
      financials: {
        askingPrice: s.price,
        monthlyRevenue: s.revenue,
        monthlyProfit: profit,
        profitMargin: s.margin,
        currency: 'AED',
      },
      yearsInOperation: s.years,
      employees: s.employees,
      description: `${s.name} — premium business acquisition opportunity in UAE`,
      shortDescription: s.name,
      assetsIncluded: s.assets || [],
      verificationStatus: s.verificationStatus || 'verified',
      listingStatus: 'active',
      isPublished: true,
      publishedAt: new Date(),
      listingMode: 'auction',
      auction: {
        startingBid: Math.round(s.price * 0.85),
        reservePrice: Math.round(s.price * 1.1),
        highestBid: s.highestBid || Math.round(s.price * 0.95),
        minBidIncrement: 5000,
        endsAt: s.endsAt ? new Date(s.endsAt) : new Date(Date.now() + 7 * 24 * 3600000),
      },
      metrics: {
        views: s.viewsToday * 7,
        inquiries: Math.floor(s.bids * 1.5),
        saves: Math.floor(s.watchers * 0.4),
        bids: s.bids || 0,
        viewsToday: s.viewsToday || 0,
        watchers: s.watchers || 0,
        highestBid: s.highestBid || Math.round(s.price * 0.95),
      },
    };

    if (existing) {
      await BusinessListing.findByIdAndUpdate(existing._id, listingData);
      console.log(`Updated listing: ${s.name} (slug: ${s.slug})`);
    } else {
      await BusinessListing.create(listingData);
      console.log(`Created listing: ${s.name} (slug: ${s.slug})`);
    }
  }

  await mongoose.disconnect();
  console.log('Done');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
