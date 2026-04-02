// ============================================================
// Config.gs — Central Configuration
// Edit all values in this file before deploying.
// ============================================================

const CONFIG = {

  // ── Google Sheets ─────────────────────────────────────────
  // Create a new Google Sheet and paste its ID here.
  // The ID is in the URL: docs.google.com/spreadsheets/d/SHEET_ID/edit
  SHEET_ID: '1zwb6S63norFs5j5vOwKR6vxpfJN_84PaQM_ALcIMR_w',

  // ── Jira Connection ───────────────────────────────────────
  // Your Jira Cloud base URL (no trailing slash)
  JIRA_BASE_URL: 'https://wildernessnz.atlassian.net',

  // Service account email used for API calls
  JIRA_EMAIL: 'mark.lonergan@wilderness.co.nz',

  // Jira API token — generate at: https://id.atlassian.com/manage-profile/security/api-tokens
  // Store this in Script Properties for production:
  //   File → Project Settings → Script Properties → Add property JIRA_API_TOKEN
  // Then replace the string below with: PropertiesService.getScriptProperties().getProperty('JIRA_API_TOKEN')
  JIRA_API_TOKEN: PropertiesService.getScriptProperties().getProperty('JIRA_API_TOKEN'),

  // ── Project & Issue Config ────────────────────────────────
  // The Jira project key for "Company Work Items"
  JIRA_PROJECT_KEY: 'CWP',

  // Issue type to create (must exist in your project)
  ISSUE_TYPE: 'Task',

  // ── Department Custom Field ───────────────────────────────
  // The Jira custom field ID for Department (e.g. 'customfield_10050')
  // Find it via: GET /rest/api/3/field — look for your field by name
  DEPARTMENT_FIELD_ID: 'customfield_11005',

  // Human-readable name of the field (used for auto-discovery)
  DEPARTMENT_FIELD_NAME: 'Department',

  // List of department options shown in the UI dropdown
  // These must match the allowed values in Jira exactly (case-sensitive)
  DEPARTMENT_OPTIONS: [
    'Digital Experience',
    'Marketing',
    'Finance',
    'Adventure Support',
    'Reservations',
    'Sales',
    'Parts & Warranty',
    'Workshop'
  ],

  // ── Notifications (optional) ──────────────────────────────
  // Email to receive daily run summaries. Set to null to disable.
  NOTIFY_EMAIL: 'mark.lonergan@wilderness.co.nz',

};


// ============================================================
// SETUP CHECKLIST (run through this before first deployment)
// ============================================================
//
//  1. Create a Google Sheet → paste its ID into SHEET_ID above.
//
//  2. Generate a Jira API token at:
//     https://id.atlassian.com/manage-profile/security/api-tokens
//     Paste it into JIRA_API_TOKEN (or better: store in Script Properties).
//
//  3. Verify JIRA_PROJECT_KEY matches your project.
//
//  4. Confirm DEPARTMENT_FIELD_ID by calling:
//     GET https://your-domain.atlassian.net/rest/api/3/field
//     and searching the response for your Department field.
//
//  5. Update DEPARTMENT_OPTIONS to match your Jira field's allowed values.
//
//  6. Run installDailyTrigger() once from the Apps Script editor to
//     register the daily cron job (requires authorisation on first run).
//
//  7. Deploy as Web App:
//     Deploy → New Deployment → Web App
//     Execute as: Me  |  Who has access: Anyone in your org
//
// ============================================================
