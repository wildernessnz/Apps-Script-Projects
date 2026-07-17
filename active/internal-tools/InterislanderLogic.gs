/**
 * @fileoverview Interislander Availability — checks scheduled sailings via the
 * KiwiRail booking API for a selected date plus a ±2 day window either side.
 * Ported from the original "Interislander.gs" + "Security.gs" + "Utilities.gs".
 *
 * Credentials moved out of hardcoded values in Security.gs into Script
 * Properties (Project Settings > Script Properties). The original had
 * separate credential pairs for production vs UAT — preserved here rather
 * than collapsed into one set:
 *   KIWIRAIL_PRODUCTION_MODE     — "true" or "false" (defaults to true if unset)
 *   KIWIRAIL_PROD_API_KEY
 *   KIWIRAIL_PROD_BASE64_HEADER
 *   KIWIRAIL_UAT_API_KEY
 *   KIWIRAIL_UAT_BASE64_HEADER
 *
 * (The original Security.gs also had a getUsername() — unused by the actual
 * API calls in the original code, so not carried forward. Flag if that was
 * needed for something outside this file.)
 *
 * Data source: "Scheduled Sailings" tab in the Interislander spreadsheet
 * (SHEET_IDS.INTERISLANDER in Config.gs) — used as a cache/log, matching the
 * original tool's behaviour.
 */

// Global wrapper — the only entry point exposed to google.script.run from the client.
function getScheduledSailingsExtended(departureDate, direction) {
  return new Interislander().getScheduledSailingsExtended(departureDate, direction);
}

var Interislander = function () {

  const SHEET_KEY = 'INTERISLANDER';
  const CACHE_TAB = 'Scheduled Sailings';

  // ── Security / API config ────────────────────────────────────────────────

  /**
   * @returns {{isProduction: boolean, baseUrl: string, base64Header: string, apiKey: string}}
   */
  const getSecurityConfig_ = () => {
    const props = PropertiesService.getScriptProperties();
    const isProduction = props.getProperty('KIWIRAIL_PRODUCTION_MODE') !== 'false'; // defaults true

    // Prod and UAT use entirely separate credential pairs — matches the
    // original Security.gs, which returned different values for each based
    // on isInProductionMode(). Do not fall back from one to the other.
    return isProduction
      ? {
          isProduction,
          baseUrl: 'https://ws.kiwirail.co.nz/InterislanderBookingv2/',
          base64Header: props.getProperty('KIWIRAIL_PROD_BASE64_HEADER'),
          apiKey:       props.getProperty('KIWIRAIL_PROD_API_KEY'),
        }
      : {
          isProduction,
          baseUrl: 'https://ws-test.kiwirail.co.nz/InterislanderBookingv2/',
          base64Header: props.getProperty('KIWIRAIL_UAT_BASE64_HEADER'),
          apiKey:       props.getProperty('KIWIRAIL_UAT_API_KEY'),
        };
  };

  /**
   * @param {Object} cfg - from getSecurityConfig_()
   * @returns {Object} UrlFetchApp options for a GET request
   */
  const getHeaderOptions_ = (cfg) => ({
    method: 'GET',
    contentType: 'application/json; charset=utf8',
    muteHttpExceptions: true,
    headers: {
      Authorization:  'Basic ' + cfg.base64Header,
      Authorization2: 'APIKey ' + cfg.apiKey,
      Accept: 'application/json',
    },
  });

  /**
   * @param {string} api - relative path + querystring, e.g. "scheduledsailings?..."
   * @returns {Object|null} parsed JSON body, or null on non-200 response
   */
  const getAPIData_ = (api) => {
    const cfg = getSecurityConfig_();
    const url = cfg.baseUrl + api;
    const response = UrlFetchApp.fetch(url, getHeaderOptions_(cfg));
    const code = response.getResponseCode();

    if (code !== 200) {
      Logger.log(`[Interislander.getAPIData_] status=${code} | body=${response.getContentText()}`);
      return null;
    }
    return JSON.parse(response.getContentText());
  };

  // ── Date helpers ──────────────────────────────────────────────────────────

  /**
   * Formats a Date as YYYY-MM-DD for the KiwiRail API.
   * @param {Date} date
   * @returns {string|null}
   */
  const formatDate_ = (date) => {
    if (!date) return null;
    const year  = date.getFullYear().toString();
    const month = (date.getMonth() + 101).toString().substring(1);
    const day   = (date.getDate() + 100).toString().substring(1);
    return `${year}-${month}-${day}`;
  };

  // ── Sailings ──────────────────────────────────────────────────────────────

  /**
   * Checks availability for a single date + direction.
   * @param {string} departureDate - YYYY-MM-DD
   * @param {string} direction - "WP" or "PW"
   * @returns {Array<Object>}
   */
  const getScheduledSailings_ = (departureDate, direction) => {
    Logger.log(`[Interislander.getScheduledSailings_] departureDate=${departureDate} | direction=${direction}`);
    const params = `?RouteCode=${direction}&DepDate=${departureDate}&PaxTypeCodes=ADL,CHD,INT&PaxTypeUnits=2,0,0&MotVehCode=MHOME&MotVehLen=7.4`;
    const data = getAPIData_('scheduledsailings' + params);
    return (data && data.ScheduledSailings) || [];
  };

  /**
   * Writes combined sailing results to the Scheduled Sailings cache tab.
   * Matches the original tool's behaviour (clear + rewrite on every search).
   * @param {Array<Object>} sailings
   */
  const populateScheduledSailings_ = (sailings) => {
    if (!sailings.length) return;

    const ss    = getSpreadsheet_(SHEET_KEY);
    const sheet = ss.getSheetByName(CACHE_TAB);
    if (!sheet) {
      Logger.log(`[Interislander.populateScheduledSailings_] Sheet tab "${CACHE_TAB}" not found — skipping cache write`);
      return;
    }

    const lastRefresh = new Date();
    const rows = [];

    sailings.forEach((result) => {
      (result.Prices || []).forEach((price) => {
        rows.push([
          result.RouteCode,
          new Date(result.ScheduledDeparture),
          new Date(result.ScheduledArrival),
          result.ShipName,
          result.CanBook,
          price.FareConditionsName,
          price.Price,
          price.CanBook,
          price.IsSpecial,
          result.UnableToBookReason,
          price.GeneralConditions,
          price.AmendConditions,
          price.CancelConditions,
          price.SummaryConditions,
          lastRefresh,
        ]);
      });
    });

    sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).clearContent();
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    }

    Logger.log(`[Interislander.populateScheduledSailings_] rowsWritten=${rows.length}`);
  };

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Fetches sailings for the requested date plus 2 days either side (skipping
   * "minus" dates that fall before today), then caches the combined result.
   * @param {string} departureDate
   * @param {string} direction - "WP" or "PW"
   * @returns {Array<Object>} combined sailings, ordered -2, -1, 0, +1, +2 days
   */
  this.getScheduledSailingsExtended = (departureDate, direction) => {
    Logger.log(`[Interislander.getScheduledSailingsExtended] departureDate=${departureDate} | direction=${direction}`);

    const today = new Date();
    const dep = new Date(departureDate);

    const offsetDate_ = (n) => { const d = new Date(dep); d.setDate(d.getDate() + n); return d; };

    const dayMinus2 = offsetDate_(-2);
    const dayMinus1 = offsetDate_(-1);

    const day0  = getScheduledSailings_(formatDate_(offsetDate_(0)), direction);
    const dayP1 = getScheduledSailings_(formatDate_(offsetDate_(1)), direction);
    const dayP2 = getScheduledSailings_(formatDate_(offsetDate_(2)), direction);
    const dayM1 = dayMinus1 > today ? getScheduledSailings_(formatDate_(dayMinus1), direction) : [];
    const dayM2 = dayMinus2 > today ? getScheduledSailings_(formatDate_(dayMinus2), direction) : [];

    const combined = [...dayM2, ...dayM1, ...day0, ...dayP1, ...dayP2];

    populateScheduledSailings_(combined);

    return combined;
  };

};