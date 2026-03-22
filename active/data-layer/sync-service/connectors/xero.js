/**
 * Xero connector
 *
 * Syncs to BigQuery dataset: `xero`
 * Tables: invoices, contacts, accounts, payments
 *
 * Xero uses OAuth2 with refresh tokens.
 * Rate limits: 60 req/min per app, 5000 req/day
 * Modified-since header reduces data volume on incremental syncs.
 */

const axios = require('axios');
const { getSecret } = require('../secrets');
const { loadTable } = require('../bigquery');

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const BASE_URL = 'https://api.xero.com/api.xro/2.0';

async function getAccessToken() {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    getSecret('xero-client-id'),
    getSecret('xero-client-secret'),
    getSecret('xero-refresh-token'),
  ]);

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    {
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  // NOTE: Xero rotates refresh tokens — you must store the new one.
  // In production, update the secret here:
  // await updateSecret('xero-refresh-token', response.data.refresh_token);
  console.log('[Xero] Token refreshed. Update xero-refresh-token in Secret Manager if rotating.');

  return response.data.access_token;
}

async function getClient() {
  const [accessToken, tenantId] = await Promise.all([
    getAccessToken(),
    getSecret('xero-tenant-id'),
  ]);

  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    },
  });
}

async function fetchXeroResource(client, resource, params = {}) {
  const rows = [];
  let page = 1;

  while (true) {
    const response = await client.get(`/${resource}`, {
      params: { page, pageSize: 100, ...params },
    });

    // Xero wraps results in a key matching the resource name
    const items = response.data[resource] || [];
    if (!items.length) break;

    rows.push(...items);
    console.log(`[Xero] ${resource}: page ${page}, ${rows.length} total`);

    if (items.length < 100) break; // last page
    page++;
    await sleep(1100); // 60 req/min = 1000ms min gap
  }

  return rows;
}

async function syncXero() {
  const client = await getClient();
  const results = {};

  // Invoices (ACCREC = sales invoices, ACCPAY = bills)
  const invoices = await fetchXeroResource(client, 'Invoices', {
    where: 'Type=="ACCREC"',
    order: 'UpdatedDateUTC DESC',
  });
  results.invoices = await loadTable('xero', 'invoices', invoices.map(flattenXero));

  // Contacts
  const contacts = await fetchXeroResource(client, 'Contacts');
  results.contacts = await loadTable('xero', 'contacts', contacts.map(flattenXero));

  // Accounts (chart of accounts — infrequently changes, daily sync is fine)
  const accounts = await fetchXeroResource(client, 'Accounts');
  results.accounts = await loadTable('xero', 'accounts', accounts.map(flattenXero));

  // Payments
  const payments = await fetchXeroResource(client, 'Payments');
  results.payments = await loadTable('xero', 'payments', payments.map(flattenXero));

  return results;
}

// Xero dates come as /Date(1234567890000+0000)/ — convert to ISO
function parseXeroDate(val) {
  if (typeof val !== 'string') return val;
  const match = val.match(/\/Date\((\d+)([+-]\d+)?\)\//);
  return match ? new Date(parseInt(match[1])).toISOString() : val;
}

function flattenXero(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    if (typeof val === 'string' && val.startsWith('/Date(')) {
      acc[fullKey] = parseXeroDate(val);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(acc, flattenXero(val, fullKey));
    } else {
      acc[fullKey] = Array.isArray(val) ? JSON.stringify(val) : val;
    }
    return acc;
  }, {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { syncXero };
