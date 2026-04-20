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
      'Last Created', 'Next Due', 'Active', 'Created At', 'Description'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 13).setFontWeight('bold');
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
    Logger.log('[getLogSheet_] Sheet created and headers written');
  } else {
    Logger.log('[getLogSheet_] "Creation Log" sheet found');
  }

  return sheet;
}

/**
 * Writes a row to the Creation Log sheet after a Jira issue is created.
 */
function logIssueCreated_(issue, schedule, triggeredBy, createdBy) {
  Logger.log('[logIssueCreated_] Logging issue %s for schedule "%s" | triggered by: %s | user: %s',
    issue.key, schedule.taskName, triggeredBy, createdBy || 'system');
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
      triggeredBy,
      createdBy || 'Daily Trigger'
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
    // Parse date string parts directly — avoids timezone offset shifting date by 1 day
    const parts = form.startDate.split('-');
    const startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    // Use the start date as the first run date — the daily check will advance it
    // to startDate + interval once the first issue is created
    const nextDue = startDate;
    Logger.log('[saveSchedule] First next-due date set to start date: %s', nextDue);

    sheet.appendRow([
      id,
      form.taskName,
      form.department,
      Utilities.formatDate(startDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      parseInt(form.recurrenceValue, 10),
      form.recurrenceUnit,
      parseInt(form.offsetValue, 10),
      form.offsetUnit,
      '',  // Last Created
      Utilities.formatDate(nextDue, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      'TRUE',
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      form.description || ''  // Description (col 13)
    ]);

    Logger.log('[saveSchedule] Row written successfully. ID: %s', id);
    logAudit_('Created', id, form.taskName, `Dept: ${form.department} | Recurs every ${form.recurrenceValue} ${form.recurrenceUnit}`);
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
        logAudit_('Deleted', data[i][0], data[i][1], 'Soft-deleted (Active = FALSE)');
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
        logAudit_('Paused', data[i][0], data[i][1], '');
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
        logAudit_('Resumed', data[i][0], data[i][1], '');
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

      const userEmail = Session.getActiveUser().getEmail();
      logIssueCreated_(issue, schedule, 'Manual Run', userEmail);

      Logger.log('[runScheduleNow] ✅ Created %s | Next due advanced to: %s',
        issue.key, Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd'));

      logAudit_('Run Now', schedule.id, schedule.taskName, `Created ${issue.key} | Next due: ${Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd')}`);
      return { success: true, issueKey: issue.key, issueUrl: `${CONFIG.JIRA_BASE_URL}/browse/${issue.key}`, nextDue: Utilities.formatDate(newNextDue, tz, 'yyyy-MM-dd') };
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
      // Parse date string directly to avoid timezone offset shifting the date
      const parts = nextDue.split('-');
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
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

      // Parse next run date — this is what the user explicitly set in the edit modal
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
      Logger.log('[updateSchedule] Next due set to: %s', Utilities.formatDate(nextDue, tz, 'yyyy-MM-dd'));

      Logger.log('[updateSchedule] Schedule updated at row %s', i + 1);
      logAudit_('Updated', form.id, form.taskName, `Dept: ${form.department} | Recurs every ${form.recurrenceValue} ${form.recurrenceUnit} | Offset: ${form.offsetValue} ${form.offsetUnit}`);
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
        triggeredBy: toStr(r[8]),
        createdBy:   toStr(r[9])
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
 * Returns department options from CONFIG.
 */
function getJiraFieldOptions() {
  Logger.log('[getJiraFieldOptions] Returning department options from CONFIG (%s items)', CONFIG.DEPARTMENT_OPTIONS.length);
  return {
    departments: CONFIG.DEPARTMENT_OPTIONS,
    fieldId: CONFIG.DEPARTMENT_FIELD_ID
  };
}

/**
 * Creates a Jira issue for the given schedule object.
 */
function createJiraIssue_(schedule) {
  Logger.log('[createJiraIssue_] Creating issue for schedule: "%s" (ID: %s)', schedule.taskName, schedule.id);
  const dueDate = calculateDueDate_(new Date(), schedule.offsetValue, schedule.offsetUnit);
  Logger.log('[createJiraIssue_] Calculated due date: %s', dueDate);

  const fields = {
    project: { key: CONFIG.JIRA_PROJECT_KEY },
    summary: schedule.taskName,
    issuetype: { name: CONFIG.ISSUE_TYPE },
    duedate: Utilities.formatDate(dueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    [CONFIG.DEPARTMENT_FIELD_ID]: { value: schedule.department }
  };
  if (schedule.description) {
    fields.description = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: schedule.description }] }]
    };
  }
  const payload = { fields };

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
 * Generic Jira REST caller — uses OAuth 2.0 Bearer token.
 * Access tokens are refreshed automatically using the stored refresh token.
 */
function callJira_(method, url, body) {
  // OAuth 2.0 (3LO) requires api.atlassian.com/ex/jira/{cloudId} base URL.
  // Replace the configured JIRA_BASE_URL with the correct OAuth URL.
  const oauthBase = `https://api.atlassian.com/ex/jira/${CONFIG.JIRA_CLOUD_ID}`;
  url = url.replace(CONFIG.JIRA_BASE_URL, oauthBase);
  Logger.log('[callJira_] %s %s', method, url);
  const token = getOAuthAccessToken_();
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
  Logger.log('[callJira_] Response code: %s', code);

  if (code >= 400) {
    const errorBody = response.getContentText();
    Logger.log('[callJira_] ERROR body: %s', errorBody);
    throw new Error(`Jira API error ${code}: ${errorBody}`);
  }

  return response.getContentText();
}


// ============================================================
// OAUTH 2.0 — Atlassian token management
// ============================================================

/**
 * Returns a valid OAuth access token, refreshing it if necessary.
 * Access tokens expire after 1 hour — this is called before every Jira request.
 */
function getOAuthAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const refreshToken = props.getProperty('JIRA_REFRESH_TOKEN');

  if (!refreshToken) {
    throw new Error(
      'No OAuth refresh token found. Run authoriseJira() from the Apps Script editor first, ' +
      'then run exchangeCodeForTokens() with the code from the redirect URL.'
    );
  }

  Logger.log('[getOAuthAccessToken_] Refreshing access token...');
  const response = UrlFetchApp.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     CONFIG.JIRA_CLIENT_ID,
      client_secret: CONFIG.JIRA_CLIENT_SECRET,
      refresh_token: refreshToken
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (!data.access_token) {
    Logger.log('[getOAuthAccessToken_] ERROR: %s', response.getContentText());
    throw new Error('Failed to refresh OAuth access token. Run authoriseJira() again to re-authenticate.');
  }

  // Atlassian rotates refresh tokens on each use — store the new one
  if (data.refresh_token) {
    props.setProperty('JIRA_REFRESH_TOKEN', data.refresh_token);
    Logger.log('[getOAuthAccessToken_] ✅ Access token refreshed, refresh token rotated');
  } else {
    Logger.log('[getOAuthAccessToken_] ✅ Access token refreshed');
  }

  return data.access_token;
}

/**
 * STEP 1 of OAuth setup — run this manually from the Apps Script editor.
 * Copy the URL from the logs and open it in your browser.
 * After approving, you'll be redirected — copy the ?code= value from the URL.
 */
function authoriseJira() {
  const scopes = [
    'read:field:jira',
    'read:issue-meta:jira',
    'write:issue:jira',
    'offline_access'   // required to get a refresh token
  ].join(' ');

  const authUrl = 'https://auth.atlassian.com/authorize?' + [
    'audience=api.atlassian.com',
    'client_id='    + CONFIG.JIRA_CLIENT_ID,
    'scope='        + encodeURIComponent(scopes),
    'redirect_uri=' + encodeURIComponent(CONFIG.JIRA_REDIRECT_URI),
    'response_type=code',
    'prompt=consent'
  ].join('&');

  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log('STEP 1: Open this URL in your browser and approve access');
  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log(authUrl);
  Logger.log('═══════════════════════════════════════════════════════');
  Logger.log('STEP 2: After approving, copy the "code" value from the');
  Logger.log('redirect URL and run: exchangeCodeForTokens("paste-code-here")');
  Logger.log('═══════════════════════════════════════════════════════');
}

/**
 * STEP 2 of OAuth setup — run this manually after completing the browser auth flow.
 * Pass in the code value from the redirect URL query string.
 *
 * Example: exchangeCodeForTokens('eyJhbGc...')
 */
function exchangeCodeForTokens(code) {
  Logger.log('[exchangeCodeForTokens] Exchanging auth code for tokens...');

  const response = UrlFetchApp.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     CONFIG.JIRA_CLIENT_ID,
      client_secret: CONFIG.JIRA_CLIENT_SECRET,
      code:          code,
      redirect_uri:  CONFIG.JIRA_REDIRECT_URI
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (data.refresh_token) {
    PropertiesService.getScriptProperties().setProperty('JIRA_REFRESH_TOKEN', data.refresh_token);
    Logger.log('[exchangeCodeForTokens] ✅ Refresh token stored successfully.');
    Logger.log('[exchangeCodeForTokens] OAuth setup complete — run diagTestJira() to verify.');
  } else {
    Logger.log('[exchangeCodeForTokens] ❌ No refresh token in response: %s', response.getContentText());
    Logger.log('[exchangeCodeForTokens] Make sure offline_access scope is included and prompt=consent was set.');
  }
}

/**
 * Clears the stored refresh token. Run this to force re-authentication.
 */
function revokeOAuthToken() {
  PropertiesService.getScriptProperties().deleteProperty('JIRA_REFRESH_TOKEN');
  Logger.log('[revokeOAuthToken] Refresh token cleared. Run authoriseJira() to re-authenticate.');
}

/**
 * Shows current OAuth status — useful for debugging.
 */
function checkOAuthStatus() {
  const token = PropertiesService.getScriptProperties().getProperty('JIRA_REFRESH_TOKEN');
  if (token) {
    Logger.log('[checkOAuthStatus] ✅ Refresh token is stored (length: %s)', token.length);
    Logger.log('[checkOAuthStatus] Run diagTestJira() to verify it still works.');
  } else {
    Logger.log('[checkOAuthStatus] ❌ No refresh token found. Run authoriseJira() to set up OAuth.');
  }
}


// ============================================================
// AUDIT LOG
// ============================================================

/**
 * Returns the Audit Log sheet, creating it on first run.
 */
function getAuditSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName('Audit Log');
  if (!sheet) {
    Logger.log('[getAuditSheet_] Creating Audit Log sheet');
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

/**
 * Writes a row to the Audit Log.
 * action: 'Created' | 'Updated' | 'Deleted' | 'Paused' | 'Resumed' | 'Run Now'
 */
function logAudit_(action, scheduleId, taskName, detail) {
  try {
    const sheet = getAuditSheet_();
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
    Logger.log('[logAudit_] %s | %s | %s | %s', action, user, taskName, detail || '');
  } catch (e) {
    Logger.log('[logAudit_] WARNING: Failed to write audit row: %s', e.message);
    // Non-fatal
  }
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

    const nextDueRaw = new Date(row[9]);
    if (isNaN(nextDueRaw)) {
      Logger.log('[runDailyCheck] Row %s: "%s" has invalid next-due date "%s" — skipping', i + 1, row[1], row[9]);
      skipped++;
      continue;
    }
    const nextDue = stripTime_(nextDueRaw);
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
      logIssueCreated_(issue, schedule, 'Daily Trigger', 'Daily Trigger');
      log.push(`✅ Created ${issue.key} for "${schedule.taskName}"`);
    } catch (e) {
      Logger.log('[runDailyCheck] ❌ Failed for "%s": %s', schedule.taskName, e.message);
      log.push(`❌ Failed for "${schedule.taskName}": ${e.message}`);
    }
  }

  Logger.log('[runDailyCheck] ── Run complete. Issues created/attempted: %s | Skipped: %s ──', processed, skipped);

  const failures = log.filter(l => l.startsWith('❌'));
  const successes = log.filter(l => l.startsWith('✅'));

  if (log.length > 0) {
    Logger.log('[runDailyCheck] Summary:\n%s', log.join('\n'));
    if (CONFIG.NOTIFY_EMAIL) {
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
      Logger.log('[runDailyCheck] Sending summary email to: %s (failures: %s)', CONFIG.NOTIFY_EMAIL, failures.length);
      GmailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, body);
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
    createdAt:       toStr(row[11]),
    description:     toStr(row[12])
  };
}