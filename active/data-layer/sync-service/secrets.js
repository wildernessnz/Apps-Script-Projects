/**
 * Secrets — fetched from Google Secret Manager at startup.
 * One source of truth for all API keys across all your scripts.
 *
 * Secret names in Secret Manager (create these once):
 *   fleetio-api-key
 *   fleetio-account-token
 *   hubspot-access-token
 *   xero-client-id
 *   xero-client-secret
 *   xero-tenant-id
 *   xero-refresh-token       ← updated automatically on each token refresh
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const client = new SecretManagerServiceClient();

const PROJECT = process.env.GCP_PROJECT_ID;
const cache = {};

async function getSecret(name) {
  if (cache[name]) return cache[name];
  const [version] = await client.accessSecretVersion({
    name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
  });
  const value = version.payload.data.toString('utf8');
  cache[name] = value;
  return value;
}

module.exports = { getSecret };
