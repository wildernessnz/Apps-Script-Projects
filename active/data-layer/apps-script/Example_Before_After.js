/**
 * Example_Before_After.gs
 *
 * Shows the migration pattern for existing Apps Script projects.
 * The logic stays the same — only the data source changes.
 */

// ============================================================
// BEFORE: Direct API call (hits Fleetio API quota, slow, fragile)
// ============================================================

function updateFleetio_BEFORE() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FLEETIO_API_KEY');
  var accountToken = PropertiesService.getScriptProperties().getProperty('FLEETIO_ACCOUNT_TOKEN');

  var response = UrlFetchApp.fetch('https://secure.fleetio.com/api/v2/vehicles?per_page=100', {
    headers: {
      'Authorization': 'Token ' + apiKey,
      'Account-Token': accountToken,
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('Failed: ' + response.getContentText());
    return;
  }

  var data = JSON.parse(response.getContentText());
  // ... parse pagination, handle rate limits, paginate, etc.
  // (often hits 6-min timeout on large datasets)
}


// ============================================================
// AFTER: Read from BigQuery (fast, no quotas, no API keys needed)
// ============================================================

function updateFleetio_AFTER() {
  // Reads pre-synced data from BigQuery — runs in under 5 seconds
  var data = Fleetio.getVehicles('status = "Active"');
  populateSheetFromBQ('Vehicles', data);
}

// Another example — cross-source query (not possible with direct API calls)
function updateRevenueReport() {
  var data = bqQuery(`
    SELECT
      x.ContactName,
      x.AmountDue,
      x.DueDate,
      h.dealstage,
      h.amount AS deal_value
    FROM \`your-project.xero.invoices\` x
    LEFT JOIN \`your-project.hubspot.deals\` h
      ON LOWER(x.ContactName) = LOWER(h.dealname)
    WHERE x.Status = 'AUTHORISED'
      AND x.DueDate < CURRENT_DATE()
    ORDER BY x.AmountDue DESC
  `);

  populateSheetFromBQ('Overdue Invoices', data);
}
