// tests/extractors/extractSocialHandles.test.js
const fs = require('fs');
const path = require('path');
const { extractSocialHandles } = require('../../services/scraper/extractSocialHandles');

describe('extractSocialHandles - real-world fixtures', () => {
  const fixtures = [
    'malabar-dental',
    'jetour-uae',
    'afghan-palace',
    'kahf-beauty-uae',
  ];

  fixtures.forEach(name => {
    test(`${name}: extracts all expected handles`, () => {
      const html = fs.readFileSync(
        path.join(__dirname, `../fixtures/${name}.html`), 'utf-8'
      );
      const expected = require(`../fixtures/expected/${name}-social.json`);
      
      const result = extractSocialHandles({ html, url: expected.url });
      
      // Test each expected handle is present
      expect(result.handles.facebookHandle).toBe(expected.facebookHandle);
      expect(result.handles.instagramHandle).toBe(expected.instagramHandle);
      expect(result.handles.tiktokHandle).toBe(expected.tiktokHandle);
      expect(result.handles.whatsappNumber).toBe(expected.whatsappNumber);
      
      // Test NO false positives
      if (expected.expectedAbsent) {
        expected.expectedAbsent.forEach(field => {
          expect(result.handles[field]).toBeFalsy();
        });
      }
    });
  });

  // Critical performance test
  test('extracts in under 200ms on 1MB HTML', () => {
    const largeHtml = fs.readFileSync(
      path.join(__dirname, '../fixtures/large-html-1mb.html'), 'utf-8'
    );
    const start = Date.now();
    extractSocialHandles({ html: largeHtml });
    expect(Date.now() - start).toBeLessThan(200);
  });

  test('competitor with confidence < 0.6 is filtered out before final report', () => {
    const competitors = [
      { name: 'Hyundai UAE', confidence: 0.95 },
      { name: 'AutoScout24', confidence: 0.32 }, // keyword match, no domain match
    ];
    
    const filtered = filterByConfidence(competitors, 0.6);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Hyundai UAE');
  });
});