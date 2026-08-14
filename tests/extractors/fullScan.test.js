'use strict';

const { scanUrl } = require('../../services/urlToAdsService');
const { test } = require('node:test');
const { expect } = require('chai');

const REAL_URLS = [
    {
      url: 'https://www.malabardentalclinics.com',
      expectations: {
        brand: { name: 'Malabar Dental', vertical: 'clinic_dental' },
        hasSocial: ['facebook', 'instagram', 'whatsapp'],
        minCompetitors: 3,
        maxCompetitors: 8,
        noCompetitorMatching: /Malabar/i, // own brand must never appear
        minWinningAds: 5,
      },
    },
    {
        url: 'http://daytodayuae.com/',
        expectations: {
            brand: { name: 'Day Today', vertical: 'qsr_karak' },
            hasSocial: ['facebook', 'instagram', 'whatsapp'],
            minCompetitors: 3,
            maxCompetitors: 8,
            noCompetitorMatching: /Day Today/i, // own brand must never appear
            minWinningAds: 5,
          },
    },
    // ... 4 more real URLs
  ];
  
  REAL_URLS.forEach(({ url, expectations }) => {
    test(`Full scan: ${url}`, async () => {
      const scan = await scanUrl({ url });
      
      expect(scan.brand.name).toBe(expectations.brand.name);
      expect(scan.businessProfile.type).toBe(expectations.brand.vertical);
      
      expectations.hasSocial.forEach(platform => {
        expect(scan.brand.socialHandles[`${platform}Handle`]).toBeTruthy();
      });
      
      expect(scan.competitors.length).toBeGreaterThanOrEqual(expectations.minCompetitors);
      expect(scan.competitors.length).toBeLessThanOrEqual(expectations.maxCompetitors);
      
      // The own-brand-as-competitor check
      scan.competitors.forEach(c => {
        expect(c.name).not.toMatch(expectations.noCompetitorMatching);
      });
      
      expect(scan.winners?.length).toBeGreaterThanOrEqual(expectations.minWinningAds);
    }, 120000); // 2-minute timeout
  });