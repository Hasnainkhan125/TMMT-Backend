/**
 * Qumak Marketplace — four listing types (strategy doc).
 * Used by GET /api/v1/marketplace/listing-types and for validation hints.
 */
const LISTING_TYPES = {
  public_auction: {
    id: 'public_auction',
    label: 'Public Auction',
    shortLabel: 'Auction',
    emoji: '🔨',
    summary:
      'Business listed publicly. All bids visible in real-time. Highest bid wins if reserve met.',
    buyerSees: [
      'Current highest bid',
      'Bid count',
      'Countdown timer',
      'Reserve met / not met (reserve price hidden until met)',
    ],
    sellerBestFor:
      'Stressed sellers who want speed; obvious cashflow businesses.',
    countdownDaysDefault: 7,
  },
  private_sealed: {
    id: 'private_sealed',
    label: 'Private Sealed Bid',
    shortLabel: 'Sealed',
    emoji: '🔒',
    summary:
      'Business visible; all bids sealed. Seller receives all bids when the window closes.',
    buyerSees: ['Number of bids received', 'Not individual amounts until close'],
    sellerBestFor: 'AED 500k+; discreet exits; no public price war.',
    windowDaysMin: 7,
    windowDaysMax: 14,
  },
  off_market_reserved: {
    id: 'off_market_reserved',
    label: 'Off-Market Reserved',
    shortLabel: 'Off-market',
    emoji: '🤫',
    summary:
      'Not publicly listed. Shown only to pre-approved, deposit-paid buyers. Maximum discretion.',
    buyerSees: ['Curated buyer list only after qualification'],
    sellerBestFor: 'AED 1M+; family businesses; confidentiality.',
    listingFeeAEDDefault: 5000,
    successFeePercentDefault: 3,
  },
  buy_now: {
    id: 'buy_now',
    label: 'Fixed Price Buy Now',
    shortLabel: 'Buy now',
    emoji: '⚡',
    summary:
      'Asking price set. First buyer to pay deposit and complete DD within the window wins.',
    buyerSees: ['Fixed price', '48h due diligence window (configurable)'],
    sellerBestFor: 'Sellers who know their price; urgent exits; sub–AED 200k deals.',
    dueDiligenceHoursDefault: 48,
  },
};

function listTypesArray() {
  return Object.values(LISTING_TYPES);
}

/** Map legacy listingMode → listingType when `listingType` is missing */
function inferListingType(doc) {
  if (doc.listingType && LISTING_TYPES[doc.listingType]) return doc.listingType;
  if (doc.listingMode === 'auction') return 'public_auction';
  return 'buy_now';
}

module.exports = {
  LISTING_TYPES,
  listTypesArray,
  inferListingType,
};
