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

    const rows = sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).getValues();
    const normalisedRego = (rego || '').trim().toUpperCase();
    const date = new Date(travelDate);

    const matches = rows.filter((row) => {
      const rowRego = (row[9] || '').toString().toUpperCase();
      if (!rowRego.startsWith(normalisedRego)) return false;
      return date >= new Date(row[5]) && date <= new Date(row[7]);
    });

    Logger.log(`[BookingFinder.searchBookings] matchCount=${matches.length}`);

    const bookings = matches.map((row) => {
      const bookingNumber = row[0].replace('R-', '');
      return {
        bookingNumber,
        guest:       row[10],
        startDate:   new Date(row[5]),
        endDate:     new Date(row[7]),
        rego:        row[9],
        vehicleType: row[3],
        link: `https://bookings.wilderness.co.nz/rata/bookings/${bookingNumber}`,
      };
    });

    return JSON.stringify(bookings);
  };

};
