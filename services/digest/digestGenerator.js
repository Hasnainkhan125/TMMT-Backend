'use strict';

/**
 * Weekly competitive digest — compares latest Apify snapshots to the prior week.
 * Email send is wired by weeklyDigestJob (SendGrid / existing mailer).
 */

function buildMoves(current, previous) {
  const moves = [];
  const curAds = current?.competitorAds?.length || 0;
  const prevAds = previous?.competitorAds?.length || 0;
  if (curAds > prevAds) {
    moves.push({
      title: 'New competitor ads detected',
      body: `We found ${curAds - prevAds} more live ads in the Ad Library vs last week.`,
    });
  }
  if (curAds < prevAds) {
    moves.push({
      title: 'Competitor ads dropped',
      body: 'Some previously running creatives are no longer active — a good moment to test your angle.',
    });
  }
  if (moves.length < 3) {
    moves.push({
      title: 'Refresh your hooks',
      body: 'Rotate headline tests on Meta — benchmark CTR in your vertical is moving week to week.',
    });
  }
  return moves.slice(0, 5);
}

/**
 * @returns {{ subject: string, html: string, text: string }}
 */
function generateDigestEmail({ brandName, currentSnapshot, previousSnapshot }) {
  const moves = buildMoves(currentSnapshot, previousSnapshot);
  const subject = `${brandName || 'Your brand'} — weekly competitor moves`;
  const text = moves.map((m) => `• ${m.title}\n  ${m.body}`).join('\n\n');
  const html = `<h2>This week in your competitive set</h2>${moves
    .map((m) => `<h3>${m.title}</h3><p>${m.body}</p>`)
    .join('')}`;
  return { subject, html, text };
}

module.exports = { generateDigestEmail, buildMoves };
