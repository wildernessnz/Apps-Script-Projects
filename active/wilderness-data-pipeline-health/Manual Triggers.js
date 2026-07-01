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
 */

const MANUAL_TRIGGERS_SHEET = 'Manual Triggers';
// Handler name from the earlier immediate-fire design — no longer
// installed anywhere in this file, kept only so cleanupLegacyEditTrigger_()
// can find and remove any trigger a prior version left behind.
const LEGACY_MANUAL_TRIGGERS_HANDLER = 'onManualTriggerEdit';

// Column layout (1-indexed) for the Manual Triggers sheet.
const MT_COL_PLATFORM = 1;
const MT_COL_TABLE = 2;
const MT_COL_DESCRIPTION = 3;
const MT_COL_SELECT = 4;
const MT_COL_RESULT = 5;
const MT_COL_LAST_RUN = 6;
const MT_NUM_COLS = 6;

// Same 17 targets as the triggerX() wrappers in the Health Check file —
// keep in sync if a new connector/target is added there.
const MANUAL_TRIGGER_ENDPOINTS = [
  // HubSpot Rental — base targets
  { platform: 'hs-rental', table: 'deals', description: 'HubSpot Rental — Deals' },
  { platform: 'hs-rental', table: 'contacts', description: 'HubSpot Rental — Contacts' },
  { platform: 'hs-rental', table: 'tickets', description: 'HubSpot Rental — Tickets' },
  { platform: 'hs-rental', table: 'tasks', description: 'HubSpot Rental — Tasks' },
  { platform: 'hs-rental', table: 'calls', description: 'HubSpot Rental — Calls' },
  { platform: 'hs-rental', table: 'emails', description: 'HubSpot Rental — Emails' },
  { platform: 'hs-rental', table: 'meetings', description: 'HubSpot Rental — Meetings' },
  { platform: 'hs-rental', table: 'engagements', description: 'HubSpot Rental — Engagements' },
  { platform: 'hs-rental', table: 'owners', description: 'HubSpot Rental — Owners' },
  { platform: 'hs-rental', table: 'pipelines', description: 'HubSpot Rental — Pipelines' },
  // HubSpot Rental — association targets
  { platform: 'hs-rental', table: 'deals_associations', description: 'HubSpot Rental — Deals associations' },
  { platform: 'hs-rental', table: 'tickets_associations', description: 'HubSpot Rental — Tickets associations' },
  { platform: 'hs-rental', table: 'tasks_associations', description: 'HubSpot Rental — Tasks associations' },
  { platform: 'hs-rental', table: 'calls_associations', description: 'HubSpot Rental — Calls associations' },
  { platform: 'hs-rental', table: 'emails_associations', description: 'HubSpot Rental — Emails associations' },
  { platform: 'hs-rental', table: 'meetings_associations', description: 'HubSpot Rental — Meetings associations' },
  // Fleetio
  { platform: 'fleetio', table: 'work_orders', description: 'Fleetio — Work orders' },
];

/**
 * Build (or rebuild) the Manual Triggers sheet, and clean up any leftover
 * installable trigger from the earlier immediate-fire design. Safe to
 * re-run — rebuilding the layout doesn't need re-authorization, since
 * firing now happens via a menu item rather than a trigger.
 */
function setupManualTriggersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MANUAL_TRIGGERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_TRIGGERS_SHEET);
  }
  sheet.clear();

  const headers = ['Platform', 'Table', 'Description', 'Select', 'Last Result', 'Last Triggered (NZT)'];
  sheet.getRange(1, 1, 1, MT_NUM_COLS).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const rows = MANUAL_TRIGGER_ENDPOINTS.map(e => [e.platform, e.table, e.description, false, '', '']);
  sheet.getRange(2, 1, rows.length, MT_NUM_COLS).setValues(rows);

  sheet.getRange(2, MT_COL_SELECT, rows.length, 1).insertCheckboxes();

  sheet.setColumnWidth(MT_COL_PLATFORM, 100);
  sheet.setColumnWidth(MT_COL_TABLE, 180);
  sheet.setColumnWidth(MT_COL_DESCRIPTION, 240);
  sheet.setColumnWidth(MT_COL_SELECT, 70);
  sheet.setColumnWidth(MT_COL_RESULT, 320);
  sheet.setColumnWidth(MT_COL_LAST_RUN, 160);

  // Warning-only protection on the non-editable columns — flags accidental
  // edits to Platform/Table (which would silently point a selection at
  // the wrong endpoint) without blocking anyone who genuinely needs to.
  sheet.getRange(1, 1, rows.length + 1, MT_COL_TABLE).protect().setWarningOnly(true);
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
 * dialog listing exactly what's about to run, then fires triggerSync()
 * for each one and writes the result back. See file header doc for why
 * this is menu-driven rather than firing straight off a checkbox edit.
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
      selectedRows.push({ rowIndex: i + 2, platform: row[MT_COL_PLATFORM - 1], table: row[MT_COL_TABLE - 1] });
    }
  });

  if (selectedRows.length === 0) {
    ui.alert('Nothing selected — tick the Select box next to each endpoint you want to run, then run this again.');
    return;
  }

  const summary = selectedRows.map(r => `${r.platform}/${r.table}`).join('\n');
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
      result = triggerSync(String(r.platform), String(r.table));
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
