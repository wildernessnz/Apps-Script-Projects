/**
 * WebRTC Call Logger — Google Apps Script
 * =========================================
 * Receives two types of POST/GET requests from Twilio:
 *
 *   1. Whisper name lookup (GET ?type=whisper-name-only)
 *      Called by whisper-handler.js (Twilio Function) when the customer
 *      name was not included in the call page URL. Returns JSON with the
 *      resolved customer name from HubSpot. The Twilio Function handles
 *      the TwiML <Say> generation itself for fast response times.
 *
 *   2. Status callback (POST, no type param)
 *      Called by Twilio when the dialled call ends. Logs the call
 *      as a HubSpot Call engagement against the matching contact.
 *      Contact lookup: searches for a Deal whose name matches the booking
 *      reference (Rata syncs bookings to HubSpot Deals using the booking
 *      reference as the deal name), then traverses the Deal → Contact
 *      association to find the contact ID.
 *
 * Setup:
 *   1. Paste this script into a new Google Apps Script project
 *   2. Set script properties (Project Settings > Script Properties):

 *        TWILIO_AUTH_TOKEN     — Your Twilio Auth Token (for request validation, optional)
 *        HUBSPOT_OWNER_ID      — Default HubSpot owner ID to assign calls to (optional)
 *   3. Deploy as web app: Execute as "Me", Who has access "Anyone"
 *   4. Copy the web app URL into the GAS_WEBHOOK_URL environment variable
 *      in your Twilio Function Service
 */

// ─── Feature flags ────────────────────────────────────────────────────────
// Toggle these to enable/disable features without redeploying voice-handler.js
// Changes take effect immediately on the next call — no Twilio redeploy needed.

const FEATURE_FLAGS = {
  WHISPER_ENABLED:      true,  // Agent hears customer name + booking ref before call connects
  TRANSCRIPT_ENABLED:   true,  // Call transcript appended to HubSpot engagement after call ends
  HUBSPOT_LOGGING:      true,  // Log call as HubSpot Call engagement
  SHEET_LOGGING:        true,  // Write every call to the Call Log Google Sheet
};

// ─── Entry points ──────────────────────────────────────────────────────────

/**
 * Handle GET requests — used for whisper TwiML
 */
function doGet(e) {
  const params = e.parameter || {};

  // Called by whisper-handler.js (Twilio Function) when customerName was not
  // in the call page URL. Returns JSON so the Function can build the TwiML itself.
  // Keeping name resolution in GAS (not the Twilio Function) means HubSpot auth
  // stays in one place (WildernessAppScriptLibrary).
  if (params.type === 'whisper-name-only') {
    if (!FEATURE_FLAGS.WHISPER_ENABLED) {
      return ContentService
        .createTextOutput(JSON.stringify({ customerName: '' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const bookingRef   = params.bookingRef || '';
    const customerName = bookingRef ? (getCustomerNameFromDeal_(bookingRef) || '') : '';
    return ContentService
      .createTextOutput(JSON.stringify({ customerName }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Health check
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle POST requests:
 *   - type=transcript  → append transcript to existing HubSpot engagement
 *   - (no type)        → Twilio status callback, log call to HubSpot
 */
function doPost(e) {
  const params = e.parameter || {};
  let   body   = {};

  // Parse JSON body if present (transcript-handler POSTs JSON)
  try {
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch(err) { /* not JSON, ignore */ }

  // Default: Twilio call status callback
  try {
    if (FEATURE_FLAGS.SHEET_LOGGING)   logToSheet_(params);
    if (FEATURE_FLAGS.HUBSPOT_LOGGING) logCallToHubSpot_(params);

    // Schedule transcript lookup as a delayed trigger — do NOT run inline here.
    // Twilio times out webhooks after 15 seconds. Running retries inside doPost
    // would block the response and cause Twilio to retry, creating duplicate
    // HubSpot engagements. Instead we schedule a one-off trigger 15 seconds
    // from now which runs appendTranscriptFromSync_ after doPost has returned.
    if (FEATURE_FLAGS.TRANSCRIPT_ENABLED && params.CallSid) {
      scheduleTranscriptLookup_(params.CallSid);
    }
  } catch (err) {
    Logger.log('Error in doPost: ' + err.message);
    appendErrorRow_(params, err.message);
  }

  return ContentService
    .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response/>')
    .setMimeType(ContentService.MimeType.XML);
}

// ─── HubSpot logging ───────────────────────────────────────────────────────

/**
 * Logs the completed call as a HubSpot Call engagement.
 * Flow:
 *   1. Extract booking ref and customer name from Twilio callback params
 *   2. Search HubSpot Deals for a deal whose name matches the booking ref
 *      (Rata syncs bookings as Deals, using the booking ref as the deal name)
 *   3. Traverse the Deal → Contact association to get the contact ID
 *   4. Fall back to searching contacts by name if no deal match is found
 *   5. Create a Call engagement and associate it with the contact (and deal)
 *   6. If no match at all, create the engagement unassociated and flag it
 */
function logCallToHubSpot_(params) {
  const props          = getScriptProps_();
  const defaultOwnerId = props.HUBSPOT_OWNER_ID || '';

  // Only log completed or no-answer calls — skip initiated/ringing events
  const dialStatus = params.DialCallStatus || '';
  if (!['completed', 'no-answer', 'busy', 'failed'].includes(dialStatus)) {
    Logger.log('Skipping callback — DialCallStatus is: ' + dialStatus);
    return;
  }

  const bookingRef      = params.bookingRef   || '';
  const callSid         = params.CallSid      || '';

  // Resolve customer name — use param if present, otherwise look up from HubSpot
  let customerName = params.customerName || '';
  if ((!customerName || customerName === 'Customer') && bookingRef && bookingRef !== 'unknown') {
    customerName = getCustomerNameFromDeal_(bookingRef) || customerName;
  }
  const durationSec  = parseInt(params.DialCallDuration || '0', 10);
  const timestamp    = new Date().toISOString();

  // ── 1. Find the HubSpot contact via Deal lookup ───────────────────────
  // Rata syncs bookings to HubSpot Deals using the booking reference as the
  // deal name. We search for that deal, then traverse the Deal → Contact
  // association to get the contact ID.
  let contactId = null;
  let dealId    = null;

  if (bookingRef && bookingRef !== 'unknown') {
    const dealResult = findContactByDeal_(bookingRef);
    contactId = dealResult.contactId;
    dealId    = dealResult.dealId;
  }

  // Fallback: search by customer name if no deal match found
  if (!contactId && customerName && customerName !== 'Customer') {
    contactId = findContactByName_(customerName);
  }

  // ── 2. Build call note ───────────────────────────────────────────────
  const statusLabel  = DIAL_STATUS_LABELS[dialStatus] || dialStatus;
  const durationStr  = durationSec > 0
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : 'Not answered';

  const callBody = [
    `Source: Wilderness Browser Call (WebRTC / Wi-Fi)`,
    `Status: ${statusLabel}`,
    `Duration: ${durationStr}`,
    `Booking Ref: ${bookingRef || 'Not provided'}`,
    `Customer Name: ${customerName || 'Not provided'}`,
    `Twilio Call SID: ${callSid}`,
    dealId    ? `HubSpot Deal ID: ${dealId}` : '',
    contactId ? '' : '⚠ No matching HubSpot contact found — call logged without association'
  ].filter(Boolean).join('\n');

  // ── 3. Create the HubSpot Call engagement ───────────────────────────
  // hs_call_disposition GUIDs — confirmed from /calling/v1/dispositions for this account
  const DISPOSITION_CONNECTED = 'f240bbac-87c9-4f6e-bf70-924b57d47db7'; // Connected
  const DISPOSITION_NO_ANSWER = '73a0d17f-1163-4015-bdd5-ec830791da20'; // No answer
  const DISPOSITION_BUSY      = '9d9162e7-6cf3-4944-bf63-4dff82258764'; // Busy
  const DISPOSITION_FAILED    = '17b47fee-58de-441e-a44c-c6300d46f273'; // Wrong number (closest to failed)

  const dispositionMap = {
    'completed': DISPOSITION_CONNECTED,
    'no-answer': DISPOSITION_NO_ANSWER,
    'busy':      DISPOSITION_BUSY,
    'failed':    DISPOSITION_FAILED
  };

  const callPayload = {
    properties: {
      hs_timestamp:                  new Date().getTime().toString(),
      hs_call_title:                 `Browser Call — ${customerName || bookingRef || 'Unknown Customer'}`,
      hs_call_body:                  callBody,
      hs_call_duration:              (durationSec * 1000).toString(), // HubSpot expects milliseconds
      hs_call_from_number:           'WebRTC Browser',
      hs_call_to_number:             params.To || '',
      hs_call_status:                HUBSPOT_CALL_STATUS[dialStatus] || 'COMPLETED',
      hs_call_direction:             'INBOUND',
      hs_call_disposition:           dispositionMap[dialStatus] || DISPOSITION_CONNECTED,
      hs_activity_type:              'Inbound Phone Call',
      ...(defaultOwnerId ? { hubspot_owner_id: defaultOwnerId } : {})
    }
  };

  // Associate with contact and deal if found.
  // associationTypeId 194 = call → contact
  // associationTypeId 206 = call → deal
  if (contactId || dealId) {
    callPayload.associations = [
      ...(contactId ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }] : []),
      ...(dealId    ? [{ to: { id: dealId },    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 206 }] }] : [])
    ];
  }

  const createResp = hubspotPost_('/crm/v3/objects/calls', callPayload);
  Logger.log('HubSpot call created: ' + JSON.stringify(createResp));

  if (!createResp.id) {
    Logger.log('ERROR: HubSpot call creation returned no ID — engagement may not have been created');
    updateSheetRow_(callSid, { hubspotStatus: 'Error — no engagement ID returned' });
    return;
  }

  // ── 4. Write result to log sheet ─────────────────────────────────────
  updateSheetRow_(callSid, {
    hubspotStatus:    contactId ? 'Logged ✓' : (dealId ? 'Logged (deal only)' : 'Logged (no match)'),
    hubspotContactId: contactId || '',
    hubspotCallId:    createResp.id || '',
    customerName:     customerName || ''  // write resolved name back to sheet
  });
}

// ─── Contact lookup helpers ────────────────────────────────────────────────

/**
 * Primary lookup: search HubSpot Deals by name (= booking reference as synced
 * from Rata), then traverse the Deal → Contact association to return both IDs.
 *
 * Returns: { dealId, contactId } — either or both may be null if not found.
 *
 * API calls made:
 *   1. POST /crm/v3/objects/deals/search  — find deal by name
 *   2. GET  /crm/v4/objects/deals/{id}/associations/contacts  — get linked contact
 */
function findContactByDeal_(bookingRef) {
  const result = { dealId: null, contactId: null };

  // ── Step 1: Find the deal whose name matches the booking reference
  const searchPayload = {
    filterGroups: [{
      filters: [{
        propertyName: 'dealname',
        operator:     'EQ',
        value:        bookingRef
      }]
    }],
    properties: ['dealname', 'dealstage'],
    limit: 1
  };

  let dealId;
  try {
    const dealResp = hubspotPost_('/crm/v3/objects/deals/search', searchPayload);
    if (!dealResp.results || dealResp.results.length === 0) {
      Logger.log('No deal found with name: ' + bookingRef);
      return result;
    }
    dealId = dealResp.results[0].id;
    result.dealId = dealId;
    Logger.log('Deal found: ' + dealId + ' (' + bookingRef + ')');
  } catch (err) {
    Logger.log('Deal search failed: ' + err.message);
    return result;
  }

  // ── Step 2: Get the contact associated with this deal
  try {
    const assocUrl = 'https://api.hubapi.com/crm/v4/objects/deals/' + dealId + '/associations/contacts';
    const assocResp = UrlFetchApp.fetch(assocUrl, {
      method:  'get',
      headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      muteHttpExceptions: true
    });
    const assocCode = assocResp.getResponseCode();
    const assocBody = JSON.parse(assocResp.getContentText());

    if (assocCode !== 200) {
      Logger.log('Association lookup failed (' + assocCode + '): ' + assocResp.getContentText());
      return result;
    }

    if (assocBody.results && assocBody.results.length > 0) {
      result.contactId = assocBody.results[0].toObjectId.toString();
      Logger.log('Contact found via deal association: ' + result.contactId);
    } else {
      Logger.log('Deal found but no associated contact: ' + dealId);
    }
  } catch (err) {
    Logger.log('Association traversal failed: ' + err.message);
  }

  return result;
}

/**
 * Fallback: search by first + last name.
 * Used when no deal is found for the booking reference — e.g. the call link
 * was opened without a booking ref, or the deal hasn't synced from Rata yet.
 */
function findContactByName_(fullName) {
  const parts     = fullName.trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  if (!firstName) return null;

  const filters = [{ propertyName: 'firstname', operator: 'EQ', value: firstName }];
  if (lastName) filters.push({ propertyName: 'lastname', operator: 'EQ', value: lastName });

  const payload = {
    filterGroups: [{ filters }],
    properties:   ['firstname', 'lastname', 'email'],
    limit: 1
  };

  try {
    const resp = hubspotPost_('/crm/v3/objects/contacts/search', payload);
    if (resp.results && resp.results.length > 0) {
      Logger.log('Contact found by name: ' + resp.results[0].id);
      return resp.results[0].id;
    }
  } catch (err) {
    Logger.log('Contact search by name failed: ' + err.message);
  }
  return null;
}

// ─── Whisper name lookup helper ───────────────────────────────────────────

/**
 * Given a booking reference, finds the associated HubSpot contact and returns
 * their full name. Used by the whisper handler when customerName is not
 * present in the URL parameters.
 *
 * Returns the contact's full name as a string, or null if not found.
 */
function getCustomerNameFromDeal_(bookingRef) {
  try {
    const dealResult = findContactByDeal_(bookingRef);
    if (!dealResult.contactId) {
      Logger.log('Whisper name lookup — no contact found for: ' + bookingRef);
      return null;
    }

    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/' + dealResult.contactId
      + '?properties=firstname,lastname';
    const resp = UrlFetchApp.fetch(url, {
      method:  'get',
      headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Whisper name lookup — contact fetch failed: ' + resp.getContentText());
      return null;
    }

    const p    = JSON.parse(resp.getContentText()).properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
    Logger.log('Whisper name lookup — resolved: ' + name);
    return name || null;

  } catch (err) {
    Logger.log('Whisper name lookup error: ' + err.message);
    return null;
  }
}

// ─── Transcript → HubSpot ─────────────────────────────────────────────────

/**
 * Finds the HubSpot Call engagement for a completed call (looked up by
 * CallSid from the Call Log sheet) and appends the transcript to its
 * hs_call_body property.
 */
function appendTranscriptToHubSpot_(callSid, transcript, bookingRef, customerName) {
  if (!transcript || !callSid) return;

  // ── 1. Find the HubSpot Call ID from the log sheet ────────────────────
  const hubspotCallId = getHubSpotCallIdFromSheet_(callSid);
  if (!hubspotCallId) {
    Logger.log('appendTranscriptToHubSpot_: no HubSpot Call ID for ' + callSid);
    return;
  }

  // ── 2. Fetch existing call body ───────────────────────────────────────
  const url      = 'https://api.hubapi.com/crm/v3/objects/calls/' + hubspotCallId
    + '?properties=hs_call_body';
  const fetchResp = UrlFetchApp.fetch(url, {
    method:  'get',
    headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
    muteHttpExceptions: true
  });

  let existingBody = '';
  if (fetchResp.getResponseCode() === 200) {
    const data = JSON.parse(fetchResp.getContentText());
    existingBody = (data.properties && data.properties.hs_call_body) || '';
  }

  // ── 3. Append transcript ──────────────────────────────────────────────
  const updatedBody = existingBody
    + '\n\n— Call Transcript —\n'
    + transcript;

  const patchResp = UrlFetchApp.fetch(
    'https://api.hubapi.com/crm/v3/objects/calls/' + hubspotCallId,
    {
      method:      'patch',
      contentType: 'application/json',
      headers:     { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      payload:     JSON.stringify({ properties: { hs_call_body: updatedBody } }),
      muteHttpExceptions: true
    }
  );

  const patchCode = patchResp.getResponseCode();
  Logger.log('Transcript appended to HubSpot call ' + hubspotCallId + ' — status: ' + patchCode);

  // ── 4. Update log sheet with transcript status ─────────────────────────
  updateSheetTranscript_(callSid, patchCode === 200 ? 'Transcript ✓' : 'Transcript failed (' + patchCode + ')');
}

/**
 * Looks up the HubSpot Call ID from the Call Log sheet by CallSid.
 */
function getHubSpotCallIdFromSheet_(callSid) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === callSid) {
      return data[i][8] || null; // Column I = HubSpot Call ID
    }
  }
  return null;
}

/**
 * Updates the HubSpot Status column to reflect transcript outcome.
 */
function updateSheetTranscript_(callSid, status) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === callSid) {
      const current = sheet.getRange(i + 1, 7).getValue();
      sheet.getRange(i + 1, 7).setValue(current + ' + ' + status);
      return;
    }
  }
}

// ─── Transcript from Sync ─────────────────────────────────────────────────

/**
 * Schedules a one-off trigger to run appendTranscriptFromSync_ after a short
 * delay. Called from doPost so that the Twilio webhook response is returned
 * immediately — Twilio times out after 15 seconds and retries if no response.
 */
function scheduleTranscriptLookup_(callSid) {
  // Store the callSid in Script Properties so the trigger can read it
  // runPendingTranscriptLookup processes ALL pending keys each time it fires
  const key = 'pendingTranscript_' + callSid;
  PropertiesService.getScriptProperties().setProperty(key, callSid);

  // Always create a new trigger — do NOT delete existing ones as they may
  // be waiting to process a previous call's transcript
  ScriptApp.newTrigger('runPendingTranscriptLookup')
    .timeBased()
    .after(45 * 1000)
    .create();

}

/**
 * Called by the scheduled trigger. Finds all pending transcript lookups,
 * runs appendTranscriptFromSync_ for each, then cleans up.
 */
function runPendingTranscriptLookup() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const pending = Object.keys(props).filter(k => k.startsWith('pendingTranscript_'));


  pending.forEach(key => {
    const callSid = props[key];
    try {
      appendTranscriptFromSync_(callSid);
    } catch (err) {
    }
    PropertiesService.getScriptProperties().deleteProperty(key);
  });

  // Clean up only THIS trigger instance — not all pending ones
  // (other triggers may still be waiting for concurrent calls)
  const allTriggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runPendingTranscriptLookup');
  if (allTriggers.length > 0) {
    ScriptApp.deleteTrigger(allTriggers[0]); // delete just one
  }
}

// ─── Transcript from Sync ─────────────────────────────────────────────────

/**
 * Called by doPost after a call is logged to HubSpot.
 * Checks Twilio Sync for a completed transcript stored by transcript-handler.js.
 * If found, appends it to the HubSpot Call engagement and cleans up Sync.
 *
 * This approach eliminates the race condition — the status callback always runs
 * after logCallToHubSpot_ writes the HubSpot Call ID to the sheet, so the
 * transcript lookup always has a valid Call ID to work with.
 */
function appendTranscriptFromSync_(callSid) {
  const props          = getScriptProps_();
  const accountSid     = props.TWILIO_ACCOUNT_SID;
  const authToken      = props.TWILIO_AUTH_TOKEN;
  const syncServiceSid = props.SYNC_SERVICE_SID;

  if (!accountSid || !authToken || !syncServiceSid) {
    Logger.log('appendTranscriptFromSync_: missing Twilio credentials in Script Properties');
    return;
  }

  const docKey  = 'transcript_' + callSid;
  const syncUrl = 'https://sync.twilio.com/v1/Services/' + syncServiceSid + '/Documents/' + docKey;
  const auth    = Utilities.base64Encode(accountSid + ':' + authToken);

  // Fetch the Sync doc — retry up to 5 times with 10s gaps (50s total)
  // Trigger fires 45s after call ends so Sync should be ready on attempt 1.
  let syncData;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(syncUrl, {
        method:  'get',
        headers: { Authorization: 'Basic ' + auth },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 404) {
        Logger.log('appendTranscriptFromSync_: attempt ' + attempt + ' — Sync doc not ready yet for ' + callSid);
        if (attempt < 5) Utilities.sleep(10000);
        continue;
      }
      if (resp.getResponseCode() !== 200) {
        Logger.log('appendTranscriptFromSync_: Sync fetch failed ' + resp.getResponseCode());
        return;
      }
      const parsed = JSON.parse(resp.getContentText());
      syncData = parsed.data;
      if (syncData && syncData.transcriptReady) {
        Logger.log('appendTranscriptFromSync_: transcript found on attempt ' + attempt);
        break;
      }
      Logger.log('appendTranscriptFromSync_: attempt ' + attempt + ' — doc exists but transcriptReady is false');
      if (attempt < 5) Utilities.sleep(10000);
    } catch (err) {
      Logger.log('appendTranscriptFromSync_: error on attempt ' + attempt + ': ' + err.message);
      if (attempt < 5) Utilities.sleep(10000);
    }
  }

  if (!syncData || !syncData.transcriptReady || !syncData.transcript) {
    Logger.log('appendTranscriptFromSync_: transcript not available after 5 attempts for ' + callSid);
    return;
  }

  // Transcript is ready — append to HubSpot
  appendTranscriptToHubSpot_(callSid, syncData.transcript, syncData.bookingRef || '', syncData.customerName || '');

  // Clean up Sync doc
  try {
    UrlFetchApp.fetch(syncUrl, {
      method:  'delete',
      headers: { Authorization: 'Basic ' + auth },
      muteHttpExceptions: true
    });
  } catch (e) { /* ignore cleanup errors */ }
}

// ─── Google Sheet logging ──────────────────────────────────────────────────

/**
 * Appends a new row to the "Call Log" sheet when a Twilio callback arrives.
 * Creates the sheet and header row automatically on first use.
 */
function logToSheet_(params) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let sheet   = ss.getSheetByName('Call Log');

  if (!sheet) {
    sheet = ss.insertSheet('Call Log');
    sheet.appendRow([
      'Timestamp', 'Call SID', 'Booking Ref', 'Customer Name',
      'Duration (s)', 'Dial Status', 'HubSpot Status', 'HubSpot Contact ID',
      'HubSpot Call ID', 'Caller', 'Error'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
  }

  sheet.appendRow([
    new Date().toISOString(),
    params.CallSid      || '',
    params.bookingRef   || '',
    params.customerName || '',
    params.DialCallDuration || '',
    params.DialCallStatus   || '',
    'Pending…', // Updated by updateSheetRow_ after HubSpot logging
    '',
    '',
    params.Caller || '',
    ''
  ]);
}

/**
 * Updates the HubSpot result columns in the row matching a CallSid.
 */
function updateSheetRow_(callSid, updates) {
  if (!callSid) return;
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === callSid) { // Column B = Call SID
      if (updates.customerName)     sheet.getRange(i + 1, 4).setValue(updates.customerName);  // Col D
      if (updates.hubspotStatus)    sheet.getRange(i + 1, 7).setValue(updates.hubspotStatus);  // Col G
      if (updates.hubspotContactId) sheet.getRange(i + 1, 8).setValue(updates.hubspotContactId); // Col H
      if (updates.hubspotCallId)    sheet.getRange(i + 1, 9).setValue(updates.hubspotCallId);  // Col I
      break;
    }
  }
}

function appendErrorRow_(params, errorMessage) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');
  if (!sheet) return;
  // Find the row with this CallSid and write error in column K
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === (params.CallSid || '')) {
      sheet.getRange(i + 1, 7).setValue('Error');
      sheet.getRange(i + 1, 11).setValue(errorMessage);
      return;
    }
  }
}

// ─── HubSpot API helpers ───────────────────────────────────────────────────

function hubspotPost_(path, payload) {
  const url      = 'https://api.hubapi.com' + path;
  const options  = {
    method:      'post',
    contentType: 'application/json',
    headers:     { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
    payload:     JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  const code     = response.getResponseCode();
  const body     = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`HubSpot API error ${code}: ${body}`);
  }
  return JSON.parse(body);
}

// ─── Utility helpers ───────────────────────────────────────────────────────

function getScriptProps_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function escapeXml_(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DIAL_STATUS_LABELS = {
  'completed':  'Completed',
  'no-answer':  'No answer',
  'busy':       'Busy',
  'failed':     'Failed',
  'canceled':   'Cancelled'
};

const HUBSPOT_CALL_STATUS = {
  'completed': 'COMPLETED',
  'no-answer': 'NO_ANSWER',
  'busy':      'BUSY',
  'failed':    'FAILED',
  'canceled':  'CANCELED'
};

// ─── Test handler ──────────────────────────────────────────────────────────

/**
 * testDealLookup
 * ---------------
 * Manually test the deal → contact lookup without needing a real Twilio call.
 *
 * Usage:
 *   1. Open the Apps Script editor
 *   2. Select testDealLookup from the function dropdown
 *   3. Set the bookingRef variable below to a real booking reference
 *   4. Click Run
 *   5. Check Execution log for results
 */
function testDealLookup() {
  const bookingRef = 'BK-12345'; // ← replace with a real booking reference to test

  Logger.log('=== testDealLookup ===');
  Logger.log('Looking up booking ref: ' + bookingRef);

  const result = findContactByDeal_(bookingRef);

  if (result.dealId) {
    Logger.log('✓ Deal found       — ID: ' + result.dealId);
  } else {
    Logger.log('✗ No deal found for booking ref: ' + bookingRef);
  }

  if (result.contactId) {
    Logger.log('✓ Contact found    — ID: ' + result.contactId);

    // Fetch the contact's name and email so you can confirm it's the right person
    try {
      const url = 'https://api.hubapi.com/crm/v3/objects/contacts/' + result.contactId
        + '?properties=firstname,lastname,email';
      const resp = UrlFetchApp.fetch(url, {
        method:  'get',
        headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
        muteHttpExceptions: true
      });
      const contact = JSON.parse(resp.getContentText());
      const p = contact.properties || {};
      Logger.log('  Name:  ' + (p.firstname || '') + ' ' + (p.lastname || ''));
      Logger.log('  Email: ' + (p.email || ''));
    } catch (err) {
      Logger.log('  (Could not fetch contact details: ' + err.message + ')');
    }
  } else if (result.dealId) {
    Logger.log('✗ Deal found but no associated contact');
  }

  Logger.log('=== done ===');
}

// ─── Monitoring & Alerting ─────────────────────────────────────────────────

/**
 * MONITORING SETUP
 * ─────────────────────────────────────────────────────────────────────────────
 * Run setupMonitoringTrigger() ONCE from the GAS editor to install a daily
 * trigger. After that, monitorCallLog() runs automatically every morning
 * at 8am NZT and emails a summary if there are any issues.
 *
 * To set the alert email, add ALERT_EMAIL to Script Properties:
 *   Project Settings → Script Properties → ALERT_EMAIL = your@email.com
 *
 * To remove the trigger: GAS Editor → Triggers → delete the monitorCallLog trigger.
 */

/**
 * Run once to install the daily monitoring trigger.
 * After running, check GAS Editor → Triggers to confirm it appears.
 */
function setupMonitoringTrigger() {
  // Remove any existing monitorCallLog triggers to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'monitorCallLog')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Run daily at 8am NZT (UTC+12 = 8pm UTC previous day)
  ScriptApp.newTrigger('monitorCallLog')
    .timeBased()
    .atHour(20) // 8pm UTC = 8am NZT
    .everyDays(1)
    .create();

  Logger.log('Monitoring trigger installed — monitorCallLog will run daily at 8am NZT');
}

/**
 * Daily monitoring job. Scans the Call Log sheet for issues in the past 24 hours
 * and sends an alert email if any are found.
 *
 * Issues detected:
 *   - Calls with HubSpot Status = 'Error'
 *   - Calls with blank HubSpot Status (logging may have failed silently)
 *   - Calls with no HubSpot Call ID (deal/contact lookup failed)
 *   - Calls where transcript was expected but not appended
 *   - Calls with blank booking ref (link generated without ?ref= param)
 */
function monitorCallLog() {
  const props     = getScriptProps_();
  const alertEmail = props.ALERT_EMAIL || Session.getActiveUser().getEmail();
  const now       = new Date();
  const cutoff    = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');

  if (!sheet) {
    Logger.log('monitorCallLog: Call Log sheet not found');
    return;
  }

  const data   = sheet.getDataRange().getValues();
  const issues = [];
  let   totalCalls = 0;
  let   successCalls = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    // Skip debug/test rows and header
    const callSid = String(row[1] || '');
    if (!callSid || callSid.startsWith('CA_TEST') || callSid === 'Call SID') continue;

    // Only check rows from the past 24 hours
    const rowTime = new Date(row[0]);
    if (isNaN(rowTime.getTime()) || rowTime < cutoff) continue;

    totalCalls++;

    const bookingRef    = row[2]  || '';
    const customerName  = row[3]  || '';
    const duration      = row[4]  || '';
    const dialStatus    = row[5]  || '';
    const hubspotStatus = row[6]  || '';
    const contactId     = row[7]  || '';
    const hubspotCallId = row[8]  || '';
    const errorMsg      = row[10] || '';

    const rowIssues = [];

    if (!bookingRef) {
      rowIssues.push('Missing booking ref — call link was opened without ?ref= parameter');
    }

    if (hubspotStatus === 'Error') {
      rowIssues.push('HubSpot logging error: ' + (errorMsg || 'see Error column'));
    }

    if (!hubspotStatus && dialStatus === 'completed') {
      rowIssues.push('HubSpot status is blank — logging may have failed silently');
    }

    if (dialStatus === 'completed' && !hubspotCallId) {
      rowIssues.push('No HubSpot Call ID — engagement was not created');
    }

    if (dialStatus === 'completed' && !contactId) {
      rowIssues.push('No HubSpot Contact ID — deal/contact lookup failed');
    }

    if (FEATURE_FLAGS.TRANSCRIPT_ENABLED
        && dialStatus === 'completed'
        && duration > 10
        && hubspotStatus
        && !hubspotStatus.includes('Transcript')) {
      rowIssues.push('Transcript not appended — check transcript-handler Twilio logs');
    }

    if (rowIssues.length > 0) {
      issues.push({
        timestamp:   row[0],
        callSid,
        bookingRef:  bookingRef  || '(none)',
        customer:    customerName || '(unknown)',
        status:      dialStatus,
        duration:    duration + 's',
        issues:      rowIssues
      });
    } else {
      successCalls++;
    }
  }

  Logger.log(`monitorCallLog: ${totalCalls} calls in last 24h, ${issues.length} with issues`);

  // Send email only if there are issues
  if (issues.length > 0) {
    sendAlertEmail_(alertEmail, totalCalls, successCalls, issues, now);
  } else if (totalCalls > 0) {
    Logger.log('All ' + totalCalls + ' calls logged successfully — no alert needed');
  } else {
    Logger.log('No calls in the past 24 hours');
  }
}

/**
 * Sends the alert email with a formatted summary of issues.
 */
function sendAlertEmail_(to, totalCalls, successCalls, issues, now) {
  const dateStr = Utilities.formatDate(now, 'Pacific/Auckland', 'dd MMM yyyy');

  const subject = `⚠ WebRTC Call Logger — ${issues.length} issue${issues.length > 1 ? 's' : ''} detected (${dateStr})`;

  let body = `WebRTC Browser Call — Daily Monitor Report\n`;
  body += `${dateStr} · ${totalCalls} call${totalCalls !== 1 ? 's' : ''} in past 24 hours\n`;
  body += `${successCalls} successful · ${issues.length} with issues\n`;
  body += `\n${'─'.repeat(60)}\n\n`;

  issues.forEach((item, idx) => {
    const time = Utilities.formatDate(new Date(item.timestamp), 'Pacific/Auckland', 'HH:mm');
    body += `Issue ${idx + 1} of ${issues.length}\n`;
    body += `  Time:       ${time} NZT\n`;
    body += `  Customer:   ${item.customer}\n`;
    body += `  Booking:    ${item.bookingRef}\n`;
    body += `  Call SID:   ${item.callSid}\n`;
    body += `  Status:     ${item.status} (${item.duration})\n`;
    body += `  Problems:\n`;
    item.issues.forEach(issue => { body += `    • ${issue}\n`; });
    body += '\n';
  });

  body += `${'─'.repeat(60)}\n`;
  body += `View full log: ${SpreadsheetApp.getActiveSpreadsheet().getUrl()}\n`;
  body += `\nThis alert is sent automatically each morning at 8am NZT.\n`;
  body += `To change the alert recipient, update ALERT_EMAIL in GAS Script Properties.\n`;
  body += `To disable alerts, delete the monitorCallLog trigger in the GAS editor.\n`;

  MailApp.sendEmail({
    to:      to,
    subject: subject,
    body:    body
  });

  Logger.log('Alert email sent to: ' + to);
}

/**
 * Run manually to test the alert email with synthetic data.
 * Sends a real email to ALERT_EMAIL (or your GAS account email).
 */
function testMonitoringAlert() {
  const props      = getScriptProps_();
  const alertEmail = props.ALERT_EMAIL || Session.getActiveUser().getEmail();

  const fakeIssues = [
    {
      timestamp:  new Date(),
      callSid:    'CA_TEST_MONITOR_123',
      bookingRef: 'BK105067',
      customer:   'Mark Lonergan',
      status:     'completed',
      duration:   '25s',
      issues:     ['HubSpot logging error: API returned 401 — token may have expired',
                   'Transcript not appended — check transcript-handler Twilio logs']
    },
    {
      timestamp:  new Date(Date.now() - 3600000),
      callSid:    'CA_TEST_MONITOR_456',
      bookingRef: '(none)',
      customer:   '(unknown)',
      status:     'completed',
      duration:   '8s',
      issues:     ['Missing booking ref — call link was opened without ?ref= parameter']
    }
  ];

  sendAlertEmail_(alertEmail, 5, 3, fakeIssues, new Date());
  Logger.log('Test alert sent to: ' + alertEmail);
}
