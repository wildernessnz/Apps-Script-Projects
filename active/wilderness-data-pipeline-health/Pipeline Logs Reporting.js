/**
 * @fileoverview Wilderness Pipeline — recent Cloud Run log viewer. Pulls
 * `wilderness-pipeline` Cloud Run logs directly from the Cloud Logging API
 * (NOT BigQuery — these are stdout/stderr text logs, not a table this
 * pipeline writes to) for a rolling lookback window and writes the
 * job-activity lines to a sheet, so a run's recent behaviour can be
 * inspected without a terminal / `gcloud` access.
 *
 * WHY A REGEX FILTER INSTEAD OF FULL LOGS: Cloud Run emits a lot of
 * request/infra noise per revision. This pipeline's own code tags every
 * job-activity line with a bracketed component name (e.g.
 * "[PipelineRunner] Starting hs_rental_raw.tickets (incremental)",
 * "[BQWriter] Upserted 36 rows -> hs_rental_raw.tickets"). Filtering on
 * that bracket-tag prefix generically captures "what jobs ran and what
 * they did" for ANY platform/table/job — it does not hardcode any specific
 * job name (unlike a one-off keyword grep for e.g. "tickets").
 *
 * Sheet: "Pipeline Logs"
 *   timestamp, message, last_refresh
 *
 * Requires:
 *   - GCP_PROJECT_ID declared in its own file (shared global scope)
 *   - The running user's identity must have at least roles/logging.viewer
 *     on the project (uses ScriptApp.getOAuthToken() directly, same as
 *     Scheduled Job Reporting.js's Cloud Scheduler call — no impersonation
 *     needed here since the Cloud Logging API accepts plain OAuth access
 *     tokens, unlike the Cloud Run push endpoint triggerSync() hits).
 *     Grant via:
 *       gcloud projects add-iam-policy-binding wilderness-data \
 *         --member="user:YOUR_EMAIL@wilderness.co.nz" \
 *         --role="roles/logging.viewer"
 *   - Uses the "https://www.googleapis.com/auth/cloud-platform" OAuth scope
 *     already declared in appsscript.json (covers the Cloud Logging API too
 *     — no new scope needed).
 */

const PIPELINE_LOGS_SHEET          = 'Pipeline Logs';
const PIPELINE_LOGS_SERVICE_NAME   = 'wilderness-pipeline';
const PIPELINE_LOGS_LOOKBACK_HOURS = 24;
const PIPELINE_LOGS_MAX_PAGES      = 20; // safety cap: 20 x 1000-entry pages

function refreshPipelineLogs() {
  new PipelineLogsReporting().refresh();
}

var PipelineLogsReporting = function() {

  this.refresh = () => {
    const end   = new Date();
    const start = new Date(end.getTime() - PIPELINE_LOGS_LOOKBACK_HOURS * 60 * 60 * 1000);

    Logger.log(`[PipelineLogsReporting.refresh] fetching logs ${start.toISOString()} -> ${end.toISOString()}`);
    const entries = fetchLogEntries_(start, end);
    Logger.log(`[PipelineLogsReporting.refresh] fetched ${entries.length} raw log entries`);

    const rows = entries
      .filter(e => e.textPayload && PIPELINE_ACTIVITY_PATTERN_.test(e.textPayload))
      .map(e => [
        Utilities.formatDate(new Date(e.timestamp), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss'),
        e.textPayload,
      ]);

    Logger.log(`[PipelineLogsReporting.refresh] ${rows.length} entries matched job-activity pattern`);

    writeToSheet_(PIPELINE_LOGS_SHEET, ['timestamp', 'message'], rows);
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  const PIPELINE_ACTIVITY_PATTERN_ = /^\[[^\]]+\]/;

  function fetchLogEntries_(start, end) {
    const filter = [
      'resource.type="cloud_run_revision"',
      `resource.labels.service_name="${PIPELINE_LOGS_SERVICE_NAME}"`,
      `timestamp>="${start.toISOString()}"`,
      `timestamp<="${end.toISOString()}"`,
    ].join(' AND ');

    const entries = [];
    let pageToken = null;
    let page = 0;

    do {
      const body = {
        resourceNames: [`projects/${GCP_PROJECT_ID}`],
        filter,
        orderBy: 'timestamp asc',
        pageSize: 1000,
      };
      if (pageToken) body.pageToken = pageToken;

      const options = {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      };

      const response = UrlFetchApp.fetch('https://logging.googleapis.com/v2/entries:list', options);
      const code = response.getResponseCode();

      if (code === 401 || code === 403) {
        throw new Error(
          `Cloud Logging API auth failed (${code}). The Apps Script identity needs ` +
          `roles/logging.viewer on the project — see file header doc for the grant command.`
        );
      }
      if (code !== 200) {
        throw new Error(`Cloud Logging API error ${code}: ${response.getContentText()}`);
      }

      const data = JSON.parse(response.getContentText());
      entries.push(...(data.entries || []));
      pageToken = data.nextPageToken || null;
      page++;
    } while (pageToken && page < PIPELINE_LOGS_MAX_PAGES);

    return entries;
  }

  const writeToSheet_ = (sheetName, headers, data) => {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`[PipelineLogsReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[PipelineLogsReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumn(2);

    Logger.log(`[PipelineLogsReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};
