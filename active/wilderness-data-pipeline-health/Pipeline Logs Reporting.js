/**
 * @fileoverview Wilderness Pipeline — recent Cloud Run log viewer. Pulls
 * `wilderness-pipeline` Cloud Run logs directly from the Cloud Logging API
 * (NOT BigQuery — these are stdout/stderr logs, not a table this pipeline
 * writes to) for a rolling lookback window and writes the job-activity
 * lines to a sheet, so a run's recent behaviour can be inspected without a
 * terminal / `gcloud` access.
 *
 * LOG FORMAT (as of the wilderness-pipeline structured-logging change):
 * each app log line is a single JSON object on stdout/stderr, e.g.
 *   {"severity":"INFO","message":"Upserted 36 rows -> hs_rental_raw.tickets",
 *    "component":"BQWriter","runId":"a1b2c3d4-...","platform":"hs_rental",
 *    "table":"tickets","mode":"incremental"}
 * Cloud Run's logging agent promotes the top-level "severity" key to the
 * LogEntry's own `severity` field and puts the rest in `jsonPayload`.
 * `runId`/`platform`/`table`/`mode` are only present for lines logged
 * inside `withRunContext()` (i.e. an actual sync invocation, keyed to the
 * SAME platform/table/mode taxonomy as `pipeline.sync_runs` and the Cloud
 * Scheduler job's target URI) — a few call sites outside a run (webhook
 * receipt, maintenance sweep, startup) pass platform/table manually where
 * they have it, everything else (process startup, the concurrency-cap 503)
 * has none of the four. This is what makes it possible to answer "which
 * scheduled job do these lines belong to" — before this change, only lines
 * that happened to spell out the table name in their message text could be
 * attributed at all.
 *
 * LEGACY FALLBACK: any entry without a matching `jsonPayload.component`
 * falls back to matching the OLD plain-text convention this pipeline used
 * before structured logging (`"[Component] message"`, no platform/table/
 * mode/runId) — this keeps older log lines still inside the lookback
 * window (from before the pipeline's redeploy) visible in the sheet
 * instead of silently vanishing. Safe to delete this fallback once no
 * pre-migration lines remain in the lookback window.
 *
 * Sheet: "Pipeline Logs" (newest first)
 *   timestamp, severity, platform, table, mode, component, message, run_id,
 *   revision, last_refresh
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

    const rows = entries.map(extractRow_).filter(row => row !== null);

    Logger.log(`[PipelineLogsReporting.refresh] ${rows.length} entries matched job-activity pattern`);

    const headers = ['timestamp', 'severity', 'platform', 'table', 'mode', 'component', 'message', 'run_id', 'revision'];
    writeToSheet_(PIPELINE_LOGS_SHEET, headers, rows);
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  const LEGACY_COMPONENT_PATTERN_ = /^\[([^\]]+)\]\s*/;

  function extractRow_(e) {
    const timestamp = Utilities.formatDate(new Date(e.timestamp), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const severity  = e.severity || 'DEFAULT';
    const revision  = (e.resource && e.resource.labels && e.resource.labels.revision_name) || '';

    if (e.jsonPayload && e.jsonPayload.component) {
      const jp = e.jsonPayload;
      return [timestamp, severity, jp.platform || '', jp.table || '', jp.mode || '', jp.component, jp.message || '', jp.runId || '', revision];
    }

    if (e.textPayload) {
      const match = e.textPayload.match(LEGACY_COMPONENT_PATTERN_);
      if (match) {
        const component = match[1];
        const message = e.textPayload.slice(match[0].length);
        return [timestamp, severity, '', '', '', component, message, '', revision];
      }
    }

    return null;
  }

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
        orderBy: 'timestamp desc',
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
    sheet.autoResizeColumn(7);

    Logger.log(`[PipelineLogsReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};
