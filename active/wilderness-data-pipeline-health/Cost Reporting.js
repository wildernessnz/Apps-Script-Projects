/**
 * @fileoverview Wilderness Pipeline — Cloud Run cost summary (MVP). Combines
 * live resource config + usage metrics from three Google Cloud APIs (NOT
 * BigQuery — none of this is pipeline-written data) to estimate
 * current-month Cloud Run spend, split by Service (wilderness-pipeline,
 * the fast/incremental sync targets) vs Job (wilderness-pipeline-job, the
 * 16 reconciliation targets moved there 2026-07-06 — see CLAUDE.md's
 * "Cloud Run JOB for long-running targets" section).
 *
 * SCOPE (deliberately MVP, per 2026-07-06 handoff): current-month running
 * total + Service vs Job split only. No per-connector/per-target cost
 * breakdown, no historical trend across months. Revisit once this proves
 * useful — the pieces here (rate table, usage fetchers) extend naturally
 * to a per-target breakdown if the Cloud Monitoring query is later grouped
 * by a label instead of summed outright, but that's real added complexity
 * (Cloud Run doesn't label billable_instance_time by sync target, only by
 * revision/execution) not attempted here.
 *
 * RATES: hardcoded below, pulled from the Cloud Billing Catalog API
 * (cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus — 152E-
 * C115-5142 is Cloud Run's service ID) for australia-southeast1 on
 * 2026-07-06. These rates are NOT re-queried live on every refresh
 * (SKU-matching the Catalog API's response is fiddly — nested pricing
 * tiers/currency-nanos — and a wrong live parse would silently produce a
 * wrong cost with no way to notice from the sheet alone; a hardcoded,
 * dated, documented constant is safer for an MVP). Re-verify periodically
 * by re-querying that API by hand — Cloud Run pricing changes rarely but
 * not never.
 *
 * BILLING MODE: the Service can run either request-based (CPU only
 * allocated while handling a request — the default) or instance-based
 * (`--no-cpu-throttling`, CPU always allocated) billing, distinguished by
 * the Cloud Run v2 API's `containers[0].resources.cpuIdle` field (true =
 * request-based/throttled, false = instance-based/always-on). Cloud Run
 * JOBS have no such toggle — task containers always run at instance-based
 * rates (there's no "idle between requests" concept for a Job task).
 *
 * USAGE:
 *   - Service: `run.googleapis.com/container/billable_instance_time` via
 *     the Cloud Monitoring API, summed over the current month — this
 *     metric is already "seconds of billable instance time," independent
 *     of billing mode; multiplying by the container's configured CPU/
 *     memory LIMITS (not actual usage) converts it to vCPU-seconds /
 *     GiB-seconds, matching how Cloud Run itself bills (allocation-based,
 *     not measured actual usage).
 *   - Job: summed (completionTime - startTime) x taskCount across
 *     `executions.list` for wilderness-pipeline-job within the current
 *     month, same allocation-based conversion using the Job's container
 *     resource limits. Only COMPLETED executions are counted (a still-
 *     running execution's eventual duration isn't known yet) — this
 *     slightly undercounts the tail end of the month, acceptable for an
 *     MVP running-total.
 *
 * Sheet: "Health - Cost Summary"
 *   resource, billing_mode, cpu_limit_vcpu, memory_limit_gib,
 *   billable_seconds, cpu_cost_usd, memory_cost_usd, total_cost_usd,
 *   period_start, period_end, last_refresh
 *   (plus a final "TOTAL" row summing Service + Job)
 *
 * Requires (in addition to what Scheduled Job Reporting.js / Health Check
 * Reporting.js already need):
 *   - roles/run.viewer on the project, to read Service/Job config and list
 *     Job executions via the Cloud Run Admin API — granted to
 *     mark.lonergan@wilderness.co.nz 2026-07-06:
 *       gcloud projects add-iam-policy-binding wilderness-data \
 *         --member="user:YOUR_EMAIL@wilderness.co.nz" \
 *         --role="roles/run.viewer"
 *   - roles/monitoring.viewer on the project, to read the billable-
 *     instance-time metric via the Cloud Monitoring API — granted to
 *     mark.lonergan@wilderness.co.nz 2026-07-06:
 *       gcloud projects add-iam-policy-binding wilderness-data \
 *         --member="user:YOUR_EMAIL@wilderness.co.nz" \
 *         --role="roles/monitoring.viewer"
 *   - Uses ScriptApp.getOAuthToken() directly (cloud-platform scope
 *     already declared in appsscript.json covers both APIs) — no
 *     impersonation needed, same as Scheduled Job Reporting.js and
 *     Pipeline Logs Reporting.js.
 *
 * Data lives in australia-southeast1 (same region as everything else in
 * this pipeline).
 */

const COST_SHEET    = 'Health - Cost Summary';
const COST_REGION   = 'australia-southeast1';
const COST_SERVICE  = 'wilderness-pipeline';
const COST_JOB      = 'wilderness-pipeline-job';

// Cloud Run pricing, australia-southeast1, confirmed via Cloud Billing
// Catalog API (service 152E-C115-5142) on 2026-07-06. See file header —
// re-verify periodically rather than trusting these indefinitely.
const COST_RATES = {
  requestBased: {
    cpuPerVcpuSecond: 0.0000336,
    memPerGibSecond:  0.0000035,
  },
  instanceBased: {
    cpuPerVcpuSecond: 0.0000216,
    memPerGibSecond:  0.0000024,
  },
};

function refreshCostSummary() {
  new CostReporting().refresh();
}

var CostReporting = function() {

  this.refresh = () => {
    const now = new Date();
    const periodStart = monthStartInZone_(now, 'Pacific/Auckland');
    const periodEnd = now;

    Logger.log(`[CostReporting.refresh] period ${periodStart.toISOString()} -> ${periodEnd.toISOString()}`);

    const serviceRow = computeServiceCost_(periodStart, periodEnd);
    const jobRow = computeJobCost_(periodStart, periodEnd);

    const headers = [
      'resource', 'billing_mode', 'cpu_limit_vcpu', 'memory_limit_gib',
      'billable_seconds', 'cpu_cost_usd', 'memory_cost_usd', 'total_cost_usd',
      'period_start', 'period_end',
    ];

    const periodStartStr = Utilities.formatDate(periodStart, 'Pacific/Auckland', 'yyyy-MM-dd');
    const periodEndStr = Utilities.formatDate(periodEnd, 'Pacific/Auckland', 'yyyy-MM-dd HH:mm');

    const rows = [serviceRow, jobRow].map(r => [
      r.resource, r.billingMode, r.cpuLimitVcpu, r.memLimitGib,
      r.billableSeconds, round4_(r.cpuCost), round4_(r.memCost), round4_(r.cpuCost + r.memCost),
      periodStartStr, periodEndStr,
    ]);

    const totalCpuCost = serviceRow.cpuCost + jobRow.cpuCost;
    const totalMemCost = serviceRow.memCost + jobRow.memCost;
    rows.push([
      'TOTAL', '', '', '', '',
      round4_(totalCpuCost), round4_(totalMemCost), round4_(totalCpuCost + totalMemCost),
      periodStartStr, periodEndStr,
    ]);

    writeToSheet_(COST_SHEET, headers, rows);
  };

  // ── Cost computation ────────────────────────────────────────────────────────

  function computeServiceCost_(periodStart, periodEnd) {
    const config = fetchServiceConfig_();
    const container = config.template.containers[0];
    const cpuLimitVcpu = parseCpu_(container.resources.limits.cpu);
    const memLimitGib = parseMemory_(container.resources.limits.memory);

    // cpuIdle: true (default) = request-based/throttled billing; false =
    // instance-based/always-on billing (--no-cpu-throttling).
    const isInstanceBased = container.resources.cpuIdle === false;
    const billingMode = isInstanceBased ? 'instance-based' : 'request-based';
    const rates = isInstanceBased ? COST_RATES.instanceBased : COST_RATES.requestBased;

    const billableSeconds = fetchBillableInstanceSeconds_(COST_SERVICE, periodStart, periodEnd);

    return {
      resource: `${COST_SERVICE} (Service)`,
      billingMode,
      cpuLimitVcpu,
      memLimitGib,
      billableSeconds,
      cpuCost: billableSeconds * cpuLimitVcpu * rates.cpuPerVcpuSecond,
      memCost: billableSeconds * memLimitGib * rates.memPerGibSecond,
    };
  }

  function computeJobCost_(periodStart, periodEnd) {
    const config = fetchJobConfig_();
    const container = config.template.template.containers[0];
    const cpuLimitVcpu = parseCpu_(container.resources.limits.cpu);
    const memLimitGib = parseMemory_(container.resources.limits.memory);

    // Cloud Run Jobs have no throttled-billing mode — always instance-based.
    const rates = COST_RATES.instanceBased;

    const billableSeconds = fetchJobExecutionSeconds_(periodStart, periodEnd);

    return {
      resource: `${COST_JOB} (Job)`,
      billingMode: 'instance-based',
      cpuLimitVcpu,
      memLimitGib,
      billableSeconds,
      cpuCost: billableSeconds * cpuLimitVcpu * rates.cpuPerVcpuSecond,
      memCost: billableSeconds * memLimitGib * rates.memPerGibSecond,
    };
  }

  // ── Cloud Run Admin API ─────────────────────────────────────────────────────

  function fetchServiceConfig_() {
    const url = `https://run.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${COST_REGION}/services/${COST_SERVICE}`;
    return fetchRunAdminJson_(url);
  }

  function fetchJobConfig_() {
    const url = `https://run.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${COST_REGION}/jobs/${COST_JOB}`;
    return fetchRunAdminJson_(url);
  }

  /**
   * Sum (completionTime - startTime) x taskCount across all COMPLETED
   * executions of wilderness-pipeline-job whose startTime falls within
   * [periodStart, periodEnd]. Only completed executions are counted (see
   * file header doc) — a currently-running execution is excluded until it
   * finishes.
   */
  function fetchJobExecutionSeconds_(periodStart, periodEnd) {
    const url = `https://run.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${COST_REGION}/jobs/${COST_JOB}/executions`;
    let seconds = 0;
    let pageToken = null;

    do {
      const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
      const data = fetchRunAdminJson_(pageUrl);
      const executions = data.executions || [];

      executions.forEach(exec => {
        if (!exec.startTime || !exec.completionTime) return; // not yet completed
        const start = new Date(exec.startTime);
        if (start < periodStart || start > periodEnd) return;

        const end = new Date(exec.completionTime);
        const durationSeconds = (end.getTime() - start.getTime()) / 1000;
        const taskCount = exec.taskCount || 1;
        seconds += durationSeconds * taskCount;
      });

      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return seconds;
  }

  function fetchRunAdminJson_(url) {
    const options = {
      method: 'get',
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 401 || code === 403) {
      throw new Error(
        `Cloud Run Admin API auth failed (${code}) for ${url}. The Apps Script identity needs ` +
        `roles/run.viewer on the project — see file header doc for the grant command.`
      );
    }
    if (code !== 200) {
      throw new Error(`Cloud Run Admin API error ${code} for ${url}: ${response.getContentText()}`);
    }

    return JSON.parse(response.getContentText());
  }

  // ── Cloud Monitoring API ────────────────────────────────────────────────────

  /**
   * Sum run.googleapis.com/container/billable_instance_time (a DELTA
   * metric, unit seconds) for the given Cloud Run service across
   * [periodStart, periodEnd].
   */
  function fetchBillableInstanceSeconds_(serviceName, periodStart, periodEnd) {
    const filter = [
      'metric.type="run.googleapis.com/container/billable_instance_time"',
      `resource.labels.service_name="${serviceName}"`,
    ].join(' AND ');

    const params = [
      `filter=${encodeURIComponent(filter)}`,
      `interval.startTime=${encodeURIComponent(periodStart.toISOString())}`,
      `interval.endTime=${encodeURIComponent(periodEnd.toISOString())}`,
      'aggregation.alignmentPeriod=' + encodeURIComponent(`${Math.max(60, Math.floor((periodEnd - periodStart) / 1000))}s`),
      'aggregation.perSeriesAligner=ALIGN_SUM',
      'aggregation.crossSeriesReducer=REDUCE_SUM',
    ].join('&');

    const url = `https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT_ID}/timeSeries?${params}`;

    const options = {
      method: 'get',
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 401 || code === 403) {
      throw new Error(
        `Cloud Monitoring API auth failed (${code}). The Apps Script identity needs ` +
        `roles/monitoring.viewer on the project — see file header doc for the grant command.`
      );
    }
    if (code !== 200) {
      throw new Error(`Cloud Monitoring API error ${code}: ${response.getContentText()}`);
    }

    const data = JSON.parse(response.getContentText());
    const timeSeries = data.timeSeries || [];

    let total = 0;
    timeSeries.forEach(series => {
      (series.points || []).forEach(point => {
        const value = point.value.doubleValue ?? point.value.int64Value ?? 0;
        total += Number(value);
      });
    });

    return total;
  }

  // ── Parsing helpers ─────────────────────────────────────────────────────────

  /**
   * Parse a Cloud Run CPU limit string ("1", "2", "1000m", "500m") into
   * whole/fractional vCPUs.
   */
  function parseCpu_(cpuStr) {
    if (!cpuStr) return 0;
    if (cpuStr.endsWith('m')) return parseFloat(cpuStr) / 1000;
    return parseFloat(cpuStr);
  }

  /**
   * Parse a Cloud Run memory limit string ("512Mi", "1Gi", "2048Mi") into
   * GiB.
   */
  function parseMemory_(memStr) {
    if (!memStr) return 0;
    if (memStr.endsWith('Gi')) return parseFloat(memStr);
    if (memStr.endsWith('Mi')) return parseFloat(memStr) / 1024;
    if (memStr.endsWith('Ki')) return parseFloat(memStr) / (1024 * 1024);
    return parseFloat(memStr) / (1024 * 1024 * 1024); // assume raw bytes
  }

  function monthStartInZone_(date, timeZone) {
    const dateStr = Utilities.formatDate(date, timeZone, 'yyyy-MM');
    return new Date(`${dateStr}-01T00:00:00`);
  }

  function round4_(n) {
    return Math.round(n * 10000) / 10000;
  }

  const writeToSheet_ = (sheetName, headers, data) => {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`[CostReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[CostReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[CostReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};
