/**
 * @fileoverview Service History — generates a branded PDF of a vehicle's
 * service history from Fleetio, resolved by rego, and saves it to Drive.
 * Ported from the fleetio-service-history POC (SSP-3698) — fetch/mapping/PDF
 * logic unchanged. The only functional change is the Script Properties name:
 * the source's unprefixed EXCLUDED_SERVICE_TASKS is renamed to
 * SERVICE_HISTORY_EXCLUDED_TASKS per this project's per-tool prefix
 * convention (see Config.gs).
 */

/**
 * Used by ContentLoader.gs to gate this tool's content behind
 * SERVICE_HISTORY_ALLOWLIST before the sidebar-shared shell renders it —
 * same pattern as Weather Alert's isWeatherAlertApproved().
 * @returns {boolean}
 */
function isServiceHistoryApproved() {
  const email = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props = PropertiesService.getScriptProperties();
  const approved = (props.getProperty('SERVICE_HISTORY_ALLOWLIST') ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return approved.includes(email);
}

/**
 * Fetches a vehicle's overview + service history without generating a PDF —
 * lets the client show a preview table so staff can pick which entries to
 * include before generating.
 * Global wrapper — entry point exposed to google.script.run from the client.
 * @param {string} rego
 * @returns {string} JSON-stringified {vehicle, entries}
 */
function previewServiceHistory(rego) {
  try {
    const data = new ServiceHistoryFetcher().fetchByRego(rego);
    logEvent_('Service History: Preview', `rego=${rego} | entries=${data.entries.length}`);
    return JSON.stringify(data);
  } catch (err) {
    logEvent_('Service History: Preview', `rego=${rego} | ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * Global wrapper — the only entry point exposed to google.script.run from
 * the client for actually generating the PDF.
 * @param {string} rego
 * @param {number[]} [selectedEntryIds] - entry IDs to include; omit/undefined
 *   to include every entry (e.g. when called outside the preview/select UI,
 *   such as testGenerateServiceHistory()). An explicit empty array means the
 *   user deliberately deselected everything and is respected as-is.
 */
function generateServiceHistory(rego, selectedEntryIds) {
  Logger.log(`[generateServiceHistory] rego=${rego} | selected=${Array.isArray(selectedEntryIds) ? selectedEntryIds.length : 'all'}`);

  try {
    const data = new ServiceHistoryFetcher().fetchByRego(rego);
    const entryIds = Array.isArray(selectedEntryIds) ? selectedEntryIds : data.entries.map(e => e.id);

    const pdfBlob = new ServiceHistoryPdf().build(data.vehicle, data.entries, entryIds);

    const file = DriveApp.createFile(pdfBlob);
    Logger.log(`[generateServiceHistory] created file=${file.getUrl()}`);

    logEvent_('Service History: Generate PDF', `rego=${rego} | selected=${entryIds.length}/${data.entries.length} | file=${file.getUrl()}`);
    return file.getUrl();
  } catch (err) {
    logEvent_('Service History: Generate PDF', `rego=${rego} | ERROR: ${err.message}`);
    throw err;
  }
}

var ServiceHistoryFetcher = function() {

  const normalizeTaskName_ = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const EXCLUDED_TASKS_ = (PropertiesService.getScriptProperties()
    .getProperty('SERVICE_HISTORY_EXCLUDED_TASKS') || 'Rental Turn Around,Detail')
    .split(',')
    .map(normalizeTaskName_);

  /**
   * Resolves a rego to a Fleetio vehicle, then fetches overview + history.
   * @param {string} rego
   * @returns {{vehicle: Object, entries: Object[]}}
   */
  this.fetchByRego = (rego) => {
    Logger.log(`[ServiceHistoryFetcher.fetchByRego] rego=${rego}`);

    const vehicle = findVehicleByRego_(rego);
    if (!vehicle) throw new Error(`No Fleetio vehicle found for rego "${rego}"`);

    const allEntries = fetchAllServiceEntries_(vehicle.id);
    const entries = allEntries
      .map(stripExcludedTasks_)
      .filter(e => e.service_tasks.length > 0 || e.originalTaskCount === 0);

    Logger.log(`[ServiceHistoryFetcher.fetchByRego] vehicleId=${vehicle.id} | totalEntries=${allEntries.length} | afterExclusion=${entries.length}`);

    return {
      vehicle: mapVehicleOverview_(vehicle),
      entries: entries.map(mapEntry_)
    };
  };

  /**
   * @param {string} rego
   * @returns {Object|null}
   */
  const findVehicleByRego_ = (rego) => {
    const res = fleetioFetch_(`/vehicles?q[license_plate_eq]=${encodeURIComponent(rego)}`);
    const records = res.records || res;
    return records[0] || null;
  };

  /**
   * @param {number} vehicleId
   * @returns {Object[]}
   */
  const fetchAllServiceEntries_ = (vehicleId) => {
    let all = [];
    let page = 1;
    while (true) {
      const res = fleetioFetch_(
        `/vehicles/${vehicleId}/service_entries?q[s]=completed_at+desc&page=${page}&per=100`
      );
      const records = res.records || res;
      all = all.concat(records);
      if (!records.length || records.length < 100) break;
      page++;
    }
    return all;
  };

  /**
   * Drops excluded tasks (e.g. rental turnarounds, detailing) from an
   * entry's task list, without discarding real service work recorded
   * on the same work order.
   * @param {Object} entry
   * @returns {Object}
   */
  const stripExcludedTasks_ = (entry) => {
    const tasks = entry.service_tasks || [];
    const kept = tasks.filter(t => !EXCLUDED_TASKS_.includes(normalizeTaskName_(t.name)));
    return Object.assign({}, entry, { service_tasks: kept, originalTaskCount: tasks.length });
  };

  /**
   * @param {Object} entry
   * @returns {Object}
   */
  const mapEntry_ = (entry) => ({
    id: entry.id,
    vendor: entry.vendor_name || '—',
    taskDescription: (entry.service_tasks || []).map(t => t.name).join(', ') || '—',
    completedAt: entry.completed_at
  });

  /**
   * @param {Object} vehicle
   * @returns {Object}
   */
  const mapVehicleOverview_ = (vehicle) => {
    const cf = vehicle.custom_fields || {};
    return {
      name: vehicle.name,
      make: vehicle.make,
      model: vehicle.model,
      vin: vehicle.vin,
      odometer: vehicle.current_meter_value,
      chassisType: cf.chassis_type || '—',
      waterTightnessResult: cf.water_tightness_expiration || '—', // ⚠️ confirm with Brett — may not be the "test result" field
      waterTightnessWarrantyExpiry: cf.water_tightness_warranty_expiration || '—',
      waterTightnessWarrantyStatus: cf.water_tightness_warranty_status || '—',
      regoExpiry: cf.rego_expiry || '—',
      rucValidity: cf.ruc_valid_until || '—'
    };
  };

  /**
   * @param {string} path
   * @param {string} [apiVersion]
   * @returns {Object}
   */
  const fleetioFetch_ = (path, apiVersion) => {
    const security = new WildernessAppScriptLibrary.FleetioSecurity();
    const options = {
      method: 'GET',
      contentType: 'application/json',
      headers: security.getAuthHeaders(apiVersion),
      muteHttpExceptions: true
    };
    const response = UrlFetchApp.fetch(`https://secure.fleetio.com/api/v1${path}`, options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code !== 200) {
      throw new Error(`[ServiceHistoryFetcher.fleetioFetch_] ${path} → HTTP ${code}: ${body}`);
    }
    return JSON.parse(body);
  };
};

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

    const formattedVehicle = {
      ...vehicle,
      regoExpiry: formatDate_(vehicle.regoExpiry),
      waterTightnessResult: formatDate_(vehicle.waterTightnessResult),
      waterTightnessWarrantyExpiry: formatDate_(vehicle.waterTightnessWarrantyExpiry)
    };

    const template = HtmlService.createTemplateFromFile('ServiceHistoryTemplate');
    template.vehicle = formattedVehicle;
    template.entries = filteredEntries;
    template.generatedOn = formatDate_(new Date());

    const html = template.evaluate().getContent();
    const filename = `Service History - ${vehicle.name}`;

    return Utilities.newBlob(html, 'text/html', `${filename}.html`)
      .getAs('application/pdf')
      .setName(`${filename}.pdf`);
  };

  /**
   * Formats a date in NZ dd/MM/yyyy style. Non-date values (e.g. '—' or a
   * status string like "Valid") are returned unchanged.
   * @param {string|Date} date
   * @returns {string}
   */
  const formatDate_ = (date) => {
    if (!date) return '—';
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) return date;
    return Utilities.formatDate(parsed, 'Pacific/Auckland', 'dd/MM/yyyy');
  };
};
