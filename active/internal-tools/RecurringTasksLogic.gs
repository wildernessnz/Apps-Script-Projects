/**
 * @fileoverview Recurring Tasks — creates recurring Jira tickets on a
 * schedule (daily trigger + manual "Run Now"), backed by the same Google
 * Sheet ("Schedules" / "Creation Log" / "Audit Log" tabs) as the original
 * standalone recurring-task-engine project. Ported here with the sheet
 * schema and all CRUD/pause/resume/run-now/history/Jira logic unchanged —
 * only the function names changed, to fit this shared script's per-tool
 * naming convention (see Config.gs's SCRIPT PROPERTIES NAMING CONVENTION
 * note — the same collision risk applies to plain global function names
 * like the source's getSheet_/rowToObject_/logAudit_, which is why every
 * private helper here gets an rt prefix).
 *
 * Secrets (OAuth client ID/secret/redirect URI/refresh token) that used to
 * live in the source project's gitignored Config.js now live in this
 * project's Script Properties, prefixed RECURRING_TASKS_* — see the
 * migration checklist handed over alongside this port for the exact keys
 * to set before this tool will work.
 */

const RECURRING_TASKS_CONFIG = {
  JIRA_BASE_URL: 'https://wildernessnz.atlassian.net',
  JIRA_CLOUD_ID: 'cb0b2158-97aa-4d80-803f-a2a02ba9911d',
  JIRA_PROJECT_KEY: 'CWP',
  ISSUE_TYPE: 'Task',
  DEPARTMENT_FIELD_ID: 'customfield_11005',
  DEPARTMENT_OPTIONS: [
    'Digital Experience',
    'Marketing',
    'Finance',
    'Adventure Support',
    'Reservations',
    'Sales',
    'Parts & Warranty',
    'Workshop',
    'Detailing',
    'General / Other',
    'SLT',
    'Health & Safety',
    'HR'
  ],
  NOTIFY_EMAIL: 'mark.lonergan@wilderness.co.nz',
  // Google Groups — membership in any one of these grants access. Checked
  // via isRecurringTasksApproved() below, same mechanism as the standalone app.
  ACCESS_GROUPS: ['leaders@wilderness.co.nz', 'jirataskengine@wilderness.co.nz'],
};


// ============================================================
// ACCESS CONTROL
// ============================================================

/**
 * Used by ContentLoader.gs to gate this tool's content behind Google Group
 * membership before the sidebar-shared shell renders it — same access
 * mechanism as the standalone app (GroupsApp membership, not an email
 * allowlist Script Property like Weather Alert/Service History), since
 * this only changes the shell, not the tool's own access rules.
 * @returns {boolean}
 */
function isRecurringTasksApproved() {
  const email = Session.getActiveUser().getEmail();
  return RECURRING_TASKS_CONFIG.ACCESS_GROUPS.some(function (groupEmail) {
    try {
      return GroupsApp.getGroupByEmail(groupEmail).hasUser(email);
    } catch (e) {
      Logger.log('[isRecurringTasksApproved] Group check failed for %s (%s): %s', email, groupEmail, e.message);
      return false;
    }
  });
}


// ============================================================
// SCHEDULE CRUD — backed by Google Sheets as a simple DB
// ============================================================

// Returns the Schedules sheet, creating it with headers on first run.
function rtGetSheet_() {
  const ss = getSpreadsheet_('RECURRING_TASKS');
  let sheet = ss.getSheetByName('Schedules');

  if (!sheet) {
    Logger.log('[rtGetSheet_] "Schedules" sheet not found — creating it now');
    sheet = ss.insertSheet('Schedules');
    sheet.appendRow([
      'ID', 'Task Name', 'Department', 'Start Date',
      'Recurrence Value', 'Recurrence Unit',
      'Due Date Offset Value', 'Due Date Offset Unit',
      'Last Created', 'Next Due', 'Active', 'Created At', 'Description'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 13).setFontWeight('bold');
  }

  return sheet;
}

// Returns the Creation Log sheet, creating it with headers on first run.
function rtGetLogSheet_() {
  const ss = getSpreadsheet_('RECURRING_TASKS');
  let sheet = ss.getSheetByName('Creation Log');

  if (!sheet) {
    Logger.log('[rtGetLogSheet_] "Creation Log" sheet not found — creating it now');
    sheet = ss.insertSheet('Creation Log');
    sheet.appendRow([
      'Timestamp', 'Jira Issue Key', 'Jira Issue URL',
      'Task Name', 'Department', 'Due Date',
      'Schedule ID', 'Recurs Every', 'Triggered By', 'Created By'
    ]);
    sheet.setFrozenRows(1);
    const header = sheet.getRange(1, 1, 1, 10);
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
    sheet.setColumnWidth(10, 200);
  }

  return sheet;
}

// Appends a row to the Creation Log after a Jira issue is created.
// createdBy is the user email for manual runs, or 'Daily Trigger' for automated runs.
function rtLogIssueCreated_(issue, schedule, triggeredBy, createdBy) {
  try {
    const logSheet = rtGetLogSheet_();
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const issueUrl = `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/browse/${issue.key}`;
    const dueDate = rtCalculateDueDate_(now, schedule.offsetValue, schedule.offsetUnit);

    logSheet.appendRow([
      Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss'),
      issue.key,
      issueUrl,
      schedule.taskName,
      schedule.department,
      Utilities.formatDate(dueDate, tz, 'yyyy-MM-dd'),
      schedule.id,
      `Every ${schedule.recurrenceValue} ${schedule.recurrenceUnit}`,
      triggeredBy,
      createdBy || 'Daily Trigger'
    ]);
  } catch (e) {
    // Non-fatal — don't let a logging failure break the main flow
    Logger.log('[rtLogIssueCreated_] WARNING: Failed to write log row: %s', e.message);
  }
}

// Returns all non-deleted schedules as an array of objects.
// Filters out blank rows; active/paused/deleted distinction is handled client-side.
function getRecurringTaskSchedules() {
  try {
    const sheet = rtGetSheet_();
    const [, ...rows] = sheet.getDataRange().getValues();
    const nonBlank = rows.filter(r => r[0]);
    return nonBlank.map(rtRowToObject_);
  } catch (e) {
    Logger.log('[getRecurringTaskSchedules] ERROR: %s', e.message);
    return { error: e.message };
  }
}

// Appends a new schedule row and returns the generated UUID.
// nextDue is set to startDate — the daily trigger advances it after the first issue is created.
function saveRecurringTaskSchedule(form) {
  try {
    const sheet = rtGetSheet_();
    const id = Utilities.getUuid();
    const now = new Date();
    // Split date string manually to avoid timezone offset shifting the date by 1 day
    const parts = form.startDate.split('-');
    const startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const nextDue = startDate;

    sheet.appendRow([
      id,
      form.taskName,
      form.department,
      Utilities.formatDate(startDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      parseInt(form.recurrenceValue, 10),
      form.recurrenceUnit,
      parseInt(form.offsetValue, 10),
      form.offsetUnit,
      '',  // Last Created — blank until first issue is made
      Utilities.formatDate(nextDue, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      'TRUE',
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      form.description || ''
    ]);

    rtLogAudit_('Created', id, form.taskName, `Dept: ${form.department} | Recurs every ${form.recurrenceValue} ${form.recurrenceUnit}`);
    logEvent_('Recurring Tasks: Create Schedule', `task=${form.taskName} | dept=${form.department}`);
    return { success: true, id };
  } catch (e) {
    Logger.log('[saveRecurringTaskSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}

// Soft-deletes a schedule by setting Active = 'FALSE'.
// Rows are never physically deleted so the history remains intact.
function deleteRecurringTaskSchedule(id) {
  try {
    const sheet = rtGetSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('FALSE');
        rtLogAudit_('Deleted', data[i][0], data[i][1], 'Soft-deleted (Active = FALSE)');
        logEvent_('Recurring Tasks: Delete Schedule', `task=${data[i][1]}`);
        return { success: true };
      }
    }
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[deleteRecurringTaskSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// PAUSE / RESUME
// ============================================================

// Pauses a schedule — sets Active = 'PAUSED'.
// Paused schedules are skipped by the daily trigger but can be resumed.
function pauseRecurringTaskSchedule(id) {
  try {
    const sheet = rtGetSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('PAUSED');
        rtLogAudit_('Paused', data[i][0], data[i][1], '');
        logEvent_('Recurring Tasks: Pause Schedule', `task=${data[i][1]}`);
        return { success: true };
      }
    }
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[pauseRecurringTaskSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}

// Resumes a paused schedule — sets Active = 'TRUE'.
// The next run date is unchanged; the trigger will pick it up on the next due date.
function resumeRecurringTaskSchedule(id) {
  try {
    const sheet = rtGetSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.getRange(i + 1, 11).setValue('TRUE');
        rtLogAudit_('Resumed', data[i][0], data[i][1], '');
        logEvent_('Recurring Tasks: Resume Schedule', `task=${data[i][1]}`);
        return { success: true };
      }
    }
    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[resumeRecurringTaskSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// RUN NOW
// ============================================================

// Immediately creates a Jira issue for the given schedule, bypassing the daily trigger.
// Advances nextDue by the recurrence interval so the schedule stays on track.
function runRecurringTaskScheduleNow(id) {
  try {
    const sheet = rtGetSheet_();
    const data = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();
    const today = rtStripTime_(new Date());

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== id) continue;

      const schedule = rtRowToObject_(data[i]);
      const issue = rtCreateJiraIssue_(schedule);
      const newNextDue = rtCalculateNextDue_(today, schedule.recurrenceValue, schedule.recurrenceUnit);

      sheet.getRange(i + 1, 9).setValue(Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      const userEmail = Session.getActiveUser().getEmail();
      rtLogIssueCreated_(issue, schedule, 'Manual Run', userEmail);
      rtLogAudit_('Run Now', schedule.id, schedule.taskName, `Created ${issue.key} | Next due: ${Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd')}`);
      logEvent_('Recurring Tasks: Run Now', `task=${schedule.taskName} | issue=${issue.key}`);

      return { success: true, issueKey: issue.key, issueUrl: `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/browse/${issue.key}`, nextDue: Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd') };
    }

    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[runRecurringTaskScheduleNow] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// SCHEDULE UPDATE
// ============================================================

// Updates an existing schedule row by ID.
// Start Date (col 4) is intentionally not updated — it's a historical record.
// Next Due (col 10) is updated from the value the user set in the edit modal.
function updateRecurringTaskSchedule(form) {
  try {
    const sheet = rtGetSheet_();
    const data = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== form.id) continue;

      // Split date string to avoid timezone offset shifting the date
      const ndParts = form.nextDue.split('-');
      const nextDue = new Date(Number(ndParts[0]), Number(ndParts[1]) - 1, Number(ndParts[2]));

      sheet.getRange(i + 1, 2).setValue(form.taskName);
      sheet.getRange(i + 1, 3).setValue(form.department);
      // Col 4 (Start Date) is left as-is — it's historical, not editable
      sheet.getRange(i + 1, 5).setValue(parseInt(form.recurrenceValue, 10));
      sheet.getRange(i + 1, 6).setValue(form.recurrenceUnit);
      sheet.getRange(i + 1, 7).setValue(parseInt(form.offsetValue, 10));
      sheet.getRange(i + 1, 8).setValue(form.offsetUnit);
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(nextDue, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 13).setValue(form.description || '');
      rtLogAudit_('Updated', form.id, form.taskName, `Dept: ${form.department} | Recurs every ${form.recurrenceValue} ${form.recurrenceUnit} | Offset: ${form.offsetValue} ${form.offsetUnit}`);
      logEvent_('Recurring Tasks: Update Schedule', `task=${form.taskName} | dept=${form.department}`);
      return { success: true };
    }

    return { error: 'Schedule not found.' };
  } catch (e) {
    Logger.log('[updateRecurringTaskSchedule] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// SCHEDULE HISTORY LOG
// ============================================================

// Returns all Creation Log rows for a given schedule ID, sorted newest first by the UI.
function getRecurringTaskScheduleLogs(scheduleId) {
  try {
    const logSheet = rtGetLogSheet_();
    const [, ...rows] = logSheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone();

    function toStr(val) {
      if (!val || val === '') return '';
      if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm:ss');
      return String(val);
    }

    return rows
      .filter(r => r[6] === scheduleId)
      .map(r => ({
        timestamp:   toStr(r[0]),
        issueKey:    toStr(r[1]),
        issueUrl:    toStr(r[2]),
        taskName:    toStr(r[3]),
        department:  toStr(r[4]),
        dueDate:     toStr(r[5]),
        scheduleId:  toStr(r[6]),
        recurrence:  toStr(r[7]),
        triggeredBy: toStr(r[8]),
        createdBy:   toStr(r[9])
      }));
  } catch (e) {
    Logger.log('[getRecurringTaskScheduleLogs] ERROR: %s', e.message);
    return { error: e.message };
  }
}


// ============================================================
// JIRA INTEGRATION
// ============================================================

// Returns department options from RECURRING_TASKS_CONFIG — called on page load to populate dropdowns.
// Departments are static, not fetched from Jira at runtime.
function getRecurringTaskDepartmentOptions() {
  return {
    departments: RECURRING_TASKS_CONFIG.DEPARTMENT_OPTIONS,
    fieldId: RECURRING_TASKS_CONFIG.DEPARTMENT_FIELD_ID
  };
}

// Builds and posts a Jira issue for the given schedule.
// Uses ADF format for the description field if provided.
function rtCreateJiraIssue_(schedule) {
  const dueDate = rtCalculateDueDate_(new Date(), schedule.offsetValue, schedule.offsetUnit);

  const fields = {
    project: { key: RECURRING_TASKS_CONFIG.JIRA_PROJECT_KEY },
    summary: schedule.taskName,
    issuetype: { name: RECURRING_TASKS_CONFIG.ISSUE_TYPE },
    duedate: Utilities.formatDate(dueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    [RECURRING_TASKS_CONFIG.DEPARTMENT_FIELD_ID]: { value: schedule.department }
  };
  // Description uses Atlassian Document Format (ADF) — required by Jira REST API v3
  if (schedule.description) {
    fields.description = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: schedule.description }] }]
    };
  }

  const url = `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/rest/api/3/issue`;
  const response = rtCallJira_('POST', url, { fields });
  return JSON.parse(response);
}

// Generic Jira REST caller using OAuth 2.0 Bearer token.
// Rewrites JIRA_BASE_URL to the api.atlassian.com/ex/jira/{cloudId} format required by OAuth 2.0 (3LO).
function rtCallJira_(method, url, body) {
  const oauthBase = `https://api.atlassian.com/ex/jira/${RECURRING_TASKS_CONFIG.JIRA_CLOUD_ID}`;
  url = url.replace(RECURRING_TASKS_CONFIG.JIRA_BASE_URL, oauthBase);
  const token = rtGetOAuthAccessToken_();
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  if (body) options.payload = JSON.stringify(body);

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();

  if (code >= 400) {
    const errorBody = response.getContentText();
    Logger.log('[rtCallJira_] ERROR %s %s → %s: %s', method, url, code, errorBody);
    throw new Error(`Jira API error ${code}: ${errorBody}`);
  }

  return response.getContentText();
}


// ============================================================
// OAUTH 2.0 — Atlassian token management
// ============================================================

// Fetches a fresh access token using the stored refresh token.
// Called before every Jira API request — access tokens expire after 1 hour.
// Atlassian rotates refresh tokens on each use; the new one is stored automatically.
function rtGetOAuthAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const refreshToken = props.getProperty('RECURRING_TASKS_JIRA_REFRESH_TOKEN');

  if (!refreshToken) {
    throw new Error(
      'No OAuth refresh token found. Run rtAuthoriseJira() from the Apps Script editor first, ' +
      'then run rtExchangeCodeForTokens() with the code from the redirect URL.'
    );
  }

  const response = UrlFetchApp.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     props.getProperty('RECURRING_TASKS_JIRA_CLIENT_ID'),
      client_secret: props.getProperty('RECURRING_TASKS_JIRA_CLIENT_SECRET'),
      refresh_token: refreshToken
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (!data.access_token) {
    Logger.log('[rtGetOAuthAccessToken_] ERROR: %s', response.getContentText());
    throw new Error('Failed to refresh OAuth access token. Run rtAuthoriseJira() again to re-authenticate.');
  }

  if (data.refresh_token) {
    props.setProperty('RECURRING_TASKS_JIRA_REFRESH_TOKEN', data.refresh_token);
  }

  return data.access_token;
}

// STEP 1 of OAuth setup — run manually from the Apps Script editor.
// Generates the Atlassian auth URL and logs it. Open the URL in a browser
// while logged in as systems@wilderness.co.nz to approve access.
function rtAuthoriseJira() {
  const props = PropertiesService.getScriptProperties();
  const scopes = [
    'read:jira-work',
    'write:jira-work',
    'offline_access'    // Required to receive a refresh token
  ].join(' ');

  const authUrl = 'https://auth.atlassian.com/authorize?' + [
    'audience=api.atlassian.com',
    'client_id='    + props.getProperty('RECURRING_TASKS_JIRA_CLIENT_ID'),
    'scope='        + encodeURIComponent(scopes),
    'redirect_uri=' + encodeURIComponent(props.getProperty('RECURRING_TASKS_JIRA_REDIRECT_URI')),
    'response_type=code',
    'prompt=consent'
  ].join('&');

  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log('STEP 1: Open this URL in your browser and approve access');
  Logger.log('        Make sure you are logged in as systems@wilderness.co.nz');
  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log(authUrl);
  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log('STEP 2: After approving, copy the "code" value from the');
  Logger.log('redirect URL and run: rtExchangeCodeForTokens("paste-code-here")');
  Logger.log('═══════════════════════════════════════════════════════');
}

// STEP 2 of OAuth setup — run after completing the browser auth flow.
// Exchanges the one-time auth code for a refresh token and stores it in Script Properties.
// Example: rtExchangeCodeForTokens('eyJhbGc...')
function rtExchangeCodeForTokens(code) {
  const props = PropertiesService.getScriptProperties();
  const response = UrlFetchApp.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     props.getProperty('RECURRING_TASKS_JIRA_CLIENT_ID'),
      client_secret: props.getProperty('RECURRING_TASKS_JIRA_CLIENT_SECRET'),
      code:          code,
      redirect_uri:  props.getProperty('RECURRING_TASKS_JIRA_REDIRECT_URI')
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (data.refresh_token) {
    props.setProperty('RECURRING_TASKS_JIRA_REFRESH_TOKEN', data.refresh_token);
    Logger.log('[rtExchangeCodeForTokens] ✅ Refresh token stored successfully.');
  } else {
    Logger.log('[rtExchangeCodeForTokens] ❌ No refresh token in response: %s', response.getContentText());
    Logger.log('[rtExchangeCodeForTokens] Make sure offline_access scope is included and prompt=consent was set.');
  }
}

// Clears the stored refresh token from Script Properties.
// Run this before re-authenticating with a different account.
function rtRevokeOAuthToken() {
  PropertiesService.getScriptProperties().deleteProperty('RECURRING_TASKS_JIRA_REFRESH_TOKEN');
  Logger.log('[rtRevokeOAuthToken] Refresh token cleared. Run rtAuthoriseJira() to re-authenticate.');
}

// Checks whether a refresh token is currently stored.
function rtCheckOAuthStatus() {
  const token = PropertiesService.getScriptProperties().getProperty('RECURRING_TASKS_JIRA_REFRESH_TOKEN');
  if (token) {
    Logger.log('[rtCheckOAuthStatus] ✅ Refresh token is stored (length: %s)', token.length);
  } else {
    Logger.log('[rtCheckOAuthStatus] ❌ No refresh token found. Run rtAuthoriseJira() to set up OAuth.');
  }
}


// ============================================================
// AUDIT LOG
// ============================================================

// Returns the Audit Log sheet, creating it with headers on first run.
function rtGetAuditSheet_() {
  const ss = getSpreadsheet_('RECURRING_TASKS');
  let sheet = ss.getSheetByName('Audit Log');
  if (!sheet) {
    sheet = ss.insertSheet('Audit Log');
    sheet.appendRow(['Timestamp', 'User', 'Action', 'Schedule ID', 'Task Name', 'Detail']);
    sheet.setFrozenRows(1);
    const header = sheet.getRange(1, 1, 1, 6);
    header.setFontWeight('bold');
    header.setBackground('#263450');
    header.setFontColor('#ffffff');
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(3, 130);
    sheet.setColumnWidth(4, 280);
    sheet.setColumnWidth(5, 220);
    sheet.setColumnWidth(6, 340);
  }
  return sheet;
}

// Appends a row to the Audit Log for any significant user action.
// action: 'Created' | 'Updated' | 'Deleted' | 'Paused' | 'Resumed' | 'Run Now'
function rtLogAudit_(action, scheduleId, taskName, detail) {
  try {
    const sheet = rtGetAuditSheet_();
    const tz = Session.getScriptTimeZone();
    const user = Session.getActiveUser().getEmail() || 'unknown';
    sheet.appendRow([
      Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss'),
      user,
      action,
      scheduleId,
      taskName,
      detail || ''
    ]);
  } catch (e) {
    // Non-fatal — audit failure should never break the main operation
    Logger.log('[rtLogAudit_] WARNING: Failed to write audit row: %s', e.message);
  }
}


// ============================================================
// DAILY TRIGGER — checks for schedules due today
// ============================================================

// Main trigger function — runs every day at 7 AM via the time-based trigger.
// Loops all active schedules, creates Jira issues for any that are due,
// and advances the next due date by the recurrence interval.
// Sends a summary email to RECURRING_TASKS_CONFIG.NOTIFY_EMAIL (⚠️ subject on failures).
function runRecurringTasksDailyCheck() {
  const today = rtStripTime_(new Date());
  const tz = Session.getScriptTimeZone();
  Logger.log('[runRecurringTasksDailyCheck] ── Daily check started. Date: %s ──', Utilities.formatDate(today, tz, 'yyyy-MM-dd'));

  const sheet = rtGetSheet_();
  const data = sheet.getDataRange().getValues();
  const log = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    // Skip paused and deleted schedules (Active must be exactly 'TRUE' or true)
    if (row[10] !== 'TRUE' && row[10] !== true) continue;

    // Guard against invalid or missing next-due dates
    const nextDueRaw = new Date(row[9]);
    if (isNaN(nextDueRaw)) continue;
    const nextDue = rtStripTime_(nextDueRaw);
    if (nextDue > today) continue;

    const schedule = rtRowToObject_(row);

    try {
      const issue = rtCreateJiraIssue_(schedule);
      const newNextDue = rtCalculateNextDue_(nextDue, schedule.recurrenceValue, schedule.recurrenceUnit);

      sheet.getRange(i + 1, 9).setValue(Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
      sheet.getRange(i + 1, 10).setValue(Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      rtLogIssueCreated_(issue, schedule, 'Daily Trigger', 'Daily Trigger');
      log.push(`✅ Created ${issue.key} for "${schedule.taskName}"`);
    } catch (e) {
      Logger.log('[runRecurringTasksDailyCheck] ❌ Failed for "%s": %s', schedule.taskName, e.message);
      log.push(`❌ Failed for "${schedule.taskName}": ${e.message}`);
    }
  }

  const failures = log.filter(l => l.startsWith('❌'));
  const successes = log.filter(l => l.startsWith('✅'));

  Logger.log('[runRecurringTasksDailyCheck] ── Run complete. Created: %s | Failed: %s ──', successes.length, failures.length);
  logEvent_('Recurring Tasks: Daily Trigger', `created=${successes.length} | failed=${failures.length}`);

  if (log.length > 0 && RECURRING_TASKS_CONFIG.NOTIFY_EMAIL) {
    const hasFailures = failures.length > 0;
    const subject = hasFailures
      ? `[Recurring Tasks] ⚠️ ${failures.length} failure(s) — ${Utilities.formatDate(today, tz, 'yyyy-MM-dd')}`
      : `[Recurring Tasks] ✅ Daily Run — ${Utilities.formatDate(today, tz, 'yyyy-MM-dd')}`;
    const body = [
      `Daily trigger run: ${Utilities.formatDate(today, tz, 'yyyy-MM-dd')}`,
      `Issues created: ${successes.length}`,
      `Failures: ${failures.length}`,
      '',
      ...log,
      '',
      hasFailures ? 'Please check the Apps Script logs for more detail.' : ''
    ].join('\n');
    GmailApp.sendEmail(RECURRING_TASKS_CONFIG.NOTIFY_EMAIL, subject, body);
  }
}

// Installs the daily time-based trigger at 7 AM, in THIS Apps Script project.
// Safe to run multiple times — removes any existing trigger first.
function rtInstallDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runRecurringTasksDailyCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runRecurringTasksDailyCheck')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  Logger.log('[rtInstallDailyTrigger] Daily trigger installed — runs every day at 7 AM');
}

// Removes the daily trigger from THIS project. Run this to pause automated processing entirely.
function rtUninstallDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runRecurringTasksDailyCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('[rtUninstallDailyTrigger] Trigger removed');
}

// Returns trigger status for display in the UI.
function getRecurringTaskTriggerStatus() {
  const trigger = ScriptApp.getProjectTriggers()
    .find(t => t.getHandlerFunction() === 'runRecurringTasksDailyCheck');
  Logger.log('[getRecurringTaskTriggerStatus] %s', trigger ? 'Trigger is active' : 'No trigger installed');
  return trigger
    ? { active: true, description: 'Runs daily at 7:00 AM' }
    : { active: false, description: 'Not installed' };
}


// ============================================================
// DATE HELPERS
// ============================================================

// Advances a date by the given value and unit (days/weeks/months/years).
function rtCalculateNextDue_(fromDate, value, unit) {
  const d = new Date(fromDate);
  const v = parseInt(value, 10);
  switch (unit) {
    case 'days':   d.setDate(d.getDate() + v); break;
    case 'weeks':  d.setDate(d.getDate() + v * 7); break;
    case 'months': d.setMonth(d.getMonth() + v); break;
    case 'years':  d.setFullYear(d.getFullYear() + v); break;
  }
  return d;
}

// Alias for rtCalculateNextDue_ — used when calculating the Jira due date from today.
function rtCalculateDueDate_(fromDate, value, unit) {
  return rtCalculateNextDue_(fromDate, value, unit);
}

// Strips the time component from a date, returning midnight local time.
// Used for accurate date comparisons in the daily trigger.
function rtStripTime_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}


// ============================================================
// DIAGNOSTIC — run manually from the Apps Script editor to verify
// the Jira OAuth connection after (re-)authenticating in this project.
// ============================================================

function rtDiagTestJira() {
  Logger.log('[rtDiagTestJira] Testing Jira connectivity...');
  try {
    const metaUrl = `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/rest/api/3/issue/createmeta?projectKeys=${RECURRING_TASKS_CONFIG.JIRA_PROJECT_KEY}`;
    JSON.parse(rtCallJira_('GET', metaUrl));
    Logger.log('[rtDiagTestJira] ✅ Auth OK');
  } catch (e) {
    Logger.log('[rtDiagTestJira] ❌ Auth FAILED: %s', e.message);
    return;
  }

  try {
    const proj = JSON.parse(rtCallJira_('GET', `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/rest/api/3/project/${RECURRING_TASKS_CONFIG.JIRA_PROJECT_KEY}`));
    Logger.log('[rtDiagTestJira] ✅ Project found: %s (%s)', proj.name, proj.key);
  } catch (e) {
    Logger.log('[rtDiagTestJira] ❌ Project FAILED: %s', e.message);
    return;
  }

  try {
    const result = JSON.parse(rtCallJira_('POST', `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/rest/api/3/issue`, {
      fields: {
        project: { key: RECURRING_TASKS_CONFIG.JIRA_PROJECT_KEY },
        summary: '[DIAG TEST] Delete me — Recurring Tasks',
        issuetype: { name: RECURRING_TASKS_CONFIG.ISSUE_TYPE },
        [RECURRING_TASKS_CONFIG.DEPARTMENT_FIELD_ID]: { value: RECURRING_TASKS_CONFIG.DEPARTMENT_OPTIONS[0] }
      }
    }));
    Logger.log('[rtDiagTestJira] ✅ Full issue created: %s — everything is working!', result.key);
    try { rtCallJira_('DELETE', `${RECURRING_TASKS_CONFIG.JIRA_BASE_URL}/rest/api/3/issue/${result.key}`); } catch (e) {}
  } catch (e) {
    Logger.log('[rtDiagTestJira] ❌ Issue creation FAILED: %s', e.message);
  }

  Logger.log('[rtDiagTestJira] ── Diagnostic complete ──');
}


// ============================================================
// UTILITY
// ============================================================

// Converts a sheet row array to a plain object.
// IMPORTANT: All Date values must be converted to strings before returning —
// google.script.run cannot serialise Date objects and will return null silently if any exist.
function rtRowToObject_(row) {
  const tz = Session.getScriptTimeZone();

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
    active:          row[10] === 'TRUE' || row[10] === true,  // handle string and boolean
    paused:          row[10] === 'PAUSED',
    createdAt:       toStr(row[11]),
    description:     toStr(row[12])
  };
}
