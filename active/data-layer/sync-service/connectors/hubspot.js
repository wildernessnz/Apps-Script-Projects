/**
 * HubSpot connector
 *
 * Syncs to BigQuery dataset: `hubspot`
 * Tables: contacts, companies, deals
 *
 * Uses HubSpot CRM v3 API with cursor-based pagination (after token).
 * Rate limits: 100 req/10s, 40,000 req/day (standard)
 */

const axios = require('axios');
const { getSecret } = require('../secrets');
const { loadTable } = require('../bigquery');

const BASE_URL = 'https://api.hubapi.com/crm/v3/objects';

// Properties to fetch per object type — add/remove as needed
const PROPERTIES = {
  contacts: ['firstname', 'lastname', 'email', 'phone', 'company', 'createdate', 'lastmodifieddate', 'lifecyclestage', 'hs_lead_status'],
  companies: ['name', 'domain', 'industry', 'city', 'country', 'phone', 'numberofemployees', 'annualrevenue', 'createdate'],
  deals: ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'createdate', 'hubspot_owner_id', 'hs_deal_stage_probability'],
};

async function getClient() {
  const token = await getSecret('hubspot-access-token');
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchAllObjects(client, objectType) {
  const rows = [];
  let after = undefined;
  const properties = PROPERTIES[objectType] || [];

  do {
    const response = await client.get(`/${objectType}`, {
      params: {
        limit: 100,
        properties: properties.join(','),
        after,
      },
    });

    const { results, paging } = response.data;
    rows.push(...results.map((r) => ({ id: r.id, ...r.properties })));

    after = paging?.next?.after;
    console.log(`[HubSpot] ${objectType}: fetched ${rows.length} so far`);

    if (after) await sleep(120); // ~100 req/10s = ~100ms min, 120ms is safe
  } while (after);

  return rows;
}

async function syncHubspot() {
  const client = await getClient();
  const results = {};

  for (const objectType of ['contacts', 'companies', 'deals']) {
    const rows = await fetchAllObjects(client, objectType);
    results[objectType] = await loadTable('hubspot', objectType, rows);
  }

  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { syncHubspot };
