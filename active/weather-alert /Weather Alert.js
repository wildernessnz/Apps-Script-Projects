/**
 * Weather Alert Tool — Apps Script (Sheet-bound)
 *
 * Reads on-road guests directly from the "Raw - OnRoad Bookings" tab of this
 * spreadsheet. Deduplicates by hubspot_vid. Sends a SendGrid dynamic template
 * email to each unique guest and optionally enrolls them in the HubSpot
 * WhatsApp workflow.
 *
 * SETUP (one-time, done by DE):
 *   1. Open Extensions > Apps Script from this spreadsheet.
 *   2. Paste WeatherAlert.gs and Index.html into the project.
 *   3. Add WildernessAppScriptLibrary as a library dependency (Script ID from DE).
 *   4. Go to Project Settings > Script Properties and add:
 *        HUBSPOT_WHATSAPP_FLOW_ID  — workflow ID from HubSpot URL
 *        SENDGRID_API_KEY          — SendGrid API key with Mail Send permission
 *        SENDGRID_TEMPLATE_ID      — SendGrid dynamic template ID (starts with "d-")
 *        FROM_EMAIL                — e.g. support@wilderness.co.nz (must be a SendGrid verified sender)
 *        FROM_NAME                 — e.g. Wilderness Adventure Support
 *        TEST_MODE                 — set to "true" to restrict sends to @wilderness.co.nz only
 *        APPROVED_SENDERS         — comma-separated emails that can see and use the menu
 *                                   e.g. leader@wilderness.co.nz,backup@wilderness.co.nz
 *        OVERRIDE_EMAILS           — comma-separated emails allowed to reset the daily lock
 *        CONFIRMATION_CC           — comma-separated emails always CC'd on the confirmation summary
 *                                   e.g. manager@wilderness.co.nz,ops@wilderness.co.nz
 *        BCC_EMAIL                 — comma-separated emails BCC'd on every real guest send
 *                                   (not applied to test sends). e.g. archive@wilderness.co.nz
 *      Note: HubSpot auth is handled by WildernessAppScriptLibrary (no key needed
 *      for the WhatsApp workflow call). SendGrid uses its own API key above.
 *   5. Reload the spreadsheet — the "Weather Alert" menu will appear for approved senders only.
 *
 * SAFETY FEATURES:
 *   - Approved senders: menu only appears for emails listed in APPROVED_SENDERS
 *   - Test mode: only @wilderness.co.nz addresses are contacted when TEST_MODE=true
 *   - One send per day: a second trigger within the same calendar day is blocked
 *   - Override: authorised emails (OVERRIDE_EMAILS) can reset the daily lock via the menu
 *   - Confirmation dialog: the leader must confirm before any send fires
 *   - Triggered-by logging: every send and override records the Google account that did it
 *
 * NO web app deployment needed. The UI runs as a modal dialog inside the Sheet.
 */

// ---------------------------------------------------------------------------
// MENU — the only globals Apps Script requires at the top level
// ---------------------------------------------------------------------------

function onOpen() {
  const currentUser     = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props           = PropertiesService.getScriptProperties();
  const approvedRaw     = props.getProperty('APPROVED_SENDERS') ?? '';
  const approvedSenders = approvedRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  // Menu is only added for approved senders — all others see nothing
  if (!approvedSenders.includes(currentUser)) return;

  SpreadsheetApp.getUi()
    .createMenu('⚠️ Weather Alert')
    .addItem('📨 Send alert',         'openAlertDialog')
    .addSeparator()
    .addItem('👥 Preview guest list', 'previewGuestList')
    .addItem('🔓 Reset today\'s lock', 'resetDailyLock')
    .addToUi();
}

// Thin wrappers — global so the menu and google.script.run can reach them.
// All real logic lives inside WeatherAlert below.

function openAlertDialog()                          { new WeatherAlert().openAlertDialog(); }
function previewGuestList()                         { new WeatherAlert().previewGuestList(); }
function getGuestPreview()                          { return new WeatherAlert().getGuestPreview(); }
function triggerWeatherAlert(subject, body, sendWA, sendEmail)  { return new WeatherAlert().triggerWeatherAlert(subject, body, sendWA, sendEmail); }
function resetDailyLock()                           { new WeatherAlert().resetDailyLock(); }
function resetLockFromWebApp()                      { return new WeatherAlert().resetLockFromWebApp(); }
function previewEmail(subject, body)                { return new WeatherAlert().previewEmail(subject, body); }
function sendTestEmail(subject, body)               { return new WeatherAlert().sendTestEmail(subject, body); }

// ---------------------------------------------------------------------------
// WeatherAlert — all implementation kept inside the constructor
// ---------------------------------------------------------------------------

const WeatherAlert = function () {

  // ── Constants ──────────────────────────────────────────────────────────────

  const RAW_TAB       = 'Raw - OnRoad Bookings';
  const LOG_TAB       = 'Weather Alert Log';
  const TEST_DOMAIN   = '@wilderness.co.nz';
  const LAST_SEND_KEY = 'WEATHER_ALERT_LAST_SEND_DATE';
  const LAST_SEND_BY  = 'WEATHER_ALERT_LAST_SEND_BY';

  const COL_VID     = 'hubspot_vid';
  const COL_EMAIL   = 'customer_email';
  const COL_FNAME   = 'first_name';
  const COL_LNAME   = 'last_name';
  const COL_BOOKING = 'booking_number';

  // ── Config ─────────────────────────────────────────────────────────────────

  const getConfig = () => {
    const props = PropertiesService.getScriptProperties();
    return {
      HUBSPOT_WHATSAPP_FLOW_ID:  props.getProperty('HUBSPOT_WHATSAPP_FLOW_ID'),
      SENDGRID_API_KEY:          props.getProperty('SENDGRID_API_KEY'),
      SENDGRID_TEMPLATE_ID:      props.getProperty('SENDGRID_TEMPLATE_ID'),
      FROM_EMAIL:                props.getProperty('FROM_EMAIL'),
      FROM_NAME:                 props.getProperty('FROM_NAME'),
      TEST_MODE:                 props.getProperty('TEST_MODE') === 'true',
      APPROVED_SENDERS:          parseEmailList(props.getProperty('APPROVED_SENDERS')),
      OVERRIDE_EMAILS:           parseEmailList(props.getProperty('OVERRIDE_EMAILS')),
      CONFIRMATION_CC:           parseEmailList(props.getProperty('CONFIRMATION_CC')).join(','),
      BCC_EMAIL:                 parseEmailList(props.getProperty('BCC_EMAIL')),
    };
  };

  // Parses "a@b.com, c@d.com" → ['a@b.com', 'c@d.com'] (trimmed, lowercased)
  const parseEmailList = (raw) =>
    (raw ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  // ── Who triggered ──────────────────────────────────────────────────────────

  const getTriggeredBy = () => Session.getActiveUser().getEmail()?.toLowerCase() || 'unknown';

  // ── One-send-per-day guard ─────────────────────────────────────────────────

  const todayNZ = () => {
    const nz      = new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const [d,m,y] = nz.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  };

  const props           = () => PropertiesService.getScriptProperties();
  const getLastSendDate = () => props().getProperty(LAST_SEND_KEY) ?? '';
  const getLastSendBy   = () => props().getProperty(LAST_SEND_BY)  ?? '';

  const recordSend = (triggeredBy) =>
    props().setProperties({ [LAST_SEND_KEY]: todayNZ(), [LAST_SEND_BY]: triggeredBy });

  const clearLock = () => {
    props().deleteProperty(LAST_SEND_KEY);
    props().deleteProperty(LAST_SEND_BY);
  };

  const alreadySentToday = () => getLastSendDate() === todayNZ();

  // ── Override / reset daily lock ────────────────────────────────────────────

  this.resetDailyLock = () => {
    const ui          = SpreadsheetApp.getUi();
    const currentUser = getTriggeredBy();
    const cfg         = getConfig();
    const authorised  = cfg.OVERRIDE_EMAILS;

    const authorisedList = authorised.length
      ? authorised.join('\n  • ')
      : '(none — set OVERRIDE_EMAILS in Script Properties)';

    if (!authorised.includes(currentUser)) {
      ui.alert(
        'Access denied',
        `Only authorised users can reset the daily lock.\n\nAuthorised:\n  • ${authorisedList}\n\nYou are signed in as: ${currentUser}`,
        ui.ButtonSet.OK
      );
      return;
    }

    if (!alreadySentToday()) {
      ui.alert(
        'No lock active',
        `There is no send recorded for today (${todayNZ()}) — nothing to reset.\n\nAuthorised users:\n  • ${authorisedList}`,
        ui.ButtonSet.OK
      );
      return;
    }

    const lastBy   = getLastSendBy();
    const lastDate = getLastSendDate();

    const confirm = ui.alert(
      'Reset daily lock?',
      `A weather alert was sent today (${lastDate}) by ${lastBy || 'unknown'}.\n\n` +
      `Resetting the lock will allow another send today.\n\n` +
      `Authorised users:\n  • ${authorisedList}\n\n` +
      `You are signed in as: ${currentUser}\n\nProceed?`,
      ui.ButtonSet.YES_NO
    );

    if (confirm !== ui.Button.YES) return;

    clearLock();
    logOverride(currentUser, lastDate, lastBy);
    ui.alert('Lock cleared', `The daily lock has been reset. Another alert can now be sent today.\n\nThis action has been logged.`, ui.ButtonSet.OK);
  };

  // ── Reset lock (web app) ───────────────────────────────────────────────────

  // Lightweight version of resetDailyLock for the web app — no UI.alert dialogs,
  // returns a result object instead so the web app can handle display itself.
  this.resetLockFromWebApp = () => {
    const currentUser = getTriggeredBy();
    const cfg         = getConfig();

    if (!cfg.OVERRIDE_EMAILS.includes(currentUser)) {
      return { success: false, message: 'Your account is not authorised to reset the daily lock.' };
    }

    if (!alreadySentToday()) {
      return { success: false, message: `No send recorded for today (${todayNZ()}) — nothing to reset.` };
    }

    const lastBy   = getLastSendBy();
    const lastDate = getLastSendDate();
    clearLock();
    logOverride(currentUser, lastDate, lastBy);

    return { success: true, clearedDate: lastDate, clearedBy: lastBy };
  };

  // ── UI ─────────────────────────────────────────────────────────────────────

  this.openAlertDialog = () => {
    const html = HtmlService
      .createHtmlOutputFromFile('Index')
      .setWidth(640)
      .setHeight(680)
      .setTitle('Send weather alert');
    SpreadsheetApp.getUi().showModalDialog(html, 'Send weather alert');
  };

  this.previewGuestList = () => {
    const { TEST_MODE } = getConfig();
    const contacts      = getOnRoadContacts(TEST_MODE);
    if (!contacts.length) {
      SpreadsheetApp.getUi().alert(
        TEST_MODE
          ? `No @wilderness.co.nz contacts found in "${RAW_TAB}" (test mode active).`
          : `No on-road guests found in "${RAW_TAB}".`
      );
      return;
    }
    const modeLabel = TEST_MODE ? ' [TEST MODE — @wilderness.co.nz only]' : '';
    const lines     = contacts.map(c => `${c.firstName} ${c.lastName} <${c.email}> — ${c.bookingNumber}`);
    SpreadsheetApp.getUi().alert(
      `${contacts.length} unique guest(s) will be contacted${modeLabel}:\n\n${lines.join('\n')}`
    );
  };

  // Called by the dialog via google.script.run — returns full state for the UI.
  this.getGuestPreview = () => {
    const cfg         = getConfig();
    const contacts    = getOnRoadContacts(cfg.TEST_MODE);
    const sentToday   = alreadySentToday();
    const triggeredBy = getTriggeredBy();

    return {
      testMode:     cfg.TEST_MODE,
      sentToday,
      lastSendDate: getLastSendDate(),
      lastSendBy:   getLastSendBy(),
      triggeredBy,
      canOverride:  cfg.OVERRIDE_EMAILS.includes(triggeredBy),
      contacts: contacts.map(({ firstName, lastName, email, bookingNumber }) => ({
        name: `${firstName} ${lastName}`,
        email,
        bookingNumber,
      })),
    };
  };

  // ── Main send ──────────────────────────────────────────────────────────────

  this.triggerWeatherAlert = (subject, body, sendWhatsApp, sendEmail = true) => {
    const cfg         = getConfig();
    const triggeredBy = getTriggeredBy();

    // Server-side approved sender guard — Session.getActiveUser() correctly returns
    // the visiting user's email when deployed as "Execute as: User accessing the web app"
    if (!cfg.APPROVED_SENDERS.includes(triggeredBy)) {
      return { success: false, message: 'Your account is not authorised to send weather alerts.' };
    }

    if (!sendEmail && !sendWhatsApp) {
      return { success: false, message: 'No channel selected — nothing to send.' };
    }

    // Server-side daily lock — UI also checks, but this is the authoritative guard
    if (alreadySentToday()) {
      return {
        success: false,
        message: `A weather alert was already sent today (${getLastSendDate()}) by ${getLastSendBy() || 'unknown'}. Only one send per day is permitted. Use "Reset today's lock" from the Weather Alert menu if a second send is genuinely needed.`,
      };
    }

    const contacts = getOnRoadContacts(cfg.TEST_MODE);

    if (!contacts.length) {
      return {
        success: false,
        message: cfg.TEST_MODE
          ? 'No @wilderness.co.nz contacts found — nothing sent. (Test mode active)'
          : 'No on-road guests found in the sheet — nothing sent.',
      };
    }

    const emailsSent = [];
    const errors     = [];

    if (sendEmail) {
      for (const contact of contacts) {
        try {
          sendTransactionalEmail(cfg, contact, subject, body);
          emailsSent.push(contact.email);
        } catch (err) {
          errors.push({ email: contact.email, error: err.message });
        }
      }
    }

    let whatsAppResult = null;
    if (sendWhatsApp) {
      try {
        const { enrolled, errors: waErrors } = enrollInWorkflow(cfg, contacts);
        whatsAppResult = `Enrolled ${enrolled.length} of ${contacts.length} contact(s)`;
        if (waErrors.length) {
          whatsAppResult += ` — ${waErrors.length} error(s): ${waErrors.map(e => `${e.email}: ${e.error}`).join(', ')}`;
        }
      } catch (err) {
        whatsAppResult = `Error: ${err.message}`;
      }
    }

    recordSend(triggeredBy);
    logSend({ subject, body, triggeredBy, testMode: cfg.TEST_MODE,
              totalContacts: contacts.length, emailsSent, errors, whatsAppResult, sendEmail });
    sendConfirmationEmail({ triggeredBy, cc: cfg.CONFIRMATION_CC, testMode: cfg.TEST_MODE,
                            subject, contacts, emailsSent, errors, whatsAppResult, sendEmail,
                            timestamp: new Date().toISOString() });

    return {
      success:       true,
      testMode:      cfg.TEST_MODE,
      triggeredBy,
      sendEmail,
      totalContacts: contacts.length,
      emailsSent:    emailsSent.length,
      emailErrors:   errors,
      whatsApp:      whatsAppResult,
      timestamp:     new Date().toISOString(),
    };
  };

  // ── Guest list ─────────────────────────────────────────────────────────────

  const getOnRoadContacts = (testMode = false) => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(RAW_TAB);

    if (!sheet) throw new Error(`Tab "${RAW_TAB}" not found. Please check the sheet name.`);

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];

    const headers = data[0].map(h => h.toString().trim());
    const idx = {
      vid:     headers.indexOf(COL_VID),
      email:   headers.indexOf(COL_EMAIL),
      fname:   headers.indexOf(COL_FNAME),
      lname:   headers.indexOf(COL_LNAME),
      booking: headers.indexOf(COL_BOOKING),
    };

    const missing = [COL_VID, COL_EMAIL].filter(col => headers.indexOf(col) === -1);
    if (missing.length) throw new Error(`Missing column(s) in "${RAW_TAB}": ${missing.join(', ')}`);

    const seen = new Set();

    return data.slice(1).reduce((contacts, row) => {
      const vid   = row[idx.vid]?.toString().trim();
      const email = row[idx.email]?.toString().trim();

      if (!vid || !email || seen.has(vid)) return contacts;
      if (testMode && !email.endsWith(TEST_DOMAIN)) return contacts;

      seen.add(vid);
      contacts.push({
        vid,
        email,
        firstName:     row[idx.fname]?.toString().trim()   ?? '',
        lastName:      row[idx.lname]?.toString().trim()   ?? '',
        bookingNumber: row[idx.booking]?.toString().trim() ?? '',
      });

      return contacts;
    }, []);
  };

  // ── SendGrid API ───────────────────────────────────────────────────────────

  const sendTransactionalEmail = (cfg, contact, subject, body, includeBcc = true) => {
    const bccList = (includeBcc && cfg.BCC_EMAIL.length)
      ? cfg.BCC_EMAIL.map(email => ({ email }))
      : undefined;

    // The template renders alertBody as raw HTML, so plain-text line breaks
    // from the textarea must be converted to <br> or they collapse in the
    // rendered email (HTML ignores literal \n whitespace).
    const htmlBody = (body || '').replace(/\n/g, '<br>');

    const response = UrlFetchApp.fetch(
      'https://api.sendgrid.com/v3/mail/send',
      {
        method:             'POST',
        contentType:        'application/json',
        headers:            { Authorization: `Bearer ${cfg.SENDGRID_API_KEY}` },
        muteHttpExceptions: true,
        payload:            JSON.stringify({
          personalizations: [{
            to:                  [{ email: contact.email, name: contact.firstName || 'Guest' }],
            bcc:                 bccList,
            dynamic_template_data: {
              subject:     subject,
              alertBody:  htmlBody,
              firstName:  contact.firstName || 'Guest',
            },
          }],
          from:             { email: cfg.FROM_EMAIL, name: cfg.FROM_NAME || undefined },
          reply_to:         { email: cfg.FROM_EMAIL },
          template_id:      cfg.SENDGRID_TEMPLATE_ID,
          custom_args:      { weather_alert_send_id: `weather-${Date.now()}-${contact.vid}` },
        }),
      }
    );

    const code = response.getResponseCode();
    if (code >= 400) {
      // SendGrid returns { errors: [{ message, field, help }] } on failure
      let msg = `HTTP ${code}`;
      try {
        const data = JSON.parse(response.getContentText());
        msg = data.errors?.map(e => e.message).join('; ') || msg;
      } catch (_) { /* non-JSON response — keep HTTP status as the message */ }
      throw new Error(msg);
    }
  };

  // Fetches the active version's HTML for the configured dynamic template.
  // Always fetched live from SendGrid — no caching — so the preview always
  // reflects the current published template, even right after an edit.
  const getTemplateHtml = (cfg) => {
    const response = UrlFetchApp.fetch(
      `https://api.sendgrid.com/v3/templates/${cfg.SENDGRID_TEMPLATE_ID}`,
      {
        method:             'GET',
        headers:            { Authorization: `Bearer ${cfg.SENDGRID_API_KEY}` },
        muteHttpExceptions: true,
      }
    );

    if (response.getResponseCode() >= 400) {
      throw new Error(`Could not fetch template — HTTP ${response.getResponseCode()}`);
    }

    const data    = JSON.parse(response.getContentText());
    const active  = (data.versions || []).find(v => v.active === 1) || data.versions?.[0];
    if (!active) throw new Error('Template has no versions to preview.');

    return active.html_content || '<p>(This template version has no HTML content.)</p>';
  };

  // Replaces {{variable}} or {{{variable}}} tokens with the supplied values.
  // Triple braces are Handlebars' "render raw HTML, don't escape" syntax —
  // the live template uses these for alertBody so <br> tags render as actual
  // line breaks rather than literal text. Matching {1,3} braces on each side
  // covers both styles without needing to know which one a given token uses.
  const renderTemplate = (html, data) =>
    Object.entries(data).reduce(
      (out, [key, value]) => out.replace(new RegExp(`\\{{2,3}\\s*${key}\\s*\\}{2,3}`, 'g'), value),
      html
    );

  // Public preview method — called by the dialog. Renders the live SendGrid
  // template with the leader's current subject/body so they can see exactly
  // what guests will receive before sending. No email is sent.
  this.previewEmail = (subject, body) => {
    const cfg = getConfig();

    if (!cfg.SENDGRID_API_KEY || !cfg.SENDGRID_TEMPLATE_ID) {
      return { success: false, message: 'SendGrid is not configured (missing API key or template ID).' };
    }

    try {
      const rawHtml = getTemplateHtml(cfg);
      const html    = renderTemplate(rawHtml, {
        subject:   subject || '(no subject)',
        alertBody: (body || '').replace(/\n/g, '<br>'),
        firstName: 'Guest',
      });
      return { success: true, html };
    } catch (err) {
      return { success: false, message: err.message };
    }
  };

  // Public test-send method — called by the dialog. Sends a real SendGrid
  // email via the live template, but only to the current user — never BCC'd,
  // never logged to the audit sheet, and does not touch the daily lock.
  this.sendTestEmail = (subject, body) => {
    const cfg         = getConfig();
    const triggeredBy = getTriggeredBy();

    if (!cfg.SENDGRID_API_KEY || !cfg.SENDGRID_TEMPLATE_ID) {
      return { success: false, message: 'SendGrid is not configured (missing API key or template ID).' };
    }
    if (triggeredBy === 'unknown') {
      return { success: false, message: 'Could not determine your email address to send the test to.' };
    }

    try {
      sendTransactionalEmail(
        cfg,
        { email: triggeredBy, firstName: 'Test', vid: 'test' },
        `[TEST] ${subject}`,
        body,
        false // never BCC on test sends
      );
      return { success: true, sentTo: triggeredBy };
    } catch (err) {
      return { success: false, message: err.message };
    }
  };

  // ── HubSpot API (WhatsApp only) ────────────────────────────────────────────

  const hubspotHeaders = () => ({
    Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer(),
  });

  // Enrolls contacts into the WhatsApp workflow one at a time by email address.
  // Uses the v2 endpoint — the only stable API for workflow enrollment.
  const enrollInWorkflow = (cfg, contacts) => {
    const enrolled = [];
    const errors   = [];

    for (const contact of contacts) {
      const url = `https://api.hubapi.com/automation/v2/workflows/${cfg.HUBSPOT_WHATSAPP_FLOW_ID}/enrollments/contacts/${encodeURIComponent(contact.email)}`;

      const response = UrlFetchApp.fetch(url, {
        method:             'POST',
        headers:            hubspotHeaders(),
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();

      if (code === 204) {
        enrolled.push(contact.email);
      } else {
        let msg = `HTTP ${code}`;
        try {
          const body = JSON.parse(response.getContentText());
          msg = body.message || msg;
        } catch (_) {}
        errors.push({ email: contact.email, error: msg });
      }
    }

    return { enrolled, errors };
  };

  // ── Audit log ──────────────────────────────────────────────────────────────

  const getOrCreateLogSheet = () => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let   sheet = ss.getSheetByName(LOG_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(LOG_TAB);
      sheet.appendRow(['Timestamp', 'Action', 'Triggered By', 'Mode', 'Subject',
                       'Total Guests', 'Emails Sent', 'Email Errors', 'WhatsApp', 'Notes', 'Email Body']);
      sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    }
    return sheet;
  };

  const logSend = ({ subject, body, triggeredBy, testMode, totalContacts, emailsSent, errors, whatsAppResult, sendEmail }) => {
    try {
      getOrCreateLogSheet().appendRow([
        new Date(),
        'SEND',
        triggeredBy,
        testMode ? 'TEST' : 'LIVE',
        subject,
        totalContacts,
        sendEmail ? emailsSent.length : 'Not selected',
        errors.length ? errors.map(e => `${e.email}: ${e.error}`).join('\n') : 'None',
        whatsAppResult ?? 'Not triggered',
        '',
        body,
      ]);
    } catch (err) {
      console.error('Audit log (send) failed:', err.message);
    }
  };

  const logOverride = (overriddenBy, lockedDate, originalSender) => {
    try {
      getOrCreateLogSheet().appendRow([
        new Date(),
        'OVERRIDE',
        overriddenBy,
        '', '', '', '', '', '', '', '',
        `Reset lock for ${lockedDate} (originally sent by ${originalSender || 'unknown'})`,
      ]);
    } catch (err) {
      console.error('Audit log (override) failed:', err.message);
    }
  };

  // ── Confirmation email to sender ───────────────────────────────────────────

  const sendConfirmationEmail = ({ triggeredBy, cc, testMode, subject, contacts,
                                   emailsSent, errors, whatsAppResult, sendEmail, timestamp }) => {
    // Fall back to script owner email so summary always sends even if user email is unavailable
    const recipient = (!triggeredBy || triggeredBy === 'unknown')
      ? Session.getEffectiveUser().getEmail()
      : triggeredBy;
    if (!recipient) return;

    try {
      const modeLabel  = testMode ? ' [TEST MODE]' : '';
      const sentAt     = new Date(timestamp).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
      const errorBlock = errors.length
        ? `<tr><td style="padding:8px 0;color:#7a1a15;vertical-align:top"><strong>Errors (${errors.length})</strong></td>`
          + `<td style="padding:8px 0;color:#7a1a15">${errors.map(e => `${e.email}: ${e.error}`).join('<br>')}</td></tr>`
        : '';
      const waBlock = whatsAppResult
        ? `<tr><td style="padding:8px 0;color:#555;vertical-align:top"><strong>WhatsApp</strong></td>`
          + `<td style="padding:8px 0">${whatsAppResult}</td></tr>`
        : '';
      const emailStatus = sendEmail ? `${emailsSent.length} of ${contacts.length}` : 'Not selected — email channel was off';
      const contactRows = contacts
        .map(c => `<tr><td style="padding:3px 8px">${c.firstName} ${c.lastName}</td>`
                + `<td style="padding:3px 8px;color:#555">${c.email}</td>`
                + `<td style="padding:3px 8px;color:#555">${c.bookingNumber}</td></tr>`)
        .join('');

      const htmlBody = `
        <div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1a1a">
          <div style="background:#2d7a4f;padding:16px 24px;border-radius:8px 8px 0 0">
            <h2 style="color:#fff;margin:0;font-size:18px">Weather Alert Sent${modeLabel}</h2>
          </div>
          <div style="border:1px solid #d0d0c8;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr>
                <td style="padding:8px 0;width:140px;vertical-align:top"><strong>Sent at</strong></td>
                <td style="padding:8px 0">${sentAt} (NZ time)</td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top"><strong>Triggered by</strong></td>
                <td style="padding:8px 0">${triggeredBy}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top"><strong>Subject sent</strong></td>
                <td style="padding:8px 0">${subject}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top"><strong>Emails sent</strong></td>
                <td style="padding:8px 0">${emailStatus}</td>
              </tr>
              ${waBlock}
              ${errorBlock}
            </table>
            <h3 style="font-size:14px;margin:0 0 10px;border-bottom:1px solid #e0e0d8;padding-bottom:8px">
              Guests contacted (${contacts.length})
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f0">
                <th style="padding:6px 8px;text-align:left;font-weight:600">Name</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600">Email</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600">Booking</th>
              </tr>
              ${contactRows}
            </table>
            <p style="margin:20px 0 0;font-size:12px;color:#999">
              This summary was automatically generated by the Weather Alert tool.
              Full send log: Weather Alert Log tab in the booking spreadsheet.
            </p>
          </div>
        </div>`;

      MailApp.sendEmail({
        to:       recipient,
        cc:       cc || undefined,
        subject:  `[Weather Alert Summary${modeLabel}] ${subject} — ${sentAt}`,
        htmlBody,
      });
    } catch (err) {
      console.error('Confirmation email failed — recipient:', recipient, '— error:', err.message, err.stack);
    }
  };

};

// ---------------------------------------------------------------------------
// DEBUG — run this directly in the Apps Script editor to test the confirmation
// email in isolation. Remove once confirmed working.
// ---------------------------------------------------------------------------
function debugConfirmationEmail() {
  const email = Session.getEffectiveUser().getEmail();
  console.log('Script owner email:', email);
  console.log('Active user email:', Session.getActiveUser().getEmail());

  try {
    MailApp.sendEmail({
      to:       email,
      subject:  '[Weather Alert Debug] Confirmation email test',
      htmlBody: `<p>Debug test from sendConfirmationEmail. Recipient resolved as: <strong>${email}</strong></p>`,
    });
    console.log('MailApp.sendEmail succeeded');
  } catch(err) {
    console.error('MailApp.sendEmail failed:', err.message);
  }

  // Now test the full sendConfirmationEmail path with dummy data
  const wa = new WeatherAlert();
  // Call triggerWeatherAlert with a dummy subject to trigger the confirmation
  // Only do this if you have test contacts in the sheet
  // wa.triggerWeatherAlert('Debug test', 'Debug body', false, email);
}

// ---------------------------------------------------------------------------
// DEBUG — run directly in the Apps Script editor to diagnose SendGrid 403s.
// Remove once confirmed working.
// ---------------------------------------------------------------------------
function debugSendGridTemplate() {
  const props      = PropertiesService.getScriptProperties();
  const apiKey     = props.getProperty('SENDGRID_API_KEY');
  const templateId = props.getProperty('SENDGRID_TEMPLATE_ID');

  console.log('Template ID:', templateId);
  console.log('API key starts with:', apiKey ? apiKey.substring(0, 8) + '...' : '(not set)');
  console.log('API key length:', apiKey ? apiKey.length : 0);

  // 1. Check what scopes this key actually has, according to SendGrid itself
  const scopesResponse = UrlFetchApp.fetch('https://api.sendgrid.com/v3/scopes', {
    headers: { Authorization: `Bearer ${apiKey}` },
    muteHttpExceptions: true,
  });
  console.log('Scopes check — HTTP', scopesResponse.getResponseCode());
  console.log('Scopes response:', scopesResponse.getContentText());

  // 2. Try fetching the specific template
  const templateResponse = UrlFetchApp.fetch(`https://api.sendgrid.com/v3/templates/${templateId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    muteHttpExceptions: true,
  });
  console.log('Template fetch — HTTP', templateResponse.getResponseCode());
  console.log('Template response:', templateResponse.getContentText());

  // 3. List all templates this key can see (sanity check the ID is even valid for this account)
  const listResponse = UrlFetchApp.fetch('https://api.sendgrid.com/v3/templates?generations=dynamic', {
    headers: { Authorization: `Bearer ${apiKey}` },
    muteHttpExceptions: true,
  });
  console.log('Template list — HTTP', listResponse.getResponseCode());
  console.log('Template list response:', listResponse.getContentText());
}