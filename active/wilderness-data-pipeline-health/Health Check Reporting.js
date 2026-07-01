/**
 * @fileoverview Wilderness Pipeline Health Check Dashboard — pulls from
 * BigQuery health views into Google Sheets for at-a-glance monitoring of
 * every sync target across all connectors (HubSpot Rental, HubSpot Retail,
 * Fleetio, and any future platform).
 *
 * Sheets:
 *   "Health - Current Status"        → one row per sync target: last run
 *                                       outcome, cursor age, lock state,
 *                                       and whether it's overdue against
 *                                       its expected schedule (is_stale)
 *   "Health - Recent Errors"         → last 50 error-status sync runs
 *   "Health - Unacknowledged Alerts" → unacknowledged pipeline.alerts rows
 *
 * Additional functionality:
 *   - runHealthCheckDigest(email) — refreshes the dashboard and sends an
 *     email ONLY if something needs attention (error, stale schedule, or
 *     stale lock). Silent when healthy. Wire up via a time-driven Apps
 *     Script trigger (Triggers UI → this function → time-driven).
 *   - triggerSync(platform, table) — manually re-run a sync target from
 *     a sheet/menu without constructing a curl command by hand. Requires
 *     the Apps Script identity to have Cloud Run Invoker on the
 *     wilderness-pipeline service (see function doc for the IAM command).
 *
 * Requires:
 *   - BigQueryLibrary linked as a library
 *   - BigQuery Advanced Service enabled
 *   - GCP_PROJECT_ID declared in its own file (shared global scope)
 *
 * All business logic (joining sync_runs with sync_cursors, NZT conversion,
 * staleness thresholds) lives in the BigQuery views — not here. This
 * script is a thin consumer only. Same architectural pattern as
 * DealsReporting.gs and WorkOrdersReporting.gs.
 *
 * Data lives in australia-southeast1.
 */

function refreshHealthCheck()            { new HealthCheckReporting().refresh(); }
function refreshHealthCurrentStatus()     { new HealthCheckReporting().refreshCurrentStatus(); }
function refreshHealthRecentErrors()      { new HealthCheckReporting().refreshRecentErrors(); }
function refreshHealthUnackedAlerts()     { new HealthCheckReporting().refreshUnacknowledgedAlerts(); }
function refreshHealthVolumeTrends()      { new HealthCheckReporting().refreshVolumeTrends(); }
function refreshHealthVolumeTrendsChart() { new HealthCheckReporting().refreshVolumeTrendsChart(); }
function refreshHealthPerformanceMetrics() { new HealthCheckReporting().refreshPerformanceMetrics(); }
function refreshHealthVolumeAnomalies() { new HealthCheckReporting().refreshVolumeAnomalies(); }

/**
 * Acknowledge a specific pipeline.alerts row by ID.
 * @param {string} alertId
 */
function acknowledgeAlert(alertId) {
  new HealthCheckReporting().acknowledgeAlert(alertId);
}

/**
 * Acknowledge the alert in whichever row is currently selected in the
 * "Health - Unacknowledged Alerts" sheet. Click a cell in the row you
 * want to acknowledge, then run this function — e.g. assign it to a
 * keyboard shortcut (Extensions > Macros > Import, or Tools > Macros)
 * or a custom menu item for one-click acknowledgement.
 */
function acknowledgeSelectedAlert() {
  new HealthCheckReporting().acknowledgeSelectedAlert();
}

/**
 * Acknowledge EVERY currently-unacknowledged alert at once. Use with
 * intent — make sure each one has actually been reviewed (or is a known,
 * accepted non-issue) before bulk-clearing, not as a way to silence the
 * sheet without looking at what's in it.
 */
function acknowledgeAllAlerts() {
  new HealthCheckReporting().acknowledgeAllAlerts();
}

/**
 * Run on a daily (or more frequent) time-based trigger. Refreshes the
 * dashboard, then sends a digest email ONLY if something needs attention
 * (errors, stale tables, or stale locks) — silent otherwise. Set up the
 * trigger via Apps Script's Triggers UI: choose this function, time-driven,
 * whatever cadence makes sense (e.g. every 6 hours).
 *
 * @param {string} recipientEmail - who to email when something's wrong
 */
function runHealthCheckDigest(recipientEmail) {
  new HealthCheckReporting().runDigest(recipientEmail);
}

/**
 * No-arg wrapper for time-driven triggers. Apps Script calls a
 * time-triggered function with ZERO arguments — pointing a trigger
 * directly at runHealthCheckDigest(recipientEmail) would call it with
 * recipientEmail === undefined, and MailApp.sendEmail({to: undefined})
 * fails. Point the Triggers UI at THIS function instead, with your real
 * email hardcoded below.
 */
function runHealthCheckDigestScheduled() {
  runHealthCheckDigest('mark.lonergan@wilderness.co.nz');
}

/**
 * Manually trigger a sync for a given platform/table via the Cloud Run
 * endpoint, without needing to construct a curl command by hand. Requires
 * an OIDC ID token audienced to the exact target URL — Cloud Run's auth
 * check rejects a plain OAuth access token (confirmed empirically, not
 * just a theoretical caveat). The calling identity mints one on demand by
 * impersonating wilderness-pipeline-sa (which already has Cloud Run
 * Invoker) via the IAM Credentials API — see mintIdToken_() in
 * HealthCheckReporting for the full mechanism. This requires the calling
 * identity to have roles/iam.serviceAccountTokenCreator on
 * wilderness-pipeline-sa — set this up once in IAM if calls fail with
 * 401/403 quoting a token-minting error.
 *
 * NOTE on timing: routes/scheduled.js responds with {"status":"accepted",...}
 * IMMEDIATELY, before the actual sync work runs — the sync itself happens
 * asynchronously server-side after the response is already sent. This
 * means this function returns quickly (well under Apps Script's 6-minute
 * execution limit) regardless of how long the underlying sync actually
 * takes (some targets — tickets_associations, emails_associations — run
 * for many minutes server-side). The returned "accepted" response does
 * NOT mean the sync has finished, only that it started — check the
 * Health dashboard a few minutes later to confirm actual completion for
 * longer-running targets.
 *
 * @param {string} platform - e.g. 'hs-rental', 'fleetio'
 * @param {string} table    - e.g. 'deals_associations', 'work_orders'
 * @returns {string} response body or error description
 */
function triggerSync(platform, table) {
  return new HealthCheckReporting().triggerSync(platform, table);
}

/**
 * Convenience wrappers for every sync target across both connectors —
 * one-click re-run from the Apps Script editor (Run menu) or a custom
 * menu/button, without typing platform/table each time.
 *
 * HubSpot Rental — 10 base targets + 6 association targets (16 total).
 * Fleetio — 1 target (work_orders); its 3 child tables
 * (work_order_line_items, work_order_sub_line_items,
 * work_order_labor_time_entries) are written together within the
 * work_orders run itself and are not independently triggerable — see
 * PipelineRunner's childTables handling.
 *
 * Separately, most of the above also have a weekly RECONCILIATION
 * counterpart — a "<table>_reconciliation" sync target, run on its own
 * Cloud Scheduler cron (see Scheduled Job Reporting.js), that re-checks
 * everything rather than just what's changed since the last cursor, to
 * catch anything an incremental sync silently missed. 8 base + 6
 * association + 1 fleetio = 15 total (owners and pipelines are small
 * reference tables and have no reconciliation job).
 *
 * Add a new wrapper here whenever a new connector/target is added
 * (HubSpot Retail, Xero, etc.) to keep this list current.
 */

// HubSpot Rental — base targets
function triggerDeals()        { triggerSync('hs-rental', 'deals'); }
function triggerContacts()     { triggerSync('hs-rental', 'contacts'); }
function triggerTickets()      { triggerSync('hs-rental', 'tickets'); }
function triggerTasks()        { triggerSync('hs-rental', 'tasks'); }
function triggerCalls()        { triggerSync('hs-rental', 'calls'); }
function triggerEmails()       { triggerSync('hs-rental', 'emails'); }
function triggerMeetings()     { triggerSync('hs-rental', 'meetings'); }
function triggerEngagements()  { triggerSync('hs-rental', 'engagements'); }
function triggerOwners()       { triggerSync('hs-rental', 'owners'); }
function triggerPipelines()    { triggerSync('hs-rental', 'pipelines'); }

// HubSpot Rental — association targets
function triggerDealsAssociations()    { triggerSync('hs-rental', 'deals_associations'); }
function triggerTicketsAssociations()  { triggerSync('hs-rental', 'tickets_associations'); }
function triggerTasksAssociations()    { triggerSync('hs-rental', 'tasks_associations'); }
function triggerCallsAssociations()    { triggerSync('hs-rental', 'calls_associations'); }
function triggerEmailsAssociations()   { triggerSync('hs-rental', 'emails_associations'); }
function triggerMeetingsAssociations() { triggerSync('hs-rental', 'meetings_associations'); }

// Fleetio
function triggerWorkOrders() { triggerSync('fleetio', 'work_orders'); }

// HubSpot Rental — base reconciliation targets
function triggerDealsReconciliation()       { triggerSync('hs-rental', 'deals_reconciliation'); }
function triggerContactsReconciliation()    { triggerSync('hs-rental', 'contacts_reconciliation'); }
function triggerTicketsReconciliation()     { triggerSync('hs-rental', 'tickets_reconciliation'); }
function triggerTasksReconciliation()       { triggerSync('hs-rental', 'tasks_reconciliation'); }
function triggerCallsReconciliation()       { triggerSync('hs-rental', 'calls_reconciliation'); }
function triggerEmailsReconciliation()      { triggerSync('hs-rental', 'emails_reconciliation'); }
function triggerMeetingsReconciliation()    { triggerSync('hs-rental', 'meetings_reconciliation'); }
function triggerEngagementsReconciliation() { triggerSync('hs-rental', 'engagements_reconciliation'); }

// HubSpot Rental — association reconciliation targets
function triggerDealsAssociationsReconciliation()    { triggerSync('hs-rental', 'deals_associations_reconciliation'); }
function triggerTicketsAssociationsReconciliation()  { triggerSync('hs-rental', 'tickets_associations_reconciliation'); }
function triggerTasksAssociationsReconciliation()    { triggerSync('hs-rental', 'tasks_associations_reconciliation'); }
function triggerCallsAssociationsReconciliation()    { triggerSync('hs-rental', 'calls_associations_reconciliation'); }
function triggerEmailsAssociationsReconciliation()   { triggerSync('hs-rental', 'emails_associations_reconciliation'); }
function triggerMeetingsAssociationsReconciliation() { triggerSync('hs-rental', 'meetings_associations_reconciliation'); }

// Fleetio — reconciliation
function triggerWorkOrdersReconciliation() { triggerSync('fleetio', 'work_orders_reconciliation'); }

/**
 * Trigger every HubSpot Rental base target, one at a time with a short
 * pause between each. Since triggerSync() returns immediately (the
 * underlying sync runs async server-side — see triggerSync() doc), this
 * function itself completes quickly even though the actual syncs continue
 * running for some time afterward. The pause between triggers is to
 * avoid firing 10 requests in the same instant and creating unnecessary
 * Cloud Run cold-start/concurrency pressure, not to wait for completion.
 */
function triggerAllRentalBase() {
  const targets = ['deals', 'contacts', 'tickets', 'tasks', 'calls', 'emails', 'meetings', 'engagements', 'owners', 'pipelines'];
  targets.forEach(table => {
    Logger.log(`[triggerAllRentalBase] triggering ${table}`);
    triggerSync('hs-rental', table);
    Utilities.sleep(2000);
  });
}

/**
 * Trigger every HubSpot Rental association target, one at a time. Same
 * "fire and forget" behavior as triggerAllRentalBase() — returns quickly,
 * but the underlying syncs (some take 10-25+ minutes) continue running
 * server-side afterward. Check the Health dashboard a few minutes later
 * to confirm completion.
 */
function triggerAllRentalAssociations() {
  const targets = ['deals_associations', 'tickets_associations', 'tasks_associations', 'calls_associations', 'emails_associations', 'meetings_associations'];
  targets.forEach(table => {
    Logger.log(`[triggerAllRentalAssociations] triggering ${table}`);
    triggerSync('hs-rental', table);
    Utilities.sleep(2000);
  });
}

var HealthCheckReporting = function() {

  const STATUS_SHEET = 'Health - Current Status';
  const ERRORS_SHEET = 'Health - Recent Errors';
  const ALERTS_SHEET = 'Health - Unacknowledged Alerts';
  const TRENDS_SHEET = 'Health - Volume Trends';
  const PIVOT_SHEET = 'Health - Volume Trends Chart';
  const PERFORMANCE_SHEET = 'Health - Performance Metrics';
  const ANOMALIES_SHEET = 'Health - Volume Anomalies';

  // ── SQL ────────────────────────────────────────────────────────────────────

  const STATUS_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_current_status\`
  `;

  const ERRORS_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_recent_errors\`
  `;

  const ALERTS_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_unacknowledged_alerts\`
  `;

  const TRENDS_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_volume_trends\`
  `;

  const PIVOT_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_volume_trends_pivot\`
  `;

  const PERFORMANCE_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_performance_metrics\`
  `;

  const ANOMALIES_SQL = `
    SELECT *
    FROM \`wilderness-data.reporting.health_volume_anomalies\`
  `;

  // ── Public methods ─────────────────────────────────────────────────────────

  this.refresh = () => {
    Logger.log('[HealthCheckReporting.refresh] starting full refresh');
    this.refreshCurrentStatus();
    this.refreshRecentErrors();
    this.refreshUnacknowledgedAlerts();
    this.refreshVolumeTrends();
    this.refreshVolumeTrendsChart();
    this.refreshPerformanceMetrics();
    this.refreshVolumeAnomalies();
    Logger.log('[HealthCheckReporting.refresh] complete');
  };

  this.refreshCurrentStatus = () => {
    Logger.log('[HealthCheckReporting.refreshCurrentStatus] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      STATUS_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[HealthCheckReporting.refreshCurrentStatus] rows=${res.totalRows}`);
    writeToSheet_(STATUS_SHEET, res.headers, res.data);
    applyStatusFormatting_(STATUS_SHEET, res.headers);
  };

  this.refreshRecentErrors = () => {
    Logger.log('[HealthCheckReporting.refreshRecentErrors] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      ERRORS_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[HealthCheckReporting.refreshRecentErrors] rows=${res.totalRows}`);
    writeToSheet_(ERRORS_SHEET, res.headers, res.data);
  };

  this.refreshUnacknowledgedAlerts = () => {
    Logger.log('[HealthCheckReporting.refreshUnacknowledgedAlerts] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      ALERTS_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[HealthCheckReporting.refreshUnacknowledgedAlerts] rows=${res.totalRows}`);
    writeToSheet_(ALERTS_SHEET, res.headers, res.data);
  };

  /**
   * Mark a specific pipeline.alerts row as acknowledged, by alert_id.
   * There is no Google Cloud Console UI for pipeline.alerts (it's a
   * table this pipeline created itself, not a Cloud Monitoring
   * resource) — this is the only way to acknowledge one short of
   * running a raw bq query by hand.
   *
   * @param {string} alertId
   */
  this.acknowledgeAlert = (alertId) => {
    Logger.log(`[HealthCheckReporting.acknowledgeAlert] acknowledging alert_id=${alertId}`);

    const sql = `
      UPDATE \`wilderness-data.pipeline.alerts\`
      SET acknowledged = TRUE
      WHERE alert_id = @alertId
    `;

    BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      sql,
      {
        location: 'australia-southeast1',
        params: { alertId },
      }
    );

    Logger.log(`[HealthCheckReporting.acknowledgeAlert] done — refreshing alerts sheet`);
    this.refreshUnacknowledgedAlerts();
  };

  /**
   * Acknowledge the alert in whichever row is currently selected in the
   * "Health - Unacknowledged Alerts" sheet — click any cell in the row
   * you want to acknowledge, then run this function (e.g. via a custom
   * menu item or keyboard shortcut), rather than having to look up and
   * type the alert_id manually.
   *
   * Only works when the active sheet IS the alerts sheet and a row with
   * a real alert_id is selected — logs and exits cleanly otherwise
   * rather than acknowledging the wrong thing.
   */
  this.acknowledgeSelectedAlert = () => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();

    if (sheet.getName() !== ALERTS_SHEET) {
      Logger.log(
        `[HealthCheckReporting.acknowledgeSelectedAlert] active sheet is ` +
        `"${sheet.getName()}", not "${ALERTS_SHEET}" — select a row in the ` +
        `alerts sheet first`
      );
      return;
    }

    const activeRow = sheet.getActiveRange().getRow();
    if (activeRow < 2) {
      Logger.log('[HealthCheckReporting.acknowledgeSelectedAlert] header row selected — select a data row');
      return;
    }

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const alertIdCol = headers.indexOf('alert_id') + 1;

    if (alertIdCol === 0) {
      Logger.log('[HealthCheckReporting.acknowledgeSelectedAlert] no alert_id column found');
      return;
    }

    const alertId = sheet.getRange(activeRow, alertIdCol).getValue();
    if (!alertId) {
      Logger.log(`[HealthCheckReporting.acknowledgeSelectedAlert] no alert_id value in row ${activeRow}`);
      return;
    }

    this.acknowledgeAlert(String(alertId));
  };

  /**
   * Acknowledge EVERY currently-unacknowledged alert in one call —
   * single UPDATE with no WHERE alert_id filter (just acknowledged =
   * FALSE), rather than looping acknowledgeAlert() once per row, which
   * would mean one BigQuery UPDATE per alert. Refreshes the alerts sheet
   * afterward, which should then show zero rows.
   *
   * Use deliberately, not routinely — acknowledging clears them from the
   * sheet and the digest email's alert count, but doesn't fix whatever
   * caused them. Make sure each one has actually been looked at /
   * resolved (or is a known, accepted non-issue) before bulk-clearing,
   * same judgement call as acknowledging any single alert, just applied
   * to all of them at once.
   */
  this.acknowledgeAllAlerts = () => {
    Logger.log('[HealthCheckReporting.acknowledgeAllAlerts] acknowledging all unacknowledged alerts...');

    const sql = `
      UPDATE \`wilderness-data.pipeline.alerts\`
      SET acknowledged = TRUE
      WHERE acknowledged = FALSE
    `;

    BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      sql,
      { location: 'australia-southeast1' }
    );

    Logger.log('[HealthCheckReporting.acknowledgeAllAlerts] done — refreshing alerts sheet');
    this.refreshUnacknowledgedAlerts();
  };

  /**
   * Refresh the volume trends sheet — daily rows_written + run outcome
   * counts per table for the last 30 days. Two signals in one sheet:
   * data volume (rows_written) and reliability (error/skipped counts) —
   * see the view's own doc comment for why these are kept together
   * rather than split into two separate sheets.
   */
  this.refreshVolumeTrends = () => {
    Logger.log('[HealthCheckReporting.refreshVolumeTrends] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      TRENDS_SQL,
      { location: 'australia-southeast1', maxRows: 10000 }
    );
    Logger.log(`[HealthCheckReporting.refreshVolumeTrends] rows=${res.totalRows}`);
    writeToSheet_(TRENDS_SHEET, res.headers, res.data);
    applyTrendsFormatting_(TRENDS_SHEET, res.headers);
  };

  /**
   * Refresh the pivoted data behind the Volume Trends chart, and create
   * the chart itself if it doesn't exist yet. The chart is created ONCE
   * and bound to a fixed range — since the pivot view always returns the
   * same columns (run_date + the same fixed list of table names, see the
   * view's own doc comment), only the data inside that range changes on
   * each refresh, not the range's shape. This is what lets the chart
   * stay correctly bound across repeated refreshes rather than needing
   * to be deleted and recreated each time (which is what happens if you
   * try to chart a sheet whose column count/order changes between
   * refreshes — Sheets charts bind to a range, not to column names).
   *
   * Deliberately does NOT append a last_refresh column here (unlike
   * every other sheet) — adding a column would shift the chart's bound
   * range and break it on the next data-only refresh otherwise tolerant
   * of changing values within the same shape.
   */
  this.refreshVolumeTrendsChart = () => {
    Logger.log('[HealthCheckReporting.refreshVolumeTrendsChart] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      PIVOT_SQL,
      { location: 'australia-southeast1', maxRows: 10000 }
    );
    Logger.log(`[HealthCheckReporting.refreshVolumeTrendsChart] rows=${res.totalRows}`);

    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(PIVOT_SHEET);
    const isNewSheet = !sheet;

    if (!sheet) {
      sheet = ss.insertSheet(PIVOT_SHEET);
      Logger.log(`[HealthCheckReporting.refreshVolumeTrendsChart] created sheet=${PIVOT_SHEET}`);
    }

    sheet.clearContents();

    const headers = res.headers;
    const data = res.data || [];

    if (data.length === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      Logger.log('[HealthCheckReporting.refreshVolumeTrendsChart] no data returned');
      return;
    }

    const output = [headers, ...data];
    sheet.getRange(1, 1, output.length, headers.length).setValues(output);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    // Title reflects the ACTUAL date range present in the data, not a
    // hardcoded "last 30 days" — the view requests a 30-day window, but
    // if the pipeline itself has only been running for a few days, the
    // real range is much shorter. A hardcoded label would be misleading
    // (e.g. claiming 30 days of trend when only 3 days of history
    // actually exist). run_date is always the first column (see the
    // pivot view's SELECT order).
    const dates = data.map(row => row[0]).filter(Boolean);
    const earliestDate = dates.length ? dates[0] : null;
    const latestDate = dates.length ? dates[dates.length - 1] : null;
    const dateRangeLabel = (earliestDate && latestDate)
      ? `${earliestDate} to ${latestDate}`
      : 'no data yet';
    const chartTitle = `Daily rows written — top 10 tables by volume (${dateRangeLabel})`;

    // Create the chart only once — on every later refresh, the existing
    // chart (bound to this same range) just picks up the new values
    // automatically. Checking for an existing chart first avoids
    // duplicating it on every refresh. The TITLE is still updated on
    // every refresh though (via chart.modify(), not just on creation),
    // since the actual date range grows over time even after the chart
    // itself already exists.
    const existingCharts = sheet.getCharts();
    if (existingCharts.length === 0) {
      const chartRange = sheet.getRange(1, 1, output.length, headers.length);
      const chart = sheet.newChart()
        .setChartType(Charts.ChartType.LINE)
        .addRange(chartRange)
        .setPosition(1, headers.length + 2, 0, 0)
        .setOption('title', chartTitle)
        .setOption('width', 1000)
        .setOption('height', 500)
        .setOption('hAxis', { title: 'Date' })
        .setOption('vAxis', { title: 'Rows written' })
        .build();
      sheet.insertChart(chart);
      Logger.log('[HealthCheckReporting.refreshVolumeTrendsChart] chart created');
    } else {
      // Re-set the same range explicitly in case the row COUNT changed
      // (more days of history accumulating over time) — the chart's
      // bound range needs to grow to include new rows, even though
      // column shape stays fixed. Also re-set the title to reflect the
      // current actual date range.
      const chart = existingCharts[0];
      const chartRange = sheet.getRange(1, 1, output.length, headers.length);
      const updatedChart = chart.modify()
        .clearRanges()
        .addRange(chartRange)
        .setOption('title', chartTitle)
        .build();
      sheet.updateChart(updatedChart);
      Logger.log('[HealthCheckReporting.refreshVolumeTrendsChart] chart range updated');
    }
  };

  /**
   * Refresh the performance metrics sheet — avg/max/min run duration and
   * error rate per target, last 7 days. Distinct from Volume Trends
   * (which is per-DAY); this is a single summary row per target, the
   * more direct view for "which targets are slow or unreliable right
   * now" rather than a day-by-day history.
   */
  this.refreshPerformanceMetrics = () => {
    Logger.log('[HealthCheckReporting.refreshPerformanceMetrics] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      PERFORMANCE_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[HealthCheckReporting.refreshPerformanceMetrics] rows=${res.totalRows}`);
    writeToSheet_(PERFORMANCE_SHEET, res.headers, res.data);
    applyPerformanceFormatting_(PERFORMANCE_SHEET, res.headers);
  };

  /**
   * Refresh the volume anomalies sheet — compares each target's most
   * recent successful run's rows_fetched against its own trailing
   * 14-day average. This is the early-warning signal for the exact
   * incident class that caused the original tickets cursor deadlock (a
   * recurring HubSpot workflow touching nearly the whole table at once
   * produces a sudden multi-x spike in rows_fetched, visible here LONG
   * before it becomes a 10k-limit/timeout failure visible in Current
   * Status or Recent Errors). See the view's own doc comment for the 3x
   * threshold reasoning.
   */
  this.refreshVolumeAnomalies = () => {
    Logger.log('[HealthCheckReporting.refreshVolumeAnomalies] querying BigQuery...');
    const res = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      ANOMALIES_SQL,
      { location: 'australia-southeast1' }
    );
    Logger.log(`[HealthCheckReporting.refreshVolumeAnomalies] rows=${res.totalRows}`);
    writeToSheet_(ANOMALIES_SHEET, res.headers, res.data);
    applyAnomalyFormatting_(ANOMALIES_SHEET, res.headers);
  };

  /**
   * Refresh the dashboard, then send a digest email ONLY if something
   * needs attention: any row with last_run_status = 'error', is_stale =
   * true, or has_stale_lock = true, OR any unacknowledged alert, OR any
   * volume anomaly. Silent (no email) when everything is healthy —
   * avoids digest fatigue from a daily "all good" email nobody reads.
   *
   * UPDATED (Claude Code, post-2026-06-28): sends a styled HTML email
   * (color-coded tables per issue type) with a plain-text fallback in
   * the same message (both `body` and `htmlBody` set on
   * MailApp.sendEmail — clients that can't render HTML fall back to
   * `body` automatically). The HTML row colors deliberately reuse the
   * SAME hex values as the sheet's own applyStatusFormatting_() (see
   * ROW_COLORS below) so the email visually matches what you'd see by
   * opening the dashboard — error red, stale-lock amber, stale-schedule
   * yellow — same priority order too (error > stale lock > stale, most
   * severe wins if a row matches more than one condition). Originally
   * (pre-2026-06-28) this only sent a plain-text email; kept the
   * plain-text body as a genuine fallback rather than dropping it, since
   * some mail clients/filters still prefer or require it.
   *
   * @param {string} recipientEmail
   */
  this.runDigest = (recipientEmail) => {
    Logger.log('[HealthCheckReporting.runDigest] starting...');
    this.refresh();

    const statusRes = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      STATUS_SQL,
      { location: 'australia-southeast1', returnObjects: true }
    );
    const alertsRes = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      ALERTS_SQL,
      { location: 'australia-southeast1', returnObjects: true }
    );
    const anomaliesRes = BigQueryLibrary.runQuery_V2(
      GCP_PROJECT_ID,
      ANOMALIES_SQL,
      { location: 'australia-southeast1', returnObjects: true }
    );

    const problemRows  = (statusRes.rows || []).filter(row =>
      row.last_run_status === 'error' || row.is_stale === true || row.has_stale_lock === true
    );
    const alertRows    = alertsRes.rows || [];
    const anomalyRows  = (anomaliesRes.rows || []).filter(row => row.is_anomaly === true);

    if (problemRows.length === 0 && alertRows.length === 0 && anomalyRows.length === 0) {
      Logger.log('[HealthCheckReporting.runDigest] all healthy — no email sent');
      return;
    }

    const dashboardUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
    const ts = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm z');

    // ── HTML email ──────────────────────────────────────────────────────────
    // Small inline helpers rather than a templating library — this is
    // simple enough (a handful of bordered table cells) that pulling in
    // a dependency would be overkill for Apps Script.
    const cell = (text, bold) =>
      `<td style="padding:6px 10px;border:1px solid #ddd;${bold ? 'font-weight:bold;' : ''}">${text ?? ''}</td>`;

    const headerRow = (cols) =>
      `<tr style="background:#f5f5f5;font-weight:bold;">${cols.map(c => `<th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">${c}</th>`).join('')}</tr>`;

    // Same hex values as applyStatusFormatting_()'s sheet highlighting —
    // keep these two in sync if either changes, so the email and the
    // sheet never visually disagree about what "error" / "stale lock" /
    // "stale" look like.
    const ROW_COLORS = { error: '#f4cccc', stale_lock: '#fce5cd', stale: '#fff2cc' };

    let html = `
<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#333;max-width:900px;">
<h2 style="color:#c0392b;">⚠ Wilderness Pipeline — ${problemRows.length + alertRows.length + anomalyRows.length} issue(s) found</h2>
<p style="color:#666;">${ts}</p>
<p>
  <b>${problemRows.length}</b> target(s) needing attention &nbsp;·&nbsp;
  <b>${alertRows.length}</b> unacknowledged alert(s) &nbsp;·&nbsp;
  <b>${anomalyRows.length}</b> volume anomal${anomalyRows.length === 1 ? 'y' : 'ies'}
</p>`;

    if (problemRows.length > 0) {
      html += `<h3 style="margin-top:24px;">Sync targets needing attention</h3>
<table style="border-collapse:collapse;width:100%;">
  ${headerRow(['Table', 'Last status', 'Stale?', 'Stale lock?', 'Last run (min ago)', 'Expected within (min)', 'Error'])}`;

      problemRows.forEach(row => {
        // Same priority order as applyStatusFormatting_(): error beats
        // stale lock beats stale, since a row can technically match more
        // than one condition and the most severe should win visually.
        let bg = '#ffffff';
        if (row.last_run_status === 'error')  bg = ROW_COLORS.error;
        else if (row.has_stale_lock === true) bg = ROW_COLORS.stale_lock;
        else if (row.is_stale === true)       bg = ROW_COLORS.stale;

        html += `<tr style="background:${bg};">
  ${cell(`${row.dataset}.${row.table_name}`, true)}
  ${cell(row.last_run_status ?? '—')}
  ${cell(row.is_stale ? 'Yes' : 'No')}
  ${cell(row.has_stale_lock ? 'Yes' : 'No')}
  ${cell(row.minutes_since_last_run ?? '—')}
  ${cell(row.expected_max_staleness_minutes ?? '—')}
  ${cell(row.error_message ?? '')}
</tr>`;
      });

      html += `</table>`;
    }

    if (anomalyRows.length > 0) {
      html += `<h3 style="margin-top:24px;">Volume anomalies</h3>
<p style="color:#666;font-size:12px;">rows_fetched on most recent run vs trailing 14-day average — same class as the original tickets incident</p>
<table style="border-collapse:collapse;width:100%;">
  ${headerRow(['Table', 'Recent rows', 'Trailing avg', 'Ratio'])}`;

      anomalyRows.forEach(row => {
        html += `<tr style="background:${ROW_COLORS.error};">
  ${cell(row.sync_name, true)}
  ${cell(row.most_recent_rows_fetched)}
  ${cell(row.trailing_avg_rows_fetched)}
  ${cell(row.anomaly_ratio + 'x')}
</tr>`;
      });

      html += `</table>`;
    }

    if (alertRows.length > 0) {
      html += `<h3 style="margin-top:24px;">Unacknowledged alerts</h3>
<table style="border-collapse:collapse;width:100%;">
  ${headerRow(['Severity', 'Platform / table', 'Message'])}`;

      alertRows.forEach(row => {
        // 'critical' alerts get the same red as errors; anything else
        // (e.g. 'warning') gets the milder stale-schedule yellow rather
        // than its own third color, to keep the palette to the same
        // three severities used everywhere else in this dashboard.
        const bg = row.severity === 'critical' ? ROW_COLORS.error : ROW_COLORS.stale;
        html += `<tr style="background:${bg};">
  ${cell(row.severity, true)}
  ${cell(`${row.platform}/${row.sync_name}`)}
  ${cell(row.message)}
</tr>`;
      });

      html += `</table>`;
    }

    html += `
<p style="margin-top:24px;">
  <a href="${dashboardUrl}" style="background:#4285f4;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Dashboard</a>
</p>
</body></html>`;

    // Plain-text fallback for clients that don't render HTML — sent
    // alongside htmlBody in the same MailApp.sendEmail call below, not
    // as a separate email.
    const plainText = [
      `Wilderness Pipeline — ${problemRows.length + alertRows.length + anomalyRows.length} issue(s) found (${ts})`,
      '',
      ...problemRows.map(r => {
        const reasons = [];
        if (r.last_run_status === 'error') reasons.push(`ERROR: ${r.error_message}`);
        if (r.is_stale)     reasons.push(`STALE (${r.minutes_since_last_run} min ago, expected ${r.expected_max_staleness_minutes})`);
        if (r.has_stale_lock) reasons.push(`STALE LOCK (${r.locked_minutes} min)`);
        return `${r.dataset}.${r.table_name}: ${reasons.join(' | ')}`;
      }),
      ...anomalyRows.map(r => `ANOMALY ${r.sync_name}: ${r.most_recent_rows_fetched} rows (${r.anomaly_ratio}x avg)`),
      ...alertRows.map(r => `[${r.severity}] ${r.platform}/${r.sync_name}: ${r.message}`),
      '',
      dashboardUrl,
    ].join('\n');

    MailApp.sendEmail({
      to:       recipientEmail,
      subject:  `[Wilderness Pipeline] ${problemRows.length + alertRows.length + anomalyRows.length} issue(s) found`,
      body:     plainText,
      htmlBody: html,
    });

    Logger.log(`[HealthCheckReporting.runDigest] email sent to ${recipientEmail} — ${problemRows.length} issues, ${alertRows.length} alerts`);
  };

  // Cloud Run's own auth check (when "require authentication" is on)
  // validates a proper OIDC ID token whose audience matches the exact
  // request URL — it does NOT accept a plain OAuth access token like the
  // one ScriptApp.getOAuthToken() returns (confirmed empirically: it
  // fails with a GFE-level 401 regardless of IAM bindings, since the
  // token type itself is wrong, not the permission). Cloud Scheduler's
  // own jobs call this same service successfully using exactly this
  // pattern — an OIDC token audienced to the specific /sync/<platform>/
  // <table> URL, issued for the wilderness-pipeline-sa service account
  // (which already has roles/run.invoker on the service).
  //
  // A human Google identity can't mint an audience-bound ID token for an
  // arbitrary URL directly — that requires impersonating a service
  // account. So triggerSync() impersonates wilderness-pipeline-sa via the
  // IAM Credentials API's generateIdToken method, using the calling
  // user's own OAuth token (already cloud-platform scoped) as the
  // credential for that impersonation call. This requires the calling
  // identity to have roles/iam.serviceAccountTokenCreator on
  // wilderness-pipeline-sa (grant via: gcloud iam service-accounts
  // add-iam-policy-binding wilderness-pipeline-sa@wilderness-data.iam.gserviceaccount.com
  // --member="user:YOUR_EMAIL" --role="roles/iam.serviceAccountTokenCreator"
  // --project=wilderness-data). No service account key file involved —
  // the impersonation call mints a short-lived token on demand.
  const PIPELINE_SERVICE_ACCOUNT = 'wilderness-pipeline-sa@wilderness-data.iam.gserviceaccount.com';

  /**
   * Mint a short-lived OIDC ID token audienced to `targetUrl`, by
   * impersonating PIPELINE_SERVICE_ACCOUNT via the IAM Credentials API.
   * See the comment above triggerSync() for why this is necessary.
   *
   * The generateIdToken endpoint path is "projects/-/serviceAccounts/..."
   * (a wildcard, not a real project) — Google Cloud then falls back to
   * whichever GCP project is tied to the CALLING credential for API
   * enablement/quota checks. For an Apps Script OAuth token that's the
   * script's own hidden default GCP project, not wilderness-data — and
   * the IAM Service Account Credentials API isn't enabled there (nor
   * should it need to be). x-goog-user-project overrides that fallback
   * explicitly, pointing quota/enablement checks at wilderness-data
   * instead, where the API is already enabled. Confirmed empirically
   * (2026-07-01): calls fail with a SERVICE_DISABLED 403 quoting an
   * unrelated project number without this header.
   *
   * @param {string} targetUrl
   * @returns {string} ID token
   */
  const mintIdToken_ = (targetUrl) => {
    const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${PIPELINE_SERVICE_ACCOUNT}:generateIdToken`;

    const response = UrlFetchApp.fetch(iamUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        'x-goog-user-project': GCP_PROJECT_ID,
      },
      payload: JSON.stringify({ audience: targetUrl, includeEmail: true }),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(
        `Failed to mint ID token via impersonation (${code}): ${response.getContentText()} — ` +
        `the calling identity needs roles/iam.serviceAccountTokenCreator on ${PIPELINE_SERVICE_ACCOUNT}.`
      );
    }

    return JSON.parse(response.getContentText()).token;
  };

  /**
   * Manually trigger a sync via the Cloud Run endpoint, authenticating
   * with an impersonated ID token (see mintIdToken_() doc above).
   *
   * @param {string} platform
   * @param {string} table
   * @returns {string}
   */
  this.triggerSync = (platform, table) => {
    const url = `https://wilderness-pipeline-707857814172.australia-southeast1.run.app/sync/${platform}/${table}`;
    Logger.log(`[HealthCheckReporting.triggerSync] POST ${url}`);

    const idToken = mintIdToken_(url);

    const options = {
      method: 'post',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log(`[HealthCheckReporting.triggerSync] response ${code}: ${body}`);

    if (code === 401 || code === 403) {
      Logger.log(
        '[HealthCheckReporting.triggerSync] AUTH FAILED — the impersonated ' +
        'service account needs roles/run.invoker on wilderness-pipeline. ' +
        'Grant via: gcloud run services add-iam-policy-binding wilderness-pipeline ' +
        `--region=australia-southeast1 --member="serviceAccount:${PIPELINE_SERVICE_ACCOUNT}" --role="roles/run.invoker"`
      );
    }

    return body;
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Write headers + data to a named sheet, creating it if needed.
   * Clears existing content before writing. Always appends a "last_refresh"
   * column as the final column.
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
      Logger.log(`[HealthCheckReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[HealthCheckReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[HealthCheckReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

  /**
   * Apply conditional-style formatting to the Current Status sheet:
   *   - red background on rows where last_run_status = 'error'
   *   - amber background on rows where has_stale_lock = true
   *   - yellow background on rows where is_stale = true (schedule overdue)
   * Applied via direct cell coloring (not Sheets' native conditional
   * format rules) so it rebuilds cleanly on every refresh rather than
   * accumulating stale rules.
   *
   * @param {string} sheetName
   * @param {string[]} headers
   */
  const applyStatusFormatting_ = (sheetName, headers) => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const statusCol    = headers.indexOf('last_run_status') + 1;
    const staleLockCol = headers.indexOf('has_stale_lock') + 1;
    const isStaleCol   = headers.indexOf('is_stale') + 1;
    const numCols       = headers.length + 1; // +1 for last_refresh

    sheet.getRange(2, 1, lastRow - 1, numCols).setBackground(null);

    if (statusCol > 0) {
      const statusValues = sheet.getRange(2, statusCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < statusValues.length; i++) {
        if (statusValues[i][0] === 'error') {
          sheet.getRange(i + 2, 1, 1, numCols).setBackground('#f4cccc');
        }
      }
    }

    if (staleLockCol > 0) {
      const staleValues = sheet.getRange(2, staleLockCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < staleValues.length; i++) {
        if (staleValues[i][0] === true) {
          sheet.getRange(i + 2, 1, 1, numCols).setBackground('#fce5cd');
        }
      }
    }

    if (isStaleCol > 0) {
      const isStaleValues = sheet.getRange(2, isStaleCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < isStaleValues.length; i++) {
        if (isStaleValues[i][0] === true) {
          // Only apply if not already colored red/amber above — avoid
          // overwriting a more severe error/stale-lock highlight with a
          // less severe staleness one.
          const currentBg = sheet.getRange(i + 2, 1).getBackground();
          if (currentBg === '#ffffff' || currentBg === null) {
            sheet.getRange(i + 2, 1, 1, numCols).setBackground('#fff2cc');
          }
        }
      }
    }
  };

  /**
   * Highlight rows in the Volume Trends sheet where all_runs_failed is
   * true — a day where every single run for that table errored, which is
   * worth seeing at a glance rather than scanning the error_count column
   * across potentially 30+ rows per table.
   *
   * @param {string} sheetName
   * @param {string[]} headers
   */
  const applyTrendsFormatting_ = (sheetName, headers) => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const allFailedCol = headers.indexOf('all_runs_failed') + 1;
    const numCols       = headers.length + 1; // +1 for last_refresh

    sheet.getRange(2, 1, lastRow - 1, numCols).setBackground(null);

    if (allFailedCol > 0) {
      const values = sheet.getRange(2, allFailedCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        if (values[i][0] === true) {
          sheet.getRange(i + 2, 1, 1, numCols).setBackground('#f4cccc');
        }
      }
    }
  };

  /**
   * Highlight rows in the Performance Metrics sheet:
   *   - red background where error_rate_pct >= 20 (1 in 5 runs failing
   *     or worse over the last 7 days — a real reliability problem, not
   *     noise)
   *   - amber background where max_duration_s is large enough to be a
   *     genuine timeout/contention risk (>= 1500s / 25 min — chosen with
   *     headroom under Cloud Scheduler's 30-min attempt_deadline ceiling,
   *     so this flags a target getting close to that limit before it
   *     actually starts failing on deadline)
   * Thresholds are deliberately simple constants here rather than
   * per-table — if a specific table's "normal" duration is naturally
   * close to these thresholds, that's itself worth knowing about, not
   * a reason to suppress the flag.
   *
   * @param {string} sheetName
   * @param {string[]} headers
   */
  const applyPerformanceFormatting_ = (sheetName, headers) => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const ERROR_RATE_THRESHOLD_PCT = 20;
    const MAX_DURATION_THRESHOLD_S = 1500;

    const errorRateCol = headers.indexOf('error_rate_pct') + 1;
    const maxDurationCol = headers.indexOf('max_duration_s') + 1;
    const numCols = headers.length + 1; // +1 for last_refresh

    sheet.getRange(2, 1, lastRow - 1, numCols).setBackground(null);

    if (errorRateCol > 0) {
      const values = sheet.getRange(2, errorRateCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        if (typeof values[i][0] === 'number' && values[i][0] >= ERROR_RATE_THRESHOLD_PCT) {
          sheet.getRange(i + 2, 1, 1, numCols).setBackground('#f4cccc');
        }
      }
    }

    if (maxDurationCol > 0) {
      const values = sheet.getRange(2, maxDurationCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        if (typeof values[i][0] === 'number' && values[i][0] >= MAX_DURATION_THRESHOLD_S) {
          // Don't overwrite a more severe error-rate highlight already applied above.
          const currentBg = sheet.getRange(i + 2, 1).getBackground();
          if (currentBg === '#ffffff' || currentBg === null) {
            sheet.getRange(i + 2, 1, 1, numCols).setBackground('#fce5cd');
          }
        }
      }
    }
  };

  /**
   * Highlight rows in the Volume Anomalies sheet where is_anomaly is
   * true — rows_fetched on the most recent run is 3x+ the trailing
   * 14-day average. See the view's own doc comment for why 3x is the
   * threshold and why this matters (early warning for a recurring
   * source-side workflow touching the whole table, the exact pattern
   * behind the original tickets incident).
   *
   * @param {string} sheetName
   * @param {string[]} headers
   */
  const applyAnomalyFormatting_ = (sheetName, headers) => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const isAnomalyCol = headers.indexOf('is_anomaly') + 1;
    const numCols = headers.length + 1; // +1 for last_refresh

    sheet.getRange(2, 1, lastRow - 1, numCols).setBackground(null);

    if (isAnomalyCol > 0) {
      const values = sheet.getRange(2, isAnomalyCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        if (values[i][0] === true) {
          sheet.getRange(i + 2, 1, 1, numCols).setBackground('#f4cccc');
        }
      }
    }
  };

};