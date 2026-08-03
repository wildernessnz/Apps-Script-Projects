/**
 * @fileoverview Central cross-tool activity log. Every tool view (via
 * ContentLoader.gs's getToolContent) and every primary user action (each
 * tool's google.script.run entry point) writes one row to the "Activity Log"
 * tab of the Internal Tools container spreadsheet (SHEET_IDS.ACTIVITY_LOG in
 * Config.gs).
 *
 * That tab is created lazily on first write (same pattern as
 * WeatherAlertLogic.gs's own getOrCreateLogSheet_) — no manual sheet setup
 * needed beyond the container spreadsheet existing and being shared with
 * edit access to everyone who uses any tool, since writes run as the
 * visiting user (executeAs: USER_ACCESSING in appsscript.json), not a
 * shared service account.
 *
 * Logging failures are swallowed (Logger.log only, never thrown) — an audit
 * write should never block or break the actual action it's recording.
 */

const ACTIVITY_LOG_TAB = 'Activity Log';

/**
 * @param {string} event - short label, e.g. "Booking Finder: Search"
 * @param {string} [notes] - free-text detail, e.g. "rego=ABC123 | matches=3"
 */
function logEvent_(event, notes) {
  try {
    const ss = getSpreadsheet_('ACTIVITY_LOG');
    let sheet = ss.getSheetByName(ACTIVITY_LOG_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(ACTIVITY_LOG_TAB);
      sheet.appendRow(['Timestamp', 'User', 'Event', 'Notes']);
    }
    const email = Session.getActiveUser().getEmail() || 'unknown';
    sheet.appendRow([new Date(), email, event, notes || '']);
  } catch (err) {
    Logger.log(`[logEvent_] Failed to write activity log entry (event=${event}): ${err.message}`);
  }
}
