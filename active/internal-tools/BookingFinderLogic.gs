/**
 * @fileoverview Booking Finder — search bookings by vehicle rego and travel date.
 * Data source: "Linked - Bookings" tab in the Booking Finder spreadsheet
 * (SHEET_IDS.BOOKING_FINDER in Config.gs). Ported from the original
 * "Booking Finder.gs" — search logic unchanged, only the spreadsheet access
 * pattern changed (openById instead of getActiveSpreadsheet, since this
 * project is standalone, not container-bound to that sheet).
 */

// Global wrapper — the only entry point exposed to google.script.run from the client.
function searchBookings(rego, travelDate) {
  return new BookingFinder().searchBookings(rego, travelDate);
}

var BookingFinder = function () {

  const SHEET_KEY = 'BOOKING_FINDER';
  const TAB_NAME  = 'Linked - Bookings';

  // Column indices (0-based, matching getValues()'s row arrays) for the
  // "Linked - Bookings" tab's header row:
  // booking_number, hubspot_vid, state, vehicle_type, pick_up_location,
  // pick_up_date, drop_off_location, drop_off_date, booking_type,
  // vehicle_rego, customer_name, ...
  const COL_BOOKING_NUMBER = 0;
  const COL_VEHICLE_TYPE   = 3;
  const COL_PICKUP_DATE    = 5;
  const COL_DROPOFF_DATE   = 7;
  const COL_REGO           = 9;
  const COL_CUSTOMER_NAME  = 10;

  /**
   * Searches bookings by vehicle registration (prefix match) and travel date
   * (must fall within the booking's start/end date range). Matches the
   * original tool's behaviour exactly — no new filters added.
   * @param {string} rego - vehicle registration, partial/prefix match
   * @param {string|Date} travelDate - date to check against each booking's range
   * @returns {string} JSON-stringified array of matching bookings
   */
  this.searchBookings = (rego, travelDate) => {
    Logger.log(`[BookingFinder.searchBookings] rego=${rego} | travelDate=${travelDate}`);

    const ss    = getSpreadsheet_(SHEET_KEY);
    const sheet = ss.getSheetByName(TAB_NAME);
    if (!sheet) throw new Error(`[BookingFinder.searchBookings] Sheet tab "${TAB_NAME}" not found`);

    const lastRow = sheet.getLastRow();
    const rows = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const normalisedRego = (rego || '').trim().toUpperCase();
    const date = new Date(travelDate);

    const matches = rows.filter((row) => {
      const rowRego = (row[COL_REGO] || '').toString().toUpperCase();
      if (!rowRego.startsWith(normalisedRego)) return false;
      return date >= new Date(row[COL_PICKUP_DATE]) && date <= new Date(row[COL_DROPOFF_DATE]);
    });

    Logger.log(`[BookingFinder.searchBookings] matchCount=${matches.length}`);

    const bookings = matches.map((row) => {
      const bookingNumber = String(row[COL_BOOKING_NUMBER] || '').replace('R-', '');
      return {
        bookingNumber,
        guest:       row[COL_CUSTOMER_NAME],
        startDate:   new Date(row[COL_PICKUP_DATE]),
        endDate:     new Date(row[COL_DROPOFF_DATE]),
        rego:        row[COL_REGO],
        vehicleType: row[COL_VEHICLE_TYPE],
        link: `https://bookings.wilderness.co.nz/rata/bookings/${bookingNumber}`,
      };
    });

    return JSON.stringify(bookings);
  };

};
