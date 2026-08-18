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
  const startedAt = Date.now();

  try {
    const fetcher = new ServiceHistoryFetcher();
    const data = fetcher.fetchByRego(rego);
    const entryIds = Array.isArray(selectedEntryIds) ? selectedEntryIds : data.entries.map(e => e.id);

    // Per-task notes and the odometer reading aren't in the list response
    // used above — fetch them only for entries actually going into the PDF,
    // so the preview step (which loads every entry) doesn't pay for a call
    // per entry. Fetched as one batch (see fetchEntryDetailsBatch) rather
    // than one-by-one.
    const selectedSet = new Set(entryIds);
    const selectedEntries = data.entries.filter(e => selectedSet.has(e.id));
    const detailsById = new Map(
      fetcher.fetchEntryDetailsBatch(selectedEntries, data.vehicleId).map(d => [d.id, d])
    );
    const entriesWithTasks = data.entries.map(e =>
      detailsById.has(e.id) ? Object.assign({}, e, detailsById.get(e.id)) : e
    );

    const pdfBlob = new ServiceHistoryPdf().build(data.vehicle, entriesWithTasks, entryIds);

    const file = DriveApp.createFile(pdfBlob);
    const durationMs = Date.now() - startedAt;
    Logger.log(`[generateServiceHistory] created file=${file.getUrl()} | durationMs=${durationMs}`);

    logEvent_('Service History: Generate PDF', `rego=${rego} | selected=${entryIds.length}/${data.entries.length} | file=${file.getUrl()} | duration=${(durationMs / 1000).toFixed(2)}s`);
    return file.getUrl();
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logEvent_('Service History: Generate PDF', `rego=${rego} | ERROR: ${err.message} | duration=${(durationMs / 1000).toFixed(2)}s`);
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
      vehicleId: vehicle.id,
      entries: entries.map(mapEntry_)
    };
  };

  /**
   * Fetches per-task notes and the odometer reading for a batch of service
   * entries — one round trip (via UrlFetchApp.fetchAll) instead of one
   * sequential call per entry. The list endpoint used by fetchByRego only
   * returns task names, not the free-text note recorded against each task —
   * that lives on the entry's line items, which Fleetio only exposes via
   * the single-entry v2 endpoint (no bulk/vehicle-scoped equivalent
   * exists). The same v2 response also carries the entry's own meter
   * reading, so the odometer is resolved here for free when present.
   *
   * If any entry in the batch lacks its own meter reading, the vehicle's
   * full Meter Entry history is fetched once (not per entry) and reused
   * in memory to find each such entry's nearest reading — entries sharing
   * the same gap in meter data (the common case) no longer trigger
   * duplicate lookups of the same record.
   * @param {{id: number, completedAt: string}[]} entries
   * @param {number} vehicleId
   * @returns {{id: number, tasks: {name: string, note: string|null}[], odometer: {value: string, date: (string|null), isEstimated: boolean}}[]}
   */
  this.fetchEntryDetailsBatch = (entries, vehicleId) => {
    if (!entries.length) return [];

    const requests = entries.map(e => buildFleetioRequest_(`/service_entries/${e.id}`, 'v2'));
    const responses = UrlFetchApp.fetchAll(requests);
    const fullEntries = responses.map((res, i) => parseFleetioResponse_(res, `/service_entries/${entries[i].id}`));

    const needsFallback = fullEntries.some(full => !full.meter_entry || full.meter_entry.value == null);
    const meterEntries = needsFallback ? fetchAllMeterEntries_(vehicleId) : [];

    return fullEntries.map((full, i) => {
      const lineItems = (full.service_entry_line_items || [])
        .filter(li => li.type === 'ServiceEntryServiceTaskLineItem' && !li.service_entry_line_item_id);

      const tasks = lineItems
        .map(li => ({ name: (li.service_task && li.service_task.name) || '—', note: li.description || null }))
        .filter(t => !EXCLUDED_TASKS_.includes(normalizeTaskName_(t.name)));

      const odometer = resolveOdometer_(full.meter_entry, entries[i].completedAt, meterEntries);

      return { id: entries[i].id, tasks, odometer };
    });
  };

  /**
   * Resolves the odometer reading to show for a service entry: its own
   * recorded meter reading if it has one, otherwise the nearest reading
   * from the vehicle's already-fetched Meter Entry history.
   * @param {Object|null} meterEntry - the entry's own primary meter_entry, if any
   * @param {string} completedAt
   * @param {Object[]} meterEntries - the vehicle's full Meter Entry history
   *   (only consulted when meterEntry is absent)
   * @returns {{value: string, date: (string|null), isEstimated: boolean}}
   */
  const resolveOdometer_ = (meterEntry, completedAt, meterEntries) => {
    if (meterEntry && meterEntry.value != null) {
      return { value: meterEntry.value, date: null, isEstimated: false };
    }
    const targetIso = Utilities.formatDate(new Date(completedAt), 'UTC', 'yyyy-MM-dd');
    const nearest = findNearestMeterEntry_(meterEntries, targetIso);
    if (!nearest) return { value: '—', date: null, isEstimated: false };
    return { value: nearest.value, date: nearest.date, isEstimated: true };
  };

  /**
   * Finds the Meter Entry nearest a target date from an already-fetched,
   * in-memory list — no API call.
   * @param {Object[]} meterEntries
   * @param {string} targetIso
   * @returns {Object|null}
   */
  const findNearestMeterEntry_ = (meterEntries, targetIso) => {
    if (!meterEntries.length) return null;
    const target = new Date(targetIso).getTime();
    let nearest = meterEntries[0];
    let nearestDiff = Math.abs(new Date(nearest.date).getTime() - target);
    for (let i = 1; i < meterEntries.length; i++) {
      const diff = Math.abs(new Date(meterEntries[i].date).getTime() - target);
      if (diff < nearestDiff) {
        nearest = meterEntries[i];
        nearestDiff = diff;
      }
    }
    return nearest;
  };

  /**
   * Fetches the vehicle's entire Meter Entry history (paginated, same
   * pattern as fetchAllServiceEntries_) — called at most once per PDF
   * generation, only when at least one selected entry needs the fallback.
   * @param {number} vehicleId
   * @returns {Object[]}
   */
  const fetchAllMeterEntries_ = (vehicleId) => {
    let all = [];
    let page = 1;
    while (true) {
      const res = fleetioFetch_(`/meter_entries?q[vehicle_id_eq]=${vehicleId}&q[s]=date+asc&page=${page}&per=100`);
      const records = res.records || res;
      all = all.concat(records);
      if (!records.length || records.length < 100) break;
      page++;
    }
    return all;
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
    vendor: entry.vendor_name || 'Wilderness Motorhomes Auckland',
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
   * Builds a UrlFetchApp request descriptor for one Fleetio call — shared by
   * fleetioFetch_ (single call) and fetchEntryDetailsBatch's UrlFetchApp.fetchAll
   * (many calls in one round trip).
   * @param {string} path
   * @param {string} [urlVersion] - 'v1' (default) or 'v2'; selects which API
   *   version's URL prefix to call. Fleetio's task-note data (see
   *   fetchEntryDetailsBatch) only exists under v2's single-entry endpoint.
   * @returns {Object}
   */
  const buildFleetioRequest_ = (path, urlVersion) => {
    const security = new WildernessAppScriptLibrary.FleetioSecurity();
    return {
      url: `https://secure.fleetio.com/api/${urlVersion || 'v1'}${path}`,
      method: 'GET',
      contentType: 'application/json',
      headers: security.getAuthHeaders(),
      muteHttpExceptions: true
    };
  };

  /**
   * @param {HTTPResponse} response
   * @param {string} path - only used for the error message on failure
   * @returns {Object}
   */
  const parseFleetioResponse_ = (response, path) => {
    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code !== 200) {
      throw new Error(`[ServiceHistoryFetcher.fleetioFetch_] ${path} → HTTP ${code}: ${body}`);
    }
    return JSON.parse(body);
  };

  /**
   * @param {string} path
   * @param {string} [urlVersion] - 'v1' (default) or 'v2'
   * @returns {Object}
   */
  const fleetioFetch_ = (path, urlVersion) => {
    const request = buildFleetioRequest_(path, urlVersion);
    const response = UrlFetchApp.fetch(request.url, request);
    return parseFleetioResponse_(response, path);
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
      .map(e => ({
        ...e,
        completedAtFormatted: formatDate_(e.completedAt),
        odometer: e.odometer && {
          ...e.odometer,
          dateFormatted: e.odometer.isEstimated ? formatDate_(e.odometer.date) : null
        }
      }));

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
