// ============================================================
// Code.gs — Recurring Task Engine (Server-Side Logic)
// ============================================================

// --- Web App Entry Point ---

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Recurring Task Engine')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// ============================================================
// SCHEDULE CRUD — backed by Google Sheets as a simple DB
// ============================================================

/**
 * Returns the active Spreadsheet, creating the Schedules sheet on first run.
 */
function getSheet_() {
  Logger.log('[getSheet_] Opening spreadsheet ID: %s', CONFIG.SHEET_ID);
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName('Schedules');

  if (!sheet) {
    Logger.log('[getSheet_] "Schedules" sheet not found — creating it now');
    sheet = ss.insertSheet('Schedules');
    sheet.appendRow([
      'ID', 'Task Name', 'Department', 'Start Date',
      'Recurrence Value', 'Recurrence Unit',
      'Due Date Offset Value', 'Due Date Offset Unit',
      'Last Created', 'Next Due', 'Active', 'Created At'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 12).setFontWeight('bold');
    Logger.log('[getSheet_] Sheet created and headers written');
  } else {
    Logger.log('[getSheet_] "Schedules" sheet found');
  }

  return sheet;
}

/**
 * Returns the Log sheet, creating it if it doesn't exist.
 */
function getLogSheet_() {
  Logger.log('[getLogSheet_] Opening log sheet');
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName('Creation Log');

  if (!sheet) {
    Logger.log('[getLogSheet_] "Creation Log" sheet not found — creating it now');
    sheet = ss.insertSheet('Creation Log');
    sheet.appendRow([
      'Timestamp', 'Jira Issue Key', 'Jira Issue URL',
      'Task Name', 'Department', 'Due Date',
      'Schedule ID', 'Recurs Every', 'Triggered By'
    ]);
    sheet.setFrozenRows(1);
    const header = sheet.getRange(1, 1, 1, 9);
    header.setFontWeight('bold');
    header.setBackground('#1c2030');
    header.setFontColor('#ffffff');
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 280);
    sheet.setColumnWidth(4, 220);
    sheet.setColumnWidth(5, 160);
    sheet.setColumnWidth(6, 110);
    sheet.setColumnWidth(7, 280);
    sheet.setColumnWidth(8, 120);
    sheet.setColumnWidth(9, 120);
    Logger.log('[getLogSheet_] Sheet created and headers written');
  } else {
    Logger.log('[getLogSheet_] "Creation Log" sheet found');
  }

  return sheet;
}

/**
 * Writes a row to the Creation Log sheet after a Jira issue is created.
 */
function logIssueCreated_(issue, schedule, triggeredBy) {
  Logger.log('[logIssueCreated_] Logging issue %s for schedule "%s"', issue.key, schedule.taskName);
  try {
    const logSheet = getLogSheet_();
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const issueUrl = `${CONFIG.JIRA_BASE_URL}/browse/${issue.key}`;
    const dueDate = calculateDueDate_(now, schedule.offsetValue, schedule.offsetUnit);

    logSheet.appendRow([
      Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss'),
      issue.key,
      issueUrl,
      schedule.taskName,
      schedule.department,
      Utilities.formatDate(dueDate, tz, 'yyyy-MM-dd'),
      schedule.id,
      `Every ${schedule.recurrenceValue} ${schedule.recurrenceUnit}`,
      triggeredBy
    ]);
    Logger.log('[logIssueCreated_] Log row written for %s', issue.key);
  } catch (e) {
    Logger.log('[logIssueCreated_] WARNING: Failed to write log row: %s', e.message);
    // Non-fatal — don't let a logging failure break the main flow
  }
}

/**
 * Returns all schedule rows as an array of objects.
 */
function getSchedules() {
  Logger.log('[getSchedules] Fetching all schedules from sheet');
  try {
    const sheet = getSheet_();
    const [, ...rows] = sheet.getDataRange().getValues();
    const nonBlank = rows.filter(r => r[0]);
    Logger.log('[getSchedules] Total rows (excl. header): %s | Non-blank: %s', rows.length, nonBlank.length);
    return nonBlank.map(rowToObject_);
  } catch (e) {
    Logger.log('[getSchedules] ERROR: %s', e.message);
    return { error: e.message };
  }
}

/**
 * Saves a new schedule and returns its generated ID.
 */
function saveSchedule(form) {
  Logger.log('[saveSchedule] Saving new schedule: "%s"', form.taskName);
  Logger.log('[saveSchedule] Department: %s | Start: %s | Recurs every: %s %s | Offset: %s %s',
    form.department, form.startDate,
    form.recurrenceValue, form.recurrenceUnit,
    form.offsetValue, form.offsetUnit);
  try {
    const sheet = getSheet_();
    const id = Utilities.getUuid();
    const now = new Date();
    const startDate = new Date(form.startDate);
    // Use the start date as the first run date — the daily check will advance it
    // to startDate + interval once the first issue is created
    const nextDue = startDate;
    Logger.log('[saveSchedule] First next-due date set to start date: %s', nextDue);

    sheet.appendRow([
      id,
      form.taskName,
      form.department,
      Utilities.formatDate(startDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      form.recurrenceValue,
      form.recurrenceUnit,
      form.offsetValue,
      form.offsetUnit,
      '',  // Last Created
      Utilities.formatDate(nextDue, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      'TRUE',
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss')
    ]);

    Logger.log('[saveSchedule] Row written successfully. ID: %s', id);
    return { success: true, id };
  } catch (e) {
    Logger.log('[saveSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}

/**
 * Soft-deletes a schedule by ID (marks Active = FALSE).
 */
function deleteSchedule(id) {
  Logger.log('[deleteSchedule] Attempting to delete schedule ID: %s', id);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('FALSE');
        Logger.log('[deleteSchedule] Schedule "%s" marked inactive at row %s', data[i][1], i + 1);
        return { success: true };
      }
    }
    Logger.log('[deleteSchedule] WARNING: No schedule found with ID: %s', id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[deleteSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// PAUSE / RESUME
// ============================================================

/**
 * Pauses a schedule by setting Active = 'PAUSED'.
 */
function pauseSchedule(id) {
  Logger.log('[pauseSchedule] Pausing schedule ID: %s', id);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('PAUSED');
        Logger.log('[pauseSchedule] Schedule "%s" paused at row %s', data[i][1], i + 1);
        return { success: true };
      }
    }
    Logger.log('[pauseSchedule] WARNING: No schedule found with ID: %s', id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[pauseSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}

/**
 * Resumes a paused schedule by setting Active = 'TRUE'.
 */
function resumeSchedule(id) {
  Logger.log('[resumeSchedule] Resuming schedule ID: %s', id);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('TRUE');
        Logger.log('[resumeSchedule] Schedule "%s" resumed at row %s', data[i][1], i + 1);
        return { success: true };
      }
    }
    Logger.log('[resumeSchedule] WARNING: No schedule found with ID: %s', id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[resumeSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// RUN NOW
// ============================================================

/**
 * Immediately creates a Jira issue for the given schedule ID,
 * then advances the next due date by the recurrence interval.
 */
function runScheduleNow(id) {
  Logger.log('[runScheduleNow] Manual run triggered for schedule ID: %s', id);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();
    const today = stripTime_(new Date());

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== id) continue;

      const schedule = rowToObject_(data[i]);
      Logger.log('[runScheduleNow] Found schedule: "%s" — creating Jira issue now', schedule.taskName);

      const issue = createJiraIssue_(schedule);
      const newNextDue = calculateNextDue_(today, schedule.recurrenceValue, schedule.recurrenceUnit);

      sheet.getRange(i + 1, 9).setValue(Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      logIssueCreated_(issue, schedule, 'Manual Run');

      Logger.log('[runScheduleNow] ✅ Created %s | Next due advanced to: %s',
        issue.key, Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      return { success: true, issueKey: issue.key, nextDue: Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd') };
    }

    Logger.log('[runScheduleNow] WARNING: No schedule found with ID: %s', id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[runScheduleNow] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// NEXT RUN DATE OVERRIDE
// ============================================================

/**
 * Manually overrides the next due date for a schedule.
 */
function updateNextDue(id, nextDue) {
  Logger.log('[updateNextDue] Overriding next due for schedule ID: %s to %s', id, nextDue);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== id) continue;
      const d = new Date(nextDue);
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
      Logger.log('[updateNextDue] Next due updated to %s for "%s"', nextDue, data[i][1]);
      return { success: true };
    }

    Logger.log('[updateNextDue] WARNING: No schedule found with ID: %s', id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[updateNextDue] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// SCHEDULE UPDATE
// ============================================================

/**
 * Updates an existing schedule row by ID.
 */
function updateSchedule(form) {
  Logger.log('[updateSchedule] Updating schedule ID: %s | Task: "%s"', form.id, form.taskName);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== form.id) continue;

      const startDate = new Date(form.startDate);

      // Use start date directly as the next run date — the interval is only applied
      // after the first task is created, consistent with how saveSchedule works.
      const nextDue = startDate;
      Logger.log('[updateSchedule] Next-due date set to start date: %s', nextDue);

      sheet.getRange(i + 1, 2).setValue(form.taskName);
      sheet.getRange(i + 1, 3).setValue(form.department);
      sheet.getRange(i + 1, 4).setValue(Utilities.formatDate(startDate, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 5).setValue(form.recurrenceValue);
      sheet.getRange(i + 1, 6).setValue(form.recurrenceUnit);
      sheet.getRange(i + 1, 7).setValue(form.offsetValue);
      sheet.getRange(i + 1, 8).setValue(form.offsetUnit);
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(nextDue, tz, 'yyyy-MM-dd'));

      Logger.log('[updateSchedule] Schedule updated at row %s', i + 1);
      return { success: true };
    }

    Logger.log('[updateSchedule] WARNING: No schedule found with ID: %s', form.id);
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[updateSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// SCHEDULE HISTORY LOG
// ============================================================

/**
 * Returns all Creation Log rows for a given schedule ID.
 */
function getScheduleLogs(scheduleId) {
  Logger.log('[getScheduleLogs] Fetching log entries for schedule ID: %s', scheduleId);
  try {
    const logSheet = getLogSheet_();
    const [, ...rows] = logSheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();

    function toStr(val) {
      if (!val || val === '') return '';
      if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm:ss');
      return String(val);
    }

    const matches = rows
      .filter(r => r[6] === scheduleId) // column G = Schedule ID
      .map(r => ({
        timestamp:   toStr(r[0]),
        issueKey:    toStr(r[1]),
        issueUrl:    toStr(r[2]),
        taskName:    toStr(r[3]),
        department:  toStr(r[4]),
        dueDate:     toStr(r[5]),
        scheduleId:  toStr(r[6]),
        recurrence:  toStr(r[7]),
        triggeredBy: toStr(r[8])
      }));

    Logger.log('[getScheduleLogs] Found %s log entries for schedule %s', matches.length, scheduleId);
    return matches;
  } catch (e) {
    Logger.log('[getScheduleLogs] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// JIRA INTEGRATION
// ============================================================

/**
 * Fetches Jira field list and returns department options.
 * Called once on page load to populate the Department dropdown.
 */
function getJiraFieldOptions() {
  Logger.log('[getJiraFieldOptions] Fetching field list from Jira: %s', CONFIG.JIRA_BASE_URL);
  try {
    const url = `${CONFIG.JIRA_BASE_URL}/rest/api/3/field`;
    const response = callJira_('GET', url);
    const fields = JSON.parse(response);
    Logger.log('[getJiraFieldOptions] Received %s fields from Jira', fields.length);

    const deptField = fields.find(f =>
      f.name.toLowerCase() === CONFIG.DEPARTMENT_FIELD_NAME.toLowerCase()
    );

    if (!deptField) {
      Logger.log('[getJiraFieldOptions] WARNING: Department field "%s" not found in Jira field list', CONFIG.DEPARTMENT_FIELD_NAME);
      return { departments: [], fieldId: null };
    }

    Logger.log('[getJiraFieldOptions] Found department field. ID: %s | Name: %s', deptField.id, deptField.name);
    return {
      departments: CONFIG.DEPARTMENT_OPTIONS,
      fieldId: deptField.id
    };
  } catch (e) {
    Logger.log('[getJiraFieldOptions] ERROR — falling back to config defaults. Reason: %s', e.message);
    return { departments: CONFIG.DEPARTMENT_OPTIONS, fieldId: CONFIG.DEPARTMENT_FIELD_ID };
  }
}

/**
 * Creates a Jira issue for the given schedule object.
 */
function createJiraIssue_(schedule) {
  Logger.log('[createJiraIssue_] Creating issue for schedule: "%s" (ID: %s)', schedule.taskName, schedule.id);
  const dueDate = calculateDueDate_(new Date(), schedule.offsetValue, schedule.offsetUnit);
  Logger.log('[createJiraIssue_] Calculated due date: %s', dueDate);

  const payload = {
    fields: {
      project: { key: CONFIG.JIRA_PROJECT_KEY },
      summary: schedule.taskName,
      issuetype: { name: CONFIG.ISSUE_TYPE },
      duedate: Utilities.formatDate(dueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      [CONFIG.DEPARTMENT_FIELD_ID]: { value: schedule.department }
    }
  };

  Logger.log('[createJiraIssue_] Payload — project: %s | type: %s | department: %s | due: %s',
    CONFIG.JIRA_PROJECT_KEY, CONFIG.ISSUE_TYPE, schedule.department,
    Utilities.formatDate(dueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'));

  const url = `${CONFIG.JIRA_BASE_URL}/rest/api/3/issue`;
  const response = callJira_('POST', url, payload);
  const result = JSON.parse(response);

  Logger.log('[createJiraIssue_] Issue created successfully. Key: %s | ID: %s', result.key, result.id);
  return result;
}

/**
 * Generic Jira REST caller using Basic Auth (email:token).
 */
function callJira_(method, url, body) {
  Logger.log('[callJira_] %s %s', method, url);
  const credentials = Utilities.base64Encode(`${CONFIG.JIRA_EMAIL}:${CONFIG.JIRA_API_TOKEN}`);
  const options = {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  if (body) options.payload = JSON.stringify(body);

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  Logger.log('[callJira_] Response code: %s', code);

  if (code >= 400) {
    const errorBody = response.getContentText();
    Logger.log('[callJira_] ERROR body: %s', errorBody);
    throw new Error(`Jira API error ${code}: ${errorBody}`);
  }

  return response.getContentText();
}


// ============================================================
// DAILY TRIGGER — checks for schedules due today
// ============================================================

/**
 * Called by the time-based trigger every day.
 * Loops through active schedules and creates Jira issues when due.
 */
function runDailyCheck() {
  const today = stripTime_(new Date());
  const tz = Session.getScriptTimeZone();
  Logger.log('[runDailyCheck] ── Daily check started. Date: %s ──',
    Utilities.formatDate(today, tz, 'yyyy-MM-dd'));

  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const log = [];
  let processed = 0;
  let skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    if (!row[0]) {
      Logger.log('[runDailyCheck] Row %s: blank — skipping', i + 1);
      continue;
    }

    if (row[10] !== 'TRUE' && row[10] !== true) {
      const status = row[10] === 'PAUSED' ? 'paused' : 'inactive';
      Logger.log('[runDailyCheck] Row %s: "%s" is %s — skipping', i + 1, row[1], status);
      skipped++;
      continue;
    }

    const nextDue = stripTime_(new Date(row[9]));
    Logger.log('[runDailyCheck] Row %s: "%s" | Next due: %s',
      i + 1, row[1], Utilities.formatDate(nextDue, tz, 'yyyy-MM-dd'));

    if (nextDue > today) {
      Logger.log('[runDailyCheck] Not due yet — skipping');
      skipped++;
      continue;
    }

    processed++;
    const schedule = rowToObject_(row);
    Logger.log('[runDailyCheck] Schedule is due — attempting Jira issue creation');

    try {
      const issue = createJiraIssue_(schedule);
      const newNextDue = calculateNextDue_(nextDue, schedule.recurrenceValue, schedule.recurrenceUnit);

      sheet.getRange(i + 1, 9).setValue(Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      Logger.log('[runDailyCheck] ✅ Created %s | Next due advanced to: %s',
        issue.key, Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));
      logIssueCreated_(issue, schedule, 'Daily Trigger');
      log.push(`✅ Created ${issue.key} for "${schedule.taskName}"`);
    } catch (e) {
      Logger.log('[runDailyCheck] ❌ Failed for "%s": %s', schedule.taskName, e.message);
      log.push(`❌ Failed for "${schedule.taskName}": ${e.message}`);
    }
  }

  Logger.log('[runDailyCheck] ── Run complete. Issues created/attempted: %s | Skipped: %s ──', processed, skipped);

  if (log.length > 0) {
    Logger.log('[runDailyCheck] Summary:\n%s', log.join('\n'));
    if (CONFIG.NOTIFY_EMAIL) {
      Logger.log('[runDailyCheck] Sending summary email to: %s', CONFIG.NOTIFY_EMAIL);
      GmailApp.sendEmail(
        CONFIG.NOTIFY_EMAIL,
        `[Recurring Tasks] Daily Run — ${Utilities.formatDate(today, tz, 'yyyy-MM-dd')}`,
        log.join('\n')
      );
    }
  } else {
    Logger.log('[runDailyCheck] No issues were due today — nothing created');
  }
}

/**
 * Registers (or re-registers) the daily trigger.
 * Run this once manually from the Apps Script editor.
 */
function installDailyTrigger() {
  Logger.log('[installDailyTrigger] Removing any existing runDailyCheck triggers');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runDailyCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runDailyCheck')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  Logger.log('[installDailyTrigger] Daily trigger installed — runs every day at 7 AM');
}

/**
 * Removes the daily trigger.
 */
function uninstallDailyTrigger() {
  Logger.log('[uninstallDailyTrigger] Removing runDailyCheck trigger');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runDailyCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('[uninstallDailyTrigger] Trigger removed');
}

/**
 * Returns current trigger status for display in the UI.
 */
function getTriggerStatus() {
  Logger.log('[getTriggerStatus] Checking for active runDailyCheck trigger');
  const trigger = ScriptApp.getProjectTriggers()
    .find(t => t.getHandlerFunction() === 'runDailyCheck');
  if (trigger) {
    Logger.log('[getTriggerStatus] Trigger is active');
    return { active: true, description: 'Runs daily at 7:00 AM' };
  } else {
    Logger.log('[getTriggerStatus] No trigger found');
    return { active: false, description: 'Not installed' };
  }
}


// ============================================================
// DATE HELPERS
// ============================================================

function calculateNextDue_(fromDate, value, unit) {
  const d = new Date(fromDate);
  const v = parseInt(value, 10);
  Logger.log('[calculateNextDue_] From: %s | Adding: %s %s', fromDate, v, unit);
  switch (unit) {
    case 'days':   d.setDate(d.getDate() + v); break;
    case 'weeks':  d.setDate(d.getDate() + v * 7); break;
    case 'months': d.setMonth(d.getMonth() + v); break;
    case 'years':  d.setFullYear(d.getFullYear() + v); break;
  }
  Logger.log('[calculateNextDue_] Result: %s', d);
  return d;
}

function calculateDueDate_(fromDate, value, unit) {
  return calculateNextDue_(fromDate, value, unit);
}

function stripTime_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}


// ============================================================
// UTILITY
// ============================================================

function rowToObject_(row) {
  const tz = Session.getScriptTimeZone();

  // google.script.run cannot serialise Date objects — convert everything to strings
  function toStr(val) {
    if (!val || val === '') return '';
    if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
    return String(val);
  }

  return {
    id:              toStr(row[0]),
    taskName:        toStr(row[1]),
    department:      toStr(row[2]),
    startDate:       toStr(row[3]),
    recurrenceValue: Number(row[4]),
    recurrenceUnit:  toStr(row[5]),
    offsetValue:     Number(row[6]),
    offsetUnit:      toStr(row[7]),
    lastCreated:     toStr(row[8]),
    nextDue:         toStr(row[9]),
    active:          row[10] === 'TRUE' || row[10] === true,
    paused:          row[10] === 'PAUSED',
    createdAt:       toStr(row[11])
  };
}