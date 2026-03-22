/**
 * Fleetio connector
 *
 * Syncs to BigQuery dataset: `fleetio`
 * Tables: assets, contacts, issues, work_orders, fuel_entries
 *
 * Fleetio API docs: https://developer.fleetio.com/
 * - Uses cursor-based pagination via Link header (rel="next")
 * - Rate limit: 100 req/min on standard plans
 */

const axios = require('axios');
const { getSecret } = require('../secrets');
const { loadTable } = require('../bigquery');

const BASE_URL = 'https://secure.fleetio.com/api/v2';

async function getClient() {
  const [apiKey, accountToken] = await Promise.all([
    getSecret('fleetio-api-key'),
    getSecret('fleetio-account-token'),
  ]);
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Account-Token': accountToken,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Fetch all pages from a paginated Fleetio endpoint.
 * Fleetio uses cursor pagination — follow the `next` link until exhausted.
 */
async function fetchAll(client, path, params = {}) {
  const rows = [];
  let url = path;
  let pageNum = 1;

  while (url) {
    const response = await client.get(url, { params: pageNum === 1 ? params : {} });
    const data = response.data;

    // Fleetio v2 wraps results in a `data` array with a `meta` object
    const items = Array.isArray(data) ? data : (data.data || []);
    rows.push(...items);

    // Cursor pagination: check for next page cursor in meta
    const nextCursor = data?.meta?.next_cursor;
    url = nextCursor ? `${path}?cursor=${nextCursor}` : null;
    pageNum++;

    console.log(`[Fleetio] ${path}: fetched page ${pageNum - 1}, ${items.length} items`);

    // Respect rate limit — 100 req/min = ~600ms between requests to be safe
    if (url) await sleep(650);
  }

  return rows;
}

async function syncFleetio() {
  const client = await getClient();
  const results = {};

  // Vehicles / Assets
  const assets = await fetchAll(client, '/vehicles', { per_page: 100 });
  results.assets = await loadTable('fleetio', 'assets', assets.map(flattenObject));

  // Contacts
  const contacts = await fetchAll(client, '/contacts', { per_page: 100 });
  results.contacts = await loadTable('fleetio', 'contacts', contacts.map(flattenObject));

  // Issues
  const issues = await fetchAll(client, '/issues', { per_page: 100 });
  results.issues = await loadTable('fleetio', 'issues', issues.map(flattenObject));

  // Work Orders
  const workOrders = await fetchAll(client, '/work_orders', { per_page: 100 });
  results.work_orders = await loadTable('fleetio', 'work_orders', workOrders.map(flattenObject));

  // Fuel Entries (optional — can be high volume)
  // const fuelEntries = await fetchAll(client, '/fuel_entries', { per_page: 100 });
  // results.fuel_entries = await loadTable('fleetio', 'fuel_entries', fuelEntries.map(flattenObject));

  return results;
}

// BQ doesn't like nested objects in streaming inserts — flatten one level deep
function flattenObject(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      Object.assign(acc, flattenObject(val, fullKey));
    } else {
      acc[fullKey] = Array.isArray(val) ? JSON.stringify(val) : val;
    }
    return acc;
  }, {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { syncFleetio };
