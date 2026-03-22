/**
 * Wilderness Data Sync — Cloud Run entry point
 *
 * Exposes POST endpoints for each sync job.
 * Cloud Scheduler hits these on a schedule (e.g. every 15 min).
 * Apps Script never calls vendor APIs directly — it reads from BigQuery.
 *
 * Routes:
 *   POST /sync/fleetio     — sync assets, vehicles, issues, work orders
 *   POST /sync/hubspot     — sync contacts, deals, companies
 *   POST /sync/xero        — sync invoices, contacts, accounts
 *   POST /sync/all         — run all syncs sequentially
 *   GET  /health           — health check for Cloud Run
 */

const express = require('express');
const { syncFleetio } = require('./connectors/fleetio');
const { syncHubspot } = require('./connectors/hubspot');
const { syncXero } = require('./connectors/xero');

const app = express();
app.use(express.json());

// --- Health check (required by Cloud Run) ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// --- Individual sync endpoints ---
app.post('/sync/fleetio', async (req, res) => {
  try {
    const result = await syncFleetio();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Fleetio sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/sync/hubspot', async (req, res) => {
  try {
    const result = await syncHubspot();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('HubSpot sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/sync/xero', async (req, res) => {
  try {
    const result = await syncXero();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Xero sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Sync all (useful for a full daily refresh) ---
app.post('/sync/all', async (req, res) => {
  const results = {};
  for (const [name, fn] of [['fleetio', syncFleetio], ['hubspot', syncHubspot], ['xero', syncXero]]) {
    try {
      results[name] = await fn();
    } catch (err) {
      results[name] = { error: err.message };
      console.error(`${name} sync failed:`, err.message);
    }
  }
  res.json(results);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Sync service listening on port ${PORT}`));
