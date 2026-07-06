/**
 * @fileoverview Wilderness Pipeline — 429 (rate-limit) event viewer. Pulls
 * recent `core/httpUtils.js` rate-limit warnings directly from the Cloud
 * Logging API (NOT BigQuery — nothing in the pipeline writes 429
 * occurrences to a table today; this is the only place they're visible at
 * all besides raw `gcloud logging read`) for a rolling lookback window,
 * covering BOTH the wilderness-pipeline Cloud Run Service and the
 * wilderness-pipeline-job Cloud Run Job (added 2026-07-06 for the 16
 * reconciliation targets — see CLAUDE.md's "Cloud Run JOB for long-running
 * targets" section) — httpUtils.js's rate limiting applies to both.
 *
 * This is a GAS-side stopgap, not the long-term home for this data: this
 * project's convention is business logic living in BigQuery views, not
 * hand-rolled Cloud Logging queries in Apps Script (see every other
 * reporting file). The preferred long-term fix is for the pipeline itself
 * to write 429 occurrences to BigQuery (e.g. a `pipeline.alerts` row or a
 * dedicated table) so this could be a normal `SELECT * FROM
 * reporting.health_rate_limit_events`-style view like everything else —
 * that requires a change in the separate wilderness-pipeline codebase,
 * which is out of scope here. Revisit once that's done; this file's
 * fetchLogEntries_()/extractRow_() should then be deletable entirely.
 *
 * Also directly relevant: CLAUDE.md's "Locking / concurrency" gotchas note
 * that cross-process rate limiters (Service instance vs Job execution)
 * can't see each other — this sheet is the monitoring half of that
 * accepted risk, not a fix for it. A spike here after the Job split is
 * expected to some degree; a SUSTAINED high rate is the actual signal to
 * look for.
 *
 * LOG FORMAT: same structured JSON convention as Pipeline Logs Reporting.js
 * — httpUtils.js logs `{"severity":"WARNING","message":"429 rate limited —
 * waiting Xs before retry","component":"httpUtils",...}`, with
 * platform/table/mode/runId present when the call happened inside a sync
 * run's context (see withRunContext() in the pipeline repo). Matched via
 * Cloud Logging's `:` substring query operator on jsonPayload.message
 * rather than an exact match, so wording tweaks in the pipeline's log
 * message don't silently break this sheet.
 *
 * Sheet: "Health - Rate Limit Events" (newest first)
 *   timestamp, source, platform, table, mode, wait_seconds, message, run_id,
 *   revision_or_execution, last_refresh
 *
 * Requires:
 *   - GCP_PROJECT_ID declared in its own file (shared global scope)
 *   - roles/logging.viewer on the project (same grant Pipeline Logs
 *     Reporting.js already needs — no new IAM grant required if that's
 *     already in place). Uses ScriptApp.getOAuthToken() directly, no
 *     impersonation needed (Cloud Logging API accepts plain OAuth access
 *     tokens).
 */

const RATE_LIMIT_SHEET           = 'Health - Rate Limit Events';
const RATE_LIMIT_SERVICE_NAME    = 'wilderness-pipeline';
const RATE_LIMIT_JOB_NAME        = 'wilderness-pipeline-job';
const RATE_LIMIT_LOOKBACK_HOURS  = 24;
const RATE_LIMIT_MAX_PAGES       = 20; // safety cap: 20 x 1000-entry pages

function refreshRateLimitEvents() {
  new RateLimitReporting().refresh();
}

var RateLimitReporting = function() {

  this.refresh = () => {
    const end   = new Date();
    const start = new Date(end.getTime() - RATE_LIMIT_LOOKBACK_HOURS * 60 * 60 * 1000);

    Logger.log(`[RateLimitReporting.refresh] fetching 429 events ${start.toISOString()} -> ${end.toISOString()}`);
    const entries = fetchRateLimitEntries_(start, end);
    Logger.log(`[RateLimitReporting.refresh] fetched ${entries.length} matching log entries`);

    const rows = entries.map(extractRow_).filter(row => row !== null);

    const headers = ['timestamp', 'source', 'platform', 'table', 'mode', 'wait_seconds', 'message', 'run_id', 'revision_or_execution'];
    writeToSheet_(RATE_LIMIT_SHEET, headers, rows);
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  const WAIT_SECONDS_PATTERN_ = /waiting\s+([\d.]+)\s*s/i;

  function extractRow_(e) {
    const timestamp = Utilities.formatDate(new Date(e.timestamp), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const isJob = e.resource && e.resource.type === 'cloud_run_job';
    const source = isJob ? 'Job' : 'Service';
    const revisionOrExecution = isJob
      ? ((e.labels && e.labels['run.googleapis.com/execution_name']) || '')
      : ((e.resource && e.resource.labels && e.resource.labels.revision_name) || '');

    const message = (e.jsonPayload && e.jsonPayload.message) || e.textPayload || '';
    const waitMatch = message.match(WAIT_SECONDS_PATTERN_);
    const waitSeconds = waitMatch ? waitMatch[1] : '';

    if (e.jsonPayload) {
      const jp = e.jsonPayload;
      return [timestamp, source, jp.platform || '', jp.table || '', jp.mode || '', waitSeconds, message, jp.runId || '', revisionOrExecution];
    }

    return [timestamp, source, '', '', '', waitSeconds, message, '', revisionOrExecution];
  }

  function fetchRateLimitEntries_(start, end) {
    const filter = [
      '(' +
        `(resource.type="cloud_run_revision" AND resource.labels.service_name="${RATE_LIMIT_SERVICE_NAME}")` +
        ' OR ' +
        `(resource.type="cloud_run_job" AND resource.labels.job_name="${RATE_LIMIT_JOB_NAME}")` +
      ')',
      'jsonPayload.message:"429 rate limited"',
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
    } while (pageToken && page < RATE_LIMIT_MAX_PAGES);

    return entries;
  }

  const writeToSheet_ = (sheetName, headers, data) => {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`[RateLimitReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[RateLimitReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[RateLimitReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};
