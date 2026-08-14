/**
 * Marketplace listing types — config + inference (no DB / no app listen).
 */
const assert = require('assert');
const { listTypesArray, inferListingType, LISTING_TYPES } = require('../../config/listingTypeDefinitions');

describe('listingTypeDefinitions', () => {
  it('exports exactly four strategy listing types', () => {
    const types = listTypesArray();
    assert.strictEqual(types.length, 4);
    assert(LISTING_TYPES.public_auction);
    assert(LISTING_TYPES.private_sealed);
    assert(LISTING_TYPES.off_market_reserved);
    assert(LISTING_TYPES.buy_now);
  });

  it('each type has label, buyerSees, and id', () => {
    for (const t of listTypesArray()) {
      assert.ok(t.id && t.label && Array.isArray(t.buyerSees));
    }
  });

  it('inferListingType maps legacy listingMode', () => {
    assert.strictEqual(inferListingType({ listingMode: 'auction' }), 'public_auction');
    assert.strictEqual(inferListingType({ listingMode: 'fixed' }), 'buy_now');
    assert.strictEqual(inferListingType({ listingType: 'private_sealed', listingMode: 'auction' }), 'private_sealed');
  });
});
