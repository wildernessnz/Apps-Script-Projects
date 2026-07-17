/**
 * @fileoverview Central configuration for the Internal Tools shell.
 * Holds spreadsheet bindings (each tool's data lives in its own existing
 * spreadsheet — nothing is merged) and the sidebar nav structure.
 *
 * Adding a 5th tool later = one entry in NAV_CONFIG + one content partial.
 * No other file needs to change.
 *
 * SCRIPT PROPERTIES NAMING CONVENTION: since all tools now share one
 * Script Properties store (previously implicit — each tool had its own
 * project), every property must be prefixed with the tool's name, e.g.
 * WEATHER_ALERT_TEST_MODE, KIWIRAIL_PROD_API_KEY. Never add an unprefixed
 * property — it's a collision risk the moment a second tool wants a
 * similarly-named setting.
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
// `icon` holds raw SVG markup (rendered unescaped in Shell.html) rather than
// an icon-library name — no external icon dependency, matches the design
// system's inline-SVG icon style, and colors via currentColor so the
// existing .it-nav-icon CSS controls active/inactive/hover color for free.

const ICON_ALERT_TRIANGLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>';
const ICON_CALENDAR       = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/></svg>';
const ICON_FERRY          = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 16l1.5-6h15L21 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10V4h4v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 20c1 1 2 1 3 1s2-1 3-1 2 1 3 1 2-1 3-1 2 1 3 1 2-1 3-1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_CLOCK          = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const NAV_CONFIG = [
  {
    section: 'Adventure Support',
    items: [
      { id: 'weather-alert',  label: 'Weather Alert',              icon: ICON_ALERT_TRIANGLE, partial: 'WeatherAlert' },
      { id: 'booking-finder', label: 'Booking Finder',              icon: ICON_CALENDAR,       partial: 'BookingFinder' },
      { id: 'interislander',  label: 'Interislander Availability',  icon: ICON_FERRY,          partial: 'Interislander' },
      { id: 'relo-rates',     label: 'Relo Rates',                  icon: ICON_CLOCK,          partial: 'ReloRates' },
    ],
  },
];