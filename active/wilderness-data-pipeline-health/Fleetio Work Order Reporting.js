/**
 * @fileoverview Wilderness Work Orders Reporting — pulls from BigQuery
 * reporting.fleetio_work_orders view into a Google Sheet for analysis.
 *
 * Sheets:
 *   "Work Orders - Summary"  → monthly cost totals by wo_type
 *   "Work Orders - Detail"   → flat list of all work orders with key fields
 *
 * Requires:
 *   - BigQueryLibrary linked as a library
 *   - BigQuery Advanced Service enabled
 *
 * All business logic (cost rollups by service task, labour time aggregation,
 * custom field extraction) lives in the reporting.fleetio_work_orders
 * BigQuery view — not here. This script is a thin consumer only:
 * aggregation for summary, column selection for detail. Same architectural
 * pattern as DealsReporting.gs on top of reporting.deals.
 *
 * Data lives in australia-southeast1, same region as the rest of the
 * wilderness-data-pipeline.
 */

// GCP_PROJECT_ID is declared once in DealsReporting.gs — Apps Script shares
// global scope across all .gs files in a project, so it's available here
// without redeclaring (redeclaring causes "Identifier has already been
// declared" since const bindings can't be duplicated across files).

function refreshWorkOrdersReporting() { new WorkOrdersReporting().refresh(); }
function refreshWorkOrdersSummary()   { new WorkOrdersReporting().refreshSummary(); }
function refreshWorkOrdersDetail()    { new WorkOrdersReporting().refreshDetail(); }

var WorkOrdersReporting = function() {

  const SUMMARY_SHEET = 'Work Orders - Summary';
  const DETAIL_SHEET  = 'Work Orders - Detail';

  // ── SQL ────────────────────────────────────────────────────────────────────

  /**
   * Summary: monthly work order count and cost totals by wo_type.
   * All business logic (cost rollups, custom field extraction) already in view.
   */
  const SUMMARY_SQL = `
    SELECT
      FORMAT_DATETIME('%Y-%m', created_at)      AS month,
      wo_type,
      COUNT(*)                                  AS work_orders,
      ROUND(SUM(turn_around_cost), 2)            AS total_turn_around_cost,
      ROUND(SUM(detail_cost), 2)                 AS total_detail_cost,
      ROUND(SUM(other_cost), 2)                  AS total_other_cost,
      ROUND(SUM(total_amount), 2)                AS total_amount,
      ROUND(SUM(total_clocked_labour_time_secs) / 3600, 2) AS total_clocked_labour_hours
    FROM \`wilderness-data.reporting.fleetio_work_orders\`
    GROUP BY month, wo_type
    ORDER BY month DESC, wo_type
  `;

  /**
   * Detail: flat list of all work orders — exclude internal sync metadata.
   * Business logic (cost rollups, labour aggregation, custom field
   * extraction, NZT datetime conversion) already in view.
   */
  const DETAIL_SQL = `
    SELECT * EXCEPT (_synced_at)
    FROM \`wilderness-data.reporting.fleetio_work_orders\`
    ORDER BY created_at DESC
  `;

  // ── Public methods ─────────────────────────────────────────────────────────

  /**
   * Refresh both sheets.
   */
  this.refresh = () => {
    Logger.log('[WorkOrdersReporting.refresh] starting full refresh');
    this.refreshSummary();
    this.refreshDetail();
    Logger.log('[WorkOrdersReporting.refresh] complete');
  };

  /**
   * Refresh the summary sheet — monthly cost totals by wo_type.
   */
  this.refreshSummary = () => {
    Logger.log('[WorkOrdersReporting.refreshSummary] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      SUMMARY_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[WorkOrdersReporting.refreshSummary] rows=${res.totalRows}`);
    writeToSheet_(SUMMARY_SHEET, res.headers, res.data);
  };

  /**
   * Refresh the detail sheet — flat list of all work orders.
   */
  this.refreshDetail = () => {
    Logger.log('[WorkOrdersReporting.refreshDetail] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      DETAIL_SQL,
      { location: 'australia-southeast1', maxRows: 25000 }
    );
    Logger.log(`[WorkOrdersReporting.refreshDetail] rows=${res.totalRows}`);
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
      Logger.log(`[WorkOrdersReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[WorkOrdersReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[WorkOrdersReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};