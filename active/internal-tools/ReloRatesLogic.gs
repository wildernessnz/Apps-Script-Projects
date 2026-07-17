/**
 * @fileoverview Relo Rates — calculates relocation job pay offers based on
 * trip duration, flight/bus time, delays, overnight status, and public
 * holiday rate. Ported from the original "JobRates.gs" — calculation logic
 * unchanged, only the spreadsheet access pattern changed (openById instead
 * of getActiveSpreadsheet).
 *
 * Rate inputs come from the "Variables" tab in the Relo Rates spreadsheet
 * (SHEET_IDS.RELO_RATES in Config.gs): living wage (B3), meal allowance (B5),
 * standard waiting minutes (B6).
 */

// Global wrapper — the only entry point exposed to google.script.run from the client.
function getJobRates(departure, destination, departureDate, overnight, tripDuration, flightDuration, delayDuration, publicHoliday) {
  return new JobRates().calculateJobRates(departure, destination, departureDate, overnight, tripDuration, flightDuration, delayDuration, publicHoliday);
}

var JobRates = function () {

  const SHEET_KEY = 'RELO_RATES';
  const VARS_TAB  = 'Variables';

  /**
   * @param {string} departure
   * @param {string} destination
   * @param {string|Date} departureDate
   * @param {boolean} overnight
   * @param {number} tripDuration - minutes
   * @param {number} flightDuration - minutes
   * @param {number} delayDuration - minutes
   * @param {boolean} publicHoliday
   * @returns {string} JSON-stringified job rate breakdown
   */
  this.calculateJobRates = (departure, destination, departureDate, overnight, tripDuration, flightDuration, delayDuration, publicHoliday) => {
    Logger.log(`[JobRates.calculateJobRates] departure=${departure} | destination=${destination} | tripDuration=${tripDuration} | overnight=${overnight} | publicHoliday=${publicHoliday}`);

    const ss = getSpreadsheet_(SHEET_KEY);
    const sheetVariables = ss.getSheetByName(VARS_TAB);
    if (!sheetVariables) throw new Error(`[JobRates.calculateJobRates] Sheet tab "${VARS_TAB}" not found`);

    let livingWage          = Number(sheetVariables.getRange('B3').getValue()) || 0;
    const mealAllowanceAmount = Number(sheetVariables.getRange('B5').getValue()) || 0;
    const standardWaitingMins = Number(sheetVariables.getRange('B6').getValue()) || 0;

    if (publicHoliday) livingWage = livingWage * 1.5; // 1.5x rate for public holidays

    // Normalise inputs (they come in as minutes)
    const tripMins   = Number(tripDuration)   || 0;
    const flightMins = Number(flightDuration) || 0;
    const delayMins  = Number(delayDuration)  || 0;

    // Base estimate: trip time in hours. Add flight time, delays and standard waiting time (all in hours)
    const estimatedHours = (tripMins / 60) + (flightMins / 60) + (delayMins / 60) + (standardWaitingMins / 60);

    // Rest breaks (stored in minutes)
    let restDuration    = 0;
    let totalPaidBreaks  = 0; // each 10-minute paid rest break
    let totalMealBreaks  = 0; // each 30-minute unpaid meal break

    // Break estimated hours into 8-hour blocks
    let remainingHours = estimatedHours;

    while (remainingHours > 0) {
      const blockHours = Math.min(8, remainingHours);

      if (blockHours >= 2 && blockHours < 4) {
        totalPaidBreaks += 1;
        restDuration += 10;
      } else if (blockHours >= 4 && blockHours < 6) {
        totalPaidBreaks += 1;
        totalMealBreaks += 1;
        restDuration += 10;
      } else if (blockHours >= 6) {
        totalPaidBreaks += 2;
        totalMealBreaks += 1;
        restDuration += 20;
      }

      remainingHours -= blockHours;
    }

    // ----- Build Final Unified Description -----
    const descParts = [];

    if (totalPaidBreaks > 0) {
      descParts.push(
        totalPaidBreaks === 1
          ? 'One 10-minute paid rest break'
          : totalPaidBreaks + ' x 10-minute paid rest breaks'
      );
    }

    if (totalMealBreaks > 0) {
      descParts.push(
        totalMealBreaks === 1
          ? 'one 30-minute unpaid meal break'
          : totalMealBreaks + ' x 30-minute unpaid meal breaks'
      );
    }

    const restDescription = descParts.join(' + ');

    // Total hours including paid rest
    const totalHours = estimatedHours + (restDuration > 0 ? restDuration / 60 : 0);

    // Pay calculations
    const payOffered    = estimatedHours * livingWage; // base hours only
    const mealAllowance = overnight ? mealAllowanceAmount : 0;
    const delayPay      = delayMins  > 0 ? (delayMins  / 60) * livingWage : 0;
    const restPay       = restDuration > 0 ? (restDuration / 60) * livingWage : 0;

    const totalPayOffered = payOffered + mealAllowance + delayPay + restPay;

    const jobRate = {
      departure,
      destination,
      startDate:       departureDate,
      estimatedHours:  estimatedHours.toFixed(2),
      totalHours:      totalHours.toFixed(2),
      payOffered:      payOffered.toFixed(2),
      mealAllowance:   mealAllowance.toFixed(2),
      delayPay:        delayPay.toFixed(2),
      restPay:         restPay.toFixed(2),
      restDescription,
      totalPayOffered: totalPayOffered.toFixed(2),
      publicHoliday,
    };

    Logger.log(`[JobRates.calculateJobRates] totalPayOffered=${jobRate.totalPayOffered}`);

    return JSON.stringify(jobRate);
  };

};
