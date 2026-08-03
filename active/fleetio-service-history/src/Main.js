
/**
 * POC entry point. Fetches a vehicle's service history from Fleetio,
 * includes all entries (no exclusion checklist yet — POC only), and
 * saves a branded PDF to Drive.
 *
 * @param {string} rego
 * @returns {string} URL of the generated PDF in Drive
 */
function generateServiceHistory(rego) {
  Logger.log(`[generateServiceHistory] rego=${rego}`);

  const data = new ServiceHistoryFetcher().fetchByRego(rego);
  const allEntryIds = data.entries.map(e => e.id);

  const pdfBlob = new ServiceHistoryPdf().build(data.vehicle, data.entries, allEntryIds);

  const file = DriveApp.createFile(pdfBlob);
  Logger.log(`[generateServiceHistory] created file=${file.getUrl()}`);

  return file.getUrl();
}

/**
 * Quick manual test — run this from the editor.
 */
function testGenerateServiceHistory() {
  const url = generateServiceHistory('QJC696');
  Logger.log(url);
}
