/**
 * @fileoverview Wilderness Pipeline — Scheduled Jobs Dashboard. Pulls
 * Cloud Scheduler job configuration and state directly from the Cloud
 * Scheduler REST API (NOT BigQuery — job state lives in Cloud Scheduler
 * itself, not in any table this pipeline writes to) and computes each
 * job's next scheduled run time client-side.
 *
 * WHY CLIENT-SIDE NEXT-RUN CALCULATION: Cloud Scheduler's REST API
 * (projects.locations.jobs.list / .get) does NOT expose a "next run
 * time" field — only schedule (the raw cron string), timeZone,
 * lastAttemptTime, and state. There's no API call that returns "when
 * will this fire next." This file computes it by parsing the cron
 * expression directly. parseNextRun_() below handles the specific cron
 * patterns actually in use across this pipeline's scheduler jobs
 * (every-N-minutes via /N, and fixed hour:minute daily via "M H * * *")
 * — it is NOT a general-purpose cron parser and will return null for
 * patterns outside what's listed in its comments. Extend it if a future
 * schedule uses a pattern it doesn't yet handle.
 *
 * Sheet: "Scheduled Jobs"
 *   job_id, state, schedule, time_zone, last_attempt_time,
 *   last_attempt_status, next_run_estimate, last_refresh
 *
 * Requires:
 *   - GCP_PROJECT_ID declared in its own file (shared global scope)
 *   - The running user/script identity must have at least
 *     roles/cloudscheduler.viewer on the project (Cloud Scheduler Admin
 *     also works, but Viewer is the minimum needed for read-only listing).
 *     Grant via:
 *       gcloud projects add-iam-policy-binding wilderness-data \
 *         --member="user:YOUR_EMAIL@wilderness.co.nz" \
 *         --role="roles/cloudscheduler.viewer"
 *
 * Data lives in australia-southeast1 (Cloud Scheduler location used by
 * this pipeline's jobs).
 */

const SCHEDULER_LOCATION = 'australia-southeast1';
const SCHEDULER_SHEET    = 'Scheduled Jobs';

function refreshScheduledJobs() {
  new ScheduledJobsReporting().refresh();
}

var ScheduledJobsReporting = function() {

  this.refresh = () => {
    Logger.log('[ScheduledJobsReporting.refresh] fetching jobs from Cloud Scheduler...');
    const jobs = fetchSchedulerJobs_();
    Logger.log(`[ScheduledJobsReporting.refresh] fetched ${jobs.length} jobs`);

    const headers = [
      'job_id', 'state', 'schedule', 'schedule_readable', 'time_zone',
      'last_attempt_time', 'last_attempt_status', 'next_run_estimate',
    ];

    const rows = jobs.map(job => {
      const jobId = job.name.split('/').pop();
      const lastAttempt = job.lastAttemptTime
        ? Utilities.formatDate(new Date(job.lastAttemptTime), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss')
        : '';

      // FIX: a job that has never run at all returns a placeholder
      // status object from the API (observed: {code: -1} with no message)
      // rather than omitting `status` entirely. The original logic checked
      // `job.status` truthiness first, which misclassified every
      // never-run job as "error (code -1)". lastAttemptTime presence is
      // the reliable signal for "has this ever actually run" — check that
      // FIRST, and only look at job.status.code for jobs that have a real
      // attempt on record. A genuine non-zero gRPC status code (these
      // follow Google's google.rpc.Code enum, where 0 = OK) on a job that
      // HAS run is a real error; the same code on a job that has NEVER
      // run is just the API's empty placeholder, not a real failure.
      let lastStatus;
      if (!job.lastAttemptTime) {
        lastStatus = 'never run';
      } else if (job.status && job.status.code) {
        lastStatus = `error (code ${job.status.code}): ${job.status.message || ''}`;
      } else {
        lastStatus = 'success';
      }

      const nextRun = parseNextRun_(job.schedule, job.timeZone || 'UTC');
      const nextRunStr = nextRun
        ? Utilities.formatDate(nextRun, 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss')
        : '(unrecognized schedule pattern)';

      const readable = describeSchedule_(job.schedule, job.timeZone || 'UTC');

      return [jobId, job.state, job.schedule, readable, job.timeZone || 'UTC', lastAttempt, lastStatus, nextRunStr];
    });

    rows.sort((a, b) => a[0].localeCompare(b[0]));

    writeToSheet_(SCHEDULER_SHEET, headers, rows);
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  function fetchSchedulerJobs_() {
    const url = `https://cloudscheduler.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${SCHEDULER_LOCATION}/jobs`;
    const options = {
      method: 'get',
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      },
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 401 || code === 403) {
      throw new Error(
        `Cloud Scheduler API auth failed (${code}). The Apps Script identity needs ` +
        `roles/cloudscheduler.viewer on the project — see file header doc for the grant command.`
      );
    }

    if (code !== 200) {
      throw new Error(`Cloud Scheduler API error ${code}: ${response.getContentText()}`);
    }

    const data = JSON.parse(response.getContentText());
    return data.jobs || [];
  }

  /**
   * Compute the next run time for a cron schedule, handling ONLY the
   * specific patterns actually used by this pipeline's scheduler jobs.
   * Returns null for any pattern not recognized below — NOT a general
   * cron parser.
   *
   * Recognized patterns:
   *   "*\/N * * * *"   — every N minutes
   *   "M * * * *"      — hourly at fixed minute M
   *   "M H * * *"      — daily at fixed hour H, minute M
   *   "M H * * D"      — weekly, on day-of-week D (0=Sunday..6=Saturday),
   *                      at fixed hour H, minute M — used by all 9
   *                      reconciliation jobs (e.g. "0 1 * * 0" = Sunday
   *                      01:00). This pattern was MISSING entirely until
   *                      now — every reconciliation job showed
   *                      "(unrecognized schedule pattern)" as a result.
   *
   * @param {string} cronExpr
   * @param {string} timeZone
   * @returns {Date|null}
   */
  function parseNextRun_(cronExpr, timeZone) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (dayOfMonth !== '*' || month !== '*') {
      return null; // day-of-month / month restrictions not handled — none of this pipeline's jobs use them
    }

    const now = new Date();

    // Pattern: */N * * * * — every N minutes (dayOfWeek must be '*' too)
    const everyNMatch = minute.match(/^\*\/(\d+)$/);
    if (everyNMatch && hour === '*' && dayOfWeek === '*') {
      const n = parseInt(everyNMatch[1], 10);
      const nowUtcMinutes = now.getUTCMinutes();
      const minutesUntilNext = n - (nowUtcMinutes % n);
      const next = new Date(now.getTime());
      next.setUTCSeconds(0, 0);
      next.setUTCMinutes(nowUtcMinutes + minutesUntilNext);
      return next;
    }

    const fixedMinuteOnly = parseInt(minute, 10);

    // Pattern: M * * * * — hourly at fixed minute M (dayOfWeek must be '*')
    if (!isNaN(fixedMinuteOnly) && hour === '*' && dayOfWeek === '*' && !everyNMatch) {
      const next = new Date(now.getTime());
      next.setUTCSeconds(0, 0);
      next.setUTCMinutes(fixedMinuteOnly);
      if (next <= now) {
        next.setUTCHours(next.getUTCHours() + 1);
      }
      return next;
    }

    const fixedMinute = parseInt(minute, 10);
    const fixedHour = parseInt(hour, 10);
    if (isNaN(fixedMinute) || isNaN(fixedHour)) return null;

    // Build "today at H:M in timeZone" as the candidate next run.
    const targetToday = new Date(
      Utilities.formatDate(now, timeZone, 'yyyy-MM-dd') + 'T00:00:00'
    );
    targetToday.setHours(fixedHour, fixedMinute, 0, 0);

    const nowInZone = new Date(
      Utilities.formatDate(now, timeZone, "yyyy-MM-dd'T'HH:mm:ss")
    );

    // Pattern: M H * * * — daily (dayOfWeek === '*')
    if (dayOfWeek === '*') {
      let next = new Date(targetToday.getTime());
      if (next <= nowInZone) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    // Pattern: M H * * D — weekly on a specific day-of-week (0=Sun..6=Sat).
    // Previously entirely unhandled (fell through to the final `return
    // null`), causing every weekly reconciliation job to show
    // "(unrecognized schedule pattern)".
    const targetDow = parseInt(dayOfWeek, 10);
    if (!isNaN(targetDow) && targetDow >= 0 && targetDow <= 6) {
      let next = new Date(targetToday.getTime());
      // getDay() in the candidate date's OWN local representation — since
      // targetToday was built from a timeZone-formatted date string, its
      // getDay() reflects that zone's calendar day, which is what we want
      // to compare against targetDow.
      let daysUntilTarget = (targetDow - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysUntilTarget);

      // If we landed on today but the time has already passed, push a
      // full week forward rather than re-checking — daysUntilTarget being
      // 0 with a past time means "today's occurrence already happened."
      if (daysUntilTarget === 0 && next <= nowInZone) {
        next.setDate(next.getDate() + 7);
      }
      return next;
    }

    return null;
  }

  /**
   * Generate a human-readable description of a cron schedule, mirroring
   * the same patterns parseNextRun_() recognizes (so the two never
   * silently disagree about what's "recognized").
   *
   * @param {string} cronExpr
   * @param {string} timeZone
   * @returns {string}
   */
  function describeSchedule_(cronExpr, timeZone) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return cronExpr;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (dayOfMonth !== '*' || month !== '*') {
      return cronExpr;
    }

    const everyNMatch = minute.match(/^\*\/(\d+)$/);
    if (everyNMatch && hour === '*' && dayOfWeek === '*') {
      const n = parseInt(everyNMatch[1], 10);
      return `Every ${n} minute${n === 1 ? '' : 's'}`;
    }

    const fixedMinuteOnly = parseInt(minute, 10);
    if (!isNaN(fixedMinuteOnly) && hour === '*' && dayOfWeek === '*' && !everyNMatch) {
      return fixedMinuteOnly === 0
        ? 'Hourly, on the hour'
        : `Hourly, at minute ${fixedMinuteOnly}`;
    }

    const fixedMinute = parseInt(minute, 10);
    const fixedHour = parseInt(hour, 10);
    if (isNaN(fixedMinute) || isNaN(fixedHour)) return cronExpr;

    const timeStr = `${String(fixedHour).padStart(2, '0')}:${String(fixedMinute).padStart(2, '0')}`;

    if (dayOfWeek === '*') {
      return `Daily at ${timeStr} ${timeZone}`;
    }

    const targetDow = parseInt(dayOfWeek, 10);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (!isNaN(targetDow) && targetDow >= 0 && targetDow <= 6) {
      return `Weekly on ${dayNames[targetDow]} at ${timeStr} ${timeZone}`;
    }

    return cronExpr;
  }

  const writeToSheet_ = (sheetName, headers, data) => {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`[ScheduledJobsReporting.writeToSheet_] created sheet=${sheetName}`);
    }

    sheet.clearContents();

    const headersWithRefresh = [...headers, 'last_refresh'];

    if (!data || !data.length) {
      sheet.getRange(1, 1, 1, headersWithRefresh.length).setValues([headersWithRefresh]);
      Logger.log(`[ScheduledJobsReporting.writeToSheet_] sheet=${sheetName} no data returned`);
      return;
    }

    const refreshedAt = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm:ss');
    const dataWithRefresh = data.map(row => [...row, refreshedAt]);
    const output = [headersWithRefresh, ...dataWithRefresh];

    sheet.getRange(1, 1, output.length, headersWithRefresh.length).setValues(output);

    sheet.getRange(1, 1, 1, headersWithRefresh.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    Logger.log(`[ScheduledJobsReporting.writeToSheet_] sheet=${sheetName} rows=${data.length}`);
  };

};