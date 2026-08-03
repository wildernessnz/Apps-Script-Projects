/**
 * @fileoverview Fetches vehicle overview + service history from Fleetio,
 * resolved by rego. SSP-3650 POC.
 */

function testGetServiceHistory() {
  const history = new ServiceHistoryFetcher().fetchByRego('ABC123');
  Logger.log(history);
}

var ServiceHistoryFetcher = function() {

  const EXCLUDED_TASKS_ = (PropertiesService.getScriptProperties()
    .getProperty('EXCLUDED_SERVICE_TASKS') || 'Rental Turnaround,Detailing')
    .split(',')
    .map(t => t.trim().toLowerCase());

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
    const entries = allEntries.filter(e => !isExcluded_(e));

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
   * @param {Object} entry
   * @returns {boolean}
   */
  const isExcluded_ = (entry) => {
    const taskNames = (entry.service_tasks || []).map(t => t.name.toLowerCase());
    return taskNames.some(name => EXCLUDED_TASKS_.includes(name));
  };

  /**
   * @param {Object} entry
   * @returns {Object}
   */
  const mapEntry_ = (entry) => ({
    id: entry.id,
    vendor: entry.vendor ? entry.vendor.name : '—',
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