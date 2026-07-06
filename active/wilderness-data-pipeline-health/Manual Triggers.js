/**
 * @fileoverview "Manual Triggers" sheet — lets anyone tick which sync
 * endpoints to run, confirm via a dialog, and fire them, all from the
 * spreadsheet UI without opening the Apps Script editor.
 *
 * Design note: firing happens from a MENU ITEM ("Pipeline Tools > Run
 * Selected Triggers"), not directly from ticking a checkbox. This is a
 * hard platform constraint, not a stylistic choice — Apps Script's Ui
 * service (Ui.alert(), prompts, HTML dialogs) cannot be called from ANY
 * trigger context, simple or installable, so there is no point at which
 * an onEdit handler could show a confirmation dialog. Checkboxes here
 * are therefore SELECTION only; the actual trigger fires from the menu
 * action below, which — like any menu-invoked function — runs with a
 * normal UI-attached, fully authorized execution context (the same kind
 * of context the Script editor's Run button gives you).
 *
 * (An earlier revision fired triggerSync() directly from an installable
 * onEdit trigger, with no confirmation step. Replaced with this
 * menu-driven design once a confirmation step was required — see
 * Change History in CLAUDE.md, 2026-07-01. cleanupLegacyEditTrigger_()
 * below removes that old trigger from any spreadsheet still running it.)
 *
 * Endpoint list: fetched LIVE from Cloud Scheduler on every rebuild
 * (fetchManualTriggerEndpoints_()), not hand-maintained. An earlier
 * revision used a hardcoded array here and it silently missed all 15
 * weekly "_reconciliation" targets from day one — hand-kept lists drift
 * from whatever's actually deployed. Cloud Scheduler's job list is the
 * single source of truth for what sync targets exist in production, and
 * Scheduled Job Reporting.js already reads it the same way for the
 * "Scheduled Jobs" sheet — this reuses that same REST API and auth
 * (roles/cloudscheduler.viewer), reshaped into
 * {platform, table, targetType, description}.
 *
 * TWO FIRING MECHANISMS, chosen per row by its Target Type column (added
 * 2026-07-06, when the 16 reconciliation targets moved off the Service
 * onto a dedicated wilderness-pipeline-job Cloud Run Job — see
 * describeTarget_() in Scheduled Job Reporting.js, shared from there
 * rather than reimplemented here): "Service" rows call triggerSync()
 * (POSTs straight to the wilderness-pipeline Cloud Run service);
 * "Job" rows call triggerJobRun() (starts a wilderness-pipeline-job
 * execution via the Cloud Run Admin API instead — see both functions'
 * doc comments in Health Check Reporting.js for why these need
 * genuinely different transport/auth, not just a different URL). Before
 * this, EVERY row called triggerSync() regardless of target type, which
 * silently broke for all 15 reconciliation targets once they moved to
 * the Job — and fetchManualTriggerEndpoints_() previously matched only
 * `/sync/<platform>/<table>` URIs, which would have made those same 15
 * targets vanish from this sheet entirely on the next rebuild (Job
 * targets hit a `run.googleapis.com/.../jobs/...:run` URI, not
 * `/sync/...`) rather than merely mis-firing.
 */

const MANUAL_TRIGGERS_SHEET = 'Manual Triggers';
// Handler name from the earlier immediate-fire design — no longer
// installed anywhere in this file, kept only so cleanupLegacyEditTrigger_()
// can find and remove any trigger a prior version left behind.
const LEGACY_MANUAL_TRIGGERS_HANDLER = 'onManualTriggerEdit';

// Column layout (1-indexed) for the Manual Triggers sheet.
const MT_COL_PLATFORM = 1;
const MT_COL_TABLE = 2;
const MT_COL_TARGET_TYPE = 3; // "Service" or "Job" — determines which trigger function fires this row
const MT_COL_DESCRIPTION = 4;
const MT_COL_SELECT = 5;
const MT_COL_RESULT = 6;
const MT_COL_LAST_RUN = 7;
const MT_NUM_COLS = 7;

// SCHEDULER_LOCATION is declared once in Scheduled Job Reporting.js —
// Apps Script shares global scope across all .gs files, so it's
// available here without redeclaring.

/**
 * Fetch every currently configured Cloud Scheduler job that resolves to a
 * usable sync target, and reshape into the
 * {platform, table, targetType, description} entries the sheet is built
 * from. This is what keeps the sheet in sync with production without
 * anyone having to remember to update a hardcoded list here whenever a
 * sync target is added or removed upstream.
 *
 * Uses the SAME describeTarget_() Scheduled Job Reporting.js uses for the
 * "Scheduled Jobs" sheet (declared top-level there, shared via Apps
 * Script's global scope) rather than a separate regex here — before
 * 2026-07-06 this file matched only `/sync/<platform>/<table>` URIs
 * directly, which worked when every sync target was Service-hosted, but
 * would have made all 15 reconciliation targets vanish from this sheet
 * the moment they moved to hitting a `run.googleapis.com/.../jobs/
 * ...:run` URI instead (Job targets don't have `/sync/` in their URI at
 * all — see describeTarget_()'s doc comment). Non-sync, non-decodable, or
 * non-HTTP targets (e.g. /maintenance/clear-stale-locks, or a Job body
 * that fails to decode) are excluded — only rows describeTarget_()
 * resolved to a real platform/table are triggerable in the first place.
 *
 * @returns {{platform: string, table: string, targetType: string, description: string}[]}
 */
function fetchManualTriggerEndpoints_() {
  const url = `https://cloudscheduler.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${SCHEDULER_LOCATION}/jobs`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code === 401 || code === 403) {
    throw new Error(
      `Cloud Scheduler API auth failed (${code}). The Apps Script identity needs ` +
      `roles/cloudscheduler.viewer on the project — see Scheduled Job Reporting.js's ` +
      `file header doc for the grant command.`
    );
  }
  if (code !== 200) {
    throw new Error(`Cloud Scheduler API error ${code}: ${response.getContentText()}`);
  }

  const jobs = JSON.parse(response.getContentText()).jobs || [];

  const endpoints = jobs
    .map(job => {
      const target = describeTarget_(job);
      // describeTarget_() returns '' for an unmatched Service path, and
      // a "(...)" placeholder (e.g. "(decode error)") for an
      // undecodable Job body — neither is a usable trigger target.
      const hasRealTarget = target.platform && target.table && !target.platform.startsWith('(');
      if (!hasRealTarget || (target.targetType !== 'Service' && target.targetType !== 'Job')) return null;

      return {
        platform: target.platform,
        table: target.table,
        targetType: target.targetType,
        description: describeManualTriggerEndpoint_(target.platform, target.table),
      };
    })
    .filter(Boolean);

  endpoints.sort((a, b) => (a.platform + a.table).localeCompare(b.platform + b.table));
  return endpoints;
}

/**
 * Human-readable label for a platform/table pair, e.g.
 * ('hs-rental', 'deals_associations_reconciliation') ->
 * "HubSpot Rental — Deals associations (reconciliation)".
 *
 * @param {string} platform
 * @param {string} table
 * @returns {string}
 */
function describeManualTriggerEndpoint_(platform, table) {
  const PLATFORM_LABELS = { 'hs-rental': 'HubSpot Rental', 'fleetio': 'Fleetio' };
  const platformLabel = PLATFORM_LABELS[platform] || platform;

  const RECONCILIATION_SUFFIX = '_reconciliation';
  const isReconciliation = table.endsWith(RECONCILIATION_SUFFIX);
  const baseTable = isReconciliation ? table.slice(0, -RECONCILIATION_SUFFIX.length) : table;
  const tableLabel = baseTable
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return isReconciliation
    ? `${platformLabel} — ${tableLabel} (reconciliation)`
    : `${platformLabel} — ${tableLabel}`;
}

/**
 * Build (or rebuild) the Manual Triggers sheet from the LIVE Cloud
 * Scheduler job list, and clean up any leftover installable trigger
 * from the earlier immediate-fire design. Safe to re-run — rebuilding
 * the layout doesn't need re-authorization, since firing now happens
 * via a menu item rather than a trigger.
 */
function setupManualTriggersSheet() {
  const ui = SpreadsheetApp.getUi();

  let endpoints;
  try {
    endpoints = fetchManualTriggerEndpoints_();
  } catch (err) {
    ui.alert(`Could not fetch sync targets from Cloud Scheduler:\n\n${err.message}`);
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MANUAL_TRIGGERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_TRIGGERS_SHEET);
  }
  sheet.clear();

  const headers = ['Platform', 'Table', 'Target Type', 'Description', 'Select', 'Last Result', 'Last Triggered (NZT)'];
  sheet.getRange(1, 1, 1, MT_NUM_COLS).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const rows = endpoints.map(e => [e.platform, e.table, e.targetType, e.description, false, '', '']);
  sheet.getRange(2, 1, rows.length, MT_NUM_COLS).setValues(rows);

  sheet.getRange(2, MT_COL_SELECT, rows.length, 1).insertCheckboxes();

  sheet.setColumnWidth(MT_COL_PLATFORM, 100);
  sheet.setColumnWidth(MT_COL_TABLE, 180);
  sheet.setColumnWidth(MT_COL_TARGET_TYPE, 90);
  sheet.setColumnWidth(MT_COL_DESCRIPTION, 240);
  sheet.setColumnWidth(MT_COL_SELECT, 70);
  sheet.setColumnWidth(MT_COL_RESULT, 320);
  sheet.setColumnWidth(MT_COL_LAST_RUN, 160);

  // Warning-only protection on the non-editable columns — flags accidental
  // edits to Platform/Table/Target Type (which would silently point a
  // selection at the wrong endpoint, or fire it via the wrong mechanism)
  // without blocking anyone who genuinely needs to.
  sheet.getRange(1, 1, rows.length + 1, MT_COL_TARGET_TYPE).protect().setWarningOnly(true);
  sheet.getRange(2, MT_COL_RESULT, rows.length, 2).protect().setWarningOnly(true);

  cleanupLegacyEditTrigger_();

  Logger.log(`[setupManualTriggersSheet] built ${rows.length} endpoint rows`);
}

/**
 * Delete the installable onEdit trigger from the earlier immediate-fire
 * design, if still present on this spreadsheet. No-op once cleaned up.
 */
function cleanupLegacyEditTrigger_() {
  const legacyTriggers = ScriptApp.getProjectTriggers().filter(
    t => t.getHandlerFunction() === LEGACY_MANUAL_TRIGGERS_HANDLER && t.getEventType() === ScriptApp.EventType.ON_EDIT
  );
  legacyTriggers.forEach(t => ScriptApp.deleteTrigger(t));
  if (legacyTriggers.length > 0) {
    Logger.log(`[cleanupLegacyEditTrigger_] removed ${legacyTriggers.length} legacy trigger(s)`);
  }
}

/**
 * Menu action — "Pipeline Tools > Run Selected Triggers". Reads every
 * checked row on the Manual Triggers sheet, confirms via a native
 * dialog listing exactly what's about to run, then fires each one —
 * via triggerSync() for "Service" rows or triggerJobRun() for "Job" rows
 * (see the Target Type column and this file's header doc) — and writes
 * the result back. See file header doc for why this is menu-driven
 * rather than firing straight off a checkbox edit.
 */
function runSelectedManualTriggers() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANUAL_TRIGGERS_SHEET);
  if (!sheet) {
    ui.alert(`Sheet "${MANUAL_TRIGGERS_SHEET}" not found — run "Rebuild Manual Triggers Sheet" first.`);
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('No endpoints on the sheet — run "Rebuild Manual Triggers Sheet" first.');
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, MT_NUM_COLS).getValues();
  const selectedRows = [];
  data.forEach((row, i) => {
    if (row[MT_COL_SELECT - 1] === true) {
      selectedRows.push({
        rowIndex: i + 2,
        platform: row[MT_COL_PLATFORM - 1],
        table: row[MT_COL_TABLE - 1],
        targetType: row[MT_COL_TARGET_TYPE - 1],
      });
    }
  });

  if (selectedRows.length === 0) {
    ui.alert('Nothing selected — tick the Select box next to each endpoint you want to run, then run this again.');
    return;
  }

  const summary = selectedRows.map(r => `${r.platform}/${r.table} [${r.targetType}]`).join('\n');
  const response = ui.alert(
    'Confirm manual trigger',
    `About to trigger ${selectedRows.length} sync target(s):\n\n${summary}\n\nContinue?`,
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    Logger.log('[runSelectedManualTriggers] cancelled by user');
    return;
  }

  const timestamp = () => Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');

  selectedRows.forEach(r => {
    sheet.getRange(r.rowIndex, MT_COL_RESULT).setValue('Running…');
    SpreadsheetApp.flush();

    let result;
    try {
      // "Job" rows (the reconciliation targets, since 2026-07-06) run on
      // wilderness-pipeline-job and need triggerJobRun() instead of
      // triggerSync() — see both functions' doc comments in
      // Health Check Reporting.js.
      result = r.targetType === 'Job'
        ? triggerJobRun(String(r.platform), String(r.table))
        : triggerSync(String(r.platform), String(r.table));
    } catch (err) {
      result = `ERROR: ${err.message}`;
    }

    sheet.getRange(r.rowIndex, MT_COL_RESULT).setValue(result);
    sheet.getRange(r.rowIndex, MT_COL_LAST_RUN).setValue(timestamp());
    sheet.getRange(r.rowIndex, MT_COL_SELECT).setValue(false);
  });

  ui.alert(`Triggered ${selectedRows.length} sync target(s) — see the Last Result column for each response.`);
}

/**
 * Simple trigger — adds the menu that drives this sheet (both firing
 * selected triggers and rebuilding the sheet layout).
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pipeline Tools')
    .addItem('Run Selected Triggers', 'runSelectedManualTriggers')
    .addItem('Rebuild Manual Triggers Sheet', 'setupManualTriggersSheet')
    .addToUi();
}
