'use strict';

/**
 * apolloClient — single source of truth for Apollo.io API calls.
 *
 * Apollo's documented base URL is https://api.apollo.io/api/v1
 * (the historical https://api.apollo.io/v1 form is invalid and returns 404).
 *
 * Replaces inconsistent base URLs and key lookups previously scattered across
 * leadResearchService.js and outreachService.js.
 */

const axios = require('axios');

const APOLLO_BASE = process.env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1';

function getApolloKey() {
  return (
    process.env.APOLLO_API_KEY ||
    process.env.QUMAK_APOLO_LEADS_API_KEY ||
    ''
  );
}

function isConfigured() {
  return !!getApolloKey();
}

function getClient() {
  return axios.create({
    baseURL: APOLLO_BASE,
    timeout: 20000,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': getApolloKey(),
    },
  });
}

/**
 * mixedPersonSearch — Apollo's `/mixed_people/search` endpoint.
 * @param {object} body - Apollo search body (person_titles, person_locations, etc).
 */
async function mixedPersonSearch(body) {
  const client = getClient();
  const res = await client.post('/mixed_people/search', body);
  return res.data;
}

/**
 * peopleEnrichBulk — enrich a list of person objects (resolves emails).
 */
async function peopleEnrichBulk(details) {
  const client = getClient();
  const res = await client.post('/people/bulk_match', { details, reveal_personal_emails: true });
  return res.data;
}

module.exports = {
  APOLLO_BASE,
  getApolloKey,
  isConfigured,
  getClient,
  mixedPersonSearch,
  peopleEnrichBulk,
};
