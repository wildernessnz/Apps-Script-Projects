/**
 * @fileoverview Central configuration for the Internal Tools shell.
 * Holds spreadsheet bindings (each tool's data lives in its own existing
 * spreadsheet — nothing is merged) and the sidebar nav structure.
 *
 * Adding a 5th tool later = one entry in NAV_CONFIG + one content partial.
 * No other file needs to change.
 */

// ── Spreadsheet bindings ────────────────────────────────────────────────────
// Each tool opens its own existing spreadsheet by ID. None of these files
// are merged or moved — this project is standalone, not container-bound.

const SHEET_IDS = {
  BOOKING_FINDER: '1UUc82PuQezVI06fEWsGWt1OoQIevUplrzTVtc6_uM_w',
  RELO_RATES:     '1Sh4HFBhFwW0ZZert6gMxPXyjub54_ico9-Zr_3rX7Wg',
  INTERISLANDER:  '1HFe6iabLeToK1yyDlwwSNqeyrnZ43KCRLEgiMJD4roM',
  WEATHER_ALERT:  '1rPypfI_m5t7tbLN1QiW_qjcAYTV3quCtmgjYu-I4VjQ',
};

/**
 * Lazily opens a spreadsheet by key. Wrapped so a bad ID fails with a
 * clear message instead of a generic "not found" deep in some other call.
 * @param {string} key - one of the SHEET_IDS keys above
 * @returns {Spreadsheet}
 */
function getSpreadsheet_(key) {
  const id = SHEET_IDS[key];
  if (!id) throw new Error(`[getSpreadsheet_] Unknown sheet key: ${key}`);
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(`[getSpreadsheet_] Could not open sheet "${key}" (${id}): ${err.message}`);
  }
}

// ── Sidebar navigation ───────────────────────────────────────────────────────
// Drives the sidebar shell (Shell.html) and the client-side router (Router.js.html).
// `partial` is the HtmlService filename (without extension) for that tool's content.

const NAV_CONFIG = [
  {
    section: 'Adventure Support',
    items: [
      { id: 'weather-alert',  label: 'Weather Alert',              icon: 'alert-triangle', partial: 'WeatherAlert' },
      { id: 'booking-finder', label: 'Booking Finder',              icon: 'calendar',       partial: 'BookingFinder' },
      { id: 'interislander',  label: 'Interislander Availability',  icon: 'ferry',          partial: 'Interislander' },
      { id: 'relo-rates',     label: 'Relo Rates',                  icon: 'clock',          partial: 'ReloRates' },
    ],
  },
];
