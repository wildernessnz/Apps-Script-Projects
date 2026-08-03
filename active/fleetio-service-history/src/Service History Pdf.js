/**
 * @fileoverview Renders vehicle overview + selected service history entries
 * into a branded PDF. SSP-3650 POC.
 */

function testGenerateServiceHistoryPdf() {
  const data = new ServiceHistoryFetcher().fetchByRego('ABC123');
  const allIds = data.entries.map(e => e.id);
  const pdf = new ServiceHistoryPdf().build(data.vehicle, data.entries, allIds);
  DriveApp.createFile(pdf);
}

var ServiceHistoryPdf = function() {

  /**
   * @param {Object} vehicle - mapped vehicle overview from ServiceHistoryFetcher
   * @param {Object[]} entries - mapped service entries from ServiceHistoryFetcher
   * @param {number[]} selectedEntryIds - entry IDs to include in the PDF
   * @returns {Blob} PDF blob
   */
  this.build = (vehicle, entries, selectedEntryIds) => {
    Logger.log(`[ServiceHistoryPdf.build] vehicle=${vehicle.name} | selected=${selectedEntryIds.length}/${entries.length}`);

    const selectedSet = new Set(selectedEntryIds);
    const filteredEntries = entries
      .filter(e => selectedSet.has(e.id))
      .map(e => ({ ...e, completedAtFormatted: formatDate_(e.completedAt) }));

    const template = HtmlService.createTemplateFromFile('ServiceHistoryTemplate');
    template.vehicle = vehicle;
    template.entries = filteredEntries;
    template.generatedOn = formatDate_(new Date());

    const html = template.evaluate().getContent();
    const filename = `Service History - ${vehicle.name}`;

    return Utilities.newBlob(html, 'text/html', `${filename}.html`)
      .getAs('application/pdf')
      .setName(`${filename}.pdf`);
  };

  /**
   * @param {string|Date} date
   * @returns {string}
   */
  const formatDate_ = (date) => {
    if (!date) return '—';
    return Utilities.formatDate(new Date(date), 'Pacific/Auckland', 'd MMMM yyyy');
  };
};