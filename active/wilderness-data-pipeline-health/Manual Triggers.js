/**
 * @fileoverview "Manual Triggers" sheet — lets anyone fire any single sync
 * endpoint by ticking a checkbox, without opening the Apps Script editor.
 * Complements the triggerX() wrapper functions in the Health Check file
 * (those are still the fastest path from the Script editor's Run menu;
 * this is the equivalent for people who only have the Sheet open).
 *
 * Setup (one-time, from the Apps Script editor — required so the
 * installable trigger below runs with an authorized identity):
 *   1. Run setupManualTriggersSheet() once. It builds the sheet AND
 *      installs the onEdit trigger (skips re-installing if one already
 *      exists). You'll be asked to authorize — accept it.
 *   2. Re-running setupManualTriggersSheet() later (e.g. via the
 *      "Pipeline Tools" menu) is safe — it wipes and rebuilds the sheet
 *      layout but won't create a duplicate trigger.
 *
 * Why an INSTALLABLE trigger, not a plain onEdit(e) simple trigger:
 * triggerSync() calls UrlFetchApp.fetch() and ScriptApp.getOAuthToken(),
 * both of which require authorization. Simple triggers (a bare function
 * named onEdit) run in a sandboxed mode that cannot access authorized
 * services — the fetch would fail. An installable trigger, created via
 * ScriptApp.newTrigger(), runs as whoever installed it with full
 * authorization, so it can actually call the sync endpoint.
 */

const MANUAL_TRIGGERS_SHEET = 'Manual Triggers';
const MANUAL_TRIGGERS_HANDLER = 'onManualTriggerEdit';

// Column layout (1-indexed) for the Manual Triggers sheet.
const MT_COL_PLATFORM = 1;
const MT_COL_TABLE = 2;
const MT_COL_DESCRIPTION = 3;
const MT_COL_RUN = 4;
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
 * Build (or rebuild) the Manual Triggers sheet and make sure the
 * installable onEdit trigger is present. Safe to re-run — rebuilding
 * the layout does not create a duplicate trigger.
 */
function setupManualTriggersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MANUAL_TRIGGERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_TRIGGERS_SHEET);
  }
  sheet.clear();

  const headers = ['Platform', 'Table', 'Description', 'Run', 'Last Result', 'Last Triggered (NZT)'];
  sheet.getRange(1, 1, 1, MT_NUM_COLS).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const rows = MANUAL_TRIGGER_ENDPOINTS.map(e => [e.platform, e.table, e.description, false, '', '']);
  sheet.getRange(2, 1, rows.length, MT_NUM_COLS).setValues(rows);

  sheet.getRange(2, MT_COL_RUN, rows.length, 1).insertCheckboxes();

  sheet.setColumnWidth(MT_COL_PLATFORM, 100);
  sheet.setColumnWidth(MT_COL_TABLE, 180);
  sheet.setColumnWidth(MT_COL_DESCRIPTION, 240);
  sheet.setColumnWidth(MT_COL_RUN, 60);
  sheet.setColumnWidth(MT_COL_RESULT, 320);
  sheet.setColumnWidth(MT_COL_LAST_RUN, 160);

  // Warning-only protection on the non-editable columns — flags accidental
  // edits to Platform/Table (which would silently point the checkbox at
  // the wrong endpoint) without blocking anyone who genuinely needs to.
  sheet.getRange(1, 1, rows.length + 1, MT_COL_TABLE).protect().setWarningOnly(true);
  sheet.getRange(2, MT_COL_RESULT, rows.length, 2).protect().setWarningOnly(true);

  installManualTriggersEditTrigger_();

  Logger.log(`[setupManualTriggersSheet] built ${rows.length} endpoint rows`);
}

/**
 * Create the installable onEdit trigger that powers the checkboxes, if
 * one isn't already registered. See file header doc for why this must
 * be installable rather than a simple onEdit(e) function.
 */
function installManualTriggersEditTrigger_() {
  const alreadyInstalled = ScriptApp.getProjectTriggers().some(
    t => t.getHandlerFunction() === MANUAL_TRIGGERS_HANDLER && t.getEventType() === ScriptApp.EventType.ON_EDIT
  );
  if (alreadyInstalled) return;

  ScriptApp.newTrigger(MANUAL_TRIGGERS_HANDLER)
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log('[installManualTriggersEditTrigger_] installable onEdit trigger created');
}

/**
 * Installable onEdit handler. Fires triggerSync() for whichever row's
 * "Run" checkbox was just ticked TRUE, writes the response back, then
 * unchecks the box. Ignores every other edit (wrong sheet, wrong
 * column, unchecking, header row).
 *
 * @param {Object} e - onEdit event object
 */
function onManualTriggerEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (sheet.getName() !== MANUAL_TRIGGERS_SHEET) return;
  if (range.getColumn() !== MT_COL_RUN) return;
  if (range.getRow() < 2) return;
  if (e.value !== 'TRUE') return;

  const row = range.getRow();
  const platform = sheet.getRange(row, MT_COL_PLATFORM).getValue();
  const table = sheet.getRange(row, MT_COL_TABLE).getValue();

  sheet.getRange(row, MT_COL_RESULT).setValue('Running…');

  let result;
  try {
    result = triggerSync(String(platform), String(table));
  } catch (err) {
    result = `ERROR: ${err.message}`;
  }

  const timestamp = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange(row, MT_COL_RESULT).setValue(result);
  sheet.getRange(row, MT_COL_LAST_RUN).setValue(timestamp);
  sheet.getRange(row, MT_COL_RUN).setValue(false);
}

/**
 * Simple trigger — adds a menu so setupManualTriggersSheet() can be
 * (re)run from the Sheet UI itself after the initial authorized setup.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pipeline Tools')
    .addItem('Rebuild Manual Triggers Sheet', 'setupManualTriggersSheet')
    .addToUi();
}
