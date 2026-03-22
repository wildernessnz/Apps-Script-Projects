/**
 * DataLayer.gs
 *
 * Drop this file into any Apps Script project.
 * Replace direct Fleetio/HubSpot/Xero UrlFetch calls with these functions.
 *
 * Prerequisites in appsscript.json:
 *   "oauthScopes": [
 *     "https://www.googleapis.com/auth/bigquery.readonly",
 *     "https://www.googleapis.com/auth/spreadsheets"
 *   ]
 *
 * Replace these constants with your actual values:
 */

var DATA_LAYER = {
  PROJECT_ID: 'your-gcp-project-id',
  LOCATION: 'australia-southeast1',  // match your BQ dataset location
};

// ---------------------------------------------------------------------------
// Core query runner
// ---------------------------------------------------------------------------

/**
 * Run a BigQuery SQL query and return results as a 2D array (headers + rows).
 * Same shape as what your existing populateSheet() expects.
 *
 * @param {string} sql
 * @returns {{ fields: string[], values: any[][] }}
 */
function bqQuery(sql) {
  var job = BigQuery.Jobs.query(DATA_LAYER.PROJECT_ID, {
    query: sql,
    location: DATA_LAYER.LOCATION,
    useLegacySql: false,
    timeoutMs: 30000,
  });

  // Wait for job to complete (query() is synchronous up to timeoutMs)
  if (!job.jobComplete) {
    // Poll until done — rarely needed with timeoutMs set
    var jobId = job.jobReference.jobId;
    do {
      Utilities.sleep(1000);
      job = BigQuery.Jobs.getQueryResults(DATA_LAYER.PROJECT_ID, jobId, {
        location: DATA_LAYER.LOCATION,
      });
    } while (!job.jobComplete);
  }

  if (!job.rows || job.rows.length === 0) {
    return { fields: [], values: [] };
  }

  var fields = job.schema.fields.map(function (f) { return f.name; });
  var values = job.rows.map(function (row) {
    return row.f.map(function (cell) { return cell.v; });
  });

  return { fields: fields, values: values };
}

// ---------------------------------------------------------------------------
// Convenience wrappers — one per data source / entity
// ---------------------------------------------------------------------------

var Fleetio = {
  /**
   * Get all active vehicles.
   */
  getVehicles: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.fleetio.assets` ' + where + ' ORDER BY name');
  },

  /**
   * Get work orders. Optionally filter by status, e.g. "status = 'open'"
   */
  getWorkOrders: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.fleetio.work_orders` ' + where + ' ORDER BY created_at DESC');
  },

  /**
   * Get issues. Optionally filter e.g. "state = 'open'"
   */
  getIssues: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.fleetio.issues` ' + where);
  },
};

var HubSpot = {
  getContacts: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.hubspot.contacts` ' + where + ' ORDER BY createdate DESC');
  },

  getDeals: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.hubspot.deals` ' + where + ' ORDER BY closedate DESC');
  },

  getCompanies: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.hubspot.companies` ' + where);
  },
};

var Xero = {
  getInvoices: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.xero.invoices` ' + where + ' ORDER BY Date DESC');
  },

  getContacts: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.xero.contacts` ' + where);
  },

  getPayments: function (filter) {
    var where = filter ? ('WHERE ' + filter) : '';
    return bqQuery('SELECT * FROM `' + DATA_LAYER.PROJECT_ID + '.xero.payments` ' + where + ' ORDER BY Date DESC');
  },
};

// ---------------------------------------------------------------------------
// Sheet writer — same interface as your existing populateSheet()
// ---------------------------------------------------------------------------

/**
 * Write a bqQuery result into a named sheet tab.
 * Drop-in replacement for your existing populateSheet() function.
 *
 * @param {string} sheetName
 * @param {{ fields: string[], values: any[][] }} data  - result of bqQuery()
 */
function populateSheetFromBQ(sheetName, data) {
  if (!data.fields.length) {
    Logger.log('No data returned for sheet: ' + sheetName);
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('Sheet not found: ' + sheetName);
    return;
  }

  var allRows = [data.fields].concat(data.values);
  sheet.getRange(1, 1, sheet.getMaxRows(), data.fields.length).clearContent();
  sheet.getRange(1, 1, allRows.length, data.fields.length).setValues(allRows);
}
