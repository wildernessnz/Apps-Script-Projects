/**
 * @fileoverview Weather Alert — sends a weather notification to on-road
 * guests via SendGrid email and/or HubSpot WhatsApp workflow enrollment.
 * Ported from the original "Weather Alert.gs.html" — only the web-app-facing
 * methods are included here (see note below on the Sheet-bound menu dialog).
 *
 * Reads on-road guests from the "Raw - OnRoad Bookings" tab and writes audit
 * entries to "Weather Alert Log", both in the Weather Alert spreadsheet
 * (SHEET_IDS.WEATHER_ALERT in Config.gs).
 *
 * NOT ported: onOpen(), openAlertDialog(), previewGuestList(), resetDailyLock()
 * (the ui.alert-based version). These depend on SpreadsheetApp.getUi(), which
 * only works inside a Sheet-bound context — they'd throw if called from this
 * standalone web app. If that Sheet-menu access path still needs to exist,
 * it stays on the original Weather Alert spreadsheet's own script, separate
 * from this project.
 *
 * Script Properties required (Project Settings > Script Properties):
 *   HUBSPOT_WHATSAPP_FLOW_ID, SENDGRID_API_KEY, SENDGRID_TEMPLATE_ID,
 *   FROM_EMAIL, FROM_NAME, TEST_MODE, APPROVED_SENDERS, OVERRIDE_EMAILS,
 *   CONFIRMATION_CC, BCC_EMAIL — same set as the original tool.
 */

// ── Global wrappers — the only entry points exposed to google.script.run ────
function getGuestPreview()                             { return new WeatherAlert().getGuestPreview(); }
function triggerWeatherAlert(subject, body, sendWA, sendEmail) { return new WeatherAlert().triggerWeatherAlert(subject, body, sendWA, sendEmail); }
function resetLockFromWebApp()                          { return new WeatherAlert().resetLockFromWebApp(); }
function previewEmail(subject, body)                    { return new WeatherAlert().previewEmail(subject, body); }
function sendTestEmail(subject, body)                   { return new WeatherAlert().sendTestEmail(subject, body); }

/**
 * Used by ContentLoader.gs to gate this tool's content behind APPROVED_SENDERS
 * before the sidebar-shared shell renders it — replaces the original's
 * doGet()-level access check, since that gated the whole page and this tool
 * now shares a page with 3 others.
 * @returns {boolean}
 */
function isWeatherAlertApproved() {
  const email = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props = PropertiesService.getScriptProperties();
  const approved = (props.getProperty('APPROVED_SENDERS') ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return approved.includes(email);
}

var WeatherAlert = function () {

  const SHEET_KEY     = 'WEATHER_ALERT';
  const RAW_TAB        = 'Raw - OnRoad Bookings';
  const LOG_TAB        = 'Weather Alert Log';
  const TEST_DOMAIN    = '@wilderness.co.nz';
  const LAST_SEND_KEY  = 'WEATHER_ALERT_LAST_SEND_DATE';
  const LAST_SEND_BY   = 'WEATHER_ALERT_LAST_SEND_BY';

  const COL_VID     = 'hubspot_vid';
  const COL_EMAIL   = 'customer_email';
  const COL_FNAME   = 'first_name';
  const COL_LNAME   = 'last_name';
  const COL_BOOKING = 'booking_number';

  // ── Config ─────────────────────────────────────────────────────────────────

  const getConfig = () => {
    const props = PropertiesService.getScriptProperties();
    return {
      HUBSPOT_WHATSAPP_FLOW_ID: props.getProperty('HUBSPOT_WHATSAPP_FLOW_ID'),
      SENDGRID_API_KEY:         props.getProperty('SENDGRID_API_KEY'),
      SENDGRID_TEMPLATE_ID:     props.getProperty('SENDGRID_TEMPLATE_ID'),
      FROM_EMAIL:               props.getProperty('FROM_EMAIL'),
      FROM_NAME:                props.getProperty('FROM_NAME'),
      TEST_MODE:                props.getProperty('TEST_MODE') === 'true',
      APPROVED_SENDERS:         parseEmailList(props.getProperty('APPROVED_SENDERS')),
      OVERRIDE_EMAILS:          parseEmailList(props.getProperty('OVERRIDE_EMAILS')),
      CONFIRMATION_CC:          parseEmailList(props.getProperty('CONFIRMATION_CC')).join(','),
      BCC_EMAIL:                parseEmailList(props.getProperty('BCC_EMAIL')),
    };
  };

  const parseEmailList = (raw) =>
    (raw ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  const getTriggeredBy = () => Session.getActiveUser().getEmail()?.toLowerCase() || 'unknown';

  // ── One-send-per-day guard ─────────────────────────────────────────────────

  const todayNZ = () => {
    const nz      = new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const [d, m, y] = nz.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
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

  // ── Reset lock (web app) ────────────────────────────────────────────────────

  /**
   * @returns {{success: boolean, message?: string, clearedDate?: string, clearedBy?: string}}
   */
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

  // ── Guest preview (called on load by the UI) ────────────────────────────────

  /**
   * @returns {Object} full state for the UI: test mode, lock status, guest list
   */
  this.getGuestPreview = () => {
    const cfg         = getConfig();
    const contacts     = getOnRoadContacts(cfg.TEST_MODE);
    const sentToday    = alreadySentToday();
    const triggeredBy  = getTriggeredBy();

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

  /**
   * @param {string} subject
   * @param {string} body
   * @param {boolean|number} sendWhatsApp
   * @param {boolean|number} sendEmail
   * @returns {Object} send result
   */
  this.triggerWeatherAlert = (subject, body, sendWhatsApp, sendEmail = true) => {
    const cfg         = getConfig();
    const triggeredBy = getTriggeredBy();

    // Coerce to boolean — client passes 1/0 to work around google.script.run
    // silently dropping false boolean arguments (a known Apps Script quirk).
    const doEmail    = !!sendEmail;
    const doWhatsApp = !!sendWhatsApp;

    Logger.log(`[WeatherAlert.triggerWeatherAlert] triggeredBy=${triggeredBy} | doEmail=${doEmail} | doWhatsApp=${doWhatsApp}`);

    if (!cfg.APPROVED_SENDERS.includes(triggeredBy)) {
      return { success: false, message: 'Your account is not authorised to send weather alerts.' };
    }
    if (!doEmail && !doWhatsApp) {
      return { success: false, message: 'No channel selected — nothing to send.' };
    }
    if (alreadySentToday()) {
      return {
        success: false,
        message: `A weather alert was already sent today (${getLastSendDate()}) by ${getLastSendBy() || 'unknown'}. Only one send per day is permitted.`,
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

    if (doEmail) {
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
    if (doWhatsApp) {
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
              totalContacts: contacts.length, emailsSent, errors, whatsAppResult, sendEmail: doEmail });
    sendConfirmationEmail({ triggeredBy, cc: cfg.CONFIRMATION_CC, testMode: cfg.TEST_MODE,
                            subject, contacts, emailsSent, errors, whatsAppResult, sendEmail: doEmail,
                            timestamp: new Date().toISOString() });

    return {
      success:       true,
      testMode:      cfg.TEST_MODE,
      triggeredBy,
      sendEmail:     doEmail,
      totalContacts: contacts.length,
      emailsSent:    emailsSent.length,
      emailErrors:   errors,
      whatsApp:      whatsAppResult,
      timestamp:     new Date().toISOString(),
    };
  };

  // ── Guest list ─────────────────────────────────────────────────────────────

  const getOnRoadContacts = (testMode = false) => {
    const ss    = getSpreadsheet_(SHEET_KEY);
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
            to:  [{ email: contact.email, name: contact.firstName || 'Guest' }],
            bcc: bccList,
            dynamic_template_data: {
              subject:    subject,
              alertBody:  htmlBody,
              firstName:  contact.firstName || 'Guest',
            },
          }],
          from:        { email: cfg.FROM_EMAIL, name: cfg.FROM_NAME || undefined },
          reply_to:    { email: cfg.FROM_EMAIL },
          template_id: cfg.SENDGRID_TEMPLATE_ID,
          custom_args: { weather_alert_send_id: `weather-${Date.now()}-${contact.vid}` },
        }),
      }
    );

    const code = response.getResponseCode();
    if (code >= 400) {
      let msg = `HTTP ${code}`;
      try {
        const data = JSON.parse(response.getContentText());
        msg = data.errors?.map(e => e.message).join('; ') || msg;
      } catch (_) { /* non-JSON response — keep HTTP status as the message */ }
      throw new Error(msg);
    }
  };

  // Fetches the active version's HTML for the configured dynamic template.
  const getTemplateHtml = (cfg) => {
    const response = UrlFetchApp.fetch(
      `https://api.sendgrid.com/v3/templates/${cfg.SENDGRID_TEMPLATE_ID}`,
      { method: 'GET', headers: { Authorization: `Bearer ${cfg.SENDGRID_API_KEY}` }, muteHttpExceptions: true }
    );
    if (response.getResponseCode() >= 400) {
      throw new Error(`Could not fetch template — HTTP ${response.getResponseCode()}`);
    }
    const data   = JSON.parse(response.getContentText());
    const active = (data.versions || []).find(v => v.active === 1) || data.versions?.[0];
    if (!active) throw new Error('Template has no versions to preview.');
    return active.html_content || '<p>(This template version has no HTML content.)</p>';
  };

  const renderTemplate = (html, data) =>
    Object.entries(data).reduce(
      (out, [key, value]) => out.replace(new RegExp(`\\{{2,3}\\s*${key}\\s*\\}{2,3}`, 'g'), value),
      html
    );

  /**
   * @param {string} subject
   * @param {string} body
   * @returns {{success: boolean, html?: string, message?: string}}
   */
  this.previewEmail = (subject, body) => {
    const cfg = getConfig();
    if (!cfg.SENDGRID_API_KEY || !cfg.SENDGRID_TEMPLATE_ID) {
      return { success: false, message: 'SendGrid is not configured (missing API key or template ID).' };
    }
    try {
      const rawHtml = getTemplateHtml(cfg);
      const html = renderTemplate(rawHtml, {
        subject:   subject || '(no subject)',
        alertBody: (body || '').replace(/\n/g, '<br>'),
        firstName: 'Guest',
      });
      return { success: true, html };
    } catch (err) {
      return { success: false, message: err.message };
    }
  };

  /**
   * @param {string} subject
   * @param {string} body
   * @returns {{success: boolean, sentTo?: string, message?: string}}
   */
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
      sendTransactionalEmail(cfg, { email: triggeredBy, firstName: 'Test', vid: 'test' }, `[TEST] ${subject}`, body, false);
      return { success: true, sentTo: triggeredBy };
    } catch (err) {
      return { success: false, message: err.message };
    }
  };

  // ── HubSpot API (WhatsApp only) ────────────────────────────────────────────

  const hubspotHeaders = () => ({
    Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer(),
  });

  const enrollInWorkflow = (cfg, contacts) => {
    const enrolled = [];
    const errors   = [];

    for (const contact of contacts) {
      const url = `https://api.hubapi.com/automation/v2/workflows/${cfg.HUBSPOT_WHATSAPP_FLOW_ID}/enrollments/contacts/${encodeURIComponent(contact.email)}`;
      const response = UrlFetchApp.fetch(url, { method: 'POST', headers: hubspotHeaders(), muteHttpExceptions: true });
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
    const ss    = getSpreadsheet_(SHEET_KEY);
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
        new Date(), 'SEND', triggeredBy, testMode ? 'TEST' : 'LIVE', subject,
        totalContacts,
        sendEmail ? emailsSent.length : 'Not selected',
        errors.length ? errors.map(e => `${e.email}: ${e.error}`).join('\n') : 'None',
        whatsAppResult ?? 'Not triggered',
        '', body,
      ]);
    } catch (err) {
      console.error('Audit log (send) failed:', err.message);
    }
  };

  const logOverride = (overriddenBy, lockedDate, originalSender) => {
    try {
      getOrCreateLogSheet().appendRow([
        new Date(), 'OVERRIDE', overriddenBy, '', '', '', '', '', '', '',
        `Reset lock for ${lockedDate} (originally sent by ${originalSender || 'unknown'})`,
      ]);
    } catch (err) {
      console.error('Audit log (override) failed:', err.message);
    }
  };

  // ── Confirmation email to sender ───────────────────────────────────────────

  const sendConfirmationEmail = ({ triggeredBy, cc, testMode, subject, contacts,
                                   emailsSent, errors, whatsAppResult, sendEmail, timestamp }) => {
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
              <tr><td style="padding:8px 0;width:140px;vertical-align:top"><strong>Sent at</strong></td><td style="padding:8px 0">${sentAt} (NZ time)</td></tr>
              <tr><td style="padding:8px 0;vertical-align:top"><strong>Triggered by</strong></td><td style="padding:8px 0">${triggeredBy}</td></tr>
              <tr><td style="padding:8px 0;vertical-align:top"><strong>Subject sent</strong></td><td style="padding:8px 0">${subject}</td></tr>
              <tr><td style="padding:8px 0;vertical-align:top"><strong>Emails sent</strong></td><td style="padding:8px 0">${emailStatus}</td></tr>
              ${waBlock}
              ${errorBlock}
            </table>
            <h3 style="font-size:14px;margin:0 0 10px;border-bottom:1px solid #e0e0d8;padding-bottom:8px">Guests contacted (${contacts.length})</h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f0"><th style="padding:6px 8px;text-align:left;font-weight:600">Name</th><th style="padding:6px 8px;text-align:left;font-weight:600">Email</th><th style="padding:6px 8px;text-align:left;font-weight:600">Booking</th></tr>
              ${contactRows}
            </table>
            <p style="margin:20px 0 0;font-size:12px;color:#999">This summary was automatically generated by the Weather Alert tool. Full send log: Weather Alert Log tab in the booking spreadsheet.</p>
          </div>
        </div>`;

      MailApp.sendEmail({ to: recipient, cc: cc || undefined, subject: `[Weather Alert Summary${modeLabel}] ${subject} — ${sentAt}`, htmlBody });
    } catch (err) {
      console.error('Confirmation email failed — recipient:', recipient, '— error:', err.message, err.stack);
    }
  };

};
