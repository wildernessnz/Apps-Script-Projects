/**
 * @fileoverview Wilderness Deals Reporting — pulls from BigQuery reporting.deals view
 * into a Google Sheet for analysis.
 *
 * Sheets:
 *   "Deals - Summary"  → monthly revenue + deal count by stage group
 *   "Deals - Detail"   → flat list of all deals with key fields
 *
 * Requires:
 *   - BigQueryLibrary linked as a library
 *   - BigQuery Advanced Service enabled
 *
 * All business logic (stage grouping, NZT dates, amount casting, is_active flag)
 * lives in the reporting.deals BigQuery view — not here. This script is a thin
 * consumer only: aggregation for summary, column selection for detail.
 *
 * Data lives in australia-southeast1 (migrated from US region — see the
 * wider wilderness-data-pipeline migration). The `location` option below
 * reflects this.
 *
 * NZT-ONLY DATES NOTE: createdate, closedate, and hs_lastmodifieddate are
 * returned by the view as DATETIME values already converted to
 * Pacific/Auckland — there are no separate UTC originals or _nzt-suffixed
 * duplicate columns (created_date_nzt, close_date_nzt, close_datetime_nzt
 * were removed from the view). Column names are unchanged here
 * (createdate, closedate) even though their underlying type/timezone
 * changed — no SQL changes were needed in this file as a result, since
 * both queries reference these columns by name only.
 */

// GCP_PROJECT_ID is declared in its own dedicated file — Apps Script shares
// global scope across all .gs files in a project, so it's available here
// without redeclaring (redeclaring causes "Identifier has already been
// declared" since const bindings can't be duplicated across files).

function refreshDealsReporting() { new DealsReporting().refresh(); }
function refreshDealsSummary()   { new DealsReporting().refreshSummary(); }
function refreshDealsDetail()    { new DealsReporting().refreshDetail(); }

var DealsReporting = function() {

  const SUMMARY_SHEET = 'Deals - Summary';
  const DETAIL_SHEET  = 'Deals - Detail';

  // ── SQL ────────────────────────────────────────────────────────────────────

  /**
   * Summary: monthly deal count and revenue by stage group.
   * All business logic (amount cast, stage_group, is_active) already in view.
   */
  const SUMMARY_SQL = `
    SELECT
      created_month_label                    AS month,
      stage_group,
      COUNT(*)                               AS deals,
      ROUND(SUM(amount), 2)                  AS total_revenue
    FROM \`wilderness-data.reporting.deals\`
    GROUP BY month, stage_group
    ORDER BY month DESC, stage_group
  `;

  /**
   * Detail: flat list of all deals — exclude internal pipeline metadata columns.
   * Business logic (NZT dates, stage_group, is_active, amount cast) already in view.
   */
  const DETAIL_SQL = `
    SELECT * EXCEPT (_sync_run_id, _synced_at, _hs_archived)
    FROM \`wilderness-data.reporting.deals\`
    ORDER BY createdate DESC
  `;

  // ── Public methods ─────────────────────────────────────────────────────────

  /**
   * Refresh both sheets.
   */
  this.refresh = () => {
    Logger.log('[DealsReporting.refresh] starting full refresh');
    this.refreshSummary();
    this.refreshDetail();
    Logger.log('[DealsReporting.refresh] complete');
  };

  /**
   * Refresh the summary sheet — monthly revenue by stage group.
   */
  this.refreshSummary = () => {
    Logger.log('[DealsReporting.refreshSummary] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      SUMMARY_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[DealsReporting.refreshSummary] rows=${res.totalRows}`);
    writeToSheet_(SUMMARY_SHEET, res.headers, res.data);
  };

  /**
   * Refresh the detail sheet — flat list of all deals.
   */
  this.refreshDetail = () => {
    Logger.log('[DealsReporting.refreshDetail] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      DETAIL_SQL,
      { location: 'australia-southeast1', maxRows: 25000 }
    );
    Logger.log(`[DealsReporting.refreshDetail] rows=${res.totalRows}`);
    writeToSheet_(DETAIL_SHEET, res.headers, res.data);
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Write headers + data to a named sheet, creating it if needed.
   * Clears existing content before writing. Always appends a "Last Refresh"
   * column as the final column, with the same timestamp value on every row —
   * applied here rather than in each SQL query, so every sheet gets it
   * consistently without needing to remember to add it to each query, and
   * it's guaranteed to be the LAST column regardless of the underlying
   * view's column order (which a SELECT * detail query has no control over).
   *
   * @param {string} sheetName
   * @param {string[]} headers
   * @param {Array[]} data
   */
  const writeToSheet_ = (sheetName, headers, data) => {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`[DealsReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[DealsReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[DealsReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};