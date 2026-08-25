/**
 * @fileoverview CIN Generator — generates a branded Consumer Information
 * Notice PDF for a used motorhome sale, resolved by rego via Fleetio.
 * The sales team fills in the handful of fields Fleetio doesn't carry;
 * the notice's two back pages (regulatory text) are static and identical
 * on every PDF — see CINGeneratorTemplate.html.
 *
 * Fleetio lookup follows the same shape as ServiceHistoryLogic.gs's
 * ServiceHistoryFetcher (rego → /vehicles?q[license_plate_eq]=... via
 * WildernessAppScriptLibrary.FleetioSecurity()) — no shared Fleetio helper
 * module exists yet, so this is a small adapted copy, not an import.
 */

const CIN_TRADER_REGISTRATION_NUMBER = 'M374985';
const CIN_BRANCH_ADDRESSES = {
  AKL: '11 Pavilion Drive, Airport Oaks, Auckland',
  CHC: '3 Export Ave, Harewood, Christchurch',
};

/**
 * Used by ContentLoader.gs to gate this tool's content behind
 * CIN_GENERATOR_ALLOWLIST before the sidebar-shared shell renders it —
 * same pattern as isServiceHistoryApproved()/isWeatherAlertApproved().
 * @returns {boolean}
 */
function isCinGeneratorApproved() {
  const email = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props = PropertiesService.getScriptProperties();
  const approved = (props.getProperty('CIN_GENERATOR_ALLOWLIST') ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return approved.includes(email);
}

/**
 * Global wrapper — resolves a rego to a Fleetio vehicle and maps the
 * notice's Fleetio-sourced fields. Exposed to google.script.run.
 * @param {string} rego
 * @returns {string} JSON-stringified vehicle field map
 */
function lookupCinVehicle(rego) {
  try {
    const vehicle = new CinVehicleFetcher().fetchByRego(rego);
    logEvent_('CIN Generator: Lookup', `rego=${rego}`);
    return JSON.stringify(vehicle);
  } catch (err) {
    logEvent_('CIN Generator: Lookup', `rego=${rego} | ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * Global wrapper — the only entry point exposed to google.script.run for
 * actually generating the notice PDF. Takes the vehicle fields the client
 * already has from lookupCinVehicle() rather than re-fetching Fleetio —
 * deliberately avoiding the redundant-refetch pattern flagged as a known
 * inefficiency for Service History (README "Still open / deferred" #8).
 * @param {Object} payload
 * @param {Object} payload.vehicle - object returned by lookupCinVehicle (parsed, not the JSON string)
 * @param {string} payload.branch - 'AKL' or 'CHC', selects the letterhead address
 * @param {Object} payload.manual - team-entered fields (see CinNoticePdf.build)
 * @returns {string} Drive file URL
 */
function generateCinNotice(payload) {
  const rego = payload && payload.vehicle && payload.vehicle.plateNumber;
  Logger.log(`[generateCinNotice] rego=${rego} | branch=${payload && payload.branch}`);
  const startedAt = Date.now();

  try {
    const pdfBlob = new CinNoticePdf().build(payload);
    const file = DriveApp.createFile(pdfBlob);
    const durationMs = Date.now() - startedAt;

    logEvent_('CIN Generator: Generate PDF', `rego=${rego} | branch=${payload.branch} | file=${file.getUrl()} | duration=${(durationMs / 1000).toFixed(2)}s`);
    return file.getUrl();
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logEvent_('CIN Generator: Generate PDF', `rego=${rego} | ERROR: ${err.message} | duration=${(durationMs / 1000).toFixed(2)}s`);
    throw err;
  }
}

var CinVehicleFetcher = function() {

  /**
   * Resolves a rego to a Fleetio vehicle and maps it to the notice's
   * Fleetio-sourced fields (see the field-mapping sheet linked from
   * SSP for the full field-by-field source list).
   * @param {string} rego
   * @returns {Object}
   */
  this.fetchByRego = (rego) => {
    const vehicle = findVehicleByRego_(rego);
    if (!vehicle) throw new Error(`No Fleetio vehicle found for rego "${rego}"`);
    return mapVehicle_(vehicle);
  };

  /**
   * @param {Object} vehicle - raw Fleetio vehicle record
   * @returns {Object}
   */
  const mapVehicle_ = (vehicle) => {
    const cf = vehicle.custom_fields || {};
    const fuelType = vehicle.fuel_type_name || '—';
    return {
      makeModel: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—',
      vehicleYear: cf.model_year || '—',
      engineCapacity: vehicle.engine_description || '—',
      odometer: formatKm_(vehicle.current_meter_value),
      vin: vehicle.vin || '—',
      plateNumber: vehicle.license_plate || '—',
      cashPrice: formatCurrency_(cf.retail_price_nz),
      regoExpiry: formatDate_(cf.rego_expiry),
      // Only the year is shown on the notice, per the field-mapping sheet.
      yearRegisteredNz: cf.first_nz_registration ? String(cf.first_nz_registration).slice(0, 4) : '—',
      fuelType,
      // Derived, not entered: road user charges apply to diesel vehicles.
      // Fleet is currently all diesel motorhomes; revisit the >3500kg weight
      // threshold in the RUC rules if a non-diesel vehicle is ever listed.
      rucApplies: /diesel/i.test(fuelType),
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
   * @param {string} path
   * @returns {Object}
   */
  const fleetioFetch_ = (path) => {
    const security = new WildernessAppScriptLibrary.FleetioSecurity();
    const response = UrlFetchApp.fetch(`https://secure.fleetio.com/api/v1${path}`, {
      method: 'GET',
      contentType: 'application/json',
      headers: security.getAuthHeaders(),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code !== 200) {
      throw new Error(`[CinVehicleFetcher.fleetioFetch_] ${path} → HTTP ${code}: ${body}`);
    }
    return JSON.parse(body);
  };

  /**
   * @param {string|Date} date
   * @returns {string}
   */
  const formatDate_ = (date) => {
    if (!date) return '—';
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) return String(date);
    return Utilities.formatDate(parsed, 'Pacific/Auckland', 'dd/MM/yyyy');
  };

  /**
   * @param {string|number} value
   * @returns {string}
   */
  const formatKm_ = (value) => {
    if (value == null || value === '') return '—';
    const num = parseFloat(String(value).replace(/,/g, ''));
    if (isNaN(num)) return String(value);
    return `${Math.round(num).toLocaleString('en-NZ')} km`;
  };

  /**
   * @param {string|number} value - Fleetio's retail_price_nz custom field is
   *   free text, entered with a thousands separator (e.g. "129,900") — strip
   *   commas before parseFloat, which otherwise silently truncates at the
   *   first comma (parseFloat("129,900") === 129, not 129900).
   * @returns {string}
   */
  const formatCurrency_ = (value) => {
    if (value == null || value === '') return '—';
    const num = parseFloat(String(value).replace(/,/g, ''));
    if (isNaN(num)) return String(value);
    return `$${Math.round(num).toLocaleString('en-NZ')}`;
  };
};

var CinNoticePdf = function() {

  /**
   * @param {Object} payload - see generateCinNotice's @param docs
   * @returns {Blob} PDF blob
   */
  this.build = (payload) => {
    const vehicle = payload.vehicle;
    const manual = payload.manual || {};

    const template = HtmlService.createTemplateFromFile('CINGeneratorTemplate');
    template.vehicle = vehicle;
    template.manual = manual;
    template.branchAddress = CIN_BRANCH_ADDRESSES[payload.branch] || '';
    template.traderRegistrationNumber = CIN_TRADER_REGISTRATION_NUMBER;

    const html = template.evaluate().getContent();
    const filename = `CIN Notice - ${vehicle.plateNumber}`;

    return Utilities.newBlob(html, 'text/html', `${filename}.html`)
      .getAs('application/pdf')
      .setName(`${filename}.pdf`);
  };
};
